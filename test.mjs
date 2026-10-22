import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "./server.mjs";
test("public reads and unrestricted content editing after registration", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-open-edit-"));
  let app = await createApp({ allowUninvitedRegistration: true,
    dataDir,
    origin: "https://worklog.example.com",
    adminPassword: "Admin-test-93427",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  let endpoint =
    "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
  async function request(
    route,
    method = "GET",
    body,
    cookie = "",
    origin = "https://worklog.example.com",
  ) {
    const res = await fetch(endpoint + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Worklog-Request": "1",
        Origin: origin,
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
      header: res.headers.get("set-cookie"),
    };
  }
  try {
    const initial = await request("/state"),
      project = initial.data.projects[0].id;
    let alice, bob, recordId, secondProject;
    await t.test(
      "public reads without account, signed-out content writes rejected",
      async () => {
        assert.equal(initial.status, 200);
        assert.equal(initial.data.user, null);
        assert.equal((await request("/records", "POST", {})).status, 401);
        assert.equal(
          (await request("/projects", "POST", { name: "anonymous" })).status,
          401,
        );
        assert.equal(
          (
            await request("/projects/" + project, "PATCH", {
              name: "anonymous",
              version: 1,
            })
          ).status,
          401,
        );
        assert.equal(
          (await request("/register", "POST", {}, "", "https://evil.example"))
            .status,
          403,
        );
      },
    );
    await t.test(
      "registration gives content access without granting account administrator role",
      async () => {
        alice = await request("/register", "POST", {
          login: "alice",
          name: "胡示例三",
          password: "test-user-password",
          role: "admin",
        });
        bob = await request("/register", "POST", {
          login: "bob",
          name: "韩示例二",
          password: "test-user-password",
        });
        assert.equal(alice.status, 201);
        assert.equal(bob.status, 201);
        assert.match(alice.header, /HttpOnly/);
        assert.match(alice.header, /Secure/);
        assert.equal(
          (await request("/state", "GET", undefined, alice.cookie)).data.user
            .role,
          "member",
        );
        assert.equal(
          (
            await request("/register", "POST", {
              login: "ALICE",
              name: "胡示例三",
              password: "another-password",
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "registered member can edit an existing project created before registration",
      async () => {
        const result = await request(
          "/projects/" + project,
          "PATCH",
          {
            name: "共同维护项目",
            color: "emerald",
            members: ["胡示例三", "韩示例二"],
            version: 1,
          },
          alice.cookie,
        );
        assert.equal(result.status, 200);
      },
    );
    await t.test("optional date and public visibility", async () => {
      const saved = await request(
        "/records",
        "POST",
        {
          project_id: project,
          task: "接口联调",
          owner: "胡示例三",
          actual: "韩示例二",
        },
        alice.cookie,
      );
      assert.equal(saved.status, 201);
      recordId = saved.data.id;
      const publicState = (await request("/state")).data;
      assert.equal(publicState.records[0].date, "");
      assert.equal(publicState.records[0].editable, false);
      assert.equal(JSON.stringify(publicState).includes("password"), false);
      assert.equal(
        (await request("/state", "GET", undefined, bob.cookie)).data.records[0]
          .editable,
        true,
      );
    });
    await t.test(
      "another member edits a record with no ownership restriction; date validation retained",
      async () => {
        const data = {
          task: "韩示例二修改他人记录",
          owner: "胡示例三",
          actual: "胡示例三、韩示例二",
          date: "2026-10-15",
          version: 1,
        };
        assert.equal(
          (
            await request(
              "/records/" + recordId,
              "PATCH",
              { ...data, date: "2026-02-30" },
              bob.cookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (await request("/records/" + recordId, "PATCH", data, bob.cookie))
            .status,
          200,
        );
        const r = (await request("/state")).data.records[0];
        assert.equal(r.task, data.task);
        assert.equal(
          r.creator,
          (await request("/state", "GET", undefined, alice.cookie)).data.user
            .id,
        );
      },
    );
    await t.test(
      "simultaneous edits cannot silently overwrite another member",
      async () => {
        const data = {
          task: "并发修改",
          owner: "甲",
          actual: "乙",
          date: "",
          version: 2,
        };
        const results = await Promise.all([
          request("/records/" + recordId, "PATCH", data, alice.cookie),
          request("/records/" + recordId, "PATCH", data, bob.cookie),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal((await request("/state")).data.records[0].version, 3);
      },
    );
    await t.test(
      "another member updates project settings and optimistic locking protects shared changes",
      async () => {
        const data = {
          name: "所有成员可维护",
          color: "sky",
          members: ["甲", "乙", "甲"],
          version: 2,
        };
        assert.equal(
          (await request("/projects/" + project, "PATCH", data, bob.cookie))
            .status,
          200,
        );
        assert.equal(
          (await request("/projects/" + project, "PATCH", data, alice.cookie))
            .status,
          409,
        );
        const p = (await request("/state")).data.projects.find(
          (p) => p.id === project,
        );
        assert.equal(p.color, "sky");
        assert.deepEqual(p.members, ["甲", "乙"]);
        assert.equal(
          (
            await request(
              "/projects/" + project,
              "PATCH",
              { name: p.name, version: 3 },
              alice.cookie,
            )
          ).status,
          200,
        );
        const kept = (await request("/state")).data.projects.find(
          (p) => p.id === project,
        );
        assert.equal(kept.color, "sky");
        assert.deepEqual(kept.members, ["甲", "乙"]);
        assert.equal(
          (
            await request(
              "/projects/" + project,
              "PATCH",
              { name: p.name, color: "arbitrary-css", version: 4 },
              bob.cookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "/projects",
              "POST",
              { name: "bad", members: [42] },
              bob.cookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              "/projects",
              "POST",
              { name: "too-many", members: Array(101).fill("姓名") },
              bob.cookie,
            )
          ).status,
          400,
        );
      },
    );
    await t.test("projects retain separate records", async () => {
      const p = await request(
        "/projects",
        "POST",
        { name: "第二项目" },
        bob.cookie,
      );
      assert.equal(p.status, 201);
      secondProject = p.data.id;
      assert.equal(
        (
          await request(
            "/records",
            "POST",
            {
              project_id: secondProject,
              task: "另一项目",
              owner: "甲",
              actual: "乙",
              date: "2026-10-01",
            },
            alice.cookie,
          )
        ).status,
        201,
      );
      const records = (await request("/state")).data.records;
      assert.equal(records.filter((r) => r.project_id === project).length, 1);
      assert.equal(
        records.filter((r) => r.project_id === secondProject).length,
        1,
      );
    });
    await t.test(
      "any member may delete and another member may undo; anonymous users may not",
      async () => {
        assert.equal(
          (await request("/records/" + recordId, "DELETE", { version: 3 }))
            .status,
          401,
        );
        assert.equal(
          (await request("/records/" + recordId, "PATCH", { version: 3 }))
            .status,
          401,
        );
        const deleted = await request(
          "/records/" + recordId,
          "DELETE",
          { version: 3 },
          bob.cookie,
        );
        assert.equal(deleted.status, 200);
        assert.equal(deleted.data.version, 4);
        assert.equal((await request("/state")).data.records.length, 1);
        assert.equal(
          (
            await request("/records/" + recordId + "/restore", "POST", {
              version: 4,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/records/" + recordId + "/restore",
              "POST",
              { version: 4 },
              alice.cookie,
            )
          ).status,
          200,
        );
        assert.equal((await request("/state")).data.records.length, 2);
      },
    );
    await t.test(
      "invalid input produces validation responses and creates no records",
      async () => {
        const before = (await request("/state")).data.records.length;
        for (const data of [
          null,
          [],
          42,
          { project_id: project, task: "", owner: "甲", actual: "乙" },
          {
            project_id: project,
            task: "合法",
            owner: "甲",
            actual: 42,
            date: "2026-10-15",
          },
          { project_id: "missing", task: "合法", owner: "甲", actual: "乙" },
        ]) {
          const r = await request("/records", "POST", data, alice.cookie);
          assert.ok([400, 404].includes(r.status));
        }
        assert.equal((await request("/state")).data.records.length, before);
      },
    );
    await t.test(
      "password changes and logout revoke editing access of old sessions",
      async () => {
        const updated = await request(
          "/password",
          "POST",
          {
            oldPassword: "test-user-password",
            password: "changed-password-123",
          },
          alice.cookie,
        );
        assert.equal(updated.status, 200);
        assert.equal(
          (await request("/state", "GET", undefined, alice.cookie)).data.user,
          null,
        );
        assert.equal(
          (await request("/records", "POST", {}, alice.cookie)).status,
          401,
        );
        assert.equal(
          (
            await request("/login", "POST", {
              login: "alice",
              password: "test-user-password",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request("/login", "POST", {
              login: "alice",
              password: "changed-password-123",
            })
          ).status,
          200,
        );
        assert.equal(
          (await request("/logout", "POST", {}, updated.cookie)).status,
          200,
        );
        assert.equal(
          (await request("/state", "GET", undefined, updated.cookie)).data.user,
          null,
        );
      },
    );
    await t.test(
      "shared edits keep editor audit and survive restart",
      async () => {
        const bobId = (await request("/state", "GET", undefined, bob.cookie))
          .data.user.id;
        const edit = app.db
          .prepare(
            "SELECT * FROM audit WHERE action='update-record' AND actor=?",
          )
          .get(bobId);
        assert.ok(edit);
        assert.equal(JSON.parse(edit.after_json).task, "韩示例二修改他人记录");
        await app.close();
        app = await createApp({ allowUninvitedRegistration: true, dataDir, origin: "https://worklog.example.com" });
        await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
        endpoint =
          "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
        assert.equal((await request("/state")).data.records.length, 2);
        assert.ok(
          (
            await request("/state", "GET", undefined, bob.cookie)
          ).data.records.every((r) => r.editable),
        );
      },
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import { splitNames } from "./src/people.js";
test("joint completion names are normalized once per person", () => {
  assert.deepEqual(splitNames("张三、李四，张三; 王五"), [
    "张三",
    "李四",
    "王五",
  ]);
});

import { DatabaseSync } from "node:sqlite";
import {
  filterRecords,
  availablePeople,
  isCompleted,
  completionDateLabel,
  statistics,
  personSummary,
  pagination,
} from "./src/model.js";
test("legacy project migration preserves data and is idempotent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-migration-"));
  const old = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  old.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,creator TEXT,version INTEGER NOT NULL,created TEXT NOT NULL)",
  );
  old
    .prepare("INSERT INTO projects VALUES(?,?,?,?,?)")
    .run("legacy-project", "原有项目", null, 7, "2026-09-01");
  old.close();
  let app;
  try {
    app = await createApp({ allowUninvitedRegistration: true, dataDir });
    let p = app.db.prepare("SELECT * FROM projects").get();
    assert.equal(p.id, "legacy-project");
    assert.equal(p.version, 7);
    assert.equal(p.name, "原有项目");
    assert.equal(p.color, "indigo");
    assert.equal(p.members, "[]");
    app.db.close();
    app = await createApp({ allowUninvitedRegistration: true, dataDir });
    assert.equal(
      app.db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,
      1,
    );
  } finally {
    app?.db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
const sample = [
  {
    id: "1",
    project_id: "a",
    task: "接口",
    owner: "甲",
    actual: "乙",
    date: "2026-10-01",
  },
  {
    id: "2",
    project_id: "a",
    task: "协作",
    owner: "甲",
    actual: "甲、乙、乙",
    date: "2026-10-02",
  },
  {
    id: "3",
    project_id: "a",
    task: "待补日期",
    owner: "丙",
    actual: "丙",
    date: "",
  },
  {
    id: "4",
    project_id: "b",
    task: "另一项目",
    owner: "丁",
    actual: "丁",
    date: "2026-10-03",
  },
  {
    id: "5",
    project_id: "a",
    task: "上个月",
    owner: "甲",
    actual: "甲",
    date: "2026-09-30",
  },
  {
    id: "6",
    project_id: "a",
    task: "尚未完成",
    owner: "丙",
    actual: "",
    date: "",
  },
];
test("project, month, missing date, multi-person and name search filters compose", () => {
  assert.deepEqual(
    filterRecords(sample, {
      projectId: "a",
      month: "2026-10",
      people: ["乙"],
    }).map((r) => r.id),
    ["2", "1"],
  );
  assert.deepEqual(
    filterRecords(sample, { projectId: "a", month: "none" }).map((r) => r.id),
    ["6"],
  );
  assert.equal(
    filterRecords(sample, { projectId: "a", people: ["乙", "丙"] }).length,
    3,
  );
  assert.equal(
    filterRecords(sample, { projectId: "a", keyword: "乙" }).length,
    2,
  );
  assert.equal(
    filterRecords(sample, { projectId: "a", keyword: "不存在" }).length,
    0,
  );
});
test("joint attribution and other-person completion are counted accurately", () => {
  const rs = sample.slice(0, 3),
    s = statistics(rs);
  assert.equal(s.total, 3);
  assert.equal(s.people, 3);
  assert.equal(s.days, 2);
  assert.equal(s.undated, 1);
  assert.equal(s.other, 1);
  assert.equal(s.otherPct, 33);
  const people = personSummary(rs);
  assert.equal(people.find((p) => p.name === "乙").done, 2);
  assert.equal(people.find((p) => p.name === "甲").done, 1);
  assert.equal(people.find((p) => p.name === "甲").owned, 2);
  assert.equal(people.find((p) => p.name === "丙").done, 1);
  assert.equal(people.find((p) => p.name === "丙").pending, 0);
  assert.equal(statistics([]).otherPct, 0);
});
test("pagination stays bounded after filtering or deletion", () => {
  assert.deepEqual(pagination(0, 9), {
    pages: 1,
    page: 1,
    start: 0,
    numbers: [1],
  });
  assert.equal(pagination(11, 9).page, 3);
  assert.equal(pagination(11, 9).start, 10);
  assert.ok(pagination(500, 50).numbers.length <= 7);
  assert.deepEqual(pagination(11, 0).numbers, [1, 2, 3]);
});

test("unfinished records allow no completer and can later be completed or reopened", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-pending-"));
  let app;
  try {
    app = await createApp({ allowUninvitedRegistration: true, dataDir, origin: "https://worklog.example.com" });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const endpoint =
      "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
    async function request(route, method = "GET", body, cookie = "") {
      const r = await fetch(endpoint + route, {
        method,
        headers: {
          Origin: "https://worklog.example.com",
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
    const user = await request("/register", "POST", {
      name: "胡示例三",
      login: "pendingqa",
      password: "Temporary-test-123",
    });
    const project = (await request("/state")).data.projects[0].id;
    const created = await request(
      "/records",
      "POST",
      {
        project_id: project,
        task: "可以先登记未完成工作",
        owner: "胡示例三、胡示例三，韩示例二",
      },
      user.cookie,
    );
    assert.equal(created.status, 201);
    const current = async () =>
      (await request("/state")).data.records.find(
        (r) => r.id === created.data.id,
      );
    let record = await current();
    assert.equal(record.owner, "胡示例三、韩示例二");
    assert.equal(record.actual, "");
    assert.equal(record.date, "");
    assert.equal(statistics([record]).total, 0);
    const pending = personSummary([record]).find((p) => p.name === "胡示例三");
    assert.equal(pending.done, 0);
    assert.equal(pending.pending, 1);
    assert.equal(pending.records[0].id, record.id);
    const auditCount = (await request("/logs")).data.total;
    const invalid = await request(
      "/records/" + record.id,
      "PATCH",
      { ...record, date: "2026-02-30" },
      user.cookie,
    );
    assert.equal(invalid.status, 400);
    assert.equal((await current()).version, record.version);
    assert.equal((await request("/logs")).data.total, auditCount);
    for (const state of [
      { actual: "韩示例二", date: "" },
      { actual: "韩示例二", date: "2026-10-15" },
      { actual: "", date: "2026-10-15" },
    ]) {
      const completed = await request(
        "/records/" + record.id,
        "PATCH",
        { ...record, ...state },
        user.cookie,
      );
      assert.equal(completed.status, 200);
      record = await current();
      assert.equal(isCompleted(record), true);
      assert.equal(statistics([record]).total, 1);
      assert.equal(statistics([record]).pending, 0);
      assert.equal(completionDateLabel(record), state.date);
      const summary = personSummary([record]);
      if (state.actual)
        assert.equal(summary.find((p) => p.name === "韩示例二").done, 1);
      else {
        assert.equal(summary.find((p) => p.name === "韩示例二").done, 0);
        assert.equal(summary.find((p) => p.name === "韩示例二").unassigned, 1);
      }
      assert.equal(statistics([record]).otherPct, 0);
    }
    const reopened = await request(
      "/records/" + record.id,
      "PATCH",
      { ...record, actual: "", date: "" },
      user.cookie,
    );
    assert.equal(reopened.status, 200);
    record = await current();
    assert.equal(statistics([record]).total, 0);
    assert.equal(statistics([record]).pending, 1);
    assert.equal(completionDateLabel(record), "未完成");
    const history = (await request("/logs")).data.entries;
    assert.ok(
      history.some(
        (e) =>
          e.action === "create-record" &&
          e.after.actual === "" &&
          e.after.date === "",
      ),
    );
    assert.ok(
      history.some(
        (e) =>
          e.action === "update-record" &&
          e.after.actual === "" &&
          e.after.date === "2026-10-15",
      ),
    );
    await app.close();
    app = await createApp({ allowUninvitedRegistration: true, dataDir });
    const saved = app.db
      .prepare("SELECT actual,date FROM records WHERE id=?")
      .get(record.id);
    assert.equal(saved.actual, "");
    assert.equal(saved.date, "");
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("record sorting keeps blanks last, ties stable and natural name order", () => {
  const records = [
    {
      id: "a",
      task: "任务10",
      owner: "胡示例三、韩示例二",
      actual: "胡示例三",
      date: "2026-10-02",
      created: "2026-10-04",
    },
    {
      id: "b",
      task: "任务2",
      owner: "韩示例二",
      actual: "韩示例二",
      date: "2026-10-01",
      created: "2026-10-03",
    },
    {
      id: "c",
      task: "任务1",
      owner: "胡示例三",
      actual: "",
      date: "",
      created: "2026-10-05",
    },
    {
      id: "d",
      task: "任务3",
      owner: "胡示例三",
      actual: "",
      date: "",
      created: "2026-10-05",
    },
  ];
  const ids = (sort) => filterRecords(records, { sort }).map((r) => r.id);
  assert.deepEqual(ids("date-asc"), ["b", "a", "c", "d"]);
  assert.deepEqual(ids("date-desc"), ["a", "b", "c", "d"]);
  assert.deepEqual(ids("created-asc"), ["b", "a", "c", "d"]);
  assert.deepEqual(ids("created-desc"), ["c", "d", "a", "b"]);
  assert.deepEqual(ids("task-asc"), ["c", "b", "d", "a"]);
  assert.deepEqual(ids("task-desc"), ["a", "d", "b", "c"]);
  assert.deepEqual(ids("invalid"), ids("date-desc"));
  assert.ok(
    ids("actual-asc")
      .slice(-2)
      .every((id) => ["c", "d"].includes(id)),
  );
  assert.ok(
    ids("actual-desc")
      .slice(-2)
      .every((id) => ["c", "d"].includes(id)),
  );
  assert.deepEqual(
    records.map((r) => r.id),
    ["a", "b", "c", "d"],
  );
  for (const size of [5, 10, 20, 50, 100]) {
    const pg = pagination(127, 999, size);
    assert.equal(pg.page, Math.ceil(127 / size));
    assert.ok(pg.start < 127);
  }
});
test("multiple original owners are split, deduplicated and each credited correctly", () => {
  const records = [
    { owner: "胡示例三、韩示例二、胡示例三", actual: "韩示例二", date: "2026-10-15" },
    { owner: "胡示例三、韩示例二", actual: "", date: "" },
  ];
  const people = personSummary(records);
  assert.deepEqual(
    new Set(availablePeople(null, records, null)),
    new Set(["胡示例三", "韩示例二"]),
  );
  assert.equal(people.length, 2);
  assert.equal(people.find((p) => p.name === "胡示例三").owned, 2);
  assert.equal(people.find((p) => p.name === "韩示例二").owned, 2);
  assert.equal(people.find((p) => p.name === "胡示例三").pending, 1);
  assert.equal(people.find((p) => p.name === "韩示例二").done, 1);
  assert.equal(statistics(records).other, 0);
  assert.equal(statistics([{ ...records[0], actual: "易示例二十一" }]).other, 1);
});

test("completion is defined by either a completer or a date, both blank stays pending", () => {
  for (const [actual, date, done, label] of [
    ["", "", false, "未完成"],
    ["韩示例二", "", true, ""],
    ["", "2026-10-15", true, "2026-10-15"],
    ["韩示例二", "2026-10-15", true, "2026-10-15"],
    [undefined, "", false, "未完成"],
  ]) {
    const record = {
      id: "status",
      task: "状态验收",
      owner: "胡示例三",
      actual,
      date,
    };
    assert.equal(isCompleted(record), done);
    assert.equal(completionDateLabel(record), label);
    assert.equal(statistics([record]).total, done ? 1 : 0);
    assert.equal(
      filterRecords([record], { month: "none" }).length,
      done ? 0 : 1,
    );
  }
  assert.equal(
    statistics([{ owner: "胡示例三", actual: "", date: "2026-10-15" }]).otherPct,
    0,
  );
});
