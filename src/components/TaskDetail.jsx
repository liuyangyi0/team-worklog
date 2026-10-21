import { DependencyDetail } from "./Relations.jsx";
import { PriorityBadge, DueBadge } from "./Planning.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  MessageSquare,
  Plus,
  Pencil,
  Trash2,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Send,
  RefreshCw,
} from "lucide-react";
import { api } from "../api.js";
import { isCompleted, splitNames } from "../model.js";
import {
  Modal,
  AvatarChip,
  DateBadge,
  primary,
  secondary,
  FormError,
  inputClass,
} from "./UI.jsx";
export default function TaskDetail({
  record,
  project,
  records,
  user,
  onClose,
  onOpen,
  onEdit,
  onDelete,
  onAddChild,
  onLogin,
  onChanged,
  members = [],
}) {
  const children = records.filter((r) => r.parent_id === record.id),
    parent = records.find((r) => r.id === record.parent_id);
  const [comments, setComments] = useState([]),
    [cursor, setCursor] = useState(null),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [body, setBody] = useState(""),
    [edit, setEdit] = useState(null),
    [removing, setRemoving] = useState(null);
  const serial = useRef(0),
    older = useRef(false);
  const load = useCallback(
    async (before) => {
      const seq = ++serial.current;
      setLoading(true);
      setError("");
      try {
        const next = await api(
          "/records/" +
            record.id +
            "/comments" +
            (before ? "?before=" + before : ""),
        );
        if (seq !== serial.current) return;
        setComments((previous) =>
          before
            ? [
                ...next.entries,
                ...previous.filter(
                  (c) => !next.entries.some((n) => n.id === c.id),
                ),
              ]
            : next.entries,
        );
        setCursor(next.nextCursor);
        setTotal(next.total);
        older.current = Boolean(before);
      } catch (e) {
        if (seq === serial.current) setError(e.message);
        throw e;
      } finally {
        if (seq === serial.current) setLoading(false);
      }
    },
    [record.id],
  );
  useEffect(() => {
    load().catch(() => {});
    const timer = setInterval(() => {
      if (!document.hidden && !older.current) load().catch(() => {});
    }, 30000);
    return () => {
      serial.current++;
      clearInterval(timer);
    };
  }, [load]);
  async function mutate(route, method, data, message, clear) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(route, method, data);
    } catch (e) {
      setError(e.message);
      setBusy(false);
      return;
    }
    clear?.();
    setNotice(message);
    try {
      await load();
      await onChanged();
    } catch {
      setError(message + "；列表同步失败，请刷新评论");
    }
    setBusy(false);
  }
  return (
    <Modal
      title="任务详情"
      sub={project?.name || "项目工作记录"}
      icon={GitBranch}
      onClose={onClose}
      wide
    >
      <div className="task-detail px-6 pb-6">
        {parent && (
          <button
            className="mb-3 flex items-center gap-1 text-xs text-indigo-500 hover:underline"
            onClick={() => onOpen(parent)}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            上级任务：{parent.task}
          </button>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xl font-bold text-slate-800">
            {record.task}
          </h3>
          <span
            className={
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs " +
              (isCompleted(record)
                ? "bg-emerald-50 text-emerald-600"
                : "bg-amber-50 text-amber-600")
            }
          >
            {isCompleted(record) ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Clock3 className="h-3.5 w-3.5" />
            )}
            {isCompleted(record) ? "已完成" : "未完成"}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <PriorityBadge value={record.priority} />
          <DueBadge record={record} />
        </div>
        {record.description && (
          <div className="task-description mt-4 whitespace-pre-wrap break-words rounded-2xl border border-slate-100 px-4 py-3 text-sm leading-relaxed text-slate-600">
            {record.description}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 rounded-2xl bg-slate-50 p-4 sm:grid-cols-3">
          {[
            ["原定负责人", splitNames(record.owner)],
            ["实际完成人", splitNames(record.actual)],
          ].map(([label, names]) => (
            <div key={label}>
              <div className="mb-2 text-xs text-slate-400">{label}</div>
              <div className="flex flex-wrap gap-1.5">
                {names.length ? (
                  names.map((name) => <AvatarChip key={name} name={name} />)
                ) : (
                  <span className="text-sm text-slate-300">—</span>
                )}
              </div>
            </div>
          ))}
          <div>
            <div className="mb-2 text-xs text-slate-400">完成日期</div>
            <DateBadge date={record.date} actual={record.actual} />
          </div>
        </div>
        {user && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button className={secondary} onClick={() => onEdit(record)}>
              <Pencil className="h-3.5 w-3.5" />
              编辑任务
            </button>
            <button
              className={secondary + " hover:text-rose-500"}
              onClick={() => onDelete(record)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除任务
            </button>
          </div>
        )}
        <DependencyDetail
          record={record}
          records={records}
          onOpen={onOpen}
          onEdit={onEdit}
          user={user}
        />
        <section
          className="mt-6 rounded-2xl border border-slate-200"
          aria-label="子任务"
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <GitBranch className="h-4 w-4 text-indigo-400" />
              子任务{" "}
              <span className="font-normal text-slate-400">
                {children.filter(isCompleted).length}/{children.length}
              </span>
            </h4>
            <button
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-indigo-500 hover:bg-indigo-50"
              onClick={() => onAddChild(record)}
            >
              <Plus className="h-3.5 w-3.5" />
              添加子任务
            </button>
          </div>
          {children.length ? (
            <ul className="divide-y divide-slate-100">
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    onClick={() => onOpen(child)}
                    className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-slate-50"
                  >
                    {isCompleted(child) ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-pre-wrap break-words text-sm text-slate-700">
                        {child.task}
                      </span>
                      <span className="mt-1 block text-xs text-slate-400">
                        负责：{child.owner}
                        {child.actual ? " · 完成：" + child.actual : ""}
                      </span>
                    </span>
                    <ArrowUpRight className="mt-1 h-3 w-3 shrink-0 text-slate-300" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-5 text-xs text-slate-400">
              可以把这项工作拆成几个子任务，分别记录负责人和完成人。
            </p>
          )}
        </section>
        <section className="mt-6" aria-label="任务评论">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <MessageSquare className="h-4 w-4 text-indigo-400" />
              评论 <span className="font-normal text-slate-400">{total}</span>
            </h4>
            <button
              disabled={loading || busy}
              onClick={() => {
                setEdit(null);
                setRemoving(null);
                load().catch(() => {});
              }}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-500"
            >
              <RefreshCw className="h-3 w-3" />
              刷新评论
            </button>
          </div>
          {cursor && (
            <button
              className={secondary + " mb-4 w-full"}
              disabled={loading}
              onClick={() => load(cursor).catch(() => {})}
            >
              加载更早评论
            </button>
          )}
          <div className="space-y-4">
            {comments.map((c) => (
              <article
                key={c.id}
                data-comment-id={c.id}
                className="rounded-2xl border border-slate-200 bg-white"
              >
                <header className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl bg-slate-50 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-xs text-slate-700">
                      {c.author_name}
                    </strong>
                    <time
                      className="text-[11px] text-slate-400"
                      dateTime={c.created}
                    >
                      {new Date(c.created).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                        hour12: false,
                      })}
                    </time>
                    {c.updated !== c.created && (
                      <span className="text-[10px] text-slate-400">已修改</span>
                    )}
                  </div>
                  {user && (
                    <div className="flex gap-2">
                      <button
                        disabled={busy}
                        aria-label={"编辑评论 " + c.id}
                        onClick={() => {
                          setEdit({ ...c });
                          setRemoving(null);
                        }}
                        className="rounded p-1 text-slate-400 hover:text-indigo-500"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        disabled={busy}
                        aria-label={"删除评论 " + c.id}
                        onClick={() => {
                          setRemoving(c);
                          setEdit(null);
                        }}
                        className="rounded p-1 text-slate-400 hover:text-rose-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </header>
                {edit?.id === c.id ? (
                  <form
                    className="space-y-3 p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      mutate(
                        "/records/" + record.id + "/comments/" + c.id,
                        "PATCH",
                        { body: edit.body, version: edit.version },
                        "评论已修改",
                        () => setEdit(null),
                      );
                    }}
                  >
                    <textarea
                      aria-label="修改评论内容"
                      rows={3}
                      required
                      maxLength={3000}
                      className={inputClass}
                      value={edit.body}
                      onChange={(e) =>
                        setEdit({ ...edit, body: e.target.value })
                      }
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className={secondary}
                        onClick={() => setEdit(null)}
                      >
                        取消修改
                      </button>
                      <button
                        className={primary}
                        disabled={busy || !edit.body.trim()}
                      >
                        保存评论
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="whitespace-pre-wrap break-words px-4 py-4 text-sm leading-relaxed text-slate-600">
                    {c.body}
                  </p>
                )}
                {removing?.id === c.id && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
                    <span className="text-xs text-slate-400">
                      删除后，原内容仍保留在操作日志中。
                    </span>
                    <div className="flex gap-2">
                      <button
                        className={secondary}
                        disabled={busy}
                        onClick={() => setRemoving(null)}
                      >
                        取消删除
                      </button>
                      <button
                        className={primary + " bg-none bg-rose-500"}
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            "/records/" + record.id + "/comments/" + c.id,
                            "DELETE",
                            { version: removing.version },
                            "评论已删除",
                            () => setRemoving(null),
                          )
                        }
                      >
                        确认删除评论
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
          {!comments.length && !loading && (
            <p className="rounded-2xl bg-slate-50 px-4 py-5 text-xs text-slate-400">
              还没有评论，可以记录进展、讨论分工或补充说明。
            </p>
          )}
          {loading && (
            <p className="py-3 text-xs text-slate-400">正在加载评论…</p>
          )}
          {user ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                mutate(
                  "/records/" + record.id + "/comments",
                  "POST",
                  { body },
                  "评论已发表",
                  () => setBody(""),
                );
              }}
            >
              <textarea
                aria-label="评论内容"
                placeholder="写下进展，输入 @姓名 提醒对应成员…"
                rows={3}
                maxLength={3000}
                required
                className={inputClass}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="提及成员"
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      setBody(
                        (v) =>
                          (v ? v.trimEnd() + " " : "") +
                          "@" +
                          e.target.value +
                          " ",
                      );
                  }}
                  className="max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 outline-none focus:ring-2 focus:ring-indigo-100"
                >
                  <option value="">@ 提及成员</option>
                  {members.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-slate-400">
                  选择成员或输入 @姓名，姓名后加空格。
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-400">
                  评论公开可见，修改和删除会留日志。
                </span>
                <button
                  className={primary + " shrink-0"}
                  disabled={busy || !body.trim()}
                >
                  <Send className="h-3.5 w-3.5" />
                  {busy ? "提交中…" : "发表评论"}
                </button>
              </div>
            </form>
          ) : (
            <button className={secondary + " mt-4 w-full"} onClick={onLogin}>
              登录后发表评论
            </button>
          )}
          {notice && (
            <p role="status" className="mt-3 text-xs text-emerald-600">
              {notice}
            </p>
          )}
          <FormError error={error} />
        </section>
      </div>
    </Modal>
  );
}
