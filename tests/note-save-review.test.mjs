import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNotes, installNotesSchema } from "../notes.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { installLibraryCommon } from "../library-common.mjs";

function fixture(t, persistent = false) {
  const dataDir = persistent
    ? mkdtempSync(path.join(os.tmpdir(), "worklog-note-save-review-"))
    : null;
  const filename = dataDir
    ? path.join(dataDir, "synthetic.sqlite")
    : ":memory:";
  let db = new DatabaseSync(filename);
  t.after(() => {
    db.close();
    if (dataDir) {
      assert.ok(
        path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','合成成员甲','alice'),('bob','合成成员乙','bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','合成项目甲'),('p2','合成项目乙');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,deleted INTEGER,actual TEXT,date TEXT);
    INSERT INTO records VALUES('task','p1','不应被自动完成',0,'','');`);
  installLibraryCommon(db);
  installDocumentSchema(db);
  let service = createNotes({ db });
  const api = async (route, method = "GET", b = {}, actor = "alice") => {
    const url = new URL(route, "http://fixture.test");
    try {
      const result = await service.api({
        route: url.pathname,
        params: url.searchParams,
        method,
        b,
        user: actor
          ? db.prepare("SELECT * FROM users WHERE id=?").get(actor)
          : null,
      });
      return { status: result?.status || 200, ...result?.data };
    } catch (error) {
      return {
        status: error.status || 500,
        error: error.message,
        code: error.code,
      };
    }
  };
  const restart = () => {
    if (persistent) {
      db.close();
      db = new DatabaseSync(filename);
      db.exec("PRAGMA foreign_keys=ON");
    }
    installNotesSchema(db);
    service = createNotes({ db });
  };
  const document = (id, project = "p1", sensitive = 0) =>
    db
      .prepare(
        "INSERT INTO documents(id,project_id,title,creator,sensitive,created,updated) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        project,
        "合成资料 " + id,
        "alice",
        sensitive,
        "2026-10-20T00:00:00Z",
        "2026-10-20T00:00:00Z",
      );
  const version = (documentId, id, number, conflict = 0) => {
    db.prepare("INSERT INTO document_blobs VALUES(?,?,?)").run(
      id,
      number,
      "2026-10-20T00:00:00Z",
    );
    db.prepare(
      "INSERT INTO document_versions(id,document_id,number,filename,size,sha256,blob_hash,created_by,creator_id,created,conflict) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      documentId,
      number,
      `${id}.txt`,
      number,
      id,
      id,
      "合成成员甲",
      "alice",
      "2026-10-20T00:00:00Z",
      conflict,
    );
    if (!conflict)
      db.prepare("UPDATE documents SET current_version_id=? WHERE id=?").run(
        id,
        documentId,
      );
  };
  const counts = () =>
    ["project_notes", "project_note_files", "resource_events"].map(
      (table) => db.prepare("SELECT COUNT(*) n FROM " + table).get().n,
    );
  const events = () =>
    db
      .prepare("SELECT * FROM resource_events ORDER BY id")
      .all()
      .map(({ details_json, ...row }) => ({
        ...row,
        details: JSON.parse(details_json),
      }));
  return {
    get db() {
      return db;
    },
    api,
    restart,
    document,
    version,
    counts,
    events,
  };
}

test("review: retry after a committed create response is lost must reuse one note, attachment set and immutable audit", async (t) => {
  const { api, restart, document, version, counts, events } = fixture(t, true);
  document("doc");
  version("doc", "v1", 1);
  version("doc", "v2", 2);
  const payload = {
    client_request_id: randomUUID(),
    kind: "file",
    body: "模拟服务端已提交、客户端未收到响应",
    attachments: [{ document_id: "doc", version_id: "v1" }],
  };
  const committed = await api("/projects/p1/notes", "POST", payload);
  assert.equal(committed.status, 201);
  assert.equal(committed.replayed, false);
  assert.equal(committed.creation_version, 1);
  const before = counts();
  restart();
  const replayed = await api(
    "/projects/p1/notes",
    "POST",
    structuredClone(payload),
  );
  assert.equal(replayed.status, 201);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.creation_version, 1);
  assert.equal(replayed.note.id, committed.note.id);
  assert.deepEqual(counts(), before);
  assert.deepEqual(replayed.note.files, committed.note.files);
  assert.equal(
    events().filter((event) => event.action === "create-note").length,
    1,
  );
  assert.equal(
    events().filter((event) => event.action === "attach-note").length,
    1,
  );
});

test("review: same-key concurrent submissions reuse one note and canonical choices while unknown fields cannot enter persisted intent", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  document("two");
  version("two", "two-v1", 1);
  const payload = {
    client_request_id: randomUUID(),
    body: " 并发原稿 ",
    people: "合成成员甲、 合成成员乙",
    attachments: [
      { document_id: "two", version_id: "two-v1" },
      { document_id: "one", version_id: "one-v1" },
    ],
  };
  const submissions = await Promise.all(
    Array.from({ length: 8 }, () =>
      api("/projects/p1/notes", "POST", structuredClone(payload)),
    ),
  );
  assert.ok(submissions.every((result) => result.status === 201));
  assert.equal(new Set(submissions.map((result) => result.note.id)).size, 1);
  assert.equal(submissions.filter((result) => !result.replayed).length, 1);
  assert.deepEqual(counts(), [1, 2, 3]);
  const canonical = await api("/projects/p1/notes", "POST", {
    ...payload,
    client_request_id: payload.client_request_id.toUpperCase(),
    body: "并发原稿",
    people: "合成成员甲、合成成员乙",
    attachments: payload.attachments.toReversed(),
    password: "DO-NOT-STORE-RAW-UNKNOWN",
    nested: { secret: "DO-NOT-STORE-RAW-UNKNOWN" },
  });
  assert.equal(canonical.replayed, true);
  const requests = db
    .prepare("SELECT * FROM project_note_create_requests")
    .all();
  assert.equal(requests.length, 1);
  assert.match(requests[0].request_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(requests).includes("DO-NOT-STORE"));
  assert.ok(!JSON.stringify(requests).includes("并发原稿"));
  assert.ok(!JSON.stringify(canonical.note).includes("request_hash"));
  assert.deepEqual(counts(), [1, 2, 3]);
});

test("review: a reused create key rejects changed intent and stays isolated by author and project", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("doc");
  version("doc", "v1", 1);
  version("doc", "v2", 2);
  const payload = {
    client_request_id: randomUUID(),
    kind: "file",
    body: "确定的一次提交",
    occurred_on: "2026-10-20",
    file_direction: "received",
    counterparty: "客户A",
    exchange_time: "09:00",
    channel: "邮件",
    attachments: [{ document_id: "doc", version_id: "v1" }],
  };
  const committed = await api("/projects/p1/notes", "POST", payload);
  const baseline = counts();
  for (const changed of [
    { body: "不同正文" },
    { kind: "other" },
    { occurred_on: "2026-10-21" },
    { people: "其他人" },
    { counterparty: "客户B" },
    { exchange_time: "10:00" },
    { channel: "群聊" },
    { file_direction: "sent" },
    { parent_note_id: "missing" },
    { task_id: "missing" },
    { deliverable_id: "missing" },
    { attachments: [] },
    { attachments: [{ document_id: "doc", version_id: "v2" }] },
  ]) {
    assert.equal(
      (await api("/projects/p1/notes", "POST", { ...payload, ...changed }))
        .status,
      409,
      JSON.stringify(changed),
    );
    assert.deepEqual(counts(), baseline);
  }
  const simple = {
    client_request_id: payload.client_request_id,
    body: "其他账号或项目自己的提交",
  };
  const bob = await api("/projects/p1/notes", "POST", simple, "bob");
  const otherProject = await api("/projects/p2/notes", "POST", simple);
  assert.equal(bob.replayed, false);
  assert.equal(otherProject.replayed, false);
  assert.equal(
    new Set([committed.note.id, bob.note.id, otherProject.note.id]).size,
    3,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_create_requests").get().n,
    3,
  );
  assert.equal(
    (
      await api(
        "/projects/p1/notes",
        "POST",
        { ...simple, client_request_id: "invalid" },
        null,
      )
    ).status,
    401,
  );
});

test("review: committed replay survives later edits, deletion and invalidated original relationships without refreshing the old CAS baseline", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("doc");
  version("doc", "v1", 1);
  version("doc", "v2", 2);
  const parent = (await api("/projects/p1/notes", "POST", { body: "原父项" }))
    .note;
  const payload = {
    client_request_id: randomUUID(),
    body: "原补充正文",
    task_id: "task",
    parent_note_id: parent.id,
    attachments: [{ document_id: "doc", version_id: "v1" }],
  };
  const committed = await api("/projects/p1/notes", "POST", payload);
  const changed = await api(
    `/notes/${committed.note.id}`,
    "PATCH",
    { version: 1, body: "其他人已修改的正文" },
    "bob",
  );
  assert.equal(changed.status, 200);
  await api(`/notes/${parent.id}`, "DELETE", { version: parent.version });
  db.exec(
    "UPDATE records SET deleted=1 WHERE id='task'; UPDATE documents SET deleted=1,sensitive=1 WHERE id='doc'",
  );
  const beforeReplay = counts();
  const replayed = await api("/projects/p1/notes", "POST", payload);
  assert.equal(replayed.status, 201);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.note.id, committed.note.id);
  assert.equal(replayed.note.body, "其他人已修改的正文");
  assert.equal(replayed.note.version, 2);
  assert.equal(replayed.creation_version, 1);
  assert.deepEqual(counts(), beforeReplay);
  assert.equal(
    (
      await api(`/notes/${committed.note.id}`, "PATCH", {
        version: replayed.creation_version,
        body: "不能用当前版本盲盖旧草稿",
      })
    ).status,
    409,
  );
  const deletion = await api(
    `/notes/${committed.note.id}`,
    "DELETE",
    { version: changed.note.version },
    "bob",
  );
  assert.equal(deletion.status, 200);
  const afterDeletion = counts();
  const deletedReplay = await api("/projects/p1/notes", "POST", payload);
  assert.equal(deletedReplay.status, 201);
  assert.equal(deletedReplay.note.deleted, true);
  assert.equal(deletedReplay.note.id, committed.note.id);
  assert.equal(deletedReplay.creation_version, 1);
  assert.equal(deletedReplay.note.version, 3);
  assert.deepEqual(counts(), afterDeletion);
});

test("review: invalid keys and failed batch audit leave no idempotency reservation; old clients still create distinct notes", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  for (const client_request_id of [
    null,
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
    1,
    {},
    [],
  ]) {
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          client_request_id,
          body: "无效key",
        })
      ).status,
      400,
    );
    assert.deepEqual(counts(), [0, 0, 0]);
  }
  document("one");
  version("one", "one-v1", 1);
  document("two");
  version("two", "two-v1", 1);
  db.exec(
    "CREATE TRIGGER fail_new_create_batch BEFORE INSERT ON resource_events WHEN NEW.action='attach-note' AND instr(NEW.details_json,'two-v1')>0 BEGIN SELECT RAISE(ABORT,'synthetic failing batch'); END",
  );
  const payload = {
    client_request_id: randomUUID(),
    body: "不得半保存",
    attachments: [
      { document_id: "one", version_id: "one-v1" },
      { document_id: "two", version_id: "two-v1" },
    ],
  };
  assert.equal((await api("/projects/p1/notes", "POST", payload)).status, 500);
  assert.deepEqual(counts(), [0, 0, 0]);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_create_requests").get().n,
    0,
  );
  db.exec("DROP TRIGGER fail_new_create_batch");
  const repaired = await api("/projects/p1/notes", "POST", {
    ...payload,
    body: "明确失败后可以修正并重新提交",
  });
  assert.equal(repaired.status, 201);
  assert.equal(repaired.replayed, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_create_requests").get().n,
    1,
  );
  const legacy1 = await api("/projects/p1/notes", "POST", {
    body: "旧客户端没有key",
  });
  const legacy2 = await api("/projects/p1/notes", "POST", {
    body: "旧客户端没有key",
  });
  assert.equal(legacy1.status, 201);
  assert.equal(legacy2.status, 201);
  assert.notEqual(legacy1.note.id, legacy2.note.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_create_requests").get().n,
    1,
  );
});

test("review: definite uncommitted create errors can repair a rejected choice while committed hash conflicts never advertise a safe new create", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("doc");
  version("doc", "v1", 1);
  version("doc", "candidate", 2, 1);
  const payload = {
    client_request_id: randomUUID(),
    body: "所选已采用版本随后被其他人切离",
    attachments: [{ document_id: "doc", version_id: "candidate" }],
  };
  const rejected = await api("/projects/p1/notes", "POST", payload);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.code, "NOTE_CREATE_NOT_COMMITTED");
  assert.deepEqual(counts(), [0, 0, 0]);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_note_create_requests").get().n,
    0,
  );
  const badDate = await api("/projects/p1/notes", "POST", {
    ...payload,
    occurred_on: "2026-02-30",
    attachments: [],
  });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.code, "NOTE_CREATE_NOT_COMMITTED");
  assert.deepEqual(counts(), [0, 0, 0]);
  const repaired = await api("/projects/p1/notes", "POST", {
    ...payload,
    attachments: [{ document_id: "doc", version_id: "v1" }],
  });
  assert.equal(repaired.status, 201);
  assert.equal(repaired.replayed, false);
  assert.equal(repaired.note.files[0].version_id, "v1");
  const committedConflict = await api("/projects/p1/notes", "POST", {
    ...payload,
    body: "不得当作尚未保存的新草稿",
  });
  assert.equal(committedConflict.status, 409);
  assert.equal(committedConflict.code, undefined);
  const malformedCommitted = await api("/projects/p1/notes", "POST", {
    ...payload,
    attachments: null,
  });
  assert.equal(malformedCommitted.status, 400);
  assert.equal(malformedCommitted.code, undefined);
  assert.deepEqual(counts(), [1, 1, 2]);
});

test("review: a later invalid attachment, unavailable version or failed audit cannot partially create or edit a note", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("one");
  version("one", "one-v1", 1);
  document("two");
  version("two", "two-v1", 1);
  document("foreign", "p2");
  version("foreign", "foreign-v1", 1);
  document("secret", "p1", 1);
  version("secret", "secret-v1", 1);
  version("one", "one-candidate", 2, 1);
  const created = await api("/projects/p1/notes", "POST", { body: "原正文" });
  const baseline = counts();
  const good = { document_id: "one", version_id: "one-v1" };
  for (const bad of [
    { document_id: "foreign", version_id: "foreign-v1" },
    { document_id: "secret", version_id: "secret-v1" },
    { document_id: "two", version_id: "one-v1" },
    { document_id: "one", version_id: "one-candidate" },
  ]) {
    const attachments = [good, bad];
    assert.ok(
      [400, 409].includes(
        (
          await api("/projects/p1/notes", "POST", {
            body: "不应新增",
            attachments,
          })
        ).status,
      ),
    );
    assert.ok(
      [400, 409].includes(
        (
          await api(`/notes/${created.note.id}`, "PATCH", {
            version: 1,
            body: "不应更正",
            attachments,
          })
        ).status,
      ),
    );
    assert.deepEqual(counts(), baseline);
    assert.equal((await api(`/notes/${created.note.id}`)).note.body, "原正文");
  }
  db.exec(
    "CREATE TRIGGER fail_later_note_link BEFORE INSERT ON resource_events WHEN NEW.action='attach-note' AND instr(NEW.details_json,'two-v1')>0 BEGIN SELECT RAISE(ABORT,'synthetic late audit failure'); END",
  );
  for (const [route, method] of [
    ["/projects/p1/notes", "POST"],
    [`/notes/${created.note.id}`, "PATCH"],
  ]) {
    const result = await api(route, method, {
      body: "不应半保存",
      version: 1,
      attachments: [good, { document_id: "two", version_id: "two-v1" }],
    });
    assert.equal(result.status, 500);
    assert.deepEqual(counts(), baseline);
  }
});

test("review: old payloads, additive choices, deleted notes, pinned references and note CAS preserve earlier behavior", async (t) => {
  const { db, api, document, version, counts } = fixture(t);
  document("doc");
  version("doc", "v1", 1);
  version("doc", "v2", 2);
  const created = await api("/projects/p1/notes", "POST", {
    body: "旧payload仍可无附件新建",
    kind: "file",
    file_direction: "received",
    task_id: "task",
  });
  assert.equal(created.status, 201);
  const attached = await api(`/notes/${created.note.id}/files`, "POST", {
    document_id: "doc",
    version_id: "v1",
  });
  const edited = await api(`/notes/${created.note.id}`, "PATCH", {
    version: 1,
    body: "旧payload更正文保留引用",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.note.file_direction, "received");
  assert.deepEqual(edited.note.files, attached.note.files);
  const blank = await api(`/notes/${created.note.id}`, "PATCH", {
    version: edited.note.version,
    attachments: [],
  });
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.note.files, attached.note.files);
  const baseline = counts();
  assert.equal(
    (
      await api(`/notes/${created.note.id}`, "PATCH", {
        version: blank.note.version,
        attachments: [{ document_id: "doc", version_id: "v2" }],
      })
    ).status,
    409,
  );
  assert.deepEqual(counts(), baseline);
  assert.equal(
    (
      await api(`/notes/${created.note.id}`, "PATCH", {
        version: 1,
        body: "过期正文",
      })
    ).status,
    409,
  );
  const deleted = await api(`/notes/${created.note.id}`, "DELETE", {
    version: blank.note.version,
  });
  assert.equal(deleted.status, 200);
  assert.equal(
    (
      await api(`/notes/${created.note.id}/files`, "POST", {
        document_id: "doc",
        version_id: "v2",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await api(`/notes/${created.note.id}`, "PATCH", {
        version: deleted.version,
        attachments: [],
      })
    ).status,
    404,
  );
  assert.equal(
    (await api(`/notes/${created.note.id}/files/doc`, "DELETE", {})).status,
    404,
  );
  const restored = await api(`/notes/${created.note.id}/restore`, "POST", {
    version: deleted.version,
  });
  assert.deepEqual(restored.note.files, attached.note.files);
  assert.deepEqual(
    { ...db.prepare("SELECT actual,date FROM records WHERE id='task'").get() },
    { actual: "", date: "" },
  );
});
