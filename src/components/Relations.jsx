import React, { useState } from "react";
import {
  Link2,
  LockKeyhole,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  X,
  Search,
  UsersRound,
} from "lucide-react";
import { dependencyInfo, isCompleted, splitNames } from "../model.js";
import { AvatarChip } from "./UI.jsx";
export function CoordinationSummary({ record }) {
  const info = dependencyInfo(record);
  if (!info.blocked && !info.helpers.length) return null;
  const text = info.waiting
    .map((t) => t.task + "（负责：" + t.owner + "）")
    .join("、");
  return (
    <span className="mt-2 block space-y-1 text-[11px] leading-relaxed">
      {info.blocked && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-600">
            <LockKeyhole className="h-2.5 w-2.5" />
            阻塞中
          </span>
          {info.manual && (
            <span className="break-words text-rose-500">
              {record.blocker_note || "手动标记阻塞"}
            </span>
          )}
        </span>
      )}
      {info.blocked && info.waiting.length > 0 && (
        <span
          className="block break-words text-amber-600"
          title={"等待：" + text}
        >
          等待：
          {info.waiting
            .slice(0, 2)
            .map((t) => t.task + "（" + t.owner + "）")
            .join("、")}
          {info.waiting.length > 2
            ? " 等 " + info.waiting.length + " 项，点击详情查看"
            : ""}
        </span>
      )}
      {info.helpers.length > 0 && (
        <span className="block break-words text-slate-500">
          需要配合：{info.helpers.join("、")}
        </span>
      )}
    </span>
  );
}
export function DependencyPicker({
  selected,
  onChange,
  records,
  projects,
  currentId,
  known = [],
}) {
  const [search, setSearch] = useState(""),
    [projectId, setProjectId] = useState("");
  const source = new Map([...known, ...records].map((r) => [r.id, r]));
  const excluded = new Set(currentId ? [currentId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records)
      if (
        !excluded.has(r.id) &&
        (r.dependency_ids || []).some((id) => excluded.has(id))
      ) {
        excluded.add(r.id);
        changed = true;
      }
  }
  const q = search.trim().toLowerCase();
  const matches = records.filter(
    (r) =>
      !excluded.has(r.id) &&
      !selected.includes(r.id) &&
      (!projectId || r.project_id === projectId) &&
      (!q ||
        (
          r.task +
          " " +
          r.owner +
          " " +
          (projects.find((p) => p.id === r.project_id)?.name || "")
        )
          .toLowerCase()
          .includes(q)),
  );
  return (
    <fieldset className="space-y-3">
      <legend className="text-[13px] font-medium text-slate-600">
        等待哪些任务完成（可多选）
      </legend>
      {selected.length > 0 && (
        <ul className="space-y-2">
          {selected.map((id) => {
            const r = source.get(id);
            return (
              <li
                key={id}
                className="flex items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-2"
              >
                <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                <span className="min-w-0 flex-1 break-words text-xs text-slate-600">
                  {r?.task || "历史任务"}
                  <small className="mt-0.5 block text-[10px] text-slate-400">
                    {projects.find((p) => p.id === r?.project_id)?.name ||
                      r?.project_name ||
                      ""}{" "}
                    ·{" "}
                    {r?.deleted
                      ? "已删除，不再自动阻塞"
                      : isCompleted(r || {})
                        ? "已完成"
                        : "未完成"}
                    {r?.owner ? " · 负责：" + r.owner : ""}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={"移除依赖：" + (r?.task || id)}
                  onClick={() => onChange(selected.filter((x) => x !== id))}
                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-white hover:text-rose-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-40">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-300" />
          <input
            aria-label="搜索依赖任务"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索任务、负责人"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs text-slate-600 outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        <select
          aria-label="依赖项目筛选"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="max-w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs text-slate-500"
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div
        role="group"
        aria-label="可选依赖任务"
        className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-white"
      >
        {matches.slice(0, 20).map((r) => (
          <button
            key={r.id}
            type="button"
            aria-label={"添加依赖：" + r.task}
            disabled={selected.length >= 50}
            onClick={() => onChange([...selected, r.id])}
            className="flex w-full items-start gap-2 border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-indigo-50/60 disabled:opacity-40"
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-200 text-[11px] text-indigo-400">
              +
            </span>
            <span className="min-w-0 flex-1 break-words text-xs text-slate-600">
              {r.task}
              <small className="mt-0.5 block text-[10px] text-slate-400">
                {projects.find((p) => p.id === r.project_id)?.name} · {r.owner}{" "}
                · {isCompleted(r) ? "已完成" : "未完成"}
              </small>
            </span>
          </button>
        ))}
        {!matches.length && (
          <p className="px-3 py-4 text-xs text-slate-400">
            没有可选任务，换个关键词或项目试试。
          </p>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-slate-400">
        支持跨项目选择；前置任务完成后自动解除对应等待。
        {matches.length > 20
          ? "匹配 " + matches.length + " 项，显示前 20 项，请搜索缩小范围。"
          : ""}
      </p>
    </fieldset>
  );
}
export function DependencyDetail({ record, records, onOpen, onEdit, user }) {
  const info = dependencyInfo(record),
    dependencies = record.dependency_tasks || [],
    dependents = records.filter((r) =>
      (r.dependency_ids || []).includes(record.id),
    );
  const open = (r) => {
    const target = records.find((t) => t.id === r.id);
    if (target) onOpen(target);
  };
  return (
    <section
      aria-label="依赖与配合"
      className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Link2 className="h-4 w-4 text-indigo-400" />
          依赖与配合
        </h4>
        <div className="flex items-center gap-2">
          {!isCompleted(record) && (
            <span
              className={
                "rounded-full px-2 py-1 text-[10px] " +
                (info.blocked
                  ? "bg-rose-50 text-rose-600"
                  : "bg-emerald-50 text-emerald-600")
              }
            >
              {isCompleted(record)
                ? "已完成"
                : info.blocked
                  ? "阻塞中"
                  : dependencies.length
                    ? "依赖已满足"
                    : "未标记阻塞"}
            </span>
          )}
          {user && (
            <button
              onClick={() => onEdit(record)}
              className="rounded-lg px-2 py-1 text-xs text-indigo-500 hover:bg-indigo-50"
            >
              设置依赖与阻塞
            </button>
          )}
        </div>
      </div>
      <div className="space-y-4 p-4">
        {info.manual && (
          <div className="rounded-xl bg-rose-50/70 px-3 py-2 text-xs leading-relaxed text-rose-600">
            <strong className="font-medium">
              {isCompleted(record) ? "手动阻塞记录" : "手动阻塞"}
            </strong>
            <p className="mt-1 whitespace-pre-wrap break-words">
              {record.blocker_note || "暂未填写阻塞说明"}
            </p>
          </div>
        )}
        <div>
          <h5 className="mb-2 text-xs text-slate-400">
            等待哪些任务完成{" "}
            <span className="ml-1">{info.waiting.length} 项未完成</span>
          </h5>
          {dependencies.length ? (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
              {dependencies.map((r) => (
                <li key={r.id}>
                  <button
                    disabled={Boolean(r.deleted)}
                    onClick={() => open(r)}
                    aria-label={"查看前置任务：" + r.task}
                    className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-slate-50 disabled:cursor-default disabled:opacity-60"
                  >
                    {r.deleted ? (
                      <X className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                    ) : isCompleted(r) ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm text-slate-700">
                        {r.task}
                      </span>
                      <small className="mt-1 block text-[11px] text-slate-400">
                        {r.project_name} · 负责：{r.owner} ·{" "}
                        {r.deleted
                          ? "已删除，不再自动阻塞"
                          : isCompleted(r)
                            ? "已完成"
                            : "等待完成"}
                      </small>
                    </span>
                    {!r.deleted && (
                      <ArrowUpRight className="mt-1 h-3 w-3 shrink-0 text-slate-300" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-400">未设置前置任务。</p>
          )}
        </div>
        <div>
          <h5 className="mb-2 flex items-center gap-1 text-xs text-slate-400">
            <UsersRound className="h-3 w-3" />
            需要配合的人
          </h5>
          <div className="flex flex-wrap gap-1.5">
            {info.helpers.length ? (
              info.helpers.map((n) => <AvatarChip key={n} name={n} />)
            ) : (
              <span className="text-xs text-slate-400">未指定配合人员。</span>
            )}
          </div>
        </div>
        {dependents.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <h5 className="mb-2 text-xs text-slate-400">哪些任务依赖本任务</h5>
            <ul className="space-y-1">
              {dependents.map((r) => (
                <li key={r.id}>
                  <button
                    aria-label={"查看后续任务：" + r.task}
                    onClick={() => onOpen(r)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs text-indigo-500 hover:bg-indigo-50"
                  >
                    <span className="break-words">
                      {r.task} · {r.owner}
                    </span>
                    <ArrowUpRight className="h-3 w-3 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
