import React from "react";
import { fileDirectionLabel } from "../notes.js";

// Safe presentation of file exchanges. Registration time is never a fallback
// for a missing business date or a missing minute of the exchange.
export default function NoteExchange({ note, className = "" }) {
  if (note?.kind !== "file") return null;
  const direction = note.file_direction || "";
  const partyLabel =
    direction === "received"
      ? "提供方"
      : direction === "sent"
        ? "接收方"
        : "往来方";
  const timeLabel =
    direction === "received"
      ? "收到时间"
      : direction === "sent"
        ? "发出时间"
        : "业务时间";
  const businessTime = note.occurred_on
    ? note.occurred_on +
      (note.exchange_time
        ? " " + note.exchange_time + "（北京时间）"
        : "（未记录具体时间）")
    : "未记录";
  return (
    <div
      aria-label="文件收发信息"
      className={
        "mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs leading-relaxed text-slate-500 " +
        className
      }
    >
      <span
        className={
          "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 " +
          (direction === "received"
            ? "bg-sky-50 text-sky-600 ring-sky-100"
            : direction === "sent"
              ? "bg-emerald-50 text-emerald-600 ring-emerald-100"
              : "bg-slate-100 text-slate-500 ring-slate-200")
        }
      >
        {fileDirectionLabel(direction)}
      </span>
      <span className="min-w-0 break-words">
        {partyLabel}：{note.counterparty || "未记录"}
      </span>
      <span className="min-w-0 break-words">
        {timeLabel}：{businessTime}
      </span>
      <span className="min-w-0 break-words">
        渠道：{note.channel || "未记录"}
      </span>
    </div>
  );
}
