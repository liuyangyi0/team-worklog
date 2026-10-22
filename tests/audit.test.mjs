import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES, registrationName } from "../registration.mjs";
import { logChanges } from "../src/logs.js";
const expected = [
  "杨示例一",
  "韩示例二",
  "胡示例三",
  "胡示例四",
  "寇示例五",
  "李示例六",
  "刘示例七",
  "刘示例八",
  "牛示例九",
  "乔示例十",
  "尚示例十一",
  "宋示例十二",
  "唐示例十三",
  "王示例十四",
  "王示例十五",
  "王示例十六",
  "王示例十七",
  "魏示例十八",
  "向示例十九",
  "杨示例二十",
  "易示例二十一",
  "尤示例二十二",
];
test("exact 22-person registration list; invalid names have the required message", () => {
  assert.deepEqual(REGISTRATION_NAMES, expected);
  for (const name of expected) {
    assert.equal(registrationName(name), name);
    assert.equal(registrationName(" " + name + " "), name);
  }
  for (const name of [
    "",
    null,
    42,
    [],
    {},
    "张三",
    "杨晨",
    "杨示例一A",
    "宋示例十二:",
    "胡 牧",
    "胡示例三、韩示例二",
    "韩示例二\n胡示例三",
  ])
    assert.throws(
      () => registrationName(name),
      (e) => e.status === 400 && e.message === "请填写真实姓名",
    );
});
test("registration gate, public immutable history and complete edit audit", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worklog-audit-"));
  const app = await createApp({ allowUninvitedRegistration: true, dataDir: dir, origin: "https://worklog.example.com" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const root = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
  async function api(route, method = "GET", body, cookie = "") {
    const res = await fetch(root + route, {
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
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  }
  try {
    let alice, bob, pid, rid;
    await t.test(
      "invalid signup creates no account or session and shows exact message",
      async () => {
        for (const name of ["不在名单内", "胡 牧", ""]) {
          const result = await api("/register", "POST", {
            login: "invalid",
            name,
            password: "Test-password-3456",
          });
          assert.equal(result.status, 400);
          assert.equal(result.data.error, "请填写真实姓名");
          assert.equal(result.cookie, undefined);
        }
        assert.equal(
          app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
          0,
        );
        alice = await api("/register", "POST", {
          login: "alice",
          name: "胡示例三",
          password: "Test-password-3456",
        });
        bob = await api("/register", "POST", {
          login: "bob",
          name: "韩示例二",
          password: "Test-password-3456",
        });
        assert.equal(alice.status, 201);
        assert.equal(bob.status, 201);
      },
    );
    await t.test(
      "every content operation adds an actor and before/after snapshot",
      async () => {
        const p = await api(
          "/projects",
          "POST",
          { name: "审计项目", color: "sky", members: ["胡示例三", "韩示例二"] },
          alice.cookie,
        );
        assert.equal(p.status, 201);
        pid = p.data.id;
        const r = await api(
          "/records",
          "POST",
          {
            project_id: pid,
            task: "日志原始内容",
            owner: "胡示例三",
            actual: "韩示例二",
          },
          alice.cookie,
        );
        assert.equal(r.status, 201);
        rid = r.data.id;
        assert.equal(
          (
            await api(
              "/records/" + rid,
              "PATCH",
              {
                task: "由韩示例二修改",
                owner: "胡示例三",
                actual: "胡示例三、韩示例二",
                date: "2026-10-15",
                version: 1,
              },
              bob.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await api("/records/" + rid, "DELETE", { version: 2 }, bob.cookie))
            .status,
          200,
        );
        assert.equal(
          (
            await api(
              "/records/" + rid + "/restore",
              "POST",
              { version: 3 },
              alice.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await api(
              "/projects/" + pid,
              "PATCH",
              {
                name: "改名后的项目",
                members: ["胡示例三", "韩示例二", "尤示例二十二"],
                version: 1,
              },
              bob.cookie,
            )
          ).status,
          200,
        );
        const history = await api("/logs?project=" + pid);
        assert.equal(history.status, 200);
        assert.equal(history.data.total, 6);
        assert.deepEqual(
          history.data.entries.map((e) => e.action),
          [
            "update-project",
            "restore-record",
            "delete-record",
            "update-record",
            "create-record",
            "create-project",
          ],
        );
        const update = history.data.entries.find(
          (e) => e.action === "update-record",
        );
        assert.equal(update.actor, "韩示例二");
        assert.equal(update.before.task, "日志原始内容");
        assert.equal(update.after.task, "由韩示例二修改");
        assert.equal(update.after.actual, "胡示例三、韩示例二");
        assert.equal(update.projectName, "审计项目");
        assert.ok(Date.parse(update.created));
        const restore = history.data.entries.find(
          (e) => e.action === "restore-record",
        );
        assert.equal(restore.actor, "胡示例三");
        assert.equal(restore.after.task, "由韩示例二修改");
        assert.ok(logChanges(restore).length >= 4);
        const settings = history.data.entries[0];
        assert.equal(settings.before.name, "审计项目");
        assert.equal(settings.after.name, "改名后的项目");
        assert.deepEqual(settings.after.members, ["胡示例三", "韩示例二", "尤示例二十二"]);
      },
    );
    await t.test(
      "logs survive record deletion and preserve original operation identity",
      async () => {
        assert.equal(
          (await api("/records/" + rid, "DELETE", { version: 4 }, bob.cookie))
            .status,
          200,
        );
        assert.equal((await api("/state")).data.records.length, 0);
        const logs = (await api("/logs?project=" + pid)).data;
        assert.equal(logs.total, 7);
        assert.ok(logs.entries.some((e) => e.before?.task === "由韩示例二修改"));
        const actor = app.db
          .prepare("SELECT id FROM users WHERE login=?")
          .get("bob");
        app.db
          .prepare("UPDATE users SET name=? WHERE id=?")
          .run("尤示例二十二", actor.id);
        assert.equal(
          (await api("/logs?project=" + pid)).data.entries[0].actor,
          "韩示例二",
        );
      },
    );
    await t.test(
      "no public data leaks login/password/session/internal snapshots",
      async () => {
        const text = JSON.stringify((await api("/logs")).data);
        assert.equal(text.includes("Test-password-3456"), false);
        assert.equal(text.includes("password"), false);
        assert.equal(text.includes("creator"), false);
        assert.equal(text.includes("alice"), false);
        assert.equal(text.includes("actor_name"), false);
      },
    );
    await t.test(
      "anonymous and registered users see the same logs; append-only API blocks all writes",
      async () => {
        assert.deepEqual(
          (await api("/logs")).data,
          (await api("/logs", "GET", undefined, alice.cookie)).data,
        );
        const count = (await api("/logs")).data.total;
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
          for (const url of ["/logs", "/logs/1"]) {
            const res = await api(url, method, {}, alice.cookie);
            assert.equal(res.status, 405);
            assert.equal(res.data.error, "操作日志不可修改或删除");
          }
        assert.equal((await api("/logs")).data.total, count);
      },
    );
    await t.test(
      "database triggers reject updates, deletions and replacement while allowing append",
      async () => {
        const row = app.db
          .prepare("SELECT * FROM audit ORDER BY id LIMIT 1")
          .get();
        assert.throws(
          () =>
            app.db
              .prepare("UPDATE audit SET actor_name=? WHERE id=?")
              .run("伪造", row.id),
          /append-only/,
        );
        assert.throws(
          () => app.db.prepare("DELETE FROM audit WHERE id=?").run(row.id),
          /append-only/,
        );
        assert.throws(
          () =>
            app.db
              .prepare("INSERT OR REPLACE INTO audit(id,action) VALUES(?,?)")
              .run(row.id, "fake"),
          /append-only/,
        );
        assert.deepEqual(
          app.db.prepare("SELECT * FROM audit WHERE id=?").get(row.id),
          row,
        );
        assert.equal(
          (await api("/projects", "POST", { name: "另一项目" }, alice.cookie))
            .status,
          201,
        );
      },
    );
    await t.test(
      "public history pagination, project isolation and invalid query validation",
      async () => {
        const first = (await api("/logs?limit=2")).data;
        assert.equal(first.entries.length, 2);
        assert.ok(first.nextCursor);
        const all = [...first.entries];
        let cursor = first.nextCursor;
        while (cursor) {
          const next = (await api("/logs?limit=2&before=" + cursor)).data;
          all.push(...next.entries);
          cursor = next.nextCursor;
        }
        assert.equal(new Set(all.map((e) => e.id)).size, all.length);
        assert.equal(all.length, first.total);
        assert.deepEqual(
          all.map((e) => e.id),
          [...all.map((e) => e.id)].sort((a, b) => b - a),
        );
        assert.ok(
          (await api("/logs?project=" + pid)).data.entries.every(
            (e) => e.projectId === pid,
          ),
        );
        assert.equal((await api("/logs?project=missing")).data.total, 0);
        for (const query of [
          "limit=0",
          "limit=101",
          "limit=abc",
          "before=-1",
          "before=NaN",
          "before=9007199254740992",
          "project=a%27%20OR%201%3D1",
        ])
          assert.equal((await api("/logs?" + query)).status, 400);
      },
    );
    await t.test(
      "failed log append rolls back the associated content change",
      async () => {
        app.db.exec(
          "CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test append failure'); END;",
        );
        const before = (await api("/state")).data.projects.find(
            (p) => p.id === pid,
          ),
          logs = (await api("/logs")).data.total;
        assert.equal(
          (
            await api(
              "/projects/" + pid,
              "PATCH",
              { name: "不可丢失日志的修改", version: before.version },
              alice.cookie,
            )
          ).status,
          500,
        );
        assert.equal(
          (await api("/state")).data.projects.find((p) => p.id === pid).name,
          before.name,
        );
        assert.equal((await api("/logs")).data.total, logs);
        app.db.exec("DROP TRIGGER test_audit_failure");
      },
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("legacy logs migrate without rewriting original history; protection remains after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worklog-old-audit-"));
  const old = new DatabaseSync(path.join(dir, "worklog.sqlite"));
  old.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,login TEXT UNIQUE COLLATE NOCASE,name TEXT,password TEXT,role TEXT,created TEXT);CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,creator TEXT,version INTEGER,created TEXT);CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,owner TEXT,actual TEXT,date TEXT,creator TEXT,created TEXT,updated TEXT,version INTEGER,deleted INTEGER);CREATE TABLE audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity TEXT,before_json TEXT,after_json TEXT,created TEXT);",
  );
  old
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,?)")
    .run("u", "legacy", "胡示例三", "not-a-real-password", "member", "2026-10-01");
  old
    .prepare("INSERT INTO projects VALUES(?,?,?,?,?)")
    .run("p", "旧项目", "u", 1, "2026-10-01");
  old
    .prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "r",
      "p",
      "旧记录",
      "胡示例三",
      "韩示例二",
      "",
      "u",
      "2026-10-01",
      "2026-10-01",
      1,
      0,
    );
  old
    .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?)")
    .run(
      41,
      "u",
      "create-record",
      "r",
      "null",
      JSON.stringify({
        task: "旧记录",
        owner: "胡示例三",
        actual: "韩示例二",
        date: "",
      }),
      "2026-10-01T00:00:00.000Z",
    );
  const original = old.prepare("SELECT * FROM audit").get();
  old.close();
  let app;
  try {
    app = await createApp({ allowUninvitedRegistration: true, dataDir: dir });
    const legacy = app.db.prepare("SELECT * FROM audit").get();
    for (const k of Object.keys(original)) assert.equal(legacy[k], original[k]);
    assert.equal(legacy.actor_name, "胡示例三");
    assert.equal(legacy.project_id, "p");
    assert.equal(legacy.project_name, "旧项目");
    app.db.close();
    app = await createApp({ allowUninvitedRegistration: true, dataDir: dir });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 1);
    assert.throws(() => app.db.exec("DELETE FROM audit"), /append-only/);
  } finally {
    app?.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
