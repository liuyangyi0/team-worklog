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
    label: "文件收发",
    hint: "记录收到或发出的文件、往来方与收发时间，附件可选",
  },
  { id: "other", label: "其他", hint: "其他需要留档的信息" },
];
export const noteKind = (id) =>
  NOTE_KINDS.find((kind) => kind.id === id) || NOTE_KINDS[3];

export const FILE_DIRECTIONS = [
  { id: "received", label: "收到" },
  { id: "sent", label: "发出" },
];
export const fileDirection = (id) =>
  FILE_DIRECTIONS.find((direction) => direction.id === id) || null;
export const fileDirectionLabel = (id) =>
  fileDirection(id)?.label || "未区分收发";
