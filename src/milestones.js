export const MILESTONE_STATUSES = [
  { id: "planned", label: "未开始" },
  { id: "in_progress", label: "进行中" },
  { id: "achieved", label: "已达成" },
  { id: "cancelled", label: "已取消" },
];
export const milestoneStatus = (id) =>
  MILESTONE_STATUSES.find((s) => s.id === id)?.label || id;
