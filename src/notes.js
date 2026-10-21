export const NOTE_KINDS = [
  {
    id: "site",
    label: "现场设置",
    hint: "例如：3 号柜交换机 IP 改为 192.168.1.20（原 .10）",
  },
  {
    id: "verbal",
    label: "口头约定",
    hint: "谁说的、什么时候、说了什么，例如：客户张工电话确认报表按月汇总",
  },
  {
    id: "file",
    label: "文件转存",
    hint: "群里或邮件收到的文件，说明这是什么、谁发的",
  },
  { id: "other", label: "其他", hint: "其他需要留档的信息" },
];
export const noteKind = (id) =>
  NOTE_KINDS.find((kind) => kind.id === id) || NOTE_KINDS[3];
