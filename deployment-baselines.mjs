import { randomUUID } from "node:crypto";
import { libraryFail as fail } from "./library-common.mjs";

const parse = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

// This module only reads metadata. Configuration payloads and credential
// tables never participate in deployment snapshots or document archives.
export function createDeploymentBaselines(db) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_delivery_history(
      id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL REFERENCES project_deployments(id),
      revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(deployment_id,revision)
    );
    CREATE TRIGGER IF NOT EXISTS deployment_history_no_update BEFORE UPDATE ON deployment_delivery_history BEGIN SELECT RAISE(ABORT,'Deployment delivery history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS deployment_history_no_delete BEFORE DELETE ON deployment_delivery_history BEGIN SELECT RAISE(ABORT,'Deployment delivery history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS deployment_history_no_replace BEFORE INSERT ON deployment_delivery_history WHEN EXISTS(SELECT 1 FROM deployment_delivery_history WHERE id=NEW.id OR (deployment_id=NEW.deployment_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'Deployment delivery history is immutable'); END;
  `);
  const exists = (table) =>
    Boolean(
      get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        table,
      ),
    );
  function release(id) {
    if (!id || !exists("document_releases")) return null;
    const row = get(
      "SELECT id,project_id,name,created FROM document_releases WHERE id=?",
      id,
    );
    if (!row) return null;
    const voided =
      exists("document_release_voids") &&
      Boolean(
        get(
          "SELECT release_id FROM document_release_voids WHERE release_id=?",
          id,
        ),
      );
    return { ...row, voided: Boolean(voided) };
  }
  function configurationVersion(id) {
    if (!id) return null;
    const row = get(
      "SELECT v.id,v.configuration_id,v.number,v.created_at,c.project_id,c.name,c.resource_id,c.deleted FROM configuration_versions v JOIN configurations c ON c.id=v.configuration_id WHERE v.id=?",
      id,
    );
    return row ? { ...row, deleted: Boolean(row.deleted) } : null;
  }
  function options(projectId) {
    return {
      releases: exists("document_releases")
        ? all(
            "SELECT id FROM document_releases WHERE project_id=? ORDER BY created DESC,id",
            projectId,
          )
            .map((r) => release(r.id))
            .filter((r) => !r.voided)
        : [],
      configurations: all(
        "SELECT id,name,resource_id FROM configurations WHERE project_id=? AND deleted=0 ORDER BY name,id",
        projectId,
      ).map((c) => ({
        ...c,
        versions: all(
          "SELECT id,number,created_at FROM configuration_versions WHERE configuration_id=? ORDER BY number DESC",
          c.id,
        ),
      })),
    };
  }
  function validate(projectId, body, previous = {}) {
    const releaseId =
      body.delivery_release_id === undefined
        ? previous.delivery_release_id || null
        : body.delivery_release_id;
    if (releaseId !== null && (typeof releaseId !== "string" || !releaseId))
      fail(400, "交付归档引用无效");
    if (releaseId) {
      const r = release(releaseId),
        retained = previous.delivery_release_id === releaseId;
      if (!r || r.project_id !== projectId || (!retained && r.voided))
        fail(400, "请选择本项目未作废的固定交付归档");
    }
    const ids =
      body.configuration_version_ids === undefined
        ? previous.configuration_version_ids || []
        : body.configuration_version_ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      fail(400, "配置版本引用无效");
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const v = configurationVersion(id),
        retained = (previous.configuration_version_ids || []).includes(id);
      if (!v || v.project_id !== projectId || (!retained && v.deleted))
        fail(400, "请选择本项目中有效配置的具体版本");
    }
    return {
      delivery_release_id: releaseId,
      configuration_version_ids: unique.sort(),
    };
  }
  function metadata(data) {
    return {
      delivery_release: data.delivery_release_id
        ? release(data.delivery_release_id) || {
            id: data.delivery_release_id,
            missing: true,
          }
        : null,
      configuration_versions: (data.configuration_version_ids || []).map(
        (id) => configurationVersion(id) || { id, missing: true },
      ),
    };
  }
  function append(row, user) {
    const data = parse(row.data_json),
      source = {
        name: row.name,
        environment_id: row.environment_id,
        status: row.status,
        data,
      };
    const last = get(
      "SELECT snapshot_json FROM deployment_delivery_history WHERE deployment_id=? ORDER BY revision DESC LIMIT 1",
      row.id,
    );
    if (
      last &&
      JSON.stringify(parse(last.snapshot_json).source) ===
        JSON.stringify(source)
    )
      return;
    const revision = get(
      "SELECT COALESCE(MAX(revision),0)+1 AS n FROM deployment_delivery_history WHERE deployment_id=?",
      row.id,
    ).n;
    db.prepare(
      "INSERT INTO deployment_delivery_history VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      row.id,
      revision,
      JSON.stringify({ source, ...metadata(data) }),
      user.id,
      user.name,
      new Date().toISOString(),
    );
  }
  function history(id, before = null) {
    if (
      before !== null &&
      (!/^\d+$/.test(before) ||
        !Number.isSafeInteger(Number(before)) ||
        Number(before) < 1)
    )
      fail(400, "交付历史分页无效");
    const rows = all(
      "SELECT * FROM deployment_delivery_history WHERE deployment_id=? AND revision<? ORDER BY revision DESC LIMIT 51",
      id,
      before === null ? Number.MAX_SAFE_INTEGER : Number(before),
    );
    return {
      baselines: rows
        .slice(0, 50)
        .map(({ snapshot_json, ...row }) => ({
          ...row,
          ...parse(snapshot_json),
        })),
      next_before: rows.length > 50 ? rows[49].revision : null,
    };
  }
  return { options, validate, metadata, append, history };
}
