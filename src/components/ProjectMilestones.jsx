import React, { useEffect, useRef, useState } from "react";
import {
  Flag,
  Plus,
  RefreshCw,
  Trash2,
  RotateCcw,
  CalendarDays,
  CheckCircle2,
  FileText,
  ArrowUpRight,
} from "lucide-react";
import { api } from "../api.js";
import { beijingDate, isCompleted } from "../model.js";
import { MILESTONE_STATUSES, milestoneStatus } from "../milestones.js";
import {
  Field,
  FormError,
  FormActions,
  Modal,
  inputClass,
  primary,
  secondary,
} from "./UI.jsx";
import PublicNotice from "./PublicNotice.jsx";

export default function ProjectMilestones(props) {
  if (!props.project) return null;
  return (
    <MilestoneSession
      key={props.project.id + ":" + (props.user?.id || "guest")}
      {...props}
    />
  );
}
function MilestoneSession({
  project,
  user,
  records = [],
  onLogin,
  onOpenTask,
  onChanged,
  initialMilestoneId,
}) {
  const [items, setItems] = useState([]),
    [summary, setSummary] = useState(null),
    [canViewInternal, setCanViewInternal] = useState(Boolean(user)),
    [trash, setTrash] = useState(false),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(null),
    [modal, setModal] = useState(null);
  const alive = useRef(true),
    seq = useRef(0),
    deepOpened = useRef(null),
    intent = useRef(0),
    trashRef = useRef(trash);
  trashRef.current = trash;
  function openModal(next) {
    intent.current++;
    setModal(next);
  }
  function revokeInternal() {
    setCanViewInternal(false);
    openModal(null);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      seq.current++;
    };
  }, []);
  async function load() {
    const token = ++seq.current;
    setLoading(true);
    try {
      const data = await api(
        "/projects/" +
          project.id +
          "/milestones" +
          (trashRef.current ? "?deleted=1" : ""),
      );
      if (!alive.current || token !== seq.current) return;
      setItems(data.milestones);
      setCanViewInternal(Boolean(data.can_view_internal));
      if (!data.can_view_internal && user) revokeInternal();
      setSummary(data.summary);
      setError(null);
    } catch (e) {
      if (alive.current && token === seq.current) {
        setError(e);
        if (e.status === 401) {
          revokeInternal();
        }
      }
    } finally {
      if (alive.current && token === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [trash]);
  useEffect(() => {
    if (!initialMilestoneId || deepOpened.current === initialMilestoneId)
      return;
    deepOpened.current = initialMilestoneId;
    let live = true;
    const generation = intent.current;
    api("/milestones/" + initialMilestoneId)
      .then((r) => {
        if (live && alive.current && generation === intent.current) {
          setCanViewInternal(Boolean(r.can_view_internal));
          if (r.milestone.project_id !== project.id)
            setError(new Error("里程碑不属于当前项目"));
          else
            setModal(
              (existing) => existing || { mode: "view", item: r.milestone },
            );
        }
      })
      .catch((e) => {
        if (live && alive.current && generation === intent.current) setError(e);
      });
    return () => {
      live = false;
    };
  }, [initialMilestoneId]);
  const requireLogin = (next) => {
    if (user && canViewInternal) openModal(next);
    else onLogin?.();
  };
  async function restore(item) {
    setWorking(true);
    setError(null);
    try {
      await api("/milestones/" + item.id + "/restore", "POST", {
        version: item.version,
      });
      if (!alive.current) return;
      await load();
      await onChanged?.();
    } catch (e) {
      if (alive.current) {
        if (e.status === 401) revokeInternal();
        setError(e);
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  }
  const visible = items.filter(
    (i) =>
      (!status || i.status === status) &&
      [i.title, i.owner, i.description]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <section className="space-y-5" aria-label="项目里程碑">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-700">
            <Flag className="h-5 w-5 text-indigo-400" />
            {trash ? "里程碑回收站" : "项目里程碑"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            记录关键节点的计划与实际达成。节点由成员确认，任务完成规则保持原样。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondary}
            disabled={loading || working}
            onClick={load}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          {user && canViewInternal && (
            <button
              className={secondary}
              disabled={working}
              onClick={() => {
                setItems([]);
                openModal(null);
                setError(null);
                setTrash((v) => !v);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {trash ? "返回里程碑" : "回收站"}
            </button>
          )}
          {!trash && (
            <button
              className={primary}
              onClick={() => requireLogin({ mode: "edit", item: null })}
            >
              <Plus className="h-3.5 w-3.5" />
              添加里程碑
            </button>
          )}
        </div>
      </div>
      {!trash && summary && (
        <div className="grid grid-cols-3 gap-3">
          {[
            ["关键节点", summary.total],
            ["已达成", summary.achieved],
            ["已逾期", summary.overdue],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-slate-400">{label}</p>
              <p className="mt-2 text-xl font-semibold text-slate-800">
                {value}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  项
                </span>
              </p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <input
          aria-label="搜索里程碑"
          placeholder="搜索节点、负责人或说明"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={inputClass + " sm:max-w-sm"}
        />
        <select
          aria-label="里程碑状态筛选"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={inputClass + " sm:w-40"}
        >
          <option value="">全部状态</option>
          {MILESTONE_STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <FormError error={error} />
      <div className="grid gap-4 xl:grid-cols-2">
        {visible.map((i) => (
          <article
            key={i.id}
            className="min-w-0 rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-400">
                <Flag className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <button
                  className="break-words text-left text-sm font-semibold text-slate-700 hover:text-indigo-600"
                  onClick={() => openModal({ mode: "view", item: i })}
                >
                  {i.title}
                </button>
                <p className="mt-1 break-words text-xs text-slate-400">
                  负责人：{i.owner || "未指定"}
                </p>
              </div>
              <Status item={i} />
            </div>
            <div className="mt-4 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
              <p className="flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                计划：{i.planned_date || "未设置"}
              </p>
              <p>实际：{i.actual_date || "未填写"}</p>
            </div>
            {i.description && (
              <p className="mt-3 line-clamp-2 break-words text-xs leading-relaxed text-slate-400">
                {i.description}
              </p>
            )}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-400">
                关联 {i.tasks.length} 项任务
                {user && canViewInternal
                  ? " · " + (i.documents || []).length + " 份资料"
                  : ""}
              </span>
              <div className="flex gap-3">
                {trash ? (
                  <button
                    disabled={working || !canViewInternal}
                    className="inline-flex items-center gap-1 text-xs text-indigo-500"
                    onClick={() => restore(i)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    恢复
                  </button>
                ) : (
                  user &&
                  canViewInternal && (
                    <button
                      className="text-xs text-slate-500"
                      onClick={() => openModal({ mode: "edit", item: i })}
                    >
                      编辑
                    </button>
                  )
                )}
                <button
                  className="text-xs text-indigo-500"
                  onClick={() => openModal({ mode: "view", item: i })}
                >
                  查看详情
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!visible.length && !loading && (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-12 text-center text-sm text-slate-400">
          {items.length
            ? "没有匹配的里程碑"
            : trash
              ? "回收站为空"
              : "还没有里程碑，可先记录需求确认、联调、验收和交付等关键节点。"}
        </p>
      )}
      {loading && (
        <p className="py-4 text-center text-xs text-slate-400">正在载入…</p>
      )}
      {modal?.mode === "view" && (
        <MilestoneDetail
          item={modal.item}
          project={project}
          user={canViewInternal ? user : null}
          onClose={() => openModal(null)}
          onEdit={() => openModal({ mode: "edit", item: modal.item })}
          onOpenTask={onOpenTask}
          onLogin={onLogin}
        />
      )}
      {modal?.mode === "edit" && user && canViewInternal && (
        <MilestoneEditor
          key={(modal.item?.id || "new") + ":" + (modal.item?.version || 0)}
          project={project}
          item={modal.item}
          onUnauthorized={revokeInternal}
          onClose={() => {
            if (!working) openModal(null);
          }}
          onSaved={async () => {
            if (!alive.current) return;
            openModal(null);
            await load();
            await onChanged?.();
          }}
          onReload={async () => {
            if (!modal.item) return;
            const generation = intent.current;
            let r;
            try {
              r = await api("/milestones/" + modal.item.id);
            } catch (e) {
              if (e.status === 401) revokeInternal();
              throw e;
            }
            if (alive.current && generation === intent.current)
              setModal({ mode: "edit", item: r.milestone });
          }}
        />
      )}
    </section>
  );
}
function Status({ item }) {
  const overdue =
    !["achieved", "cancelled"].includes(item.status) &&
    item.planned_date &&
    item.planned_date < beijingDate();
  return (
    <span
      className={
        "shrink-0 rounded-full px-2 py-1 text-[11px] " +
        (item.status === "achieved"
          ? "bg-emerald-50 text-emerald-600"
          : overdue
            ? "bg-rose-50 text-rose-600"
            : "bg-slate-100 text-slate-500")
      }
    >
      {milestoneStatus(item.status)}
      {overdue ? " · 逾期" : ""}
    </span>
  );
}
function MilestoneDetail({
  item,
  project,
  user,
  onClose,
  onEdit,
  onOpenTask,
  onLogin,
}) {
  return (
    <Modal
      title={"里程碑 · " + item.title}
      sub="公开节点信息；关联内部资料仅登录成员可查看。"
      icon={Flag}
      wide
      onClose={onClose}
    >
      <div className="max-h-[65dvh] space-y-5 overflow-y-auto px-6 pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Status item={item} />
          <span className="text-xs text-slate-500">
            负责人：{item.owner || "未指定"}
          </span>
          {item.deleted && (
            <span className="text-xs text-rose-500">已移入回收站</span>
          )}
        </div>
        <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-xs text-slate-500 sm:grid-cols-2">
          <p>计划达成：{item.planned_date || "未设置"}</p>
          <p>实际达成：{item.actual_date || "未填写"}</p>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">
          {item.description || "未填写说明"}
        </p>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">关联任务</h3>
          {item.tasks.map((t) => (
            <button
              key={t.id}
              disabled={t.deleted}
              onClick={() => onOpenTask?.(t.id)}
              className="flex w-full items-start justify-between gap-3 rounded-xl border border-slate-100 p-3 text-left text-xs text-slate-600 disabled:text-slate-400"
            >
              <span className="min-w-0 break-words">
                {t.task}
                <small className="mt-1 block text-slate-400">
                  {t.deleted ? "已移除" : isCompleted(t) ? "已完成" : "未完成"}{" "}
                  · 负责：{t.owner || "未指定"}
                </small>
              </span>
              {!t.deleted && (
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              )}
            </button>
          ))}
          {!item.tasks.length && (
            <p className="text-xs text-slate-400">未关联任务</p>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">关联资料</h3>
          {user ? (
            (item.documents || []).map((d) => (
              <div
                key={d.document_id}
                className="rounded-xl border border-slate-100 p-3 text-xs"
              >
                <span className="break-words text-slate-600">
                  {d.title}
                  {d.number ? " · V" + d.number : ""}
                  {d.unavailable ? "（已移除或不可用）" : ""}
                </span>
                {!d.unavailable && (
                  <a
                    className="mt-2 flex items-center gap-1 text-indigo-500"
                    href={
                      "?module=documents&project=" +
                      encodeURIComponent(project.id) +
                      "&document=" +
                      encodeURIComponent(d.document_id)
                    }
                  >
                    <FileText className="h-3 w-3" />
                    打开资料
                  </a>
                )}
                {!d.unavailable && d.version_id && (
                  <a
                    className="mt-2 flex items-center gap-1 text-indigo-500"
                    href={
                      "/worklog/api/documents/" +
                      encodeURIComponent(d.document_id) +
                      "/versions/" +
                      encodeURIComponent(d.version_id) +
                      "/download"
                    }
                  >
                    下载固定版本 V{d.number}
                  </a>
                )}
              </div>
            ))
          ) : (
            <button onClick={onLogin} className={secondary}>
              登录后查看关联资料
            </button>
          )}
          {user && !item.documents?.length && (
            <p className="text-xs text-slate-400">未关联资料</p>
          )}
        </section>
        <p className="text-xs leading-relaxed text-slate-400">
          关联任务完成或资料上传不会自动达成节点；实际日期可留空，节点状态由成员确认。
        </p>
        {user && !item.deleted && (
          <button className={primary} onClick={onEdit}>
            编辑里程碑
          </button>
        )}
      </div>
    </Modal>
  );
}
function MilestoneEditor({
  project,
  item,
  onClose,
  onSaved,
  onReload,
  onUnauthorized,
}) {
  const [form, setForm] = useState({
      title: item?.title || "",
      description: item?.description || "",
      owner: item?.owner || "",
      planned_date: item?.planned_date || "",
      actual_date: item?.actual_date || "",
      status: item?.status || "planned",
      task_ids: item?.task_ids || [],
      documents: (item?.documents || []).map(({ document_id, version_id }) => ({
        document_id,
        version_id: version_id || null,
      })),
    }),
    [options, setOptions] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [retry, setRetry] = useState(0),
    [taskSearch, setTaskSearch] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    api("/projects/" + project.id + "/milestone-options")
      .then((r) => {
        if (current) setOptions(r);
      })
      .catch((e) => {
        if (current) {
          if (e.status === 401) onUnauthorized?.();
          setError(e);
        }
      });
    return () => {
      current = false;
    };
  }, [project.id, retry]);
  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        item
          ? "/milestones/" + item.id
          : "/projects/" + project.id + "/milestones",
        item ? "PATCH" : "POST",
        { ...form, ...(item ? { version: item.version } : {}) },
      );
      if (alive.current) await onSaved();
    } catch (e) {
      if (alive.current) {
        if (e.status === 401) onUnauthorized?.();
        setError(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove() {
    if (
      !window.confirm("将里程碑移入回收站？任务和资料不会删除，操作日志保留。")
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/milestones/" + item.id, "DELETE", { version: item.version });
      if (alive.current) await onSaved();
    } catch (e) {
      if (alive.current) {
        if (e.status === 401) onUnauthorized?.();
        setError(e);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function changeDocument(id, version) {
    update(
      "documents",
      form.documents.map((d) =>
        d.document_id === id ? { ...d, version_id: version || null } : d,
      ),
    );
  }
  return (
    <Modal
      title={item ? "编辑里程碑" : "添加里程碑"}
      sub={project.name + " · 关键节点单独确认，保留现有任务完成规则。"}
      icon={Flag}
      wide
      onClose={(event) => {
        if (busy) event?.preventDefault?.();
        else onClose();
      }}
    >
      <form onSubmit={save}>
        <fieldset
          disabled={busy}
          className="max-h-[65dvh] space-y-5 overflow-y-auto px-6 pb-2"
        >
          <PublicNotice />
          <Field label="里程碑名称">
            <input
              required
              maxLength={200}
              autoFocus
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
              className={inputClass}
              placeholder="如：联调完成 / 客户验收 / 正式交付"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="节点负责人">
              <input
                maxLength={100}
                value={form.owner}
                onChange={(e) => update("owner", e.target.value)}
                className={inputClass}
                placeholder="可选"
              />
            </Field>
            <Field label="里程碑状态">
              <select
                value={form.status}
                onChange={(e) => update("status", e.target.value)}
                className={inputClass}
              >
                {MILESTONE_STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="计划达成日期">
              <input
                type="date"
                value={form.planned_date}
                onChange={(e) => update("planned_date", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="实际达成日期（可选）">
              <input
                type="date"
                value={form.actual_date}
                onChange={(e) => update("actual_date", e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="节点说明（公开）">
            <textarea
              rows={3}
              maxLength={1000}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              className={inputClass}
              placeholder="节点目标、达成条件；密码和内部地址请放入登录后的资源与配置。"
            />
          </Field>
          <p className="rounded-xl bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-500">
            选择“已达成”由成员确认，实际日期可留空。填写实际日期不会自动改变节点状态，关联任务状态也保持原样。
          </p>
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-slate-600">关联任务</h3>
            <input
              className={inputClass}
              aria-label="筛选关联任务"
              value={taskSearch}
              onChange={(e) => setTaskSearch(e.target.value)}
              placeholder="搜索任务名称或负责人"
            />
            <div className="max-h-44 space-y-2 overflow-y-auto rounded-xl border border-slate-100 p-3">
              {options?.tasks
                .filter((t) => (t.task + " " + t.owner).includes(taskSearch))
                .map((t) => (
                  <label
                    key={t.id}
                    className="flex items-start gap-2 text-xs text-slate-600"
                  >
                    <input
                      type="checkbox"
                      checked={form.task_ids.includes(t.id)}
                      onChange={(e) =>
                        update(
                          "task_ids",
                          e.target.checked
                            ? [...form.task_ids, t.id]
                            : form.task_ids.filter((id) => id !== t.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words">
                      {t.task} · {t.owner || "未指定"}
                    </span>
                  </label>
                ))}
              {form.task_ids
                .filter((id) => !options?.tasks.some((t) => t.id === id))
                .map((id) => (
                  <label
                    key={id}
                    className="flex items-start gap-2 text-xs text-slate-400"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(
                          "task_ids",
                          form.task_ids.filter((t) => t !== id),
                        )
                      }
                    />
                    已移除任务（保留历史关联）
                  </label>
                ))}
              {options && !options.tasks.length && (
                <p className="text-xs text-slate-400">暂无可关联任务</p>
              )}
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-slate-600">关联内部资料</h3>
            <p className="text-xs leading-relaxed text-slate-400">
              资料标题和关联只对登录成员展示；可固定版本，后续工作版更新不改变此引用。
            </p>
            <div className="max-h-56 space-y-3 overflow-y-auto rounded-xl border border-slate-100 p-3">
              {options?.documents.map((d) => {
                const ref = form.documents.find((r) => r.document_id === d.id);
                return (
                  <div key={d.id} className="space-y-2">
                    <label className="flex items-start gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={Boolean(ref)}
                        onChange={(e) =>
                          update(
                            "documents",
                            e.target.checked
                              ? [
                                  ...form.documents,
                                  { document_id: d.id, version_id: null },
                                ]
                              : form.documents.filter(
                                  (r) => r.document_id !== d.id,
                                ),
                          )
                        }
                      />
                      <span className="min-w-0 break-words">{d.title}</span>
                    </label>
                    {ref && (
                      <select
                        aria-label={d.title + "关联版本"}
                        className={inputClass}
                        value={ref.version_id || ""}
                        onChange={(e) => changeDocument(d.id, e.target.value)}
                      >
                        <option value="">跟随资料当前版本</option>
                        {d.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            固定 V{v.number}
                          </option>
                        ))}
                        {ref.version_id &&
                          !d.versions.some((v) => v.id === ref.version_id) && (
                            <option value={ref.version_id}>
                              原固定版本（历史保留）
                            </option>
                          )}
                      </select>
                    )}
                  </div>
                );
              })}
              {form.documents
                .filter(
                  (ref) =>
                    !options?.documents.some((d) => d.id === ref.document_id),
                )
                .map((ref) => (
                  <label
                    key={ref.document_id}
                    className="flex items-start gap-2 text-xs text-slate-400"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(
                          "documents",
                          form.documents.filter(
                            (d) => d.document_id !== ref.document_id,
                          ),
                        )
                      }
                    />
                    已移除资料（保留历史关联）
                  </label>
                ))}
              {options && !options.documents.length && (
                <p className="text-xs text-slate-400">
                  暂无可关联资料，可先保存节点。
                </p>
              )}
            </div>
          </section>
          <FormError error={error} onReload={item ? onReload : undefined} />
          {!options && error && (
            <button
              type="button"
              className={secondary}
              onClick={() => setRetry((v) => v + 1)}
            >
              重试读取关联选项
            </button>
          )}
          {item && (
            <button
              type="button"
              className="text-xs text-rose-500"
              disabled={busy}
              onClick={remove}
            >
              移入回收站
            </button>
          )}
        </fieldset>
        <FormActions
          busy={busy}
          disabled={!options}
          onClose={() => {
            if (!busy) onClose();
          }}
          label={item ? "保存里程碑" : "创建里程碑"}
        />
      </form>
    </Modal>
  );
}
