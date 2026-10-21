import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { libraryFail as fail, libraryTx as tx, resourceEvent } from "./library-common.mjs";
import { createStorage, safeFilename, relativeParts, streamZip, zip32Size } from "./storage.mjs";
import { createUploads } from "./uploads.mjs";

const now = () => new Date().toISOString();
const text = (value, name, maximum, fallback = "") => {
  value = value === undefined ? fallback : value;
  if (typeof value !== "string" || value.trim().length > maximum || /\x00/.test(value)) fail(400, name + "无效");
  return value.trim();
};
export function installDocumentSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_folders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT REFERENCES document_folders(id),name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS document_folder_names ON document_folders(project_id,COALESCE(parent_id,''),name) WHERE deleted=0;
    CREATE TABLE IF NOT EXISTS document_blobs(sha256 TEXT PRIMARY KEY,size INTEGER NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),folder_id TEXT REFERENCES document_folders(id),title TEXT NOT NULL,category TEXT NOT NULL DEFAULT '待整理',tags TEXT NOT NULL DEFAULT '[]',description TEXT NOT NULL DEFAULT '',owner TEXT NOT NULL DEFAULT '',task_id TEXT,resource_id TEXT,environment TEXT NOT NULL DEFAULT '',source_path TEXT NOT NULL DEFAULT '',current_version_id TEXT,published_version_id TEXT,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,sensitive INTEGER NOT NULL DEFAULT 0,creator TEXT NOT NULL REFERENCES users(id),created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id,deleted,folder_id);
    CREATE TABLE IF NOT EXISTS document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),number INTEGER NOT NULL,base_version_id TEXT,filename TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL REFERENCES document_blobs(sha256),blob_hash TEXT NOT NULL,created_by TEXT NOT NULL,creator_id TEXT NOT NULL REFERENCES users(id),created TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',conflict INTEGER NOT NULL DEFAULT 0,restored_from TEXT,UNIQUE(document_id,number));
    CREATE TABLE IF NOT EXISTS document_checkouts(document_id TEXT PRIMARY KEY REFERENCES documents(id),user_id TEXT NOT NULL REFERENCES users(id),user_name TEXT NOT NULL,base_version_id TEXT NOT NULL,created TEXT NOT NULL,expires TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_releases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,created TEXT NOT NULL,created_by TEXT NOT NULL,creator_id TEXT NOT NULL REFERENCES users(id),manifest_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_release_items(release_id TEXT NOT NULL REFERENCES document_releases(id),document_id TEXT NOT NULL REFERENCES documents(id),version_id TEXT NOT NULL REFERENCES document_versions(id),PRIMARY KEY(release_id,document_id));
    CREATE TABLE IF NOT EXISTS document_release_voids(release_id TEXT PRIMARY KEY REFERENCES document_releases(id),reason TEXT NOT NULL,created TEXT NOT NULL,created_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_deliverables(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,owner TEXT NOT NULL DEFAULT '',applicable INTEGER NOT NULL DEFAULT 1,document_id TEXT REFERENCES documents(id),version_id TEXT REFERENCES document_versions(id),version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS document_deliverables_project ON document_deliverables(project_id,deleted);
    CREATE TRIGGER IF NOT EXISTS document_versions_immutable_update BEFORE UPDATE ON document_versions BEGIN SELECT RAISE(ABORT,'Document versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_versions_immutable_delete BEFORE DELETE ON document_versions BEGIN SELECT RAISE(ABORT,'Document versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_versions_immutable_replace BEFORE INSERT ON document_versions WHEN EXISTS(SELECT 1 FROM document_versions WHERE id=NEW.id OR (document_id=NEW.document_id AND number=NEW.number)) BEGIN SELECT RAISE(ABORT,'Document versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_releases_immutable_update BEFORE UPDATE ON document_releases BEGIN SELECT RAISE(ABORT,'Document releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_releases_immutable_delete BEFORE DELETE ON document_releases BEGIN SELECT RAISE(ABORT,'Document releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_releases_immutable_replace BEFORE INSERT ON document_releases WHEN EXISTS(SELECT 1 FROM document_releases WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'Document releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_items_immutable_update BEFORE UPDATE ON document_release_items BEGIN SELECT RAISE(ABORT,'Document release items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_items_immutable_delete BEFORE DELETE ON document_release_items BEGIN SELECT RAISE(ABORT,'Document release items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_items_immutable_replace BEFORE INSERT ON document_release_items WHEN EXISTS(SELECT 1 FROM document_release_items WHERE release_id=NEW.release_id AND document_id=NEW.document_id) BEGIN SELECT RAISE(ABORT,'Document release items are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_voids_immutable_update BEFORE UPDATE ON document_release_voids BEGIN SELECT RAISE(ABORT,'Release void events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_voids_immutable_delete BEFORE DELETE ON document_release_voids BEGIN SELECT RAISE(ABORT,'Release void events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS document_release_voids_immutable_replace BEFORE INSERT ON document_release_voids WHEN EXISTS(SELECT 1 FROM document_release_voids WHERE release_id=NEW.release_id) BEGIN SELECT RAISE(ABORT,'Release void events are immutable'); END;`);
}

export function createDocuments({ db, dataDir, filesDir, maxFileBytes, quotaBytes, minFreeBytes }) {
  installDocumentSchema(db);
  const store = createStorage({ dataDir, filesDir, maxFileBytes, quotaBytes, minFreeBytes });
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const auth = (user) => { if (!user) fail(401, "请先登录后访问项目资料"); };
  const project = (id) => { const p = typeof id === "string" && get("SELECT id,name FROM projects WHERE id=?", id); if (!p) fail(404, "项目不存在"); return p; };
  const document = (id, deleted = false) => { if (typeof id !== "string") fail(400, "文档编号无效"); const d = get("SELECT * FROM documents WHERE id=?", id); if (!d || (!deleted && d.deleted)) fail(404, "文档不存在或已删除"); return d; };
  const folder = (id, projectId) => { if (!id) return null; if (typeof id !== "string") fail(400, "目录编号无效"); const f = get("SELECT * FROM document_folders WHERE id=? AND deleted=0", id); if (!f || f.project_id !== projectId) fail(400, "目录不存在或不属于该项目"); return f; };
  const checkVersion = (d, b) => { if (!Number.isInteger(b.version) || b.version !== d.version) fail(409, "资料已被修改，请刷新后重试"); };
  const version = (docId, id) => { if (typeof id !== "string") fail(400, "文件版本编号无效"); const v = get("SELECT * FROM document_versions WHERE id=? AND document_id=?", id, docId); if (!v) fail(404, "文件版本不存在"); return v; };
  const event = (user, action, id, projectId, details = {}) => resourceEvent(db, user, { action, entityType: "document", entityId: id, projectId, details });
  const exposeVersion = (v) => v ? { id: v.id, document_id: v.document_id, number: v.number, base_version_id: v.base_version_id, filename: v.filename, size: v.size, sha256: v.sha256, created: v.created, created_by: v.created_by, creator_id: v.creator_id, note: v.note, conflict: Boolean(v.conflict), restored_from: v.restored_from } : null;
  const expose = (d) => {
    const current = d.current_version_id ? exposeVersion(version(d.id, d.current_version_id)) : null;
    const published = d.published_version_id ? exposeVersion(version(d.id, d.published_version_id)) : null;
    return { ...d, tags: JSON.parse(d.tags), working_version_id: d.current_version_id, current_version: current, published_version: published, size: current?.size || 0, filename: current?.filename || "", version_count: get("SELECT COUNT(*) n FROM document_versions WHERE document_id=?", d.id).n, conflict_count: get("SELECT COUNT(*) n FROM document_versions WHERE document_id=? AND conflict=1 AND number>(SELECT COALESCE(MAX(number),0) FROM document_versions WHERE id=?)", d.id, d.current_version_id).n };
  };
  function metadata(b, old) {
    const projectId = old?.project_id || b.project_id;
    const folderId = b.folder_id === undefined ? old?.folder_id || null : b.folder_id || null;
    if (folderId !== null && typeof folderId !== "string") fail(400, "目录编号无效");
    folder(folderId, projectId);
    const title = text(b.title, "文档名称", 240, old?.title || b.filename || "");
    if (!title) fail(400, "请填写文档名称");
    let tags = b.tags === undefined ? JSON.parse(old?.tags || "[]") : b.tags;
    if (!Array.isArray(tags) || tags.length > 20 || tags.some((t) => typeof t !== "string" || !t.trim() || t.trim().length > 30)) fail(400, "标签最多 20 个，每个 1–30 字");
    tags = [...new Set(tags.map((t) => t.trim()))];
    const taskId = b.task_id === undefined ? old?.task_id || null : b.task_id || null;
    const resourceId = b.resource_id === undefined ? old?.resource_id || null : b.resource_id || null;
    if (taskId && (typeof taskId !== "string" || !get("SELECT id FROM records WHERE id=? AND project_id=? AND (deleted=0 OR ?)", taskId, projectId, Number(taskId === old?.task_id)))) fail(400, "关联任务无效或不属于该项目");
    if (resourceId) {
      if (typeof resourceId !== "string" || !get("SELECT name FROM sqlite_master WHERE type='table' AND name='resources'")) fail(400, "关联资源无效");
      const linked = get("SELECT * FROM resources WHERE id=?", resourceId);
      if (!linked || (linked.deleted && resourceId !== old?.resource_id)) fail(400, "关联资源无效");
      // Sharing is stored on the resource itself, not in a resource_projects table.
      let sharedProjects = [];
      try { const ids = JSON.parse(linked.project_ids || "[]"); if (Array.isArray(ids)) sharedProjects = ids; } catch {}
      if (linked.project_id !== projectId && !sharedProjects.includes(projectId)) fail(400, "关联资源不属于该项目");
    }
    const sourcePath = text(b.source_path ?? b.relative_path, "来源路径", 1500, old?.source_path || "");
    if (sourcePath) relativeParts(sourcePath);
    return { title, folder_id: folderId, category: text(b.category, "类别", 80, old?.category || "待整理"), tags, description: text(b.description, "说明", 2000, old?.description || ""), owner: text(b.owner, "维护人", 100, old?.owner || ""), task_id: taskId, resource_id: resourceId, environment: text(b.environment, "环境", 100, old?.environment || ""), source_path: sourcePath, note: text(b.note, "修改说明", 1000) };
  }
  function saveMeta(id, m) { run("UPDATE documents SET title=?,folder_id=?,category=?,tags=?,description=?,owner=?,task_id=?,resource_id=?,environment=?,source_path=?,updated=?,version=version+1 WHERE id=?", m.title, m.folder_id, m.category, JSON.stringify(m.tags), m.description, m.owner, m.task_id, m.resource_id, m.environment, m.source_path, now(), id); }
  const uploads = createUploads({ db, store, project, document, metadata, event, complete(row, blob, user) {
    project(row.project_id);
    let d = row.document_id ? document(row.document_id) : null;
    const savedMeta = JSON.parse(row.metadata_json);
    // Uploads can stay open for hours. Recheck every association before creating
    // a document, while existing-document uploads only add a content version and
    // must not revive or validate a stale snapshot of its old metadata.
    const meta = d ? savedMeta : metadata({ ...savedMeta, project_id: row.project_id });
    const duplicate = get("SELECT d.id document_id,d.title FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.sha256=? AND d.project_id=? AND d.deleted=0 AND d.id<>? ORDER BY d.created LIMIT 1", blob.sha256, row.project_id, d?.id || "");
    const deduplicated = Boolean(get("SELECT sha256 FROM document_blobs WHERE sha256=?", blob.sha256));
    run("INSERT OR IGNORE INTO document_blobs(sha256,size,created) VALUES(?,?,?)", blob.sha256, blob.size, now());
    const checkout = d ? get("SELECT * FROM document_checkouts WHERE document_id=? AND expires>?", d.id, now()) : null;
    const conflict = Boolean(d && (d.current_version_id !== row.base_version_id || (checkout && checkout.user_id !== user.id)));
    const created = now();
    if (!d) {
      const id = randomUUID();
      run("INSERT INTO documents(id,project_id,folder_id,title,category,tags,description,owner,task_id,resource_id,environment,source_path,creator,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, row.project_id, meta.folder_id, meta.title, meta.category, JSON.stringify(meta.tags), meta.description, meta.owner || user.name, meta.task_id, meta.resource_id, meta.environment, meta.source_path, user.id, created, created);
      d = document(id);
    }
    const id = randomUUID(), number = get("SELECT COALESCE(MAX(number),0)+1 n FROM document_versions WHERE document_id=?", d.id).n;
    run("INSERT INTO document_versions(id,document_id,number,base_version_id,filename,size,sha256,blob_hash,created_by,creator_id,created,note,conflict) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, d.id, number, row.base_version_id, row.filename, blob.size, blob.sha256, blob.sha256, user.name, user.id, created, text(meta.note, "修改说明", 1000), Number(conflict));
    if (!conflict) run("UPDATE documents SET current_version_id=?,updated=?,version=version+1 WHERE id=?", id, created, d.id);
    else run("UPDATE documents SET updated=?,version=version+1 WHERE id=?", created, d.id);
    if (!conflict && checkout?.user_id === user.id) run("DELETE FROM document_checkouts WHERE document_id=?", d.id);
    event(user, conflict ? "upload-conflict" : "upload-version", d.id, d.project_id, { version_id: id, filename: row.filename, size: blob.size, sha256: blob.sha256, number, base_version_id: row.base_version_id });
    const result = { document_id: d.id, version_id: id, conflict, document: expose(document(d.id)), duplicate: duplicate || null, deduplicated };
    run("UPDATE document_uploads SET status='complete',result_json=? WHERE id=?", JSON.stringify(result), row.id);
    return result;
  } });

  async function api(input) {
    const route = input.route.replace(/^\/api(?=\/)/, "");
    const { method, b = {}, user } = input;
    const params = input.params || new URLSearchParams();
    if (!/^\/(?:documents|folders|uploads|releases|deliverables|projects\/[^/]+\/(?:documents|folders|releases|deliverables))(?:\/|$)/.test(route)) return null;
    auth(user);
    const uploadResult = await uploads.api({ ...input, route }); if (uploadResult) return uploadResult;
    const deliverableList = route.match(/^\/projects\/([\w-]+)\/deliverables$/);
    const deliverableItem = route.match(/^\/deliverables\/([\w-]+)$/);
    if (deliverableList || deliverableItem) {
      const old = deliverableItem ? get("SELECT * FROM document_deliverables WHERE id=? AND deleted=0", deliverableItem[1]) : null;
      if (deliverableItem && !old) fail(404, "交接清单条目不存在");
      const projectId = old?.project_id || deliverableList[1]; project(projectId);
      const present = (item) => {
        const d = item.document_id ? get("SELECT * FROM documents WHERE id=?", item.document_id) : null;
        const resolvedId = item.version_id || d?.published_version_id || null;
        const v = d && resolvedId ? version(d.id, resolvedId) : null;
        const status = !item.applicable ? "not-applicable" : !d || d.deleted ? "missing" : resolvedId ? "ready" : "draft";
        return { ...item, applicable: Boolean(item.applicable), status, reference_mode: item.version_id ? "fixed" : "published", resolved_version_id: resolvedId, document_title: d?.title || "", document_deleted: Boolean(d?.deleted), filename: v?.filename || "", number: v?.number || null };
      };
      if (deliverableList && method === "GET") return { data: { items: all("SELECT * FROM document_deliverables WHERE project_id=? AND deleted=0 ORDER BY created,id", projectId).map(present) } };
      if ((deliverableList && method === "POST") || (deliverableItem && method === "PATCH")) {
        if (old) checkVersion(old, b);
        const title = text(b.title, "清单名称", 240, old?.title || ""); if (!title) fail(400, "请填写清单名称");
        const owner = text(b.owner, "维护人", 100, old?.owner || "");
        const applicable = b.applicable === undefined ? old?.applicable ?? true : b.applicable;
        if (![true, false, 0, 1].includes(applicable)) fail(400, "适用状态无效");
        const documentId = b.document_id === undefined ? old?.document_id || null : b.document_id || null;
        const versionId = b.version_id === undefined ? (documentId === old?.document_id ? old?.version_id || null : null) : b.version_id || null;
        if (documentId && typeof documentId !== "string") fail(400, "关联文档无效");
        if (documentId) { const d = document(documentId); if (d.project_id !== projectId || d.sensitive) fail(400, "只能关联当前项目的非敏感资料"); }
        if (versionId && (!documentId || typeof versionId !== "string")) fail(400, "固定版本必须关联有效文档");
        if (versionId) version(documentId, versionId);
        const id = old?.id || randomUUID();
        tx(db, () => {
          if (old) run("UPDATE document_deliverables SET title=?,owner=?,applicable=?,document_id=?,version_id=?,version=version+1,updated=? WHERE id=?", title, owner, Number(applicable), documentId, versionId, now(), id);
          else run("INSERT INTO document_deliverables(id,project_id,title,owner,applicable,document_id,version_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?)", id, projectId, title, owner, Number(applicable), documentId, versionId, now(), now());
          event(user, old ? "update-deliverable" : "create-deliverable", id, projectId, { title, document_id: documentId, version_id: versionId });
        });
        return { status: old ? 200 : 201, data: { item: present(get("SELECT * FROM document_deliverables WHERE id=?", id)), id } };
      }
      if (deliverableItem && method === "DELETE") {
        checkVersion(old, b);
        tx(db, () => { run("UPDATE document_deliverables SET deleted=1,version=version+1,updated=? WHERE id=?", now(), old.id); event(user, "delete-deliverable", old.id, projectId, { title: old.title }); });
        return { data: { ok: true } };
      }
      fail(405, "不支持的交接清单操作");
    }
    const listing = route.match(/^\/projects\/([\w-]+)\/documents$/);
    if (listing && method === "GET") {
      project(listing[1]);
      const deleted = params.get("deleted") === "1" ? 1 : 0;
      let docs = all("SELECT * FROM documents WHERE project_id=? AND deleted=? ORDER BY updated DESC,id", listing[1], deleted);
      const folderId = params.get("folder_id"), q = (params.get("q") || "").trim().toLowerCase();
      if (folderId !== null && folderId !== "all") docs = docs.filter((d) => (d.folder_id || "") === folderId);
      for (const key of ["category", "owner", "task_id", "resource_id", "environment"]) if (params.get(key)) docs = docs.filter((d) => d[key] === params.get(key));
      if (params.get("tag")) docs = docs.filter((d) => JSON.parse(d.tags).includes(params.get("tag")));
      if (q) docs = docs.filter((d) => [d.title, d.id, d.category, d.tags, d.description, d.owner, d.source_path, ...all("SELECT filename FROM document_versions WHERE document_id=?", d.id).map((v) => v.filename)].join(" ").toLowerCase().includes(q));
      return { data: { folders: all("SELECT * FROM document_folders WHERE project_id=? AND deleted=0 ORDER BY name,id", listing[1]), documents: docs.map(expose), storage: { used_bytes: get("SELECT (SELECT COALESCE(SUM(size),0) FROM document_blobs)+(SELECT COALESCE(SUM(size),0) FROM document_blob_orphans o WHERE NOT EXISTS(SELECT 1 FROM document_blobs b WHERE b.sha256=o.sha256)) n").n, orphan_bytes: get("SELECT COALESCE(SUM(size),0) n FROM document_blob_orphans o WHERE NOT EXISTS(SELECT 1 FROM document_blobs b WHERE b.sha256=o.sha256)").n, reserved_bytes: get("SELECT COALESCE(SUM(size),0) n FROM document_uploads WHERE status='active' AND expires>?", now()).n, quota_bytes: store.quota, max_file_bytes: store.maximum } } };
    }
    const folders = route.match(/^\/projects\/([\w-]+)\/folders$/);
    if (folders && method === "POST") {
      project(folders[1]); const name = safeFilename(b.name), parentId = b.parent_id || null; folder(parentId, folders[1]);
      let parent = parentId, level = 1;
      while (parent) { if (++level > 16) fail(400, "目录最多支持 16 层"); parent = get("SELECT parent_id FROM document_folders WHERE id=?", parent)?.parent_id; }
      if (get("SELECT id FROM document_folders WHERE project_id=? AND COALESCE(parent_id,'')=? AND name=? AND deleted=0", folders[1], parentId || "", name)) fail(409, "该目录已存在");
      const id = randomUUID();
      tx(db, () => { run("INSERT INTO document_folders(id,project_id,parent_id,name,created,updated) VALUES(?,?,?,?,?,?)", id, folders[1], parentId, name, now(), now()); event(user, "create-folder", id, folders[1], { name, parent_id: parentId }); });
      return { status: 201, data: { id, folder: get("SELECT * FROM document_folders WHERE id=?", id) } };
    }
    const fm = route.match(/^\/folders\/([\w-]+)$/);
    if (fm) {
      const f = get("SELECT * FROM document_folders WHERE id=? AND deleted=0", fm[1]); if (!f) fail(404, "目录不存在"); checkVersion(f, b);
      if (method === "PATCH") {
        const name = b.name === undefined ? f.name : safeFilename(b.name), parentId = b.parent_id === undefined ? f.parent_id : b.parent_id || null;
        folder(parentId, f.project_id);
        let p = parentId, depth = 0;
        while (p) { if (p === f.id || ++depth > 16) fail(400, "目录不能移动到自身子目录且最多支持 16 层"); p = get("SELECT parent_id FROM document_folders WHERE id=?", p)?.parent_id; }
        const subtreeDepth = get("WITH RECURSIVE tree(id,level) AS (SELECT id,1 FROM document_folders WHERE id=? UNION ALL SELECT f.id,t.level+1 FROM document_folders f JOIN tree t ON f.parent_id=t.id WHERE f.deleted=0) SELECT MAX(level) level FROM tree", f.id).level;
        if (depth + subtreeDepth > 16) fail(400, "移动后目录不能超过 16 层");
        if (get("SELECT id FROM document_folders WHERE project_id=? AND COALESCE(parent_id,'')=? AND name=? AND deleted=0 AND id<>?", f.project_id, parentId || "", name, f.id)) fail(409, "目标已有同名目录");
        tx(db, () => { run("UPDATE document_folders SET name=?,parent_id=?,updated=?,version=version+1 WHERE id=?", name, parentId, now(), f.id); event(user, "update-folder", f.id, f.project_id, { name, parent_id: parentId }); });
        return { data: { folder: get("SELECT * FROM document_folders WHERE id=?", f.id) } };
      }
      if (method === "DELETE") {
        if (get("SELECT id FROM document_folders WHERE parent_id=? AND deleted=0", f.id) || get("SELECT id FROM documents WHERE folder_id=?", f.id)) fail(409, "目录内仍有资料或回收站资料，请先移动后再删除目录");
        tx(db, () => { run("UPDATE document_folders SET deleted=1,version=version+1,updated=? WHERE id=?", now(), f.id); event(user, "delete-folder", f.id, f.project_id, { name: f.name }); });
        return { data: { ok: true } };
      }
      fail(405, "不支持的目录操作");
    }
    const dm = route.match(/^\/documents\/([\w-]+)(?:\/(publish|restore|restore-version|checkout|release-checkout|select-version))?$/);
    if (dm) {
      const d = document(dm[1], true), action = dm[2];
      if (!action && method === "GET") return { data: { document: expose(d), versions: all("SELECT * FROM document_versions WHERE document_id=? ORDER BY number DESC", d.id).map(exposeVersion), checkout: get("SELECT * FROM document_checkouts WHERE document_id=? AND expires>?", d.id, now()) || null } };
      if (action !== "release-checkout") checkVersion(d, b);
      if (action === "restore" && method === "POST") {
        if (!d.deleted) fail(409, "文档未被删除");
        try { metadata({}, d); }
        catch (error) {
          if ([400, 404].includes(error.status)) fail(409, "文档关联已失效，请先恢复资源与本项目的关联及所属目录，再恢复文档");
          throw error;
        }
        tx(db, () => { run("UPDATE documents SET deleted=0,version=version+1,updated=? WHERE id=?", now(), d.id); event(user, "restore-document", d.id, d.project_id); });
        return { data: { document: expose(document(d.id)) } };
      }
      if (d.deleted) fail(404, "文档已删除，请先恢复");
      if (!action && method === "PATCH") {
        const m = metadata(b, d);
        tx(db, () => { saveMeta(d.id, m); event(user, "update-document", d.id, d.project_id, { title: m.title, folder_id: m.folder_id, category: m.category, fields: Object.keys(b).filter((k) => k !== "version") }); });
        return { data: { document: expose(document(d.id)) } };
      }
      if (!action && method === "DELETE") {
        tx(db, () => { run("UPDATE documents SET deleted=1,updated=?,version=version+1 WHERE id=?", now(), d.id); run("DELETE FROM document_checkouts WHERE document_id=?", d.id); event(user, "delete-document", d.id, d.project_id, { title: d.title }); });
        return { data: { ok: true, version: d.version + 1 } };
      }
      if (["publish", "select-version", "restore-version"].includes(action) && method === "POST") {
        const v = version(d.id, b.version_id);
        tx(db, () => {
          if (action === "restore-version") {
            const id = randomUUID(), number = get("SELECT MAX(number)+1 n FROM document_versions WHERE document_id=?", d.id).n;
            run("INSERT INTO document_versions(id,document_id,number,base_version_id,filename,size,sha256,blob_hash,created_by,creator_id,created,note,conflict,restored_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)", id, d.id, number, d.current_version_id, v.filename, v.size, v.sha256, v.blob_hash, user.name, user.id, now(), "恢复历史版本 V" + v.number, v.id);
            run("UPDATE documents SET current_version_id=?,version=version+1,updated=? WHERE id=?", id, now(), d.id);
            event(user, action, d.id, d.project_id, { version_id: id, restored_from: v.id, number });
          } else {
            if (action === "publish" && v.conflict && v.id !== d.current_version_id) fail(409, "请先采用待合并版本，再设为正式版");
            run("UPDATE documents SET " + (action === "publish" ? "published_version_id" : "current_version_id") + "=?,version=version+1,updated=? WHERE id=?", v.id, now(), d.id);
            event(user, action, d.id, d.project_id, { version_id: v.id, number: v.number });
          }
        });
        return { data: { document: expose(document(d.id)) } };
      }
      if (action === "checkout" && method === "POST") {
        const prior = get("SELECT * FROM document_checkouts WHERE document_id=? AND expires>?", d.id, now());
        const takeover = prior && prior.user_id !== user.id;
        const reason = text(b.reason, "接管理由", 500);
        if (takeover && (!b.takeover || !reason)) fail(409, prior.user_name + " 正在修改，接管需填写理由");
        tx(db, () => { run("INSERT INTO document_checkouts(document_id,user_id,user_name,base_version_id,created,expires) VALUES(?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET user_id=excluded.user_id,user_name=excluded.user_name,base_version_id=excluded.base_version_id,created=excluded.created,expires=excluded.expires", d.id, user.id, user.name, d.current_version_id, now(), new Date(Date.now() + 8 * 3600000).toISOString()); event(user, takeover ? "takeover-checkout" : "checkout-document", d.id, d.project_id, { reason, previous_user_id: prior?.user_id || null, version_id: d.current_version_id }); });
        return { data: { checkout: get("SELECT * FROM document_checkouts WHERE document_id=?", d.id) } };
      }
      if (action === "release-checkout" && method === "POST") {
        const prior = get("SELECT * FROM document_checkouts WHERE document_id=?", d.id);
        const reason = text(b.reason, "释放理由", 500);
        if (prior && prior.user_id !== user.id && !reason) fail(400, "释放其他成员的修改占用需填写理由");
        tx(db, () => { run("DELETE FROM document_checkouts WHERE document_id=?", d.id); if (prior) event(user, "release-checkout", d.id, d.project_id, { reason, previous_user_id: prior.user_id }); });
        return { data: { ok: true } };
      }
      fail(405, "不支持的文档操作");
    }
    const rm = route.match(/^\/projects\/([\w-]+)\/releases$/);
    if (rm) {
      const p = project(rm[1]);
      const releaseData = (r) => ({ id: r.id, name: r.name, project_id: r.project_id, created: r.created, created_by: r.created_by, items: JSON.parse(r.manifest_json).items, voided: get("SELECT * FROM document_release_voids WHERE release_id=?", r.id) || null });
      if (method === "GET") return { data: { releases: all("SELECT * FROM document_releases WHERE project_id=? ORDER BY created DESC,id", p.id).map(releaseData) } };
      if (method !== "POST") fail(405, "不支持的交付归档操作");
      const name = text(b.name, "交付名称", 120); if (!name) fail(400, "请填写交付名称");
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 1000) fail(400, "交付归档需选择 1–1000 份资料");
      const seen = new Set(), items = [];
      for (const item of b.items) {
        if (!item || typeof item !== "object" || typeof item.document_id !== "string" || typeof item.version_id !== "string") fail(400, "交付资料无效");
        const d = document(item.document_id), v = version(d.id, item.version_id);
        if (d.project_id !== p.id || d.sensitive) fail(400, "交付仅可包含当前项目的非敏感资料");
        if (v.conflict && v.id !== d.current_version_id && v.id !== d.published_version_id) fail(409, "待合并版本不能直接进入交付归档");
        if (seen.has(d.id)) fail(400, "同一文档只能选择一个交付版本"); seen.add(d.id);
        items.push({ document_id: d.id, version_id: v.id, title: d.title, filename: v.filename, number: v.number, size: v.size, sha256: v.sha256, owner: d.owner, category: d.category, tags: JSON.parse(d.tags), folder_id: d.folder_id, task_id: d.task_id, resource_id: d.resource_id, environment: d.environment, archive_path: "files/" + d.id + "/" + v.filename });
      }
      const id = randomUUID(), created = now(), manifest = { format: "team-worklog-release-v1", id, project_id: p.id, project_name: p.name, name, created, created_by: user.name, items };
      zip32Size([{ name: "manifest.json", buffer: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }, ...items.map((item) => ({ name: item.archive_path, size: item.size }))]);
      tx(db, () => { run("INSERT INTO document_releases(id,project_id,name,created,created_by,creator_id,manifest_json) VALUES(?,?,?,?,?,?,?)", id, p.id, name, created, user.name, user.id, JSON.stringify(manifest)); for (const item of items) run("INSERT INTO document_release_items(release_id,document_id,version_id) VALUES(?,?,?)", id, item.document_id, item.version_id); event(user, "create-release", id, p.id, { name, count: items.length }); });
      return { status: 201, data: { id, release: releaseData(get("SELECT * FROM document_releases WHERE id=?", id)) } };
    }
    const voidMatch = route.match(/^\/releases\/([\w-]+)\/void$/);
    if (voidMatch && method === "POST") {
      const r = get("SELECT * FROM document_releases WHERE id=?", voidMatch[1]); if (!r) fail(404, "交付归档不存在");
      const reason = text(b.reason, "作废理由", 500); if (!reason) fail(400, "请填写作废理由");
      if (get("SELECT release_id FROM document_release_voids WHERE release_id=?", r.id)) fail(409, "该归档已作废");
      tx(db, () => { run("INSERT INTO document_release_voids(release_id,reason,created,created_by) VALUES(?,?,?,?)", r.id, reason, now(), user.name); event(user, "void-release", r.id, r.project_id, { reason }); });
      return { data: { ok: true } };
    }
    return null;
  }

  async function binary(input) {
    const route = input.route.replace(/^\/api(?=\/)/, "");
    if (await uploads.binary({ ...input, route })) return true;
    const dm = route.match(/^\/documents\/([\w-]+)\/versions\/([\w-]+)\/(download|preview)$/);
    const rm = route.match(/^\/releases\/([\w-]+)\/download$/);
    if (!dm && !rm) return false;
    auth(input.user);
    if (!["GET", "HEAD"].includes(input.method)) fail(405, "不支持的下载操作");
    const { res, req, user } = input;
    res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    if (dm) {
      const d = document(dm[1]), v = version(d.id, dm[2]); const file = store.blobPath(v.sha256);
      const stat = await fsp.stat(file).catch(() => null); if (!stat || stat.size !== v.size) fail(503, "文件暂不可用，请联系管理员恢复资料");
      let type = "application/octet-stream";
      if (dm[3] === "preview") type = await previewType(file, v.filename);
      const disposition = dm[3] === "preview" ? "inline" : "attachment";
      res.setHeader("Content-Disposition", disposition + "; filename=\"download\"; filename*=UTF-8''" + encodeURIComponent(v.filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()));
      res.setHeader("Content-Type", type); res.setHeader("Accept-Ranges", "bytes");
      if (dm[3] === "preview") { res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"); res.setHeader("X-Frame-Options", "SAMEORIGIN"); }
      let start = 0, end = v.size - 1, status = 200;
      if (req.headers.range) {
        const range = String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2]) || !v.size) { res.setHeader("Content-Range", "bytes */" + v.size); fail(416, "下载范围无效"); }
        if (!range[1]) { const suffix = Number(range[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) fail(416, "下载范围无效"); start = Math.max(0, v.size - suffix); }
        else { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= v.size) { res.setHeader("Content-Range", "bytes */" + v.size); fail(416, "下载范围无效"); }
        status = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${v.size}`);
      }
      tx(db, () => event(user, dm[3] === "preview" ? "preview-document" : "download-document", d.id, d.project_id, { version_id: v.id, number: v.number }));
      res.setHeader("Content-Length", v.size ? end - start + 1 : 0); res.writeHead(status);
      if (input.method === "HEAD" || !v.size) res.end(); else await pipeline(fs.createReadStream(file, { start, end }), res);
      return true;
    }
    const release = get("SELECT * FROM document_releases WHERE id=?", rm[1]); if (!release) fail(404, "交付归档不存在");
    const manifest = JSON.parse(release.manifest_json), entries = [{ name: "manifest.json", buffer: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }];
    for (const item of manifest.items) {
      const file = store.blobPath(item.sha256), stat = await fsp.stat(file).catch(() => null); if (!stat || stat.size !== item.size) fail(503, "归档文件暂不可用，请联系管理员恢复资料");
      entries.push({ name: item.archive_path, path: file, size: item.size });
    }
    zip32Size(entries);
    tx(db, () => event(user, "download-release", release.id, release.project_id, { count: manifest.items.length }));
    res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", "attachment; filename=\"release.zip\"; filename*=UTF-8''" + encodeURIComponent(release.name + ".zip"));
    res.writeHead(200); if (input.method === "HEAD") res.end(); else await streamZip(res, entries);
    return true;
  }
  return { api, binary, store, installSchema: () => installDocumentSchema(db) };
}

async function previewType(file, filename) {
  const handle = await fsp.open(file, "r"); const head = Buffer.alloc(16);
  try { await handle.read(head, 0, 16, 0); } finally { await handle.close(); }
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf" && head.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (ext === ".png" && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext) && head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
  if (ext === ".gif" && ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString())) return "image/gif";
  if (ext === ".webp" && head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (ext === ".wav" && head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WAVE") return "audio/wav";
  if (ext === ".mp3" && (head.subarray(0, 3).toString() === "ID3" || (head[0] === 255 && (head[1] & 224) === 224))) return "audio/mpeg";
  fail(415, "该格式仅支持下载原件，不支持在线预览");
}
