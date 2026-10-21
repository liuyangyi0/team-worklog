import { splitNames } from "./people.js";
export { splitNames };
export function isCompleted(record) {
  return Boolean(record.date || splitNames(record.actual).length);
}
export function completionDateLabel(record) {
  return record.date || (isCompleted(record) ? "" : "未完成");
}
export const PAGE_SIZE = 5;
export const PAGE_SIZES = [5, 10, 20, 50, 100];
export const PRIORITIES = [
  {
    id: "urgent",
    label: "紧急",
    rank: 4,
    className: "bg-rose-50 text-rose-600 ring-rose-100",
  },
  {
    id: "high",
    label: "高",
    rank: 3,
    className: "bg-amber-50 text-amber-600 ring-amber-100",
  },
  {
    id: "normal",
    label: "普通",
    rank: 2,
    className: "bg-slate-100 text-slate-500 ring-slate-200",
  },
  {
    id: "low",
    label: "低",
    rank: 1,
    className: "bg-sky-50 text-sky-600 ring-sky-100",
  },
];
export const priorityOf = (id) =>
  PRIORITIES.find((p) => p.id === id) || PRIORITIES[2];
export function beijingDate(time = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
}
export function dueState(record, today = beijingDate()) {
  if (!record.due_date || isCompleted(record)) return "";
  if (record.due_date < today) return "overdue";
  if (record.due_date === today) return "today";
  const tomorrow = new Date(today + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return record.due_date === tomorrow.toISOString().slice(0, 10)
    ? "soon"
    : "later";
}
export function myTodos(records, name) {
  return name
    ? records.filter(
        (r) => !isCompleted(r) && splitNames(r.owner).includes(name),
      )
    : [];
}
export const SORT_OPTIONS = [
  {
    id: "due_date-asc",
    field: "due_date",
    direction: 1,
    label: "计划日期 · 从近到远",
  },
  {
    id: "due_date-desc",
    field: "due_date",
    direction: -1,
    label: "计划日期 · 从远到近",
  },
  {
    id: "priority-desc",
    field: "priority",
    direction: -1,
    label: "优先级 · 从高到低",
  },
  {
    id: "priority-asc",
    field: "priority",
    direction: 1,
    label: "优先级 · 从低到高",
  },
  {
    id: "date-desc",
    field: "date",
    direction: -1,
    label: "完成日期 · 从新到旧",
  },
  { id: "date-asc", field: "date", direction: 1, label: "完成日期 · 从旧到新" },
  {
    id: "created-desc",
    field: "created",
    direction: -1,
    label: "登记时间 · 从新到旧",
  },
  {
    id: "created-asc",
    field: "created",
    direction: 1,
    label: "登记时间 · 从旧到新",
  },
  { id: "task-asc", field: "task", direction: 1, label: "工作事项 · 升序" },
  { id: "task-desc", field: "task", direction: -1, label: "工作事项 · 降序" },
  { id: "owner-asc", field: "owner", direction: 1, label: "原定负责人 · 升序" },
  {
    id: "owner-desc",
    field: "owner",
    direction: -1,
    label: "原定负责人 · 降序",
  },
  {
    id: "actual-asc",
    field: "actual",
    direction: 1,
    label: "实际完成人 · 升序",
  },
  {
    id: "actual-desc",
    field: "actual",
    direction: -1,
    label: "实际完成人 · 降序",
  },
];
export const COLORS = [
  { id: "indigo", label: "靛紫", from: "#818cf8", to: "#4f46e5" },
  { id: "emerald", label: "青绿", from: "#34d399", to: "#059669" },
  { id: "amber", label: "琥珀", from: "#fbbf24", to: "#d97706" },
  { id: "rose", label: "玫红", from: "#fb7185", to: "#e11d48" },
  { id: "sky", label: "天蓝", from: "#38bdf8", to: "#0284c7" },
  { id: "violet", label: "罗兰", from: "#a78bfa", to: "#7c3aed" },
];
const palettes = [
  { bg: "#e0e7ff", text: "#4338ca", ring: "#c7d2fe", dot: "#6366f1" },
  { bg: "#d1fae5", text: "#047857", ring: "#a7f3d0", dot: "#10b981" },
  { bg: "#fef3c7", text: "#b45309", ring: "#fde68a", dot: "#f59e0b" },
  { bg: "#ffe4e6", text: "#be123c", ring: "#fecdd3", dot: "#f43f5e" },
  { bg: "#e0f2fe", text: "#0369a1", ring: "#bae6fd", dot: "#0ea5e9" },
  { bg: "#ede9fe", text: "#6d28d9", ring: "#ddd6fe", dot: "#8b5cf6" },
];
export function personStyle(name) {
  const fixed = { 张三: 0, 李四: 1, 王五: 2, 赵六: 3 };
  let hash = 0;
  for (const c of name) hash = (Math.imul(hash, 31) + c.codePointAt(0)) >>> 0;
  return palettes[fixed[name] ?? hash % palettes.length];
}
export function colorOf(id) {
  return COLORS.find((c) => c.id === id) || COLORS[0];
}
export function monthLabel(month) {
  if (!month) return "全部日期";
  if (month === "none") return "未完成";
  return month.slice(0, 4) + "年" + Number(month.slice(5)) + "月";
}
export function filterRecords(
  records,
  {
    projectId,
    month = "",
    people = [],
    keyword = "",
    sort = "date-desc",
    priority = "",
    due = "",
    blocked = "",
  } = {},
) {
  const q = keyword.trim().toLocaleLowerCase();
  const order =
    SORT_OPTIONS.find((option) => option.id === sort) ||
    SORT_OPTIONS.find((option) => option.id === "date-desc");
  return records
    .filter(
      (r) =>
        (!projectId || r.project_id === projectId) &&
        (!priority || priorityOf(r.priority).id === priority) &&
        (!blocked ||
          (blocked === "blocked"
            ? dependencyInfo(r).blocked
            : !isCompleted(r) && !dependencyInfo(r).blocked)) &&
        (!due ||
          (due === "none"
            ? !r.due_date
            : due === "upcoming"
              ? ["today", "soon"].includes(dueState(r))
              : dueState(r) === due)) &&
        (!month ||
          (month === "none" ? !isCompleted(r) : recordMonth(r) === month)) &&
        (!people.length ||
          splitNames(r.actual).some((n) => people.includes(n))) &&
        (!q ||
          (
            r.task +
            " " +
            r.owner +
            " " +
            r.actual +
            " " +
            (r.support_people || "") +
            " " +
            (r.blocker_note || "") +
            " " +
            (r.dependency_tasks || [])
              .map((t) => t.task + " " + t.owner)
              .join(" ")
          )
            .toLocaleLowerCase()
            .includes(q)),
    )
    .sort((a, b) => {
      if (order.field === "priority")
        return (
          (priorityOf(a.priority).rank - priorityOf(b.priority).rank) *
            order.direction ||
          (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
          String(a.id || "").localeCompare(String(b.id || ""))
        );
      const av = String(a[order.field] || ""),
        bv = String(b[order.field] || "");
      if (!av !== !bv) return av ? -1 : 1;
      return (
        av.localeCompare(bv, "zh-CN", { numeric: true }) * order.direction ||
        (b.created || "").localeCompare(a.created || "") ||
        String(a.id || "").localeCompare(String(b.id || ""))
      );
    });
}
export function personSummary(records) {
  records = contributionRecords(records);
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name))
      map.set(name, {
        name,
        done: 0,
        pending: 0,
        unassigned: 0,
        owned: 0,
        records: [],
      });
    return map.get(name);
  };
  for (const r of records) {
    const owners = splitNames(r.owner);
    for (const owner of owners) ensure(owner).owned++;
    const names = splitNames(r.actual);
    if (!names.length) {
      for (const owner of owners) {
        const p = ensure(owner);
        if (isCompleted(r)) p.unassigned++;
        else p.pending++;
        p.records.push(r);
      }
      continue;
    }
    for (const name of names) {
      const p = ensure(name);
      p.done++;
      p.records.push(r);
    }
  }
  return [...map.values()].sort(
    (a, b) => b.done - a.done || a.name.localeCompare(b.name, "zh"),
  );
}
export function statistics(records) {
  records = contributionRecords(records);
  const completed = records.filter(isCompleted),
    attributed = completed.filter((r) => splitNames(r.actual).length),
    dated = completed.filter((r) => r.date),
    people = new Set(records.flatMap((r) => splitNames(r.actual))),
    other = attributed.filter(
      (r) =>
        !splitNames(r.owner).some((owner) =>
          splitNames(r.actual).includes(owner),
        ),
    ).length;
  return {
    total: completed.length,
    people: people.size,
    days: new Set(dated.map((r) => r.date)).size,
    undated: completed.length - dated.length,
    pending: records.length - completed.length,
    unassigned: completed.length - attributed.length,
    latest:
      dated
        .map((r) => r.date)
        .sort()
        .at(-1) || "",
    other,
    otherPct: attributed.length
      ? Math.round((other / attributed.length) * 100)
      : 0,
  };
}
export function pagination(total, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size)),
    safe = Math.max(1, Math.min(page, pages));
  const nums = [
    1,
    ...Array.from({ length: 5 }, (_, i) => safe + i - 2).filter(
      (n) => n > 1 && n < pages,
    ),
    pages,
  ];
  return {
    pages,
    page: safe,
    start: (safe - 1) * size,
    numbers: [...new Set(nums)],
  };
}
export function availablePeople(project, records, user) {
  return [
    ...new Set([
      ...(project?.members || []),
      ...records.flatMap((r) => [
        ...splitNames(r.owner),
        ...splitNames(r.actual),
      ]),
      ...(user ? [user.name] : []),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh"));
}

export function recordMonth(record, includePending = false) {
  if (record.date) return record.date.slice(0, 7);
  if (!isCompleted(record) && !includePending) return "";
  const timestamp = record.completed_at || record.created;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(new Date(timestamp));
}
export function contributionRecords(records) {
  const parents = new Set(records.map((r) => r.parent_id).filter(Boolean));
  return records.filter((r) => !r.child_count && !parents.has(r.id));
}
export function taskTree(allRecords, matching, sort = "date-desc") {
  const source = new Map(allRecords.map((r) => [r.id, r])),
    ids = new Set(matching.map((r) => r.id)),
    matched = new Set(ids);
  for (const r of matching) {
    let parent = r.parent_id;
    const seen = new Set([r.id]);
    while (parent && source.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      ids.add(parent);
      parent = source.get(parent).parent_id;
    }
  }
  const ordered = filterRecords(allRecords, { sort }).filter((r) =>
      ids.has(r.id),
    ),
    roots = [],
    children = new Map();
  for (const r of ordered) {
    if (r.parent_id && ids.has(r.parent_id)) {
      if (!children.has(r.parent_id)) children.set(r.parent_id, []);
      children.get(r.parent_id).push(r);
    } else roots.push(r);
  }
  return { roots, children, matched };
}
export function peopleOverview(projects, records) {
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const stats = personSummary(records);
  return stats.map((person) => {
    const assigned = contributionRecords(records).filter(
      (r) =>
        splitNames(r.owner).includes(person.name) ||
        splitNames(r.actual).includes(person.name),
    );
    return {
      ...person,
      related: assigned,
      projects: [...new Set(assigned.map((r) => r.project_id))]
        .map((id) => projectsById.get(id))
        .filter(Boolean),
      joint: assigned.filter(
        (r) =>
          splitNames(r.actual).includes(person.name) &&
          splitNames(r.actual).length > 1,
      ).length,
      helped: assigned.filter(
        (r) =>
          splitNames(r.actual).includes(person.name) &&
          !splitNames(r.owner).includes(person.name),
      ).length,
    };
  });
}

export function dependencyInfo(record) {
  const waiting = (record.dependency_tasks || []).filter(
    (r) => !r.deleted && !isCompleted(r),
  );
  const manual = Boolean(record.blocked);
  return {
    waiting,
    manual,
    blocked: !isCompleted(record) && (manual || waiting.length > 0),
    helpers: splitNames(record.support_people),
  };
}
export function coordinationText(record) {
  const info = dependencyInfo(record);
  return [
    info.blocked ? "阻塞中" : "",
    !isCompleted(record) && info.waiting.length
      ? "等待：" +
        info.waiting.map((r) => r.task + "（" + r.owner + "）").join("、")
      : "",
    !isCompleted(record) && info.manual && record.blocker_note
      ? "阻塞说明：" + record.blocker_note
      : "",
    info.helpers.length ? "需要配合：" + info.helpers.join("、") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
