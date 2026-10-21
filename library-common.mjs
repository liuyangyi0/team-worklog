import { randomUUID } from "node:crypto";

export function libraryFail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function libraryTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    if (value && typeof value.then === "function")
      throw new Error("Library transactions must be synchronous");
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function installLibraryCommon(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_login TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      project_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resource_events_project ON resource_events(project_id,id);
    CREATE TRIGGER IF NOT EXISTS resource_events_no_update
      BEFORE UPDATE ON resource_events BEGIN SELECT RAISE(ABORT,'resource-events-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS resource_events_no_delete
      BEFORE DELETE ON resource_events BEGIN SELECT RAISE(ABORT,'resource-events-immutable'); END;
    CREATE TRIGGER IF NOT EXISTS resource_events_no_replace
      BEFORE INSERT ON resource_events WHEN EXISTS(SELECT 1 FROM resource_events WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'resource-events-immutable'); END;
  `);
}

// Only descriptive metadata can enter this log. Secret payloads are never snapshots.
const eventKeys = new Set([
  "name",
  "title",
  "fields",
  "filename",
  "size",
  "sha256",
  "version",
  "version_id",
  "source_version_id",
  "base_version_id",
  "document_id",
  "resource_id",
  "resource_name",
  "environment_id",
  "environment_name",
  "folder_id",
  "parent_id",
  "published_version_id",
  "current_version_id",
  "release_id",
  "release_name",
  "count",
  "conflict",
  "duplicate",
  "reason",
  "status",
  "result",
  "from",
  "to",
  "kind",
  "username",
  "applied_at",
  "rollback_version_id",
  "credential_id",
  "configuration_id",
  "has_secret",
  "key_version",
  "restored_from",
  "revision",
  "target_id",
  "checked_out_by",
  "number",
  "purpose",
  "previous_user_id",
  "project_ids",
  "type",
  "application_id",
]);
function cleanDetails(details) {
  const result = {};
  if (!details || typeof details !== "object" || Array.isArray(details))
    return result;
  for (const [key, value] of Object.entries(details)) {
    if (!eventKeys.has(key)) continue;
    if (typeof value === "string") result[key] = value.slice(0, 1000);
    else if (value === null || typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      result[key] = value;
    else if (Array.isArray(value))
      result[key] = value
        .slice(0, 100)
        .filter((v) => ["string", "number", "boolean"].includes(typeof v))
        .map((v) => (typeof v === "string" ? v.slice(0, 300) : v));
  }
  return result;
}

export function resourceEvent(
  db,
  user,
  { action, entityType, entityId, projectId = null, details = {} },
) {
  if (!user) libraryFail(401, "请先登录");
  return db
    .prepare(
      `INSERT INTO resource_events
    (request_id,actor_id,actor_login,actor_name,project_id,action,entity_type,entity_id,details_json,created)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      user.id,
      user.login || "",
      user.name || "",
      projectId,
      action,
      entityType,
      entityId,
      JSON.stringify(cleanDetails(details)),
      new Date().toISOString(),
    ).lastInsertRowid;
}

export function readResourceEvents(db, params) {
  const limitValue = params.get("limit") || "50";
  if (!/^\d+$/.test(limitValue)) libraryFail(400, "每页条数无效");
  const limit = Math.max(1, Math.min(100, Number(limitValue)));
  const projectId = params.get("project_id");
  const before = params.get("before");
  if (before && !/^\d+$/.test(before)) libraryFail(400, "日志游标无效");
  const where = [],
    values = [];
  if (projectId) {
    where.push("project_id=?");
    values.push(projectId);
  }
  if (before) {
    where.push("id<?");
    values.push(Number(before));
  }
  const rows = db
    .prepare(
      `SELECT * FROM resource_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...values, limit + 1);
  const entries = rows.slice(0, limit).map(({ details_json, ...row }) => ({
    ...row,
    details: JSON.parse(details_json),
  }));
  return {
    entries,
    nextCursor: rows.length > limit ? entries.at(-1)?.id : null,
  };
}
