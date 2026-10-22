import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProjectOverview } from "../project-overview.mjs";
import { beijingDate } from "../src/model.js";
const user = { id: "tester", login: "tester", name: "测试成员" };
const failure = (status) => (e) => e.status === status;
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,color TEXT,archived INTEGER,created TEXT);INSERT INTO projects VALUES('p1','软件项目','indigo',0,'2026-01-01'),('p2','设备项目','rose',1,'2026-01-02');CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,owner TEXT,actual TEXT,date TEXT,created TEXT,parent_id TEXT,deleted INTEGER DEFAULT 0,due_date TEXT DEFAULT '',blocked INTEGER DEFAULT 0);CREATE TABLE task_dependencies(record_id TEXT,depends_on_id TEXT);",
  );
  let privateCalls = 0;
  const service = createProjectOverview({
    db,
    getMilestoneSummary: () => ({
      total: 3,
      achieved: 1,
      overdue: 1,
      next: {
        id: "m1",
        title: "现场验收",
        owner: "项目负责人",
        planned_date: "2026-11-01",
        status: "planned",
        secret: "must-not-leak",
      },
      private_document_name: "must-not-leak",
    }),
    getChangeSummary: () => {
      privateCalls++;
      return {
        total: 4,
        pending: 2,
        in_progress: 1,
        private_title: "must-not-leak",
      };
    },
    checklistSummary: () => {
      privateCalls++;
      return { p1: { missing: 9, evidence_missing: 3 } };
    },
  });
  const api = (route, method = "GET", b = {}, actor = user) =>
    service.api({ route, method, b, user: actor });
  t.after(() => db.close());
  return { db, api, privateCalls: () => privateCalls };
}
test("project overview follows existing OR completion and leaf/blocking rules while hiding private summaries from guests", async (t) => {
  const f = fixture(t),
    today = beijingDate(),
    old = "2000-01-01";
  const insert = f.db.prepare(
    "INSERT INTO records(id,project_id,task,owner,actual,date,created,parent_id,due_date,blocked) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "parent",
    "p1",
    "父任务",
    "甲",
    "甲",
    "",
    "2026-01-01",
    null,
    old,
    1,
  );
  insert.run(
    "child",
    "p1",
    "待完成子项",
    "乙",
    "",
    "",
    "2026-01-01",
    "parent",
    old,
    0,
  );
  insert.run(
    "date",
    "p1",
    "只填日期",
    "乙",
    "",
    today,
    "2026-01-01",
    null,
    old,
    1,
  );
  insert.run(
    "actual",
    "p1",
    "只填完成人",
    "乙",
    "乙",
    "",
    "2026-01-01",
    null,
    old,
    1,
  );
  insert.run(
    "dependency",
    "p1",
    "等待任务",
    "乙",
    "",
    "",
    "2026-01-01",
    null,
    "",
    0,
  );
  insert.run(
    "other",
    "p2",
    "跨项目前置",
    "丙",
    "",
    "",
    "2026-01-01",
    null,
    "",
    0,
  );
  f.db
    .prepare("INSERT INTO task_dependencies VALUES(?,?)")
    .run("dependency", "other");
  const before = f.db.prepare("SELECT * FROM records ORDER BY id").all();
  const guest = (await f.api("/api/project-overview", "GET", {}, null)).data;
  const p = guest.projects.find((p) => p.id === "p1");
  assert.deepEqual(
    { ...p.task_summary, important: undefined },
    {
      total: 4,
      completed: 2,
      pending: 2,
      overdue: 1,
      blocked: 1,
      important: undefined,
    },
  );
  assert.equal(Object.hasOwn(p, "changes"), false);
  assert.equal(Object.hasOwn(p, "handover_missing"), false);
  assert.equal(f.privateCalls(), 0);
  assert.ok(!JSON.stringify(guest).includes("must-not-leak"));
  assert.equal(p.milestones.next.title, "现场验收");
  const member = (await f.api("/project-overview")).data.projects.find(
    (p) => p.id === "p1",
  );
  assert.equal(member.handover_missing, 3);
  assert.equal(member.changes.pending, 2);
  assert.ok(!JSON.stringify(member).includes("must-not-leak"));
  assert.ok(f.privateCalls() > 0);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM records ORDER BY id").all(),
    before,
  );
});
test("public project management metadata uses version conflicts, valid optional dates and immutable member audit", async (t) => {
  const f = fixture(t);
  const empty = (await f.api("/projects/p1/management", "GET", {}, null)).data
    .management;
  assert.equal(empty.version, 0);
  await assert.rejects(
    f.api(
      "/projects/p1/management",
      "PATCH",
      { version: 0, owner: "负责人" },
      null,
    ),
    failure(401),
  );
  for (const b of [
    { version: "0" },
    { version: 0, target_date: "2026-02-30" },
    { version: 0, target_date: "0000-01-01" },
    { version: 0, stage: "x".repeat(41) },
    { version: 0, owner: [] },
    { version: 0, target_date: null },
  ])
    await assert.rejects(f.api("/projects/p1/management", "PATCH", b), (e) =>
      [400, 409].includes(e.status),
    );
  const saved = (
    await f.api("/projects/p1/management", "PATCH", {
      version: 0,
      owner: "  负责人  ",
      stage: "联调",
      target_date: "2028-02-29",
    })
  ).data.management;
  assert.equal(saved.owner, "负责人");
  assert.equal(saved.version, 1);
  assert.equal(saved.target_date, "2028-02-29");
  await assert.rejects(
    f.api("/projects/p1/management", "PATCH", { version: 0, stage: "覆盖" }),
    failure(409),
  );
  const cleared = (
    await f.api("/projects/p1/management", "PATCH", {
      version: 1,
      target_date: "",
    })
  ).data.management;
  assert.equal(cleared.owner, "负责人");
  assert.equal(cleared.target_date, "");
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM resource_events").get().n,
    2,
  );
  assert.throws(() => f.db.exec("DELETE FROM resource_events"), /immutable/);
  f.db.exec(
    "CREATE TRIGGER reject_management_audit BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'audit rejected');END;",
  );
  await assert.rejects(
    f.api("/projects/p1/management", "PATCH", {
      version: 2,
      owner: "not-saved",
    }),
  );
  assert.equal(
    (await f.api("/projects/p1/management")).data.management.owner,
    "负责人",
  );
  await assert.rejects(f.api("/projects/missing/management"), failure(404));
  await assert.rejects(f.api("/project-overview", "POST"), failure(405));
});
