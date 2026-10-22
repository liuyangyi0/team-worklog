import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createDocuments, installDocumentSchema } from "../documents.mjs";
import { installLibraryCommon } from "../library-common.mjs";
import { CHUNK_SIZE, zip32Size } from "../storage.mjs";

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-files-"));
  const db = new DatabaseSync(path.join(dataDir, "test.sqlite"));
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,login TEXT);
    INSERT INTO users VALUES('alice','成员甲','alice'),('bob','成员乙','bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO projects VALUES('p1','软件项目'),('p2','设备项目');
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,deleted INTEGER);
    INSERT INTO records VALUES('task1','p1',0),('task2','p2',0);`);
  installLibraryCommon(db);
  const docs = createDocuments({ db, dataDir, ...options });
  const server = http.createServer(async (req, res) => {
    const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, "http://localhost"), route = url.pathname;
      const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.headers["x-user"] || "") || null;
      if (await docs.binary({ route, method: req.method, req, res, user, json })) return;
      let text = ""; for await (const chunk of req) text += chunk;
      const result = await docs.api({ route, method: req.method, b: text ? JSON.parse(text) : {}, user, params: url.searchParams });
      if (!result) return json({ error: "missing" }, 404);
      json(result.data, result.status || 200);
    } catch (e) { if (!res.headersSent) json({ error: e.message }, e.status || 500); else res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const api = async (route, method = "GET", body, user = "alice") => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(user ? { "X-User": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const chunk = async (id, part, body, user = "alice") => {
    const r = await fetch(base + "/uploads/" + id + "/chunks/" + part, { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...(user ? { "X-User": user } : {}) }, body });
    return { status: r.status, data: await r.json() };
  };
  const upload = async (content = Buffer.from("文件内容"), extra = {}, user = "alice") => {
    const init = await api("/uploads", "POST", { project_id: "p1", filename: "项目说明.txt", size: content.length, ...extra }, user);
    assert.equal(init.status, 201, JSON.stringify(init.data));
    for (let i = 0; i < init.data.total_parts; i++) assert.equal((await chunk(init.data.id, i, content.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), user)).status, 200);
    return api("/uploads/" + init.data.id + "/complete", "POST", { sha256: createHash("sha256").update(content).digest("hex") }, user);
  };
  return { dataDir, db, docs, api, base, chunk, upload };
}

test("private document lifecycle, stable identity, immutable versions and releases", async (t) => {
  const { db, docs, api, base, upload } = await fixture(t);
  const content = Buffer.from("接口说明 V1\n");
  const first = await upload(content, { title: "接口说明", category: "技术需求", tags: ["联调", "协议"], task_id: "task1", source_path: "原始资料/接口说明.txt" });
  assert.equal(first.status, 201);
  const id = first.data.document_id, v1 = first.data.version_id;
  let d = first.data.document;
  assert.equal(d.current_version_id, v1); assert.equal(d.published_version_id, null);
  assert.equal((await api("/projects/p1/documents", "GET", undefined, "")).status, 401);
  assert.equal((await fetch(base + `/documents/${id}/versions/${v1}/download`)).status, 401);
  const folder = (await api("/projects/p1/folders", "POST", { name: "交付资料" })).data;
  const rename = await api("/documents/" + id, "PATCH", { version: d.version, title: "接口协议", folder_id: folder.id, owner: "成员乙" }, "bob");
  assert.equal(rename.status, 200); d = rename.data.document; assert.equal(d.id, id);
  assert.equal((await api("/projects/p1/documents?q=联调")).data.documents[0].id, id);
  const pub = await api("/documents/" + id + "/publish", "POST", { version: d.version, version_id: v1 }, "bob"); d = pub.data.document;
  const release = await api("/projects/p1/releases", "POST", { name: "首次交付 R1", items: [{ document_id: id, version_id: v1 }] }); assert.equal(release.status, 201);
  const r1 = await fetch(base + "/releases/" + release.data.id + "/download", { headers: { "X-User": "bob" } }); const originalZip = Buffer.from(await r1.arrayBuffer());
  assert.equal(originalZip.readUInt32LE(0), 0x04034b50); assert.ok(originalZip.includes(content)); assert.ok(originalZip.includes(Buffer.from('"version_id": "' + v1)));
  const second = await upload(Buffer.from("接口说明 V2"), { document_id: id, base_version_id: v1 });
  assert.equal(second.status, 201); assert.equal(second.data.conflict, false); d = second.data.document;
  assert.equal(d.published_version_id, v1); assert.equal(d.current_version_id, second.data.version_id);
  const r2 = await fetch(base + "/releases/" + release.data.id + "/download", { headers: { "X-User": "alice" } }); assert.deepEqual(Buffer.from(await r2.arrayBuffer()), originalZip);
  assert.throws(() => db.prepare("UPDATE document_versions SET filename='changed' WHERE id=?").run(v1), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM document_versions WHERE id=?").run(v1), /immutable/);
  assert.throws(() => db.prepare("UPDATE document_releases SET name='changed'").run(), /immutable/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO document_versions SELECT * FROM document_versions WHERE id=?").run(v1), /immutable/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO document_releases SELECT * FROM document_releases WHERE id=?").run(release.data.id), /immutable/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO document_release_items SELECT * FROM document_release_items WHERE release_id=?").run(release.data.id), /immutable/);
  const restored = await api("/documents/" + id + "/restore-version", "POST", { version: d.version, version_id: v1 }); assert.equal(restored.status, 200); d = restored.data.document;
  assert.equal(d.current_version.number, 3); assert.equal(d.current_version.restored_from, v1);
  const del = await api("/documents/" + id, "DELETE", { version: d.version }, "bob"); assert.equal(del.status, 200);
  assert.equal((await api("/projects/p1/documents")).data.documents.length, 0);
  assert.equal((await api("/projects/p1/documents?deleted=1")).data.documents[0].id, id);
  const restoredDoc = await api("/documents/" + id + "/restore", "POST", { version: del.data.version }); assert.equal(restoredDoc.status, 200);
  assert.equal((await api("/documents/" + id)).data.versions.length, 3);
  installDocumentSchema(db); docs.installSchema();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM resource_events").get().n > 10, true);
});

test("stale upload creates a preserved candidate, checkout takeover is logged, optimistic edits conflict", async (t) => {
  const { api, upload, db } = await fixture(t);
  const first = (await upload()).data, id = first.document_id, v1 = first.version_id;
  const checkout = await api("/documents/" + id + "/checkout", "POST", { version: first.document.version }); assert.equal(checkout.status, 200);
  const second = await upload(Buffer.from("乙的修改"), { document_id: id, base_version_id: v1 }, "bob"); assert.equal(second.data.conflict, true); assert.equal(second.data.document.current_version_id, v1);
  let d = second.data.document;
  assert.equal((await api("/documents/" + id + "/checkout", "POST", { version: d.version }, "bob")).status, 409);
  assert.equal((await api("/documents/" + id + "/checkout", "POST", { version: d.version, takeover: true, reason: "原修改人已转交" }, "bob")).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM resource_events WHERE action='takeover-checkout'").get().n, 1);
  const newer = await upload(Buffer.from("乙的新工作版"), { document_id: id, base_version_id: v1 }, "bob"); assert.equal(newer.data.conflict, false); d = newer.data.document;
  const stale = await upload(Buffer.from("甲基于旧版本的修改"), { document_id: id, base_version_id: v1 }); assert.equal(stale.data.conflict, true); assert.equal(stale.data.document.current_version_id, newer.data.version_id); d = stale.data.document;
  assert.equal((await api("/documents/" + id + "/publish", "POST", { version: d.version, version_id: stale.data.version_id })).status, 409);
  const adopted = await api("/documents/" + id + "/select-version", "POST", { version: d.version, version_id: stale.data.version_id }); assert.equal(adopted.data.document.current_version_id, stale.data.version_id);
  assert.equal((await api("/documents/" + id, "PATCH", { version: d.version, title: "旧编辑" })).status, 409);
  assert.equal((await api("/documents/" + id)).data.versions.length, 4);
});

test("multipart upload resume, idempotence, checksums, deduplication, cancellation and session isolation", async (t) => {
  const { api, chunk, upload, docs, db, dataDir } = await fixture(t);
  const content = Buffer.alloc(CHUNK_SIZE + 19, 77);
  const init = await api("/uploads", "POST", { project_id: "p1", filename: "录音.bin", size: content.length, client_id: "resume-test" }); const id = init.data.id;
  assert.equal((await chunk(id, 1, content.subarray(CHUNK_SIZE))).status, 200);
  const restarted = createDocuments({ db, dataDir }); assert.ok(restarted.store);
  assert.deepEqual((await api("/uploads/" + id)).data.received_parts, [1]);
  assert.equal((await api("/uploads/" + id, "GET", undefined, "bob")).status, 404);
  assert.equal((await chunk(id, 0, content.subarray(0, CHUNK_SIZE), "bob")).status, 404);
  assert.equal((await api("/uploads/" + id + "/complete", "POST", {})).status, 409);
  assert.equal((await chunk(id, 0, content.subarray(0, CHUNK_SIZE))).status, 200);
  assert.equal((await chunk(id, 0, content.subarray(0, CHUNK_SIZE))).data.repeated, true);
  assert.equal((await chunk(id, 0, Buffer.alloc(CHUNK_SIZE, 1))).status, 409);
  assert.equal((await api("/uploads/" + id + "/complete", "POST", { sha256: "a".repeat(64) })).status, 400);
  const completed = await api("/uploads/" + id + "/complete", "POST", {}); assert.equal(completed.status, 201);
  const retry = await api("/uploads/" + id + "/complete", "POST", {}); assert.equal(retry.data.version_id, completed.data.version_id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_versions").get().n, 1);
  const duplicate = await upload(content, { filename: "复制件.bin" }); assert.equal(duplicate.data.deduplicated, true); assert.equal(duplicate.data.duplicate.document_id, completed.data.document_id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_blobs").get().n, 1);
  const cancel = await api("/uploads", "POST", { project_id: "p1", filename: "取消.bin", size: 8 });
  assert.equal((await api("/uploads/" + cancel.data.id + "/cancel", "POST", {})).status, 200);
  assert.equal((await chunk(cancel.data.id, 0, Buffer.alloc(8))).status, 409);
  assert.equal(await fs.stat(path.join(docs.store.uploadDir(id))).catch(() => null), null);
});

test("file limits, directory traversal and cycles, preview signatures, Range and audit transaction failure", async (t) => {
  const { api, upload, base, db } = await fixture(t, { maxFileBytes: 1024, quotaBytes: 1024 });
  assert.equal((await api("/uploads", "POST", { project_id: "p1", filename: "too-big", size: 1025 })).status, 413);
  for (const filename of ["../passwd", "a\\b", "..", "bad\u0000name"]) assert.equal((await api("/uploads", "POST", { project_id: "p1", filename, size: 1 })).status, 400);
  assert.equal((await api("/uploads", "POST", { project_id: "p1", filename: "normal", source_path: "../secret", size: 1 })).status, 400);
  const parent = (await api("/projects/p1/folders", "POST", { name: "父目录" })).data.folder;
  const child = (await api("/projects/p1/folders", "POST", { name: "子目录", parent_id: parent.id })).data.folder;
  assert.equal((await api("/folders/" + parent.id, "PATCH", { version: parent.version, parent_id: child.id })).status, 400);
  assert.equal((await api("/projects/p2/folders", "POST", { name: "错误目录", parent_id: parent.id })).status, 400);
  assert.equal((await api("/uploads", "POST", { project_id: "p2", filename: "跨项目.txt", size: 1, folder_id: parent.id })).status, 400);
  const content = Buffer.from("0123456789"); const first = (await upload(content, { filename: "text.pdf" })).data;
  const href = base + `/documents/${first.document_id}/versions/${first.version_id}`;
  assert.equal((await fetch(href + "/preview", { headers: { "X-User": "alice" } })).status, 415);
  const ranged = await fetch(href + "/download", { headers: { "X-User": "alice", Range: "bytes=2-5" } }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), "2345");
  const suffix = await fetch(href + "/download", { headers: { "X-User": "alice", Range: "bytes=-2" } }); assert.equal(await suffix.text(), "89");
  assert.equal((await fetch(href + "/download", { headers: { "X-User": "alice", Range: "bytes=20-" } })).status, 416);
  const reservation = await api("/uploads", "POST", { project_id: "p1", filename: "reserve", size: 1014 }); assert.equal(reservation.status, 201);
  assert.equal((await api("/uploads", "POST", { project_id: "p1", filename: "overflow", size: 1 })).status, 413);
  await api("/uploads/" + reservation.data.id + "/cancel", "POST", {});
  db.exec("CREATE TRIGGER test_document_log_failure BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'test-log-failure'); END;");
  const patch = await api("/documents/" + first.document_id, "PATCH", { version: first.document.version, title: "不能漏审计的修改" }); assert.equal(patch.status, 500);
  const deniedDownload = await fetch(href + "/download", { headers: { "X-User": "alice" } }); assert.equal(deniedDownload.status, 500); assert.ok(!(await deniedDownload.text()).includes("0123456789"));
  db.exec("DROP TRIGGER test_document_log_failure");
  assert.equal((await api("/documents/" + first.document_id)).data.document.title, first.document.title);
});

test("handover checklist distinguishes missing, draft, fixed accepted versions and published-following references", async (t) => {
  const { api, upload } = await fixture(t);
  const create = await api("/projects/p1/deliverables", "POST", { title: "部署手册", owner: "成员甲" });
  assert.equal(create.status, 201); let item = create.data.item; assert.equal(item.status, "missing");
  assert.equal((await api("/projects/p1/deliverables", "GET", undefined, "")).status, 401);
  const first = (await upload(Buffer.from("部署步骤"), { title: "部署手册" })).data;
  let patch = await api("/deliverables/" + item.id, "PATCH", { version: item.version, document_id: first.document_id });
  item = patch.data.item; assert.equal(item.status, "draft"); assert.equal(item.reference_mode, "published");
  patch = await api("/deliverables/" + item.id, "PATCH", { version: item.version, version_id: first.version_id }); item = patch.data.item;
  assert.equal(item.status, "ready"); assert.equal(item.reference_mode, "fixed"); assert.equal(item.resolved_version_id, first.version_id);
  assert.equal((await api("/deliverables/" + item.id, "PATCH", { version: item.version - 1, applicable: false })).status, 409);
  patch = await api("/deliverables/" + item.id, "PATCH", { version: item.version, applicable: false }); item = patch.data.item;
  assert.equal(item.status, "not-applicable");
  assert.equal((await api("/projects/p2/deliverables", "POST", { title: "不正确", document_id: first.document_id })).status, 400);
  const pub = await api("/documents/" + first.document_id + "/publish", "POST", { version: first.document.version, version_id: first.version_id }); assert.equal(pub.status, 200);
  patch = await api("/deliverables/" + item.id, "PATCH", { version: item.version, applicable: true, version_id: null }); item = patch.data.item;
  assert.equal(item.status, "ready"); assert.equal(item.reference_mode, "published");
  await api("/documents/" + first.document_id, "DELETE", { version: pub.data.document.version });
  assert.equal((await api("/projects/p1/deliverables")).data.items[0].status, "missing");
  assert.equal((await api("/deliverables/" + item.id, "DELETE", { version: item.version }, "bob")).status, 200);
  assert.equal((await api("/projects/p1/deliverables")).data.items.length, 0);
});

test("failed completion retains accounted orphan for retry; expired sessions release quota and private chunks", async (t) => {
  const { api, chunk, db, docs } = await fixture(t);
  const content = Buffer.from("保留直到审核完成");
  const init = await api("/uploads", "POST", { project_id: "p1", filename: "retry.txt", size: content.length });
  const id = init.data.id; await chunk(id, 0, content);
  db.exec("CREATE TRIGGER test_completion_failure BEFORE INSERT ON resource_events BEGIN SELECT RAISE(ABORT,'test-completion-failure'); END;");
  assert.equal((await api("/uploads/" + id + "/complete", "POST", {})).status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_blob_orphans").get().n, 1);
  assert.equal((await api("/projects/p1/documents")).data.storage.orphan_bytes, content.length);
  db.exec("DROP TRIGGER test_completion_failure");
  assert.equal((await api("/uploads/" + id + "/complete", "POST", {})).status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_blob_orphans").get().n, 0);
  const expired = await api("/uploads", "POST", { project_id: "p1", filename: "expired.txt", size: 3 });
  await chunk(expired.data.id, 0, Buffer.from("old"));
  db.prepare("UPDATE document_uploads SET expires='2000-01-01T00:00:00.000Z' WHERE id=?").run(expired.data.id);
  await api("/uploads", "POST", { project_id: "p1", filename: "new-empty.txt", size: 0 });
  assert.equal((await api("/uploads/" + expired.data.id)).data.status, "expired");
  assert.equal(await fs.stat(docs.store.uploadDir(expired.data.id)).catch(() => null), null);
  const altered = await api("/uploads", "POST", { project_id: "p1", filename: "changed.txt", size: 3 });
  await chunk(altered.data.id, 0, Buffer.from("one"));
  await fs.writeFile(path.join(docs.store.uploadDir(altered.data.id), "0"), Buffer.from("two"));
  assert.equal((await api("/uploads/" + altered.data.id + "/complete", "POST", {})).status, 409);
});

test("physical disk watermark denies chunks and assembly with 507, before creating partial originals", async (t) => {
  const { api, chunk, db, docs } = await fixture(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const init = await api("/uploads", "POST", { project_id: "p1", filename: "disk-full.txt", size: 3 });
  const denied = await chunk(init.data.id, 0, Buffer.from("one"));
  assert.equal(denied.status, 507); assert.match(denied.data.error, /磁盘空间不足/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_upload_parts").get().n, 0);
  const empty = await api("/uploads", "POST", { project_id: "p1", filename: "empty.txt", size: 0 });
  assert.equal((await api("/uploads/" + empty.data.id + "/complete", "POST", {})).status, 507);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_versions").get().n, 0);
  assert.deepEqual(await fs.readdir(path.join(docs.store.root, "blobs")), []);
});

test("disk reservations include concurrent writes and release capacity after success", async (t) => {
  const { docs } = await fixture(t, { minFreeBytes: 0 });
  const originalStatfs = fs.statfs;
  fs.statfs = async () => ({ bavail: 100n, bsize: 1n });
  let finish, started;
  const start = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  let first;
  try {
    first = docs.store.writeChunk("parallel-first", 0, Readable.from((async function* () { yield Buffer.alloc(60); started(); await pending; })()), 60);
    await start;
    await assert.rejects(docs.store.writeChunk("parallel-second", 0, Readable.from([Buffer.alloc(60)]), 60), (e) => e.status === 507);
    finish(); await first;
    assert.equal((await docs.store.writeChunk("parallel-third", 0, Readable.from([Buffer.alloc(60)]), 60)).size, 60);
  } finally { finish(); await first?.catch(() => {}); fs.statfs = originalStatfs; }
});

test("ZIP32 capacity preflight counts manifest, UTF-8 paths, descriptors and central directory", () => {
  const entries = [{ name: "manifest.json", buffer: Buffer.from("{}\n") }, { name: "资料/说明.txt", size: 123 }];
  const expected = 22 + entries.reduce((sum, entry) => sum + 30 + 16 + 46 + 2 * Buffer.byteLength(entry.name) + (entry.buffer?.length ?? entry.size), 0);
  assert.equal(zip32Size(entries), expected);
  assert.throws(() => zip32Size([{ name: "large.bin", size: 0x100000000 }]), (e) => e.status === 413);
  assert.throws(() => zip32Size([{ name: "almost-limit.bin", size: 0xffffffff - 10 }]), (e) => e.status === 413);
  assert.throws(() => zip32Size([{ name: "a", size: 3000000000 }, { name: "b", size: 2000000000 }]), (e) => e.status === 413);
  assert.throws(() => zip32Size(Array.from({ length: 65536 }, () => ({ name: "a", size: 0 }))), (e) => e.status === 413);
});
