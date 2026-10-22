import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNotes, installNotesSchema } from "../notes.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { installLibraryCommon, resourceEvent } from "../library-common.mjs";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";

function fixture(t, legacy = false) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','记录人甲','alice'),('bob','记录人乙','bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','项目甲'),('p2','项目乙');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,deleted INTEGER);
    INSERT INTO records VALUES('task1','p1','调试',0),('task2','p2','交付',0);`);
  installLibraryCommon(db);
  if (legacy)
    db.exec(`
    CREATE TABLE project_notes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,body TEXT NOT NULL,occurred_on TEXT NOT NULL DEFAULT '',people TEXT NOT NULL DEFAULT '',deliverable_id TEXT,task_id TEXT,author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE project_note_files(note_id TEXT NOT NULL REFERENCES project_notes(id),document_id TEXT NOT NULL REFERENCES documents(id),created TEXT NOT NULL,PRIMARY KEY(note_id,document_id));`);
  installDocumentSchema(db);
  const notes = createNotes({ db });
  async function api(route, method = "GET", b = {}, actor = "alice") {
    const url = new URL(route, "http://localhost");
    try {
      const result = await notes.api({
        route: url.pathname,
        method,
        b,
        params: url.searchParams,
        user: actor
          ? db.prepare("SELECT * FROM users WHERE id=?").get(actor)
          : null,
      });
      return { status: result?.status || 200, data: result?.data };
    } catch (error) {
      return { status: error.status || 500, data: { error: error.message } };
    }
  }
  async function create(body = {}) {
    const result = await api("/projects/p1/notes", "POST", {
      body: "现场记录",
      ...body,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.note;
  }
  function document(id = "doc1", projectId = "p1", sensitive = 0) {
    db.prepare(
      "INSERT INTO documents(id,project_id,title,sensitive,creator,created,updated) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      projectId,
      "资料 " + id,
      sensitive,
      "alice",
      "2026-10-01T08:00:00Z",
      "2026-10-01T08:00:00Z",
    );
    return id;
  }
  function version(
    documentId,
    id,
    number,
    { conflict = 0, current = true } = {},
  ) {
    db.prepare("INSERT INTO document_blobs VALUES(?,?,?)").run(
      id,
      number * 10,
      "2026-10-01T08:00:00Z",
    );
    db.prepare(
      "INSERT INTO document_versions(id,document_id,number,filename,size,sha256,blob_hash,created_by,creator_id,created,conflict) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      documentId,
      number,
      `原件-v${number}.txt`,
      number * 10,
      id,
      id,
      "记录人甲",
      "alice",
      "2026-10-01T08:00:00Z",
      conflict,
    );
    if (current)
      db.prepare("UPDATE documents SET current_version_id=? WHERE id=?").run(
        id,
        documentId,
      );
    return id;
  }
  const events = () =>
    db
      .prepare("SELECT * FROM resource_events ORDER BY id")
      .all()
      .map(({ details_json, ...event }) => ({
        ...event,
        details: JSON.parse(details_json),
      }));
  return { db, api, create, document, version, events };
}

test("new note attachments pin a concrete version and retrying an attach cannot silently repoint it", async (t) => {
  const { db, api, create, document, version, events } = fixture(t);
  const n = await create();
  document();
  version("doc1", "v1", 1);
  const first = await api(`/notes/${n.id}/files`, "POST", {
    document_id: "doc1",
  });
  assert.equal(first.status, 201);
  const file = first.data.note.files[0];
  assert.equal(file.version_id, "v1");
  assert.equal(file.number, 1);
  assert.equal(file.reference_mode, "fixed");
  assert.equal(typeof file.link_version, "string");
  assert.equal(first.data.note.version, n.version);
  version("doc1", "v2", 2);
  const seen = (await api(`/notes/${n.id}`)).data.note.files[0];
  assert.equal(seen.filename, "原件-v1.txt");
  assert.equal(seen.size, 10);
  assert.equal(seen.current_version_id, "v2");
  const retried = await api(`/notes/${n.id}/files`, "POST", {
    document_id: "doc1",
    version_id: "v2",
  });
  assert.equal(retried.data.note.files[0].version_id, "v1");
  assert.equal(retried.data.note.files[0].link_version, file.link_version);
  assert.equal(events().filter((e) => e.action === "attach-note").length, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    2,
  );
  assert.throws(
    () => db.prepare("DELETE FROM document_versions WHERE id='v1'").run(),
    /immutable/,
  );
  const other = await create({ body: "人工选择旧版" });
  const explicit = await api(`/notes/${other.id}/files`, "POST", {
    document_id: "doc1",
    version_id: "v1",
  });
  assert.equal(explicit.data.note.files[0].version_id, "v1");
});

test("attachments reject invalid, foreign, sensitive and unresolved conflict versions without writes", async (t) => {
  const { db, api, create, document, version, events } = fixture(t);
  const n = await create();
  document();
  version("doc1", "v1", 1);
  document("foreign", "p2");
  version("foreign", "foreign-v1", 1);
  document("secret", "p1", 1);
  version("secret", "secret-v1", 1);
  document("empty");
  document("removed");
  version("removed", "removed-v1", 1);
  db.prepare("UPDATE documents SET deleted=1 WHERE id='removed'").run();
  version("doc1", "candidate", 2, { conflict: 1, current: false });
  for (const body of [
    { document_id: "missing" },
    { document_id: "foreign" },
    { document_id: "secret" },
    { document_id: "empty" },
    { document_id: "removed" },
    { document_id: "doc1", version_id: null },
    { document_id: "doc1", version_id: "missing" },
    { document_id: "doc1", version_id: "foreign-v1" },
  ]) {
    assert.equal(
      (await api(`/notes/${n.id}/files`, "POST", body)).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal(
    (
      await api(`/notes/${n.id}/files`, "POST", {
        document_id: "doc1",
        version_id: "candidate",
      })
    ).status,
    409,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_files").get().n,
    0,
  );
  assert.equal(events().filter((e) => e.action.includes("attach")).length, 0);
  // Conflict candidates become valid only after an explicit library adoption.
  db.prepare(
    "UPDATE documents SET current_version_id='candidate' WHERE id='doc1'",
  ).run();
  assert.equal(
    (await api(`/notes/${n.id}/files`, "POST", { document_id: "doc1" })).status,
    201,
  );
});

test("legacy links stay explicitly unfixed; manual fixes use CAS and prevent detach/reattach ABA overwrites", async (t) => {
  const { db, api, create, document, version, events } = fixture(t, true);
  const n = await create();
  document();
  version("doc1", "v1", 1);
  // Represents an existing row before attachment pinning was available.
  db.prepare(
    "INSERT INTO project_note_files(note_id,document_id,created) VALUES(?,?,?)",
  ).run(n.id, "doc1", "2026-10-01T08:00:00Z");
  db.exec(
    "ALTER TABLE project_note_files DROP COLUMN version_id; ALTER TABLE project_note_files DROP COLUMN link_version",
  );
  installNotesSchema(db);
  const first = (await api(`/notes/${n.id}`)).data.note.files[0];
  assert.equal(first.version_id, null);
  assert.equal(first.reference_mode, "unfixed");
  assert.ok(first.link_version);
  installNotesSchema(db);
  assert.equal(
    (await api(`/notes/${n.id}`)).data.note.files[0].link_version,
    first.link_version,
  );
  version("doc1", "v2", 2);
  let file = (await api(`/notes/${n.id}`)).data.note.files[0];
  assert.equal(file.filename, "原件-v2.txt");
  assert.equal(file.version_id, null);
  assert.equal(
    (await api(`/notes/${n.id}/files`, "POST", { document_id: "doc1" })).data
      .note.files[0].reference_mode,
    "unfixed",
  );
  assert.equal(
    (await api(`/notes/${n.id}/files/doc1`, "PATCH", { version_id: "v1" }))
      .status,
    409,
  );
  assert.equal(
    (
      await api(`/notes/${n.id}/files/doc1`, "PATCH", {
        version_id: "missing",
        link_version: first.link_version,
      })
    ).status,
    400,
  );
  const fixed = await api(
    `/notes/${n.id}/files/doc1`,
    "PATCH",
    { version_id: "v1", link_version: first.link_version },
    "bob",
  );
  assert.equal(fixed.status, 200);
  file = fixed.data.note.files[0];
  assert.equal(file.version_id, "v1");
  assert.equal(file.reference_mode, "fixed");
  assert.notEqual(file.link_version, first.link_version);
  assert.equal(
    (
      await api(`/notes/${n.id}/files/doc1`, "PATCH", {
        version_id: "v2",
        link_version: first.link_version,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(`/notes/${n.id}/files/doc1`, "DELETE", {
        link_version: first.link_version,
      })
    ).status,
    409,
  );
  const update = events().find((e) => e.action === "update-note-file");
  assert.equal(update.actor_id, "bob");
  assert.equal(update.details.before.version_id, null);
  assert.equal(update.details.before.reference_mode, "unfixed");
  assert.equal(update.details.after.version_id, "v1");
  assert.equal(update.details.after.link_version, file.link_version);
  assert.equal(
    (
      await api(`/notes/${n.id}/files/doc1`, "DELETE", {
        link_version: file.link_version,
      })
    ).status,
    200,
  );
  const detached = events().find((e) => e.action === "detach-note");
  assert.equal(detached.details.before.version_id, "v1");
  assert.equal(detached.details.after, null);
  const replacement = (
    await api(`/notes/${n.id}/files`, "POST", { document_id: "doc1" })
  ).data.note.files[0];
  assert.notEqual(replacement.link_version, file.link_version);
  assert.equal(
    (
      await api(`/notes/${n.id}/files/doc1`, "PATCH", {
        version_id: "v1",
        link_version: file.link_version,
      })
    ).status,
    409,
  );
  assert.equal(
    (await api(`/notes/${n.id}`)).data.note.files[0].version_id,
    "v2",
  );
});

test("supplements normalize to one immutable root while each keeps its own author, dates, body and correction history", async (t) => {
  const { db, api, create, events } = fixture(t);
  const root = await create({
    body: "最初发现",
    occurred_on: "2026-10-19",
    task_id: "task1",
  });
  const one = (
    await api(
      "/projects/p1/notes",
      "POST",
      {
        body: "乙现场补充",
        parent_note_id: root.id,
        occurred_on: "2026-10-20",
        people: "记录人乙",
      },
      "bob",
    )
  ).data.note;
  const two = await create({
    body: "第三次进展",
    parent_note_id: one.id,
    occurred_on: "2026-10-21",
  });
  assert.equal(one.author_id, "bob");
  assert.equal(one.task_id, null);
  assert.equal(two.parent_note_id, root.id);
  assert.equal(two.thread_root_id, root.id);
  assert.equal(two.thread_count, 3);
  assert.equal(root.parent_note_id, null);
  const thread = (await api(`/notes/${one.id}/thread`)).data;
  assert.equal(thread.root.id, root.id);
  assert.deepEqual(
    thread.notes.map((n) => n.id),
    [root.id, one.id, two.id],
  );
  assert.deepEqual(
    thread.notes.map((n) => n.author_id),
    ["alice", "bob", "alice"],
  );
  assert.ok(thread.notes.every((n) => n.created && n.updated && n.files));
  const changed = await api(
    `/notes/${one.id}`,
    "PATCH",
    { version: one.version, body: "乙纠正现场信息", occurred_on: "2026-10-18" },
    "alice",
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.note.author_id, "bob");
  assert.equal(changed.data.note.created, one.created);
  assert.equal(
    (
      await api(`/notes/${one.id}`, "PATCH", {
        version: one.version,
        body: "过期覆盖",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(`/notes/${one.id}`, "PATCH", {
        version: changed.data.note.version,
        parent_note_id: null,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api(`/notes/${one.id}`, "PATCH", {
        version: changed.data.note.version,
        thread_root_id: one.id,
      })
    ).status,
    400,
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE project_notes SET parent_note_id=NULL WHERE id=?")
        .run(one.id),
    /immutable/,
  );
  const update = events().find((e) => e.action === "update-note");
  assert.equal(update.details.before.body, one.body);
  assert.equal(update.details.before.occurred_on, "2026-10-20");
  assert.equal(update.details.after.occurred_on, "2026-10-18");
  assert.equal(update.details.after.parent_note_id, root.id);
  const created = events().find(
    (e) => e.entity_id === two.id && e.action === "create-note",
  );
  assert.equal(created.details.after.parent_note_id, root.id);
  assert.equal(created.details.after.thread_root_id, root.id);
});

test("root deletion is independent and a visible supplement can continue the same matter", async (t) => {
  const { api, create } = fixture(t);
  const root = await create({ body: "事项根" });
  const supplement = await create({
    body: "继续跟进",
    parent_note_id: root.id,
  });
  const foreign = (
    await api("/projects/p2/notes", "POST", { body: "别的项目" })
  ).data.note;
  for (const parent_note_id of ["missing", foreign.id, "", 1, {}])
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          body: "不应写入",
          parent_note_id,
        })
      ).status,
      400,
    );
  const deleted = await api(
    `/notes/${root.id}`,
    "DELETE",
    { version: root.version },
    "bob",
  );
  assert.equal(deleted.status, 200);
  const detail = (await api(`/notes/${root.id}`)).data.note;
  assert.equal(detail.deleted, true);
  assert.equal(detail.thread_count, 1);
  assert.equal(detail.thread_deleted_count, 1);
  assert.deepEqual(
    (await api("/projects/p1/notes")).data.notes.map((n) => n.id),
    [supplement.id],
  );
  assert.equal(
    (await api("/projects/p1/notes?deleted=1")).data.notes[0].id,
    root.id,
  );
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        body: "直接向删根写入",
        parent_note_id: root.id,
      })
    ).status,
    400,
  );
  const resumed = await create({
    body: "从活动补充继续",
    parent_note_id: supplement.id,
  });
  assert.equal(resumed.parent_note_id, root.id);
  const thread = (await api(`/notes/${resumed.id}/thread`)).data;
  assert.equal(thread.root.deleted, true);
  assert.equal(thread.notes.length, 3);
  assert.equal(thread.notes.filter((n) => !n.deleted).length, 2);
  assert.equal(
    (
      await api(`/notes/${supplement.id}`, "DELETE", {
        version: supplement.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        body: "已删补充不可选",
        parent_note_id: supplement.id,
      })
    ).status,
    400,
  );
  const restored = await api(`/notes/${root.id}/restore`, "POST", {
    version: deleted.data.version,
  });
  assert.equal(restored.data.note.deleted, false);
  assert.equal(restored.data.note.thread_count, 2);
  assert.equal((await api(`/notes/${supplement.id}`)).data.note.deleted, true);
});

test("note detail, threads, mutations and attachments all require login; calendar year zero is rejected", async (t) => {
  const { db, api, create } = fixture(t);
  const n = await create();
  for (const [route, method, b] of [
    ["/projects/p1/notes", "GET"],
    ["/projects/p1/notes", "POST", { body: "guest" }],
    [`/notes/${n.id}`, "GET"],
    [`/notes/${n.id}/thread`, "GET"],
    [`/notes/${n.id}`, "PATCH", { version: 1, body: "guest" }],
    [`/notes/${n.id}`, "DELETE", { version: 1 }],
    [`/notes/${n.id}/restore`, "POST", { version: 1 }],
    [`/notes/${n.id}/files`, "POST", { document_id: "doc1" }],
    [`/notes/${n.id}/files/doc1`, "PATCH", { version_id: "v1" }],
    [`/notes/${n.id}/files/doc1`, "DELETE"],
  ])
    assert.equal((await api(route, method, b, "")).status, 401, route);
  for (const occurred_on of [
    "0000-01-01",
    "2026-02-29",
    "2026-13-01",
    "2026-02-30",
  ])
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          body: "bad date",
          occurred_on,
        })
      ).status,
      400,
    );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_notes").get().n, 1);
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        body: "leap day",
        occurred_on: "2024-02-29",
      })
    ).status,
    201,
  );
});

test("note snapshots preserve full wording and safe metadata without enabling vault snapshots", async (t) => {
  const { db, api, create, events } = fixture(t);
  const before = "原".repeat(3997) + "旧结尾";
  const after = "改".repeat(3997) + "新结尾";
  const n = await create({ body: before });
  assert.equal(
    (
      await api(`/notes/${n.id}`, "PATCH", {
        version: n.version,
        body: after,
        occurred_on: "2026-10-22",
        people: "记录人甲、记录人乙",
      })
    ).status,
    200,
  );
  const update = events().find((e) => e.action === "update-note");
  assert.equal(update.details.from, before);
  assert.equal(update.details.to, after);
  assert.equal(update.details.before.body, before);
  assert.equal(update.details.after.body, after);
  assert.equal(update.details.after.occurred_on, "2026-10-22");
  assert.equal(update.details.after.people, "记录人甲、记录人乙");
  assert.equal(
    events().find((e) => e.action === "create-note").details.after.body,
    before,
  );
  const actor = db.prepare("SELECT * FROM users WHERE id='alice'").get();
  for (const entityType of ["credential", "configuration", "document"]) {
    resourceEvent(db, actor, {
      action: "test-snapshot",
      entityType,
      entityId: "synthetic",
      details: {
        before: { body: "secret-old", password: "secret-old" },
        after: { body: "secret-new", payload: "secret-new" },
      },
    });
    assert.deepEqual(events().at(-1).details, {}, entityType);
  }
  resourceEvent(db, actor, {
    action: "test-snapshot",
    entityType: "note",
    entityId: n.id,
    details: {
      before: {
        body: before,
        password: "secret-old",
        payload: "secret-old",
        files: [{ password: "secret-old" }],
      },
      after: {
        body: { password: "secret-new" },
        author_name: "x".repeat(200),
        nested: { password: "secret-new" },
      },
    },
  });
  const safe = events().at(-1).details;
  assert.deepEqual(safe.before, { body: before });
  assert.deepEqual(safe.after, { author_name: "x".repeat(100) });
  assert.throws(
    () => db.prepare("DELETE FROM resource_events WHERE id=?").run(update.id),
    /immutable/,
  );
});

test("the pinned original remains downloadable after later uploads, and guest download is denied", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "worklog-record-archive-"),
  );
  const origin = "http://127.0.0.1";
  const app = await createApp({
    allowUninvitedRegistration: true,
    dataDir,
    origin,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/worklog/api`;
  let cookie = "";
  const headers = (binary = false) => ({
    Origin: origin,
    "Content-Type": binary ? "application/octet-stream" : "application/json",
    "X-Worklog-Request": "1",
    Cookie: cookie,
  });
  async function api(route, method = "GET", body) {
    const response = await fetch(base + route, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  }
  await api("/register", "POST", {
    name: REGISTRATION_NAMES[0],
    login: "record_archive",
    password: "Temporary-record-123",
  });
  const project = (await api("/state")).projects[0].id;
  const note = (
    await api(`/projects/${project}/notes`, "POST", { body: "保留原件" })
  ).note;
  async function upload(bytes, extra = {}) {
    const initialized = await api("/uploads", "POST", {
      project_id: project,
      filename: "原始说明.txt",
      size: bytes.length,
      ...extra,
    });
    const chunk = await fetch(`${base}/uploads/${initialized.id}/chunks/0`, {
      method: "PUT",
      headers: headers(true),
      body: bytes,
    });
    assert.ok(chunk.ok);
    return api(`/uploads/${initialized.id}/complete`, "POST", {});
  }
  const original = Buffer.from("最初原件\nversion one\u0000");
  const first = await upload(original);
  await api(`/notes/${note.id}/files`, "POST", {
    document_id: first.document_id,
  });
  const next = await upload(Buffer.from("后来修订 version two"), {
    document_id: first.document_id,
    base_version_id: first.version_id,
    filename: "修订说明.txt",
  });
  const pinned = (await api(`/notes/${note.id}`)).note.files[0];
  assert.equal(pinned.version_id, first.version_id);
  assert.equal(pinned.current_version_id, next.version_id);
  const route = `${base}/documents/${pinned.document_id}/versions/${pinned.version_id}/download`;
  const download = await fetch(route, { headers: headers() });
  assert.ok(download.ok);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
  assert.equal((await fetch(route)).status, 401);
});
