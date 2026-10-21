import React, { useMemo, useState } from "react";
import {
  UsersRound,
  Search,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  CheckCircle2,
  Clock3,
  ArrowUpRight,
} from "lucide-react";
import {
  peopleOverview,
  filterRecords,
  statistics,
  personStyle,
  splitNames,
  colorOf,
  isCompleted,
  recordMonth,
} from "../model.js";
import { DateBadge, inputClass, secondary } from "./UI.jsx";
export default function PeopleOverview({ projects, records, onOpen }) {
  const [month, setMonth] = useState(""),
    [projectId, setProjectId] = useState(""),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(""),
    [scope, setScope] = useState("all");
  const filtered = useMemo(
    () =>
      filterRecords(records, { projectId }).filter(
        (r) => !month || recordMonth(r, true) === month,
      ),
    [records, projectId, month],
  );
  const people = useMemo(
    () =>
      peopleOverview(projects, filtered).filter((p) =>
        p.name.includes(search.trim()),
      ),
    [projects, filtered, search],
  );
  const person = people.find((p) => p.name === selected),
    stats = statistics(filtered);
  const related =
    person?.related.filter(
      (r) =>
        scope === "all" ||
        (scope === "pending"
          ? !isCompleted(r)
          : splitNames(r.actual).includes(person.name)),
    ) || [];
  return (
    <>
      <header className="topbar sticky top-0 z-10 flex items-center justify-between border-b border-slate-200/60 bg-[#F6F7F9]/90 px-8 py-4 backdrop-blur-md">
        <span className="flex items-center gap-2 text-[13px] text-slate-500">
          <UsersRound className="h-4 w-4 text-indigo-400" />
          跨项目人员总览
        </span>
        <span className="text-xs text-slate-400">公开可见</span>
      </header>
      <div className="workbench-content mx-auto w-full max-w-6xl px-8 pb-12">
        <div className="pt-8">
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            每个人的工作，一处看清
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            汇总所有项目的负责事项、实际贡献和未完成工作。
          </p>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            [UsersRound, "参与成员", people.length + " 人"],
            [
              FolderOpen,
              "涉及项目",
              new Set(filtered.map((r) => r.project_id)).size + " 个",
            ],
            [CheckCircle2, "完成工作", stats.total + " 项"],
            [Clock3, "未完成", stats.pending + " 项"],
          ].map(([Icon, label, value]) => (
            <div
              key={label}
              className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm"
            >
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <div className="mt-3 text-2xl font-bold text-slate-800">
                {value}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <div className="relative min-w-0 flex-1 basis-52">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-300" />
            <input
              aria-label="搜索成员"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索成员姓名"
              className={inputClass + " bg-white pl-9"}
            />
          </div>
          <select
            aria-label="总览项目筛选"
            style={{ width: "auto", minWidth: 150 }}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={inputClass + " w-auto max-w-full bg-white"}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="month"
            aria-label="总览统计月份"
            style={{ width: 180, maxWidth: "100%" }}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={inputClass + " w-auto bg-white"}
          />
          {(month || projectId || search) && (
            <button
              className={secondary}
              onClick={() => {
                setMonth("");
                setProjectId("");
                setSearch("");
              }}
            >
              重置
            </button>
          )}
        </div>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200/70 bg-white shadow-sm">
          <table className="w-full min-w-[680px] text-left">
            <thead className="border-b border-slate-100 bg-slate-50/60 text-xs font-medium text-slate-400">
              <tr>
                {[
                  "成员",
                  "参与项目",
                  "原定负责",
                  "实际完成",
                  "共同完成",
                  "未完成",
                  "明细",
                ].map((label) => (
                  <th key={label} className="px-4 py-3.5">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {people.map((p) => {
                const s = personStyle(p.name);
                return (
                  <tr
                    key={p.name}
                    className={
                      selected === p.name
                        ? "bg-indigo-50/50"
                        : "hover:bg-slate-50/70"
                    }
                  >
                    <td className="px-4 py-4">
                      <button
                        className="flex items-center gap-2 text-sm font-semibold text-slate-700"
                        onClick={() => {
                          setSelected(p.name);
                          setScope("all");
                        }}
                      >
                        <span
                          className="flex h-8 w-8 items-center justify-center rounded-full text-xs"
                          style={{ background: s.bg, color: s.text }}
                        >
                          {p.name[0]}
                        </span>
                        {p.name}
                      </button>
                    </td>
                    <td className="max-w-[220px] px-4 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        {p.projects.map((project) => (
                          <span
                            key={project.id}
                            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500"
                          >
                            <i
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: colorOf(project.color).to }}
                            />
                            {project.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm text-slate-500">
                      {p.owned}
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-indigo-600">
                      {p.done}
                    </td>
                    <td className="px-4 py-4 text-sm text-slate-500">
                      {p.joint}
                    </td>
                    <td className="px-4 py-4 text-sm text-amber-600">
                      {p.pending}
                    </td>
                    <td className="px-4 py-4">
                      <button
                        aria-label={"查看 " + p.name + " 的跨项目工作"}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-500"
                        onClick={() => {
                          setSelected(selected === p.name ? "" : p.name);
                          setScope("all");
                        }}
                      >
                        {selected === p.name ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!people.length && (
            <p className="px-6 py-14 text-center text-sm text-slate-400">
              当前范围还没有人员工作记录
            </p>
          )}
        </div>
        {person && (
          <section
            aria-label={person.name + "的跨项目工作"}
            className="mt-6 rounded-2xl border border-slate-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-slate-800">
                {person.name}的工作
              </h2>
              <div className="flex rounded-xl bg-slate-100 p-1">
                {[
                  ["all", "全部"],
                  ["done", "实际完成"],
                  ["pending", "未完成"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={scope === key}
                    className={
                      "rounded-lg px-3 py-1.5 text-xs " +
                      (scope === key
                        ? "bg-white text-slate-700 shadow-sm"
                        : "text-slate-400")
                    }
                    onClick={() => setScope(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 divide-y divide-slate-100">
              {related.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onOpen(r)}
                  className="flex w-full items-start gap-3 py-3 text-left hover:bg-slate-50"
                >
                  <span className="mt-0.5 max-w-[130px] shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500">
                    {projects.find((p) => p.id === r.project_id)?.name}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm text-slate-700">
                      {r.task}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      负责：{r.owner} · 完成：{r.actual || "待填写"}
                    </span>
                  </span>
                  <span className="shrink-0">
                    <DateBadge date={r.date} actual={r.actual} />
                  </span>
                  <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300" />
                </button>
              ))}
              {!related.length && (
                <p className="py-6 text-xs text-slate-400">
                  该范围没有工作事项
                </p>
              )}
            </div>
          </section>
        )}
        <p className="mt-5 text-center text-xs leading-relaxed text-slate-400">
          有子任务时按子任务统计，父任务不重复计数。共同完成在每位完成人名下各计
          1 项。
        </p>
        <p className="mt-2 text-center text-[11px] text-slate-400">
          已完成但未填日期的工作，按系统记录的完成月份统计；未完成按登记月份查看，未填完成人不归入个人实际完成数量。
        </p>
      </div>
    </>
  );
}
