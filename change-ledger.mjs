import { randomUUID } from "node:crypto";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
} from "./library-common.mjs";

const CONFIRMATIONS = ["pending", "confirmed", "rejected", "cancelled"];
const PROGRESS = ["not_started", "in_progress", "implemented"];
const now = () => new Date().toISOString();
const parseIds = (value) => JSON.parse(value || "[]");

export function installChangeLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_changes(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, original_scope TEXT NOT NULL DEFAULT '', requested_scope TEXT NOT NULL,
      requester TEXT NOT NULL DEFAULT '', requested_on TEXT NOT NULL DEFAULT '',
      confirmation_status TEXT NOT NULL DEFAULT 'pending', confirmed_by TEXT NOT NULL DEFAULT '', confirmed_on TEXT NOT NULL DEFAULT '',
      schedule_impact TEXT NOT NULL DEFAULT '', impact_days REAL, owner TEXT NOT NULL DEFAULT '',
      task_ids TEXT NOT NULL DEFAULT '[]', milestone_id TEXT,
      progress_status TEXT NOT NULL DEFAULT 'not_started',
      creator_id TEXT NOT NULL REFERENCES users(id), creator_name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_changes_project ON project_changes(project_id,deleted,updated);
    CREATE TABLE IF NOT EXISTS project_change_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL REFERENCES project_changes(id),
      revision INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
      before_json TEXT, after_json TEXT NOT NULL, created TEXT NOT NULL,
      UNIQUE(change_id,revision)
    );
    CREATE TRIGGER IF NOT EXISTS change_history_no_update BEFORE UPDATE ON project_change_history BEGIN SELECT RAISE(ABORT,'change history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS change_history_no_delete BEFORE DELETE ON project_change_history BEGIN SELECT RAISE(ABORT,'change history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS change_history_no_replace BEFORE INSERT ON project_change_history WHEN EXISTS(SELECT 1 FROM project_change_history WHERE id=NEW.id OR (change_id=NEW.change_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'change history is immutable'); END;
  `);
}

export function createChangeLedger({ db }) {
  installChangeLedgerSchema(db);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const hasMilestones = () =>
    Boolean(
      get(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_milestones'",
      ),
    );
  const project = (id) => {
    if (
      typeof id !== "string" ||
      !get("SELECT id FROM projects WHERE id=?", id)
    )
      fail(404, "项目不存在");
    return id;
  };
  const change = (id) => {
    const row = get("SELECT * FROM project_changes WHERE id=?", id);
    if (!row) fail(404, "变更记录不存在");
    return row;
  };
  const checkVersion = (row, b) => {
    if (!Number.isInteger(b.version) || b.version !== row.version)
      fail(409, "这条变更记录已被他人修改，请刷新后重试");
  };
  const text = (value, label, max, required = false) => {
    if (
      typeof value !== "string" ||
      value.trim().length > max ||
      (required && !value.trim())
    )
      fail(400, `${label}${required ? "不能为空，" : ""}最多 ${max} 字`);
    return value.trim();
  };
  const date = (value, label) => {
    if (
      typeof value !== "string" ||
      (value &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          Number(value.slice(0, 4)) < 1 ||
          !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
          new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value))
    )
      fail(400, `${label}无效`);
    return value;
  };
  function fields(b, projectId, old = {}) {
    const pick = (key, fallback) => (b[key] === undefined ? fallback : b[key]);
    const confirmation = pick(
      "confirmation_status",
      old.confirmation_status || "pending",
    );
    const progress = pick(
      "progress_status",
      old.progress_status || "not_started",
    );
    if (!CONFIRMATIONS.includes(confirmation)) fail(400, "确认状态无效");
    if (!PROGRESS.includes(progress)) fail(400, "执行状态无效");
    const ids = pick("task_ids", parseIds(old.task_ids));
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 100)
    )
      fail(400, "关联任务无效，最多 100 项");
    const previous = new Set(parseIds(old.task_ids));
    const taskIds = [...new Set(ids)];
    for (const id of taskIds) {
      if (
        !get(
          "SELECT id FROM records WHERE id=? AND project_id=? AND (deleted=0 OR ?=1)",
          id,
          projectId,
          Number(previous.has(id)),
        )
      )
        fail(400, "关联任务已删除或不属于该项目");
    }
    const rawMilestone = pick("milestone_id", old.milestone_id || null);
    const milestoneId =
      rawMilestone === "" || rawMilestone === null ? null : rawMilestone;
    if (
      milestoneId !== null &&
      (typeof milestoneId !== "string" ||
        !hasMilestones() ||
        !get(
          "SELECT id FROM project_milestones WHERE id=? AND project_id=? AND (deleted=0 OR id=?)",
          milestoneId,
          projectId,
          old.milestone_id || "",
        ))
    )
      fail(400, "关联里程碑已删除或不属于该项目");
    const rawDays = pick("impact_days", old.impact_days ?? null);
    const impactDays = rawDays === "" || rawDays === null ? null : rawDays;
    if (
      impactDays !== null &&
      (typeof impactDays !== "number" ||
        !Number.isFinite(impactDays) ||
        Math.abs(impactDays) > 3650)
    )
      fail(400, "工期影响应为 -3650 至 3650 天的数字");
    return {
      title: text(pick("title", old.title || ""), "变更标题", 240, true),
      original_scope: text(
        pick("original_scope", old.original_scope || ""),
        "原约定",
        4000,
      ),
      requested_scope: text(
        pick("requested_scope", old.requested_scope || ""),
        "本次调整",
        4000,
        true,
      ),
      requester: text(pick("requester", old.requester || ""), "提出人", 100),
      requested_on: date(
        pick("requested_on", old.requested_on || ""),
        "提出日期",
      ),
      confirmation_status: confirmation,
      confirmed_by:
        confirmation === "confirmed"
          ? text(pick("confirmed_by", old.confirmed_by || ""), "确认人", 100)
          : "",
      confirmed_on:
        confirmation === "confirmed"
          ? date(pick("confirmed_on", old.confirmed_on || ""), "确认日期")
          : "",
      schedule_impact: text(
        pick("schedule_impact", old.schedule_impact || ""),
        "影响说明",
        1000,
      ),
      impact_days: impactDays,
      owner: text(pick("owner", old.owner || ""), "跟进人", 100),
      task_ids: JSON.stringify(taskIds),
      milestone_id: milestoneId,
      progress_status: progress,
    };
  }
  function present(row) {
    const ids = parseIds(row.task_ids);
    return {
      ...row,
      deleted: Boolean(row.deleted),
      task_ids: ids,
      tasks: ids.map((id) => {
        const r = get(
          "SELECT id,task AS title,deleted FROM records WHERE id=? AND project_id=?",
          id,
          row.project_id,
        );
        return r
          ? { ...r, deleted: Boolean(r.deleted) }
          : { id, title: "关联任务已移除", deleted: true, missing: true };
      }),
      milestone: row.milestone_id
        ? (() => {
            const m =
              hasMilestones() &&
              get(
                "SELECT id,title,status,deleted FROM project_milestones WHERE id=? AND project_id=?",
                row.milestone_id,
                row.project_id,
              );
            return m
              ? { ...m, deleted: Boolean(m.deleted) }
              : {
                  id: row.milestone_id,
                  title: "关联里程碑已移除",
                  deleted: true,
                  missing: true,
                };
          })()
        : null,
    };
  }
  function summary(projectId) {
    const rows = all(
      "SELECT confirmation_status,progress_status FROM project_changes WHERE project_id=? AND deleted=0",
      projectId,
    );
    return {
      total: rows.length,
      ...Object.fromEntries(
        CONFIRMATIONS.map((s) => [
          s,
          rows.filter((r) => r.confirmation_status === s).length,
        ]),
      ),
      in_progress: rows.filter((r) => r.progress_status === "in_progress")
        .length,
      implemented: rows.filter((r) => r.progress_status === "implemented")
        .length,
    };
  }
  const snapshot = (row) => ({
    ...row,
    task_ids: parseIds(row.task_ids),
    deleted: Boolean(row.deleted),
    tasks: present(row).tasks,
    milestone: present(row).milestone,
  });
  function append(user, action, before, after) {
    run(
      "INSERT INTO project_change_history(change_id,revision,action,actor_id,actor_name,before_json,after_json,created) VALUES(?,?,?,?,?,?,?,?)",
      after.id,
      after.version,
      action,
      user.id,
      user.name || "",
      before ? JSON.stringify(snapshot(before)) : null,
      JSON.stringify(snapshot(after)),
      now(),
    );
    resourceEvent(db, user, {
      action: action + "-change",
      entityType: "change",
      entityId: after.id,
      projectId: after.project_id,
      details: {
        title: after.title,
        version: after.version,
        status: after.confirmation_status,
        kind: after.progress_status,
      },
    });
  }
  function history(id, before) {
    if (
      before !== null &&
      before !== undefined &&
      (!/^\d+$/.test(before) ||
        !Number.isSafeInteger(Number(before)) ||
        Number(before) < 1)
    )
      fail(400, "变更历史游标无效");
    const rows = all(
      "SELECT * FROM project_change_history WHERE change_id=? AND id<? ORDER BY id DESC LIMIT 51",
      id,
      before ? Number(before) : Number.MAX_SAFE_INTEGER,
    );
    return {
      entries: rows.slice(0, 50).map(({ before_json, after_json, ...r }) => ({
        ...r,
        before: before_json ? JSON.parse(before_json) : null,
        after: JSON.parse(after_json),
      })),
      next_before: rows.length > 50 ? rows[49].id : null,
    };
  }
  async function api({
    route,
    method,
    b = {},
    params = new URLSearchParams(),
    user,
  }) {
    route = route.replace(/^\/api(?=\/)/, "");
    const list = route.match(/^\/projects\/([\w-]+)\/changes$/);
    const item = route.match(/^\/changes\/([\w-]+)(?:\/(restore|history))?$/);
    if (!list && !item) return null;
    if (!user) fail(401, "需求变更可能包含客户约定，登录后查看");
    if (list) {
      const projectId = project(list[1]);
      if (method === "GET") {
        const deleted = params.get("deleted") === "1" ? 1 : 0;
        return {
          data: {
            changes: all(
              "SELECT * FROM project_changes WHERE project_id=? AND deleted=? ORDER BY updated DESC,id",
              projectId,
              deleted,
            ).map(present),
            summary: summary(projectId),
            milestones: hasMilestones()
              ? all(
                  "SELECT id,title,status FROM project_milestones WHERE project_id=? AND deleted=0 ORDER BY title,id",
                  projectId,
                )
              : [],
          },
        };
      }
      if (method !== "POST") fail(405, "不支持的变更台账操作");
      const f = fields(b, projectId),
        id = randomUUID(),
        created = now();
      tx(db, () => {
        const keys = Object.keys(f);
        run(
          `INSERT INTO project_changes(id,project_id,${keys.join(",")},creator_id,creator_name,created,updated) VALUES(${Array(
            keys.length + 6,
          )
            .fill("?")
            .join(",")})`,
          id,
          projectId,
          ...Object.values(f),
          user.id,
          user.name || "",
          created,
          created,
        );
        append(user, "create", null, change(id));
      });
      return { status: 201, data: { id, change: present(change(id)) } };
    }
    const row = change(item[1]),
      action = item[2];
    project(row.project_id);
    if (!action && method === "GET")
      return {
        data: {
          change: present(row),
          history: history(row.id, params.get("before")),
        },
      };
    if (action === "history" && method === "GET")
      return { data: history(row.id, params.get("before")) };
    checkVersion(row, b);
    if (!action && method === "PATCH") {
      if (row.deleted) fail(404, "变更记录已移入回收站");
      const f = fields(b, row.project_id, row);
      tx(db, () => {
        const written = run(
          `UPDATE project_changes SET ${Object.keys(f)
            .map((k) => k + "=?")
            .join(",")},version=version+1,updated=? WHERE id=? AND version=?`,
          ...Object.values(f),
          now(),
          row.id,
          row.version,
        );
        if (written.changes !== 1)
          fail(409, "这条变更记录已被他人修改，请刷新后重试");
        append(user, "update", row, change(row.id));
      });
      return { data: { change: present(change(row.id)) } };
    }
    if (
      (!action && method === "DELETE") ||
      (action === "restore" && method === "POST")
    ) {
      const restoring = action === "restore";
      if (restoring ? !row.deleted : row.deleted)
        fail(409, restoring ? "这条变更记录未删除" : "这条变更记录已删除");
      tx(db, () => {
        const written = run(
          "UPDATE project_changes SET deleted=?,version=version+1,updated=? WHERE id=? AND version=?",
          restoring ? 0 : 1,
          now(),
          row.id,
          row.version,
        );
        if (written.changes !== 1)
          fail(409, "这条变更记录已被他人修改，请刷新后重试");
        append(user, restoring ? "restore" : "delete", row, change(row.id));
      });
      return { data: { change: present(change(row.id)), ok: true } };
    }
    fail(405, "不支持的变更台账操作");
  }
  return { api, summary };
}
