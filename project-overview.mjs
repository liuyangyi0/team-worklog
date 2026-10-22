import {
  libraryFail as fail,
  libraryTx,
  installLibraryCommon,
  resourceEvent,
} from "./library-common.mjs";
import { hydrateRelations } from "./dependencies.mjs";
import {
  beijingDate,
  contributionRecords,
  dependencyInfo,
  isCompleted,
} from "./src/model.js";

const number = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const text = (body, key, maximum, old = "") => {
  const value = body[key] === undefined ? old : body[key];
  if (typeof value !== "string" || value.trim().length > maximum)
    fail(400, "项目管理资料填写无效");
  return value.trim();
};
function calendar(value) {
  if (value === "") return "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1 ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail(400, "目标交付日期无效");
  return value;
}
function milestoneProjection(summary = {}) {
  summary = summary && typeof summary === "object" ? summary : {};
  const next = summary.next || summary.next_milestone || null;
  return {
    total: number(summary.total),
    achieved: number(summary.achieved ?? summary.completed),
    overdue: number(summary.overdue),
    next:
      next && typeof next.id === "string"
        ? {
            id: next.id,
            title: String(next.title || ""),
            planned_date: String(
              next.planned_date || next.target_date || next.due_date || "",
            ),
            owner: String(next.owner || ""),
            status: String(next.status || ""),
          }
        : null,
  };
}
function changeProjection(summary = {}) {
  summary = summary && typeof summary === "object" ? summary : {};
  return Object.fromEntries(
    [
      "total",
      "pending",
      "confirmed",
      "in_progress",
      "implemented",
      "rejected",
    ].map((key) => [key, number(summary[key])]),
  );
}
export function createProjectOverview({
  db,
  getMilestoneSummary = () => ({}),
  getChangeSummary = () => ({}),
  checklistSummary = () => ({}),
}) {
  installLibraryCommon(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS project_management(project_id TEXT PRIMARY KEY REFERENCES projects(id),owner TEXT NOT NULL DEFAULT '',stage TEXT NOT NULL DEFAULT '',target_date TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL)",
  );
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const project = (id) => {
    const row = get("SELECT * FROM projects WHERE id=?", id);
    if (!row) fail(404, "项目不存在");
    return row;
  };
  const management = (id) =>
    get(
      "SELECT project_id,owner,stage,target_date,version,updated_at FROM project_management WHERE project_id=?",
      id,
    ) || {
      project_id: id,
      owner: "",
      stage: "",
      target_date: "",
      version: 0,
      updated_at: "",
    };
  async function overview(user) {
    const rows = db
      .prepare(
        "SELECT r.*,(SELECT COUNT(*) FROM records c WHERE c.parent_id=r.id AND c.deleted=0) AS child_count FROM records r WHERE r.deleted=0",
      )
      .all();
    const records = hydrateRelations(db, rows);
    const today = beijingDate(),
      checklists = user ? await checklistSummary() : null;
    const projects = await Promise.all(
      db
        .prepare(
          "SELECT id,name,color,archived,created FROM projects ORDER BY archived,created,id",
        )
        .all()
        .map(async (p) => {
          const leaf = contributionRecords(
            records.filter((r) => r.project_id === p.id),
          );
          const pending = leaf.filter((r) => !isCompleted(r));
          const overdue = pending.filter(
            (r) => r.due_date && r.due_date < today,
          );
          const blocked = pending.filter((r) => dependencyInfo(r).blocked);
          const important = [...pending]
            .sort(
              (a, b) =>
                Number(dependencyInfo(b).blocked) -
                  Number(dependencyInfo(a).blocked) ||
                (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
                (a.created || "").localeCompare(b.created || ""),
            )
            .slice(0, 3)
            .map((r) => ({
              id: r.id,
              project_id: r.project_id,
              task: r.task,
              owner: r.owner,
              actual: r.actual,
              date: r.date,
              due_date: r.due_date || "",
              blocked: dependencyInfo(r).blocked,
            }));
          const result = {
            ...p,
            archived: Boolean(p.archived),
            management: management(p.id),
            task_summary: {
              total: leaf.length,
              completed: leaf.length - pending.length,
              pending: pending.length,
              overdue: overdue.length,
              blocked: blocked.length,
              important,
            },
            milestones: milestoneProjection(await getMilestoneSummary(p.id)),
          };
          if (user) {
            const checklist = checklists?.[p.id] || {};
            result.handover_missing = number(
              checklist.evidence_missing ?? checklist.missing,
            );
            result.changes = changeProjection(await getChangeSummary(p.id));
          }
          return result;
        }),
    );
    return { projects, today, can_view_internal: Boolean(user) };
  }
  async function api({ route, method, b = {}, user }) {
    route = route.replace(/^\/api(?=\/)/, "");
    if (route === "/project-overview") {
      if (method !== "GET") fail(405, "总览仅供读取");
      return { data: await overview(user) };
    }
    const match = route.match(/^\/projects\/([\w-]+)\/management$/);
    if (!match) return null;
    const id = match[1];
    project(id);
    if (method === "GET") return { data: { management: management(id) } };
    if (method !== "PATCH") fail(405, "不支持的项目资料操作");
    if (!user) fail(401, "请先登录");
    const old = management(id);
    if (!Number.isInteger(b.version) || b.version !== old.version)
      fail(409, "项目管理资料刚被他人修改，请载入最新内容后重试");
    const next = {
      owner: text(b, "owner", 100, old.owner),
      stage: text(b, "stage", 40, old.stage),
      target_date: calendar(text(b, "target_date", 10, old.target_date)),
    };
    libraryTx(db, () => {
      const current = management(id);
      if (current.version !== old.version)
        fail(409, "项目管理资料刚被他人修改，请载入最新内容后重试");
      db.prepare(
        "INSERT INTO project_management(project_id,owner,stage,target_date,version,updated_at,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET owner=excluded.owner,stage=excluded.stage,target_date=excluded.target_date,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
      ).run(
        id,
        next.owner,
        next.stage,
        next.target_date,
        old.version + 1,
        new Date().toISOString(),
        user.id,
      );
      resourceEvent(db, user, {
        action: "update-project-management",
        entityType: "project-management",
        entityId: id,
        projectId: id,
        details: {
          fields: ["owner", "stage", "target_date"],
          from: JSON.stringify({
            owner: old.owner,
            stage: old.stage,
            target_date: old.target_date,
          }),
          to: JSON.stringify(next),
        },
      });
    });
    return { data: { management: management(id) } };
  }
  return { api };
}
