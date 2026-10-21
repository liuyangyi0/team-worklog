import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../server.mjs";
import { dependencyInfo, isCompleted, filterRecords } from "../src/model.js";
import { installDependencySchema } from "../dependencies.mjs";
test("dependencies, blocking, assistance, notifications and immutable audit", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "worklog-dependencies-"),
  );
  let app;
  try {
    app = await createApp({ dataDir, origin: "https://worklog.example.com" });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    let base = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
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
        login: "dep_alice",
        password: "Temporary-test-123",
      }),
      bob = await api("/register", "POST", {
        name: "韩示例二",
        login: "dep_bob",
        password: "Temporary-test-123",
      });
    const project = (await api("/state")).data.projects[0].id,
      second = (
        await api("/projects", "POST", { name: "配套采购" }, alice.cookie)
      ).data.id;
    const create = async (task, extra = {}) =>
      api(
        "/records",
        "POST",
        {
          project_id: project,
          task,
          owner: "胡示例三",
          actual: "",
          date: "",
          ...extra,
        },
        alice.cookie,
      );
    const state = async () => (await api("/state")).data;
    const read = async (id) => (await state()).records.find((r) => r.id === id);
    const update = async (id, extra = {}, cookie = alice.cookie) =>
      api("/records/" + id, "PATCH", { ...(await read(id)), ...extra }, cookie);
    let first, other, work;
    await t.test(
      "public dependency names, cross-project multi-select and helper requests",
      async () => {
        first = (
          await create("设备到货", { project_id: second, owner: "韩示例二" })
        ).data.id;
        other = (await create("接口就绪", { owner: "韩示例二" })).data.id;
        const created = await create("系统联调", {
          dependency_ids: [first, other, first],
          support_people: "韩示例二、韩示例二",
          owner: "胡示例三、韩示例二",
        });
        assert.equal(created.status, 201);
        work = created.data.id;
        const r = await read(work);
        assert.equal(r.dependency_ids.length, 2);
        assert.equal(r.support_people, "韩示例二");
        assert.equal(
          r.dependency_tasks.find((d) => d.id === first).project_name,
          "配套采购",
        );
        assert.equal(dependencyInfo(r).waiting.length, 2);
        assert.equal(dependencyInfo(r).blocked, true);
        assert.ok(
          filterRecords((await state()).records, { blocked: "blocked" }).some(
            (r) => r.id === work,
          ),
        );
        assert.ok(
          filterRecords((await state()).records, { keyword: "配合不存在" })
            .length === 0,
        );
        const notices = (
          await api("/notifications", "GET", undefined, bob.cookie)
        ).data.entries;
        assert.ok(
          notices.some(
            (n) => n.kind === "support-request" && n.record_id === work,
          ),
        );
        assert.equal(
          (
            await api("/records", "POST", {
              project_id: project,
              task: "匿名操作",
              owner: "胡示例三",
              dependency_ids: [first],
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "rejects invalid input and cycles without leaving partial records, audit or notices",
      async () => {
        const count = app.db.prepare("SELECT COUNT(*) n FROM records").get().n,
          logs = app.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
          notes = app.db
            .prepare("SELECT COUNT(*) n FROM notifications")
            .get().n;
        for (const extra of [
          { dependency_ids: ["missing"] },
          { dependency_ids: "wrong" },
          { dependency_ids: Array.from({ length: 51 }, (_, i) => "item-" + i) },
          { blocked: "yes" },
          { blocker_note: "x".repeat(501) },
          { support_people: [] },
        ])
          assert.equal((await create("无效", extra)).status, 400);
        assert.equal(
          app.db.prepare("SELECT COUNT(*) n FROM records").get().n,
          count,
        );
        assert.equal(
          app.db.prepare("SELECT COUNT(*) n FROM audit").get().n,
          logs,
        );
        assert.equal(
          app.db.prepare("SELECT COUNT(*) n FROM notifications").get().n,
          notes,
        );
        assert.equal(
          (await update(work, { dependency_ids: [work] })).status,
          400,
        );
        assert.equal(
          (await update(first, { dependency_ids: [work] })).status,
          400,
        );
        const tail = (await create("部署验收", { dependency_ids: [work] })).data
          .id;
        assert.equal(
          (await update(other, { dependency_ids: [tail] })).status,
          400,
        );
      },
    );
    await t.test(
      "finishing either completion field releases dependencies; reopen blocks again and notifies",
      async () => {
        await update(first, { actual: "韩示例二" });
        assert.equal(dependencyInfo(await read(work)).waiting.length, 1);
        await update(other, { date: "2026-10-16" }, bob.cookie);
        assert.equal(dependencyInfo(await read(work)).blocked, false);
        let notes = (
          await api("/notifications", "GET", undefined, alice.cookie)
        ).data.entries;
        assert.ok(
          notes.some(
            (n) =>
              n.record_id === work &&
              n.title === "前置任务已完成，可以继续推进",
          ),
        );
        await update(other, { actual: "", date: "" }, bob.cookie);
        assert.equal(dependencyInfo(await read(work)).blocked, true);
        notes = (await api("/notifications", "GET", undefined, alice.cookie))
          .data.entries;
        assert.ok(
          notes.some(
            (n) => n.record_id === work && n.title.includes("恢复待办"),
          ),
        );
      },
    );
    await t.test(
      "manual blocker survives dependency completion; helpers do not count as completers",
      async () => {
        await update(work, {
          blocked: true,
          blocker_note: "等现场配合",
          support_people: "韩示例二",
        });
        await update(other, { actual: "韩示例二" });
        const r = await read(work);
        assert.equal(dependencyInfo(r).blocked, true);
        assert.equal(dependencyInfo(r).waiting.length, 0);
        assert.equal(isCompleted(r), false);
        assert.equal(r.actual, "");
        assert.equal(filterRecords([r], { keyword: "等现场配合" }).length, 1);
        await update(work, { blocked: false, blocker_note: "" });
        assert.equal(dependencyInfo(await read(work)).blocked, false);
        // An already completed work item is never shown as blocked, and keeps its optional date blank.
        await update(work, { actual: "胡示例三", blocked: true });
        assert.equal(dependencyInfo(await read(work)).blocked, false);
        assert.equal((await read(work)).date, "");
        await update(work, { actual: "", date: "" });
        assert.equal(dependencyInfo(await read(work)).blocked, true);
        await update(work, { blocked: false });
      },
    );
    await t.test(
      "deleted prerequisites stop blocking; undo reactivates, and deleted graph nodes cannot hide cycles",
      async () => {
        await update(other, { actual: "", date: "" });
        let r = await read(other);
        const deleted = await api(
          "/records/" + other,
          "DELETE",
          { version: r.version },
          alice.cookie,
        );
        assert.equal(deleted.status, 200);
        let workRecord = await read(work);
        assert.equal(dependencyInfo(workRecord).blocked, false);
        assert.equal(
          workRecord.dependency_tasks.find((d) => d.id === other).deleted,
          1,
        );
        assert.equal(
          (await create("不可选已删除任务", { dependency_ids: [other] }))
            .status,
          400,
        );
        assert.equal(
          (await update(work, { task: "联调（保留已删除前置关系）" })).status,
          200,
        );
        const restored = await api(
          "/records/" + other + "/restore",
          "POST",
          { version: deleted.data.version },
          bob.cookie,
        );
        assert.equal(restored.status, 200);
        assert.equal(dependencyInfo(await read(work)).blocked, true);
        r = await read(work);
        const deleteWork = await api(
          "/records/" + work,
          "DELETE",
          { version: r.version },
          alice.cookie,
        );
        assert.equal(deleteWork.status, 200);
        assert.equal(
          (await update(other, { dependency_ids: [work] })).status,
          400,
        ); // adding a deleted target is invalid.
        // Existing A -> work(deleted) -> other still prevents other -> A.
        const tail = (await state()).records.find((r) => r.task === "部署验收");
        assert.equal(
          (await update(other, { dependency_ids: [tail.id] })).status,
          400,
        );
        await api(
          "/records/" + work + "/restore",
          "POST",
          { version: deleteWork.data.version },
          alice.cookie,
        );
      },
    );
    await t.test(
      "legacy edits preserve relations, conflicts protect and public logs keep named snapshots",
      async () => {
        let r = await read(work);
        const {
          dependency_ids,
          blocked,
          blocker_note,
          support_people,
          ...legacy
        } = r;
        assert.equal(
          (
            await api(
              "/records/" + work,
              "PATCH",
              { ...legacy, task: "联调最终检查" },
              bob.cookie,
            )
          ).status,
          200,
        );
        let current = await read(work);
        assert.deepEqual(current.dependency_ids, dependency_ids);
        assert.equal(current.support_people, support_people);
        assert.equal(
          (
            await api(
              "/records/" + work,
              "PATCH",
              { ...r, dependency_ids: [] },
              alice.cookie,
            )
          ).status,
          409,
        );
        assert.deepEqual((await read(work)).dependency_ids, dependency_ids);
        await update(
          work,
          {
            dependency_ids: [first],
            blocked: true,
            blocker_note: "现场暂未就绪",
            support_people: "韩示例二",
          },
          bob.cookie,
        );
        const log = (await api("/logs?limit=100")).data.entries.find(
          (e) =>
            e.entityId === work && e.after?.blocker_note === "现场暂未就绪",
        );
        assert.equal(log.before.dependency_titles.includes("接口就绪"), true);
        assert.equal(log.after.dependency_titles, "配套采购 / 设备到货");
        assert.equal(log.after.blocked, "已标记");
        assert.equal(log.after.support_people, "韩示例二");
        assert.equal(
          (await api("/logs/" + log.id, "DELETE", {}, alice.cookie)).status,
          405,
        );
        const savedJSON = app.db
          .prepare("SELECT after_json FROM audit WHERE id=?")
          .get(log.id).after_json;
        await update(first, { task: "设备全部到货" });
        assert.equal(
          app.db.prepare("SELECT after_json FROM audit WHERE id=?").get(log.id)
            .after_json,
          savedJSON,
        );
      },
    );
    await t.test(
      "audit failure rolls back edges and coordination changes together",
      async () => {
        const before = await read(work),
          notes = app.db
            .prepare("SELECT COUNT(*) n FROM notifications")
            .get().n;
        app.db.exec(
          "CREATE TRIGGER dependency_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'dependency-audit-failure'); END;",
        );
        const failed = await update(work, {
          dependency_ids: [],
          blocked: false,
          support_people: "易示例二十一",
        });
        assert.equal(failed.status, 500);
        app.db.exec("DROP TRIGGER dependency_audit_failure");
        const after = await read(work);
        assert.equal(after.version, before.version);
        assert.deepEqual(after.dependency_ids, before.dependency_ids);
        assert.equal(after.support_people, before.support_people);
        assert.equal(
          app.db.prepare("SELECT COUNT(*) n FROM notifications").get().n,
          notes,
        );
      },
    );
    await t.test(
      "schema is idempotent and relations and blockers survive restart",
      async () => {
        const before = await read(work);
        installDependencySchema(app.db);
        await app.close();
        app = await createApp({ dataDir, origin: "https://worklog.example.com" });
        await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
        base = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
        const after = await read(work);
        assert.deepEqual(after.dependency_ids, before.dependency_ids);
        assert.equal(after.blocker_note, before.blocker_note);
        assert.equal(after.blocked, before.blocked);
      },
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
