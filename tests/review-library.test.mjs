import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installLibraryCommon } from "../library-common.mjs";
import { createDocuments } from "../documents.mjs";
import { createResources } from "../resources.mjs";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-review-library-"),
  );
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','测试成员甲','alice'),('bob','测试成员乙','bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','项目甲'),('p2','项目乙'),('p3','项目丙');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,deleted INTEGER);
    INSERT INTO records VALUES('task2','p2',0);`);
  installLibraryCommon(db);
  const docs = createDocuments({ db, dataDir, minFreeBytes: 0 });
  const resources = createResources({ db, dataDir, documents: docs });
  const user = { id: "alice", name: "测试成员甲", login: "alice" };
  const da = (route, method = "GET", b = {}) =>
    docs.api({ route, method, b, user });
  const ra = (route, method = "GET", b = {}) =>
    resources.api({ route, method, b, user });
  const begin = async (b = {}) =>
    (
      await da("/uploads", "POST", {
        project_id: "p2",
        filename: "说明.txt",
        size: 0,
        ...b,
      })
    ).data;
  const complete = async (upload) =>
    (await da(`/uploads/${upload.id}/complete`, "POST")).data;
  t.after(async () => {
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { db, da, ra, begin, complete };
}

test("review: documents can associate resources shared from another project", async (t) => {
  const { da, ra, begin, complete } = await fixture(t);
  const resource = (
    await ra("/projects/p1/resources", "POST", {
      name: "共享主机",
      type: "host",
      project_ids: ["p1", "p2"],
    })
  ).data.resource;
  const first = await complete(await begin({ resource_id: resource.id }));
  assert.equal(first.document.resource_id, resource.id);
  const second = await complete(await begin({ title: "后来关联的说明" }));
  const edited = await da(`/documents/${second.document_id}`, "PATCH", {
    version: second.document.version,
    resource_id: resource.id,
  });
  assert.equal(edited.data.document.resource_id, resource.id);
  await assert.rejects(begin({ project_id: "p3", resource_id: resource.id }), {
    status: 400,
  });
  await assert.rejects(
    ra(`/resources/${resource.id}`, "PATCH", {
      version: resource.version,
      project_ids: ["p1"],
    }),
    { status: 409 },
  );
});

test("review: upload completion rechecks deleted resources and tasks", async (t) => {
  const { db, ra, begin, complete } = await fixture(t);
  const resource = (
    await ra("/projects/p2/resources", "POST", {
      name: "临时设备",
      type: "device",
    })
  ).data.resource;
  const upload = await begin({ resource_id: resource.id });
  await ra(`/resources/${resource.id}`, "DELETE", {
    version: resource.version,
  });
  await assert.rejects(complete(upload), { status: 400 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 0);
  const taskUpload = await begin({ task_id: "task2" });
  db.prepare("UPDATE records SET deleted=1 WHERE id='task2'").run();
  await assert.rejects(complete(taskUpload), { status: 400 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 0);
});

test("review: upload completion rechecks a resource unshared while upload was open", async (t) => {
  const { db, ra, begin, complete } = await fixture(t);
  const resource = (
    await ra("/projects/p1/resources", "POST", {
      name: "取消共享的主机",
      type: "host",
      project_ids: ["p1", "p2"],
    })
  ).data.resource;
  const upload = await begin({ resource_id: resource.id });
  await ra(`/resources/${resource.id}`, "PATCH", {
    version: resource.version,
    project_ids: ["p1"],
  });
  await assert.rejects(complete(upload), { status: 400 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents").get().n, 0);
});

test("review: an existing document can move folders while a content upload is open", async (t) => {
  const { da, begin, complete } = await fixture(t);
  const originalFolder = (
    await da("/projects/p2/folders", "POST", { name: "旧目录" })
  ).data.folder;
  const targetFolder = (
    await da("/projects/p2/folders", "POST", { name: "新目录" })
  ).data.folder;
  const original = await complete(
    await begin({ folder_id: originalFolder.id }),
  );
  const pending = await begin({
    document_id: original.document_id,
    base_version_id: original.version_id,
  });
  await da(`/documents/${original.document_id}`, "PATCH", {
    version: original.document.version,
    title: "已改名",
    folder_id: targetFolder.id,
  });
  await da(`/folders/${originalFolder.id}`, "DELETE", {
    version: originalFolder.version,
  });
  const uploaded = await complete(pending);
  assert.equal(uploaded.document.folder_id, targetFolder.id);
  assert.equal(uploaded.document.title, "已改名");
  assert.equal(uploaded.document.version_count, 2);
  assert.equal(uploaded.conflict, false);
});

test("review: soft-deleted task and resource references do not block document metadata edits", async (t) => {
  const { db, da, ra, begin, complete } = await fixture(t);
  const resource = (
    await ra("/projects/p2/resources", "POST", {
      name: "已退役设备",
      type: "device",
    })
  ).data.resource;
  const saved = await complete(
    await begin({ task_id: "task2", resource_id: resource.id }),
  );
  await ra(`/resources/${resource.id}`, "DELETE", {
    version: resource.version,
  });
  db.prepare("UPDATE records SET deleted=1 WHERE id='task2'").run();
  const edited = (
    await da(`/documents/${saved.document_id}`, "PATCH", {
      version: saved.document.version,
      title: "保留历史关联的说明",
    })
  ).data.document;
  assert.equal(edited.title, "保留历史关联的说明");
  assert.equal(edited.task_id, "task2");
  assert.equal(edited.resource_id, resource.id);
  await assert.rejects(begin({ task_id: "task2" }), { status: 400 });
  await assert.rejects(begin({ resource_id: resource.id }), { status: 400 });
  const deleted = await da(`/documents/${saved.document_id}`, "DELETE", {
    version: edited.version,
  });
  const restored = (
    await da(`/documents/${saved.document_id}/restore`, "POST", {
      version: deleted.data.version,
    })
  ).data.document;
  assert.equal(restored.task_id, "task2");
  assert.equal(restored.resource_id, resource.id);
  assert.equal(restored.deleted, 0);
});

test("review: restoring a document cannot revive a resource unshared from its project", async (t) => {
  const { db, da, ra, begin, complete } = await fixture(t);
  const resource = (
    await ra("/projects/p1/resources", "POST", {
      name: "恢复期间取消共享的主机",
      type: "host",
      project_ids: ["p1", "p2"],
    })
  ).data.resource;
  const saved = await complete(await begin({ resource_id: resource.id }));
  const deleted = await da(`/documents/${saved.document_id}`, "DELETE", {
    version: saved.document.version,
  });
  await ra(`/resources/${resource.id}`, "PATCH", {
    version: resource.version,
    project_ids: ["p1"],
  });
  await assert.rejects(
    da(`/documents/${saved.document_id}/restore`, "POST", {
      version: deleted.data.version,
    }),
    { status: 409 },
  );
  assert.equal(
    db
      .prepare("SELECT deleted FROM documents WHERE id=?")
      .get(saved.document_id).deleted,
    1,
  );
  await ra(`/resources/${resource.id}`, "PATCH", {
    version: resource.version + 1,
    project_ids: ["p1", "p2"],
  });
  const restored = (
    await da(`/documents/${saved.document_id}/restore`, "POST", {
      version: deleted.data.version,
    })
  ).data.document;
  const edited = (
    await da(`/documents/${saved.document_id}`, "PATCH", {
      version: restored.version,
      title: "恢复后可修改的文档",
    })
  ).data.document;
  assert.equal(edited.resource_id, resource.id);
  assert.equal(edited.title, "恢复后可修改的文档");
});
