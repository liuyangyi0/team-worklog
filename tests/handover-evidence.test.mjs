import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createDocuments } from "../documents.mjs";
import { createResources } from "../resources.mjs";
import { createNotes } from "../notes.mjs";
import { checklistProgress, evidenceProgress } from "../src/checklist.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-evidence-"));
  const db = new DatabaseSync(path.join(dataDir, "test.sqlite"));
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','成员甲','alice');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','软件项目'),('p2','二号现场');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,deleted INTEGER);`);
  const resources = createResources({ db, dataDir });
  const docs = createDocuments({ db, dataDir });
  const notes = createNotes({ db });
  const server = http.createServer(async (req, res) => {
    const json = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const user = req.headers["x-user"]
        ? { id: "alice", name: "成员甲", login: "alice" }
        : null;
      if (
        await docs.binary({
          route: url.pathname,
          method: req.method,
          req,
          res,
          user,
          json,
        })
      )
        return;
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = {
        route: url.pathname,
        method: req.method,
        b: body ? JSON.parse(body) : {},
        user,
        params: url.searchParams,
      };
      const result =
        (await docs.api(input)) ||
        (await resources.api(input)) ||
        (await notes.api(input));
      json(
        result?.data || { error: "missing" },
        result?.status || (result ? 200 : 404),
      );
    } catch (error) {
      json({ error: error.message }, error.status || 500);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  const api = async (route, method = "GET", body, user = true) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user ? { "X-User": "alice" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const upload = async (name = "交接说明.txt", extra = {}) => {
    const content = Buffer.from("虚构测试文件：" + name);
    const init = await api("/uploads", "POST", {
      project_id: "p1",
      filename: name,
      size: content.length,
      ...extra,
    });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    const chunk = await fetch(base + "/uploads/" + init.data.id + "/chunks/0", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-User": "alice",
      },
      body: content,
    });
    assert.equal(chunk.status, 200);
    const result = await api(
      "/uploads/" + init.data.id + "/complete",
      "POST",
      {},
    );
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  const list = async (project = "p1") =>
    (await api("/projects/" + project + "/deliverables")).data;
  return { db, docs, api, upload, list };
}

test("formal evidence cannot be satisfied by a note or by pinning an unpublished draft", async (t) => {
  const { api, upload, list } = await fixture(t);
  let item = (
    await api("/projects/p1/deliverables", "POST", {
      title: "客户签字验收单",
      required: true,
      evidence_kind: "published",
    })
  ).data.item;
  assert.equal(item.status, "needs-published");
  assert.equal(
    (
      await api("/projects/p1/notes", "POST", {
        kind: "verbal",
        body: "下周补签",
        deliverable_id: item.id,
      })
    ).status,
    201,
  );
  item = (await list()).items[0];
  assert.equal(item.collection_status, "recorded");
  assert.equal(item.evidence_met, false);
  const legacy = (
    await api("/projects/p1/deliverables", "POST", {
      title: "现场约定",
      required: true,
    })
  ).data.item;
  assert.equal(legacy.evidence_kind, "record");
  await api("/projects/p1/notes", "POST", {
    kind: "site",
    body: "虚构现场已记录",
    deliverable_id: legacy.id,
  });
  assert.equal(
    (await list()).items.find((i) => i.id === legacy.id).status,
    "recorded",
  );
  const file = await upload();
  item = (
    await api("/deliverables/" + item.id, "PATCH", {
      version: item.version,
      document_id: file.document_id,
      version_id: file.version_id,
    })
  ).data.item;
  assert.equal(item.collection_status, "ready");
  assert.equal(item.evidence_met, false);
  assert.equal(item.status, "needs-published");
  assert.deepEqual(evidenceProgress([item]), {
    required: 1,
    met: 0,
    missing: 1,
  });
  assert.equal(checklistProgress([item]).provided, 1);
  let doc = (
    await api("/documents/" + file.document_id + "/publish", "POST", {
      version: file.document.version,
      version_id: file.version_id,
    })
  ).data.document;
  item = (await list()).items[0];
  assert.equal(item.evidence_met, true);
  assert.equal(item.status, "ready");
  const v2 = await upload("新验收单.txt", {
    document_id: file.document_id,
    base_version_id: file.version_id,
  });
  doc = (
    await api("/documents/" + file.document_id + "/publish", "POST", {
      version: v2.document.version,
      version_id: v2.version_id,
    })
  ).data.document;
  assert.equal(
    (await list()).items[0].evidence_met,
    true,
    "previously published pinned evidence stays valid",
  );
  const removed = await api("/documents/" + doc.id, "DELETE", {
    version: doc.version,
  });
  assert.equal((await list()).items[0].evidence_met, false);
  await api("/documents/" + doc.id + "/restore", "POST", {
    version: removed.data.version,
  });
  assert.equal((await list()).items[0].evidence_met, true);
});

test("credential and configuration evidence is scoped, live, metadata-only, and not copied into templates", async (t) => {
  const { api, list, db } = await fixture(t);
  const credential = (
    await api("/projects/p1/credentials", "POST", {
      title: "运行账号",
      username: "fixture",
      secret: "SYNTHETIC-CREDENTIAL-SECRET",
      notes: "DO-NOT-EXPOSE-NOTES",
      project_ids: ["p1", "p2"],
    })
  ).data.credential;
  const config = (
    await api("/projects/p1/configurations", "POST", {
      name: "运行配置",
      content: "secret=SYNTHETIC-CONFIG-SECRET",
    })
  ).data.configuration;
  let item = (
    await api("/projects/p1/deliverables", "POST", {
      title: "账号交接",
      required: true,
      evidence_kind: "credential",
      credential_id: credential.id,
    })
  ).data.item;
  assert.equal(item.status, "linked");
  assert.equal(item.evidence_met, true);
  const configItem = (
    await api("/projects/p1/deliverables", "POST", {
      title: "配置交接",
      required: true,
      evidence_kind: "configuration",
      configuration_id: config.id,
    })
  ).data.item;
  assert.equal(configItem.evidence_met, true);
  assert.equal(
    (
      await api("/projects/p2/deliverables", "POST", {
        title: "越界配置",
        evidence_kind: "configuration",
        configuration_id: config.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/projects/p1/deliverables", "POST", {
        title: "无效类型",
        evidence_kind: "approve",
      })
    ).status,
    400,
  );
  const sharedItem = (
    await api("/projects/p2/deliverables", "POST", {
      title: "共享账号",
      evidence_kind: "credential",
      credential_id: credential.id,
    })
  ).data.item;
  assert.equal(sharedItem.evidence_met, true);
  await api("/credentials/" + credential.id, "PATCH", {
    version: credential.version,
    project_ids: ["p1"],
  });
  assert.equal(
    (await list("p2")).items[0].evidence_met,
    false,
    "unsharing invalidates evidence without exposing the other project's metadata",
  );
  assert.equal((await list("p2")).items[0].evidence_title, "");
  assert.equal(
    (
      await api("/deliverables/" + item.id, "PATCH", {
        version: item.version - 1,
        title: "stale",
      })
    ).status,
    409,
  );
  const saved = (
    await api("/checklist-templates", "POST", {
      name: "证据模板",
      project_id: "p1",
    })
  ).data.template;
  assert.ok(
    saved.items.every(
      (i) =>
        !Object.hasOwn(i, "credential_id") &&
        !Object.hasOwn(i, "configuration_id"),
    ),
  );
  const applied = await api("/projects/p2/deliverables/apply", "POST", {
    template_id: saved.id,
  });
  const copied = applied.data.items.find((i) => i.title === "账号交接");
  assert.equal(copied.evidence_kind, "credential");
  assert.equal(copied.credential_id, null);
  assert.equal(copied.evidence_met, false);
  const data = JSON.stringify(await list());
  for (const secret of [
    "SYNTHETIC-CREDENTIAL-SECRET",
    "SYNTHETIC-CONFIG-SECRET",
    "DO-NOT-EXPOSE-NOTES",
    "secret_payload",
    "secret_context",
  ])
    assert.ok(!data.includes(secret), secret);
  assert.equal(
    (await api("/projects/p1/deliverables", "GET", undefined, false)).status,
    401,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM resource_events WHERE action LIKE '%reveal%'",
      )
      .get().n,
    0,
  );
});

test("handover gaps use existing verification, actual-use and ownership metadata", async (t) => {
  const { api, list, upload } = await fixture(t);
  let credential = (
    await api("/projects/p1/credentials", "POST", {
      title: "现场账号",
      secret: "SYNTHETIC-SECRET",
    })
  ).data.credential;
  const resource = (
    await api("/projects/p1/resources", "POST", {
      name: "现场实例",
      type: "host",
    })
  ).data.resource;
  const config = (
    await api("/projects/p1/configurations", "POST", {
      name: "现场配置",
      resource_id: resource.id,
      content: "fixture=1",
    })
  ).data.configuration;
  const file = await upload();
  await api("/documents/" + file.document_id, "PATCH", {
    version: file.document.version,
    owner: "",
  });
  let gaps = (await list()).gaps;
  assert.deepEqual(
    gaps.unverified_credentials.map((i) => i.id),
    [credential.id],
  );
  assert.deepEqual(
    gaps.unconfirmed_configurations.map((i) => i.id),
    [config.id],
  );
  assert.deepEqual(
    gaps.unowned_documents.map((i) => i.id),
    [file.document_id],
  );
  credential = (
    await api("/credentials/" + credential.id, "PATCH", {
      version: credential.version,
      verified_status: "verified",
    })
  ).data.credential;
  await api("/configurations/" + config.id + "/applications", "POST", {
    version_id: config.latest_version_id,
    resource_id: resource.id,
    result: "failed",
  });
  assert.equal((await list()).gaps.unconfirmed_configurations.length, 1);
  await api("/configurations/" + config.id + "/applications", "POST", {
    version_id: config.latest_version_id,
    resource_id: resource.id,
    result: "verified",
  });
  gaps = (await list()).gaps;
  assert.equal(gaps.unverified_credentials.length, 0);
  assert.equal(gaps.unconfirmed_configurations.length, 0);
  assert.equal(gaps.unowned_documents.length, 1);
});
