import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import {
  isCompleted,
  statistics,
  peopleOverview,
  filterRecords,
  taskTree,
  recordMonth,
} from "../src/model.js";
test("subtasks, public comments and cross-project accounting", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-collab-"));
  let app;
  try {
    app = await createApp({ allowUninvitedRegistration: true, dataDir, origin: "https://worklog.example.com" });
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
    const alice = await api("/register", "POST", {
        name: "胡示例三",
        login: "collab_alice",
        password: "Temporary-test-123",
      }),
      bob = await api("/register", "POST", {
        name: "韩示例二",
        login: "collab_bob",
        password: "Temporary-test-123",
      });
    const project = (await api("/state")).data.projects[0].id,
      project2 = (
        await api(
          "/projects",
          "POST",
          { name: "第二项目", color: "sky" },
          alice.cookie,
        )
      ).data.id;
    const create = async (task, extra = {}, cookie = alice.cookie) =>
      await api(
        "/records",
        "POST",
        {
          project_id: project,
          task,
          owner: "胡示例三、韩示例二",
          actual: "",
          date: "",
          ...extra,
        },
        cookie,
      );
    let root, child, oldDeleted;
    await t.test(
      "creates nested tasks within a project and preserves completion timestamp",
      async () => {
        root = (await create("父任务", { actual: "胡示例三" })).data.id;
        child = (
          await create(
            "子任务",
            { parent_id: root, owner: "韩示例二", actual: "韩示例二" },
            bob.cookie,
          )
        ).data.id;
        assert.equal(
          (
            await create("跨项目错误", {
              project_id: project2,
              parent_id: root,
            })
          ).status,
          400,
        );
        assert.equal(
          (await create("错误上级", { parent_id: "missing" })).status,
          404,
        );
        assert.equal(
          (await create("游客不能创建", { parent_id: root }, "")).status,
          401,
        );
        let state = (await api("/state")).data,
          record = state.records.find((r) => r.id === child);
        assert.equal(record.parent_id, root);
        assert.ok(record.completed_at);
        assert.equal(state.records.find((r) => r.id === root).child_count, 1);
        const stamp = record.completed_at;
        assert.equal(
          (
            await api(
              "/records/" + child,
              "PATCH",
              { ...record, task: "修改标题后仍保留完成时间" },
              alice.cookie,
            )
          ).status,
          200,
        );
        record = (await api("/state")).data.records.find((r) => r.id === child);
        assert.equal(record.completed_at, stamp);
        assert.equal(
          (
            await api(
              "/records/" + child,
              "PATCH",
              { ...record, parent_id: null },
              alice.cookie,
            )
          ).status,
          400,
        );
        await api(
          "/records/" + child,
          "PATCH",
          { ...record, actual: "", date: "" },
          alice.cookie,
        );
        record = (await api("/state")).data.records.find((r) => r.id === child);
        assert.equal(record.completed_at, "");
        await api(
          "/records/" + child,
          "PATCH",
          { ...record, date: "2026-10-16" },
          bob.cookie,
        );
        record = (await api("/state")).data.records.find((r) => r.id === child);
        assert.ok(isCompleted(record));
        assert.ok(record.completed_at);
        assert.equal(record.actual, "");
        const tree = taskTree((await api("/state")).data.records, [record]);
        assert.equal(tree.roots[0].id, root);
        assert.equal(tree.children.get(root)[0].id, child);
      },
    );
    let commentId;
    await t.test(
      "comments are public; any member can update with conflict protection and stable author",
      async () => {
        assert.equal(
          (
            await api("/records/" + root + "/comments", "POST", {
              body: "匿名写入",
            })
          ).status,
          401,
        );
        const posted = await api(
          "/records/" + root + "/comments",
          "POST",
          { body: "原始评论 <script>alert(1)</script>" },
          alice.cookie,
        );
        assert.equal(posted.status, 201);
        commentId = posted.data.id;
        const publicComments = (await api("/records/" + root + "/comments"))
          .data;
        assert.equal(publicComments.total, 1);
        assert.equal(publicComments.entries[0].author_name, "胡示例三");
        assert.equal(publicComments.entries[0].editable, false);
        assert.equal(
          JSON.stringify(publicComments).includes("collab_alice"),
          false,
        );
        assert.equal(
          (
            await api(
              "/records/" + root + "/comments/" + commentId,
              "PATCH",
              { body: "其他成员修改", version: 1 },
              bob.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await api(
              "/records/" + root + "/comments/" + commentId,
              "PATCH",
              { body: "过期草稿", version: 1 },
              alice.cookie,
            )
          ).status,
          409,
        );
        const updated = (await api("/records/" + root + "/comments")).data
          .entries[0];
        assert.equal(updated.author_name, "胡示例三");
        assert.equal(updated.body, "其他成员修改");
        assert.equal(updated.version, 2);
        const log = (await api("/logs")).data.entries.find(
          (e) => e.action === "update-comment",
        );
        assert.equal(log.actor, "韩示例二");
        assert.equal(log.projectId, project);
        assert.equal(log.entityType, "comment");
        assert.equal(log.before.body, "原始评论 <script>alert(1)</script>");
        assert.equal(log.after.body, "其他成员修改");
      },
    );
    await t.test(
      "comment validation, pagination, soft delete and immutable history",
      async () => {
        for (const body of ["", " ".repeat(5), "x".repeat(3001), 42])
          assert.equal(
            (
              await api(
                "/records/" + root + "/comments",
                "POST",
                { body },
                alice.cookie,
              )
            ).status,
            400,
          );
        for (let i = 0; i < 24; i++)
          await api(
            "/records/" + root + "/comments",
            "POST",
            { body: "分页评论" + i },
            alice.cookie,
          );
        const first = (await api("/records/" + root + "/comments")).data;
        assert.equal(first.entries.length, 20);
        assert.equal(first.total, 25);
        assert.ok(first.nextCursor);
        const second = (
          await api("/records/" + root + "/comments?before=" + first.nextCursor)
        ).data;
        assert.equal(second.entries.length, 5);
        assert.equal(
          new Set([...first.entries, ...second.entries].map((e) => e.id)).size,
          25,
        );
        assert.equal(
          (await api("/records/" + root + "/comments?limit=999")).status,
          400,
        );
        assert.equal(
          (
            await api(
              "/records/" + root + "/comments/" + commentId,
              "DELETE",
              { version: 2 },
              bob.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await api("/records/" + root + "/comments")).data.total,
          24,
        );
        const history = (await api("/logs")).data.entries.find(
          (e) => e.action === "delete-comment",
        );
        assert.equal(history.before.body, "其他成员修改");
        assert.equal(history.actor, "韩示例二");
        assert.equal(
          (await api("/logs/" + history.id, "DELETE", {}, bob.cookie)).status,
          405,
        );
        assert.equal(
          (await api("/state")).data.records.find((r) => r.id === root)
            .comment_count,
          24,
        );
      },
    );
    await t.test("audit failure rolls back comment writes", async () => {
      const before = (await api("/records/" + root + "/comments")).data.total;
      app.db.exec(
        "CREATE TRIGGER fail_comment_audit BEFORE INSERT ON audit WHEN NEW.action='create-comment' BEGIN SELECT RAISE(ABORT,'comment-audit-failure'); END",
      );
      assert.equal(
        (
          await api(
            "/records/" + root + "/comments",
            "POST",
            { body: "不应留下半次写入" },
            alice.cookie,
          )
        ).status,
        500,
      );
      app.db.exec("DROP TRIGGER fail_comment_audit");
      assert.equal(
        (await api("/records/" + root + "/comments")).data.total,
        before,
      );
    });
    await t.test(
      "deleting a parent cascades with exact group restore, not older deleted children",
      async () => {
        oldDeleted = (await create("更早被删除的子任务", { parent_id: root }))
          .data.id;
        let r = (await api("/state")).data.records.find(
          (r) => r.id === oldDeleted,
        );
        await api(
          "/records/" + r.id,
          "DELETE",
          { version: r.version },
          bob.cookie,
        );
        let state = (await api("/state")).data;
        r = state.records.find((r) => r.id === root);
        const result = await api(
          "/records/" + root,
          "DELETE",
          { version: r.version },
          bob.cookie,
        );
        assert.equal(result.status, 200);
        state = (await api("/state")).data;
        assert.ok(!state.records.some((r) => r.id === root || r.id === child));
        assert.equal((await api("/records/" + root + "/comments")).status, 404);
        const deleted = app.db
          .prepare("SELECT * FROM records WHERE id=?")
          .get(child);
        assert.equal(
          (
            await api(
              "/records/" + child + "/restore",
              "POST",
              { version: deleted.version },
              alice.cookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await api(
              "/records/" + root + "/restore",
              "POST",
              { version: result.data.version },
              alice.cookie,
            )
          ).status,
          200,
        );
        state = (await api("/state")).data;
        assert.ok(state.records.some((r) => r.id === root));
        assert.ok(state.records.some((r) => r.id === child));
        assert.ok(!state.records.some((r) => r.id === oldDeleted));
        assert.equal(
          (await api("/records/" + root + "/comments")).data.total,
          24,
        );
        const restores = (await api("/logs")).data.entries.filter(
          (e) => e.action === "restore-record",
        );
        assert.ok(restores.some((e) => e.entityId === root));
        assert.ok(restores.some((e) => e.entityId === child));
      },
    );
    await t.test(
      "nested depth is bounded without leaving orphan records",
      async () => {
        let parent = root;
        for (let i = 0; i < 7; i++) {
          const next = await create("层级" + i, { parent_id: parent });
          assert.equal(next.status, 201);
          parent = next.data.id;
        }
        assert.equal(
          (await create("超过层级", { parent_id: parent })).status,
          400,
        );
      },
    );
    const originalHistory = JSON.stringify(
      app.db.prepare("SELECT * FROM audit ORDER BY id").all(),
    );
    const expectedTime = app.db
      .prepare(
        "SELECT created FROM audit WHERE action='create-record' AND entity=? ORDER BY id LIMIT 1",
      )
      .get(root).created;
    await app.close();
    app = null;
    const legacy = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
    legacy.exec("ALTER TABLE records DROP COLUMN completed_at");
    legacy.close();
    app = await createApp({ allowUninvitedRegistration: true, dataDir });
    assert.equal(
      app.db.prepare("SELECT completed_at FROM records WHERE id=?").get(root)
        .completed_at,
      expectedTime,
    );
    assert.equal(
      JSON.stringify(app.db.prepare("SELECT * FROM audit ORDER BY id").all()),
      originalHistory,
    );
    await app.close();
    app = await createApp({ allowUninvitedRegistration: true, dataDir });
    assert.equal(
      app.db.prepare("SELECT parent_id FROM records WHERE id=?").get(child)
        .parent_id,
      root,
    );
    assert.equal(
      app.db
        .prepare("SELECT COUNT(*) AS n FROM task_comments WHERE deleted=0")
        .get().n,
      24,
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("cross-project totals count leaf work once and assign undated completed work to Beijing month", () => {
  const projects = [
    { id: "a", name: "示例项目" },
    { id: "b", name: "运维" },
  ];
  const records = [
    {
      id: "root",
      project_id: "a",
      task: "父任务",
      owner: "胡示例三",
      actual: "胡示例三",
      date: "2026-10-01",
      child_count: 2,
    },
    {
      id: "c1",
      parent_id: "root",
      project_id: "a",
      task: "子任务",
      owner: "韩示例二",
      actual: "韩示例二、胡示例三",
      date: "",
      completed_at: "2026-09-30T16:05:00.000Z",
    },
    {
      id: "c2",
      parent_id: "root",
      project_id: "a",
      task: "待办",
      owner: "胡示例三",
      actual: "",
      date: "",
    },
    {
      id: "other",
      project_id: "b",
      task: "其他项目",
      owner: "胡示例三",
      actual: "胡示例三",
      date: "2026-10-02",
    },
  ];
  assert.equal(statistics(records).total, 2);
  assert.equal(statistics(records).pending, 1);
  assert.equal(recordMonth(records[1]), "2026-10");
  assert.equal(recordMonth({ ...records[1], date: "2026-09-30" }), "2026-09");
  const people = peopleOverview(projects, records),
    hu = people.find((p) => p.name === "胡示例三");
  assert.equal(hu.done, 2);
  assert.equal(hu.pending, 1);
  assert.equal(hu.joint, 1);
  assert.equal(hu.helped, 1);
  assert.equal(hu.projects.length, 2);
  assert.equal(hu.related.length, 3);
  const october = filterRecords(records, { month: "2026-10" });
  assert.ok(october.some((r) => r.id === "c1"));
  assert.equal(statistics(october).total, 2);
  const tree = taskTree(records, filterRecords(records, { keyword: "子任务" }));
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, "root");
  assert.equal(tree.children.get("root")[0].id, "c1");
  assert.equal(tree.matched.has("root"), false);
});
