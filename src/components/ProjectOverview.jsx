import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Flag,
  FolderKanban,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { api } from "../api.js";
import { colorOf } from "../model.js";
import {
  Field,
  FormActions,
  FormError,
  Modal,
  inputClass,
  primary,
  secondary,
} from "./UI.jsx";

const card = "rounded-2xl border border-slate-200/70 bg-white shadow-sm";
const small =
  "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 hover:text-indigo-600";
const stages = [
  "立项",
  "方案",
  "实施",
  "联调",
  "试运行",
  "验收",
  "交付",
  "运维",
  "暂停",
];

export default function ProjectOverview(props) {
  return <OverviewSession key={props.user?.id || "guest"} {...props} />;
}
function OverviewSession({
  user,
  onLogin,
  onOpenProject,
  onOpenTask,
  onOpenMilestone,
  onOpenChanges,
}) {
  const [data, setData] = useState({ projects: [], today: "" }),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [search, setSearch] = useState(""),
    [owner, setOwner] = useState(""),
    [stage, setStage] = useState(""),
    [scope, setScope] = useState("active"),
    [editing, setEditing] = useState(null);
  const sequence = useRef(0),
    live = useRef(true);
  async function load() {
    const id = ++sequence.current;
    setBusy(true);
    try {
      const next = await api("/project-overview");
      if (live.current && id === sequence.current) {
        setData(next);
        setLoaded(true);
        setError(null);
      }
    } catch (e) {
      if (live.current && id === sequence.current) setError(e);
    } finally {
      if (live.current && id === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    load();
    const visible = () => {
      if (!document.hidden) load();
    };
    const timer = setInterval(visible, 30000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      live.current = false;
      sequence.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const owners = [
    ...new Set(
      [...data.projects.map((p) => p.management.owner), owner].filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh"));
  const availableStages = [
    ...new Set(
      [...data.projects.map((p) => p.management.stage), stage].filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh"));
  const projects = useMemo(
    () =>
      data.projects.filter(
        (p) =>
          (scope === "all" || Boolean(p.archived) === (scope === "archived")) &&
          (!owner || p.management.owner === owner) &&
          (!stage || p.management.stage === stage) &&
          (!search.trim() ||
            [p.name, p.management.owner, p.management.stage]
              .join(" ")
              .toLowerCase()
              .includes(search.trim().toLowerCase())),
      ),
    [data.projects, scope, owner, stage, search],
  );
  const canViewInternal = Boolean(user && data.can_view_internal);
  useEffect(() => {
    if (loaded && !data.can_view_internal) setEditing(null);
  }, [loaded, data.can_view_internal]);
  const totals = projects.reduce(
    (a, p) => ({
      pending: a.pending + p.task_summary.pending,
      overdue: a.overdue + p.task_summary.overdue,
      blocked: a.blocked + p.task_summary.blocked,
    }),
    { pending: 0, overdue: 0, blocked: 0 },
  );
  return (
    <>
      <header className="topbar sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200/60 bg-[#F6F7F9]/90 px-8 py-4 backdrop-blur-md">
        <span className="flex items-center gap-2 text-[13px] text-slate-500">
          <FolderKanban className="h-4 w-4 text-indigo-400" />
          跨项目总览
        </span>
        <button className={small} disabled={busy} onClick={load}>
          <RefreshCw
            className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")}
          />
          刷新
        </button>
      </header>
      <div className="workbench-content mx-auto w-full max-w-6xl px-8 pb-12">
        <div className="pt-8">
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            项目进展，一处看清
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            查看项目负责人、阶段、关键节点和需要推进的事项。
          </p>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            [FolderKanban, "当前项目", projects.length + " 个"],
            [CheckCircle2, "未完成工作", totals.pending + " 项"],
            [CalendarDays, "已逾期任务", totals.overdue + " 项"],
            [CircleAlert, "阻塞任务", totals.blocked + " 项"],
          ].map(([Icon, label, value]) => (
            <div key={label} className={card + " p-5"}>
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <div className="mt-3 text-2xl font-bold text-slate-800">
                {value}
              </div>
              <p className="mt-1 text-[10px] text-slate-400">按当前筛选范围</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <div className="relative min-w-0 flex-1 basis-52">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-300" />
            <input
              aria-label="搜索项目总览"
              className={inputClass + " bg-white pl-9"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索项目、负责人或阶段"
            />
          </div>
          <select
            aria-label="项目负责人筛选"
            className={inputClass + " w-auto max-w-full bg-white"}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">全部负责人</option>
            {owners.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <select
            aria-label="项目阶段筛选"
            className={inputClass + " w-auto max-w-full bg-white"}
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="">全部阶段</option>
            {availableStages.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <select
            aria-label="项目归档筛选"
            className={inputClass + " w-auto max-w-full bg-white"}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="active">进行中项目</option>
            <option value="all">全部项目</option>
            <option value="archived">已归档项目</option>
          </select>
        </div>
        {error && (
          <div
            className="mt-4 rounded-xl border border-rose-100 bg-rose-50/50 px-4 py-3 text-xs text-rose-600"
            role="alert"
          >
            {loaded ? "更新失败，当前显示上次同步结果。" : ""}
            {error.message}
            <button className="ml-2 underline" onClick={load}>
              重试
            </button>
          </div>
        )}
        {loaded && !canViewInternal && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-100/70 px-4 py-3 text-xs text-slate-500">
            <span className="inline-flex items-center gap-2">
              <LockKeyhole className="h-3.5 w-3.5" />
              公开查看项目进展；登录后可查看交接缺项和需求变更。
            </span>
            <button className="text-indigo-600" onClick={onLogin}>
              登录 / 注册
            </button>
          </div>
        )}
        <div className="mt-5 grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
          {projects.map((p) => {
            const profile = p.management,
              ms = p.milestones;
            return (
              <article
                key={p.id}
                aria-label={"项目总览：" + p.name}
                className={card + " min-w-0 overflow-hidden"}
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                  <div className="min-w-0">
                    <button
                      onClick={() => onOpenProject?.(p, "records")}
                      className="flex max-w-full items-center gap-2 text-left text-base font-semibold text-slate-800"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: colorOf(p.color).to }}
                      />
                      <span className="min-w-0 break-words">{p.name}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                    </button>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5">
                        {profile.stage || "阶段未设置"}
                      </span>
                      {p.archived && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5">
                          已归档
                        </span>
                      )}
                    </div>
                  </div>
                  {canViewInternal && (
                    <button
                      aria-label={"编辑 " + p.name + " 的管理资料"}
                      className={small + " shrink-0"}
                      onClick={() =>
                        setEditing({ project: p, management: { ...profile } })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                    </button>
                  )}
                </div>
                <div className="space-y-4 px-5 py-4">
                  <div className="grid grid-cols-1 gap-2 text-xs text-slate-500 sm:grid-cols-2">
                    <p className="flex min-w-0 items-start gap-2">
                      <UsersRound className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                      <span className="break-words">
                        负责人：{profile.owner || "未设置"}
                      </span>
                    </p>
                    <p className="flex min-w-0 items-start gap-2">
                      <CalendarDays className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                      <span>
                        目标交付：{profile.target_date || "未设置"}
                        {!p.archived &&
                          profile.target_date &&
                          profile.target_date < data.today && (
                            <span className="ml-1 text-amber-600">
                              日期已过
                            </span>
                          )}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => onOpenMilestone?.(p, ms.next?.id || null)}
                    className="w-full rounded-xl bg-indigo-50/60 p-3 text-left"
                  >
                    <span className="flex items-center justify-between gap-3 text-xs text-indigo-600">
                      <span className="inline-flex items-center gap-1.5">
                        <Flag className="h-3.5 w-3.5" />
                        里程碑达成
                      </span>
                      <span className="shrink-0 font-semibold">
                        {ms.achieved} / {ms.total}
                      </span>
                    </span>
                    <span className="mt-2 block break-words text-xs leading-6 text-slate-600">
                      {ms.next
                        ? "下一节点：" + ms.next.title
                        : "暂无待推进节点"}
                      {ms.next?.planned_date && (
                        <span className="ml-2 text-slate-400">
                          {ms.next.planned_date}
                        </span>
                      )}
                    </span>
                    {ms.overdue > 0 && (
                      <span className="mt-1 block text-[11px] text-amber-600">
                        {ms.overdue} 个节点已过计划日
                      </span>
                    )}
                  </button>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-500">
                    <span>
                      未完成{" "}
                      <b className="text-slate-700">{p.task_summary.pending}</b>
                    </span>
                    <span>
                      逾期{" "}
                      <b className="text-amber-600">{p.task_summary.overdue}</b>
                    </span>
                    <span>
                      阻塞{" "}
                      <b className="text-rose-500">{p.task_summary.blocked}</b>
                    </span>
                  </div>
                  {!!p.task_summary.important.length && (
                    <div className="divide-y divide-slate-100 border-t border-slate-100">
                      {p.task_summary.important.map((task) => (
                        <button
                          key={task.id}
                          onClick={() => onOpenTask?.(task)}
                          className="flex w-full items-start justify-between gap-3 py-2.5 text-left text-xs text-slate-600 hover:text-indigo-600"
                        >
                          <span className="min-w-0 break-words">
                            {task.task}
                            <span className="mt-1 block text-[10px] text-slate-400">
                              {task.owner}
                              {task.due_date ? " · " + task.due_date : ""}
                              {task.blocked ? " · 阻塞中" : ""}
                            </span>
                          </span>
                          <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-300" />
                        </button>
                      ))}
                    </div>
                  )}
                  {canViewInternal && (
                    <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                      <button
                        className={small}
                        onClick={() => onOpenProject?.(p, "documents")}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        交接缺 {p.handover_missing} 项
                      </button>
                      <button
                        className={small}
                        onClick={() => onOpenChanges?.(p)}
                      >
                        需求变更 {p.changes.total} 项
                        {p.changes.pending
                          ? " · 待确认 " + p.changes.pending
                          : ""}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {!loaded && !error && (
          <p className="py-16 text-center text-sm text-slate-400">
            正在汇总项目…
          </p>
        )}
        {loaded && !projects.length && (
          <div
            className={
              card + " mt-5 px-6 py-14 text-center text-sm text-slate-400"
            }
          >
            当前筛选下没有项目
            <button
              className="ml-2 text-indigo-500"
              onClick={() => {
                setSearch("");
                setOwner("");
                setStage("");
                setScope("all");
              }}
            >
              查看全部
            </button>
          </div>
        )}
        <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
          进展按里程碑查看；任务数量只作工作记录参考。有子任务时只统计叶子任务，完成人或完成日期任填一项即完成。
        </p>
      </div>
      {editing && canViewInternal && (
        <ManagementDialog
          project={editing.project}
          management={editing.management}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </>
  );
}
function ManagementDialog({ project, management, onClose, onSaved }) {
  const [draft, setDraft] = useState({ ...management }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  function close(e) {
    if (busy) {
      e?.preventDefault?.();
      return;
    }
    onClose();
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/projects/" + project.id + "/management", "PATCH", {
        owner: draft.owner,
        stage: draft.stage,
        target_date: draft.target_date,
        version: draft.version,
      });
      if (active.current) await onSaved();
    } catch (e) {
      if (active.current) setError(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="项目管理资料"
      sub={project.name + " · 负责人、阶段和目标日期公开可见"}
      icon={FolderKanban}
      onClose={close}
    >
      <form onSubmit={save}>
        <fieldset disabled={busy} className="space-y-5 px-6 pb-2">
          <p className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
            这些资料公开可见，勿填写账号密码或内部部署地址。阶段和日期独立登记，不改变任务完成状态。
          </p>
          <Field label="项目负责人（选填）">
            <input
              className={inputClass}
              value={draft.owner}
              onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
              maxLength={100}
            />
          </Field>
          <Field label="当前阶段（选填）" hint="可选择常用阶段，也可直接填写。">
            <input
              className={inputClass}
              value={draft.stage}
              onChange={(e) => setDraft({ ...draft, stage: e.target.value })}
              maxLength={40}
              list="project-management-stages"
            />
          </Field>
          <datalist id="project-management-stages">
            {stages.map((n) => (
              <option value={n} key={n} />
            ))}
          </datalist>
          <Field label="目标交付日期（选填）">
            <input
              type="date"
              className={inputClass}
              value={draft.target_date}
              onChange={(e) =>
                setDraft({ ...draft, target_date: e.target.value })
              }
            />
          </Field>
        </fieldset>
        <FormError error={error} />
        {error?.status === 409 && (
          <div className="px-6 pb-2">
            <button
              type="button"
              className={secondary}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await api(
                    "/projects/" + project.id + "/management",
                  );
                  if (active.current) {
                    setDraft(next.management);
                    setError(null);
                  }
                } catch (e) {
                  if (active.current) setError(e);
                } finally {
                  if (active.current) setBusy(false);
                }
              }}
            >
              载入最新资料（将替换当前草稿）
            </button>
          </div>
        )}
        <FormActions busy={busy} onClose={close} label="保存项目资料" />
      </form>
    </Modal>
  );
}
