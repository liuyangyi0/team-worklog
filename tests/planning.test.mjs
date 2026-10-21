import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import {
  planningFields,
  installPlanningSchema,
  ensureDueNotifications,
  mentionedNames,
} from "../planning.mjs";
import {
  dueState,
  myTodos,
  filterRecords,
  beijingDate,
  isCompleted,
} from "../src/model.js";
test("planning dates do not change completion; Beijing deadlines and priority sort", () => {
  assert.equal(beijingDate(new Date("2026-10-15T16:01:00Z")), "2026-10-16");
  const pending = {
    id: "p",
    task: "pending",
    owner: "胡示例三、韩示例二",
    actual: "",
    date: "",
    due_date: "2026-10-15",
    priority: "urgent",
  };
  assert.equal(isCompleted(pending), false);
  assert.equal(dueState(pending, "2026-10-16"), "overdue");
  assert.equal(
    dueState({ ...pending, due_date: "2026-10-16" }, "2026-10-16"),
    "today",
  );
  assert.equal(
    dueState({ ...pending, due_date: "2026-10-17" }, "2026-10-16"),
    "soon",
  );
  assert.equal(
    dueState({ ...pending, due_date: "2027-01-01" }, "2026-12-31"),
    "soon",
  );
  for (const extra of [{ actual: "韩示例二" }, { date: "2026-10-15" }]) {
    assert.equal(dueState({ ...pending, ...extra }, "2026-10-16"), "");
    assert.deepEqual(myTodos([{ ...pending, ...extra }], "胡示例三"), []);
  }
  assert.equal(myTodos([pending], "韩示例二").length, 1);
  assert.equal(myTodos([pending], "韩").length, 0);
  assert.deepEqual(
    filterRecords([{ ...pending, id: "l", priority: "low" }, pending], {
      sort: "priority-desc",
    }).map((r) => r.id),
    ["p", "l"],
  );
  assert.deepEqual(
    filterRecords([pending, { ...pending, id: "n", due_date: "" }], {
      sort: "due_date-asc",
    }).map((r) => r.id),
    ["p", "n"],
  );
  for (const value of ["2026-02-30", "2026-2-01", false, "2026-13-01"])
    assert.throws(() => planningFields({ due_date: value }));
  for (const value of [null, "highest", 1])
    assert.throws(() => planningFields({ priority: value }));
  assert.deepEqual(
    planningFields({}, { due_date: "2026-10-16", priority: "high" }),
    { due_date: "2026-10-16", priority: "high" },
  );
  assert.deepEqual(
    mentionedNames("请@韩示例二 @韩示例二，请处理 @胡示例三。 @胡示例三甲 abc@韩示例二 @韩示例二2", [
      "韩示例二",
      "胡示例三",
    ]),
    ["韩示例二", "胡示例三"],
  );
});
test("planning, assignment notifications, mention updates and private read state", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-planning-"));
  let app;
  try {
    app = await createApp({ dataDir, origin: "https://worklog.example.com" });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base =
      "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
    async function api(route, method = "GET", body, cookie = "") {
      const r = await fetch(base + route, {
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
    const a = await api("/register", "POST", {
        name: "胡示例三",
        login: "planning_a",
        password: "Temporary-test-123",
      }),
      b = await api("/register", "POST", {
        name: "韩示例二",
        login: "planning_b",
        password: "Temporary-test-123",
      });
    const project = (await api("/state")).data.projects[0].id;
    const create = async (extra = {}) =>
      api(
        "/records",
        "POST",
        {
          project_id: project,
          task: "计划任务",
          owner: "韩示例二",
          actual: "",
          date: "",
          due_date: "2099-10-16",
          priority: "high",
          ...extra,
        },
        a.cookie,
      );
    const recordId = (await create()).data.id;
    const record = async () =>
      (await api("/state")).data.records.find((r) => r.id === recordId);
    let note;
    await t.test(
      "fields persist; assignment only goes to recipient; anonymous cannot read",
      async () => {
        assert.equal((await record()).due_date, "2099-10-16");
        assert.equal((await record()).priority, "high");
        assert.equal(isCompleted(await record()), false);
        assert.equal((await api("/notifications")).status, 401);
        assert.equal(
          (await api("/notifications", "GET", undefined, a.cookie)).data.entries
            .length,
          0,
        );
        const inbox = (await api("/notifications", "GET", undefined, b.cookie))
          .data;
        assert.equal(inbox.unread, 1);
        note = inbox.entries[0];
        assert.equal(note.kind, "assigned");
        assert.equal(note.record_id, recordId);
        assert.equal(
          (await api("/state", "GET", undefined, b.cookie)).data
            .unread_notifications,
          1,
        );
        assert.equal((await api("/state")).data.unread_notifications, 0);
        assert.equal(
          (
            await api(
              "/notifications/" + note.id + "/read",
              "POST",
              {},
              a.cookie,
            )
          ).status,
          404,
        );
        assert.equal(
          (await api("/notifications/" + note.id, "DELETE", {}, b.cookie))
            .status,
          405,
        );
        assert.equal(
          (await api("/notifications?before=-1", "GET", undefined, b.cookie))
            .status,
          400,
        );
      },
    );
    await t.test(
      "partial legacy payload preserves planning; invalid writes and conflicts create no reminders",
      async () => {
        let r = await record();
        const { due_date, priority, ...legacy } = r;
        assert.equal(
          (await api("/records/" + recordId, "PATCH", legacy, a.cookie)).status,
          200,
        );
        assert.equal((await record()).due_date, due_date);
        assert.equal((await record()).priority, priority);
        assert.equal(
          (await api("/notifications", "GET", undefined, b.cookie)).data.entries
            .length,
          1,
        );
        assert.equal(
          (
            await api(
              "/records/" + recordId,
              "PATCH",
              { ...r, task: "过期版本" },
              a.cookie,
            )
          ).status,
          409,
        );
        for (const extra of [
          { due_date: "2026-02-30" },
          { priority: "invalid" },
        ])
          assert.equal((await create(extra)).status, 400);
        const logs = (await api("/logs")).data.entries;
        assert.equal(
          logs.filter((e) => e.action === "create-record").length,
          1,
        );
      },
    );
    await t.test(
      "other member updates trigger notification; self update does not; public audit includes planning",
      async () => {
        let r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, priority: "urgent", due_date: "2099-11-01" },
          a.cookie,
        );
        let inbox = (await api("/notifications", "GET", undefined, b.cookie))
          .data;
        assert.equal(inbox.entries[0].title, "任务计划已更新");
        const count = inbox.entries.length;
        r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, task: "自己调整任务" },
          b.cookie,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, b.cookie)).data.entries
            .length,
          count,
        );
        const log = (await api("/logs")).data.entries.find(
          (e) =>
            e.after?.priority === "urgent" && e.before?.priority === "high",
        );
        assert.equal(log.after.due_date, "2099-11-01");
        const beforeVersion = (await record()).version;
        installPlanningSchema(app.db);
        assert.equal((await record()).version, beforeVersion);
      },
    );
    await t.test(
      "comments notify unique mentions, ignore self and only newly added mentions on edits",
      async () => {
        const posted = await api(
          "/records/" + recordId + "/comments",
          "POST",
          { body: "请 @韩示例二 @韩示例二 处理，@胡示例三 已检查。" },
          a.cookie,
        );
        assert.equal(posted.status, 201);
        let inbox = (await api("/notifications", "GET", undefined, b.cookie))
          .data;
        assert.equal(inbox.entries[0].kind, "mentioned");
        const count = inbox.entries.length;
        await api(
          "/records/" + recordId + "/comments/" + posted.data.id,
          "PATCH",
          { version: 1, body: "再次请 @韩示例二 核对" },
          a.cookie,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, b.cookie)).data.entries
            .length,
          count,
        );
        await api(
          "/records/" + recordId + "/comments/" + posted.data.id,
          "PATCH",
          { version: 2, body: "请 @胡示例三 处理" },
          b.cookie,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, a.cookie)).data
            .entries[0].kind,
          "mentioned",
        );
        assert.equal(
          (
            await api(
              "/notifications/read",
              "POST",
              { through: inbox.latestId },
              b.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await api("/notifications?unread=1", "GET", undefined, b.cookie))
            .data.entries.length,
          0,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, a.cookie)).data.unread,
          1,
        );
      },
    );
    await t.test(
      "due reminders deduplicate and exclude completed and deleted tasks",
      async () => {
        let r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, due_date: "2026-10-16" },
          b.cookie,
        );
        ensureDueNotifications(app.db, "2026-10-15");
        ensureDueNotifications(app.db, "2026-10-16");
        let rows = app.db
          .prepare(
            "SELECT * FROM notifications WHERE record_id=? AND kind='due-soon'",
          )
          .all(recordId);
        assert.equal(rows.length, 1);
        ensureDueNotifications(app.db, "2026-10-17");
        ensureDueNotifications(app.db, "2026-10-18");
        assert.equal(
          app.db
            .prepare(
              "SELECT COUNT(*) n FROM notifications WHERE record_id=? AND kind='overdue'",
            )
            .get(recordId).n,
          1,
        );
        r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, actual: "胡示例三", date: "", due_date: "2026-10-14" },
          a.cookie,
        );
        const completed = await record();
        assert.equal(isCompleted(completed), true);
        assert.equal(completed.date, "");
        ensureDueNotifications(app.db, "2026-10-18");
        assert.equal(
          app.db
            .prepare(
              "SELECT COUNT(*) n FROM notifications WHERE record_id=? AND kind='overdue'",
            )
            .get(recordId).n,
          1,
        );
        assert.deepEqual(myTodos([completed], "韩示例二"), []);
        r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, actual: "", date: "2026-10-12" },
          b.cookie,
        );
        assert.equal(isCompleted(await record()), true);
        r = await record();
        await api(
          "/records/" + recordId,
          "PATCH",
          { ...r, actual: "", date: "" },
          b.cookie,
        );
        assert.equal(myTodos([await record()], "韩示例二").length, 1);
        r = await record();
        await api(
          "/records/" + recordId,
          "DELETE",
          { version: r.version },
          b.cookie,
        );
        ensureDueNotifications(app.db, "2026-10-18");
        assert.equal(
          app.db
            .prepare(
              "SELECT COUNT(*) n FROM notifications WHERE record_id=? AND kind='overdue'",
            )
            .get(recordId).n,
          1,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, b.cookie)).data
            .entries[0].task_deleted,
          1,
        );
      },
    );
    await t.test(
      "read-all watermark leaves newer arrivals unread and private across accounts",
      async () => {
        const aliceUnread = (
          await api("/notifications", "GET", undefined, a.cookie)
        ).data.unread;
        const head = (await api("/notifications", "GET", undefined, b.cookie))
          .data.latestId;
        await create({ task: "新的待办" });
        await api("/notifications/read", "POST", { through: head }, b.cookie);
        let unread = (
          await api("/notifications?unread=1", "GET", undefined, b.cookie)
        ).data;
        assert.equal(unread.entries.length, 1);
        assert.equal(unread.entries[0].task, "新的待办");
        const read = await api(
          "/notifications/" + unread.entries[0].id + "/read",
          "POST",
          {},
          b.cookie,
        );
        assert.equal(read.status, 200);
        assert.equal(
          (await api("/notifications?unread=1", "GET", undefined, b.cookie))
            .data.unread,
          0,
        );
        assert.equal(
          (await api("/notifications", "GET", undefined, a.cookie)).data.unread,
          aliceUnread,
        );
      },
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
