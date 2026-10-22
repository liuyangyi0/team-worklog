import { randomUUID } from "node:crypto";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
  installLibraryCommon,
} from "./library-common.mjs";
import { beijingDate } from "./src/model.js";
import { MILESTONE_STATUSES } from "./src/milestones.js";

const now = () => new Date().toISOString();
export function installMilestoneSchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS project_milestones(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',owner TEXT NOT NULL DEFAULT '',planned_date TEXT NOT NULL DEFAULT '',actual_date TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'planned',version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL); CREATE INDEX IF NOT EXISTS milestones_project ON project_milestones(project_id,deleted,planned_date); CREATE TABLE IF NOT EXISTS milestone_tasks(milestone_id TEXT NOT NULL REFERENCES project_milestones(id),task_id TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(milestone_id,task_id)); CREATE TABLE IF NOT EXISTS milestone_documents(milestone_id TEXT NOT NULL REFERENCES project_milestones(id),document_id TEXT NOT NULL REFERENCES documents(id),version_id TEXT REFERENCES document_versions(id),PRIMARY KEY(milestone_id,document_id));",
  );
}
export function createMilestones({ db }) {
  installMilestoneSchema(db);
  installLibraryCommon(db);
  const get = (sql, ...p) => db.prepare(sql).get(...p),
    all = (sql, ...p) => db.prepare(sql).all(...p),
    run = (sql, ...p) => db.prepare(sql).run(...p);
  const table = (name) =>
    Boolean(
      get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name),
    );
  const project = (id) => {
    if (
      typeof id !== "string" ||
      !get("SELECT id FROM projects WHERE id=?", id)
    )
      fail(404, "项目不存在");
    return id;
  };
  const item = (id) => {
    const r = get("SELECT * FROM project_milestones WHERE id=?", id);
    if (!r) fail(404, "里程碑不存在");
    return r;
  };
  const checkVersion = (r, b) => {
    if (!Number.isInteger(b.version) || b.version !== r.version)
      fail(409, "里程碑刚被他人修改，请载入最新内容后重试");
  };
  const requireUser = (user) => {
    if (!user) fail(401, "请先登录后维护里程碑");
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
      fail(400, label + "无效");
    return value;
  };
  const links = (id) => ({
    task_ids: all(
      "SELECT task_id FROM milestone_tasks WHERE milestone_id=? ORDER BY task_id",
      id,
    ).map((r) => r.task_id),
    documents: all(
      "SELECT document_id,version_id FROM milestone_documents WHERE milestone_id=? ORDER BY document_id",
      id,
    ),
  });
  function present(r, user) {
    const relations = links(r.id);
    const result = {
      id: r.id,
      project_id: r.project_id,
      title: r.title,
      description: r.description,
      owner: r.owner,
      planned_date: r.planned_date,
      actual_date: r.actual_date,
      status: r.status,
      version: r.version,
      deleted: Boolean(r.deleted),
      created: r.created,
      updated: r.updated,
      task_ids: relations.task_ids,
      tasks: relations.task_ids.map((id) => {
        const t = get(
          "SELECT id,project_id,task,owner,actual,date,deleted FROM records WHERE id=?",
          id,
        );
        return t && t.project_id === r.project_id
          ? {
              id: t.id,
              task: t.task,
              owner: t.owner,
              actual: t.actual,
              date: t.date,
              deleted: Boolean(t.deleted),
            }
          : { id, task: "关联任务不可用", deleted: true };
      }),
    };
    if (user)
      result.documents = relations.documents.map((ref) => {
        const d = table("documents")
          ? get(
              "SELECT id,project_id,title,deleted,sensitive,current_version_id FROM documents WHERE id=?",
              ref.document_id,
            )
          : null;
        const valid = d && d.project_id === r.project_id && !d.sensitive;
        const v =
          valid && ref.version_id
            ? get(
                "SELECT id,number,conflict FROM document_versions WHERE id=? AND document_id=?",
                ref.version_id,
                d.id,
              )
            : null;
        return {
          ...ref,
          title: valid ? d.title : "关联资料不可用",
          deleted: !valid || Boolean(d.deleted),
          number: v?.number || null,
          unavailable:
            !valid || Boolean(d.deleted) || Boolean(ref.version_id && !v),
        };
      });
    return result;
  }
  function fields(b, projectId, old = {}) {
    const pick = (k, fallback) => (b[k] === undefined ? fallback : b[k]);
    const text = (key, label, max, fallback = "") => {
      const s = pick(key, fallback);
      if (typeof s !== "string" || s.trim().length > max)
        fail(400, label + "最多 " + max + " 字");
      return s.trim();
    };
    const title = text("title", "里程碑名称", 200, old.title || "");
    if (!title) fail(400, "请填写里程碑名称");
    const status = pick("status", old.status || "planned");
    if (!MILESTONE_STATUSES.some((s) => s.id === status))
      fail(400, "里程碑状态无效");
    const previous = old.id ? links(old.id) : { task_ids: [], documents: [] };
    const ids = pick("task_ids", previous.task_ids);
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      fail(400, "关联任务无效，最多 100 项");
    const taskIds = [...new Set(ids)].sort();
    for (const id of taskIds) {
      const t = get("SELECT id,project_id,deleted FROM records WHERE id=?", id);
      if (
        !t ||
        t.project_id !== projectId ||
        (t.deleted && !previous.task_ids.includes(id))
      )
        fail(400, "只能关联本项目有效任务");
    }
    const docs = pick("documents", previous.documents);
    if (!Array.isArray(docs) || docs.length > 50)
      fail(400, "关联资料无效，最多 50 项");
    const documentRefs = [],
      seen = new Set();
    for (const ref of docs) {
      if (
        !ref ||
        typeof ref !== "object" ||
        Array.isArray(ref) ||
        typeof ref.document_id !== "string" ||
        !ref.document_id ||
        (ref.version_id !== undefined &&
          ref.version_id !== null &&
          typeof ref.version_id !== "string")
      )
        fail(400, "关联资料格式无效");
      if (seen.has(ref.document_id)) fail(400, "同一资料只能关联一次");
      seen.add(ref.document_id);
      const versionId = ref.version_id || null;
      const retained = previous.documents.some(
        (d) => d.document_id === ref.document_id && d.version_id === versionId,
      );
      const d = table("documents")
        ? get(
            "SELECT id,project_id,deleted,sensitive,current_version_id,published_version_id FROM documents WHERE id=?",
            ref.document_id,
          )
        : null;
      if (
        !d ||
        d.project_id !== projectId ||
        (!retained && (d.deleted || d.sensitive))
      )
        fail(400, "只能关联本项目未移除的非敏感资料");
      if (versionId) {
        const v = get(
          "SELECT id,conflict FROM document_versions WHERE id=? AND document_id=?",
          versionId,
          d.id,
        );
        if (
          !v ||
          (!retained &&
            v.conflict &&
            v.id !== d.current_version_id &&
            v.id !== d.published_version_id)
        )
          fail(400, "请选择该资料的有效版本");
      }
      documentRefs.push({ document_id: d.id, version_id: versionId });
    }
    return {
      title,
      description: text("description", "说明", 1000, old.description || ""),
      owner: text("owner", "负责人", 100, old.owner || ""),
      planned_date: date(
        pick("planned_date", old.planned_date || ""),
        "计划达成日期",
      ),
      actual_date: date(
        pick("actual_date", old.actual_date || ""),
        "实际达成日期",
      ),
      status,
      task_ids: taskIds,
      documents: documentRefs.sort((a, b) =>
        a.document_id.localeCompare(b.document_id),
      ),
    };
  }
  function saveLinks(id, f) {
    run("DELETE FROM milestone_tasks WHERE milestone_id=?", id);
    for (const taskId of f.task_ids)
      run("INSERT INTO milestone_tasks VALUES(?,?)", id, taskId);
    run("DELETE FROM milestone_documents WHERE milestone_id=?", id);
    for (const ref of f.documents)
      run(
        "INSERT INTO milestone_documents VALUES(?,?,?)",
        id,
        ref.document_id,
        ref.version_id,
      );
  }
  function audit(user, action, r, details = {}) {
    const fields = details.fields || [];
    const chunks = fields.length
      ? Array.from({ length: Math.ceil(fields.length / 100) }, (_, i) =>
          fields.slice(i * 100, (i + 1) * 100),
        )
      : [null];
    for (const chunk of chunks)
      resourceEvent(db, user, {
        action,
        entityType: "milestone",
        entityId: r.id,
        projectId: r.project_id,
        details: {
          title: r.title,
          status: r.status,
          ...details,
          ...(chunk ? { fields: chunk } : {}),
        },
      });
  }
  function summary(projectId) {
    const rows = all(
      "SELECT id,title,owner,planned_date,status FROM project_milestones WHERE project_id=? AND deleted=0 AND status<>'cancelled'",
      projectId,
    );
    const pending = rows
      .filter((r) => r.status !== "achieved")
      .sort(
        (a, b) =>
          (a.planned_date || "9999").localeCompare(b.planned_date || "9999") ||
          a.id.localeCompare(b.id),
      );
    return {
      total: rows.length,
      achieved: rows.filter((r) => r.status === "achieved").length,
      overdue: pending.filter(
        (r) => r.planned_date && r.planned_date < beijingDate(),
      ).length,
      next: pending[0] || null,
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
    const list = route.match(/^\/projects\/([\w-]+)\/milestones$/),
      option = route.match(/^\/projects\/([\w-]+)\/milestone-options$/),
      single = route.match(/^\/milestones\/([\w-]+)(?:\/(restore))?$/);
    if (!list && !option && !single) return null;
    if (option) {
      requireUser(user);
      project(option[1]);
      if (method !== "GET") fail(405, "不支持的里程碑选项操作");
      return {
        data: {
          tasks: all(
            "SELECT id,task,owner,actual,date FROM records WHERE project_id=? AND deleted=0 ORDER BY created,id",
            option[1],
          ),
          documents: table("documents")
            ? all(
                "SELECT id,title,current_version_id,published_version_id FROM documents WHERE project_id=? AND deleted=0 AND sensitive=0 ORDER BY title,id",
                option[1],
              ).map((d) => ({
                ...d,
                versions: all(
                  "SELECT id,number,conflict FROM document_versions WHERE document_id=? AND (conflict=0 OR id=? OR id=?) ORDER BY number DESC",
                  d.id,
                  d.current_version_id,
                  d.published_version_id,
                ),
              }))
            : [],
        },
      };
    }
    if (list) {
      const projectId = project(list[1]);
      if (method === "GET") {
        const deleted = params.get("deleted") === "1";
        if (deleted) requireUser(user);
        return {
          data: {
            milestones: all(
              "SELECT * FROM project_milestones WHERE project_id=? AND deleted=? ORDER BY CASE WHEN planned_date='' THEN 1 ELSE 0 END,planned_date,created,id",
              projectId,
              Number(deleted),
            ).map((r) => present(r, user)),
            summary: summary(projectId),
            can_view_internal: Boolean(user),
          },
        };
      }
      requireUser(user);
      if (method !== "POST") fail(405, "不支持的里程碑操作");
      const id = randomUUID();
      tx(db, () => {
        const f = fields(b, projectId),
          created = now();
        run(
          "INSERT INTO project_milestones(id,project_id,title,description,owner,planned_date,actual_date,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
          id,
          projectId,
          f.title,
          f.description,
          f.owner,
          f.planned_date,
          f.actual_date,
          f.status,
          created,
          created,
        );
        saveLinks(id, f);
        audit(user, "create-milestone", item(id), {
          fields: [
            ...f.task_ids.map((id) => "task:" + id),
            ...f.documents.map(
              (d) =>
                "document:" + d.document_id + ":" + (d.version_id || "current"),
            ),
          ],
        });
      });
      return { status: 201, data: { milestone: present(item(id), user) } };
    }
    const r = item(single[1]),
      action = single[2];
    if (method === "GET" && !action) {
      if (r.deleted && !user) fail(404, "里程碑不存在或已移除");
      return {
        data: { milestone: present(r, user), can_view_internal: Boolean(user) },
      };
    }
    requireUser(user);
    if (method === "PATCH" && !action) {
      tx(db, () => {
        const current = item(r.id);
        if (current.deleted) fail(404, "里程碑已移除");
        checkVersion(current, b);
        const f = fields(b, current.project_id, current);
        run(
          "UPDATE project_milestones SET title=?,description=?,owner=?,planned_date=?,actual_date=?,status=?,version=version+1,updated=? WHERE id=?",
          f.title,
          f.description,
          f.owner,
          f.planned_date,
          f.actual_date,
          f.status,
          now(),
          r.id,
        );
        const previous = links(r.id);
        saveLinks(r.id, f);
        let logged = false;
        for (const key of [
          "title",
          "description",
          "owner",
          "planned_date",
          "actual_date",
          "status",
        ])
          if (current[key] !== f[key]) {
            audit(user, "update-milestone", item(r.id), {
              fields: [key],
              from: current[key],
              to: f[key],
            });
            logged = true;
          }
        const beforeLinks = JSON.stringify(previous),
          afterLinks = JSON.stringify({
            task_ids: f.task_ids,
            documents: f.documents,
          });
        if (beforeLinks !== afterLinks) {
          const addedTasks = f.task_ids.filter(
              (id) => !previous.task_ids.includes(id),
            ),
            removedTasks = previous.task_ids.filter(
              (id) => !f.task_ids.includes(id),
            );
          audit(user, "update-milestone", item(r.id), {
            fields: [
              ...addedTasks.map((id) => "add-task:" + id),
              ...removedTasks.map((id) => "remove-task:" + id),
              ...previous.documents
                .filter(
                  (d) =>
                    !f.documents.some(
                      (x) =>
                        x.document_id === d.document_id &&
                        x.version_id === d.version_id,
                    ),
                )
                .map(
                  (d) =>
                    "remove-document:" +
                    d.document_id +
                    ":" +
                    (d.version_id || "current"),
                ),
              ...f.documents.map(
                (d) =>
                  "document:" +
                  d.document_id +
                  ":" +
                  (d.version_id || "current"),
              ),
            ],
          });
          logged = true;
        }
        if (!logged) audit(user, "update-milestone", item(r.id));
      });
      return { data: { milestone: present(item(r.id), user) } };
    }
    if (method === "DELETE" && !action) {
      tx(db, () => {
        const current = item(r.id);
        checkVersion(current, b);
        if (current.deleted) fail(409, "里程碑已移除");
        run(
          "UPDATE project_milestones SET deleted=1,version=version+1,updated=? WHERE id=?",
          now(),
          r.id,
        );
        audit(user, "delete-milestone", current);
      });
      return { data: { ok: true, version: item(r.id).version } };
    }
    if (method === "POST" && action === "restore") {
      tx(db, () => {
        const current = item(r.id);
        checkVersion(current, b);
        if (!current.deleted) fail(409, "里程碑未移除");
        run(
          "UPDATE project_milestones SET deleted=0,version=version+1,updated=? WHERE id=?",
          now(),
          r.id,
        );
        audit(user, "restore-milestone", current);
      });
      return { data: { milestone: present(item(r.id), user) } };
    }
    fail(405, "不支持的里程碑操作");
  }
  return { api, summary };
}
