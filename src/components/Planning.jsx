import React from "react";
import { Flag, CalendarClock } from "lucide-react";
import { priorityOf, dueState } from "../model.js";
export function PriorityBadge({ value }) {
  const p = priorityOf(value);
  return (
    <span
      title={"优先级：" + p.label}
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset " +
        p.className
      }
    >
      <Flag className="h-2.5 w-2.5" />
      {p.label}
    </span>
  );
}
export function DueBadge({ record }) {
  if (!record.due_date) return null;
  const state = dueState(record),
    label = { overdue: "已逾期", today: "今日到期", soon: "明日到期" }[state];
  return (
    <span
      title={"计划完成日期：" + record.due_date}
      className={
        "inline-flex flex-wrap items-center gap-1 rounded-full px-2 py-0.5 text-[10px] " +
        (state === "overdue"
          ? "bg-rose-50 text-rose-600"
          : label
            ? "bg-amber-50 text-amber-600"
            : "bg-slate-100 text-slate-500")
      }
    >
      <CalendarClock className="h-3 w-3" />
      <span>
        计划 <time dateTime={record.due_date}>{record.due_date}</time>
        {label ? " · " + label : ""}
      </span>
    </span>
  );
}
