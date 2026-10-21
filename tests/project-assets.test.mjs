import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResources, installResourceSchema } from "../resources.mjs";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";

const alice = { id: "a", name: "成员甲", login: "alice" },
  bob = { id: "b", name: "成员乙", login: "bob" };
const status = (n) => (e) => e.status === n;
function fixture(legacy = false) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-project-assets-"),
  );
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','软件项目'),('p2','设备项目');",
  );
  if (legacy) {
    installResourceSchema(db);
    db.prepare(
      "INSERT INTO resources(id,project_id,project_ids,name,type,model,serial_number,location,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "old",
      "p1",
      '["p1"]',
      "旧主机",
      "host",
      "型号A",
      "SN-test",
      "机柜1",
      "2026-01-01",
      "2026-01-01",
    );
  }
  const service = createResources({ db, dataDir });
  return {
    db,
    dataDir,
    api: (
      route,
      method = "GET",
      b = {},
      user = alice,
      params = new URLSearchParams(),
    ) => service.api({ route, method, b, user, params }),
    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
const field = (key, type = "text", options = []) => ({
  key,
  label: key,
  type,
  required: false,
  options,
  archived: false,
});

test("asset categories: legacy data migrates without losing physical properties; repeated startup is safe", async () => {
  const f = fixture(true);
  try {
    let r = (await f.api("/resources/old")).data.resource;
    assert.equal(r.category.name, "服务器 / 主机");
    assert.equal(r.field_values.model, "型号A");
    assert.equal(r.field_values.serial_number, "SN-test");
    const c = (await f.api("/projects/p1/resource-categories")).data.categories;
    assert.equal(c.length, 6);
    assert.equal(
      c.find((x) => x.base_type === "application").family,
      "software",
    );
    createResources({ db: f.db, dataDir: f.dataDir });
    assert.equal(
      (await f.api("/projects/p1/resource-categories")).data.categories.length,
      6,
    );
    r = (
      await f.api("/resources/old", "PATCH", {
        version: 1,
        category_version: r.category.version,
        field_values: {
          model: "型号B",
          serial_number: "SN-test",
          location: "新机房",
        },
      })
    ).data.resource;
    assert.equal(r.model, "型号B");
    assert.equal(r.location, "新机房");
    assert.equal(
      f.db.prepare("SELECT model FROM resources WHERE id='old'").get().model,
      "型号B",
    );
    f.db.exec("INSERT INTO projects VALUES('p3','新项目')");
    assert.equal(
      (await f.api("/projects/p3/resources")).data.categories.length,
      6,
    );
  } finally {
    f.close();
  }
});

test("asset categories: dynamic types, required fields, malicious keys and stale form protection", async () => {
  const f = fixture();
  try {
    const fields = [
      { ...field("asset_no"), required: true },
      field("count", "number"),
      field("purchased", "date"),
      field("enabled", "boolean"),
      field("vendor", "select", ["厂家甲", "厂家乙"]),
      field("memo", "textarea"),
    ];
    let c = (
      await f.api("/projects/p1/resource-categories", "POST", {
        name: "定制机柜",
        family: "hardware",
        base_type: "device",
        fields,
      })
    ).data.category;
    for (const values of [
      {},
      { asset_no: "x", count: "12" },
      { asset_no: "x", enabled: "false" },
      { asset_no: "x", purchased: "2026-02-30" },
      { asset_no: "x", vendor: "未知" },
      { asset_no: "x", extra: "unknown" },
    ])
      await assert.rejects(
        f.api("/projects/p1/resources", "POST", {
          name: "设备",
          category_id: c.id,
          field_values: values,
        }),
        status(400),
      );
    for (const key of ["constructor", "__proto__", "bad-key"])
      await assert.rejects(
        f.api("/projects/p1/resource-categories", "POST", {
          name: "无效" + key,
          fields: [field(key)],
        }),
        status(400),
      );
    const r = (
      await f.api("/projects/p1/resources", "POST", {
        name: "机柜1",
        category_id: c.id,
        category_version: c.version,
        field_values: {
          asset_no: "A-001",
          count: 0,
          enabled: false,
          purchased: "2026-10-21",
          vendor: "厂家甲",
          memo: "仅用于验证的备注",
        },
      })
    ).data.resource;
    assert.equal(r.type, "device");
    assert.equal(r.field_values.count, 0);
    assert.equal(r.field_values.enabled, false);
    await assert.rejects(
      f.api("/projects/p2/resources", "POST", {
        name: "跨项目分类",
        category_id: c.id,
      }),
      status(400),
    );
    c = (
      await f.api("/resource-categories/" + c.id, "PATCH", {
        version: c.version,
        name: "机柜资产",
        fields,
      })
    ).data.category;
    await assert.rejects(
      f.api("/resources/" + r.id, "PATCH", {
        version: r.version,
        category_id: c.id,
        category_version: 1,
        field_values: r.field_values,
      }),
      status(409),
    );
    await assert.rejects(
      f.api("/resource-categories/" + c.id, "PATCH", {
        version: 1,
        name: "覆盖",
      }),
      status(409),
    );
    assert.equal(
      (await f.api("/resources/" + r.id)).data.resource.category.name,
      "机柜资产",
    );
    const logs = JSON.stringify(
      f.db.prepare("SELECT * FROM resource_events").all(),
    );
    assert.ok(!logs.includes("仅用于验证的备注"));
    assert.ok(logs.includes("create-category"));
  } finally {
    f.close();
  }
});

test("asset categories: archive preserves values, switching retains history and shared edits use the origin schema", async () => {
  const f = fixture();
  try {
    let c = (
      await f.api("/projects/p1/resource-categories", "POST", {
        name: "网络设备",
        family: "hardware",
        base_type: "device",
        fields: [field("rack"), field("vendor", "select", ["甲", "乙"])],
      })
    ).data.category;
    let r = (
      await f.api("/projects/p1/resources", "POST", {
        name: "共享设备",
        category_id: c.id,
        project_ids: ["p1", "p2"],
        field_values: { rack: "机柜9", vendor: "甲" },
      })
    ).data.resource;
    await assert.rejects(
      f.api("/resource-categories/" + c.id, "PATCH", {
        version: c.version,
        fields: [field("rack")],
      }),
      status(409),
    );
    await assert.rejects(
      f.api("/resource-categories/" + c.id, "PATCH", {
        version: c.version,
        fields: [
          field("rack", "number"),
          field("vendor", "select", ["甲", "乙"]),
        ],
      }),
      status(409),
    );
    await assert.rejects(
      f.api("/resource-categories/" + c.id, "PATCH", {
        version: c.version,
        fields: [field("rack"), field("vendor", "select", ["乙"])],
      }),
      status(409),
    );
    c = (
      await f.api("/resource-categories/" + c.id, "PATCH", {
        version: c.version,
        archived: true,
        fields: [
          { ...field("rack"), archived: true },
          field("vendor", "select", ["甲", "乙"]),
        ],
      })
    ).data.category;
    await assert.rejects(
      f.api("/projects/p1/resources", "POST", {
        name: "停用分类新记录",
        category_id: c.id,
      }),
      status(400),
    );
    r = (
      await f.api(
        "/resources/" + r.id,
        "PATCH",
        { version: r.version, description: "成员乙修改" },
        bob,
      )
    ).data.resource;
    assert.equal(r.field_values.rack, "机柜9");
    const shared = (await f.api("/projects/p2/resources")).data.resources[0];
    assert.equal(shared.category.id, c.id);
    r = (
      await f.api("/resources/" + r.id, "PATCH", {
        version: r.version,
        category_id: "builtin-p1-application",
        field_values: { software_version: "2.0" },
      })
    ).data.resource;
    assert.equal(r.field_values.rack, "机柜9");
    assert.equal(r.software_version, "2.0");
    const raw = f.db
      .prepare("SELECT field_values_json FROM resources WHERE id=?")
      .get(r.id);
    assert.ok(raw.field_values_json.includes("机柜9"));
  } finally {
    f.close();
  }
});

test("project deployments: multi-site lifecycle, references, optimistic updates and immutable member audit", async () => {
  const f = fixture();
  try {
    const env = (
      await f.api("/projects/p1/environments", "POST", { name: "正式环境" })
    ).data.id;
    const otherEnv = (
      await f.api("/projects/p2/environments", "POST", { name: "外部环境" })
    ).data.id;
    const r = (
      await f.api("/projects/p1/resources", "POST", {
        name: "应用服务器",
        type: "host",
        project_ids: ["p1", "p2"],
      })
    ).data.resource;
    for (const invalid of [
      { environment_id: otherEnv },
      { resource_ids: ["missing"] },
      { deployed_at: "2026-02-30" },
      { status: "wrong" },
      { method: "wrong" },
    ])
      await assert.rejects(
        f.api("/projects/p1/deployments", "POST", { name: "测试", ...invalid }),
        status(400),
      );
    let d = (
      await f.api("/projects/p1/deployments", "POST", {
        name: "客户A现场",
        site: "测试单位",
        location: "A栋机房",
        status: "live",
        environment_id: env,
        resource_ids: [r.id],
        deployed_at: "2026-10-21",
        deployed_version: "1.2",
        entry_url: "https://service.example.invalid",
      })
    ).data.deployment;
    assert.equal(d.environment_name, "正式环境");
    assert.equal(d.location, "A栋机房");
    await f.api("/projects/p1/deployments", "POST", {
      name: "客户B现场",
      method: "cloud",
      location: "演示地域",
    });
    assert.equal(
      (await f.api("/projects/p1/deployments")).data.deployments.length,
      2,
    );
    assert.equal(
      (await f.api("/projects/p2/deployments")).data.deployments.length,
      0,
    );
    d = (
      await f.api(
        "/deployments/" + d.id,
        "PATCH",
        { version: d.version, deployed_version: "1.3" },
        bob,
      )
    ).data.deployment;
    assert.equal(d.location, "A栋机房");
    assert.equal(d.deployed_version, "1.3");
    await assert.rejects(
      f.api("/deployments/" + d.id, "PATCH", { version: 1, name: "覆盖" }),
      status(409),
    );
    await assert.rejects(
      f.api("/environments/" + env, "DELETE", { version: 1 }),
      status(409),
    );
    // A project cannot unlink a resource still used by one of its deployments.
    const p2 = (
      await f.api("/projects/p2/deployments", "POST", {
        name: "同一资源的其他现场",
        resource_ids: [r.id],
      })
    ).data.deployment;
    await assert.rejects(
      f.api("/resources/" + r.id, "PATCH", {
        version: r.version,
        project_ids: ["p1"],
      }),
      status(409),
    );
    await f.api("/deployments/" + p2.id, "DELETE", { version: p2.version });
    await f.api("/resources/" + r.id, "PATCH", {
      version: r.version,
      project_ids: ["p1"],
    });
    await assert.rejects(
      f.api("/resources/" + r.id, "DELETE", { version: 2 }),
      status(409),
    );
    await assert.rejects(
      f.api("/deployments/" + p2.id + "/restore", "POST", { version: 2 }),
      status(409),
    );
    await f.api("/resources/" + r.id, "PATCH", {
      version: 2,
      project_ids: ["p1", "p2"],
    });
    await f.api("/deployments/" + p2.id + "/restore", "POST", { version: 2 });
    await f.api("/deployments/" + d.id, "DELETE", { version: d.version }, bob);
    const trash = (
      await f.api(
        "/projects/p1/deployments",
        "GET",
        {},
        alice,
        new URLSearchParams("deleted=1"),
      )
    ).data.deployments;
    assert.equal(trash[0].id, d.id);
    assert.equal(trash[0].deleted, 1);
    await f.api("/deployments/" + d.id + "/restore", "POST", {
      version: d.version + 1,
    });
    assert.equal(
      (await f.api("/deployments/" + d.id)).data.deployment.deployed_version,
      "1.3",
    );
    const logs = f.db
      .prepare("SELECT * FROM resource_events WHERE entity_type='deployment'")
      .all();
    assert.ok(logs.some((l) => l.actor_id === bob.id));
    assert.ok(!JSON.stringify(logs).includes("A栋机房"));
    assert.throws(() => f.db.exec("DELETE FROM resource_events"));
  } finally {
    f.close();
  }
});

test("asset HTTP routes: guests blocked, registered members can edit, public state and logs contain no internal data", async () => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-assets-http-"),
  );
  let app;
  try {
    const origin = "http://127.0.0.1:8789";
    app = await createApp({ dataDir, origin });
    await new Promise((r) => app.server.listen(8789, "127.0.0.1", r));
    const api = async (route, method = "GET", body, cookie = "") => {
      const res = await fetch(origin + "/worklog/api" + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        data: await res.json(),
        cookie: res.headers.get("set-cookie")?.split(";")[0],
      };
    };
    const reg = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "assets_http",
      password: "Temporary-assets-test-123",
    });
    assert.equal(reg.status, 201);
    const project = (await api("/state")).data.projects[0];
    for (const route of [
      "/projects/" + project.id + "/resource-categories",
      "/projects/" + project.id + "/deployments",
    ])
      assert.equal((await api(route)).status, 401);
    const cat = await api(
      "/projects/" + project.id + "/resource-categories",
      "POST",
      { name: "内部分类Fixture", fields: [field("code")] },
      reg.cookie,
    );
    assert.equal(cat.status, 201);
    const deployment = await api(
      "/projects/" + project.id + "/deployments",
      "POST",
      { name: "内部现场Fixture", location: "内部地址Fixture" },
      reg.cookie,
    );
    assert.equal(deployment.status, 201);
    assert.equal(
      (
        await api("/resource-categories/" + cat.data.category.id, "PATCH", {
          version: 1,
          name: "改名",
        })
      ).status,
      401,
    );
    assert.equal(
      (await api("/deployments/" + deployment.data.deployment.id)).status,
      401,
    );
    const publicData = JSON.stringify([
      (await api("/state")).data,
      (await api("/logs")).data,
    ]);
    assert.ok(!publicData.includes("内部分类Fixture"));
    assert.ok(!publicData.includes("内部地址Fixture"));
  } finally {
    if (app) {
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("asset mutations: failed audit rolls back category and deployment changes", async () => {
  const f = fixture();
  try {
    const c = (
      await f.api("/projects/p1/resource-categories", "POST", {
        name: "回滚分类",
        fields: [],
      })
    ).data.category;
    const d = (
      await f.api("/projects/p1/deployments", "POST", { name: "回滚部署" })
    ).data.deployment;
    f.db.exec(
      "CREATE TRIGGER reject_asset_event BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'fixture-audit-failure'); END;",
    );
    await assert.rejects(
      f.api("/resource-categories/" + c.id, "PATCH", {
        version: 1,
        name: "不应保留",
      }),
    );
    await assert.rejects(
      f.api("/deployments/" + d.id, "PATCH", {
        version: 1,
        location: "不应保留",
      }),
    );
    assert.equal(
      (await f.api("/projects/p1/resource-categories")).data.categories.find(
        (x) => x.id === c.id,
      ).name,
      "回滚分类",
    );
    assert.equal(
      (await f.api("/deployments/" + d.id)).data.deployment.location,
      "",
    );
    assert.equal(
      (await f.api("/deployments/" + d.id)).data.deployment.version,
      1,
    );
  } finally {
    f.close();
  }
});
