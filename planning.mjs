import { randomUUID } from "node:crypto";
import { isCompleted, splitNames, dueState, beijingDate } from "./src/model.js";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function planningFields(b, old = {}) {
  const due_date = b.due_date === undefined ? old.due_date || "" : b.due_date;
  const priority =
    b.priority === undefined ? old.priority || "normal" : b.priority;
  if (
    typeof due_date !== "string" ||
    (due_date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) ||
        !Number.isFinite(Date.parse(due_date)) ||
        new Date(due_date).toISOString().slice(0, 10) !== due_date))
  )
    fail(400, "计划完成日期无效");
  if (!["urgent", "high", "normal", "low"].includes(priority))
    fail(400, "任务优先级无效");
  return { due_date, priority };
}
export function installPlanningSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const cols = db
      .prepare("PRAGMA table_info(records)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("due_date"))
      db.exec(
        "ALTER TABLE records ADD COLUMN due_date TEXT NOT NULL DEFAULT ''",
      );
    if (!cols.includes("priority"))
      db.exec(
        "ALTER TABLE records ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),record_id TEXT NOT NULL REFERENCES records(id),project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,actor_name TEXT NOT NULL DEFAULT '',title TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,read_at TEXT NOT NULL DEFAULT '',dedupe_key TEXT NOT NULL,UNIQUE(user_id,dedupe_key));CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id DESC);CREATE INDEX IF NOT EXISTS records_due ON records(deleted,due_date);",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function send(
  db,
  names,
  actor,
  task,
  kind,
  title,
  message,
  key = randomUUID(),
) {
  const recipients = new Set(names);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO notifications(user_id,record_id,project_id,kind,actor_name,title,message,created,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const user of db.prepare("SELECT id,name FROM users").all()) {
    if (!recipients.has(user.name) || user.id === actor?.id) continue;
    insert.run(
      user.id,
      task.id,
      task.project_id,
      kind,
      actor?.name || "",
      title,
      message,
      new Date().toISOString(),
      key,
    );
  }
}
export function notifyRecord(db, actor, before, after) {
  const owners = splitNames(after.owner),
    oldOwners = splitNames(before?.owner);
  const changed =
    !before ||
    ["task", "owner", "actual", "date", "due_date", "priority"].some(
      (k) =>
        (before[k] || (k === "priority" ? "normal" : "")) !==
        (after[k] || (k === "priority" ? "normal" : "")),
    );
  if (!changed) return;
  const assigned = owners.filter((n) => !oldOwners.includes(n));
  send(
    db,
    assigned,
    actor,
    after,
    "assigned",
    isCompleted(after) ? "新增了与你相关的完成记录" : "任务已指派给你",
    after.task,
  );
  if (!before) {
    send(
      db,
      splitNames(after.actual).filter((n) => !assigned.includes(n)),
      actor,
      after,
      "completed",
      "已记录你的完成情况",
      after.task,
    );
    return;
  }
  const remaining = [
    ...new Set([
      ...owners,
      ...oldOwners,
      ...splitNames(before.actual),
      ...splitNames(after.actual),
    ]),
  ].filter((n) => !assigned.includes(n));
  let title = "任务内容已更新";
  if (before.owner !== after.owner) title = "任务负责人已调整";
  else if (!isCompleted(before) && isCompleted(after)) title = "任务已完成";
  else if (isCompleted(before) && !isCompleted(after)) title = "任务已重新打开";
  else if (before.actual !== after.actual || before.date !== after.date)
    title = "任务完成情况已更新";
  else if (
    before.due_date !== after.due_date ||
    before.priority !== after.priority
  )
    title = "任务计划已更新";
  send(db, remaining, actor, after, "updated", title, after.task);
}
export function mentionedNames(text, names) {
  return [...new Set(names)].filter((name) => {
    let start = 0,
      at;
    while ((at = text.indexOf("@" + name, start)) >= 0) {
      const end = at + name.length + 1;
      if (
        (at === 0 || !/[A-Za-z0-9_@]/.test(text[at - 1])) &&
        (end === text.length || !/[\p{L}\p{N}_]/u.test(text[end]))
      )
        return true;
      start = end;
    }
    return false;
  });
}
export function notifyMentions(db, actor, task, text, previous = "") {
  const names = db
    .prepare("SELECT name FROM users")
    .all()
    .map((u) => u.name);
  const old = mentionedNames(previous, names);
  send(
    db,
    mentionedNames(text, names).filter((n) => !old.includes(n)),
    actor,
    task,
    "mentioned",
    "有人在评论中提到了你",
    text.slice(0, 240),
  );
}
export function ensureDueNotifications(db, date = beijingDate()) {
  for (const task of db
    .prepare(
      "SELECT * FROM records WHERE deleted=0 AND due_date<>'' AND actual='' AND date=''",
    )
    .all()) {
    const state = dueState(task, date);
    if (!["overdue", "soon", "today"].includes(state)) continue;
    const kind = state === "overdue" ? "overdue" : "due-soon";
    send(
      db,
      splitNames(task.owner),
      null,
      task,
      kind,
      state === "overdue" ? "任务已逾期" : "任务即将到期",
      "计划完成：" + task.due_date,
      task.id + ":" + task.due_date + ":" + kind,
    );
  }
}
export function notificationsAPI(db, { route, method, params, b, user }) {
  if (!route.startsWith("/api/notifications")) return null;
  if (!user) fail(401, "请先登录后查看提醒");
  if (method === "GET" && route === "/api/notifications") {
    const before = params.get("before"),
      limit = params.get("limit") || "20",
      unread = params.get("unread");
    if (
      (before !== null &&
        (!/^[1-9]\d*$/.test(before) ||
          !Number.isSafeInteger(Number(before)))) ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 50 ||
      (unread !== null && !["0", "1"].includes(unread))
    )
      fail(400, "提醒查询参数无效");
    ensureDueNotifications(db);
    const p = [user.id];
    let where = "n.user_id=?";
    if (before) {
      where += " AND n.id<?";
      p.push(Number(before));
    }
    if (unread === "1") where += " AND n.read_at=''";
    const rows = db
      .prepare(
        "SELECT n.id,n.record_id,n.project_id,n.kind,n.actor_name,n.title,n.message,n.created,n.read_at,r.task,r.deleted AS task_deleted,p.name AS project_name FROM notifications n JOIN records r ON r.id=n.record_id JOIN projects p ON p.id=n.project_id WHERE " +
          where +
          " ORDER BY n.id DESC LIMIT ?",
      )
      .all(...p, Number(limit) + 1);
    return {
      data: {
        entries: rows.slice(0, Number(limit)),
        nextCursor:
          rows.length > Number(limit) ? rows[Number(limit) - 1].id : null,
        unread: db
          .prepare(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at=''",
          )
          .get(user.id).n,
        latestId: db
          .prepare(
            "SELECT COALESCE(MAX(id),0) AS id FROM notifications WHERE user_id=?",
          )
          .get(user.id).id,
      },
    };
  }
  if (method === "POST" && route === "/api/notifications/read") {
    if (!Number.isSafeInteger(b.through) || b.through < 0)
      fail(400, "提醒参数无效");
    db.prepare(
      "UPDATE notifications SET read_at=? WHERE user_id=? AND id<=? AND read_at=''",
    ).run(new Date().toISOString(), user.id, b.through);
    return { data: { ok: true } };
  }
  const match = route.match(/^\/api\/notifications\/([1-9]\d*)\/read$/);
  if (method === "POST" && match) {
    if (!Number.isSafeInteger(Number(match[1]))) fail(400, "提醒参数无效");
    const n = db
      .prepare("SELECT id FROM notifications WHERE user_id=? AND id=?")
      .get(user.id, Number(match[1]));
    if (!n) fail(404, "提醒不存在");
    db.prepare(
      "UPDATE notifications SET read_at=? WHERE user_id=? AND id=? AND read_at=''",
    ).run(new Date().toISOString(), user.id, n.id);
    return { data: { ok: true } };
  }
  fail(405, "不支持的提醒操作");
}
