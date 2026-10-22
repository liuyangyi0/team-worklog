import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Archive, Clock3, RefreshCw, Search } from "lucide-react";
import { api } from "../api.js";
import { displayTime } from "../library-api.js";
import { InternalLogin } from "./ProjectLibrary.jsx";
import { inputClass, primary, secondary } from "./UI.jsx";
import NoteExchange from "./NoteExchange.jsx";

const names = {
  note: "随手记",
  milestone: "里程碑",
  change: "需求变更",
  document: "文件资料",
  delivery: "交付归档",
};
const box =
  "rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const initial = (project, mode) => ({
  mode,
  project_id: project?.id || "",
  q: "",
  kind: "",
  file_direction: "",
  from: "",
  to: "",
  page: 1,
  limit: 20,
});
export default function ProjectArchive(props) {
  if (!props.user)
    return (
      <div className="pt-8">
        <InternalLogin label="项目档案" onLogin={props.onLogin} />
      </div>
    );
  return (
    <ArchiveSession
      key={[
        props.user.id,
        props.project?.id || "all",
        props.initialMode || "timeline",
      ].join(":")}
      {...props}
    />
  );
}
function ArchiveSession({
  project,
  onLogin,
  onOpenItem,
  initialMode = "timeline",
}) {
  const [draft, setDraft] = useState(() => initial(project, initialMode));
  const [query, setQuery] = useState(() => initial(project, initialMode));
  const [result, setResult] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [expired, setExpired] = useState(false);
  const live = useRef(true),
    serial = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      serial.current++;
    };
  }, []);
  const expire = useCallback(() => {
    serial.current++;
    setResult(null);
    setDraft(initial(null, initialMode));
    setQuery(initial(null, initialMode));
    setError("");
    setLoading(false);
    setExpired(true);
  }, [initialMode]);
  const load = useCallback(async () => {
    if (expired) return;
    const seq = ++serial.current;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const params = new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
      );
      const next = await api("/project-archive?" + params);
      if (!live.current || serial.current !== seq) return;
      setResult(next);
    } catch (e) {
      if (!live.current) return;
      if (e.status === 401) expire();
      else if (serial.current === seq) setError(e.message);
    } finally {
      if (live.current && serial.current === seq) setLoading(false);
    }
  }, [query, expired, expire]);
  useEffect(() => {
    load();
    return () => {
      serial.current++;
    };
  }, [load]);
  function tab(mode) {
    const next = { ...draft, mode, page: 1 };
    setDraft(next);
    setQuery(next);
  }
  function submit(e) {
    e.preventDefault();
    const next = { ...draft, q: draft.q.trim(), page: 1 };
    setDraft(next);
    setQuery(next);
  }
  function field(key, value) {
    setDraft((old) => ({
      ...old,
      [key]: value,
      ...(key === "file_direction" && value ? { kind: "note" } : {}),
      ...(key === "kind" && value !== "note" ? { file_direction: "" } : {}),
    }));
  }
  if (expired)
    return (
      <div className="pt-8">
        <InternalLogin label="项目档案" onLogin={onLogin} />
      </div>
    );
  const page = query.page,
    total = result?.total || 0,
    pages = Math.max(1, Math.ceil(total / query.limit));
  return (
    <section className="pt-8" aria-label="项目档案">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            {query.mode === "timeline" ? "项目大事记" : "统一查档"}
          </h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-400">
            从原有记录聚合项目事实，保留发生日、系统登记时间和原始入口。
          </p>
        </div>
        <button
          type="button"
          className={secondary}
          onClick={load}
          disabled={loading}
          aria-label="刷新项目档案"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>
      <div className="mt-6 flex gap-2" role="tablist" aria-label="档案视图">
        {[
          ["timeline", "大事记", Clock3],
          ["search", "统一查档", Search],
        ].map(([id, label, Icon]) => (
          <button
            type="button"
            role="tab"
            aria-selected={query.mode === id}
            key={id}
            className={query.mode === id ? primary : secondary}
            onClick={() => tab(id)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      <form
        onSubmit={submit}
        className={box + " mt-4 p-4"}
        aria-label="档案查询条件"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs text-slate-500">
            项目范围
            <select
              aria-label="项目范围"
              className={inputClass + " mt-1.5"}
              value={draft.project_id}
              onChange={(e) => field("project_id", e.target.value)}
            >
              <option value="">全部项目</option>
              {(result?.projects || (project ? [project] : [])).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            来源类型
            <select
              aria-label="来源类型"
              className={inputClass + " mt-1.5"}
              value={draft.kind}
              onChange={(e) => field("kind", e.target.value)}
            >
              <option value="">全部来源</option>
              {Object.entries(names).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            文件收发
            <select
              aria-label="文件收发"
              className={inputClass + " mt-1.5"}
              value={draft.file_direction}
              onChange={(e) => field("file_direction", e.target.value)}
            >
              <option value="">全部收发</option>
              <option value="received">收到文件</option>
              <option value="sent">发出文件</option>
              <option value="unclassified">未区分收发</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            起始日期
            <input
              type="date"
              aria-label="起始日期"
              className={inputClass + " mt-1.5"}
              value={draft.from}
              onChange={(e) => field("from", e.target.value)}
            />
          </label>
          <label className="text-xs text-slate-500">
            结束日期
            <input
              type="date"
              aria-label="结束日期"
              className={inputClass + " mt-1.5"}
              value={draft.to}
              onChange={(e) => field("to", e.target.value)}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            aria-label="查档关键词"
            maxLength={200}
            className={inputClass + " min-w-0 flex-1 basis-56"}
            placeholder="标题、人员、往来方、渠道、正文、标签或历史文件名"
            value={draft.q}
            onChange={(e) => field("q", e.target.value)}
          />
          <button className={primary} type="submit">
            <Search size={14} />
            查询档案
          </button>
        </div>
        {draft.file_direction && (
          <p className="mt-3 text-xs leading-5 text-indigo-500">
            文件收发筛选仅包含文件类随手记；切换其他来源将清除此筛选。
          </p>
        )}
        <p className="mt-3 text-xs leading-5 text-slate-400">
          仅检索资料元数据和记录正文；不解析文件正文，不做
          OCR。日期范围按发生日筛选；发生日未填的记录按系统登记日（北京时间）筛选。
        </p>
      </form>
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600"
        >
          {error}
        </div>
      )}
      <div
        className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"
        aria-live="polite"
      >
        <span>
          {loading
            ? "正在读取档案…"
            : result
              ? "共 " + total + " 项"
              : "查询未完成"}
        </span>
        {query.mode === "timeline" && (
          <span>业务事件按发生日优先排序；缺失时按登记时间排序</span>
        )}
        {query.mode === "search" && <span>同一资料的不同文件版本分别展示</span>}
      </div>
      {!loading && result?.items.length === 0 && (
        <div
          className={
            box + " mt-3 px-5 py-14 text-center text-sm text-slate-400"
          }
        >
          <Archive size={24} className="mx-auto mb-3 text-slate-300" />
          没有符合条件的档案
        </div>
      )}
      <div className="mt-3 space-y-3">
        {result?.items.map((item) => (
          <article className={box + " min-w-0 p-5"} key={item.id}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-indigo-600">
                {names[item.source_type]}
              </span>
              <span className="break-all text-slate-400">
                {item.project_name}
              </span>
              {item.version_id && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-500">
                  版本 v{item.version_number}
                </span>
              )}
            </div>
            <div className="mt-3 flex items-start justify-between gap-3">
              <h2 className="min-w-0 break-words text-base font-semibold text-slate-800">
                {item.title}
              </h2>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
                onClick={() => onOpenItem?.(item)}
                aria-label={"打开原始内容：" + item.title}
              >
                原始内容
                <ArrowUpRight size={13} />
              </button>
            </div>
            {item.version_name && (
              <p className="mt-1 break-all text-xs text-slate-500">
                文件：{item.version_name}
              </p>
            )}
            <NoteExchange
              note={{ ...item, kind: item.note_kind }}
              className="mt-3"
            />
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-500">
              {item.summary || "该项没有补充说明"}
            </p>
            {query.q && (
              <p className="mt-2 text-xs text-indigo-400">
                命中概述：{item.match_hint}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
              <span>发生日：{item.occurred_on || "未记录"}</span>
              <span>系统登记：{displayTime(item.recorded_at) || "未记录"}</span>
              <span>
                {item.time_basis === "occurred"
                  ? "按发生日排序"
                  : "按系统登记时间排序"}
              </span>
            </div>
          </article>
        ))}
      </div>
      {result && pages > 1 && (
        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            className={secondary}
            disabled={loading || page <= 1}
            onClick={() => setQuery((old) => ({ ...old, page: old.page - 1 }))}
          >
            上一页
          </button>
          <span className="text-xs text-slate-400">
            第 {page} / {pages} 页
          </span>
          <button
            type="button"
            className={secondary}
            disabled={loading || page >= pages}
            onClick={() => setQuery((old) => ({ ...old, page: old.page + 1 }))}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
