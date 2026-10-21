import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  X,
  Check,
  CheckCircle2,
  Users,
  CalendarDays,
  TrendingUp,
  Plus,
} from "lucide-react";
import { personStyle, statistics, monthLabel, isCompleted } from "../model.js";
export const primary =
  "inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-b from-indigo-500 to-indigo-600 px-4 py-2 text-[13px] font-medium text-white shadow-lg shadow-indigo-600/25 transition-all hover:shadow-xl hover:shadow-indigo-600/30 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
export const secondary =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-600 shadow-sm transition-all hover:border-slate-300 hover:shadow active:scale-[0.98] disabled:opacity-40";
export const inputClass =
  "w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-sm text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-100";
export function AvatarChip({ name }) {
  const s = personStyle(name);
  return (
    <span
      className="person-chip inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs font-medium"
      style={{
        background: s.bg,
        color: s.text,
        boxShadow: "0 0 0 1px " + s.ring,
      }}
    >
      <span className="person-letter flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/70 text-[10px] font-semibold">
        {name[0]}
      </span>
      <span className="break-words">{name}</span>
    </span>
  );
}
export function DateBadge({ date, actual }) {
  if (!date)
    return isCompleted({ date, actual }) ? null : (
      <span
        className="inline-flex whitespace-nowrap rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200/70"
        title="实际完成人和完成日期均未填写"
      >
        未完成
      </span>
    );
  const [, m, d] = date.split("-");
  return (
    <div className="date-badge flex items-center gap-3" title={date}>
      <div className="date-tile flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-slate-100 ring-1 ring-slate-200/70">
        <span className="text-sm font-bold leading-none text-slate-800">
          {Number(d)}
        </span>
        <span className="mt-0.5 text-[10px] leading-none text-slate-400">
          {Number(m)}月
        </span>
      </div>
      <time
        dateTime={date}
        className="whitespace-nowrap text-sm text-slate-500"
      >
        {Number(m)}月{Number(d)}日
      </time>
    </div>
  );
}
export function Modal({
  title,
  sub,
  icon: Icon = Plus,
  tone = "indigo",
  onClose,
  wide = false,
  children,
}) {
  const ref = useRef(null),
    id = useId();
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={
        "wb-dialog animate-dialog w-full overflow-y-auto rounded-3xl bg-white p-0 shadow-[0_32px_80px_-16px_rgba(15,23,42,0.35)] ring-1 ring-slate-900/5 " +
        (wide ? "max-w-[880px]" : "max-w-[480px]")
      }
    >
      <div className="relative px-6 pb-5 pt-6">
        <div className="flex items-start gap-3.5">
          <div
            className={
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg " +
              (tone === "rose"
                ? "from-rose-500 to-rose-600 shadow-rose-500/30"
                : "from-indigo-500 to-indigo-600 shadow-indigo-500/30")
            }
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 pt-0.5">
            <h2
              id={id}
              className="text-[17px] font-bold tracking-tight text-slate-900"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="ml-auto rounded-full p-1.5 text-slate-400 transition-all hover:rotate-90 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      {children}
    </dialog>
  );
}
export function Popover({ anchor, onClose, width = 240, children }) {
  const ref = useRef(null),
    [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.current || !ref.current) return;
      const a = anchor.current.getBoundingClientRect(),
        r = ref.current.getBoundingClientRect();
      setPos({
        left: Math.max(12, Math.min(a.left, innerWidth - r.width - 12)),
        top:
          a.bottom + 8 + r.height < innerHeight - 12
            ? a.bottom + 8
            : Math.max(12, a.top - r.height - 8),
      });
    };
    place();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const outside = (e) => {
      if (
        !ref.current?.contains(e.target) &&
        !anchor.current?.contains(e.target)
      )
        onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      style={{
        width: Math.min(width, innerWidth - 24),
        left: pos?.left || 12,
        top: pos?.top || 12,
        visibility: pos ? "visible" : "hidden",
      }}
      className="animate-pop fixed z-40 max-h-[75dvh] origin-top-left overflow-y-auto rounded-2xl bg-white shadow-[0_16px_48px_-12px_rgba(15,23,42,0.25)] ring-1 ring-slate-900/5"
    >
      {children}
    </div>,
    document.body,
  );
}
export function Field({ label, children, hint }) {
  const generatedId = useId();
  const id = children.props.id || generatedId;
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-[13px] font-medium text-slate-600"
      >
        {label}
      </label>
      {React.cloneElement(children, { id })}
      {hint && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{hint}</p>
      )}
    </div>
  );
}
export function FormError({ error, onReload }) {
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  if (!error) return null;
  const canReload = onReload && [404, 409].includes(error.status);
  return (
    <div
      role="alert"
      className="mx-6 mb-1 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-600"
    >
      <p>{error.message || error}</p>
      {canReload && (
        <>
          <p className="mt-1">载入最新内容会替换当前尚未保存的输入。</p>
          <button
            type="button"
            disabled={reloading}
            className="mt-2 rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-medium disabled:opacity-50"
            onClick={async () => {
              setReloading(true);
              setReloadError("");
              try {
                await onReload();
              } catch (e) {
                setReloadError(e.message);
              } finally {
                setReloading(false);
              }
            }}
          >
            {reloading ? "载入中…" : "载入最新内容"}
          </button>
        </>
      )}
      {reloadError && <p className="mt-1">{reloadError}</p>}
    </div>
  );
}
export function FormActions({
  onClose,
  busy,
  label = "保存",
  disabled = false,
}) {
  return (
    <div className="flex items-center justify-end gap-2.5 px-6 py-5">
      <button
        type="button"
        onClick={onClose}
        className="rounded-xl px-4 py-2 text-[13px] font-medium text-slate-500 transition-colors hover:bg-slate-100"
      >
        取消
      </button>
      <button type="submit" disabled={busy || disabled} className={primary}>
        {busy ? "保存中…" : label}
      </button>
    </div>
  );
}
export function PersonPicker({
  label,
  hint,
  selected,
  onChange,
  people,
  multi = false,
}) {
  const [custom, setCustom] = useState(""),
    [added, setAdded] = useState([]);
  const names = [...new Set([...people, ...added, ...selected])];
  function toggle(name) {
    onChange(
      multi
        ? selected.includes(name)
          ? selected.filter((n) => n !== name)
          : [...selected, name]
        : [name],
    );
  }
  function add() {
    const n = custom.trim();
    if (!n || n.length > 30) return;
    setAdded((a) => [...new Set([...a, n])]);
    if (!selected.includes(n)) onChange(multi ? [...selected, n] : [n]);
    setCustom("");
  }
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium text-slate-600">
        {label}
      </legend>
      {hint && <p className="mb-2 text-xs text-slate-400">{hint}</p>}
      <div className="max-h-36 overflow-y-auto p-0.5">
        <div className="flex flex-wrap gap-2">
          {names.map((name) => {
            const active = selected.includes(name),
              s = personStyle(name);
            return (
              <button
                type="button"
                key={name}
                aria-pressed={active}
                onClick={() => toggle(name)}
                className="flex items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 text-[13px] font-medium transition-all active:scale-95"
                style={{
                  background: active ? s.bg : "#f8fafc",
                  color: active ? s.text : "#64748b",
                  boxShadow:
                    "0 0 0 " +
                    (active ? "2px " : "1px ") +
                    (active ? s.ring : "#e2e8f0"),
                }}
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: active ? s.dot : "#cbd5e1" }}
                >
                  {active && multi ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    name[0]
                  )}
                </span>
                {name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <input
          aria-label={label + "添加姓名"}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="输入新姓名"
          maxLength={30}
          className={inputClass}
        />
        <button
          type="button"
          disabled={!custom.trim()}
          onClick={add}
          className={secondary + " shrink-0 px-3"}
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
    </fieldset>
  );
}
export function Stats({ records, month, previousCount = null }) {
  const s = statistics(records);
  const diff = previousCount === null ? null : s.total - previousCount;
  const items = [
    {
      icon: CheckCircle2,
      label: month && month !== "none" ? "本月完成" : "完成记录",
      value: s.total + " 项",
      sub:
        diff === null
          ? s.pending
            ? "另有未完成 " + s.pending + " 项"
            : "按当前筛选统计"
          : "较上月 " + (diff >= 0 ? "+" : "") + diff,
      accent: "bg-indigo-500",
    },
    {
      icon: Users,
      label: "参与成员",
      value: s.people + " 人",
      sub: "共同完成可填多人",
      accent: "bg-emerald-500",
    },
    {
      icon: CalendarDays,
      label: "活跃天数",
      value: s.days + " 天",
      sub: s.latest
        ? "最近：" +
          monthLabel(s.latest.slice(0, 7)) +
          Number(s.latest.slice(8)) +
          "日"
        : s.undated
          ? "已完成，未填日期 " + s.undated + " 条"
          : s.pending
            ? "未完成 " + s.pending + " 条"
            : "暂无完成日期",
      accent: "bg-sky-500",
    },
    {
      icon: TrendingUp,
      label: "他人完成占比",
      value: s.otherPct + "%",
      sub: "原负责人未参与 " + s.other + " 项",
      accent: "bg-amber-500",
    },
  ];
  return (
    <div className="stats-grid mt-7 grid grid-cols-4 gap-4">
      {items.map(({ icon: Icon, label, value, sub, accent }) => (
        <div
          key={label}
          className="group relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(15,23,42,0.18)]"
        >
          <div
            className={
              "absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-[0.07] " +
              accent
            }
          />
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Icon className="h-3.5 w-3.5" />
            {label}
          </div>
          <div className="mt-2.5 text-2xl font-bold tracking-tight text-slate-900">
            {value}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-slate-400">
            {sub}
          </div>
        </div>
      ))}
    </div>
  );
}
