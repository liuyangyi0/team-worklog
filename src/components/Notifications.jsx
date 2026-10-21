import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, RefreshCw, ArrowUpRight } from "lucide-react";
import { api } from "../api.js";
import { Modal, secondary } from "./UI.jsx";
export default function Notifications({ onClose, onOpen, onChanged }) {
  const [entries, setEntries] = useState([]),
    [unread, setUnread] = useState(0),
    [cursor, setCursor] = useState(null),
    [latest, setLatest] = useState(0),
    [onlyUnread, setOnlyUnread] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0),
    older = useRef(false),
    pending = useRef(false),
    writing = useRef(false);
  const load = useCallback(
    async (before) => {
      const seq = ++sequence.current;
      pending.current = true;
      setBusy(true);
      setError("");
      try {
        const data = await api(
          "/notifications?limit=20" +
            (onlyUnread ? "&unread=1" : "") +
            (before ? "&before=" + before : ""),
        );
        if (seq !== sequence.current) return;
        setEntries((v) =>
          before
            ? [
                ...v,
                ...data.entries.filter((e) => !v.some((x) => x.id === e.id)),
              ]
            : data.entries,
        );
        setUnread(data.unread);
        setCursor(data.nextCursor);
        if (!before) setLatest(data.latestId);
        older.current = Boolean(before);
      } catch (e) {
        if (seq === sequence.current) setError(e.message);
      } finally {
        if (seq === sequence.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [onlyUnread],
  );
  useEffect(() => {
    setEntries([]);
    setCursor(null);
    older.current = false;
    load();
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !older.current &&
        !pending.current &&
        !writing.current
      )
        load();
    }, 30000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [load]);
  async function read(entry) {
    if (saving || pending.current) return;
    writing.current = true;
    sequence.current++;
    setSaving(true);
    setError("");
    try {
      if (!entry.read_at)
        await api("/notifications/" + entry.id + "/read", "POST", {});
      setEntries((v) =>
        onlyUnread
          ? v.filter((e) => e.id !== entry.id)
          : v.map((e) =>
              e.id === entry.id
                ? { ...e, read_at: e.read_at || new Date().toISOString() }
                : e,
            ),
      );
      if (!entry.read_at) setUnread((v) => Math.max(0, v - 1));
      await onChanged().catch(() => {});
      await onOpen(entry);
    } catch (e) {
      setError(e.message);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }
  async function readAll() {
    if (saving || pending.current) return;
    writing.current = true;
    sequence.current++;
    setSaving(true);
    setError("");
    try {
      await api("/notifications/read", "POST", { through: latest });
      setEntries((v) =>
        onlyUnread
          ? []
          : v.map((e) => ({
              ...e,
              read_at: e.read_at || new Date().toISOString(),
            })),
      );
      setUnread(0);
      if (onlyUnread) setCursor(null);
      await onChanged().catch(() => {});
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }
  return (
    <Modal
      title="站内提醒"
      sub="任务指派、相关任务更新、评论提及和临期提醒"
      icon={Bell}
      onClose={onClose}
      wide
    >
      <section className="px-6 pb-6" aria-label="提醒列表">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-xl bg-slate-100 p-1">
            {[
              [false, "全部提醒"],
              [true, "未读提醒"],
            ].map(([v, label]) => (
              <button
                key={label}
                disabled={saving || busy}
                aria-pressed={onlyUnread === v}
                onClick={() => setOnlyUnread(v)}
                className={
                  "rounded-lg px-3 py-1.5 text-xs " +
                  (onlyUnread === v
                    ? "bg-white text-indigo-600 shadow-sm"
                    : "text-slate-400")
                }
              >
                {label}
                {v && unread > 0 ? " · " + unread : ""}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy || saving || !unread}
              onClick={readAll}
              className={secondary + " text-xs"}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              全部已读
            </button>
            <button
              disabled={busy || saving}
              onClick={() => load()}
              className={secondary + " text-xs"}
              aria-label="刷新提醒"
            >
              <RefreshCw
                className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")}
              />
            </button>
          </div>
        </div>
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-600"
          >
            {error}
          </p>
        )}
        <div className="space-y-3">
          {entries.map((e) => (
            <button
              key={e.id}
              data-notification-id={e.id}
              disabled={saving || busy}
              onClick={() => read(e)}
              className={
                "flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors hover:border-indigo-200 " +
                (e.read_at
                  ? "border-slate-200 bg-white"
                  : "border-indigo-100 bg-indigo-50/40")
              }
            >
              <span
                className={
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
                  (e.read_at ? "bg-slate-200" : "bg-indigo-500")
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-slate-700">
                  {e.title}
                </span>
                <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-slate-600">
                  {e.task}
                </span>
                {["mentioned", "dependency", "support-request"].includes(
                  e.kind,
                ) && (
                  <span className="mt-2 block whitespace-pre-wrap break-words rounded-lg bg-white/80 px-3 py-2 text-xs text-slate-500">
                    {e.message}
                  </span>
                )}
                {["due-soon", "overdue"].includes(e.kind) && (
                  <span className="mt-1 block text-xs text-amber-600">
                    {e.message}
                  </span>
                )}
                <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-slate-400">
                  <span>{e.project_name}</span>
                  <span>
                    {e.actor_name ? e.actor_name + " · " : ""}
                    {new Date(e.created).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false,
                    })}
                  </span>
                  {Boolean(e.task_deleted) && <span>任务已删除</span>}
                </span>
              </span>
              <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300" />
            </button>
          ))}
        </div>
        {!entries.length && !busy && !error && (
          <div className="rounded-2xl bg-slate-50 py-14 text-center">
            <Bell className="mx-auto h-7 w-7 text-slate-300" />
            <p className="mt-3 text-sm text-slate-400">
              {onlyUnread ? "暂时没有未读提醒" : "暂时没有站内提醒"}
            </p>
          </div>
        )}
        {busy && (
          <p className="py-4 text-center text-xs text-slate-400">
            正在加载提醒…
          </p>
        )}
        {cursor && (
          <button
            disabled={busy || saving}
            onClick={() => load(cursor)}
            className={secondary + " mt-4 w-full"}
          >
            加载更早提醒
          </button>
        )}
        <p className="mt-5 text-center text-[11px] text-slate-400">
          提醒仅自己可见 · 约每 30 秒同步 · 临期按北京时间今明两天计算
        </p>
      </section>
    </Modal>
  );
}
