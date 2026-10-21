import { notifyMentions } from "./planning.mjs";
import { isCompleted } from "./src/model.js";
import { appendAudit } from "./audit.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
export function installTaskSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db
      .prepare("PRAGMA table_info(records)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("parent_id"))
      db.exec(
        "ALTER TABLE records ADD COLUMN parent_id TEXT REFERENCES records(id)",
      );
    if (!columns.includes("description"))
      db.exec(
        "ALTER TABLE records ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      );
    if (!columns.includes("delete_group"))
      db.exec(
        "ALTER TABLE records ADD COLUMN delete_group TEXT NOT NULL DEFAULT ''",
      );
    if (!columns.includes("completed_at")) {
      db.exec(
        "ALTER TABLE records ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''",
      );
      const times = new Map();
      for (const e of db
        .prepare(
          "SELECT entity,action,before_json,after_json,created FROM audit WHERE action IN ('create-record','update-record','restore-record') ORDER BY id",
        )
        .all()) {
        const before = parse(e.before_json),
          after =
            parse(e.after_json) ||
            (e.action === "restore-record" ? before : null);
        if (!after) continue;
        if (!isCompleted(after)) times.delete(e.entity);
        else if (!before || !isCompleted(before) || !times.has(e.entity))
          times.set(e.entity, e.created);
      }
      const update = db.prepare("UPDATE records SET completed_at=? WHERE id=?");
      for (const r of db.prepare("SELECT * FROM records").all())
        if (isCompleted(r))
          update.run(times.get(r.id) || r.created || r.updated, r.id);
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS records_parent ON records(parent_id,deleted);CREATE TABLE IF NOT EXISTS task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL REFERENCES records(id),author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0);CREATE INDEX IF NOT EXISTS task_comments_record ON task_comments(record_id,deleted,id);",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function validateParent(db, parentId, projectId) {
  if (parentId == null || parentId === "") return null;
  if (typeof parentId !== "string") fail(400, "上级任务无效");
  let parent = db
    .prepare("SELECT * FROM records WHERE id=? AND deleted=0")
    .get(parentId);
  if (!parent) fail(404, "上级任务不存在或已删除");
  if (parent.project_id !== projectId)
    fail(400, "子任务必须与上级任务属于同一项目");
  let depth = 1,
    current = parent;
  const seen = new Set([current.id]);
  while (current.parent_id) {
    if (++depth >= 8) fail(400, "子任务最多支持八层");
    current = db
      .prepare("SELECT * FROM records WHERE id=? AND deleted=0")
      .get(current.parent_id);
    if (!current || seen.has(current.id)) fail(400, "上级任务关系无效");
    seen.add(current.id);
  }
  return parent;
}
export function activeDescendants(db, id) {
  return db
    .prepare(
      "WITH RECURSIVE tree(id) AS (SELECT id FROM records WHERE id=? AND deleted=0 UNION ALL SELECT r.id FROM records r JOIN tree t ON r.parent_id=t.id WHERE r.deleted=0) SELECT r.* FROM records r JOIN tree t ON r.id=t.id",
    )
    .all(id);
}
export function commentsAPI(db, { route, method, params, b, user }) {
  const match = route.match(
    /^\/api\/records\/([\w-]+)\/comments(?:\/([1-9]\d*))?$/,
  );
  if (!match) return null;
  const task = db
    .prepare("SELECT * FROM records WHERE id=? AND deleted=0")
    .get(match[1]);
  if (!task) fail(404, "任务不存在或已删除");
  if (method === "GET" && !match[2]) {
    const raw = params.get("before"),
      limitRaw = params.get("limit") || "20";
    if (
      raw !== null &&
      (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    )
      fail(400, "评论查询参数无效");
    if (
      !/^\d+$/.test(limitRaw) ||
      Number(limitRaw) < 1 ||
      Number(limitRaw) > 50
    )
      fail(400, "评论查询参数无效");
    const limit = Number(limitRaw),
      values = [task.id];
    let filter = "record_id=? AND deleted=0";
    if (raw) {
      filter += " AND id<?";
      values.push(Number(raw));
    }
    const rows = db
      .prepare(
        "SELECT id,author_name,body,created,updated,version FROM task_comments WHERE " +
          filter +
          " ORDER BY id DESC LIMIT ?",
      )
      .all(...values, limit + 1);
    const entries = rows
      .slice(0, limit)
      .reverse()
      .map((c) => ({ ...c, editable: Boolean(user) }));
    return {
      data: {
        entries,
        total: db
          .prepare(
            "SELECT COUNT(*) AS n FROM task_comments WHERE record_id=? AND deleted=0",
          )
          .get(task.id).n,
        nextCursor: rows.length > limit ? entries[0].id : null,
      },
    };
  }
  if (!user) fail(401, "请先登录后发表评论");
  const content = () => {
    if (
      typeof b.body !== "string" ||
      !b.body.trim() ||
      b.body.trim().length > 3000
    )
      fail(400, "评论需为 1–3000 字");
    return b.body.trim();
  };
  const snapshot = (c) => ({
    body: c.body,
    task: task.task,
    record_id: task.id,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = new Date().toISOString();
    let result;
    if (method === "POST" && !match[2]) {
      const text = content();
      const insert = db
        .prepare(
          "INSERT INTO task_comments(record_id,author_id,author_name,body,created,updated) VALUES(?,?,?,?,?,?)",
        )
        .run(task.id, user.id, user.name, text, now, now);
      const id = Number(insert.lastInsertRowid);
      appendAudit(
        db,
        user,
        "create-comment",
        String(id),
        null,
        snapshot({ body: text }),
      );
      notifyMentions(db, user, task, text);
      result = { status: 201, data: { id } };
    } else if (match[2] && ["PATCH", "DELETE"].includes(method)) {
      const c = db
        .prepare(
          "SELECT * FROM task_comments WHERE id=? AND record_id=? AND deleted=0",
        )
        .get(Number(match[2]), task.id);
      if (!c) fail(404, "评论不存在或已删除");
      if (b.version !== c.version) fail(409, "评论已被修改，请刷新后重试");
      if (method === "PATCH") {
        const text = content();
        db.prepare(
          "UPDATE task_comments SET body=?,updated=?,version=version+1 WHERE id=?",
        ).run(text, now, c.id);
        appendAudit(
          db,
          user,
          "update-comment",
          String(c.id),
          snapshot(c),
          snapshot({ body: text }),
        );
        notifyMentions(db, user, task, text, c.body);
      } else {
        db.prepare(
          "UPDATE task_comments SET deleted=1,updated=?,version=version+1 WHERE id=?",
        ).run(now, c.id);
        appendAudit(
          db,
          user,
          "delete-comment",
          String(c.id),
          snapshot(c),
          null,
        );
      }
      result = { data: { ok: true } };
    } else fail(405, "不支持的评论操作");
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
