export const LOG_ACTIONS = {
  "create-record": "新增记录",
  "update-record": "修改记录",
  "delete-record": "删除记录",
  "restore-record": "撤销删除",
  "create-project": "新建项目",
  "update-project": "修改项目设置",
  "rename-project": "修改项目名称",
  "create-comment": "发表评论",
  "update-comment": "修改评论",
  "delete-comment": "删除评论",
};
export const LOG_FIELDS = {
  task: "工作事项",
  owner: "原定负责人",
  actual: "实际完成人",
  date: "完成日期",
  due_date: "计划完成日期",
  priority: "优先级",
  name: "项目名称",
  color: "标识色",
  members: "常用成员",
  body: "评论内容",
  parent_task: "上级任务",
  dependency_titles: "前置任务",
  blocked: "手动阻塞",
  blocker_note: "阻塞说明",
  support_people: "配合人员",
};
export function logChanges(entry) {
  const keys =
    entry.entityType === "project"
      ? ["name", "color", "members"]
      : entry.entityType === "comment"
        ? ["body"]
        : [
            "task",
            "owner",
            "actual",
            "due_date",
            "priority",
            "date",
            "parent_task",
            "dependency_titles",
            "blocked",
            "blocker_note",
            "support_people",
          ];
  const before = entry.action === "restore-record" ? {} : entry.before || {},
    after =
      entry.after ||
      (entry.action === "restore-record" ? entry.before || {} : {});
  return keys
    .filter((key) => key in before || key in after)
    .filter(
      (key) =>
        !entry.before ||
        !entry.after ||
        JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((key) => ({
      key,
      label: LOG_FIELDS[key],
      before: before[key],
      after: after[key],
    }));
}
export function logTitle(entry) {
  return (
    entry.after?.task ||
    entry.before?.task ||
    entry.after?.name ||
    entry.before?.name ||
    "历史内容"
  );
}
