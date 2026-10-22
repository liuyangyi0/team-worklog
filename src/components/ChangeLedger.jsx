import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  GitPullRequestArrow,
  History,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "../api.js";
import { beijingDate } from "../model.js";
import { displayTime } from "../library-api.js";
import { InternalLogin } from "./ProjectLibrary.jsx";
import {
  Field,
  FormActions,
  FormError,
  Modal,
  inputClass,
  primary,
  secondary,
} from "./UI.jsx";

const confirmations = {
  pending: "待确认",
  confirmed: "已确认",
  rejected: "不采纳",
  cancelled: "已取消",
};
const progresses = {
  not_started: "未开始",
  in_progress: "执行中",
  implemented: "已实施",
};
const actions = {
  create: "创建",
  update: "修改",
  delete: "移入回收站",
  restore: "恢复",
};
const box =
  "rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const tiny =
  "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-50 hover:text-indigo-600 disabled:opacity-40";
const impactLabel = (n) =>
  n === null || n === undefined
    ? "未估算"
    : n === 0
      ? "预计不影响交期"
      : n > 0
        ? `预计增加 ${n} 天`
        : `预计缩短 ${Math.abs(n)} 天`;

function Badges({ row }) {
  const c = row.confirmation_status;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <span
        className={
          "rounded-full px-2 py-0.5 text-[11px] " +
          (c === "confirmed"
            ? "bg-emerald-50 text-emerald-600"
            : c === "pending"
              ? "bg-amber-50 text-amber-600"
              : "bg-slate-100 text-slate-500")
        }
      >
        {confirmations[c]}
      </span>
      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-500">
        {progresses[row.progress_status]}
      </span>
    </span>
  );
}

export default function ChangeLedger(props) {
  if (!props.project) return null;
  if (!props.user)
    return (
      <div className="pt-8">
        <InternalLogin label="需求变更台账" onLogin={props.onLogin} />
      </div>
    );
  return (
    <ChangeSession key={props.project.id + ":" + props.user.id} {...props} />
  );
}

function ChangeSession({
  project,
  records = [],
  onOpenTask,
  onChanged,
  onLogin,
  initialChangeId,
}) {
  const [rows, setRows] = useState([]),
    [milestones, setMilestones] = useState([]),
    [summary, setSummary] = useState({}),
    [trash, setTrash] = useState(false),
    [query, setQuery] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [progress, setProgress] = useState(""),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [working, setWorking] = useState(false),
    [editor, setEditor] = useState(null),
    [detailId, setDetailId] = useState(""),
    [error, setError] = useState(null),
    [notice, setNotice] = useState(""),
    [expired, setExpired] = useState(false);
  const live = useRef(true),
    request = useRef(0),
    initialOpened = useRef("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current++;
    };
  }, []);
  const expire = useCallback(() => {
    request.current++;
    setRows([]);
    setMilestones([]);
    setSummary({});
    setEditor(null);
    setDetailId("");
    setNotice("");
    setError(null);
    setLoading(false);
    setExpired(true);
  }, []);
  const load = useCallback(async () => {
    const serial = ++request.current;
    setLoading(true);
    try {
      const result = await api(
        `/projects/${project.id}/changes${trash ? "?deleted=1" : ""}`,
      );
      if (!live.current || serial !== request.current) return;
      setRows(result.changes);
      setMilestones(result.milestones || []);
      setSummary(result.summary || {});
      setError(null);
      setLoaded(true);
      setExpired(false);
    } catch (e) {
      if (live.current && serial === request.current) {
        if (e.status === 401) expire();
        else setError(e);
        setLoaded(true);
      }
    } finally {
      if (live.current && serial === request.current) setLoading(false);
    }
  }, [project.id, trash, expire]);
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) load();
    };
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  useEffect(() => {
    if (initialChangeId && initialOpened.current !== initialChangeId) {
      initialOpened.current = initialChangeId;
      setDetailId(initialChangeId);
    }
  }, [initialChangeId]);
  const filtered = rows.filter(
    (row) =>
      (!confirmation || row.confirmation_status === confirmation) &&
      (!progress || row.progress_status === progress) &&
      (!query.trim() ||
        [
          row.title,
          row.original_scope,
          row.requested_scope,
          row.requester,
          row.owner,
          row.schedule_impact,
          row.milestone?.title,
          ...row.tasks.map((t) => t.title),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  async function mutate(row, restore) {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await api(
        `/changes/${row.id}${restore ? "/restore" : ""}`,
        restore ? "POST" : "DELETE",
        { version: row.version },
      );
      if (!live.current) return;
      setNotice(
        restore ? "变更已恢复，历史记录保留" : "已移入回收站，历史记录保留",
      );
      await load();
      await onChanged?.();
    } catch (e) {
      if (live.current) {
        if (e.status === 401) expire();
        else setError(e);
      }
    } finally {
      if (live.current) setWorking(false);
    }
  }
  async function saved() {
    if (!live.current) return;
    setEditor(null);
    setDetailId("");
    setNotice("变更已保存；关联任务和里程碑保持原有状态");
    await load();
    try {
      await onChanged?.();
    } catch {
      if (live.current)
        setError(new Error("变更已保存，项目总览同步失败，请刷新核对"));
    }
  }
  if (expired)
    return (
      <div className="pt-8">
        <InternalLogin label="需求变更台账" onLogin={onLogin} />
      </div>
    );
  return (
    <section className="pt-8" aria-label="需求变更台账">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            需求变更台账
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            把原约定、本次调整和交期影响记清楚，所有注册成员共同维护。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className={secondary}
            disabled={loading || working}
            aria-label="刷新变更台账"
            onClick={load}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            className={primary}
            disabled={working}
            onClick={() => setEditor({ row: null })}
          >
            <Plus className="h-4 w-4" />
            记录变更
          </button>
        </div>
      </div>
      <p className="mt-4 rounded-xl bg-slate-100/70 px-4 py-3 text-xs leading-relaxed text-slate-500">
        本台账及历史仅登录后可见。确认状态是事实登记，不设审批；登记变更不会自动调整任务日期、任务完成情况或里程碑。
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["变更记录", summary.total || 0],
          ["待确认", summary.pending || 0],
          ["已确认", summary.confirmed || 0],
          ["已实施", summary.implemented || 0],
        ].map(([label, n]) => (
          <div key={label} className={box + " px-4 py-4"}>
            <div className="text-xs text-slate-400">{label}</div>
            <div className="mt-2 text-2xl font-semibold text-slate-800">
              {n}
              <span className="ml-1 text-xs font-normal text-slate-400">
                项
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input
            aria-label="搜索需求变更"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索变更、提出人、跟进人"
            className={inputClass + " bg-white pl-9"}
          />
        </div>
        <select
          aria-label="变更确认状态筛选"
          className={inputClass + " w-auto bg-white"}
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        >
          <option value="">全部确认状态</option>
          {Object.entries(confirmations).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label="变更执行状态筛选"
          className={inputClass + " w-auto bg-white"}
          value={progress}
          onChange={(e) => setProgress(e.target.value)}
        >
          <option value="">全部执行状态</option>
          {Object.entries(progresses).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          disabled={working}
          className={secondary + " ml-auto"}
          aria-pressed={trash}
          onClick={() => {
            setRows([]);
            setLoaded(false);
            setDetailId("");
            setTrash((v) => !v);
          }}
        >
          <Trash2 className="h-4 w-4" />
          {trash ? "返回变更列表" : "变更回收站"}
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-3 text-xs text-emerald-600">
          {notice}
        </p>
      )}
      {error && (
        <div className="mt-3">
          <FormError error={error} onReload={load} />
        </div>
      )}
      <div className="mt-5 space-y-3">
        {!loaded ? (
          <div className={box + " py-14 text-center text-sm text-slate-400"}>
            正在加载…
          </div>
        ) : !filtered.length ? (
          <div className={box + " px-6 py-14 text-center"}>
            <GitPullRequestArrow className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm text-slate-500">
              {trash
                ? "回收站暂无变更"
                : rows.length
                  ? "没有符合条件的变更"
                  : "还没有需求变更记录"}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              新增需求、范围调整、交付日期变化，都可以在这里留一份明确记录。
            </p>
          </div>
        ) : (
          filtered.map((row) => (
            <article
              key={row.id}
              data-change-id={row.id}
              className={box + " p-5"}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <button
                    className="break-words text-left text-base font-semibold text-slate-700 hover:text-indigo-600"
                    onClick={() => setDetailId(row.id)}
                  >
                    {row.title}
                  </button>
                  <div className="mt-2">
                    <Badges row={row} />
                  </div>
                </div>
                <span className="shrink-0 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
                  {impactLabel(row.impact_days)}
                </span>
              </div>
              <p className="mt-3 line-clamp-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-500">
                {row.requested_scope}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
                <span>
                  提出：{row.requester || "未填写"}
                  {row.requested_on ? " · " + row.requested_on : ""}
                </span>
                <span>跟进：{row.owner || "未填写"}</span>
                {row.milestone && (
                  <span>
                    节点：{row.milestone.title}
                    {row.milestone.deleted ? "（已移除）" : ""}
                  </span>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <span className="text-[11px] text-slate-400">
                  {displayTime(row.updated)} · 第 {row.version} 版
                </span>
                <div className="flex gap-1">
                  <button className={tiny} onClick={() => setDetailId(row.id)}>
                    <History className="h-3.5 w-3.5" />
                    详情与历史
                  </button>
                  {trash ? (
                    <button
                      className={tiny}
                      disabled={working}
                      onClick={() => mutate(row, true)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      恢复
                    </button>
                  ) : (
                    <>
                      <button
                        className={tiny}
                        aria-label={"编辑变更：" + row.title}
                        onClick={() => setEditor({ row })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </button>
                      <button
                        className={tiny + " hover:text-rose-500"}
                        disabled={working}
                        aria-label={"删除变更：" + row.title}
                        onClick={() => {
                          if (
                            window.confirm(
                              "将这条变更移入回收站？完整历史会保留。",
                            )
                          )
                            mutate(row, false);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))
        )}
      </div>
      {editor && (
        <ChangeEditor
          key={(editor.row?.id || "new") + ":" + (editor.row?.version || 0)}
          initial={editor.row}
          projectId={project.id}
          records={records}
          milestones={milestones}
          onClose={() => setEditor(null)}
          onSaved={saved}
          onExpired={expire}
        />
      )}
      {detailId && (
        <ChangeDetail
          key={detailId}
          id={detailId}
          projectId={project.id}
          onExpired={expire}
          onClose={() => setDetailId("")}
          onEdit={(row) => {
            setDetailId("");
            setEditor({ row });
          }}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  );
}

function draftOf(row) {
  return {
    title: row?.title || "",
    original_scope: row?.original_scope || "",
    requested_scope: row?.requested_scope || "",
    requester: row?.requester || "",
    requested_on: row?.requested_on ?? beijingDate(),
    confirmation_status: row?.confirmation_status || "pending",
    confirmed_by: row?.confirmed_by || "",
    confirmed_on: row?.confirmed_on || "",
    schedule_impact: row?.schedule_impact || "",
    impact_days: row?.impact_days ?? "",
    owner: row?.owner || "",
    task_ids: row?.task_ids || [],
    milestone_id: row?.milestone_id || "",
    progress_status: row?.progress_status || "not_started",
    version: row?.version,
  };
}
function ChangeEditor({
  initial,
  projectId,
  records,
  milestones,
  onClose,
  onSaved,
  onExpired,
}) {
  const [draft, setDraft] = useState(() => draftOf(initial)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [taskSearch, setTaskSearch] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const close = (e) => {
    if (busy) e?.preventDefault?.();
    else onClose();
  };
  const set = (key) => (e) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  const known = records.filter((r) => r.project_id === projectId && !r.deleted);
  const missing = draft.task_ids.filter(
    (id) => !known.some((r) => r.id === id),
  );
  const choices = known.filter(
    (r) =>
      !taskSearch.trim() ||
      [r.task, r.owner, r.actual]
        .join(" ")
        .toLocaleLowerCase()
        .includes(taskSearch.trim().toLocaleLowerCase()),
  );
  async function reload() {
    setBusy(true);
    setError(null);
    try {
      const result = await api("/changes/" + initial.id);
      if (result.change.project_id !== projectId)
        throw new Error("这条变更不属于当前项目，请切换至对应项目查看");
      if (live.current) setDraft(draftOf(result.change));
    } catch (e) {
      if (live.current) {
        if (e.status === 401) onExpired();
        else setError(e);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        initial ? "/changes/" + initial.id : `/projects/${projectId}/changes`,
        initial ? "PATCH" : "POST",
        {
          ...draft,
          milestone_id: draft.milestone_id || null,
          impact_days:
            draft.impact_days === "" ? null : Number(draft.impact_days),
        },
      );
      if (live.current) await onSaved();
    } catch (e) {
      if (live.current) {
        if (e.status === 401) onExpired();
        else setError(e);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "编辑需求变更" : "记录需求变更"}
      sub="确认与执行分开登记，原约定和每次调整均保留历史"
      icon={GitPullRequestArrow}
      onClose={close}
      wide
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="space-y-5 px-6 pb-2">
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500">
            本台账仅注册成员可见。密码、私钥和令牌请存到“资源与配置”。
          </p>
          <Field label="变更标题">
            <input
              required
              maxLength={240}
              value={draft.title}
              onChange={set("title")}
              className={inputClass}
              placeholder="例如：增加按月统计报表"
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="原约定（选填）">
              <textarea
                rows={5}
                maxLength={4000}
                value={draft.original_scope}
                onChange={set("original_scope")}
                className={inputClass}
                placeholder="原先确定的范围、做法或交付要求"
              />
            </Field>
            <Field label="本次调整">
              <textarea
                required
                rows={5}
                maxLength={4000}
                value={draft.requested_scope}
                onChange={set("requested_scope")}
                className={inputClass}
                placeholder="这次需要新增、删去或调整什么"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="提出人（选填）">
              <input
                maxLength={100}
                value={draft.requester}
                onChange={set("requester")}
                className={inputClass}
              />
            </Field>
            <Field label="提出日期（选填）">
              <input
                type="date"
                value={draft.requested_on}
                onChange={set("requested_on")}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="确认状态">
              <select
                value={draft.confirmation_status}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    confirmation_status: e.target.value,
                    ...(e.target.value !== "confirmed"
                      ? { confirmed_by: "", confirmed_on: "" }
                      : {}),
                  }))
                }
                className={inputClass}
              >
                {Object.entries(confirmations).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="执行状态">
              <select
                value={draft.progress_status}
                onChange={set("progress_status")}
                className={inputClass}
              >
                {Object.entries(progresses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {draft.confirmation_status === "confirmed" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="确认人（选填）">
                <input
                  maxLength={100}
                  value={draft.confirmed_by}
                  onChange={set("confirmed_by")}
                  className={inputClass}
                />
              </Field>
              <Field label="确认日期（选填）">
                <input
                  type="date"
                  value={draft.confirmed_on}
                  onChange={set("confirmed_on")}
                  className={inputClass}
                />
              </Field>
            </div>
          )}
          {draft.confirmation_status !== "confirmed" &&
            draft.progress_status !== "not_started" && (
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700">
                这项调整尚未登记为已确认，当前执行情况仍会如实保留。登记已实施不代表客户已验收。
              </p>
            )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="跟进人（选填）">
              <input
                maxLength={100}
                value={draft.owner}
                onChange={set("owner")}
                className={inputClass}
              />
            </Field>
            <Field
              label="工期影响天数（选填）"
              hint="正数为增加，负数为缩短，0 为不影响；不会自动修改计划日期。"
            >
              <input
                type="number"
                step="any"
                min={-3650}
                max={3650}
                value={draft.impact_days}
                onChange={set("impact_days")}
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="影响说明（选填）">
            <textarea
              rows={3}
              maxLength={1000}
              value={draft.schedule_impact}
              onChange={set("schedule_impact")}
              className={inputClass}
              placeholder="涉及哪些范围、设备、人员或交付安排"
            />
          </Field>
          <Field label="关联里程碑（选填）">
            <select
              value={draft.milestone_id}
              onChange={set("milestone_id")}
              className={inputClass}
            >
              <option value="">不关联</option>
              {draft.milestone_id &&
                !milestones.some((m) => m.id === draft.milestone_id) && (
                  <option value={draft.milestone_id}>
                    {initial?.milestone?.title || "原里程碑"}
                    （已移除，保留历史）
                  </option>
                )}
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </Field>
          <details
            className="rounded-xl border border-slate-200 p-4"
            open={draft.task_ids.length > 0}
          >
            <summary className="cursor-pointer text-[13px] font-medium text-slate-600">
              关联任务（选填，已选 {draft.task_ids.length} 项）
            </summary>
            <input
              aria-label="搜索关联变更任务"
              value={taskSearch}
              onChange={(e) => setTaskSearch(e.target.value)}
              className={inputClass + " mt-3"}
              placeholder="按工作事项或人员查找"
            />
            <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
              {[
                ...choices.map((r) => ({ id: r.id, title: r.task })),
                ...missing.map((id) => ({
                  id,
                  title:
                    (initial?.tasks?.find((t) => t.id === id)?.title ||
                      "原任务") + "（已移除，保留历史）",
                })),
              ].map((r) => (
                <label
                  key={r.id}
                  className="flex items-start gap-2 rounded-lg px-2 py-2 text-xs text-slate-500 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-indigo-600"
                    checked={draft.task_ids.includes(r.id)}
                    disabled={
                      !draft.task_ids.includes(r.id) &&
                      draft.task_ids.length >= 100
                    }
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        task_ids: e.target.checked
                          ? [...d.task_ids, r.id]
                          : d.task_ids.filter((id) => id !== r.id),
                      }))
                    }
                  />
                  <span className="break-words">{r.title}</span>
                </label>
              ))}
              {!choices.length && !missing.length && (
                <p className="px-2 py-3 text-xs text-slate-400">
                  没有可关联的任务
                </p>
              )}
            </div>
          </details>
        </fieldset>
        <FormError error={error} onReload={initial ? reload : undefined} />
        <FormActions
          onClose={close}
          busy={busy}
          disabled={!draft.title.trim() || !draft.requested_scope.trim()}
          label="保存变更"
        />
      </form>
    </Modal>
  );
}

const snapshotLabels = {
  title: "标题",
  original_scope: "原约定",
  requested_scope: "本次调整",
  requester: "提出人",
  requested_on: "提出日期",
  confirmation_status: "确认状态",
  confirmed_by: "确认人",
  confirmed_on: "确认日期",
  schedule_impact: "影响说明",
  impact_days: "工期影响天数",
  owner: "跟进人",
  progress_status: "执行状态",
  task_ids: "关联任务 ID",
  milestone_id: "关联里程碑 ID",
  deleted: "回收站",
};
function Snapshot({ value }) {
  if (!value) return <p className="text-xs text-slate-400">尚无记录</p>;
  return (
    <dl className="space-y-2">
      {Object.entries(snapshotLabels).map(([key, label]) => {
        const raw = value[key];
        const shown =
          key === "confirmation_status"
            ? confirmations[raw]
            : key === "progress_status"
              ? progresses[raw]
              : key === "deleted"
                ? raw
                  ? "已移除"
                  : "正常"
                : Array.isArray(raw)
                  ? raw.join("、")
                  : raw;
        return (
          <div key={key}>
            <dt className="text-[11px] text-slate-400">{label}</dt>
            <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-600">
              {shown === null || shown === undefined || shown === ""
                ? "—"
                : shown}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
function ChangeDetail({
  id,
  projectId,
  onClose,
  onEdit,
  onOpenTask,
  onExpired,
}) {
  const [data, setData] = useState(null),
    [entries, setEntries] = useState([]),
    [cursor, setCursor] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const live = useRef(true),
    serial = useRef(0);
  const reloadDetails = useCallback(async () => {
    const seq = ++serial.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api("/changes/" + id);
      if (result.change.project_id !== projectId) {
        if (live.current && seq === serial.current) {
          setData(null);
          setEntries([]);
          setCursor(null);
        }
        throw new Error("这条变更不属于当前项目，请切换至对应项目查看");
      }
      if (live.current && seq === serial.current) {
        setData(result.change);
        setEntries(result.history.entries);
        setCursor(result.history.next_before);
      }
    } catch (e) {
      if (live.current && seq === serial.current) {
        if (e.status === 401) {
          setData(null);
          setEntries([]);
          setCursor(null);
          onExpired();
        } else setError(e);
      }
    } finally {
      if (live.current && seq === serial.current) setBusy(false);
    }
  }, [id, projectId, onExpired]);
  useEffect(() => {
    live.current = true;
    reloadDetails();
    return () => {
      live.current = false;
      serial.current++;
    };
  }, [reloadDetails]);
  async function older() {
    const seq = ++serial.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/changes/${id}/history?before=${cursor}`);
      if (live.current && seq === serial.current) {
        setEntries((v) => [
          ...v,
          ...r.entries.filter((n) => !v.some((o) => o.id === n.id)),
        ]);
        setCursor(r.next_before);
      }
    } catch (e) {
      if (live.current && seq === serial.current) {
        if (e.status === 401) {
          setData(null);
          setEntries([]);
          setCursor(null);
          onExpired();
        } else setError(e);
      }
    } finally {
      if (live.current && seq === serial.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="变更详情与历史"
      sub={data?.title || "正在加载变更记录"}
      icon={History}
      onClose={onClose}
      wide
    >
      <div className="space-y-5 px-6 pb-6">
        {error && (
          <div className="space-y-3">
            <FormError error={error} />
            <button
              className={secondary}
              disabled={busy}
              onClick={reloadDetails}
            >
              重新加载变更详情
            </button>
          </div>
        )}
        {!data && !error && (
          <p className="py-8 text-center text-sm text-slate-400">正在加载…</p>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badges row={data} />
              {!data.deleted && (
                <button className={secondary} onClick={() => onEdit(data)}>
                  <Pencil className="h-3.5 w-3.5" />
                  编辑变更
                </button>
              )}
            </div>
            {data.deleted && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-700">
                此变更已移入回收站，历史仍保留。可回到回收站恢复。
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl bg-slate-50 p-4">
                <h3 className="mb-2 text-xs font-medium text-slate-400">
                  原约定
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">
                  {data.original_scope || "未填写"}
                </p>
              </div>
              <div className="rounded-xl bg-indigo-50/60 p-4">
                <h3 className="mb-2 text-xs font-medium text-indigo-400">
                  本次调整
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                  {data.requested_scope}
                </p>
              </div>
            </div>
            <div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-2">
              <p>
                提出：{data.requester || "未填写"} ·{" "}
                {data.requested_on || "日期未填"}
              </p>
              <p>跟进：{data.owner || "未填写"}</p>
              <p>工期：{impactLabel(data.impact_days)}</p>
              {data.confirmation_status === "confirmed" && (
                <p>
                  确认：{data.confirmed_by || "未填写"} ·{" "}
                  {data.confirmed_on || "日期未填"}
                </p>
              )}
            </div>
            {data.schedule_impact && (
              <p className="whitespace-pre-wrap break-words rounded-xl border border-slate-100 p-3 text-sm leading-relaxed text-slate-600">
                {data.schedule_impact}
              </p>
            )}
            {data.milestone && (
              <p className="break-words text-xs text-slate-500">
                关联里程碑：{data.milestone.title}
                {data.milestone.deleted ? "（已移除）" : ""}
              </p>
            )}
            {data.tasks.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-slate-400">关联任务</h3>
                {data.tasks.map((r) => (
                  <button
                    key={r.id}
                    disabled={r.deleted}
                    className="flex max-w-full items-center gap-1 break-words rounded-lg px-2 py-1 text-left text-xs text-indigo-500 hover:bg-indigo-50 disabled:text-slate-400"
                    onClick={() => onOpenTask?.(r.id)}
                  >
                    <ArrowUpRight className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 break-words">
                      {r.title}
                      {r.deleted ? "（已移除）" : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-400">
              确认和实施均为人工登记，不代表客户已验收，也不会改写关联任务完成情况。
            </p>
            <section
              aria-label="变更完整历史"
              className="border-t border-slate-100 pt-4"
            >
              <h3 className="mb-3 text-sm font-semibold text-slate-700">
                完整修改历史
              </h3>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <details
                    key={entry.id}
                    className="rounded-xl border border-slate-100 p-3"
                  >
                    <summary className="cursor-pointer text-xs text-slate-500">
                      第 {entry.revision} 版 · {entry.actor_name}{" "}
                      {actions[entry.action]} · {displayTime(entry.created)}
                    </summary>
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div className="min-w-0 rounded-lg bg-slate-50 p-3">
                        <h4 className="mb-3 text-xs font-medium text-slate-500">
                          修改前
                        </h4>
                        <Snapshot value={entry.before} />
                      </div>
                      <div className="min-w-0 rounded-lg bg-indigo-50/50 p-3">
                        <h4 className="mb-3 text-xs font-medium text-indigo-500">
                          修改后
                        </h4>
                        <Snapshot value={entry.after} />
                      </div>
                    </div>
                  </details>
                ))}
              </div>
              {cursor && (
                <button
                  disabled={busy}
                  className={secondary + " mt-3 w-full"}
                  onClick={older}
                >
                  {busy ? "加载中…" : "加载更早历史"}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
