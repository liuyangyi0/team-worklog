import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createResources, installResourceSchema } from "../resources.mjs";
import { createVault } from "../vault.mjs";

const alice = { id: "alice-id", name: "成员甲", login: "alice" };
const bob = { id: "bob-id", name: "成员乙", login: "bob" };
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-resources-"));
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);INSERT INTO projects VALUES('p1','软件项目'),('p2','设备项目');",
  );
  const resources = createResources({ db, dataDir });
  const api = async (
    route,
    method = "GET",
    b = {},
    user = alice,
    params = new URLSearchParams(),
  ) => resources.api({ route, method, b, user, params });
  return {
    dataDir,
    db,
    resources,
    api,
    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
const errorStatus = (status) => (error) => error.status === status;

test("resources: pure software, environments, shared resources, multi-address relations and concurrency", async () => {
  const f = fixture(),
    { api, db } = f;
  try {
    const env = (
      await api("/projects/p1/environments", "POST", { name: "测试" })
    ).data.id;
    const host = (
      await api("/projects/p1/resources", "POST", {
        name: "演示主机",
        type: "host",
        project_ids: ["p1", "p2"],
        environment_id: env,
        endpoints: [
          {
            address: "10.0.0.10",
            port: "22",
            protocol: "ssh",
            purpose: "管理",
          },
          {
            address: "https://demo.invalid",
            port: 443,
            protocol: "https",
            purpose: "业务",
          },
        ],
      })
    ).data.resource;
    const software = (
      await api("/projects/p1/resources", "POST", {
        name: "监控应用",
        type: "application",
        relations: [{ type: "runs_on", target_id: host.id }],
      })
    ).data.resource;
    assert.equal(software.relations[0].target_name, "演示主机");
    assert.equal(host.endpoints.length, 2);
    assert.equal(host.endpoints[0].port, 22);
    assert.ok(
      (await api("/projects/p2/resources")).data.resources.some(
        (r) => r.id === host.id,
      ),
    );
    const changed = await api(
      `/resources/${host.id}`,
      "PATCH",
      { version: 1, description: "机房设备" },
      bob,
    );
    assert.deepEqual(changed.data.resource.project_ids, ["p1", "p2"]);
    await assert.rejects(
      api(`/resources/${host.id}`, "PATCH", { version: 1, name: "覆盖" }),
      errorStatus(409),
    );
    await assert.rejects(
      api(`/resources/${host.id}`, "PATCH", {
        version: 2,
        relations: [{ type: "depends_on", target_id: software.id }],
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api(`/environments/${env}`, "DELETE", { version: 1 }),
      errorStatus(409),
    );
    await assert.rejects(
      api("/projects/p2/resources", "POST", {
        name: "越项目环境",
        environment_id: env,
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api("/projects/p1/resources", "POST", {
        name: "无效端口",
        endpoints: [{ address: "a", port: 65536 }],
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api(`/resources/${host.id}`, "DELETE", { version: 2 }),
      errorStatus(409),
    );
    await api(`/resources/${host.id}`, "PATCH", {
      version: 2,
      project_ids: ["p1"],
    });
    const deleted = await api(
      `/resources/${host.id}`,
      "DELETE",
      { version: 3 },
      bob,
    );
    assert.equal(
      (await api("/projects/p1/resources")).data.resources.length,
      1,
    );
    assert.equal(
      (
        await api(
          "/projects/p1/resources",
          "GET",
          {},
          alice,
          new URLSearchParams("include_deleted=1"),
        )
      ).data.resources.length,
      2,
    );
    // Editing an existing resource retains its reference to a deleted target.
    assert.equal(
      (
        await api(`/resources/${software.id}`, "PATCH", {
          version: 1,
          description: "保留关联",
        })
      ).data.version,
      2,
    );
    await api(`/resources/${host.id}/restore`, "POST", {
      version: deleted.data.version,
    });
    assert.equal(
      (await api(`/resources/${host.id}`)).data.resource.name,
      "演示主机",
    );
    assert.equal(
      (
        await api(
          "/projects/p1/resources",
          "GET",
          {},
          alice,
          new URLSearchParams("q=监控"),
        )
      ).data.resources.length,
      1,
    );
    const events = db.prepare("SELECT * FROM resource_events").all();
    assert.ok(
      events.some(
        (e) => e.actor_id === bob.id && e.action === "update-resource",
      ),
    );
    installResourceSchema(db);
  } finally {
    f.close();
  }
});

test("credentials: encrypted history, registered member edits, explicit clearing, verification and immutable audit", async () => {
  const f = fixture(),
    { api, db, resources } = f;
  const firstSecret = "Fictional-secret-A-甲",
    secondSecret = "Fictional-secret-B-乙";
  try {
    const host = (
      await api("/projects/p1/resources", "POST", {
        name: "共享数据库",
        type: "database",
        project_ids: ["p1", "p2"],
      })
    ).data.id;
    const created = await api("/projects/p1/credentials", "POST", {
      title: "数据库管理账号",
      username: "admin",
      secret: firstSecret,
      resource_id: host,
      project_ids: ["p1", "p2"],
      verified_status: "verified",
    });
    const id = created.data.id;
    assert.equal(created.data.credential.verified_by, alice.name);
    assert.equal(created.data.credential.has_secret, true);
    assert.equal(JSON.stringify(created).includes(firstSecret), false);
    const initial = await api(`/credentials/${id}`);
    assert.equal(initial.data.versions.length, 1);
    const firstId = initial.data.versions[0].id;
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST", {}, bob)).data.secret,
      firstSecret,
    );
    const metadata = await api(
      `/credentials/${id}`,
      "PATCH",
      { version: 1, title: "更正用途" },
      bob,
    );
    assert.equal(metadata.data.credential.verified_status, "verified");
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST")).data.secret,
      firstSecret,
    );
    const updated = await api(
      `/credentials/${id}`,
      "PATCH",
      { version: 2, secret: secondSecret },
      bob,
    );
    assert.equal(updated.data.credential.verified_status, "unverified");
    assert.equal(updated.data.credential.verified_at, "");
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST", { version_id: firstId }))
        .data.secret,
      firstSecret,
    );
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST")).data.secret,
      secondSecret,
    );
    await assert.rejects(
      api(`/credentials/${id}`, "PATCH", { version: 1, secret: "stale" }),
      errorStatus(409),
    );
    const cleared = await api(`/credentials/${id}`, "PATCH", {
      version: 3,
      secret: "",
    });
    assert.equal(cleared.data.credential.has_secret, false);
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST")).data.secret,
      "",
    );
    assert.equal(
      (await api(`/credentials/${id}/reveal`, "POST", { version_id: firstId }))
        .data.secret,
      firstSecret,
    );
    assert.equal(
      (await api("/projects/p2/credentials")).data.credentials[0].id,
      id,
    );
    await assert.rejects(
      api(`/credentials/${id}`, "DELETE", { version: 4 }),
      errorStatus(409),
    );
    await api(`/credentials/${id}`, "PATCH", {
      version: 4,
      project_ids: ["p1"],
    });
    const removed = await api(`/credentials/${id}`, "DELETE", { version: 5 });
    await assert.rejects(
      api(`/credentials/${id}/reveal`, "POST"),
      errorStatus(404),
    );
    await api(
      `/credentials/${id}/restore`,
      "POST",
      { version: removed.data.version },
      bob,
    );
    const after = await api(`/credentials/${id}`);
    const metadataJSON = JSON.stringify(after);
    assert.equal(metadataJSON.includes(firstSecret), false);
    assert.equal(metadataJSON.includes("ciphertext"), false);
    const history = db
      .prepare("SELECT * FROM credential_versions WHERE credential_id=?")
      .all(id);
    assert.ok(history[0].secret_payload.includes('"key_version":"v1"'));
    for (const value of [
      JSON.stringify(history),
      JSON.stringify(db.prepare("SELECT * FROM resource_events").all()),
      fs.readFileSync(path.join(f.dataDir, "worklog.sqlite")).toString("utf8"),
    ]) {
      assert.equal(value.includes(firstSecret), false);
      assert.equal(value.includes(secondSecret), false);
    }
    assert.throws(() =>
      db.prepare("UPDATE resource_events SET action='erase'").run(),
    );
    assert.throws(() => db.prepare("DELETE FROM resource_events").run());
    assert.throws(() =>
      db.prepare("DELETE FROM credential_versions WHERE id=?").run(firstId),
    );
    assert.throws(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO credential_versions SELECT * FROM credential_versions WHERE id=?",
        )
        .run(firstId),
    );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM resource_events")
      .get().n;
    let decryptions = 0;
    const originalDecrypt = resources.vault.decrypt;
    resources.vault.decrypt = (...args) => {
      decryptions++;
      return originalDecrypt(...args);
    };
    db.exec(
      "CREATE TRIGGER reject_resource_event BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'test-event-failure'); END",
    );
    await assert.rejects(
      api(`/credentials/${id}/reveal`, "POST", { version_id: firstId }),
    );
    assert.equal(decryptions, 0);
    await assert.rejects(
      api(`/credentials/${id}`, "PATCH", {
        version: after.data.credential.version,
        secret: "Not-persisted",
      }),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM resource_events").get().n,
      count,
    );
    assert.equal(
      (await api(`/credentials/${id}`)).data.credential.version,
      after.data.credential.version,
    );
    db.exec("DROP TRIGGER reject_resource_event");
  } finally {
    f.close();
  }
});

test("configuration: encrypted text, immutable versions/releases and independent actual use for multiple targets", async () => {
  const f = fixture(),
    { api, db } = f;
  const original = "password=ImaginaryConfigSecret-A\nport=3306\n";
  try {
    const prod = (
      await api("/projects/p1/environments", "POST", { name: "生产" })
    ).data.id;
    const testing = (
      await api("/projects/p1/environments", "POST", { name: "测试" })
    ).data.id;
    const a = (
      await api("/projects/p1/resources", "POST", {
        name: "应用 A",
        type: "application",
      })
    ).data.id;
    const b = (
      await api("/projects/p1/resources", "POST", {
        name: "应用 B",
        type: "application",
      })
    ).data.id;
    const created = await api("/projects/p1/configurations", "POST", {
      name: "应用运行配置",
      resource_id: a,
      path: "/opt/demo/app.env",
      content: original,
    });
    const id = created.data.id,
      firstVersion = created.data.configuration.latest_version_id;
    assert.equal(created.data.configuration.published_version_id, null);
    await api(
      `/configurations/${id}/publish`,
      "POST",
      { version: 1, version_id: firstVersion },
      bob,
    );
    await api(`/configurations/${id}/applications`, "POST", {
      resource_id: a,
      environment_id: prod,
      version_id: firstVersion,
      result: "verified",
      applied_at: "2026-10-20T10:00:00Z",
    });
    const next = await api(
      `/configurations/${id}/versions`,
      "POST",
      {
        version: 2,
        content: "password=ImaginaryConfigSecret-B\nport=3307",
        note: "测试端口调整",
      },
      bob,
    );
    const secondVersion = next.data.version_id;
    const detail = (await api(`/configurations/${id}`)).data;
    assert.equal(detail.configuration.latest_version_id, secondVersion);
    assert.equal(detail.configuration.published_version_id, firstVersion);
    assert.equal(detail.applications[0].version_id, firstVersion);
    assert.equal(detail.versions[0].number, 2);
    assert.equal(detail.versions[0].has_content, true);
    assert.equal(
      JSON.stringify(detail).includes("ImaginaryConfigSecret"),
      false,
    );
    assert.equal(JSON.stringify(detail).includes("ciphertext"), false);
    assert.equal(
      (
        await api(
          `/configurations/${id}/versions/${firstVersion}/reveal`,
          "POST",
          {},
          bob,
        )
      ).data.content,
      original,
    );
    assert.equal(
      (await api(`/configurations/${id}/versions/1/reveal`, "POST")).data
        .content,
      original,
    );
    await api(`/configurations/${id}/applications`, "POST", {
      resource_id: b,
      environment_id: testing,
      version_id: secondVersion,
      result: "applied",
      applied_at: "2026-10-21T10:00:00Z",
    });
    await api(`/configurations/${id}/applications`, "POST", {
      resource_id: a,
      environment_id: prod,
      version_id: secondVersion,
      result: "failed",
      applied_at: "2026-10-21T11:00:00Z",
    });
    let current = (await api(`/configurations/${id}`)).data.configuration
      .current_applications;
    assert.equal(current.length, 2);
    assert.equal(
      current.find((x) => x.resource_id === a).version_id,
      firstVersion,
    );
    await api(
      `/configurations/${id}/applications`,
      "POST",
      {
        resource_id: b,
        environment_id: testing,
        version_id: firstVersion,
        rollback_version_id: secondVersion,
        result: "rolled_back",
        applied_at: "2026-10-21T12:00:00Z",
      },
      bob,
    );
    current = (await api(`/configurations/${id}`)).data.configuration
      .current_applications;
    assert.equal(
      current.find((x) => x.resource_id === b).version_id,
      firstVersion,
    );
    assert.equal(
      (await api(`/configurations/${id}`)).data.releases[0].version_id,
      firstVersion,
    );
    await assert.rejects(
      api(`/configurations/${id}/versions`, "POST", {
        version: 1,
        content: "overwrite",
      }),
      errorStatus(409),
    );
    await assert.rejects(
      api(`/configurations/${id}/applications`, "POST", {
        resource_id: a,
        version_id: "nonexistent",
      }),
      errorStatus(404),
    );
    await assert.rejects(
      api(`/configurations/${id}/applications`, "POST", {
        resource_id: a,
        version_id: firstVersion,
        result: "rolled_back",
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api(`/configurations/${id}`, "PATCH", {
        version: 3,
        content: "overwrite",
      }),
      errorStatus(400),
    );
    const big = "x".repeat(512 * 1024);
    await api(`/configurations/${id}/versions`, "POST", {
      version: 3,
      content: big,
    });
    await assert.rejects(
      api(`/configurations/${id}/versions`, "POST", {
        version: 4,
        content: "中".repeat(180000),
      }),
      errorStatus(400),
    );
    const removed = await api(`/configurations/${id}`, "DELETE", {
      version: 4,
    });
    await assert.rejects(
      api(`/configurations/${id}/versions/1/reveal`, "POST"),
      errorStatus(404),
    );
    await api(`/configurations/${id}/restore`, "POST", {
      version: removed.data.version,
    });
    for (const table of [
      "configuration_versions",
      "configuration_releases",
      "configuration_applications",
    ]) {
      assert.throws(() => db.exec(`UPDATE ${table} SET id='replacement'`));
      assert.throws(() => db.exec(`DELETE FROM ${table}`));
      assert.throws(() =>
        db.exec(
          `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`,
        ),
      );
    }
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM configuration_versions").all(),
      ).includes("ImaginaryConfigSecret"),
      false,
    );
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM resource_events").all(),
      ).includes("ImaginaryConfigSecret"),
      false,
    );
    db.exec(
      "CREATE TRIGGER reject_config_reveal BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'test-event-failure'); END",
    );
    await assert.rejects(
      api(`/configurations/${id}/versions/1/reveal`, "POST"),
    );
    db.exec("DROP TRIGGER reject_config_reveal");
  } finally {
    f.close();
  }
});

test("vault: independent key backup, missing/wrong key degrades only secret operations, AAD and historical recovery", async () => {
  const f = fixture(),
    { api, db, dataDir } = f;
  try {
    const id = (
      await api("/projects/p1/credentials", "POST", {
        title: "虚构账号",
        secret: "Restore-only-fictional-password",
      })
    ).data.id;
    const config = (
      await api("/projects/p1/configurations", "POST", {
        name: "虚构配置",
        content: "restore_test=secret",
      })
    ).data.id;
    const keyPath = path.join(dataDir, ".keys", "vault-v1.key"),
      key = fs.readFileSync(keyPath, "utf8");
    fs.unlinkSync(keyPath);
    const noKey = createResources({ db, dataDir });
    assert.equal(noKey.vault.status().available, false);
    assert.equal(fs.existsSync(keyPath), false);
    assert.match(noKey.vault.status().message, /密钥缺失/);
    const invoke = (module, route, method = "GET", b = {}) =>
      module.api({ route, method, b, user: bob });
    assert.equal(
      (await invoke(noKey, "/projects/p1/resources")).data.resources.length,
      0,
    );
    assert.equal(
      (await invoke(noKey, `/credentials/${id}`)).data.credential.has_secret,
      true,
    );
    await assert.rejects(
      invoke(noKey, `/credentials/${id}/reveal`, "POST"),
      errorStatus(503),
    );
    await assert.rejects(
      invoke(noKey, `/credentials/${id}`, "PATCH", {
        version: 1,
        secret: "new",
      }),
      errorStatus(503),
    );
    assert.equal(
      (
        await invoke(noKey, `/credentials/${id}`, "PATCH", {
          version: 1,
          title: "可改非秘密资料",
        })
      ).data.version,
      2,
    );
    const wrong = createResources({ db, dataDir, vaultKey: "77".repeat(32) });
    assert.equal(wrong.vault.status().available, false);
    await assert.rejects(
      invoke(wrong, `/credentials/${id}/reveal`, "POST"),
      errorStatus(503),
    );
    fs.writeFileSync(keyPath, key);
    const restored = createResources({ db, dataDir });
    assert.equal(restored.vault.status().available, true);
    assert.equal(
      (await invoke(restored, `/credentials/${id}/reveal`, "POST")).data.secret,
      "Restore-only-fictional-password",
    );
    assert.equal(
      (
        await invoke(
          restored,
          `/configurations/${config}/versions/1/reveal`,
          "POST",
        )
      ).data.content,
      "restore_test=secret",
    );
    const saved = db
      .prepare(
        "SELECT secret_payload,secret_context FROM credential_versions WHERE credential_id=? ORDER BY number LIMIT 1",
      )
      .get(id);
    assert.throws(
      () =>
        restored.vault.decrypt(
          saved.secret_payload,
          `credential:wrong-entity:${saved.secret_context}`,
        ),
      errorStatus(503),
    );
    const external = createVault({
      db,
      dataDir,
      masterKey: Buffer.from(key.trim(), "hex").toString("base64"),
    });
    assert.equal(external.status().available, true);
    assert.equal(
      createVault({ db, dataDir, masterKey: "not-a-key" }).status().available,
      false,
    );
  } finally {
    f.close();
  }
});

test("all internal routes require authentication and ordinary attachments cannot silently carry configuration secrets", async () => {
  const f = fixture(),
    { api, db } = f;
  try {
    for (const route of [
      "/resources",
      "/credentials",
      "/projects/p1/resources",
      "/projects/p1/environments",
      "/projects/p1/credentials",
      "/projects/p1/configurations",
      "/resources/guessed",
      "/credentials/guessed/reveal",
      "/configurations/guessed/versions/1/reveal",
    ])
      await assert.rejects(
        api(route, route.endsWith("reveal") ? "POST" : "GET", {}, null),
        errorStatus(401),
      );
    assert.equal(await api("/state"), null);
    db.exec(
      "CREATE TABLE documents(id TEXT PRIMARY KEY,project_id TEXT,deleted INTEGER DEFAULT 0);CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT);INSERT INTO documents VALUES('doc1','p1',0),('doc2','p2',0);INSERT INTO document_versions VALUES('dv1','doc1'),('dv2','doc2');",
    );
    await assert.rejects(
      api("/projects/p1/configurations", "POST", {
        name: "不明确附件",
        content: "secret=x",
        document_id: "doc1",
        document_version_id: "dv1",
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api("/projects/p1/configurations", "POST", {
        name: "越项目附件",
        content: "secret=x",
        document_id: "doc2",
        document_version_id: "dv2",
        attachment_non_secret: true,
      }),
      errorStatus(400),
    );
    const created = await api("/projects/p1/configurations", "POST", {
      name: "带说明的配置",
      content: "secret=x",
      document_id: "doc1",
      document_version_id: "dv1",
      attachment_non_secret: true,
    });
    assert.equal(created.data.configuration.document_id, "doc1");
    assert.equal(
      (
        await api(`/configurations/${created.data.id}`, "PATCH", {
          version: 1,
          name: "配置名称修正",
        })
      ).data.version,
      2,
    );
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM configurations")
      .get().n;
    await assert.rejects(
      api("/projects/p1/configurations", "POST", { name: "无内容" }),
      errorStatus(400),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM configurations").get().n,
      before,
    );
  } finally {
    f.close();
  }
});

test("registered users reuse one resource and credential across projects without copying secrets", async () => {
  const f = fixture(),
    { api, db } = f;
  try {
    const resource = (
      await api("/projects/p1/resources", "POST", {
        name: "共享平台",
        type: "service",
      })
    ).data.resource;
    const credential = (
      await api("/projects/p1/credentials", "POST", {
        title: "平台账号",
        resource_id: resource.id,
        secret: "Shared-fictional-secret",
      })
    ).data.credential;
    assert.equal(
      (await api("/resources", "GET", {}, bob)).data.resources[0].id,
      resource.id,
    );
    assert.equal(
      (await api("/credentials", "GET", {}, bob)).data.credentials[0].id,
      credential.id,
    );
    await assert.rejects(
      api(`/credentials/${credential.id}`, "PATCH", {
        version: 1,
        project_ids: ["p1", "p2"],
      }),
      errorStatus(400),
    );
    await api(
      `/resources/${resource.id}`,
      "PATCH",
      { version: 1, project_ids: ["p1", "p2"] },
      bob,
    );
    await api(
      `/credentials/${credential.id}`,
      "PATCH",
      { version: 1, project_ids: ["p1", "p2"] },
      bob,
    );
    assert.equal(
      (await api("/projects/p2/credentials")).data.credentials[0].id,
      credential.id,
    );
    assert.equal(
      (await api(`/credentials/${credential.id}/reveal`, "POST", {}, bob)).data
        .secret,
      "Shared-fictional-secret",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM credentials").get().n,
      1,
    );
    await assert.rejects(
      api(`/resources/${resource.id}`, "PATCH", {
        version: 2,
        project_ids: ["p1"],
      }),
      errorStatus(409),
    );
    await api(`/credentials/${credential.id}`, "PATCH", {
      version: 2,
      project_ids: ["p1"],
    });
    await api(`/resources/${resource.id}`, "PATCH", {
      version: 2,
      project_ids: ["p1"],
    });
    const removed = await api(`/credentials/${credential.id}`, "DELETE", {
      version: 3,
    });
    assert.equal(
      (
        await api(
          "/projects/p1/credentials",
          "GET",
          {},
          alice,
          new URLSearchParams("deleted=1"),
        )
      ).data.credentials[0].id,
      credential.id,
    );
    assert.equal((await api("/credentials")).data.credentials.length, 0);
    await api(`/credentials/${credential.id}/restore`, "POST", {
      version: removed.data.version,
    });
    assert.equal((await api("/credentials")).data.credentials.length, 1);
  } finally {
    f.close();
  }
});
