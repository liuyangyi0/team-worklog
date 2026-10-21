import { CoordinationSummary } from "./Relations.jsx";
import { PriorityBadge, DueBadge } from "./Planning.jsx";
import React, { useRef, useState } from "react";
import {
  LayoutGrid,
  ChevronRight,
  ChevronDown,
  Plus,
  LogIn,
  LogOut,
  KeyRound,
  CalendarDays,
  ChevronLeft,
  Check,
  Search,
  X,
  MoreHorizontal,
  Pencil,
  Trash2,
  CalendarX,
  CheckCircle2,
  ArrowUpDown,
  ArrowUpRight,
  UsersRound,
  Palette,
  GitBranch,
  MessageSquare,
  ListTodo,
  Bell,
  Archive,
} from "lucide-react";
import { AvatarChip, DateBadge, Popover, primary, secondary } from "./UI.jsx";
import {
  colorOf,
  monthLabel,
  personStyle,
  personSummary,
  splitNames,
  pagination,
  PAGE_SIZES,
  SORT_OPTIONS,
  completionDateLabel,
  isCompleted,
  recordMonth,
  contributionRecords,
  PRIORITIES,
} from "../model.js";
export function Sidebar({
  projects,
  project,
  user,
  onSelect,
  onNew,
  onLogin,
  onPassword,
  onLogout,
  overview,
  onOverview,
  onSettings,
  todoActive,
  todoCount = 0,
  unread = 0,
  onTodos,
  onNotifications,
}) {
  const anchor = useRef(null),
    [accountOpen, setAccountOpen] = useState(false),
    [archivedOpen, setArchivedOpen] = useState(false);
  const activeProjects = projects.filter((p) => !p.archived),
    archivedProjects = projects.filter((p) => p.archived),
    showArchived = archivedOpen || Boolean(project?.archived);
  function projectEntry(p) {
    const active = !overview && !todoActive && p.id === project?.id,
      c = colorOf(p.color);
    return (
      <div key={p.id} className="project-entry relative">
        <button
          onClick={() => onSelect(p)}
          aria-current={active ? "page" : undefined}
          className={
            "project-button group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] transition-all " +
            (active
              ? "font-medium text-white shadow-lg shadow-black/15"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200")
          }
          style={
            active
              ? {
                  backgroundImage:
                    "linear-gradient(100deg," + c.to + "b3," + c.to + "80)",
                }
              : undefined
          }
        >
          <span
            className={
              "h-2 w-2 shrink-0 rounded-full " +
              (active ? "ring-2 ring-white/40" : "opacity-70")
            }
            style={{
              background: "linear-gradient(135deg," + c.from + "," + c.to + ")",
            }}
          />
          <span className="truncate" title={p.name}>
            {p.name}
          </span>
          {active && (
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
        </button>
        <button
          type="button"
          aria-label={"修改 " + p.name + " 标识色"}
          title="修改项目标识色"
          onClick={() => onSettings(p)}
          className="absolute left-0 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-transparent hover:bg-slate-900/20 hover:text-white focus-visible:text-white"
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return (
    <aside className="workbench-sidebar relative flex w-60 shrink-0 flex-col overflow-hidden bg-[#0C1322] text-slate-300">
      <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl" />
      <div className="pointer-events-none absolute bottom-10 -right-16 h-48 w-48 rounded-full bg-sky-500/10 blur-3xl" />
      <div className="relative flex items-center gap-2.5 px-5 pb-6 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-400 to-indigo-600 shadow-lg shadow-indigo-500/30">
          <LayoutGrid className="h-5 w-5 text-white" strokeWidth={2.2} />
        </div>
        <div>
          <div className="text-[15px] font-semibold tracking-wide text-white">
            项目工作台
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Workbench
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-3">
        <button
          onClick={onTodos}
          className={
            "personal-nav mb-2 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors " +
            (todoActive
              ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/20"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200")
          }
        >
          <ListTodo className="h-4 w-4 shrink-0" />
          我的待办
          {user && (
            <span className="ml-auto rounded-md bg-white/10 px-1.5 py-0.5 text-[10px]">
              {todoCount}
            </span>
          )}
        </button>
        {user && (
          <button
            onClick={onNotifications}
            className="personal-nav mb-2 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <Bell className="h-4 w-4 shrink-0" />
            站内提醒
            {unread > 0 && (
              <span
                aria-label={unread + " 条未读提醒"}
                className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] text-white"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        )}
        <button
          onClick={onOverview}
          className={
            "overview-nav mb-5 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors " +
            (overview
              ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400/20"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200")
          }
        >
          <UsersRound className="h-4 w-4 shrink-0" />
          跨项目人员总览
        </button>
        <div className="project-caption px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
          我的项目
        </div>
        <nav aria-label="项目" className="project-nav space-y-1">
          {activeProjects.map(projectEntry)}
        </nav>
        <button
          onClick={onNew}
          className="new-project mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-600/70 py-2.5 text-[13px] text-slate-400 transition-all hover:border-indigo-400/60 hover:text-indigo-300 active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          新建项目
        </button>
        {archivedProjects.length > 0 && (
          <div className="archived-projects mt-5 pb-3">
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={() => setArchivedOpen(!showArchived)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-medium tracking-[0.14em] text-slate-500 hover:text-slate-300"
            >
              <Archive className="h-3.5 w-3.5" />
              已归档 · {archivedProjects.length}
              <ChevronDown
                className={
                  "ml-auto h-3.5 w-3.5 transition-transform " +
                  (showArchived ? "rotate-180" : "")
                }
              />
            </button>
            {showArchived && (
              <nav
                aria-label="已归档项目"
                className="mt-1 space-y-1 opacity-80"
              >
                {archivedProjects.map(projectEntry)}
              </nav>
            )}
          </div>
        )}
      </div>
      <div className="account-area relative p-3">
        {user ? (
          <>
            <button
              ref={anchor}
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((v) => !v)}
              className="flex w-full items-center gap-3 rounded-xl bg-white/5 px-3 py-3 text-left ring-1 ring-white/10 backdrop-blur hover:bg-white/10"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-500 to-slate-700 text-sm font-semibold text-white ring-2 ring-white/20">
                {user.name[0]}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-slate-100">
                  {user.name}
                </div>
                <div className="text-[11px] text-slate-500">
                  {user.role === "admin" ? "管理员" : user.login}
                </div>
              </div>
              <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-500" />
            </button>
            {accountOpen && (
              <Popover
                anchor={anchor}
                width={210}
                onClose={() => setAccountOpen(false)}
              >
                <div className="p-1.5">
                  <button
                    onClick={() => {
                      setAccountOpen(false);
                      onPassword();
                    }}
                    className="menu-item"
                  >
                    <KeyRound className="h-4 w-4" />
                    修改密码
                  </button>
                  <button
                    onClick={() => {
                      setAccountOpen(false);
                      onLogout();
                    }}
                    className="menu-item"
                  >
                    <LogOut className="h-4 w-4" />
                    退出登录
                  </button>
                </div>
              </Popover>
            )}
          </>
        ) : (
          <button
            onClick={onLogin}
            className="flex w-full items-center gap-3 rounded-xl bg-white/5 px-3 py-3 text-left ring-1 ring-white/10 hover:bg-white/10"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-700 text-slate-200">
              <LogIn className="h-4 w-4" />
            </span>
            <span>
              <strong className="block text-[13px] font-medium text-slate-100">
                登录 / 注册
              </strong>
              <small className="text-[11px] text-slate-500">
                公开查看，登录后填写
              </small>
            </span>
            <ChevronRight className="ml-auto h-4 w-4 text-slate-500" />
          </button>
        )}
      </div>
    </aside>
  );
}
export function MonthSelect({ month, records, onChange }) {
  const anchor = useRef(null),
    [open, setOpen] = useState(false),
    [year, setYear] = useState(new Date().getFullYear());
  function select(value) {
    onChange(value);
    setOpen(false);
  }
  return (
    <>
      <button
        ref={anchor}
        aria-label={"选择月份：" + monthLabel(month)}
        aria-expanded={open}
        onClick={() => {
          setYear(
            month && month !== "none"
              ? Number(month.slice(0, 4))
              : new Date().getFullYear(),
          );
          setOpen((v) => !v);
        }}
        className={
          secondary +
          " px-3.5 " +
          (open
            ? "border-indigo-300 text-indigo-600 ring-4 ring-indigo-100"
            : "")
        }
      >
        <CalendarDays className="h-4 w-4 text-slate-400" />
        {monthLabel(month)}
        <ChevronDown
          className={
            "h-3.5 w-3.5 text-slate-400 transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} width={280}>
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <button
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 disabled:opacity-30"
                aria-label="上一年"
                disabled={year <= 1900}
                onClick={() => setYear((y) => y - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-semibold text-slate-600">
                {year} 年
              </span>
              <button
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 disabled:opacity-30"
                aria-label="下一年"
                disabled={year >= 9999}
                onClick={() => setYear((y) => y + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: 12 }, (_, i) => {
                const m =
                    String(year).padStart(4, "0") +
                    "-" +
                    String(i + 1).padStart(2, "0"),
                  count = contributionRecords(records).filter(
                    (r) => recordMonth(r) === m,
                  ).length;
                return (
                  <button
                    key={m}
                    onClick={() => select(m)}
                    aria-pressed={month === m}
                    className={
                      "flex flex-col items-center rounded-xl py-2 transition-all active:scale-95 " +
                      (month === m
                        ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                        : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-600")
                    }
                  >
                    <span className="text-[13px] font-semibold">{i + 1}月</span>
                    <span
                      className={
                        "mt-0.5 text-[10px] " +
                        (month === m ? "text-indigo-200" : "text-slate-300")
                      }
                    >
                      {count} 条
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
              <button
                onClick={() => select("")}
                className={
                  "flex-1 rounded-xl py-2 text-xs " +
                  (!month
                    ? "bg-indigo-50 text-indigo-600"
                    : "text-slate-400 hover:bg-slate-50")
                }
              >
                全部日期
              </button>
              <button
                onClick={() => select("none")}
                className={
                  "flex-1 rounded-xl py-2 text-xs " +
                  (month === "none"
                    ? "bg-indigo-50 text-indigo-600"
                    : "text-slate-400 hover:bg-slate-50")
                }
              >
                未完成
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
function SortButton({ value, onChange }) {
  const anchor = useRef(null),
    [open, setOpen] = useState(false);
  const current =
    SORT_OPTIONS.find((option) => option.id === value) || SORT_OPTIONS[0];
  return (
    <div className="sort-control ml-auto">
      <button
        ref={anchor}
        type="button"
        aria-label={"列表排序：" + current.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={secondary + " max-w-full px-3"}
      >
        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="truncate">排序：{current.label}</span>
      </button>
      {open && (
        <Popover anchor={anchor} width={250} onClose={() => setOpen(false)}>
          <div role="menu" aria-label="列表排序" className="p-1.5">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={value === option.id}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                  anchor.current?.focus();
                }}
                className={
                  "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs hover:bg-slate-50 " +
                  (value === option.id
                    ? "bg-indigo-50 text-indigo-600"
                    : "text-slate-600")
                }
              >
                {option.label}
                {value === option.id && (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
export function Filters({
  keyword,
  onKeyword,
  people,
  selected,
  onSelected,
  onClear,
  active,
  sort,
  onSort,
  priority,
  onPriority,
  due,
  onDue,
  blocked,
  onBlocked,
}) {
  const anchor = useRef(null),
    [open, setOpen] = useState(false);
  return (
    <div className="filter-bar mt-4 flex flex-wrap items-center gap-3">
      <div className="search-field relative w-64">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
        <input
          aria-label="搜索工作或姓名"
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          placeholder="搜索工作或姓名"
          className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-8 text-[13px] text-slate-700 shadow-sm outline-none transition-all placeholder:text-slate-300 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
        />
        {keyword && (
          <button
            aria-label="清空搜索"
            onClick={() => onKeyword("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <button
        ref={anchor}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          secondary +
          " px-3.5 " +
          (open || selected.length
            ? "border-indigo-300 text-indigo-600 ring-4 ring-indigo-100"
            : "")
        }
      >
        {selected.length ? "已选 " + selected.length + " 人" : "全部完成人"}
        <ChevronDown
          className={
            "h-3.5 w-3.5 text-slate-400 transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <Popover anchor={anchor} width={230} onClose={() => setOpen(false)}>
          <div className="p-1.5" role="group" aria-label="完成人筛选">
            {people.length ? (
              people.map((n) => {
                const s = personStyle(n),
                  checked = selected.includes(n);
                return (
                  <button
                    key={n}
                    aria-pressed={checked}
                    onClick={() =>
                      onSelected(
                        checked
                          ? selected.filter((x) => x !== n)
                          : [...selected, n],
                      )
                    }
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-slate-50"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{
                        background: s.bg,
                        color: s.text,
                        boxShadow: "0 0 0 1px " + s.ring,
                      }}
                    >
                      {n[0]}
                    </span>
                    <span className="break-words text-[13px] text-slate-700">
                      {n}
                    </span>
                    <span
                      className={
                        "ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md " +
                        (checked
                          ? "bg-indigo-500 text-white"
                          : "bg-slate-100 text-transparent")
                      }
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="px-3 py-5 text-center text-xs text-slate-400">
                暂无实际完成人
              </p>
            )}
            {selected.length > 0 && (
              <button
                onClick={() => onSelected([])}
                className="mt-1 w-full border-t border-slate-100 py-2 text-xs text-slate-400 hover:text-indigo-500"
              >
                清空人员筛选
              </button>
            )}
          </div>
        </Popover>
      )}
      {onPriority && (
        <select
          aria-label="优先级筛选"
          value={priority}
          onChange={(e) => onPriority(e.target.value)}
          className="planning-select"
        >
          <option value="">全部优先级</option>
          {PRIORITIES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      {onDue && (
        <select
          aria-label="计划日期筛选"
          value={due}
          onChange={(e) => onDue(e.target.value)}
          className="planning-select"
        >
          <option value="">全部计划日期</option>
          <option value="overdue">已逾期</option>
          <option value="upcoming">今明到期</option>
          <option value="none">未设计划日期</option>
        </select>
      )}
      {onBlocked && (
        <select
          aria-label="阻塞状态筛选"
          value={blocked}
          onChange={(e) => onBlocked(e.target.value)}
          className="planning-select"
        >
          <option value="">全部推进状态</option>
          <option value="blocked">阻塞中</option>
          <option value="ready">可推进</option>
        </select>
      )}
      {active && (
        <button
          onClick={onClear}
          className="text-xs text-slate-400 hover:text-indigo-500"
        >
          重置筛选
        </button>
      )}
      {sort && <SortButton value={sort} onChange={onSort} />}
      <span className="sync-note ml-auto text-xs text-slate-400">
        多人协作 · 实时记录
      </span>
    </div>
  );
}
export function DetailTable({
  records,
  total,
  matchingTotal = total,
  tree,
  allRecords = records,
  forceExpand = false,
  page,
  pageSize,
  onPageSize,
  onPage,
  onEdit,
  onDelete,
  onOpen,
  onAddChild,
  capture = false,
  emptyAction,
  selected,
  onSelect,
}) {
  const selectable = Boolean(selected && onSelect && !capture);
  const [menu, setMenu] = useState(null),
    [expanded, setExpanded] = useState(new Set()),
    anchor = useRef(null),
    pg = pagination(total, page, pageSize);
  const rows = [];
  function visit(record, depth) {
    rows.push({ record, depth });
    if (capture || forceExpand || expanded.has(record.id))
      for (const child of tree?.children.get(record.id) || [])
        visit(child, depth + 1);
  }
  records.forEach((r) => visit(r, 0));
  const visibleIds = rows.map(({ record }) => record.id),
    allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selected?.has(id));
  function toggle(id) {
    setExpanded((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  return (
    <div className="record-table overflow-visible rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="table-viewport overflow-x-auto rounded-t-2xl">
        <table className="w-full min-w-[640px] table-fixed">
          <colgroup>
            <col className="task-col" style={{ width: "37%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "23%" }} />
            <col className="date-col" style={{ width: "17%" }} />
            {!capture && <col className="action-col" style={{ width: "6%" }} />}
          </colgroup>
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-medium tracking-wide text-slate-400">
              <th className="rounded-tl-2xl px-6 py-3.5">
                {selectable ? (
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label="选择本页全部记录"
                      checked={allVisibleSelected}
                      disabled={!visibleIds.length}
                      onChange={(e) => onSelect(visibleIds, e.target.checked)}
                      className="row-select h-3.5 w-3.5 accent-indigo-600"
                    />
                    工作事项
                  </label>
                ) : (
                  "工作事项"
                )}
              </th>
              <th className="px-4 py-3.5">原定负责人</th>
              <th className="px-4 py-3.5">实际完成人</th>
              <th className="px-4 py-3.5">完成日期</th>
              {!capture && (
                <th className="action-heading rounded-tr-2xl py-3.5 text-center">
                  操作
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ record: r, depth }) => {
              const names = splitNames(r.actual),
                children = tree?.children.get(r.id) || [],
                allChildren = allRecords.filter((c) => c.parent_id === r.id),
                self = names.length === 1 && names[0] === r.owner;
              return (
                <tr
                  key={r.id}
                  data-record-id={r.id}
                  data-task-depth={depth}
                  className={
                    "group border-b border-slate-50 last:border-0 hover:bg-indigo-50/40 " +
                    (selected?.has(r.id)
                      ? "bg-indigo-50/50"
                      : depth
                        ? "bg-slate-50/30"
                        : "")
                  }
                >
                  <td className="px-6 py-4">
                    <div
                      className="flex items-start gap-1.5"
                      style={{ paddingLeft: Math.min(depth, 5) * 12 }}
                    >
                      {selectable && (
                        <input
                          type="checkbox"
                          aria-label={"选择：" + r.task}
                          checked={selected.has(r.id)}
                          onChange={(e) => onSelect([r.id], e.target.checked)}
                          className="row-select mt-1 h-3.5 w-3.5 shrink-0 accent-indigo-600"
                        />
                      )}
                      {children.length > 0 ? (
                        <button
                          aria-label={
                            (expanded.has(r.id) || forceExpand || capture
                              ? "收起子任务："
                              : "展开子任务：") + r.task
                          }
                          aria-expanded={
                            capture || forceExpand || expanded.has(r.id)
                          }
                          className="mt-0.5 shrink-0 rounded p-0.5 text-slate-400 hover:bg-indigo-100 hover:text-indigo-500"
                          onClick={() => toggle(r.id)}
                        >
                          {capture || forceExpand || expanded.has(r.id) ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : depth > 0 ? (
                        <GitBranch className="mt-1 h-3 w-3 shrink-0 text-slate-300" />
                      ) : null}
                      <div className="min-w-0">
                        <button
                          data-task-title
                          onClick={() => onOpen(r)}
                          className="whitespace-pre-wrap break-words text-left text-sm font-medium text-slate-800 hover:text-indigo-600 hover:underline"
                        >
                          {r.task}
                        </button>
                        {self && (
                          <span className="self-done ml-2 inline-block whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                            本人完成
                          </span>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <PriorityBadge value={r.priority} />
                          <DueBadge record={r} />
                          {allChildren.length > 0 && (
                            <button
                              onClick={() => onOpen(r)}
                              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-500"
                            >
                              <GitBranch className="h-2.5 w-2.5" />
                              {allChildren.filter(isCompleted).length}/
                              {allChildren.length} 子任务
                            </button>
                          )}
                          {r.comment_count > 0 && (
                            <button
                              aria-label={"查看评论：" + r.task}
                              onClick={() => onOpen(r)}
                              className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-indigo-500"
                            >
                              <MessageSquare className="h-3 w-3" />
                              {r.comment_count}
                            </button>
                          )}
                          {tree && !tree.matched.has(r.id) && (
                            <span className="text-[10px] text-slate-300">
                              上级任务
                            </span>
                          )}
                        </div>
                        <CoordinationSummary record={r} />
                      </div>
                    </div>
                  </td>
                  <td className="break-words px-4 py-4 text-sm text-slate-500">
                    <div className="flex flex-wrap gap-x-1.5 gap-y-1">
                      {splitNames(r.owner).map((name) => (
                        <span key={name} className="inline-block">
                          {name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap gap-1.5">
                      {names.length ? (
                        names.map((name) => (
                          <AvatarChip key={name} name={name} />
                        ))
                      ) : (
                        <span className="text-sm text-slate-300">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <DateBadge date={r.date} actual={r.actual} />
                  </td>
                  {!capture && (
                    <td className="row-action-cell text-center">
                      {r.editable ? (
                        <button
                          aria-label={"操作：" + r.task}
                          onClick={(e) => {
                            anchor.current = e.currentTarget;
                            setMenu(r);
                          }}
                          className="row-menu-button inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          aria-label={"查看任务：" + r.task}
                          onClick={() => onOpen(r)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-100 hover:text-slate-500"
                        >
                          <ArrowUpRight className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!records.length && (
        <div className="empty-state flex flex-col items-center px-6 py-14 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
            <CalendarX className="h-7 w-7 text-slate-300" />
          </div>
          <p className="mt-4 text-sm font-medium text-slate-500">
            没有符合条件的记录
          </p>
          <p className="mt-1 text-xs text-slate-400">
            换个筛选条件，或记录一条新的完成情况
          </p>
          {emptyAction && (
            <button onClick={emptyAction} className={primary + " mt-5"}>
              <Plus className="h-3.5 w-3.5" />
              记录第一份完成
            </button>
          )}
        </div>
      )}
      {menu && (
        <Popover anchor={anchor} width={180} onClose={() => setMenu(null)}>
          <div className="p-1.5">
            <button
              className="menu-item"
              onClick={() => {
                onOpen(menu);
                setMenu(null);
              }}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              详情与评论
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setExpanded((old) => new Set([...old, menu.id]));
                onAddChild(menu);
                setMenu(null);
              }}
            >
              <GitBranch className="h-3.5 w-3.5" />
              添加子任务
            </button>
            <button
              className="menu-item hover:bg-indigo-50 hover:text-indigo-600"
              onClick={() => {
                onEdit(menu);
                setMenu(null);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑记录
            </button>
            <button
              className="menu-item hover:bg-rose-50 hover:text-rose-600"
              onClick={() => {
                onDelete(menu);
                setMenu(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除记录
            </button>
          </div>
        </Popover>
      )}
      <div className="pagination-footer flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-slate-100 bg-slate-50/40 px-6 py-3.5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-slate-400">
            共{" "}
            <span className="font-semibold text-slate-600">
              {matchingTotal}
            </span>{" "}
            条工作记录
            {matchingTotal !== total ? " · " + total + " 条主任务" : ""}
          </span>
          {!capture && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              每页
              <select
                aria-label="每页显示条数"
                value={pageSize}
                onChange={(e) => onPageSize(Number(e.target.value))}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} 条
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!capture && (
          <div className="flex items-center gap-1.5" aria-label="记录分页">
            <button
              aria-label="上一页"
              disabled={pg.page <= 1}
              onClick={() => onPage(pg.page - 1)}
              className="page-button"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pg.numbers.map((n, i) => (
              <React.Fragment key={n}>
                {i > 0 && n > pg.numbers[i - 1] + 1 && (
                  <span className="text-xs text-slate-300">…</span>
                )}
                <button
                  aria-label={"第 " + n + " 页"}
                  aria-current={n === pg.page ? "page" : undefined}
                  onClick={() => onPage(n)}
                  className={
                    "page-button " +
                    (n === pg.page
                      ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30"
                      : "")
                  }
                >
                  {n}
                </button>
              </React.Fragment>
            ))}
            <button
              aria-label="下一页"
              disabled={pg.page >= pg.pages}
              onClick={() => onPage(pg.page + 1)}
              className="page-button"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
export function PersonSummary({ records, capture = false }) {
  const stats = personSummary(records),
    max = Math.max(1, ...stats.map((p) => p.done));
  if (!stats.length)
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 py-16 text-center text-sm text-slate-400">
        暂无可汇总的完成记录
      </div>
    );
  return (
    <div className="person-grid grid grid-cols-2 gap-4">
      {stats.map((p, i) => {
        const s = personStyle(p.name);
        return (
          <div
            key={p.name}
            style={{ animationDelay: i * 45 + "ms" }}
            className="animate-row rounded-2xl border border-slate-200/70 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(15,23,42,0.18)]"
          >
            <div className="flex items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                style={{
                  background: s.bg,
                  color: s.text,
                  boxShadow: "0 0 0 2px " + s.ring,
                }}
              >
                {p.name[0]}
              </span>
              <div className="min-w-0">
                <div className="break-words text-sm font-semibold text-slate-800">
                  {p.name}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  原定负责 {p.owned} 项
                </div>
              </div>
              <div className="ml-auto shrink-0 text-right">
                <div className="text-xl font-bold text-slate-900">{p.done}</div>
                <div className="text-[10px] text-slate-400">实际完成</div>
                {p.pending > 0 && (
                  <div className="mt-1 text-[10px] text-amber-600">
                    未完成 {p.pending} 项
                  </div>
                )}
                {p.unassigned > 0 && (
                  <div className="mt-1 text-[10px] text-slate-400">
                    完成人未填 {p.unassigned} 项
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full opacity-80 transition-all duration-700"
                style={{ width: (p.done / max) * 100 + "%", background: s.dot }}
              />
            </div>
            {p.records.length > 0 && (
              <details
                className="mt-4 border-t border-slate-100 pt-3"
                open={capture || undefined}
              >
                <summary className="cursor-pointer text-xs text-slate-400 hover:text-indigo-500">
                  查看工作事项（{p.records.length}）
                </summary>
                <div className="mt-2 space-y-3">
                  {p.records.map((r) => (
                    <div key={r.id} className="border-t border-slate-50 pt-3">
                      <p className="whitespace-pre-wrap break-words text-[13px] text-slate-700">
                        {r.task}
                      </p>
                      <div className="mt-1 flex flex-wrap justify-between gap-1 text-[11px] text-slate-400">
                        <span>原定 {r.owner}</span>
                        <time
                          className={
                            !isCompleted(r) ? "text-amber-600" : undefined
                          }
                        >
                          {completionDateLabel(r)}
                        </time>
                      </div>
                      {splitNames(r.actual).length > 1 && (
                        <p className="mt-1 text-[11px] text-slate-400">
                          共同完成：{r.actual}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
