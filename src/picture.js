import {
  statistics,
  personSummary,
  completionDateLabel,
  isCompleted,
  priorityOf,
  coordinationText,
} from "./model.js";
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function exportPicture({
  project,
  records,
  mode = "records",
  filterLabel,
}) {
  await document.fonts.ready;
  if (mode !== "overview" && records.length > 250)
    throw new Error("单张图片最多导出 250 条，请按成员或日期筛选后分批导出");
  const canvas = document.createElement("canvas"),
    ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片导出");
  const W = 1440,
    pad = 60,
    x = [60, 670, 880, 1180],
    widths = [560, 170, 240, 190];
  function font(size, weight = 400) {
    ctx.font =
      weight + " " + size + 'px "Microsoft YaHei","PingFang SC",sans-serif';
  }
  function wrap(text, max) {
    const lines = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const char of para) {
        if (line && ctx.measureText(line + char).width > max) {
          lines.push(line);
          line = char;
        } else line += char;
      }
      lines.push(line);
    }
    return lines;
  }
  font(24, 600);
  const projectLines = wrap(project, 1280);
  font(20);
  const filterLines = wrap(filterLabel, 1280);
  const headHeight = 160 + projectLines.length * 36 + filterLines.length * 30;
  font(21);
  const stats = statistics(records);
  let entries = records;
  if (mode === "people")
    entries = personSummary(records).flatMap((p) => [
      {
        group:
          p.name +
          " · 实际完成 " +
          p.done +
          " 项 / 原定负责 " +
          p.owned +
          " 项" +
          (p.pending ? " / 未完成 " + p.pending + " 项" : "") +
          (p.unassigned ? " / 完成人未填 " + p.unassigned + " 项" : ""),
      },
      ...p.records,
    ]);
  if (mode === "overview") entries = [];
  const rows = entries.map((r) => {
    if (r.group) return { group: r.group, height: 66 };
    font(21);
    const lines = [
      r.task +
        "\n优先级：" +
        priorityOf(r.priority).label +
        (r.due_date ? " · 计划：" + r.due_date : "") +
        (coordinationText(r) ? "\n" + coordinationText(r) : ""),
      r.owner,
      r.actual || "—",
      completionDateLabel(r),
    ].map((v, i) => wrap(v, widths[i]));
    return {
      lines,
      pending: !isCompleted(r),
      height: Math.max(86, ...lines.map((a) => a.length * 31 + 40)),
    };
  });
  const hasTable = mode !== "overview";
  const H =
    headHeight +
    190 +
    (hasTable ? 64 + rows.reduce((n, r) => n + r.height, 0) : 30) +
    150;
  if (H > 30000) throw new Error("内容过长，请缩小筛选范围后导出");
  canvas.width = W;
  canvas.height = H;
  ctx.fillStyle = "#f6f7f9";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, headHeight);
  grad.addColorStop(0, "#0c1322");
  grad.addColorStop(1, "#1b2a4a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headHeight);
  font(24, 600);
  ctx.fillStyle = "#a5b4fc";
  projectLines.forEach((l, i) => ctx.fillText(l, pad, 58 + i * 36));
  const titleY = 108 + (projectLines.length - 1) * 36;
  ctx.fillStyle = "#fff";
  font(36, 700);
  ctx.fillText(
    "工作完成记录" +
      (mode === "people"
        ? " · 按人汇总"
        : mode === "overview"
          ? " · 统计概览"
          : ""),
    pad,
    titleY,
  );
  font(20);
  ctx.fillStyle = "#94a3b8";
  filterLines.forEach((l, i) => ctx.fillText(l, pad, titleY + 44 + i * 30));
  const metricY = headHeight + 28,
    gap = 18,
    cw = (W - 2 * pad - gap * 3) / 4;
  const metrics = [
    ["完成记录", stats.total + " 项", "#6366f1"],
    ["参与成员", stats.people + " 人", "#10b981"],
    ["活跃天数", stats.days + " 天", "#0ea5e9"],
    ["他人完成占比", stats.otherPct + "%", "#f59e0b"],
  ];
  for (let i = 0; i < 4; i++) {
    const left = pad + i * (cw + gap);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.roundRect(left, metricY, cw, 128, 16);
    ctx.fill();
    ctx.strokeStyle = "#e2e8f0";
    ctx.stroke();
    ctx.fillStyle = metrics[i][2];
    ctx.beginPath();
    ctx.arc(left + 25, metricY + 31, 4, 0, Math.PI * 2);
    ctx.fill();
    font(18);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(metrics[i][0], left + 40, metricY + 38);
    font(32, 700);
    ctx.fillStyle = "#0f172a";
    ctx.fillText(metrics[i][1], left + 24, metricY + 91);
  }
  let y = headHeight + 190;
  if (hasTable) {
    ctx.fillStyle = "#edf0f6";
    ctx.fillRect(pad - 16, y, W - 2 * pad + 32, 64);
    font(19, 500);
    ctx.fillStyle = "#94a3b8";
    ["工作事项", "原定负责人", "实际完成人", "完成日期"].forEach((v, i) =>
      ctx.fillText(v, x[i], y + 40),
    );
    y += 64;
    for (const row of rows) {
      if (row.group) {
        ctx.fillStyle = "#eef2ff";
        ctx.fillRect(pad - 16, y, W - 2 * pad + 32, row.height);
        font(22, 600);
        ctx.fillStyle = "#4f46e5";
        ctx.fillText(row.group, pad, y + 42);
        y += row.height;
        continue;
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(pad - 16, y, W - 2 * pad + 32, row.height);
      row.lines.forEach((lines, i) => {
        font(i === 3 ? 19 : 21, i === 0 || i === 2 ? 500 : 400);
        ctx.fillStyle =
          i === 3 && row.pending
            ? "#b45309"
            : i === 2
              ? "#4f46e5"
              : i === 0
                ? "#1e293b"
                : "#64748b";
        lines.forEach((l, j) => ctx.fillText(l, x[i], y + 43 + j * 31));
      });
      y += row.height;
      ctx.strokeStyle = "#f1f5f9";
      ctx.beginPath();
      ctx.moveTo(pad - 16, y);
      ctx.lineTo(W - pad + 16, y);
      ctx.stroke();
    }
  }
  font(17);
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(
    "实际完成人或完成日期任填一项即为完成，两项都空为未完成；共同完成在每位参与者名下各计 1 项。",
    pad,
    H - 88,
  );
  font(16);
  ctx.fillText(
    "共 " +
      records.length +
      " 条记录 · " +
      new Date().toLocaleDateString("zh-CN") +
      " 导出",
    pad,
    H - 47,
  );
  ctx.textAlign = "right";
  ctx.fillText("原定谁负责，实际谁完成。", W - pad, H - 47);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("图片生成失败，请缩小筛选范围后重试");
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename:
      project.replace(/[\\/:*?"<>|]/g, "_") +
      "-" +
      (mode === "people"
        ? "按人汇总"
        : mode === "overview"
          ? "统计概览"
          : "工作完成记录") +
      ".png",
  };
}
