import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.mjs";
import { createResources } from "../resources.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";

async function httpFixture() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-review-auth-"),
  );
  const origin = "http://127.0.0.1";
  const app = await createApp({ dataDir, origin });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/worklog/api`;
  async function api(route, method = "GET", body, cookie = "") {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "X-Worklog-Request": "1",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  return {
    app,
    api,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("review: simultaneous login-password changes cannot overwrite each other or invalidate the winner", async () => {
  const f = await httpFixture();
  try {
    const original = await f.api("/register", "POST", {
      login: "concurrent_password",
      name: REGISTRATION_NAMES[0],
      password: "Original-test-123",
    });
    assert.equal(original.status, 201);
    const next = ["New-first-test-123", "New-second-test-123"];
    const changes = await Promise.all(
      next.map((password) =>
        f.api(
          "/password",
          "POST",
          { oldPassword: "Original-test-123", password },
          original.cookie,
        ),
      ),
    );
    assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409]);
    const winner = changes.findIndex((r) => r.status === 200);
    assert.ok(
      (await f.api("/state", "GET", undefined, changes[winner].cookie)).data
        .user,
    );
    assert.equal(
      (await f.api("/state", "GET", undefined, original.cookie)).data.user,
      null,
    );
    assert.equal(
      (
        await f.api("/login", "POST", {
          login: "concurrent_password",
          password: next[winner],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api("/login", "POST", {
          login: "concurrent_password",
          password: next[1 - winner],
        })
      ).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("review: login cannot issue a new session using a password changed during verification", async () => {
  const f = await httpFixture();
  try {
    await f.api("/register", "POST", {
      login: "login_race",
      name: REGISTRATION_NAMES[0],
      password: "Original-test-123",
    });
    await f.api("/register", "POST", {
      login: "replacement_hash",
      name: REGISTRATION_NAMES[1],
      password: "Replacement-test-456",
    });
    const prepare = f.app.db.prepare.bind(f.app.db);
    const replacement = prepare(
      "SELECT password FROM users WHERE login='replacement_hash'",
    ).get().password;
    let armed = true,
      changed = false;
    // Change the stored hash after login reads it but before async scrypt returns.
    f.app.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "SELECT * FROM users WHERE login=?" && armed)
        return {
          get(...args) {
            const user = statement.get(...args);
            if (args[0] === "login_race") {
              armed = false;
              queueMicrotask(() => {
                prepare("UPDATE users SET password=? WHERE id=?").run(
                  replacement,
                  user.id,
                );
                prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
                changed = true;
              });
            }
            return user;
          },
        };
      return statement;
    };
    const login = await f.api("/login", "POST", {
      login: "login_race",
      password: "Original-test-123",
    });
    assert.ok(changed);
    assert.equal(login.status, 401);
    assert.equal(login.cookie, "");
    assert.equal(
      (
        await f.api("/login", "POST", {
          login: "login_race",
          password: "Replacement-test-456",
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("review: unsharing a resource cannot strand another resource's incoming relation", async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-review-relations-"),
  );
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','one'),('p2','two');",
  );
  const service = createResources({ db, dataDir });
  const user = { id: "test-user", name: "审查成员", login: "review" };
  const api = async (route, method = "GET", b = {}) =>
    service.api({ route, method, b, user });
  try {
    const target = (
      await api("/projects/p1/resources", "POST", {
        name: "共享主机",
        type: "host",
        project_ids: ["p1", "p2"],
      })
    ).data.resource;
    let source = (
      await api("/projects/p2/resources", "POST", {
        name: "关联应用",
        type: "application",
        relations: [{ target_id: target.id, type: "runs_on" }],
      })
    ).data.resource;
    await assert.rejects(
      api("/resources/" + target.id, "PATCH", {
        version: target.version,
        project_ids: ["p1"],
      }),
      (e) => e.status === 409,
    );
    assert.deepEqual(
      (await api("/resources/" + target.id)).data.resource.project_ids,
      ["p1", "p2"],
    );
    source = (
      await api("/resources/" + source.id, "PATCH", {
        version: source.version,
        description: "普通修改仍然有效",
        project_ids: ["p1", "p2"],
      })
    ).data.resource;
    await api("/resources/" + target.id, "PATCH", {
      version: target.version,
      project_ids: ["p1"],
    });
    assert.equal(
      (
        await api("/resources/" + source.id, "PATCH", {
          version: source.version,
          name: "仍有公共项目",
        })
      ).data.resource.name,
      "仍有公共项目",
    );
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("review: recycle restoration cannot recreate invalid project-resource associations", async (t) => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-review-restore-"),
  );
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','one'),('p2','two');",
  );
  const service = createResources({ db, dataDir });
  const user = { id: "test-user", name: "审查成员", login: "review" };
  const api = async (route, method = "GET", b = {}) =>
    service.api({ route, method, b, user });
  try {
    for (const entity of ["credentials", "configurations", "resources"])
      await t.test(entity, async () => {
        const target = (
          await api("/projects/p1/resources", "POST", {
            name: "共享依赖-" + entity,
            type: "host",
            project_ids: ["p1", "p2"],
          })
        ).data.resource;
        const payload =
          entity === "resources"
            ? {
                name: "关联应用",
                relations: [{ target_id: target.id, type: "runs_on" }],
              }
            : entity === "credentials"
              ? {
                  title: "关联账号",
                  resource_id: target.id,
                  secret: "Synthetic-secret-only",
                }
              : {
                  name: "关联配置",
                  resource_id: target.id,
                  content: "fixture=true",
                };
        const response = (await api("/projects/p2/" + entity, "POST", payload))
          .data;
        const entry =
          response.resource || response.credential || response.configuration;
        await api("/" + entity + "/" + entry.id, "DELETE", {
          version: entry.version,
        });
        await api("/resources/" + target.id, "PATCH", {
          version: target.version,
          project_ids: ["p1"],
        });
        await assert.rejects(
          api("/" + entity + "/" + entry.id + "/restore", "POST", {
            version: 2,
          }),
          (e) => e.status === 409,
        );
        const untouched = db
          .prepare(`SELECT deleted,version FROM ${entity} WHERE id=?`)
          .get(entry.id);
        assert.equal(untouched.deleted, 1);
        assert.equal(untouched.version, 2);
        await api("/resources/" + target.id, "PATCH", {
          version: 2,
          project_ids: ["p1", "p2"],
        });
        await api("/" + entity + "/" + entry.id + "/restore", "POST", {
          version: 2,
        });
        const changed = (
          await api("/" + entity + "/" + entry.id, "PATCH", {
            version: 3,
            [entity === "credentials" ? "title" : "name"]: "恢复后可编辑",
          })
        ).data;
        assert.equal(
          (changed.resource || changed.credential || changed.configuration)[
            entity === "credentials" ? "title" : "name"
          ],
          "恢复后可编辑",
        );
      });
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
