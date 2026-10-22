import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { filterRecords, recordsCsv } from "../src/model.js";
import { logChanges } from "../src/logs.js";
const origin = "https://worklog.example.com";
async function start(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-batch-"));
  const app = await createApp({ allowUninvitedRegistration: true, dataDir, origin });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
  async function api(route, method = "GET", body, cookie = "") {
    const r = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Worklog-Request": "1",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const { cookie } = await api("/register", "POST", {
    name: "胡示例三",
    login: "batch_alice",
    password: "Temporary-test-123",
  });
  const project = (await api("/state")).data.projects[0];
  const create = async (task, extra = {}) =>
    (
      await api(
        "/records",
        "POST",
        { project_id: project.id, task, owner: "胡示例三", ...extra },
        cookie,
      )
    ).data.id;
  const state = async () =>
    (await api("/state", "GET", undefined, cookie)).data;
  const find = async (id) => (await state()).records.find((r) => r.id === id);
  const logs = async () =>
    (await api("/logs?limit=50", "GET", undefined, cookie)).data.entries;
  return { app, api, cookie, project, create, state, find, logs };
}
test("task descriptions are stored, validated, searched and logged", async (t) => {
  const { api, cookie, create, find, logs } = await start(t);
  const id = await create("接口联调", {
    description: "  对接计费系统\n验收：全部用例通过  ",
  });
  let r = await find(id);
  assert.equal(r.description, "对接计费系统\n验收：全部用例通过");
  assert.equal(filterRecords([r], { keyword: "计费" }).length, 1);
  // Omitting the field keeps the current description.
  assert.equal(
    (
      await api(
        "/records/" + id,
        "PATCH",
        { task: r.task, owner: r.owner, version: r.version },
        cookie,
      )
    ).status,
    200,
  );
  r = await find(id);
  assert.equal(r.description, "对接计费系统\n验收：全部用例通过");
  assert.equal(
    (
      await api(
        "/records/" + id,
        "PATCH",
        { ...r, description: "长".repeat(2001) },
        cookie,
      )
    ).status,
    400,
  );
  await api(
    "/records/" + id,
    "PATCH",
    { ...r, description: "改为对接网关" },
    cookie,
  );
  const entry = (await logs()).find(
    (e) =>
      e.action === "update-record" && e.after?.description === "改为对接网关",
  );
  assert.ok(entry, "description change is in the public log");
  assert.deepEqual(
    logChanges(entry).map((c) => c.key),
    ["description"],
  );
});
test("batch update applies only chosen fields atomically", async (t) => {
  const { api, cookie, create, find, logs } = await start(t);
  const a = await create("甲", {
      priority: "low",
      due_date: "2026-11-01",
      description: "保留",
    }),
    b = await create("乙", { actual: "韩示例二" });
  const [ra, rb] = [await find(a), await find(b)];
  const items = [
    { id: a, version: ra.version },
    { id: b, version: rb.version },
  ];
  let res = await api(
    "/records/batch",
    "POST",
    {
      action: "update",
      items,
      changes: { date: "2026-10-20", priority: "high" },
    },
    cookie,
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);
  const [na, nb] = [await find(a), await find(b)];
  assert.equal(na.date, "2026-10-20");
  assert.equal(na.priority, "high");
  assert.equal(na.due_date, "2026-11-01");
  assert.equal(na.description, "保留");
  assert.equal(na.actual, "");
  assert.ok(na.completed_at, "batch completion records the completion time");
  assert.equal(nb.actual, "韩示例二");
  assert.equal(
    (await logs()).filter((e) => e.action === "update-record").length,
    2,
  );
  // Stale versions reject the whole batch, leaving every record untouched.
  res = await api(
    "/records/batch",
    "POST",
    {
      action: "update",
      items: [
        { id: a, version: na.version },
        { id: b, version: rb.version },
      ],
      changes: { priority: "urgent" },
    },
    cookie,
  );
  assert.equal(res.status, 409);
  assert.equal((await find(a)).priority, "high");
  for (const [body, status] of [
    [{ action: "update", items, changes: { task: "x" } }, 400],
    [{ action: "update", items, changes: {} }, 400],
    [{ action: "archive", items }, 400],
    [{ action: "update", items: [], changes: { priority: "low" } }, 400],
    [
      {
        action: "update",
        items: [items[0], items[0]],
        changes: { priority: "low" },
      },
      400,
    ],
    [
      {
        action: "update",
        items: [{ id: a, version: na.version }],
        changes: { date: "2026-13-40" },
      },
      400,
    ],
  ])
    assert.equal(
      (await api("/records/batch", "POST", body, cookie)).status,
      status,
      JSON.stringify(body),
    );
  assert.equal(
    (
      await api("/records/batch", "POST", {
        action: "update",
        items: [{ id: a, version: na.version }],
        changes: { priority: "low" },
      })
    ).status,
    401,
  );
});
test("batch delete removes subtrees as one group and one restore undoes it", async (t) => {
  const { api, cookie, create, find, state } = await start(t);
  const parent = await create("父任务"),
    child = (
      await api(
        "/records",
        "POST",
        {
          project_id: (await find(parent)).project_id,
          parent_id: parent,
          task: "子任务",
          owner: "胡示例三",
        },
        cookie,
      )
    ).data.id,
    other = await create("另一项"),
    keep = await create("保留项");
  const before = await state();
  const items = [child, parent, other].map((id) => ({
    id,
    version: before.records.find((r) => r.id === id).version,
  }));
  const res = await api(
    "/records/batch",
    "POST",
    { action: "delete", items },
    cookie,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await state()).records.map((r) => r.id),
    [keep],
  );
  // The undo target is a root of the group, so restoring it is never blocked by a deleted parent.
  assert.notEqual(res.data.undo.id, child);
  assert.equal(
    (
      await api(
        "/records/" + res.data.undo.id + "/restore",
        "POST",
        { version: res.data.undo.version },
        cookie,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await state()).records.map((r) => r.id).sort(),
    [parent, child, other, keep].sort(),
  );
});
test("archived projects keep their records but stop due reminders", async (t) => {
  const { app, api, cookie, project, create, state, logs } = await start(t);
  const second = (
    await api("/projects", "POST", { name: "已收尾项目" }, cookie)
  ).data.id;
  const bob = await api("/register", "POST", {
    name: "韩示例二",
    login: "batch_bob",
    password: "Temporary-test-123",
  });
  await api(
    "/records",
    "POST",
    {
      project_id: second,
      task: "逾期但已归档",
      owner: "韩示例二",
      due_date: "2020-01-01",
    },
    cookie,
  );
  await create("逾期且进行中", { owner: "韩示例二", due_date: "2020-01-02" });
  // Read anonymously: signed-in reads generate due reminders before archiving.
  let p = (await api("/state")).data.projects.find((x) => x.id === second);
  assert.equal(p.archived, 0);
  assert.equal(
    (
      await api(
        "/projects/" + second,
        "PATCH",
        { name: p.name, archived: "yes", version: p.version },
        cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        "/projects/" + second,
        "PATCH",
        { name: p.name, archived: true, version: p.version },
        cookie,
      )
    ).status,
    200,
  );
  p = (await state()).projects.find((x) => x.id === second);
  assert.equal(p.archived, 1);
  assert.equal(p.color, "indigo", "archiving keeps other settings");
  assert.equal(
    (await state()).records.length,
    2,
    "archived records stay visible",
  );
  const reminders = (
    await api("/notifications?limit=50", "GET", undefined, bob.cookie)
  ).data.entries.filter((n) => n.kind === "overdue");
  assert.deepEqual(
    reminders.map((n) => n.project_id),
    [project.id],
  );
  const entry = (await logs()).find(
    (e) => e.action === "update-project" && e.after?.archived,
  );
  assert.equal(entry.after.archived, "已归档");
  assert.equal(entry.before.archived, "进行中");
  assert.ok(
    app.db.prepare("SELECT archived FROM projects WHERE id=?").get(second)
      .archived,
  );
});
test("CSV export is Excel-friendly and neutralises formulas", () => {
  const parent = {
    id: "p",
    task: "父",
    owner: "甲",
    actual: "",
    date: "",
    created: "2026-10-01T02:00:00Z",
  };
  const csv = recordsCsv([
    parent,
    {
      id: "c",
      parent_id: "p",
      task: '=HYPERLINK("x")',
      description: "第一行\n第二行, 含逗号",
      owner: "甲、乙",
      actual: "乙",
      date: "2026-10-20",
      priority: "urgent",
      created: "2026-10-01T17:00:00Z",
    },
  ]);
  assert.ok(csv.startsWith("﻿工作事项,上级任务,任务说明,状态"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[1], "父,,,未完成,甲,,,普通,,,,,,2026-10-01");
  assert.equal(
    lines[2],
    '"\'=HYPERLINK(""x"")",父,"第一行\n第二行, 含逗号",已完成,甲、乙,乙,2026-10-20,紧急,,,,,,2026-10-02',
  );
});
