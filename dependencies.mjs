import { splitNames, isCompleted, dependencyInfo } from "./src/model.js";
import { send } from "./planning.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function installDependencySchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const cols = db
      .prepare("PRAGMA table_info(records)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("blocked"))
      db.exec(
        "ALTER TABLE records ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))",
      );
    if (!cols.includes("blocker_note"))
      db.exec(
        "ALTER TABLE records ADD COLUMN blocker_note TEXT NOT NULL DEFAULT ''",
      );
    if (!cols.includes("support_people"))
      db.exec(
        "ALTER TABLE records ADD COLUMN support_people TEXT NOT NULL DEFAULT ''",
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_dependencies(record_id TEXT NOT NULL REFERENCES records(id),depends_on_id TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(record_id,depends_on_id),CHECK(record_id<>depends_on_id));CREATE INDEX IF NOT EXISTS dependencies_target ON task_dependencies(depends_on_id,record_id);",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function hydrateRelations(db, records) {
  const byTask = new Map();
  for (const edge of db
    .prepare(
      "SELECT d.record_id,r.id,r.task,r.owner,r.actual,r.date,r.deleted,r.project_id,p.name AS project_name FROM task_dependencies d JOIN records r ON r.id=d.depends_on_id JOIN projects p ON p.id=r.project_id ORDER BY d.depends_on_id",
    )
    .all()) {
    const { record_id, ...target } = edge;
    if (!byTask.has(record_id)) byTask.set(record_id, []);
    byTask.get(record_id).push(target);
  }
  return records.map((r) => ({
    ...r,
    dependency_ids: (byTask.get(r.id) || []).map((t) => t.id),
    dependency_tasks: byTask.get(r.id) || [],
  }));
}
export function relationSnapshot(db, r) {
  if (!r) return r;
  const dependency_ids = db
    .prepare(
      "SELECT depends_on_id FROM task_dependencies WHERE record_id=? ORDER BY depends_on_id",
    )
    .all(r.id)
    .map((d) => d.depends_on_id);
  return { ...r, dependency_ids };
}
export function relationFields(b, old = {}) {
  const blocked = b.blocked === undefined ? old.blocked || 0 : b.blocked;
  if (![true, false, 0, 1].includes(blocked)) fail(400, "阻塞标记无效");
  const support =
    b.support_people === undefined
      ? old.support_people || ""
      : b.support_people;
  const note =
    b.blocker_note === undefined ? old.blocker_note || "" : b.blocker_note;
  if (typeof support !== "string" || support.length > 300)
    fail(400, "配合人员姓名过长");
  if (typeof note !== "string" || note.trim().length > 500)
    fail(400, "阻塞说明最多 500 字");
  const ids =
    b.dependency_ids === undefined
      ? old.dependency_ids || []
      : b.dependency_ids;
  if (
    !Array.isArray(ids) ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !/^[-\w]{1,100}$/.test(id))
  )
    fail(400, "依赖任务无效，最多选择 50 项");
  return {
    blocked: Number(blocked),
    blocker_note: note.trim(),
    support_people: splitNames(support).join("、"),
    dependency_ids: [...new Set(ids)].sort(),
  };
}
export function saveRelations(db, id, ids, oldIds = []) {
  const previous = new Set(oldIds);
  for (const target of ids) {
    if (target === id) fail(400, "任务不能依赖自己");
    const r = db.prepare("SELECT deleted FROM records WHERE id=?").get(target);
    if (!r || (r.deleted && !previous.has(target)))
      fail(400, "依赖任务不存在或已删除，请重新选择");
  }
  const graph = new Map();
  for (const e of db
    .prepare(
      "SELECT record_id,depends_on_id FROM task_dependencies WHERE record_id<>?",
    )
    .all(id)) {
    if (!graph.has(e.record_id)) graph.set(e.record_id, []);
    graph.get(e.record_id).push(e.depends_on_id);
  }
  const queue = [...ids],
    seen = new Set();
  while (queue.length) {
    const next = queue.pop();
    if (next === id) fail(400, "任务之间不能循环依赖，请调整前置任务");
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(graph.get(next) || []));
  }
  db.prepare("DELETE FROM task_dependencies WHERE record_id=?").run(id);
  const insert = db.prepare(
    "INSERT INTO task_dependencies(record_id,depends_on_id) VALUES(?,?)",
  );
  for (const target of ids) insert.run(id, target);
}
export function notifyRelations(db, actor, before, after) {
  const oldSupport = splitNames(before?.support_people),
    support = splitNames(after.support_people);
  const added = support.filter((n) => !oldSupport.includes(n));
  send(
    db,
    added,
    actor,
    after,
    "support-request",
    "有任务需要你配合",
    after.task + (after.blocker_note ? " · " + after.blocker_note : ""),
  );
  if (
    before &&
    ["blocked", "blocker_note", "support_people", "dependency_ids"].some(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    )
  ) {
    send(
      db,
      [...splitNames(after.owner), ...support].filter(
        (n) => !added.includes(n),
      ),
      actor,
      after,
      "coordination",
      "任务依赖与配合已更新",
      after.task,
    );
  }
}
export function notifyDependents(db, actor, before, after) {
  if (
    Boolean(before.deleted) === Boolean(after.deleted) &&
    isCompleted(before) === isCompleted(after)
  )
    return;
  const dependents = hydrateRelations(
    db,
    db
      .prepare(
        "SELECT r.* FROM records r JOIN task_dependencies d ON d.record_id=r.id WHERE d.depends_on_id=? AND r.deleted=0",
      )
      .all(after.id),
  );
  for (const r of dependents) {
    if (isCompleted(r)) continue;
    const info = dependencyInfo(r);
    const title = after.deleted
      ? "依赖任务已删除，请核对"
      : !isCompleted(after)
        ? "前置任务恢复待办，当前任务受到阻塞"
        : info.blocked
          ? "前置任务进展已更新"
          : "前置任务已完成，可以继续推进";
    const message =
      after.task +
      (after.deleted
        ? " · 已删除，不再作为自动阻塞项"
        : !isCompleted(after)
          ? " · 尚未完成"
          : info.waiting.length
            ? " · 已完成，仍有 " + info.waiting.length + " 项前置待完成"
            : info.manual
              ? " · 已完成，仍有手动阻塞标记"
              : " · 已完成");
    send(
      db,
      [...splitNames(r.owner), ...splitNames(r.support_people)],
      actor,
      r,
      "dependency",
      title,
      message,
    );
  }
}
