import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNotes, installNotesSchema } from "../notes.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { createProjectArchive } from "../project-archive.mjs";
import { installMilestoneSchema } from "../milestones.mjs";
import { installChangeLedgerSchema } from "../change-ledger.mjs";
import { installLibraryCommon, resourceEvent } from "../library-common.mjs";
import {
  NOTE_KINDS,
  FILE_DIRECTIONS,
  fileDirection,
  fileDirectionLabel,
} from "../src/notes.js";

const exchangeKeys = [
  "file_direction",
  "counterparty",
  "exchange_time",
  "channel",
];
const exchange = (note) =>
  Object.fromEntries(exchangeKeys.map((key) => [key, note[key]]));
const empty = {
  file_direction: "",
  counterparty: "",
  exchange_time: "",
  channel: "",
};

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','记录人甲','alice'),('bob','记录人乙','bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','项目甲'),('p2','项目乙');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,deleted INTEGER,actual TEXT,date TEXT);
    INSERT INTO records VALUES('task1','p1','验收交付',0,'','');`);
  installLibraryCommon(db);
  installDocumentSchema(db);
  const notes = createNotes({ db });
  const actor = (id = "alice") =>
    db.prepare("SELECT * FROM users WHERE id=?").get(id);
  async function api(route, method = "GET", b = {}, userId = "alice") {
    const url = new URL(route, "http://fixture.test");
    try {
      const result = await notes.api({
        route: url.pathname,
        params: url.searchParams,
        method,
        b,
        user: userId ? actor(userId) : null,
      });
      return { status: result?.status || 200, ...result?.data };
    } catch (error) {
      return { status: error.status || 500, error: error.message };
    }
  }
  async function create(fields = {}, userId = "alice", projectId = "p1") {
    const result = await api(
      `/projects/${projectId}/notes`,
      "POST",
      { kind: "file", body: "收发事项", ...fields },
      userId,
    );
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.note;
  }
  const events = () =>
    db
      .prepare("SELECT * FROM resource_events ORDER BY id")
      .all()
      .map(({ details_json, ...row }) => ({
        ...row,
        details: JSON.parse(details_json),
      }));
  function document() {
    db.prepare(
      "INSERT INTO documents(id,project_id,title,current_version_id,creator,created,updated) VALUES('doc1','p1','合成附件','v1','alice','2026-10-20T08:00:00Z','2026-10-20T08:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO document_blobs VALUES('fixture-hash',10,'2026-10-20T08:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO document_versions(id,document_id,number,filename,size,sha256,blob_hash,created_by,creator_id,created) VALUES('v1','doc1',1,'合成附件-v1.txt',10,'fixture-hash','fixture-hash','记录人甲','alice','2026-10-20T08:00:00Z')",
    ).run();
  }
  return { db, api, create, events, actor, document };
}

test("file kind keeps its stable ID and exposes received/sent labels without guessing an unknown direction", () => {
  assert.equal(NOTE_KINDS.find((kind) => kind.id === "file").label, "文件收发");
  assert.deepEqual(
    FILE_DIRECTIONS.map((direction) => direction.id),
    ["received", "sent"],
  );
  assert.equal(fileDirection("received").label, "收到");
  assert.equal(fileDirectionLabel("sent"), "发出");
  for (const unknown of ["", undefined, null, "unknown"])
    assert.equal(fileDirectionLabel(unknown), "未区分收发");
  assert.equal(fileDirection(""), null);
});

test("file exchanges are optional facts with their own explicit Beijing date/time and no required attachment or task", async (t) => {
  const { api, create } = fixture(t);
  const received = await create({
    file_direction: "received",
    counterparty: "  客户张工  ",
    occurred_on: "2026-10-20",
    exchange_time: "09:35",
    channel: "  邮件  ",
  });
  assert.deepEqual(exchange(received), {
    file_direction: "received",
    counterparty: "客户张工",
    exchange_time: "09:35",
    channel: "邮件",
  });
  assert.equal(received.occurred_on, "2026-10-20");
  assert.equal(received.task_id, null);
  assert.deepEqual(received.files, []);
  assert.ok(Number.isFinite(Date.parse(received.created)));
  assert.deepEqual(
    exchange((await api(`/notes/${received.id}`)).note),
    exchange(received),
  );
  const undated = await create({
    file_direction: "sent",
    counterparty: "实施方",
    channel: "群聊",
  });
  assert.equal(undated.occurred_on, "");
  assert.equal(undated.exchange_time, "");
  const unknown = await create({
    counterparty: "合作方",
    occurred_on: "2026-10-19",
    exchange_time: "23:59",
    channel: "线下",
  });
  assert.equal(unknown.file_direction, "");
  assert.equal(unknown.exchange_time, "23:59");
  assert.deepEqual(exchange(await create()), empty);
  assert.equal(
    (await create({ occurred_on: "2024-02-29", exchange_time: "00:00" }))
      .exchange_time,
    "00:00",
  );
});

test("schema upgrade preserves old file records, fixed links and thread identity while leaving the new facts unclassified", async (t) => {
  const { db, api, create, events, document } = fixture(t);
  const old = await create({
    body: "旧正文写着发给客户，也不能推断方向",
    people: "客户张工",
    occurred_on: "2026-10-19",
  });
  const child = await create({ body: "旧事项补充", parent_note_id: old.id });
  document();
  assert.equal(
    (await api(`/notes/${old.id}/files`, "POST", { document_id: "doc1" }))
      .status,
    201,
  );
  const before = (await api(`/notes/${old.id}`)).note;
  const priorEvents = events();
  for (const column of exchangeKeys)
    db.exec("ALTER TABLE project_notes DROP COLUMN " + column);
  installNotesSchema(db);
  installNotesSchema(db);
  const migrated = (await api(`/notes/${old.id}`)).note;
  assert.deepEqual(exchange(migrated), empty);
  for (const key of [
    "body",
    "people",
    "occurred_on",
    "author_id",
    "created",
    "updated",
    "version",
    "parent_note_id",
  ])
    assert.equal(migrated[key], before[key], key);
  assert.deepEqual(migrated.files, before.files);
  assert.deepEqual(
    events(),
    priorEvents,
    "migration must not fabricate business or edit events",
  );
  assert.equal((await api(`/notes/${child.id}`)).note.parent_note_id, old.id);
  assert.equal(
    (await api("/projects/p1/notes?file_direction=unclassified")).notes.length,
    2,
  );
  const columns = db.prepare("PRAGMA table_info(project_notes)").all();
  for (const key of exchangeKeys) {
    assert.equal(columns.filter((column) => column.name === key).length, 1);
    assert.equal(columns.find((column) => column.name === key).notnull, 1);
  }
});

test("direction, counterpart, channel and calendar/time validation reject invalid writes atomically", async (t) => {
  const { db, api, create, events } = fixture(t);
  const malformed = [
    ...["receive", "RECEIVED", " received", null, 1, {}, []].map(
      (file_direction) => ({ file_direction }),
    ),
    ...[
      "24:00",
      "23:60",
      "01:60",
      "1:00",
      "00:0",
      "09:00:00",
      " 09:00",
      "09:00Z",
      null,
      930,
      {},
    ].map((exchange_time) => ({ occurred_on: "2026-10-20", exchange_time })),
    { exchange_time: "09:00" },
    { occurred_on: "0000-01-01", exchange_time: "09:00" },
    { occurred_on: "2026-02-29", exchange_time: "09:00" },
    { counterparty: "客".repeat(201) },
    { channel: "渠".repeat(101) },
    ...[null, 1, {}, []].flatMap((value) => [
      { counterparty: value },
      { channel: value },
    ]),
    { counterparty: "客户\u0000" },
    { channel: "邮件\u0000" },
  ];
  for (const fields of malformed)
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          kind: "file",
          body: "不得写入",
          ...fields,
        })
      ).status,
      400,
      JSON.stringify(fields),
    );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_notes").get().n, 0);
  assert.deepEqual(events(), []);
  const edge = await create({
    counterparty: "客".repeat(200),
    channel: "渠".repeat(100),
  });
  assert.equal(edge.counterparty.length, 200);
  assert.equal(edge.channel.length, 100);
  for (const [key, value] of Object.entries({
    file_direction: "sent",
    counterparty: "客户",
    channel: "邮件",
    exchange_time: "10:00",
  })) {
    const result = await api("/projects/p1/notes", "POST", {
      kind: "site",
      body: "非文件记录",
      occurred_on: "2026-10-20",
      [key]: value,
    });
    assert.equal(result.status, 400, key);
  }
  for (const counterparty of [null, 0, false])
    assert.equal(
      (
        await api("/projects/p1/notes", "POST", {
          kind: "other",
          body: "非文件记录",
          counterparty,
        })
      ).status,
      400,
    );
  assert.deepEqual(exchange(await create({ kind: "site", ...empty })), empty);
});

test("old PATCH payloads preserve exchange facts; edits use note CAS and keep complete before/after audit", async (t) => {
  const { api, create, events } = fixture(t);
  const body = "正".repeat(3997) + "文末尾";
  const initial = await create({
    body,
    file_direction: "received",
    counterparty: "客户A",
    occurred_on: "2026-10-20",
    exchange_time: "10:30",
    channel: "邮件",
  });
  const oldClient = await api(
    `/notes/${initial.id}`,
    "PATCH",
    { version: initial.version, body: "旧客户端仅纠正正文" },
    "bob",
  );
  assert.equal(oldClient.status, 200);
  assert.deepEqual(exchange(oldClient.note), exchange(initial));
  const changed = await api(
    `/notes/${initial.id}`,
    "PATCH",
    {
      version: oldClient.note.version,
      file_direction: "sent",
      counterparty: "合作方B",
      occurred_on: "2026-10-21",
      exchange_time: "11:25",
      channel: "群聊",
    },
    "alice",
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.note.created, initial.created);
  assert.equal(changed.note.author_id, initial.author_id);
  const stale = await api(
    `/notes/${initial.id}`,
    "PATCH",
    { version: oldClient.note.version, counterparty: "过期覆盖" },
    "bob",
  );
  assert.equal(stale.status, 409);
  assert.equal(
    (await api(`/notes/${initial.id}`)).note.counterparty,
    "合作方B",
  );
  assert.equal(events().filter((e) => e.action === "update-note").length, 2);
  const updates = events().filter((e) => e.action === "update-note");
  assert.equal(updates[0].details.before.body, body);
  assert.equal(updates[0].details.from, body);
  assert.equal(updates[0].actor_id, "bob");
  assert.deepEqual(exchange(updates[1].details.before), exchange(initial));
  assert.deepEqual(exchange(updates[1].details.after), exchange(changed.note));
  assert.equal(updates[1].details.before.occurred_on, "2026-10-20");
  assert.equal(updates[1].details.after.occurred_on, "2026-10-21");
  assert.equal(
    (
      await api(`/notes/${initial.id}`, "PATCH", {
        version: changed.note.version,
        occurred_on: "",
      })
    ).status,
    400,
  );
  assert.equal(
    (await api(`/notes/${initial.id}`)).note.occurred_on,
    "2026-10-21",
  );
  const cleared = await api(`/notes/${initial.id}`, "PATCH", {
    version: changed.note.version,
    occurred_on: "",
    exchange_time: "",
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.note.counterparty, "合作方B");
  assert.equal(cleared.note.occurred_on, "");
  assert.equal(cleared.note.exchange_time, "");
});

test("switching away from file clears only exchange facts and cannot revive them by switching back", async (t) => {
  const { api, create, events, document } = fixture(t);
  const root = await create({
    file_direction: "received",
    counterparty: "客户",
    occurred_on: "2026-10-20",
    exchange_time: "08:00",
    channel: "邮件",
    task_id: "task1",
  });
  document();
  const attached = await api(`/notes/${root.id}/files`, "POST", {
    document_id: "doc1",
  });
  const invalid = await api(`/notes/${root.id}`, "PATCH", {
    version: root.version,
    kind: "other",
    counterparty: "客户",
  });
  assert.equal(invalid.status, 400);
  assert.equal(events().filter((e) => e.action === "update-note").length, 0);
  const changed = await api(`/notes/${root.id}`, "PATCH", {
    version: root.version,
    kind: "other",
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(exchange(changed.note), empty);
  assert.equal(changed.note.task_id, root.task_id);
  assert.equal(changed.note.occurred_on, root.occurred_on);
  assert.deepEqual(changed.note.files, attached.note.files);
  const history = events().find((e) => e.action === "update-note");
  assert.deepEqual(exchange(history.details.before), exchange(root));
  assert.deepEqual(exchange(history.details.after), empty);
  assert.equal(history.details.before.kind, "file");
  assert.equal(history.details.after.kind, "other");
  const restoredKind = await api(`/notes/${root.id}`, "PATCH", {
    version: changed.note.version,
    kind: "file",
  });
  assert.equal(restoredKind.status, 200);
  assert.deepEqual(exchange(restoredKind.note), empty);
  assert.equal((await api("/records/task1/materials")).notes[0].id, root.id);
});

test("direction filters include only file records and respect project, trash and login boundaries", async (t) => {
  const { api, create } = fixture(t);
  const received = await create({ file_direction: "received" });
  const sent = await create({ file_direction: "sent" });
  const unclassified = await create();
  await create({ kind: "other" });
  await create({ kind: "site" });
  await create({ file_direction: "received" }, "alice", "p2");
  assert.deepEqual(
    (await api("/projects/p1/notes?file_direction=received")).notes.map(
      (n) => n.id,
    ),
    [received.id],
  );
  assert.deepEqual(
    (await api("/projects/p1/notes?file_direction=sent")).notes.map(
      (n) => n.id,
    ),
    [sent.id],
  );
  assert.deepEqual(
    (await api("/projects/p1/notes?file_direction=unclassified")).notes.map(
      (n) => n.id,
    ),
    [unclassified.id],
  );
  for (const query of [
    "file_direction=",
    "file_direction=unknown",
    "file_direction=RECEIVED",
    "file_direction=received&file_direction=sent",
    "file_direction=" + encodeURIComponent("' OR 1=1 --"),
  ])
    assert.equal((await api("/projects/p1/notes?" + query)).status, 400, query);
  const deleted = await api(`/notes/${received.id}`, "DELETE", {
    version: received.version,
  });
  assert.equal(
    (await api("/projects/p1/notes?file_direction=received")).notes.length,
    0,
  );
  assert.deepEqual(
    (
      await api("/projects/p1/notes?file_direction=received&deleted=1")
    ).notes.map((n) => n.id),
    [received.id],
  );
  assert.equal(
    (
      await api(`/notes/${received.id}/restore`, "POST", {
        version: deleted.version,
      })
    ).note.file_direction,
    "received",
  );
  for (const [route, method, body] of [
    ["/projects/p1/notes?file_direction=received", "GET"],
    [
      "/projects/p1/notes",
      "POST",
      { body: "无权限", kind: "file", file_direction: "sent" },
    ],
    [`/notes/${sent.id}`, "GET"],
    [`/notes/${sent.id}/thread`, "GET"],
    [
      `/notes/${sent.id}`,
      "PATCH",
      { version: sent.version, file_direction: "received" },
    ],
    ["/records/task1/materials", "GET"],
  ])
    assert.equal((await api(route, method, body, "")).status, 401, route);
});

test("supplements keep independent exchange facts and root deletion/restoration does not change them or complete a task", async (t) => {
  const { db, api, create, events } = fixture(t);
  const root = await create({
    file_direction: "received",
    counterparty: "客户A",
    channel: "邮件",
    occurred_on: "2026-10-20",
    exchange_time: "08:00",
    task_id: "task1",
  });
  const child = await create(
    { parent_note_id: root.id, body: "补充尚未区分收发" },
    "bob",
  );
  assert.deepEqual(exchange(child), empty);
  assert.equal(child.occurred_on, "");
  assert.equal(child.task_id, null);
  assert.equal(child.author_id, "bob");
  const next = await create({
    parent_note_id: child.id,
    file_direction: "sent",
    counterparty: "合作方B",
    channel: "群聊",
    occurred_on: "2026-10-21",
    exchange_time: "15:00",
  });
  assert.equal(next.parent_note_id, root.id);
  const deleted = await api(`/notes/${root.id}`, "DELETE", {
    version: root.version,
  });
  const continued = await create({ parent_note_id: next.id });
  assert.deepEqual(exchange(continued), empty);
  const thread = await api(`/notes/${next.id}/thread`);
  assert.equal(thread.root.deleted, true);
  assert.equal(
    thread.notes.find((n) => n.id === root.id).file_direction,
    "received",
  );
  assert.equal(
    thread.notes.find((n) => n.id === next.id).file_direction,
    "sent",
  );
  assert.equal(thread.notes.length, 4);
  const restored = await api(`/notes/${root.id}/restore`, "POST", {
    version: deleted.version,
  });
  assert.deepEqual(exchange(restored.note), exchange(root));
  const deletion = events().find((e) => e.action === "delete-note");
  assert.deepEqual(exchange(deletion.details.before), exchange(root));
  assert.deepEqual(exchange(deletion.details.after), exchange(root));
  assert.deepEqual(
    { ...db.prepare("SELECT actual,date FROM records WHERE id='task1'").get() },
    { actual: "", date: "" },
  );
});

test("exchange snapshot allowlist stays note-only and failed audit writes roll back a type change", async (t) => {
  const { db, api, create, events, actor } = fixture(t);
  const initial = await create({
    file_direction: "sent",
    counterparty: "客户A",
    channel: "邮件",
    occurred_on: "2026-10-20",
    exchange_time: "09:00",
  });
  for (const entityType of ["credential", "configuration", "document"]) {
    resourceEvent(db, actor(), {
      action: "test-exchange-snapshot",
      entityType,
      entityId: "synthetic",
      details: {
        before: { ...exchange(initial), password: "DO-NOT-LOG" },
        after: { ...exchange(initial), secret: "DO-NOT-LOG" },
      },
    });
    assert.deepEqual(events().at(-1).details, {}, entityType);
  }
  resourceEvent(db, actor(), {
    action: "test-exchange-snapshot",
    entityType: "note",
    entityId: initial.id,
    details: {
      before: { ...exchange(initial), secret: "DO-NOT-LOG" },
      after: { ...exchange(initial), password: "DO-NOT-LOG" },
    },
  });
  assert.deepEqual(events().at(-1).details, {
    before: exchange(initial),
    after: exchange(initial),
  });
  db.exec(
    "CREATE TRIGGER deny_note_audit BEFORE INSERT ON resource_events WHEN NEW.entity_type='note' AND NEW.action='update-note' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  const failed = await api(`/notes/${initial.id}`, "PATCH", {
    version: initial.version,
    kind: "other",
    body: "不得保存的改动",
  });
  assert.equal(failed.status, 500);
  const preserved = (await api(`/notes/${initial.id}`)).note;
  assert.equal(preserved.kind, "file");
  assert.equal(preserved.body, initial.body);
  assert.equal(preserved.version, initial.version);
  assert.deepEqual(exchange(preserved), exchange(initial));
  assert.equal(events().filter((e) => e.action === "update-note").length, 0);
});

test("mixed archive sources cannot acquire note exchange facts through colliding IDs, and direction pagination stays scoped on old schemas", async (t) => {
  const { db, create, document } = fixture(t);
  const received = await create({
    file_direction: "received",
    counterparty: "唯一收件方",
    channel: "安全渠道",
    occurred_on: "2026-10-20",
    exchange_time: "09:00",
  });
  await create({
    file_direction: "received",
    counterparty: "第二收件方",
    occurred_on: "2026-10-20",
  });
  await create({ file_direction: "sent" });
  await create();
  await create({ kind: "site" });
  await create({ file_direction: "received" }, "alice", "p2");
  installMilestoneSchema(db);
  installChangeLedgerSchema(db);
  const created = "2026-10-20T08:00:00Z";
  db.prepare(
    "INSERT INTO project_milestones(id,project_id,title,created,updated) VALUES(?,?,?,?,?)",
  ).run(received.id, "p1", "里程碑同ID", created, created);
  db.prepare(
    "INSERT INTO project_changes(id,project_id,title,requested_scope,creator_id,creator_name,created,updated) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    received.id,
    "p1",
    "需求同ID",
    "项目范围",
    "alice",
    "记录人甲",
    created,
    created,
  );
  db.prepare(
    "INSERT INTO document_releases(id,project_id,name,created,created_by,creator_id,manifest_json) VALUES(?,?,?,?,?,?,?)",
  ).run(
    received.id,
    "p1",
    "交付同ID",
    created,
    "记录人甲",
    "alice",
    '{"secret":"DO-NOT-EXPOSE-MANIFEST"}',
  );
  document();
  const archive = createProjectArchive({ db });
  const query = async (text) =>
    (
      await archive.api({
        route: "/project-archive",
        method: "GET",
        user: { id: "alice" },
        params: new URLSearchParams(text),
      })
    ).data;
  for (const mode of ["search", "timeline"]) {
    const mixed = await query(`mode=${mode}&project_id=p1&limit=50`);
    assert.ok(mixed.items.some((item) => item.source_type === "milestone"));
    assert.ok(mixed.items.some((item) => item.source_type === "change"));
    assert.ok(mixed.items.some((item) => item.source_type === "delivery"));
    assert.ok(!JSON.stringify(mixed).includes("DO-NOT-EXPOSE-MANIFEST"));
    for (const item of mixed.items.filter(
      (item) => item.source_type !== "note",
    )) {
      assert.equal(item.note_kind, "");
      assert.deepEqual(exchange(item), empty);
    }
    const all = await query(
      `mode=${mode}&project_id=p1&file_direction=received&limit=50`,
    );
    assert.equal(all.total, 2);
    const one = await query(
      `mode=${mode}&project_id=p1&file_direction=received&limit=1&page=1`,
    );
    const two = await query(
      `mode=${mode}&project_id=p1&file_direction=received&limit=1&page=2`,
    );
    const beyond = await query(
      `mode=${mode}&project_id=p1&file_direction=received&limit=1&page=3`,
    );
    assert.equal(one.total, 2);
    assert.equal(two.total, 2);
    assert.equal(beyond.total, 2);
    assert.equal(beyond.items.length, 0);
    assert.deepEqual(
      [...one.items, ...two.items].map((item) => item.id),
      all.items.map((item) => item.id),
    );
    assert.ok(
      all.items.every(
        (item) =>
          item.project_id === "p1" &&
          item.source_type === "note" &&
          item.note_kind === "file",
      ),
    );
  }
  // A legacy source can coexist with every other module, without modifying it.
  for (const key of exchangeKeys)
    db.exec("ALTER TABLE project_notes DROP COLUMN " + key);
  for (const mode of ["search", "timeline"]) {
    const legacy = await query(
      `mode=${mode}&project_id=p1&file_direction=unclassified&limit=50`,
    );
    assert.equal(legacy.total, 4);
    assert.ok(
      legacy.items.every(
        (item) => item.source_type === "note" && item.note_kind === "file",
      ),
    );
    assert.ok(
      legacy.items.every(
        (item) => JSON.stringify(exchange(item)) === JSON.stringify(empty),
      ),
    );
    assert.equal(
      (await query(`mode=${mode}&file_direction=received`)).total,
      0,
    );
    assert.ok(
      (await query(`mode=${mode}&limit=50`)).items.some(
        (item) => item.source_type === "delivery",
      ),
    );
  }
});
