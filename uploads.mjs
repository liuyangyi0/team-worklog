import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CHUNK_SIZE, safeFilename } from "./storage.mjs";
import { libraryFail as fail, libraryTx as tx } from "./library-common.mjs";

export function installUploadSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_uploads(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), document_id TEXT,
    creator_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL, size INTEGER NOT NULL,
    base_version_id TEXT, metadata_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created TEXT NOT NULL, expires TEXT NOT NULL, client_id TEXT, result_json TEXT, cleanup_done INTEGER NOT NULL DEFAULT 0,
    UNIQUE(creator_id,client_id));
    CREATE TABLE IF NOT EXISTS document_upload_parts(upload_id TEXT NOT NULL REFERENCES document_uploads(id),part INTEGER NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(upload_id,part));
    CREATE INDEX IF NOT EXISTS document_uploads_status ON document_uploads(status,expires);
    CREATE TABLE IF NOT EXISTS document_blob_orphans(sha256 TEXT PRIMARY KEY,size INTEGER NOT NULL,created TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(document_uploads)").all().some((column) => column.name === "cleanup_done")) db.exec("ALTER TABLE document_uploads ADD COLUMN cleanup_done INTEGER NOT NULL DEFAULT 0");
}
export function createUploads({ db, store, project, document, metadata, complete, event }) {
  installUploadSchema(db);
  const get = (id, user, active = true) => {
    if (!user) fail(401, "请先登录后访问项目资料");
    const row = db.prepare("SELECT * FROM document_uploads WHERE id=?").get(id);
    if (!row || row.creator_id !== user.id) fail(404, "上传会话不存在");
    if (active && (row.status !== "active" || row.expires < new Date().toISOString())) fail(409, "上传会话已结束或过期，请重新上传");
    return row;
  };
  const summary = (row) => ({ id: row.id, chunk_size: CHUNK_SIZE, received_parts: db.prepare("SELECT part FROM document_upload_parts WHERE upload_id=? ORDER BY part").all(row.id).map((p) => p.part), total_parts: Math.ceil(row.size / CHUNK_SIZE), status: row.status === "active" && row.expires < new Date().toISOString() ? "expired" : row.status, size: row.size, filename: row.filename, expires: row.expires, ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) });
  async function cleanup() {
    db.prepare("UPDATE document_uploads SET status='expired' WHERE status='active' AND expires<?").run(new Date().toISOString());
    // Only session UUIDs from this database are removed, never arbitrary supplied paths.
    for (const row of db.prepare("SELECT id FROM document_uploads WHERE status IN ('expired','cancelled','complete') AND cleanup_done=0 ORDER BY created LIMIT 100").all()) {
      await store.lock(row.id, async () => {
        await fs.rm(store.uploadDir(row.id), { recursive: true, force: true });
        db.prepare("UPDATE document_uploads SET cleanup_done=1 WHERE id=?").run(row.id);
      }).catch(() => {});
    }
  }
  async function api({ route, method, b = {}, user }) {
    if (route === "/uploads" && method === "POST") {
      if (!user) fail(401, "请先登录后上传项目资料");
      await cleanup();
      project(b.project_id);
      const filename = safeFilename(b.filename);
      if (!Number.isSafeInteger(b.size) || b.size < 0 || b.size > store.maximum) fail(413, "文件超过单文件限制");
      const doc = b.document_id ? document(b.document_id) : null;
      if (doc && doc.project_id !== b.project_id) fail(400, "文档不属于该项目");
      if (doc && (typeof b.base_version_id !== "string" || !db.prepare("SELECT id FROM document_versions WHERE id=? AND document_id=?").get(b.base_version_id, doc.id))) fail(400, "上传新版本必须指定有效的基于版本");
      const meta = metadata(b, doc);
      const clientId = b.client_id ?? null;
      if (clientId !== null && (typeof clientId !== "string" || !/^[\w-]{1,100}$/.test(clientId))) fail(400, "上传标识无效");
      if (clientId) {
        const old = db.prepare("SELECT * FROM document_uploads WHERE creator_id=? AND client_id=?").get(user.id, clientId);
        if (old) {
          if (old.project_id !== b.project_id || old.filename !== filename || old.size !== b.size || old.document_id !== (doc?.id || null) || old.base_version_id !== (doc ? b.base_version_id : null) || old.metadata_json !== JSON.stringify(meta)) fail(409, "上传标识已经用于另一个文件");
          return { data: summary(old) };
        }
      }
      const row = tx(db, () => {
        db.prepare("UPDATE document_uploads SET status='expired' WHERE status='active' AND expires<?").run(new Date().toISOString());
        const used = db.prepare("SELECT (SELECT COALESCE(SUM(size),0) FROM document_blobs)+(SELECT COALESCE(SUM(size),0) FROM document_blob_orphans o WHERE NOT EXISTS(SELECT 1 FROM document_blobs b WHERE b.sha256=o.sha256)) n").get().n;
        const reserved = db.prepare("SELECT COALESCE(SUM(size),0) n FROM document_uploads WHERE status='active'").get().n;
        if (used + reserved + b.size > store.quota) fail(413, "文件存储配额不足，请整理上传会话或联系管理员");
        const id = randomUUID(), created = new Date().toISOString(), expires = new Date(Date.now() + 48 * 3600000).toISOString();
        db.prepare("INSERT INTO document_uploads(id,project_id,document_id,creator_id,filename,size,base_version_id,metadata_json,created,expires,client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, b.project_id, doc?.id || null, user.id, filename, b.size, doc ? b.base_version_id : null, JSON.stringify(meta), created, expires, clientId);
        return db.prepare("SELECT * FROM document_uploads WHERE id=?").get(id);
      });
      return { status: 201, data: summary(row) };
    }
    const match = route.match(/^\/uploads\/([\w-]+)(?:\/(complete|cancel))?$/);
    if (!match) return null;
    const row = get(match[1], user, false);
    if (!match[2] && method === "GET") return { data: summary(row) };
    if (match[2] === "cancel" && method === "POST") return store.lock(row.id, async () => {
      const current = get(row.id, user, false);
      if (current.status === "complete") fail(409, "文件已完成入库，不能取消");
      tx(db, () => { db.prepare("UPDATE document_uploads SET status='cancelled' WHERE id=?").run(row.id); event(user, "cancel-upload", row.id, row.project_id, { filename: row.filename }); });
      await fs.rm(store.uploadDir(row.id), { recursive: true, force: true });
      db.prepare("UPDATE document_uploads SET cleanup_done=1 WHERE id=?").run(row.id);
      return { data: { ok: true } };
    });
    if (match[2] === "complete" && method === "POST") return store.lock(row.id, async () => {
      const current = get(row.id, user, false);
      if (current.status === "complete") return { data: JSON.parse(current.result_json) };
      get(row.id, user);
      if (b.sha256 !== undefined && (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256))) fail(400, "文件校验值无效");
      const parts = db.prepare("SELECT part,size,sha256 FROM document_upload_parts WHERE upload_id=? ORDER BY part").all(row.id);
      const total = Math.ceil(row.size / CHUNK_SIZE);
      if (parts.length !== total || parts.some((p, i) => p.part !== i || p.size !== Math.min(CHUNK_SIZE, row.size - i * CHUNK_SIZE))) fail(409, "还有分片未上传，请继续上传后再提交");
      const blob = await store.assemble(row.id, parts, row.size, b.sha256);
      // A failed metadata/audit transaction must leave this immutable object accounted for.
      // Orphans are retained for explicit review; no automatic blob deletion can race backups.
      if (!db.prepare("SELECT sha256 FROM document_blobs WHERE sha256=?").get(blob.sha256)) db.prepare("INSERT OR IGNORE INTO document_blob_orphans(sha256,size,created) VALUES(?,?,?)").run(blob.sha256, blob.size, new Date().toISOString());
      const result = tx(db, () => {
        // Assembly can overlap cleanup or cross the expiry time while holding the
        // session lock. Keep the assembled orphan accounted for, but never commit
        // a document after the session has become expired or cancelled.
        const fresh = get(row.id, user);
        const result = complete(fresh, blob, user);
        db.prepare("DELETE FROM document_blob_orphans WHERE sha256=?").run(blob.sha256);
        return result;
      });
      await fs.rm(store.uploadDir(row.id), { recursive: true, force: true }).then(() => db.prepare("UPDATE document_uploads SET cleanup_done=1 WHERE id=?").run(row.id)).catch(() => {});
      return { status: 201, data: result };
    });
    fail(405, "不支持的上传操作");
  }
  async function binary({ route, method, req, user, json }) {
    const match = route.match(/^\/uploads\/([\w-]+)\/chunks\/(\d+)$/);
    if (!match) return false;
    if (method !== "PUT") fail(405, "不支持的分片操作");
    if (!String(req.headers["content-type"] || "").startsWith("application/octet-stream")) fail(415, "分片必须使用二进制格式");
    await store.lock(match[1], async () => {
      const row = get(match[1], user);
      const part = Number(match[2]), total = Math.ceil(row.size / CHUNK_SIZE);
      if (!Number.isSafeInteger(part) || part < 0 || part >= total) fail(400, "上传分片序号无效");
      const expected = Math.min(CHUNK_SIZE, row.size - part * CHUNK_SIZE);
      const declared = req.headers["content-length"];
      if (declared !== undefined && Number(declared) !== expected) fail(400, "分片长度与预期不符");
      const chunk = await store.writeChunk(row.id, part, req, expected);
      try {
        const prior = db.prepare("SELECT sha256 FROM document_upload_parts WHERE upload_id=? AND part=?").get(row.id, part);
        if (prior) {
          if (prior.sha256 !== chunk.sha256) fail(409, "该分片已上传且内容不同，请新建上传会话");
          json({ ok: true, part, sha256: prior.sha256, repeated: true }); return;
        }
        // Rename first. If the subsequent DB insert fails, retry safely replaces this uncommitted chunk.
        await fs.rename(chunk.path, path.join(store.uploadDir(row.id), String(part)));
        db.prepare("INSERT INTO document_upload_parts(upload_id,part,size,sha256) VALUES(?,?,?,?)").run(row.id, part, chunk.size, chunk.sha256);
        json({ ok: true, part, sha256: chunk.sha256 });
      } finally { await fs.rm(chunk.path, { force: true }); }
    });
    return true;
  }
  return { api, binary, cleanup };
}
