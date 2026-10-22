import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createChangeLedger } from "../change-ledger.mjs";
import { installLibraryCommon } from "../library-common.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,login TEXT,name TEXT);
    INSERT INTO users VALUES('a','alice','成员甲'),('b','bob','成员乙');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','软件项目'),('p2','设备项目');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,owner TEXT,actual TEXT,date TEXT,due_date TEXT,deleted INTEGER);
    INSERT INTO records VALUES('t1','p1','接口联调','成员甲','','','2026-11-01',0),('t2','p2','设备安装','成员乙','','','2026-11-02',0),('gone','p1','旧任务','成员甲','','','',1);
    CREATE TABLE project_milestones(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,status TEXT,deleted INTEGER);
    INSERT INTO project_milestones VALUES('m1','p1','联调完成','planned',0),('m2','p2','设备验收','planned',0),('mgone','p1','旧节点','planned',1);`);
  installLibraryCommon(db);
  const ledger = createChangeLedger({ db });
  const alice = { id: "a", login: "alice", name: "成员甲" },
    bob = { id: "b", login: "bob", name: "成员乙" };
  const api = async (route, method = "GET", body, user = alice) => {
    const url = new URL(route, "http://localhost");
    const result = await ledger.api({
      route: url.pathname,
      method,
      b: body || {},
      params: url.searchParams,
      user,
    });
    assert.ok(result);
    return result.data;
  };
  t.after(() => db.close());
  return {
    db,
    ledger,
    alice,
    bob,
    api,
    create: (body = {}) =>
      api("/api/projects/p1/changes", "POST", {
        title: "报表调整",
        original_scope: "按日汇总",
        requested_scope: "增加按月汇总",
        requester: "客户代表",
        ...body,
      }),
  };
}

test("change ledger is internal, shared by members, and does not mutate completion or schedules", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.api("/api/projects/p1/changes", "GET", {}, null), {
    status: 401,
  });
  const before = f.db.prepare("SELECT * FROM records WHERE id='t1'").get();
  const { change } = await f.create({
    task_ids: ["t1"],
    milestone_id: "m1",
    impact_days: 3,
    confirmation_status: "pending",
    progress_status: "implemented",
  });
  assert.equal(change.confirmation_status, "pending");
  assert.equal(change.progress_status, "implemented");
  assert.deepEqual(
    f.db.prepare("SELECT * FROM records WHERE id='t1'").get(),
    before,
  );
  assert.equal(
    f.db.prepare("SELECT status FROM project_milestones WHERE id='m1'").get()
      .status,
    "planned",
  );
  const updated = (
    await f.api(
      "/api/changes/" + change.id,
      "PATCH",
      {
        version: change.version,
        owner: "成员乙",
        confirmation_status: "confirmed",
        confirmed_by: "客户代表",
        confirmed_on: "2026-10-22",
      },
      f.bob,
    )
  ).change;
  assert.equal(updated.owner, "成员乙");
  assert.deepEqual(f.ledger.summary("p1"), {
    total: 1,
    pending: 0,
    confirmed: 1,
    rejected: 0,
    cancelled: 0,
    in_progress: 0,
    implemented: 1,
  });
  assert.equal(f.ledger.summary("p2").total, 0);
  const reopened = (
    await f.api(
      "/api/changes/" + change.id,
      "PATCH",
      { version: updated.version, confirmation_status: "pending" },
      f.alice,
    )
  ).change;
  assert.equal(reopened.confirmed_by, "");
  assert.equal(reopened.confirmed_on, "");
  assert.equal(
    (await f.api("/api/changes/" + change.id)).history.entries[0].before
      .confirmed_by,
    "客户代表",
  );
  await assert.rejects(
    f.api("/api/changes/" + change.id + "/history", "GET", {}, null),
    { status: 401 },
  );
});

test("change ledger validates dates, finite effort, enums, text and link project scope", async (t) => {
  const f = fixture(t);
  for (const body of [
    { title: " " },
    { requested_scope: " " },
    { original_scope: "甲".repeat(4001) },
    { requested_on: "2026-02-30" },
    { requested_on: "not-a-date" },
    { confirmation_status: "confirmed", confirmed_on: "2025-02-29" },
    { confirmation_status: "anything" },
    { progress_status: "done" },
    { impact_days: "3" },
    { impact_days: Number.NaN },
    { impact_days: 3651 },
    { task_ids: ["t2"] },
    { task_ids: ["gone"] },
    { task_ids: {} },
    { milestone_id: "m2" },
    { milestone_id: "mgone" },
    { milestone_id: {} },
    { milestone_id: 0 },
    { milestone_id: false },
  ])
    await assert.rejects(f.create(body), { status: 400 });
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM project_changes").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM project_change_history").get().n,
    0,
  );
  const { change } = await f.create({
    requested_on: "2024-02-29",
    impact_days: -0.5,
    task_ids: ["t1", "t1"],
  });
  assert.deepEqual(change.task_ids, ["t1"]);
  assert.equal(change.impact_days, -0.5);
});

test("full change history survives edits, soft deletion and restoration without truncating text", async (t) => {
  const f = fixture(t),
    original = "原始约定".repeat(800),
    requested = "调整事项".repeat(800);
  const first = (
    await f.create({ original_scope: original, requested_scope: requested })
  ).change;
  const second = (
    await f.api(
      "/api/changes/" + first.id,
      "PATCH",
      {
        version: first.version,
        requested_scope: "新内容",
        confirmation_status: "confirmed",
        confirmed_by: "客户代表",
      },
      f.bob,
    )
  ).change;
  let history = (await f.api("/api/changes/" + first.id)).history.entries;
  assert.equal(history.length, 2);
  assert.equal(history[0].before.requested_scope, requested);
  assert.equal(history[0].after.original_scope, original);
  assert.equal(history[0].actor_name, "成员乙");
  await assert.rejects(
    f.api("/api/changes/" + first.id, "PATCH", { version: 1, title: "旧草稿" }),
    { status: 409 },
  );
  const deleted = (
    await f.api("/api/changes/" + first.id, "DELETE", {
      version: second.version,
    })
  ).change;
  assert.equal(f.ledger.summary("p1").total, 0);
  assert.equal(
    (await f.api("/api/projects/p1/changes?deleted=1")).changes[0].id,
    first.id,
  );
  const restored = (
    await f.api(
      "/api/changes/" + first.id + "/restore",
      "POST",
      { version: deleted.version },
      f.bob,
    )
  ).change;
  assert.equal(restored.deleted, false);
  history = (await f.api("/api/changes/" + first.id)).history.entries;
  assert.equal(history.length, 4);
  assert.equal(history.at(-1).after.requested_scope, requested);
  assert.throws(
    () => f.db.exec("UPDATE project_change_history SET action='changed'"),
    /immutable/,
  );
  assert.throws(
    () => f.db.exec("DELETE FROM project_change_history"),
    /immutable/,
  );
  assert.throws(
    () =>
      f.db.exec(
        "INSERT OR REPLACE INTO project_change_history SELECT * FROM project_change_history LIMIT 1",
      ),
    /immutable/,
  );
});

test("old removed associations remain editable and are clearly marked; new invalid links are rejected", async (t) => {
  const f = fixture(t);
  const original = (await f.create({ task_ids: ["t1"], milestone_id: "m1" }))
    .change;
  f.db.exec(
    "UPDATE records SET deleted=1 WHERE id='t1'; UPDATE project_milestones SET deleted=1 WHERE id='m1'",
  );
  const changed = (
    await f.api("/api/changes/" + original.id, "PATCH", {
      version: original.version,
      title: "仍可维护的变更",
    })
  ).change;
  assert.equal(changed.tasks[0].deleted, true);
  assert.equal(changed.milestone.deleted, true);
  await assert.rejects(f.create({ task_ids: ["t1"] }), { status: 400 });
  await assert.rejects(f.create({ milestone_id: "m1" }), { status: 400 });
  const cleared = (
    await f.api("/api/changes/" + original.id, "PATCH", {
      version: changed.version,
      task_ids: [],
      milestone_id: null,
    })
  ).change;
  assert.deepEqual(cleared.task_ids, []);
  assert.equal(cleared.milestone, null);
});

test("failed audit rolls back change and history, and history pagination retains every revision", async (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TRIGGER fail_change_audit BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  await assert.rejects(f.create(), /synthetic audit failure/);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM project_changes").get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM project_change_history").get().n,
    0,
  );
  f.db.exec("DROP TRIGGER fail_change_audit");
  let row = (await f.create()).change;
  for (let i = 0; i < 54; i++)
    row = (
      await f.api("/api/changes/" + row.id, "PATCH", {
        version: row.version,
        schedule_impact: "补充 " + i,
      })
    ).change;
  const page = await f.api("/api/changes/" + row.id + "/history");
  assert.equal(page.entries.length, 50);
  assert.ok(page.next_before);
  const older = await f.api(
    "/api/changes/" + row.id + "/history?before=" + page.next_before,
  );
  assert.equal(older.entries.length, 5);
  assert.equal(
    new Set([...page.entries, ...older.entries].map((r) => r.id)).size,
    55,
  );
  await assert.rejects(
    f.api("/api/changes/" + row.id + "/history?before=bad"),
    { status: 400 },
  );
});
