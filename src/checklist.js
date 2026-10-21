// Shared by the server (applying templates) and the browser (labels, grouping).
export const STAGES = ["立项", "方案", "实施", "验收", "交付", "全过程"];
export const PROJECT_KINDS = [
  { id: "software", label: "软件项目资料" },
  { id: "equipment", label: "设备项目资料" },
  { id: "both", label: "软硬件项目资料" },
];
// scope: which project kinds an item applies to; "all" applies to every kind.
export const STARTER_CHECKLIST = [
  {
    title: "合同 / 技术协议",
    stage: "立项",
    scope: "all",
    required: true,
    hint: "签订版扫描件或盖章 PDF",
  },
  {
    title: "客户联系人与需求确认",
    stage: "立项",
    scope: "all",
    required: true,
    hint: "联系人、电话，以及双方确认过的需求范围",
  },
  { title: "方案设计 / 网络规划", stage: "方案", scope: "all" },
  {
    title: "设备清单",
    stage: "实施",
    scope: "equipment",
    required: true,
    hint: "型号、序列号、数量和安装位置",
  },
  {
    title: "现场配置记录",
    stage: "实施",
    scope: "all",
    required: true,
    hint: "IP、参数、改了什么；可以直接用随手记记录",
  },
  { title: "接线与安装图、现场照片", stage: "实施", scope: "equipment" },
  { title: "部署手册", stage: "实施", scope: "software", required: true },
  { title: "数据库脚本与运行配置", stage: "实施", scope: "software" },
  { title: "测试记录", stage: "验收", scope: "all" },
  {
    title: "验收单（客户签字）",
    stage: "验收",
    scope: "all",
    required: true,
  },
  { title: "操作 / 运维手册", stage: "交付", scope: "all", required: true },
  {
    title: "账号与访问方式",
    stage: "交付",
    scope: "all",
    required: true,
    hint: "密码存入“资源与配置”的加密账号库，这里说明在哪里、怎么登录",
  },
  { title: "遗留问题清单", stage: "交付", scope: "all" },
  {
    title: "会议纪要与关键决定",
    stage: "全过程",
    scope: "all",
    hint: "口头约定也请用随手记记下：谁说的、什么时候、说了什么",
  },
];
export function starterItems(kind) {
  return STARTER_CHECKLIST.filter(
    (item) => item.scope === "all" || kind === "both" || item.scope === kind,
  ).map(({ title, stage, required = false, hint = "" }) => ({
    title,
    stage,
    required,
    hint,
  }));
}
// Anything on file counts as provided; only an empty applicable item is missing.
export const PROVIDED = ["ready", "draft", "recorded"];
export function checklistProgress(items) {
  const required = items.filter((item) => item.applicable && item.required);
  const missing = required.filter((item) => !PROVIDED.includes(item.status));
  return {
    required: required.length,
    provided: required.length - missing.length,
    missing: missing.length,
    unpublished: required.filter((item) => item.status === "draft").length,
  };
}
