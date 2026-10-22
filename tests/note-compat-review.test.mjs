import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNotes, installNotesSchema } from "../notes.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { installLibraryCommon } from "../library-common.mjs";
import { createApp } from "../server.mjs";
import { isCompleted } from "../src/model.js";
const instant = "2026-01-01T00:00:00Z";
function seedDocument(db, id, projectId = "p1", sensitive = 0, user = "alice") {
  db.prepare(
    "INSERT INTO documents(id,project_id,title,sensitive,creator,created,updated) VALUES(?,?,?,?,?,?,?)",
  ).run(id, projectId, "Fixture " + id, sensitive, user, instant, instant);
  for (const number of [1, 2]) {
    const version = id + "-v" + number;
    db.prepare(
      "INSERT INTO document_blobs(sha256,size,created) VALUES(?,?,?)",
    ).run(version, 10, instant);
    db.prepare(
      "INSERT INTO document_versions(id,document_id,number,filename,size,sha256,blob_hash,created_by,creator_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      version,
      id,
      number,
      version + ".txt",
      10,
      version,
      version,
      "Fixture owner",
      user,
      instant,
    );
  }
  db.prepare("UPDATE documents SET current_version_id=? WHERE id=?").run(
    id + "-v2",
    id,
  );
}
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT); INSERT INTO users VALUES('alice','Fixture Alice','alice'),('bob','Fixture Bob','bob'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p1','Fixture project'),('p2','Other fixture'); CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,deleted INTEGER DEFAULT 0,actual TEXT DEFAULT '',date TEXT DEFAULT '',version INTEGER DEFAULT 1,updated TEXT DEFAULT 'initial'); INSERT INTO records(id,project_id,task) VALUES('task','p1','Pending task'),('foreign-task','p2','Foreign task');",
  );
  installLibraryCommon(db);
  installDocumentSchema(db);
  const service = createNotes({ db });
  db.prepare(
    "INSERT INTO document_deliverables(id,project_id,title,created,updated) VALUES(?,?,?,?,?)",
  ).run("handover", "p1", "Checklist entry", instant, instant);
  db.prepare(
    "INSERT INTO document_deliverables(id,project_id,title,created,updated) VALUES(?,?,?,?,?)",
  ).run("foreign-handover", "p2", "Foreign checklist", instant, instant);
  for (const id of ["one", "two"]) seedDocument(db, id);
  seedDocument(db, "foreign", "p2");
  seedDocument(db, "secret", "p1", 1);
  const api = async (route, method = "GET", b = {}, who = "alice") => {
    const url = new URL(route, "http://compat.test");
    try {
      const result = await service.api({
        route: url.pathname,
        method,
        b,
        params: url.searchParams,
        user: who
          ? db.prepare("SELECT * FROM users WHERE id=?").get(who)
          : null,
      });
      return { status: result.status || 200, ...result.data };
    } catch (e) {
      return { status: e.status || 500, error: e.message };
    }
  };
  const create = async (b = {}) => {
    const result = await api("/projects/p1/notes", "POST", {
      body: "Compatibility note",
      ...b,
    });
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.note;
  };
  return { db, api, create };
}
test("legacy per-file actions still coexist with staged additions and preserve the text version baseline", async (t) => {
  const { db, api, create } = fixture(t),
    before = db.prepare("SELECT * FROM records ORDER BY id").all();
  const n = await create({
    task_id: "task",
    attachments: [{ document_id: "one", version_id: "one-v1" }],
  });
  let r = await api("/notes/" + n.id + "/files", "POST", {
    document_id: "two",
  });
  assert.equal(r.status, 201);
  assert.equal(r.note.version, n.version);
  assert.equal(
    r.note.files.find((f) => f.document_id === "two").version_id,
    "two-v2",
  );
  const old = r.note.files.find((f) => f.document_id === "one");
  r = await api(
    "/notes/" + n.id + "/files/one",
    "PATCH",
    { version_id: "one-v2", link_version: old.link_version },
    "bob",
  );
  assert.equal(r.status, 200);
  assert.equal(r.note.version, n.version);
  assert.equal(
    (
      await api("/notes/" + n.id + "/files/one", "PATCH", {
        version_id: "one-v1",
        link_version: old.link_version,
      })
    ).status,
    409,
  );
  const second = r.note.files.find((f) => f.document_id === "two");
  r = await api("/notes/" + n.id + "/files/two", "DELETE", {
    link_version: second.link_version,
  });
  assert.equal(r.status, 200);
  assert.equal(r.note.version, n.version);
  r = await api("/notes/" + n.id, "PATCH", {
    version: n.version,
    body: "Text and another historical selection",
    attachments: [{ document_id: "two", version_id: "two-v1" }],
  });
  assert.equal(r.status, 200);
  assert.equal(
    r.note.files.find((f) => f.document_id === "one").version_id,
    "one-v2",
  );
  assert.equal(
    r.note.files.find((f) => f.document_id === "two").version_id,
    "two-v1",
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM records ORDER BY id").all(),
    before,
  );
  assert.equal(
    db.prepare("SELECT current_version_id FROM documents WHERE id='two'").get()
      .current_version_id,
    "two-v2",
  );
});
test("old unfixed links remain unfixed on retry and can still be explicitly corrected then removed", async (t) => {
  const { db, api, create } = fixture(t),
    n = await create();
  db.prepare(
    "INSERT INTO project_note_files(note_id,document_id,created) VALUES(?,?,?)",
  ).run(n.id, "one", instant);
  installNotesSchema(db);
  let r = await api("/notes/" + n.id);
  let file = r.note.files[0];
  assert.equal(file.version_id, null);
  assert.equal(file.reference_mode, "unfixed");
  assert.equal(file.filename, "one-v2.txt");
  r = await api("/notes/" + n.id + "/files", "POST", {
    document_id: "one",
    version_id: "one-v1",
  });
  assert.equal(r.note.files[0].version_id, null);
  r = await api("/notes/" + n.id, "PATCH", {
    version: n.version,
    body: "Should not replace legacy provenance",
    attachments: [{ document_id: "one", version_id: "one-v1" }],
  });
  assert.equal(r.status, 409);
  assert.equal((await api("/notes/" + n.id)).note.body, n.body);
  r = await api("/notes/" + n.id + "/files/one", "PATCH", {
    version_id: "one-v1",
    link_version: file.link_version,
  });
  assert.equal(r.status, 200);
  assert.equal(r.note.files[0].version_id, "one-v1");
  r = await api("/notes/" + n.id, "PATCH", {
    version: n.version,
    attachments: [{ document_id: "two", version_id: "two-v1" }],
  });
  assert.equal(r.status, 200);
  r = await api("/notes/" + n.id + "/files/one", "DELETE");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.note.files.map((f) => f.document_id),
    ["two"],
  );
});
test("task and checklist associations, independent supplements and stale text conflicts retain previous behavior", async (t) => {
  const { db, api, create } = fixture(t),
    before = db.prepare("SELECT * FROM records ORDER BY id").all();
  const root = await create({
    kind: "file",
    file_direction: "received",
    counterparty: "Fixture sender",
    task_id: "task",
    deliverable_id: "handover",
    attachments: [{ document_id: "one", version_id: "one-v1" }],
  });
  let materials = await api("/records/task/materials");
  assert.ok(materials.notes.some((n) => n.id === root.id));
  const child = await create({
    parent_note_id: root.id,
    body: "Independent supplement",
    attachments: [{ document_id: "two", version_id: "two-v2" }],
  });
  assert.equal(child.parent_note_id, root.id);
  assert.equal(child.task_id, null);
  assert.equal(child.deliverable_id, null);
  assert.equal(child.file_direction, "");
  assert.equal(child.counterparty, "");
  assert.equal((await api("/notes/" + child.id + "/thread")).notes.length, 2);
  await api(
    "/notes/" + root.id,
    "PATCH",
    { version: root.version, body: "Concurrent wording" },
    "bob",
  );
  const link = (await api("/notes/" + root.id)).note.files[0];
  const remove = await api("/notes/" + root.id + "/files/one", "DELETE", {
    link_version: link.link_version,
  });
  assert.equal(remove.status, 200);
  const draftBaseline = { ...root, files: remove.note.files };
  const stale = await api("/notes/" + root.id, "PATCH", {
    version: draftBaseline.version,
    body: "Old local draft",
    attachments: [{ document_id: "two", version_id: "two-v1" }],
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (await api("/notes/" + root.id)).note.body,
    "Concurrent wording",
  );
  for (const b of [
    { task_id: "foreign-task" },
    { deliverable_id: "foreign-handover" },
    { attachments: [{ document_id: "foreign", version_id: "foreign-v1" }] },
    { attachments: [{ document_id: "secret", version_id: "secret-v1" }] },
  ])
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          body: "Invalid association",
          ...b,
        })
      ).status,
      400,
    );
  for (const route of [
    "/projects/p1/notes",
    "/notes/" + root.id,
    "/notes/" + root.id + "/thread",
    "/records/task/materials",
  ])
    assert.equal((await api(route, "GET", {}, null)).status, 401);
  assert.deepEqual(
    db.prepare("SELECT * FROM records ORDER BY id").all(),
    before,
  );
  assert.ok(!isCompleted(before.find((r) => r.id === "task")));
  assert.ok(isCompleted({ actual: "Fixture Alice", date: "" }));
  assert.ok(isCompleted({ actual: "", date: "2026-01-01" }));
});
async function invoke(app, route, method = "GET", body, cookie = "") {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  );
  Object.assign(req, {
    url: "/worklog/api" + route,
    method,
    headers: {
      origin: "http://compat.test",
      "x-worklog-request": "1",
      "content-type": "application/json",
      cookie,
    },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const headers = {};
  let status = 200,
    text = "";
  const res = {
    headersSent: false,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(code, values = {}) {
      status = code;
      this.headersSent = true;
      for (const [k, v] of Object.entries(values)) headers[k.toLowerCase()] = v;
    },
    end(value = "") {
      text += String(value);
    },
  };
  await app.server.listeners("request")[0](req, res);
  return {
    status,
    data: JSON.parse(text),
    cookie: String(headers["set-cookie"] || "").split(";")[0],
  };
}
test("public work logs remain readable while note attachment history stays authenticated and immutable", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "note-compat-review-"));
  const app = await createApp({
    dataDir: temp,
    filesDir: path.join(temp, "synthetic-files"),
    dist: path.join(temp, "unused-dist"),
    origin: "http://compat.test",
    adminLogin: "compat_admin",
    adminPassword: "Compatibility-fixture-123",
    vaultKey: Buffer.alloc(32, 7).toString("base64"),
  });
  t.after(async () => {
    await app.close();
    assert.ok(
      path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await rm(temp, { recursive: true, force: true });
  });
  const auth = await invoke(app, "/login", "POST", {
    login: "compat_admin",
    password: "Compatibility-fixture-123",
  });
  assert.equal(auth.status, 200);
  const cookie = auth.cookie;
  const project = (await invoke(app, "/state")).data.projects[0];
  const task = (
    await invoke(
      app,
      "/records",
      "POST",
      {
        project_id: project.id,
        task: "Original completion rule",
        owner: "管理员",
        actual: "管理员",
        date: "",
      },
      cookie,
    )
  ).data.id;
  const user = app.db
    .prepare("SELECT id FROM users WHERE login='compat_admin'")
    .get();
  seedDocument(app.db, "server-document", project.id, 0, user.id);
  app.db
    .prepare(
      "INSERT INTO document_deliverables(id,project_id,title,created,updated) VALUES(?,?,?,?,?)",
    )
    .run(
      "server-handover",
      project.id,
      "Server checklist fixture",
      instant,
      instant,
    );
  const before = app.db.prepare("SELECT * FROM records WHERE id=?").get(task);
  const n = await invoke(
    app,
    "/projects/" + project.id + "/notes",
    "POST",
    {
      body: "PRIVATE-NOTE-COMPAT-MARKER",
      task_id: task,
      deliverable_id: "server-handover",
      attachments: [
        { document_id: "server-document", version_id: "server-document-v1" },
      ],
    },
    cookie,
  );
  assert.equal(n.status, 201);
  assert.equal(n.data.note.files[0].version_id, "server-document-v1");
  assert.ok(
    (
      await invoke(
        app,
        "/records/" + task + "/materials",
        "GET",
        undefined,
        cookie,
      )
    ).data.notes.some((i) => i.id === n.data.note.id),
  );
  const checklist = await invoke(
    app,
    "/projects/" + project.id + "/deliverables",
    "GET",
    undefined,
    cookie,
  );
  assert.equal(checklist.status, 200);
  assert.equal(
    checklist.data.items.find((i) => i.id === "server-handover").note_count,
    1,
  );
  const publicLogs = await invoke(app, "/logs");
  assert.equal(publicLogs.status, 200);
  assert.ok(!JSON.stringify(publicLogs).includes("PRIVATE-NOTE-COMPAT-MARKER"));
  assert.equal((await invoke(app, "/resource-events")).status, 401);
  const internalLogs = await invoke(
    app,
    "/resource-events",
    "GET",
    undefined,
    cookie,
  );
  assert.equal(internalLogs.status, 200);
  assert.ok(
    JSON.stringify(internalLogs).includes("PRIVATE-NOTE-COMPAT-MARKER"),
  );
  assert.equal((await invoke(app, "/logs", "DELETE", {}, cookie)).status, 405);
  assert.equal(
    (await invoke(app, "/resource-events", "DELETE", {}, cookie)).status,
    405,
  );
  assert.deepEqual(
    app.db.prepare("SELECT * FROM records WHERE id=?").get(task),
    before,
  );
  assert.ok(isCompleted(before));
  assert.throws(() => app.db.exec("DELETE FROM resource_events"), /immutable/i);
});

test("canonical create replay preserves deleted history, normalized intent and clients without request IDs", async (t) => {
  const { db, api } = fixture(t);
  const requestId = "835a0c45-ef12-4d67-b349-abcde1234567";
  const payload = {
    client_request_id: requestId.toUpperCase(),
    kind: "file",
    body: " CLIENT-ID-PRIVATE-BODY ",
    people: "Fixture Alice, Fixture Bob",
    file_direction: "sent",
    counterparty: " Receiver ",
    channel: " Mail ",
    attachments: [
      { document_id: "two", version_id: "two-v1" },
      { document_id: "one", version_id: "one-v1" },
    ],
  };
  const created = await api("/projects/p1/notes", "POST", payload);
  assert.equal(created.status, 201);
  assert.equal(created.replayed, false);
  const id = created.note.id;
  const edited = await api(
    "/notes/" + id,
    "PATCH",
    { version: created.note.version, body: "Later independent wording" },
    "bob",
  );
  assert.equal(edited.status, 200);
  assert.equal(
    (await api("/notes/" + id, "DELETE", { version: edited.note.version }))
      .status,
    200,
  );
  const counts = () =>
    [
      "project_notes",
      "project_note_files",
      "resource_events",
      "project_note_create_requests",
    ].map((table) => db.prepare("SELECT COUNT(*) n FROM " + table).get().n);
  const before = counts();
  const replay = await api("/projects/p1/notes", "POST", {
    ...payload,
    client_request_id: requestId,
    body: "CLIENT-ID-PRIVATE-BODY",
    people: "Fixture Alice、Fixture Bob",
    counterparty: "Receiver",
    channel: "Mail",
    attachments: [...payload.attachments].reverse(),
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.replayed, true);
  assert.equal(replay.note.id, id);
  assert.equal(replay.note.deleted, true);
  assert.equal(replay.note.body, "Later independent wording");
  assert.equal(replay.creation_version, 1);
  assert.deepEqual(counts(), before);
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        ...payload,
        body: "Different intent",
      })
    ).status,
    409,
  );
  assert.deepEqual(counts(), before);
  const stored = db.prepare("SELECT * FROM project_note_create_requests").get();
  assert.match(stored.request_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes("CLIENT-ID-PRIVATE-BODY"));
  const first = await api("/projects/p1/notes", "POST", {
    body: "Legacy optional payload",
  });
  const second = await api("/projects/p1/notes", "POST", {
    body: "Legacy optional payload",
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.note.id, second.note.id);
  const other = await api("/projects/p1/notes", "POST", payload, "bob");
  assert.equal(other.status, 201);
  assert.notEqual(other.note.id, id);
});
