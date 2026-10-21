import { CoordinationSummary } from "./Relations.jsx";
import React, { useMemo, useState } from "react";
import { ListTodo, Search, ArrowUpRight, RefreshCw } from "lucide-react";
import {
  myTodos,
  dueState,
  filterRecords,
  pagination,
  SORT_OPTIONS,
  PRIORITIES,
  PAGE_SIZES,
  colorOf,
  dependencyInfo,
  splitNames,
  isCompleted,
} from "../model.js";
import { inputClass, secondary } from "./UI.jsx";
import { PriorityBadge, DueBadge } from "./Planning.jsx";
export default function MyTodos({
  user,
  records,
  projects,
  onOpen,
  onRefresh,
  error,
  loaded,
}) {
  const [keyword, setKeyword] = useState(""),
    [projectId, setProjectId] = useState(""),
    [scope, setScope] = useState("all"),
    [role, setRole] = useState("owner"),
    [blockedFilter, setBlockedFilter] = useState(""),
    [priority, setPriority] = useState(""),
    [sort, setSort] = useState("due_date-asc"),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [busy, setBusy] = useState(false);
  const todos = useMemo(
    () =>
      role === "support"
        ? records.filter(
            (r) =>
              !isCompleted(r) &&
              splitNames(r.support_people).includes(user?.name),
          )
        : myTodos(records, user?.name),
    [records, user?.name, role],
  );
  const filtered = filterRecords(todos, {
    projectId,
    keyword,
    sort,
    blocked: blockedFilter,
  }).filter(
    (r) =>
      (!priority || (r.priority || "normal") === priority) &&
      (scope === "all" ||
        (scope === "none"
          ? !r.due_date
          : scope === "upcoming"
            ? ["today", "soon"].includes(dueState(r))
            : dueState(r) === scope)),
  );
  const pg = pagination(filtered.length, page, pageSize);
  const change = (setter, v) => {
    setter(v);
    setPage(1);
  };
  return (
    <>
      <header className="topbar sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/60 bg-[#F6F7F9]/90 px-8 py-4 backdrop-blur-md">
        <span className="flex items-center gap-2 text-[13px] text-slate-500">
          <ListTodo className="h-4 w-4 text-indigo-400" />
          我的待办
        </span>
        <button
          disabled={busy}
          className={secondary + " text-xs"}
          onClick={async () => {
            setBusy(true);
            try {
              await onRefresh();
            } catch {
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw
            className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")}
          />
          刷新待办
        </button>
      </header>
      <div className="workbench-content mx-auto w-full max-w-5xl px-8 pb-12">
        <div className="pt-8">
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            我的待办
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {user?.name}，这里汇总所有项目中
            {role === "support"
              ? "需要你配合的未完成工作。"
              : "由你负责、尚未完成的工作。"}
          </p>
        </div>
        <div
          role="group"
          aria-label="个人工作范围"
          className="mt-5 inline-flex rounded-xl bg-slate-200/50 p-1"
        >
          {[
            ["owner", "我负责的"],
            ["support", "需要我配合"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={role === key}
              onClick={() => {
                setRole(key);
                setScope("all");
                setBlockedFilter("");
                setPage(1);
              }}
              className={
                "rounded-lg px-4 py-2 text-xs " +
                (role === key
                  ? "bg-white text-indigo-600 shadow-sm"
                  : "text-slate-500")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["全部待办", todos.length, "text-indigo-600", "all"],
            [
              "已逾期",
              todos.filter((r) => dueState(r) === "overdue").length,
              "text-rose-600",
              "overdue",
            ],
            [
              "今明到期",
              todos.filter((r) => ["today", "soon"].includes(dueState(r)))
                .length,
              "text-amber-600",
              "upcoming",
            ],
            [
              "未设计划日期",
              todos.filter((r) => !r.due_date).length,
              "text-slate-600",
              "none",
            ],
          ].map(([label, n, c, key]) => (
            <button
              key={key}
              aria-pressed={scope === key}
              onClick={() => change(setScope, key)}
              className={
                "rounded-2xl border bg-white p-5 text-left shadow-sm " +
                (scope === key
                  ? "border-indigo-300 ring-2 ring-indigo-50"
                  : "border-slate-200/70")
              }
            >
              <span className="text-xs text-slate-400">{label}</span>
              <strong className={"mt-3 block text-2xl " + c}>
                {n}
                <small className="ml-1 text-xs font-normal">项</small>
              </strong>
            </button>
          ))}
        </div>
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-600"
          >
            暂时无法同步：{error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <select
            aria-label="待办阻塞筛选"
            value={blockedFilter}
            onChange={(e) => change(setBlockedFilter, e.target.value)}
            className="planning-select"
          >
            <option value="">全部推进状态</option>
            <option value="blocked">阻塞中</option>
            <option value="ready">可推进</option>
          </select>
          <div className="relative min-w-0 flex-1 basis-48">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-300" />
            <input
              aria-label="搜索我的待办"
              placeholder="搜索任务或姓名"
              value={keyword}
              onChange={(e) => change(setKeyword, e.target.value)}
              className={inputClass + " bg-white pl-9"}
            />
          </div>
          <select
            aria-label="待办项目筛选"
            value={projectId}
            onChange={(e) => change(setProjectId, e.target.value)}
            className="planning-select"
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="待办优先级筛选"
            value={priority}
            onChange={(e) => change(setPriority, e.target.value)}
            className="planning-select"
          >
            <option value="">全部优先级</option>
            {PRIORITIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            aria-label="待办排序"
            value={sort}
            onChange={(e) => change(setSort, e.target.value)}
            className="planning-select"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {(keyword ||
          projectId ||
          priority ||
          blockedFilter ||
          scope !== "all") && (
          <button
            className="mt-3 text-xs text-indigo-500"
            onClick={() => {
              setKeyword("");
              setProjectId("");
              setPriority("");
              setScope("all");
              setBlockedFilter("");
              setPage(1);
            }}
          >
            重置待办筛选
          </button>
        )}
        <section
          aria-label="我的待办列表"
          className="mt-4 overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm"
        >
          <div className="divide-y divide-slate-100">
            {filtered.slice(pg.start, pg.start + pageSize).map((r) => {
              const project = projects.find((p) => p.id === r.project_id),
                parent = records.find((p) => p.id === r.parent_id);
              return (
                <button
                  key={r.id}
                  data-todo-id={r.id}
                  onClick={() => onOpen(r)}
                  className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-indigo-50/40"
                >
                  <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-400">
                    <ListTodo className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block whitespace-pre-wrap break-words text-sm font-medium text-slate-800">
                      {r.task}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
                        <i
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: colorOf(project?.color).to }}
                        />
                        {project?.name}
                      </span>
                      <PriorityBadge value={r.priority} />
                      <DueBadge record={r} />
                    </span>
                    <CoordinationSummary record={r} />
                    <span className="mt-2 block text-xs text-slate-400">
                      负责人：{r.owner}
                      {parent ? " · 上级任务：" + parent.task : ""}
                    </span>
                  </span>
                  <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-slate-300" />
                </button>
              );
            })}
          </div>
          {!filtered.length && (
            <p className="px-6 py-16 text-center text-sm text-slate-400">
              {!loaded
                ? "正在加载待办…"
                : todos.length
                  ? "没有符合筛选条件的待办"
                  : "当前没有未完成的负责事项"}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-5 py-3 text-xs text-slate-400">
            <span>
              共 {filtered.length} 项待办 · 第 {pg.page}/{pg.pages} 页
            </span>
            <div className="flex items-center gap-2">
              <label>
                每页{" "}
                <select
                  aria-label="待办每页条数"
                  value={pageSize}
                  onChange={(e) => change(setPageSize, Number(e.target.value))}
                  className="rounded-lg border border-slate-200 bg-white p-1"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={secondary + " px-2 text-xs"}
                disabled={pg.page <= 1}
                onClick={() => setPage(pg.page - 1)}
              >
                上一页
              </button>
              <button
                className={secondary + " px-2 text-xs"}
                disabled={pg.page >= pg.pages}
                onClick={() => setPage(pg.page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
        <p className="mt-5 text-center text-xs leading-relaxed text-slate-400">
          {role === "support"
            ? "需要配合的人包含你，且任务尚未完成时，在这里显示。"
            : "原定负责人包含你，且实际完成人与完成日期均为空时，显示为待办。"}
          计划日期和阻塞标记不影响完成状态。
        </p>
      </div>
    </>
  );
}
