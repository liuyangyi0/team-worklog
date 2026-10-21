import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  Download,
  File,
  FileArchive,
  FileText,
  Folder,
  FolderPlus,
  History,
  Link2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api.js";
import {
  cancelUpload,
  displayTime,
  fileSize,
  internalDownload,
  uploadFile,
} from "../library-api.js";
import {
  Field,
  FormActions,
  FormError,
  Modal,
  inputClass,
  primary,
  secondary,
} from "./UI.jsx";

const card =
  "rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const smallButton =
  "inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-40";
const categories = [
  "方案设计",
  "安装部署",
  "联调测试",
  "验收交付",
  "运维资料",
  "会议纪要",
  "其他",
];
const workingId = (doc) => doc.current_version_id || doc.working_version_id;
const dateValue = (obj) => obj?.created_at || obj?.created;
export function InternalLogin({ onLogin, label = "项目资料" }) {
  return (
    <div
      className={
        card +
        " flex min-h-80 flex-col items-center justify-center px-6 py-14 text-center"
      }
    >
      <div className="mb-4 rounded-2xl bg-indigo-50 p-4 text-indigo-500">
        <LockKeyhole size={28} />
      </div>
      <h2 className="text-lg font-semibold text-slate-800">
        登录后查看{label}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
        项目内部资料向所有已注册成员开放，查看和修改均保留操作记录。
      </p>
      <button onClick={onLogin} className={primary + " mt-5"}>
        登录 / 注册
      </button>
    </div>
  );
}
export default function ProjectLibrary(props) {
  if (!props.user) return <InternalLogin onLogin={props.onLogin} />;
  return (
    <LibrarySession key={props.project.id + ":" + props.user.id} {...props} />
  );
}
function LibrarySession({ project, user, records = [] }) {
  const [data, setData] = useState({ folders: [], documents: [] });
  const [folderId, setFolderId] = useState(null),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [trash, setTrash] = useState(false);
  const [error, setError] = useState(null),
    [loaded, setLoaded] = useState(false),
    [modal, setModal] = useState(null),
    [selected, setSelected] = useState(() => {
      const params = new URLSearchParams(location.search);
      return params.get("project") === project.id
        ? params.get("document")
        : null;
    }),
    [notice, setNotice] = useState("");
  const active = useRef(true),
    request = useRef(0);
  useEffect(
    () => () => {
      active.current = false;
      request.current++;
    },
    [],
  );
  async function load() {
    const token = ++request.current;
    try {
      const next = await api(
        "/projects/" + project.id + "/documents" + (trash ? "?deleted=1" : ""),
      );
      if (active.current && token === request.current) {
        setData(next);
        setError(null);
        setLoaded(true);
      }
    } catch (e) {
      if (active.current && token === request.current) {
        setError(e);
        setLoaded(true);
      }
    }
  }
  useEffect(() => {
    setLoaded(false);
    load();
  }, [trash]);
  const folders = data.folders || [],
    documents = data.documents || [];
  const selectedFolder = folders.find((f) => f.id === folderId);
  const crumbs = [];
  let cursor = selectedFolder;
  const visited = new Set();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    crumbs.unshift(cursor);
    cursor = folders.find((f) => f.id === cursor.parent_id);
  }
  const filtered = documents.filter(
    (d) =>
      (query || category || trash || (d.folder_id || null) === folderId) &&
      (!category || d.category === category) &&
      (!query ||
        [
          d.title,
          d.filename,
          d.description,
          d.owner,
          d.category,
          ...(d.tags || []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const children = folders.filter((f) => (f.parent_id || null) === folderId);
  async function mutate(route, method, body) {
    try {
      await api(route, method, body);
      await load();
      setNotice("已保存，操作已记录");
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            项目资料
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            集中查找、保留版本，让最新工作版与正式交付版清楚可见。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondary}
            onClick={() => setModal({ type: "releases" })}
          >
            <FileArchive size={15} />
            交付归档
          </button>
          <button
            className={secondary}
            onClick={() => setModal({ type: "folder" })}
            disabled={trash}
          >
            <FolderPlus size={15} />
            新建目录
          </button>
          <button
            className={primary}
            onClick={() => setModal({ type: "upload" })}
            disabled={trash}
          >
            <Upload size={15} />
            上传资料
          </button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            FileText,
            "文档资料",
            documents.length + " 份",
            "保留原件与每次更新",
          ],
          [
            ShieldCheck,
            "已有正式版",
            documents.filter((d) => d.published_version_id).length + " 份",
            "上传更新不会替换正式版",
          ],
          [History, "版本记录", "可追溯", "旧版可恢复，操作有记录"],
        ].map(([Icon, title, count, hint]) => (
          <div
            className={card + " flex items-center gap-3 px-4 py-4"}
            key={title}
          >
            <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-500">
              <Icon size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-400">{title}</p>
              <p className="mt-1 text-lg font-bold text-slate-800">{count}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>
            </div>
          </div>
        ))}
      </div>
      {notice && (
        <div
          role="status"
          className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3 text-xs text-emerald-700"
        >
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {error && (
        <div
          className="rounded-xl bg-rose-50 p-3 text-sm text-rose-600"
          role="alert"
        >
          {error.message}
          <button className="ml-3 underline" onClick={load}>
            重试
          </button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className={card + " self-start p-3"}>
          <p className="px-3 py-2 text-xs font-medium text-slate-400">
            资料目录
          </p>
          <button
            onClick={() => {
              setFolderId(null);
              setTrash(false);
              setQuery("");
            }}
            className={
              "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm " +
              (!folderId && !trash
                ? "bg-indigo-50 font-medium text-indigo-600"
                : "text-slate-500 hover:bg-slate-50")
            }
          >
            <Folder size={16} />
            项目根目录
          </button>
          <FolderTree
            folders={folders}
            parent={null}
            selected={trash ? undefined : folderId}
            onSelect={(id) => {
              setFolderId(id);
              setTrash(false);
              setQuery("");
            }}
          />
          <div className="my-3 border-t border-slate-100" />
          <button
            onClick={() => setTrash(true)}
            className={
              "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm " +
              (trash
                ? "bg-rose-50 text-rose-600"
                : "text-slate-400 hover:bg-slate-50")
            }
          >
            <Trash2 size={16} />
            回收站
          </button>
          <p className="px-3 pb-2 pt-3 text-[11px] leading-relaxed text-slate-400">
            回收站保留历史，操作日志不可删除。
          </p>
        </aside>
        <div className={card + " min-w-0 overflow-hidden"}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
            <nav
              aria-label="资料路径"
              className="flex flex-wrap items-center gap-1 text-xs text-slate-400"
            >
              <button
                onClick={() => {
                  setFolderId(null);
                  setTrash(false);
                }}
                className="hover:text-indigo-600"
              >
                项目资料
              </button>
              {trash ? (
                <>
                  <ChevronRight size={13} />
                  <span>回收站</span>
                </>
              ) : (
                crumbs.map((f) => (
                  <React.Fragment key={f.id}>
                    <ChevronRight size={13} />
                    <button
                      onClick={() => setFolderId(f.id)}
                      className="hover:text-indigo-600"
                    >
                      {f.name}
                    </button>
                  </React.Fragment>
                ))
              )}
            </nav>
            <div className="flex gap-2">
              <div className="relative">
                <Search
                  size={15}
                  className="absolute left-3 top-2.5 text-slate-300"
                />
                <input
                  aria-label="搜索资料"
                  placeholder="名称、标签、维护人…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className={inputClass + " max-w-60 py-2 pl-9 text-xs"}
                />
              </div>
              <select
                aria-label="资料分类"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={inputClass + " w-auto py-2 text-xs"}
              >
                <option value="">全部分类</option>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          {!trash && !query && !category && children.length > 0 && (
            <div className="grid grid-cols-2 gap-2 border-b border-slate-100 p-4 sm:grid-cols-3">
              {children.map((f) => (
                <div
                  key={f.id}
                  className="group flex min-w-0 items-center gap-2 rounded-xl border border-slate-100 p-3 hover:bg-slate-50"
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-slate-600"
                    onClick={() => setFolderId(f.id)}
                  >
                    <Folder size={19} className="shrink-0 text-amber-400" />
                    <span className="truncate">{f.name}</span>
                  </button>
                  <button
                    aria-label={"编辑目录 " + f.name}
                    onClick={() => setModal({ type: "folder", folder: f })}
                    className="rounded-md p-1 text-slate-300 hover:bg-white hover:text-indigo-500"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[660px] text-left text-sm">
              <thead className="bg-slate-50/70 text-xs text-slate-400">
                <tr>
                  <th className="px-5 py-3.5 font-medium">文档名称</th>
                  <th className="px-3 py-3.5 font-medium">工作版 / 正式版</th>
                  <th className="px-3 py-3.5 font-medium">维护人</th>
                  <th className="px-3 py-3.5 font-medium">更新</th>
                  <th className="w-20 px-4 py-3.5 text-right font-medium">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((doc) => (
                  <tr key={doc.id} className="transition hover:bg-slate-50/60">
                    <td className="max-w-80 px-5 py-4">
                      <button
                        onClick={() => setSelected(doc.id)}
                        className="flex w-full min-w-0 items-start gap-3 text-left"
                      >
                        <span className="mt-0.5 rounded-xl bg-indigo-50 p-2 text-indigo-400">
                          <FileText size={18} />
                        </span>
                        <span className="min-w-0">
                          <span className="block break-words font-medium text-slate-700 hover:text-indigo-600">
                            {doc.title}
                          </span>
                          <span className="mt-1 block text-[11px] text-slate-400">
                            {doc.category || "未分类"} ·{" "}
                            {fileSize(doc.size || doc.current_version?.size)}
                            {doc.checkout ? " · 有人正在修改" : ""}
                          </span>
                          {(doc.tags || []).length > 0 && (
                            <span className="mt-1.5 flex flex-wrap gap-1">
                              {doc.tags.map((t) => (
                                <span
                                  key={t}
                                  className="rounded-md bg-slate-100 px-1.5 text-[10px] text-slate-400"
                                >
                                  {t}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-4 text-xs">
                      <p className="text-slate-500">
                        工作版 V
                        {doc.current_version?.number ||
                          doc.current_version_number ||
                          "1"}
                      </p>
                      <p
                        className={
                          "mt-1.5 " +
                          (doc.published_version_id
                            ? "text-emerald-600"
                            : "text-slate-300")
                        }
                      >
                        {doc.published_version_id
                          ? "正式版 V" +
                            (doc.published_version?.number ||
                              doc.published_version_number ||
                              "—")
                          : "尚未发布"}
                      </p>
                    </td>
                    <td className="px-3 py-4 text-xs text-slate-500">
                      {doc.owner ||
                        doc.updated_by_name ||
                        doc.created_by_name ||
                        "—"}
                    </td>
                    <td className="px-3 py-4 text-[11px] text-slate-400">
                      {displayTime(
                        doc.updated_at || doc.updated || dateValue(doc),
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <button
                        className={smallButton}
                        aria-label={"管理 " + doc.title}
                        onClick={() => setSelected(doc.id)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!loaded || !filtered.length) && (
            <div className="flex flex-col items-center gap-2 px-5 py-12 text-sm text-slate-400">
              <File size={28} className="text-slate-200" />
              <p>
                {!loaded
                  ? "正在载入资料…"
                  : trash
                    ? "回收站暂无文件"
                    : query || category
                      ? "没有找到符合条件的资料"
                      : "这个目录还没有资料"}
              </p>
              {loaded && !trash && !query && !category && (
                <button
                  className={smallButton}
                  onClick={() => setModal({ type: "upload" })}
                >
                  上传第一份资料
                </button>
              )}
            </div>
          )}
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
            共 {filtered.length} 份资料
            {query || category ? " · 跨目录搜索" : ""}
          </div>
        </div>
      </div>
      {modal?.type === "folder" && (
        <FolderEditor
          folder={modal.folder}
          folders={folders}
          projectId={project.id}
          parentId={folderId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal?.type === "upload" && (
        <UploadDialog
          projectId={project.id}
          userId={user.id}
          folders={folders}
          documents={documents}
          folderId={folderId}
          onClose={() => {
            setModal(null);
            load();
          }}
          onSaved={load}
        />
      )}
      {modal?.type === "releases" && (
        <ReleaseDialog
          projectId={project.id}
          documents={documents}
          onClose={() => setModal(null)}
        />
      )}
      {selected && (
        <DocumentDetail
          key={selected}
          id={selected}
          projectId={project.id}
          user={user}
          folders={folders}
          records={records}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
function FolderTree({
  folders,
  parent,
  selected,
  onSelect,
  depth = 0,
  seen = [],
}) {
  if (depth > 20) return null;
  return folders
    .filter((f) => (f.parent_id || null) === parent && !seen.includes(f.id))
    .map((f) => (
      <React.Fragment key={f.id}>
        <button
          onClick={() => onSelect(f.id)}
          style={{ paddingLeft: 16 + depth * 12 }}
          className={
            "mt-1 flex w-full items-center gap-2 rounded-xl py-2 text-left text-xs transition " +
            (selected === f.id
              ? "bg-indigo-50 font-medium text-indigo-600"
              : "text-slate-500 hover:bg-slate-50")
          }
        >
          <Folder size={14} className="shrink-0" />
          <span className="truncate">{f.name}</span>
        </button>
        <FolderTree
          folders={folders}
          parent={f.id}
          selected={selected}
          onSelect={onSelect}
          depth={depth + 1}
          seen={[...seen, f.id]}
        />
      </React.Fragment>
    ));
}
function FolderEditor({
  folder,
  folders,
  parentId,
  projectId,
  onClose,
  onSaved,
}) {
  const [name, setName] = useState(folder?.name || ""),
    [parent, setParent] = useState(folder?.parent_id || parentId || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        folder
          ? "/folders/" + folder.id
          : "/projects/" + projectId + "/folders",
        folder ? "PATCH" : "POST",
        {
          name,
          parent_id: parent || null,
          ...(folder ? { version: folder.version } : {}),
        },
      );
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={folder ? "管理目录" : "新建目录"}
      sub="目录用于保留资料层级，分类和标签方便跨目录查找。"
      icon={FolderPlus}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="space-y-4 px-6">
          <Field label="目录名称">
            <input
              autoFocus
              required
              maxLength={100}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="上级目录">
            <select
              className={inputClass}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">项目根目录</option>
              {folders
                .filter((f) => f.id !== folder?.id)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <div className="mt-4">
          <FormError error={error} />
        </div>
        <FormActions onClose={onClose} busy={busy} />
      </form>
    </Modal>
  );
}
function UploadDialog({
  projectId,
  userId,
  folders,
  documents,
  folderId,
  document,
  onClose,
  onSaved,
}) {
  const [files, setFiles] = useState([]),
    [category, setCategory] = useState(document?.category || ""),
    [tags, setTags] = useState((document?.tags || []).join("，")),
    [mode, setMode] = useState("new"),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState({}),
    [results, setResults] = useState([]),
    [error, setError] = useState(null);
  const controller = useRef(null),
    active = useRef(true),
    cancelled = useRef(false),
    uploads = useRef([]);
  useEffect(
    () => () => {
      active.current = false;
      controller.current?.abort();
    },
    [],
  );
  const duplicates = files.filter(
    (file) =>
      !file.webkitRelativePath &&
      documents.some(
        (d) => d.filename === file.name && (d.folder_id || null) === folderId,
      ),
  );
  async function start() {
    if (!files.length) return;
    setBusy(true);
    cancelled.current = false;
    setError(null);
    setResults([]);
    controller.current = new AbortController();
    const localFolders = [...folders];
    const outcomes = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (controller.current.signal.aborted)
          throw new DOMException("上传已暂停", "AbortError");
        let targetFolder = folderId;
        const segments = (file.webkitRelativePath || "")
          .split("/")
          .slice(0, -1);
        for (const name of segments) {
          let entry = localFolders.find(
            (f) => f.name === name && (f.parent_id || null) === targetFolder,
          );
          if (!entry) {
            const result = await api(
              "/projects/" + projectId + "/folders",
              "POST",
              { name, parent_id: targetFolder },
            );
            entry = result.folder || result;
            localFolders.push(entry);
          }
          targetFolder = entry.id;
        }
        const existing =
          document ||
          (mode === "version" &&
            documents.find(
              (d) =>
                (d.filename === file.name || d.title === file.name) &&
                (d.folder_id || null) === targetFolder,
            ));
        if (
          !document &&
          mode === "skip" &&
          documents.some(
            (d) =>
              d.filename === file.name &&
              (d.folder_id || null) === targetFolder,
          )
        ) {
          outcomes.push({ name: file.name, message: "已跳过同名文件" });
          continue;
        }
        const result = await uploadFile(
          file,
          {
            folder_id: targetFolder,
            ...(existing
              ? {
                  document_id: existing.id,
                  base_version_id: workingId(existing),
                }
              : { title: file.name }),
            category,
            tags: tags
              .split(/[,，、]/)
              .map((t) => t.trim())
              .filter(Boolean),
          },
          {
            projectId,
            userId,
            signal: controller.current.signal,
            onProgress: (p) => {
              if (active.current) {
                if (!uploads.current.includes(p.uploadId))
                  uploads.current.push(p.uploadId);
                setProgress({ ...p, index: i + 1, filename: file.name });
              }
            },
          },
        );
        outcomes.push({
          name: file.name,
          message: result.conflict
            ? "内容已保存为冲突候选，请在版本中比对后采纳"
            : result.deduplicated || result.duplicate
              ? "相同内容已识别，已保留记录"
              : "上传完成",
        });
        if (active.current) setResults([...outcomes]);
      }
      if (active.current) {
        setFiles([]);
        await onSaved();
      }
    } catch (e) {
      if (active.current)
        setError(
          e.name === "AbortError"
            ? new Error(
                cancelled.current
                  ? "已取消当前上传，已完成的文件仍然保留。"
                  : "上传已暂停。重新选择相同文件可续传，已完成文件不会丢失。",
              )
            : e,
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={document ? "更新文档版本" : "上传项目资料"}
      sub="支持批量和整目录导入；新内容保留为工作版，正式版单独发布。"
      icon={Upload}
      onClose={onClose}
      wide
    >
      <div className="space-y-4 px-6 pb-2">
        <div className="flex flex-wrap gap-2">
          <label className={secondary + " cursor-pointer"}>
            <Plus size={15} />
            {document ? "选择新版文件" : "选择文件"}
            <input
              type="file"
              className="hidden"
              multiple={!document}
              onChange={(e) => {
                setFiles([...e.target.files]);
                setResults([]);
                setError(null);
                e.target.value = "";
              }}
              disabled={busy}
            />
          </label>
          {!document && (
            <label className={secondary + " cursor-pointer"}>
              <Folder size={15} />
              选择整个目录
              <input
                type="file"
                className="hidden"
                webkitdirectory=""
                multiple
                onChange={(e) => {
                  setFiles([...e.target.files]);
                  setResults([]);
                  setError(null);
                  e.target.value = "";
                }}
                disabled={busy}
              />
            </label>
          )}
          <span className="self-center text-xs text-slate-400">
            {files.length
              ? `${files.length} 个文件 · ${fileSize(files.reduce((n, f) => n + f.size, 0))}`
              : "先选择文件，确认后再上传"}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="资料分类">
            <select
              className={inputClass}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={busy}
            >
              <option value="">未分类</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="标签" hint="多个标签用逗号分隔">
            <input
              className={inputClass}
              value={tags}
              maxLength={500}
              onChange={(e) => setTags(e.target.value)}
              disabled={busy}
              placeholder="如：部署、客户确认"
            />
          </Field>
        </div>
        {!document && (
          <Field label="遇到同目录同名文件时">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className={inputClass}
              disabled={busy}
            >
              <option value="version">添加为该文档的新版本（保留旧版）</option>
              <option value="skip">跳过同名文件</option>
              <option value="new">保留为独立文档</option>
            </select>
          </Field>
        )}
        {duplicates.length > 0 && (
          <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-700">
            发现 {duplicates.length}{" "}
            个同名文件，请确认上方处理方式。上传时会检查基于版本，旧版本提交不会覆盖他人的更新。
          </p>
        )}
        <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-100">
          {files.map((f, index) => (
            <div
              className="flex justify-between gap-4 border-b border-slate-50 px-3 py-2 text-xs last:border-0"
              key={index}
            >
              <span className="min-w-0 break-all text-slate-600">
                {f.webkitRelativePath || f.name}
              </span>
              <span className="shrink-0 text-slate-400">
                {fileSize(f.size)}
              </span>
            </div>
          ))}
        </div>
        {busy && (
          <div role="status">
            <div className="mb-2 flex justify-between gap-3 text-xs text-slate-500">
              <span className="truncate">
                {progress.index || 1}/{files.length} ·{" "}
                {progress.filename || "准备上传…"}
              </span>
              <span>
                {progress.total
                  ? Math.round((progress.loaded / progress.total) * 100)
                  : 0}
                %
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-indigo-50">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{
                  width:
                    (progress.total
                      ? (progress.loaded / progress.total) * 100
                      : 0) + "%",
                }}
              />
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              网络失败自动重试；暂停后重新选择相同文件可以续传。
            </p>
          </div>
        )}
        {results.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700">
            {results.map((r, i) => (
              <p key={i} className="py-1">
                {r.name}：{r.message}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3">
        <FormError error={error} />
      </div>
      <div className="flex justify-end gap-2 px-6 py-5">
        <button className={secondary} onClick={onClose}>
          {busy ? "暂停并关闭" : "关闭"}
        </button>
        {busy ? (
          <>
            <button
              className={secondary}
              onClick={() => controller.current?.abort()}
            >
              暂停上传
            </button>
            <button
              className={secondary + " text-rose-500"}
              onClick={async () => {
                if (
                  !window.confirm(
                    "取消当前文件上传并清理已上传分片？已经完成的文件会保留。",
                  )
                )
                  return;
                cancelled.current = true;
                controller.current?.abort();
                try {
                  await cancelUpload(progress.uploadId);
                } catch (e) {
                  if (active.current) setError(e);
                }
              }}
            >
              取消上传
            </button>
          </>
        ) : (
          <button className={primary} disabled={!files.length} onClick={start}>
            <Upload size={15} />
            确认上传
          </button>
        )}
      </div>
    </Modal>
  );
}
function DocumentDetail({
  id,
  projectId,
  user,
  folders,
  records,
  onClose,
  onChanged,
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [update, setUpdate] = useState(false),
    [form, setForm] = useState({}),
    [preview, setPreview] = useState(null);
  const active = useRef(true),
    previewRef = useRef(null);
  useEffect(
    () => () => {
      active.current = false;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  async function load() {
    try {
      const next = await api("/documents/" + id);
      if (active.current) {
        if (next.document.project_id !== projectId)
          throw new Error("该文档不属于当前项目，请返回对应项目查看");
        setData(next);
        setForm({
          ...next.document,
          tags: (next.document.tags || []).join("，"),
        });
        setError(null);
      }
    } catch (e) {
      if (active.current) setError(e);
    }
  }
  useEffect(() => {
    load();
  }, [id]);
  async function action(route, body = {}, method = "POST") {
    setBusy(true);
    setError(null);
    try {
      await api(route, method, { version: data.document.version, ...body });
      await load();
      await onChanged();
    } catch (e) {
      if (active.current) setError(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function download(version, isPreview = false) {
    setError(null);
    try {
      const result = await internalDownload(
        "/documents/" +
          id +
          "/versions/" +
          version.id +
          (isPreview ? "/preview" : "/download"),
        version.filename,
        { preview: isPreview },
      );
      if (isPreview && active.current) {
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        previewRef.current = result.url;
        setPreview(result);
      } else if (result?.url) URL.revokeObjectURL(result.url);
    } catch (e) {
      if (active.current) setError(e);
    }
  }
  const doc = data?.document,
    versions = data?.versions || [],
    checkout = data?.checkout;
  const current = versions.find((v) => v.id === workingId(doc || {}));
  return (
    <>
      <Modal
        title={doc?.title || "文档详情"}
        sub="稳定文档记录 · 每次更新形成独立版本"
        icon={FileText}
        onClose={onClose}
        wide
      >
        <div className="max-h-[65dvh] space-y-5 overflow-y-auto px-6 pb-2">
          {!data && !error && (
            <p className="py-10 text-center text-sm text-slate-400">载入中…</p>
          )}
          {doc && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-600">
                  {doc.category || "未分类"}
                </span>
                {doc.deleted_at || doc.deleted ? (
                  <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs text-rose-600">
                    已移入回收站
                  </span>
                ) : null}
                {(doc.tags || []).map((t) => (
                  <span
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-400"
                    key={t}
                  >
                    {t}
                  </span>
                ))}
                <button
                  className={smallButton + " ml-auto"}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        location.origin +
                          location.pathname +
                          "?module=documents&project=" +
                          projectId +
                          "&document=" +
                          id,
                      );
                    } catch {
                      setError(new Error("复制失败，请使用文档列表中的入口"));
                    }
                  }}
                >
                  <Link2 size={14} />
                  复制内部链接
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs text-slate-400">最新工作版</p>
                  <p className="mt-1 text-sm font-medium text-slate-700">
                    {current
                      ? "V" + current.number + " · " + current.filename
                      : "暂无版本"}
                  </p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-3">
                  <p className="text-xs text-emerald-600">正式交付版</p>
                  <p className="mt-1 text-sm font-medium text-emerald-700">
                    {doc.published_version_id
                      ? "V" +
                        (versions.find((v) => v.id === doc.published_version_id)
                          ?.number || "—")
                      : "尚未发布"}
                  </p>
                </div>
              </div>
              {checkout && (
                <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
                  {checkout.user_name ||
                    checkout.holder_name ||
                    checkout.created_by_name ||
                    "有成员"}{" "}
                  正在修改这份文档。
                  <span className="ml-1">
                    占用至{" "}
                    {displayTime(checkout.expires_at || checkout.expires)}
                  </span>
                  <button
                    className="ml-3 underline"
                    disabled={busy}
                    onClick={() => {
                      const reason =
                        window.prompt("填写释放或接管说明（会记录日志）");
                      if (reason?.trim())
                        action("/documents/" + id + "/release-checkout", {
                          reason,
                        });
                    }}
                  >
                    释放 / 接管
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {!(doc.deleted_at || doc.deleted) ? (
                  <>
                    <button
                      className={primary}
                      disabled={busy}
                      onClick={() => setUpdate(true)}
                    >
                      <Upload size={14} />
                      上传新版本
                    </button>
                    <button
                      className={secondary}
                      onClick={() => setEdit(!edit)}
                    >
                      编辑信息
                    </button>
                    {!checkout && (
                      <button
                        className={secondary}
                        disabled={busy}
                        onClick={() => action("/documents/" + id + "/checkout")}
                      >
                        标记我在修改
                      </button>
                    )}
                    <button
                      className={smallButton + " text-rose-500"}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm("移入回收站？历史版本和日志会保留。")
                        )
                          action("/documents/" + id, {}, "DELETE");
                      }}
                    >
                      <Trash2 size={14} />
                      移入回收站
                    </button>
                  </>
                ) : (
                  <button
                    className={primary}
                    disabled={busy}
                    onClick={() => action("/documents/" + id + "/restore")}
                  >
                    <RefreshCw size={14} />
                    恢复文档
                  </button>
                )}
              </div>
              {edit && (
                <form
                  className="space-y-4 rounded-xl border border-slate-100 p-4"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await action(
                      "/documents/" + id,
                      {
                        title: form.title,
                        folder_id: form.folder_id || null,
                        category: form.category || "",
                        tags: form.tags
                          .split(/[,，、]/)
                          .map((t) => t.trim())
                          .filter(Boolean),
                        owner: form.owner || "",
                        description: form.description || "",
                        task_id: form.task_id || null,
                      },
                      "PATCH",
                    );
                  }}
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="标题">
                      <input
                        required
                        className={inputClass}
                        value={form.title || ""}
                        onChange={(e) =>
                          setForm({ ...form, title: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="所在目录">
                      <select
                        className={inputClass}
                        value={form.folder_id || ""}
                        onChange={(e) =>
                          setForm({ ...form, folder_id: e.target.value })
                        }
                      >
                        <option value="">项目根目录</option>
                        {folders.map((f) => (
                          <option value={f.id} key={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="分类">
                      <select
                        className={inputClass}
                        value={form.category || ""}
                        onChange={(e) =>
                          setForm({ ...form, category: e.target.value })
                        }
                      >
                        <option value="">未分类</option>
                        {categories.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="维护人">
                      <input
                        className={inputClass}
                        value={form.owner || ""}
                        onChange={(e) =>
                          setForm({ ...form, owner: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="标签">
                      <input
                        className={inputClass}
                        value={form.tags || ""}
                        onChange={(e) =>
                          setForm({ ...form, tags: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="关联任务">
                      <select
                        className={inputClass}
                        value={form.task_id || ""}
                        onChange={(e) =>
                          setForm({ ...form, task_id: e.target.value })
                        }
                      >
                        <option value="">不关联</option>
                        {records
                          .filter(
                            (r) =>
                              r.project_id === projectId ||
                              r.projectId === projectId,
                          )
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.title || r.task}
                            </option>
                          ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="说明">
                    <textarea
                      className={inputClass}
                      value={form.description || ""}
                      rows={2}
                      onChange={(e) =>
                        setForm({ ...form, description: e.target.value })
                      }
                    />
                  </Field>
                  <div className="text-right">
                    <button className={primary} disabled={busy} type="submit">
                      保存信息
                    </button>
                  </div>
                </form>
              )}
              <div>
                <h3 className="mb-3 text-sm font-semibold text-slate-700">
                  版本历史{" "}
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    {versions.length} 个版本
                  </span>
                </h3>
                <div className="space-y-2">
                  {versions.map((v) => (
                    <div
                      key={v.id}
                      className="rounded-xl border border-slate-100 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-700">
                          V{v.number}
                        </span>
                        {v.id === workingId(doc) && (
                          <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-600">
                            最新工作版
                          </span>
                        )}
                        {v.id === doc.published_version_id && (
                          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600">
                            正式版
                          </span>
                        )}
                        {v.conflict ||
                        v.is_conflict ||
                        v.status === "conflict" ? (
                          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                            冲突候选 · 尚未替换工作版
                          </span>
                        ) : null}
                        <span className="ml-auto text-[11px] text-slate-400">
                          {fileSize(v.size)}
                        </span>
                      </div>
                      <p className="mt-2 break-all text-xs text-slate-500">
                        {v.filename}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {v.created_by_name ||
                          v.uploader_name ||
                          v.created_by ||
                          "成员"}{" "}
                        · {displayTime(dateValue(v))}
                        {v.note ? " · " + v.note : ""}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <button
                          className={smallButton}
                          onClick={() => download(v)}
                        >
                          <Download size={13} />
                          下载
                        </button>
                        {/\.(png|jpe?g|gif|webp|pdf)$/i.test(
                          v.filename || "",
                        ) && (
                          <button
                            className={smallButton}
                            onClick={() => download(v, true)}
                          >
                            预览
                          </button>
                        )}
                        {!(doc.deleted_at || doc.deleted) && (
                          <>
                            {v.id !== doc.published_version_id && (
                              <button
                                className={smallButton}
                                disabled={busy}
                                onClick={() =>
                                  action("/documents/" + id + "/publish", {
                                    version_id: v.id,
                                  })
                                }
                              >
                                <ShieldCheck size={13} />
                                发布为正式版
                              </button>
                            )}
                            {v.id !== workingId(doc) && (
                              <button
                                className={smallButton}
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "采纳 V" +
                                        v.number +
                                        " 为最新工作版？当前工作版和正式版仍会保留。",
                                    )
                                  )
                                    action(
                                      "/documents/" + id + "/select-version",
                                      { version_id: v.id },
                                    );
                                }}
                              >
                                采纳为工作版
                              </button>
                            )}
                            {v.id !== workingId(doc) && (
                              <button
                                className={smallButton}
                                disabled={busy}
                                onClick={() =>
                                  action(
                                    "/documents/" + id + "/restore-version",
                                    { version_id: v.id },
                                  )
                                }
                              >
                                基于此版恢复
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="mt-3">
          <FormError error={error} onReload={load} />
        </div>
        <div className="flex justify-end px-6 py-4">
          <button className={secondary} onClick={onClose}>
            关闭
          </button>
        </div>
      </Modal>
      {update && doc && (
        <UploadDialog
          projectId={projectId}
          userId={user.id}
          documents={[]}
          folders={folders}
          folderId={doc.folder_id || null}
          document={doc}
          onClose={() => {
            setUpdate(false);
            load();
            onChanged();
          }}
          onSaved={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
      {preview && (
        <Modal
          title="文件预览"
          sub="预览来自登录验证后的文件内容。"
          onClose={() => {
            URL.revokeObjectURL(preview.url);
            previewRef.current = null;
            setPreview(null);
          }}
          wide
        >
          <div className="px-6 pb-6">
            {preview.type === "application/pdf" ? (
              <iframe
                title="PDF 预览"
                src={preview.url}
                className="h-[65vh] w-full rounded-xl border border-slate-100"
              />
            ) : (
              <img
                alt={doc?.title || "资料预览"}
                src={preview.url}
                className="max-h-[65vh] w-full rounded-xl object-contain"
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
function ReleaseDialog({ projectId, documents, onClose }) {
  const [releases, setReleases] = useState([]),
    [name, setName] = useState(""),
    [items, setItems] = useState({}),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const r = await api("/projects/" + projectId + "/releases");
      setReleases(r.releases || []);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    load();
  }, [projectId]);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/projects/" + projectId + "/releases", "POST", {
        name,
        items: Object.entries(items)
          .filter(([, v]) => v)
          .map(([document_id, version_id]) => ({ document_id, version_id })),
      });
      setName("");
      setItems({});
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="交付归档"
      sub="固定选择的版本形成交付快照，后续上传不会改变已有归档。"
      icon={FileArchive}
      onClose={onClose}
      wide
    >
      <div className="max-h-[65dvh] space-y-5 overflow-y-auto px-6">
        <form onSubmit={save} className="space-y-4 rounded-xl bg-slate-50 p-4">
          <Field label="归档名称 / 发布编号">
            <input
              value={name}
              required
              maxLength={150}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：一期验收交付 2026-10"
              className={inputClass}
            />
          </Field>
          <div className="max-h-52 space-y-2 overflow-y-auto">
            {documents
              .filter((d) => !d.deleted && !d.deleted_at)
              .map((d) => (
                <label
                  key={d.id}
                  className="flex items-center gap-3 rounded-lg bg-white p-2.5 text-xs text-slate-600"
                >
                  <input
                    type="checkbox"
                    checked={!!items[d.id]}
                    onChange={(e) =>
                      setItems({
                        ...items,
                        [d.id]: e.target.checked
                          ? d.published_version_id || workingId(d)
                          : "",
                      })
                    }
                    className="accent-indigo-500"
                  />
                  <span className="min-w-0 flex-1 break-words">{d.title}</span>
                  <select
                    aria-label={d.title + "归档版本"}
                    value={
                      items[d.id] || d.published_version_id || workingId(d)
                    }
                    onChange={(e) =>
                      setItems({ ...items, [d.id]: e.target.value })
                    }
                    className="max-w-36 rounded-lg border border-slate-200 p-1.5"
                  >
                    <option value={workingId(d)}>最新工作版</option>
                    {d.published_version_id &&
                      d.published_version_id !== workingId(d) && (
                        <option value={d.published_version_id}>
                          正式交付版
                        </option>
                      )}
                  </select>
                </label>
              ))}
          </div>
          <p className="text-[11px] text-slate-400">
            请确认选中的是可交付版本。归档仅含选定文档，不包含账号密码和加密配置。
          </p>
          <div className="text-right">
            <button
              disabled={busy || !Object.values(items).some(Boolean)}
              className={primary}
            >
              生成固定归档
            </button>
          </div>
        </form>
        <div>
          <h3 className="mb-3 text-sm font-semibold text-slate-700">
            已有归档
          </h3>
          {!releases.length && (
            <p className="py-4 text-xs text-slate-400">还没有交付归档</p>
          )}
          {releases.map((r) => (
            <div
              key={r.id}
              className="mb-2 rounded-xl border border-slate-100 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-700">{r.name}</p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {(r.items || []).length} 份固定版本 ·{" "}
                    {displayTime(dateValue(r))}
                  </p>
                </div>
                <button
                  className={secondary}
                  onClick={async () => {
                    try {
                      await internalDownload(
                        "/releases/" + r.id + "/download",
                        r.name + ".zip",
                      );
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  <Download size={14} />
                  下载
                </button>
              </div>
              <details className="mt-2 text-xs text-slate-400">
                <summary className="cursor-pointer">查看版本清单</summary>
                <div className="mt-2 space-y-1">
                  {(r.items || []).map((i, n) => (
                    <p key={n}>
                      {i.title || i.filename} · V{i.number} · {fileSize(i.size)}
                    </p>
                  ))}
                </div>
              </details>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <FormError error={error} />
      </div>
      <div className="flex justify-end px-6 py-4">
        <button onClick={onClose} className={secondary}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
