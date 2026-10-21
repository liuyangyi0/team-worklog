import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  History,
  LockKeyhole,
  RefreshCw,
  ChevronDown,
  ArrowRight,
} from "lucide-react";
import { api } from "../api.js";
import { colorOf, priorityOf } from "../model.js";
import { LOG_ACTIONS, logChanges, logTitle } from "../logs.js";
import { secondary } from "./UI.jsx";
function display(value, key) {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.length ? value.join("、") : "未设置";
  if (!value) return key === "date" ? "" : "未填写";
  if (key === "priority") return priorityOf(value).label;
  if (key === "color") return colorOf(value).label;
  return String(value);
}
export default function OperationLog({ project, revision = 0 }) {
  const [all, setAll] = useState(false),
    [entries, setEntries] = useState([]),
    [total, setTotal] = useState(0),
    [cursor, setCursor] = useState(null),
    [busy, setBusy] = useState(true),
    [moreBusy, setMoreBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0),
    olderLoaded = useRef(false),
    headBusy = useRef(false),
    scope = all ? "" : project?.id || "";
  const query = useCallback(
    (before) =>
      "/logs?limit=20" +
      (scope ? "&project=" + encodeURIComponent(scope) : "") +
      (before ? "&before=" + before : ""),
    [scope],
  );
  const reload = useCallback(async () => {
    const seq = ++sequence.current;
    headBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await api(query());
      if (seq !== sequence.current) return;
      setEntries(data.entries);
      setTotal(data.total);
      setCursor(data.nextCursor);
      olderLoaded.current = false;
    } catch (e) {
      if (seq === sequence.current) setError(e.message);
    } finally {
      if (seq === sequence.current) {
        headBusy.current = false;
        setBusy(false);
      }
    }
  }, [query]);
  useEffect(() => {
    olderLoaded.current = false;
    setEntries([]);
    setCursor(null);
    setTotal(0);
    setMoreBusy(false);
    reload();
    const timer = setInterval(() => {
      if (!document.hidden && !olderLoaded.current && !headBusy.current)
        reload();
    }, 30000);
    return () => {
      clearInterval(timer);
      sequence.current++;
      headBusy.current = false;
    };
  }, [reload, revision]);
  async function more() {
    if (!cursor || moreBusy || busy) return;
    setMoreBusy(true);
    setError("");
    olderLoaded.current = true;
    const seq = sequence.current;
    try {
      const data = await api(query(cursor));
      if (seq !== sequence.current) return;
      setEntries((previous) => {
        const seen = new Set(previous.map((e) => e.id));
        return [...previous, ...data.entries.filter((e) => !seen.has(e.id))];
      });
      setCursor(data.nextCursor);
      setTotal(data.total);
    } catch (e) {
      if (seq === sequence.current) setError(e.message);
    } finally {
      if (seq === sequence.current) setMoreBusy(false);
    }
  }
  return (
    <section aria-label="操作日志" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <History className="h-4 w-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-slate-700">操作日志</h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500">
              <LockKeyhole className="h-3 w-3" />
              不可修改或删除
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
            所有人均可查看，新增、修改、删除和撤销均保留记录。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex rounded-xl bg-slate-100 p-1"
            role="group"
            aria-label="日志范围"
          >
            <button
              aria-pressed={!all}
              className={
                "rounded-lg px-3 py-1.5 text-xs " +
                (!all ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400")
              }
              onClick={() => setAll(false)}
            >
              本项目
            </button>
            <button
              aria-pressed={all}
              className={
                "rounded-lg px-3 py-1.5 text-xs " +
                (all ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400")
              }
              onClick={() => setAll(true)}
            >
              全部项目
            </button>
          </div>
          <button
            className={secondary + " px-3 text-xs"}
            disabled={busy || moreBusy}
            onClick={reload}
          >
            <RefreshCw
              className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")}
            />
            刷新日志
          </button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-600"
        >
          暂时无法读取日志：{error}
        </p>
      )}
      {busy && !entries.length ? (
        <div className="rounded-2xl border border-slate-200/70 bg-white py-16 text-center text-sm text-slate-400">
          正在加载日志…
        </div>
      ) : entries.length === 0 && !error ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 py-16 text-center text-sm text-slate-400">
          暂无操作日志
        </div>
      ) : (
        <>
          <p className="px-1 text-xs text-slate-400">
            共 {total} 条 · 按操作时间倒序
          </p>
          <div className="space-y-3">
            {entries.map((entry) => {
              const changes = logChanges(entry),
                deleting = entry.action === "delete-record";
              return (
                <article
                  key={entry.id}
                  data-log-id={entry.id}
                  className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                >
                  <header className="border-b border-slate-100 px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <strong className="font-semibold text-slate-700">
                          {entry.actor || "历史成员"}
                        </strong>
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-[11px] " +
                            (deleting
                              ? "bg-rose-50 text-rose-600"
                              : "bg-indigo-50 text-indigo-600")
                          }
                        >
                          {LOG_ACTIONS[entry.action] || "更新内容"}
                        </span>
                      </div>
                      <time
                        dateTime={entry.created}
                        className="text-[11px] tabular-nums text-slate-400"
                      >
                        {new Date(entry.created).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </time>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium text-slate-800">
                      {logTitle(entry)}
                    </p>
                    <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-slate-400">
                      <span>所属项目：{entry.projectName || "历史项目"}</span>
                      <span>日志 #{entry.id}</span>
                    </div>
                  </header>
                  <div className="divide-y divide-slate-50 px-5 py-1">
                    {changes.length ? (
                      changes.map((change) => (
                        <div
                          key={change.key}
                          className="grid grid-cols-[80px_1fr] gap-3 py-3 text-xs"
                        >
                          <span className="text-slate-400">{change.label}</span>
                          <div className="flex min-w-0 flex-wrap items-start gap-2">
                            <span className="max-w-full whitespace-pre-wrap break-words rounded-md bg-slate-50 px-2 py-1 text-slate-500">
                              {display(change.before, change.key)}
                            </span>
                            <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300" />
                            <span
                              className={
                                "max-w-full whitespace-pre-wrap break-words rounded-md px-2 py-1 " +
                                (deleting
                                  ? "bg-rose-50 text-rose-500"
                                  : "bg-indigo-50 text-indigo-600")
                              }
                            >
                              {deleting
                                ? "已删除"
                                : display(change.after, change.key)}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="py-3 text-xs text-slate-400">
                        已保存，内容未发生变化。
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {cursor && (
            <div className="pt-2 text-center">
              <button
                className={secondary}
                disabled={moreBusy || busy}
                onClick={more}
              >
                <ChevronDown className="h-4 w-4" />
                {moreBusy ? "加载中…" : "加载更早日志"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
