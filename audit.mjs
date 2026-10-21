const recordKeys = [
  "task",
  "owner",
  "actual",
  "due_date",
  "priority",
  "date",
  "parent_task",
  "dependency_titles",
  "blocked",
  "blocker_note",
  "support_people",
];
const commentKeys = ["body", "task"];
const projectKeys = ["name", "color", "members"];
const parse = (value) => {
  try {
    return value == null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};
const isProject = (action) => action.endsWith("-project");
const isComment = (action) => action.endsWith("-comment");
function snapshot(value, project, comment = false) {
  const source = typeof value === "string" ? parse(value) : value;
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;
  const result = {};
  for (const key of project
    ? projectKeys
    : comment
      ? commentKeys
      : recordKeys) {
    if (!(key in source)) continue;
    if (key === "parent_task" && !source[key]) continue;
    if (key === "members") {
      const names =
        typeof source[key] === "string" ? parse(source[key]) : source[key];
      result[key] = Array.isArray(names)
        ? names.filter((n) => typeof n === "string")
        : [];
    } else if (key === "blocked")
      result[key] = source[key] ? "已标记" : "未标记";
    else if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}
function context(db, row) {
  const commentRecord = isComment(row.action)
    ? db
        .prepare("SELECT record_id FROM task_comments WHERE id=?")
        .get(row.entity)?.record_id ||
      parse(row.before_json)?.record_id ||
      parse(row.after_json)?.record_id
    : null;
  const projectId = isProject(row.action)
    ? row.entity
    : db
        .prepare("SELECT project_id FROM records WHERE id=?")
        .get(commentRecord || row.entity)?.project_id ||
      parse(row.before_json)?.project_id ||
      parse(row.after_json)?.project_id ||
      "";
  const project = db
    .prepare("SELECT name FROM projects WHERE id=?")
    .get(projectId);
  const projectName = isProject(row.action)
    ? parse(row.after_json)?.name ||
      parse(row.before_json)?.name ||
      project?.name ||
      "历史项目"
    : project?.name || "历史项目";
  return { projectId, projectName };
}
export function installAuditSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db
      .prepare("PRAGMA table_info(audit)")
      .all()
      .map((c) => c.name);
    const additions = ["actor_name", "project_id", "project_name"];
    const migrate = additions.some((c) => !columns.includes(c));
    for (const column of additions)
      if (!columns.includes(column))
        db.exec(
          "ALTER TABLE audit ADD COLUMN " +
            column +
            " TEXT NOT NULL DEFAULT ''",
        );
    if (migrate) {
      const update = db.prepare(
        "UPDATE audit SET actor_name=?,project_id=?,project_name=? WHERE id=?",
      );
      for (const row of db.prepare("SELECT * FROM audit ORDER BY id").all()) {
        const actor = db
          .prepare("SELECT name FROM users WHERE id=?")
          .get(row.actor);
        const { projectId, projectName } = context(db, row);
        update.run(actor?.name || "历史成员", projectId, projectName, row.id);
      }
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS audit_project_order ON audit(project_id,id DESC);" +
        "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'operation logs are append-only'); END;" +
        "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'operation logs are append-only'); END;" +
        "CREATE TRIGGER IF NOT EXISTS audit_no_replace BEFORE INSERT ON audit WHEN EXISTS(SELECT 1 FROM audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'operation logs are append-only'); END;",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function appendAudit(db, user, action, entity, before, after) {
  if (action === "restore-record")
    after = db.prepare("SELECT * FROM records WHERE id=?").get(entity);
  if (!isProject(action) && !isComment(action)) {
    for (const value of [before, after]) {
      if (value) {
        const ids =
          value.dependency_ids ||
          db
            .prepare(
              "SELECT depends_on_id FROM task_dependencies WHERE record_id=? ORDER BY depends_on_id",
            )
            .all(entity)
            .map((d) => d.depends_on_id);
        value.dependency_titles = ids
          .map((id) => {
            const r = db
              .prepare(
                "SELECT r.task,p.name FROM records r JOIN projects p ON p.id=r.project_id WHERE r.id=?",
              )
              .get(id);
            return r ? r.name + " / " + r.task : "历史任务";
          })
          .join("\n");
      }
      if (value?.parent_id)
        value.parent_task =
          db.prepare("SELECT task FROM records WHERE id=?").get(value.parent_id)
            ?.task || "";
    }
  }
  const row = {
    action,
    entity,
    before_json: JSON.stringify(before),
    after_json: JSON.stringify(after),
  };
  const { projectId, projectName } = context(db, row);
  db.prepare(
    "INSERT INTO audit(actor,actor_name,action,entity,project_id,project_name,before_json,after_json,created) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    user.id,
    user.name,
    action,
    entity,
    projectId,
    projectName,
    row.before_json,
    row.after_json,
    new Date().toISOString(),
  );
}
export function readAudit(db, params) {
  const project = params.get("project") || "";
  const before = params.get("before");
  const limitRaw = params.get("limit") || "20";
  const invalid = () => {
    throw Object.assign(new Error("日志查询参数无效"), { status: 400 });
  };
  if (project && !/^[\w-]{1,100}$/.test(project)) invalid();
  if (
    before !== null &&
    (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before)))
  )
    invalid();
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100)
    invalid();
  const limit = Number(limitRaw),
    filters = [],
    values = [];
  if (project) {
    filters.push("project_id=?");
    values.push(project);
  }
  const total = db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit" +
        (filters.length ? " WHERE " + filters.join(" AND ") : ""),
    )
    .get(...values).n;
  if (before !== null) {
    filters.push("id<?");
    values.push(Number(before));
  }
  const rows = db
    .prepare(
      "SELECT id,actor_name,action,entity,project_id,project_name,before_json,after_json,created FROM audit" +
        (filters.length ? " WHERE " + filters.join(" AND ") : "") +
        " ORDER BY id DESC LIMIT ?",
    )
    .all(...values, limit + 1);
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map((row) => ({
    id: row.id,
    actor: row.actor_name,
    action: row.action,
    entityId: row.entity,
    entityType: isProject(row.action)
      ? "project"
      : isComment(row.action)
        ? "comment"
        : "record",
    projectId: row.project_id,
    projectName: row.project_name,
    created: row.created,
    before: snapshot(
      row.before_json,
      isProject(row.action),
      isComment(row.action),
    ),
    after: snapshot(
      row.after_json,
      isProject(row.action),
      isComment(row.action),
    ),
  }));
  return { entries, total, nextCursor: more ? entries.at(-1).id : null };
}
