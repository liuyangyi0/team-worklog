import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMilestones } from "../milestones.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT); INSERT INTO users VALUES('a','成员甲','alice'),('b','成员乙','bob'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p1','项目一'),('p2','项目二'); CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task TEXT,owner TEXT,actual TEXT,date TEXT,deleted INTEGER DEFAULT 0,created TEXT); INSERT INTO records VALUES('t1','p1','成员任务','成员甲','','',0,'2026-01-01'),('t2','p2','其他项目任务','成员乙','','',0,'2026-01-01'),('t3','p1','已完成任务','成员甲','成员甲','',0,'2026-01-01'); CREATE TABLE documents(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,deleted INTEGER DEFAULT 0,sensitive INTEGER DEFAULT 0,current_version_id TEXT,published_version_id TEXT); INSERT INTO documents VALUES('d1','p1','PRIVATE-DOCUMENT-TITLE',0,0,'v1',null),('d2','p2','OTHER-PROJECT-DOCUMENT',0,0,'v2',null),('d3','p1','SENSITIVE-TITLE',0,1,'v3',null); CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT,number INTEGER,conflict INTEGER DEFAULT 0); INSERT INTO document_versions VALUES('v1','d1',1,0),('v2','d2',1,0),('v3','d3',1,0),('v4','d1',2,1);",
  );
  const service = createMilestones({ db });
  t.after(() => db.close());
  const user = { id: "a", name: "成员甲", login: "alice" },
    bob = { id: "b", name: "成员乙", login: "bob" };
  async function api(route, method = "GET", b = {}, who = user) {
    try {
      const u = new URL(route, "http://localhost");
      const r = await service.api({
        route: u.pathname,
        method,
        b,
        user: who,
        params: u.searchParams,
      });
      return { status: r?.status || 200, data: r?.data };
    } catch (e) {
      return { status: e.status || 500, data: { error: e.message } };
    }
  }
  return { db, api, service, user, bob };
}
const payload = {
  title: "联调验收节点",
  owner: "成员甲",
  planned_date: "2000-01-01",
  task_ids: ["t1"],
  documents: [{ document_id: "d1", version_id: "v1" }],
};

test("milestones publish safe work metadata, keep internal document references private, and require members to mutate", async (t) => {
  const { api, db, bob, service } = fixture(t);
  let created = await api("/api/projects/p1/milestones", "POST", payload);
  assert.equal(created.status, 201, JSON.stringify(created));
  let item = created.data.milestone;
  assert.equal(item.documents[0].title, "PRIVATE-DOCUMENT-TITLE");
  const publicResult = await api(
    "/api/projects/p1/milestones",
    "GET",
    {},
    null,
  );
  assert.equal(publicResult.data.can_view_internal, false);
  const raw = JSON.stringify(publicResult);
  assert.ok(!raw.includes("PRIVATE-DOCUMENT-TITLE"));
  assert.ok(!raw.includes("documents"));
  assert.ok(!raw.includes(JSON.stringify("d1")));
  assert.ok(!raw.includes(JSON.stringify("v1")));
  assert.equal(publicResult.data.milestones[0].tasks[0].task, "成员任务");
  assert.equal(
    (await api("/api/projects/p1/milestone-options", "GET", {}, null)).status,
    401,
  );
  assert.equal(
    (await api("/api/projects/p1/milestones", "POST", payload, null)).status,
    401,
  );
  assert.equal(
    (
      await api(
        "/api/milestones/" + item.id,
        "PATCH",
        { version: item.version, title: "forbidden" },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await api(
        "/api/milestones/" + item.id,
        "DELETE",
        { version: item.version },
        null,
      )
    ).status,
    401,
  );
  item = (
    await api(
      "/api/milestones/" + item.id,
      "PATCH",
      { version: item.version, title: "同事修改" },
      bob,
    )
  ).data.milestone;
  assert.equal(item.title, "同事修改");
  assert.equal(
    (
      await api("/api/milestones/" + item.id, "PATCH", {
        version: 1,
        title: "stale",
      })
    ).status,
    409,
  );
  assert.ok(
    !JSON.stringify(service.summary("p1")).includes("PRIVATE-DOCUMENT"),
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM resource_events WHERE entity_type='milestone'",
      )
      .get().n,
    2,
  );
});

test("milestones reject invalid calendar dates, foreign or sensitive links, and preserve invalidated old references safely", async (t) => {
  const { api, db } = fixture(t);
  for (const body of [
    { ...payload, title: "   " },
    { ...payload, planned_date: "2026-02-30" },
    { ...payload, planned_date: "0000-01-01" },
    { ...payload, actual_date: "2025-02-29" },
    { ...payload, status: "done" },
    { ...payload, task_ids: ["t2"] },
    { ...payload, documents: [{ document_id: "d2", version_id: "v2" }] },
    { ...payload, documents: [{ document_id: "d3", version_id: "v3" }] },
    { ...payload, documents: [{ document_id: "d1", version_id: "v2" }] },
    { ...payload, documents: [{ document_id: "d1", version_id: "v4" }] },
  ]) {
    const r = await api("/api/projects/p1/milestones", "POST", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM project_milestones").get().n,
    0,
  );
  let item = (await api("/api/projects/p1/milestones", "POST", payload)).data
    .milestone;
  db.exec(
    "UPDATE records SET deleted=1 WHERE id='t1'; UPDATE documents SET deleted=1 WHERE id='d1';",
  );
  item = (
    await api("/api/milestones/" + item.id, "PATCH", {
      version: item.version,
      title: "保留历史",
    })
  ).data.milestone;
  assert.equal(item.tasks[0].deleted, true);
  assert.equal(item.documents[0].unavailable, true);
  assert.equal(
    (await api("/api/projects/p1/milestones", "POST", payload)).status,
    400,
  );
  assert.equal(
    (
      await api("/api/milestones/" + item.id, "PATCH", {
        version: item.version,
        documents: [{ document_id: "d1", version_id: null }],
      })
    ).status,
    400,
  );
  db.exec("UPDATE documents SET sensitive=1 WHERE id='d1'");
  const safe = (await api("/api/milestones/" + item.id)).data.milestone;
  assert.equal(safe.documents[0].title, "关联资料不可用");
  item = (
    await api("/api/milestones/" + item.id, "PATCH", {
      version: item.version,
      documents: [],
      task_ids: [],
    })
  ).data.milestone;
  assert.equal(item.documents.length, 0);
  assert.equal(item.tasks.length, 0);
});

test("manual milestone achievement is independent of task completion fields, dates and summary counts", async (t) => {
  const { api, db, service } = fixture(t);
  let a = (
    await api("/api/projects/p1/milestones", "POST", {
      title: "待达成",
      planned_date: "2000-01-01",
      task_ids: ["t3"],
    })
  ).data.milestone;
  assert.equal(a.status, "planned");
  assert.equal(a.tasks[0].actual, "成员甲");
  const taskBefore = db.prepare("SELECT * FROM records WHERE id='t3'").get();
  a = (
    await api("/api/milestones/" + a.id, "PATCH", {
      version: a.version,
      status: "achieved",
      actual_date: "",
    })
  ).data.milestone;
  assert.equal(a.status, "achieved");
  assert.equal(a.actual_date, "");
  assert.deepEqual(
    db.prepare("SELECT * FROM records WHERE id='t3'").get(),
    taskBefore,
  );
  const b = (
    await api("/api/projects/p1/milestones", "POST", {
      title: "独立日期",
      actual_date: "2026-01-01",
      planned_date: "2000-01-01",
    })
  ).data.milestone;
  assert.equal(b.status, "planned");
  await api("/api/projects/p1/milestones", "POST", {
    title: "已取消",
    status: "cancelled",
    planned_date: "2000-01-01",
  });
  const summary = service.summary("p1");
  assert.equal(summary.total, 2);
  assert.equal(summary.achieved, 1);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.next.id, b.id);
  await api("/api/milestones/" + b.id, "DELETE", { version: b.version });
  assert.equal(service.summary("p1").overdue, 0);
  assert.equal(service.summary("p1").next, null);
});

test("soft deletion and restore use optimistic versions, preserve links and are transactional with immutable audit", async (t) => {
  const { api, db } = fixture(t);
  let item = (await api("/api/projects/p1/milestones", "POST", payload)).data
    .milestone;
  db.exec(
    "CREATE TRIGGER reject_milestone_event BEFORE INSERT ON resource_events WHEN NEW.action='update-milestone' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;",
  );
  assert.equal(
    (
      await api("/api/milestones/" + item.id, "PATCH", {
        version: item.version,
        title: "should rollback",
        task_ids: [],
        documents: [],
      })
    ).status,
    500,
  );
  const unchanged = (await api("/api/milestones/" + item.id)).data.milestone;
  assert.equal(unchanged.title, item.title);
  assert.equal(unchanged.version, item.version);
  assert.equal(unchanged.task_ids.length, 1);
  assert.equal(unchanged.documents.length, 1);
  db.exec("DROP TRIGGER reject_milestone_event;");
  const deleted = await api("/api/milestones/" + item.id, "DELETE", {
    version: item.version,
  });
  assert.equal(deleted.status, 200);
  assert.equal(
    (await api("/api/milestones/" + item.id, "GET", {}, null)).status,
    404,
  );
  assert.equal(
    (await api("/api/projects/p1/milestones?deleted=1", "GET", {}, null))
      .status,
    401,
  );
  assert.equal(
    (
      await api("/api/milestones/" + item.id + "/restore", "POST", {
        version: item.version,
      })
    ).status,
    409,
  );
  item = (
    await api("/api/milestones/" + item.id + "/restore", "POST", {
      version: deleted.data.version,
    })
  ).data.milestone;
  assert.equal(item.deleted, false);
  assert.equal(item.documents[0].version_id, "v1");
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE resource_events SET action='erased' WHERE entity_type='milestone'",
        )
        .run(),
    /immutable/,
  );
});

test("milestone schema can be installed repeatedly without changing stored work or references", async (t) => {
  const { api, db } = fixture(t);
  const first = (await api("/api/projects/p1/milestones", "POST", payload)).data
    .milestone;
  const service = createMilestones({ db });
  assert.equal(service.summary("p1").total, 1);
  assert.equal(
    db
      .prepare("SELECT version FROM project_milestones WHERE id=?")
      .get(first.id).version,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM milestone_documents").get().n,
    1,
  );
});

test("maximum-size task and document association changes are fully retained across immutable audit batches", async (t) => {
  const { api, db } = fixture(t);
  const tasksOld = [],
    tasksNew = [],
    docsOld = [],
    docsNew = [];
  for (let i = 0; i < 100; i++)
    for (const [prefix, ids] of [
      ["old", tasksOld],
      ["new", tasksNew],
    ]) {
      const id = prefix + "-task-" + i;
      ids.push(id);
      db.prepare(
        "INSERT INTO records VALUES(?,'p1','batch task','成员甲','','',0,'2026-01-01')",
      ).run(id);
    }
  for (let i = 0; i < 50; i++)
    for (const [prefix, refs] of [
      ["old", docsOld],
      ["new", docsNew],
    ]) {
      const id = prefix + "-doc-" + i;
      refs.push({ document_id: id, version_id: null });
      db.prepare(
        "INSERT INTO documents VALUES(?,'p1','batch file',0,0,null,null)",
      ).run(id);
    }
  const item = (
    await api("/api/projects/p1/milestones", "POST", {
      title: "批量关联",
      task_ids: tasksOld,
      documents: docsOld,
    })
  ).data.milestone;
  const createFields = db
    .prepare(
      "SELECT details_json FROM resource_events WHERE entity_id=? AND action='create-milestone'",
    )
    .all(item.id)
    .flatMap((r) => JSON.parse(r.details_json).fields);
  assert.equal(createFields.length, 150);
  for (const id of tasksOld) assert.ok(createFields.includes("task:" + id));
  for (const d of docsOld)
    assert.ok(createFields.includes("document:" + d.document_id + ":current"));
  assert.equal(
    (
      await api("/api/milestones/" + item.id, "PATCH", {
        version: item.version,
        task_ids: tasksNew,
        documents: docsNew,
      })
    ).status,
    200,
  );
  const updateFields = db
    .prepare(
      "SELECT details_json FROM resource_events WHERE entity_id=? AND action='update-milestone'",
    )
    .all(item.id)
    .flatMap((r) => JSON.parse(r.details_json).fields);
  assert.equal(updateFields.length, 300);
  for (const id of tasksOld)
    assert.ok(updateFields.includes("remove-task:" + id));
  for (const id of tasksNew) assert.ok(updateFields.includes("add-task:" + id));
  for (const d of docsOld)
    assert.ok(
      updateFields.includes("remove-document:" + d.document_id + ":current"),
    );
  for (const d of docsNew)
    assert.ok(updateFields.includes("document:" + d.document_id + ":current"));
});
