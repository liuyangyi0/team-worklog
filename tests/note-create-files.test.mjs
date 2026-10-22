import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNotes, installNotesSchema } from "../notes.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { installLibraryCommon, resourceEvent } from "../library-common.mjs";

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

const counts = (db) =>
  ["project_notes", "project_note_files", "resource_events"].map(
    (t) => db.prepare("SELECT COUNT(*) count FROM " + t).get().count,
  );

test("one save creates the note and multiple explicit existing versions with complete immutable attachment audit", async (t) => {
  const { db, create, document, version, events } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  version("one", "one-v2", 2);
  document("two");
  version("two", "two-v1", 1);
  const before = db.prepare("SELECT * FROM records ORDER BY id").all();
  const n = await create({
    kind: "file",
    file_direction: "sent",
    counterparty: "Fixture receiver",
    attachments: [
      { document_id: "one", version_id: "one-v1" },
      { document_id: "two", version_id: "two-v1" },
    ],
  });
  assert.equal(n.files.length, 2);
  assert.deepEqual(n.files.map((f) => f.version_id).sort(), [
    "one-v1",
    "two-v1",
  ]);
  assert.ok(
    n.files.every(
      (f) => f.reference_mode === "fixed" && typeof f.link_version === "string",
    ),
  );
  assert.equal(
    db.prepare("SELECT current_version_id FROM documents WHERE id='one'").get()
      .current_version_id,
    "one-v2",
  );
  const log = events();
  assert.equal(log.filter((e) => e.action === "create-note").length, 1);
  assert.deepEqual(
    log
      .filter((e) => e.action === "attach-note")
      .map((e) => e.details.version_id)
      .sort(),
    ["one-v1", "two-v1"],
  );
  for (const e of log.filter((e) => e.action === "attach-note")) {
    assert.equal(e.entity_id, n.id);
    assert.equal(e.actor_id, "alice");
    assert.equal(e.details.after.version_id, e.details.version_id);
  }
  assert.deepEqual(
    db.prepare("SELECT * FROM records ORDER BY id").all(),
    before,
  );
  assert.throws(
    () => db.exec("DELETE FROM resource_events"),
    /immutable|readonly|append|cannot/i,
  );
});

test("invalid or unavailable existing choices reject the entire create without orphan notes, links or audit", async (t) => {
  const { db, api, document, version } = fixture(t);
  document("ok");
  version("ok", "ok-v1", 1);
  document("foreign", "p2");
  version("foreign", "foreign-v1", 1);
  document("secret", "p1", 1);
  version("secret", "secret-v1", 1);
  document("removed");
  version("removed", "removed-v1", 1);
  db.exec("UPDATE documents SET deleted=1 WHERE id='removed'");
  version("ok", "conflict", 2, { current: false, conflict: 1 });
  const good = { document_id: "ok", version_id: "ok-v1" };
  const invalid = [
    null,
    {},
    "bad",
    [{ document_id: "ok" }],
    [good, good],
    [good, { document_id: "foreign", version_id: "foreign-v1" }],
    [good, { document_id: "secret", version_id: "secret-v1" }],
    [good, { document_id: "removed", version_id: "removed-v1" }],
    [good, { document_id: "missing", version_id: "ok-v1" }],
    [{ document_id: "ok", version_id: "foreign-v1" }],
    [{ document_id: "ok", version_id: "conflict" }],
    Array.from({ length: 101 }, (_, i) => ({
      document_id: "doc-" + i,
      version_id: "v-" + i,
    })),
  ];
  const before = counts(db);
  for (const attachments of invalid) {
    const r = await api("/projects/p1/notes", "POST", {
      body: "Must roll back",
      attachments,
    });
    assert.ok([400, 409].includes(r.status), JSON.stringify(r));
    assert.deepEqual(counts(db), before);
  }
  assert.equal(
    (
      await api(
        "/projects/p1/notes",
        "POST",
        { body: "Guest", attachments: [good] },
        null,
      )
    ).status,
    401,
  );
  assert.deepEqual(counts(db), before);
});

test("an attachment audit failure rolls back both new note and existing-note edits including earlier valid choices", async (t) => {
  const { db, api, create, document, version } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  document("two");
  version("two", "two-v1", 1);
  const n = await create({ body: "Original wording" }),
    before = counts(db);
  db.exec(
    "CREATE TRIGGER fail_second_attach BEFORE INSERT ON resource_events WHEN NEW.action='attach-note' AND instr(NEW.details_json,'two-v1')>0 BEGIN SELECT RAISE(ABORT,'attachment-audit-failure'); END",
  );
  const attachments = [
    { document_id: "one", version_id: "one-v1" },
    { document_id: "two", version_id: "two-v1" },
  ];
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        body: "No partial create",
        attachments,
      })
    ).status,
    500,
  );
  assert.deepEqual(counts(db), before);
  assert.equal(
    (
      await api("/notes/" + n.id, "PATCH", {
        version: n.version,
        body: "No partial edit",
        attachments,
      })
    ).status,
    500,
  );
  assert.deepEqual(counts(db), before);
  const unchanged = (await api("/notes/" + n.id)).data.note;
  assert.equal(unchanged.body, n.body);
  assert.equal(unchanged.version, n.version);
  assert.equal(unchanged.files.length, 0);
});

test("existing-note staged links preserve text CAS and never silently replace a concurrently pinned version", async (t) => {
  const { db, api, create, document, version, events } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  version("one", "one-v2", 2);
  const n = await create();
  const updated = (
    await api("/notes/" + n.id, "PATCH", {
      version: n.version,
      body: "Edited with link",
      attachments: [{ document_id: "one", version_id: "one-v1" }],
    })
  ).data.note;
  assert.equal(updated.files[0].version_id, "one-v1");
  assert.equal(updated.version, n.version + 1);
  const before = counts(db);
  assert.equal(
    (
      await api("/notes/" + n.id, "PATCH", {
        version: n.version,
        body: "Stale draft",
        attachments: [],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api("/notes/" + n.id, "PATCH", {
        version: updated.version,
        body: "Wrong repoint",
        attachments: [{ document_id: "one", version_id: "one-v2" }],
      })
    ).status,
    409,
  );
  assert.deepEqual(counts(db), before);
  assert.equal((await api("/notes/" + n.id)).data.note.body, updated.body);
  const repeated = (
    await api("/notes/" + n.id, "PATCH", {
      version: updated.version,
      body: updated.body,
      attachments: [{ document_id: "one", version_id: "one-v1" }],
    })
  ).data.note;
  assert.equal(repeated.files.length, 1);
  assert.equal(events().filter((e) => e.action === "attach-note").length, 1);
});

test("supplements can choose independent historical files at creation and legacy payloads keep working", async (t) => {
  const { db, api, create, document, version } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  version("one", "one-v2", 2);
  const root = await create({
    attachments: [{ document_id: "one", version_id: "one-v1" }],
  });
  const child = await create({
    parent_note_id: root.id,
    kind: "file",
    file_direction: "received",
    attachments: [{ document_id: "one", version_id: "one-v2" }],
  });
  assert.equal(child.parent_note_id, root.id);
  assert.equal(child.files[0].version_id, "one-v2");
  assert.equal(
    (await api("/notes/" + root.id)).data.note.files[0].version_id,
    "one-v1",
  );
  const legacy = await create();
  assert.deepEqual(legacy.files, []);
  const countsBefore = counts(db);
  installNotesSchema(db);
  assert.deepEqual(counts(db), countsBefore);
});
