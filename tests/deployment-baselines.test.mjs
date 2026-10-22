import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResources } from "../resources.mjs";
import { installDocumentSchema } from "../documents.mjs";

const actor = { id: "alice", name: "测试成员", login: "alice" };
const fails = (status) => (error) => error.status === status;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-baseline-"));
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT); INSERT INTO users VALUES('alice','测试成员','alice'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p1','现场项目'),('p2','另一项目');",
  );
  const service = createResources({ db, dataDir });
  installDocumentSchema(db);
  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const api = (
    route,
    method = "GET",
    b = {},
    user = actor,
    params = new URLSearchParams(),
  ) => service.api({ route, method, b, user, params });
  const release = (id, project = "p1") =>
    db
      .prepare("INSERT INTO document_releases VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        project,
        `固定交付 ${id}`,
        "2026-10-01",
        actor.name,
        actor.id,
        '{"items":[]}',
      );
  return { db, api, release };
}
async function configuration(f, project = "p1", name = "现场配置") {
  return (
    await f.api(`/projects/${project}/configurations`, "POST", {
      name,
      content: "PASSWORD=only-a-synthetic-test-marker",
    })
  ).data.configuration;
}

test("delivery baselines validate project scope, active references, specific versions and private options", async (t) => {
  const f = fixture(t);
  f.release("r1");
  f.release("foreign", "p2");
  const c = await configuration(f),
    other = await configuration(f, "p2");
  const v1 = c.latest_version_id;
  await assert.rejects(
    f.api("/projects/p1/deployment-options", "GET", {}, null),
    fails(401),
  );
  const options = (await f.api("/projects/p1/deployment-options")).data;
  assert.deepEqual(
    options.releases.map((r) => r.id),
    ["r1"],
  );
  assert.equal(options.configurations[0].versions[0].id, v1);
  assert.ok(!JSON.stringify(options).includes("synthetic-test-marker"));
  for (const invalid of [
    { delivery_release_id: "foreign" },
    { delivery_release_id: "latest" },
    { delivery_release_id: 12 },
    { configuration_version_ids: ["latest"] },
    { configuration_version_ids: [other.latest_version_id] },
    { configuration_version_ids: [null] },
    { configuration_version_ids: "v1" },
  ])
    await assert.rejects(
      f.api("/projects/p1/deployments", "POST", { name: "测试", ...invalid }),
      fails(400),
    );
  await f.api(`/configurations/${c.id}/versions`, "POST", {
    version: c.version,
    content: "PASSWORD=second-synthetic-secret",
  });
  const versions = (await f.api(`/configurations/${c.id}`)).data.versions;
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM project_deployments").get().n,
    0,
  );
  const multi = (
    await f.api("/projects/p1/deployments", "POST", {
      name: "多个实例的交付",
      configuration_version_ids: versions.map((v) => v.id),
    })
  ).data.deployment;
  assert.equal(multi.configuration_versions.length, 2);
});

test("delivery baselines keep immutable revisions, retain invalidated historical references and never include configuration payloads", async (t) => {
  const f = fixture(t);
  f.release("r1");
  f.release("r2");
  const c = await configuration(f);
  let d = (
    await f.api("/projects/p1/deployments", "POST", {
      name: "A现场首次交付",
      deployed_version: "2.0",
      delivery_release_id: "r1",
      configuration_version_ids: [c.latest_version_id],
    })
  ).data.deployment;
  let h = (await f.api(`/deployments/${d.id}/baselines`)).data.baselines;
  assert.equal(h.length, 1);
  assert.equal(h[0].delivery_release.id, "r1");
  assert.equal(h[0].configuration_versions[0].id, c.latest_version_id);
  assert.ok(!JSON.stringify([d, h]).includes("synthetic-test-marker"));
  assert.ok(!JSON.stringify([d, h]).includes("secret_payload"));
  d = (
    await f.api(`/deployments/${d.id}`, "PATCH", {
      version: d.version,
      delivery_release_id: "r2",
      deployed_version: "2.1",
    })
  ).data.deployment;
  h = (await f.api(`/deployments/${d.id}/baselines`)).data.baselines;
  assert.equal(h.length, 2);
  assert.equal(h[1].delivery_release.id, "r1");
  assert.equal(h[1].source.data.deployed_version, "2.0");
  await assert.rejects(
    f.api(`/deployments/${d.id}`, "PATCH", { version: 1, name: "stale" }),
    fails(409),
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM deployment_delivery_history").get().n,
    2,
  );
  f.db
    .prepare("INSERT INTO document_release_voids VALUES(?,?,?,?)")
    .run("r2", "测试作废", "2026-10-02", actor.name);
  await f.api(`/configurations/${c.id}`, "DELETE", { version: c.version });
  assert.equal(
    (await f.api(`/deployments/${d.id}`)).data.deployment.delivery_release
      .voided,
    true,
  );
  assert.equal(
    (await f.api(`/deployments/${d.id}`)).data.deployment
      .configuration_versions[0].deleted,
    true,
  );
  // An unrelated metadata correction must not require losing historic links.
  d = (
    await f.api(`/deployments/${d.id}`, "PATCH", {
      version: d.version,
      maintainer: "接手人",
    })
  ).data.deployment;
  assert.equal(d.delivery_release_id, "r2");
  await assert.rejects(
    f.api("/projects/p1/deployments", "POST", {
      name: "新交付",
      delivery_release_id: "r2",
    }),
    fails(400),
  );
  await assert.rejects(
    f.api("/projects/p1/deployments", "POST", {
      name: "新交付",
      configuration_version_ids: [c.latest_version_id],
    }),
    fails(400),
  );
  assert.ok(
    !(await f.api("/projects/p1/deployment-options")).data.releases.some(
      (r) => r.id === "r2",
    ),
  );
  for (const sql of [
    "DELETE FROM deployment_delivery_history",
    "UPDATE deployment_delivery_history SET actor_name='changed'",
    "INSERT OR REPLACE INTO deployment_delivery_history SELECT * FROM deployment_delivery_history LIMIT 1",
  ])
    assert.throws(() => f.db.exec(sql), /immutable/);
  await f.api(`/deployments/${d.id}`, "DELETE", { version: d.version });
  assert.equal(
    (await f.api(`/deployments/${d.id}/baselines`)).data.baselines.length,
    3,
  );
});

test("two site instances keep independent applied versions and a failed audited save rolls back its delivery revision", async (t) => {
  const f = fixture(t),
    c = await configuration(f);
  const first = c.latest_version_id;
  await f.api(`/configurations/${c.id}/versions`, "POST", {
    version: c.version,
    content: "port=2",
  });
  const current = (await f.api(`/configurations/${c.id}`)).data.configuration;
  const a = (
    await f.api("/projects/p1/resources", "POST", {
      name: "A现场监控应用",
      type: "application",
    })
  ).data.resource;
  const b = (
    await f.api("/projects/p1/resources", "POST", {
      name: "B现场监控应用",
      type: "application",
    })
  ).data.resource;
  await f.api(`/configurations/${c.id}/applications`, "POST", {
    resource_id: a.id,
    version_id: first,
    result: "verified",
  });
  await f.api(`/configurations/${c.id}/applications`, "POST", {
    resource_id: b.id,
    version_id: current.latest_version_id,
    result: "verified",
  });
  const config = (await f.api(`/configurations/${c.id}`)).data.configuration;
  assert.equal(config.current_applications.length, 2);
  assert.equal(
    config.current_applications.find((x) => x.resource_id === a.id).version_id,
    first,
  );
  assert.equal(
    config.current_applications.find((x) => x.resource_id === b.id).version_id,
    current.latest_version_id,
  );
  const d = (
    await f.api("/projects/p1/deployments", "POST", {
      name: "A现场",
      resource_ids: [a.id],
    })
  ).data.deployment;
  f.db.exec(
    "CREATE TRIGGER reject_baseline_audit BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'audit failed'); END;",
  );
  await assert.rejects(
    f.api(`/deployments/${d.id}`, "PATCH", {
      version: d.version,
      deployed_version: "not-saved",
    }),
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) n FROM deployment_delivery_history WHERE deployment_id=?",
      )
      .get(d.id).n,
    1,
  );
  assert.equal(
    (await f.api(`/deployments/${d.id}`)).data.deployment.deployed_version,
    "",
  );
});

test("legacy deployments preserve their prior baseline on first edit and history pagination remains accessible", async (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      "INSERT INTO project_deployments(id,project_id,name,status,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "legacy",
      "p1",
      "旧现场",
      "live",
      '{"deployed_version":"old"}',
      "2026-10-01",
      "2026-10-01",
    );
  let d = (
    await f.api("/deployments/legacy", "PATCH", {
      version: 1,
      deployed_version: "new",
    })
  ).data.deployment;
  for (let n = 0; n < 50; n++)
    d = (
      await f.api("/deployments/legacy", "PATCH", {
        version: d.version,
        deployed_version: `new-${n}`,
      })
    ).data.deployment;
  const first = (await f.api("/deployments/legacy/baselines")).data;
  assert.equal(first.baselines.length, 50);
  assert.equal(first.next_before, 3);
  const second = (
    await f.api(
      "/deployments/legacy/baselines",
      "GET",
      {},
      actor,
      new URLSearchParams(`before=${first.next_before}`),
    )
  ).data;
  assert.equal(second.baselines.length, 2);
  assert.equal(second.next_before, null);
  assert.equal(second.baselines[1].source.data.deployed_version, "old");
  for (const before of ["0", "-1", "hello", "Infinity"])
    await assert.rejects(
      f.api(
        "/deployments/legacy/baselines",
        "GET",
        {},
        actor,
        new URLSearchParams({ before }),
      ),
      fails(400),
    );
});
