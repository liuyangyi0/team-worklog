import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  NotebookPen,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  RotateCcw,
  Paperclip,
  Search,
  X,
  LogIn,
  ClipboardCheck,
  GitBranch,
  Download,
} from "lucide-react";
import { api } from "../api.js";
import {
  uploadFile,
  ensureFolder,
  internalDownload,
  fileSize,
  displayTime,
} from "../library-api.js";
import { FILE_DIRECTIONS, NOTE_KINDS, noteKind } from "../notes.js";
import NoteExchange from "./NoteExchange.jsx";
import { beijingDate, splitNames } from "../model.js";
import {
  Modal,
  primary,
  secondary,
  inputClass,
  FormError,
  Field,
  PersonPicker,
} from "./UI.jsx";

export const ATTACHMENT_FOLDER = "随手记附件";
const kindClasses = {
  site: "bg-violet-50 text-violet-600 ring-violet-100",
  verbal: "bg-amber-50 text-amber-700 ring-amber-100",
  file: "bg-sky-50 text-sky-600 ring-sky-100",
  other: "bg-slate-100 text-slate-500 ring-slate-200",
};
export function KindBadge({ kind }) {
  return (
    <span
      className={
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 " +
        (kindClasses[kind] || kindClasses.other)
      }
    >
      {noteKind(kind).label}
    </span>
  );
}
export function NoteFiles({
  files,
  onRemove,
  onChooseVersion,
  onOpenDocument,
  onUnauthorized,
}) {
  const [downloadError, setDownloadError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function download(file, versionId) {
    setDownloadError("");
    try {
      // Native streaming downloads do not expose HTTP errors to JavaScript.
      // Check the private endpoint first so an expired session clears its UI.
      const result = await api("/documents/" + file.document_id);
      if (!live.current) return;
      if (result.document?.deleted || result.document?.sensitive)
        throw new Error("资料已删除或受限，无法下载");
      const targetVersion = versionId || result.document?.current_version_id;
      if (!targetVersion) throw new Error("资料暂无可下载版本");
      await internalDownload(
        "/documents/" +
          file.document_id +
          "/versions/" +
          targetVersion +
          "/download",
        versionId
          ? file.filename || file.title
          : result.document?.filename || file.filename || file.title,
      );
    } catch (e) {
      if (!live.current) return;
      if (e.status === 401) onUnauthorized?.();
      else setDownloadError(e.message);
    }
  }
  if (!files?.length) return null;
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {files.map((f) => {
          const fixed = !!f.version_id;
          const filename = f.filename || f.title;
          return (
            <li
              key={f.document_id}
              className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-500 ring-1 ring-slate-100"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              {f.deleted ? (
                <span className="min-w-0 truncate line-through">
                  {filename}（已删除）
                </span>
              ) : fixed ? (
                <button
                  type="button"
                  className="min-w-0 truncate hover:text-indigo-600 hover:underline"
                  title={"下载当时版本：" + filename}
                  onClick={() => download(f, f.version_id)}
                >
                  {filename}
                </button>
              ) : (
                <span className="min-w-0 truncate">{filename}</span>
              )}
              <span
                className={
                  fixed ? "shrink-0 text-indigo-500" : "shrink-0 text-amber-600"
                }
              >
                {fixed ? "当时 V" + (f.number || "?") : "未固定版本"}
              </span>
              {f.size > 0 && (
                <span className="shrink-0 text-slate-400">
                  {fileSize(f.size)}
                </span>
              )}
              {!f.deleted && f.current_version_id && (
                <button
                  type="button"
                  className="shrink-0 text-indigo-500 hover:underline"
                  aria-label={"查看最新版：" + filename}
                  onClick={() =>
                    onOpenDocument
                      ? onOpenDocument(f.document_id)
                      : download(f, null)
                  }
                >
                  {onOpenDocument ? "查看最新版" : "下载最新版"}
                </button>
              )}
              {!f.deleted && onChooseVersion && (
                <button
                  type="button"
                  className="shrink-0 text-slate-500 hover:text-indigo-600 hover:underline"
                  aria-label={"选择附件版本：" + filename}
                  onClick={() => onChooseVersion(f)}
                >
                  {fixed ? "更正版本" : "选择版本"}
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  aria-label={"移除附件：" + filename}
                  className="shrink-0 rounded p-0.5 text-slate-400 hover:text-rose-500"
                  onClick={() => onRemove(f)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {downloadError && (
        <p role="alert" className="mt-1 text-xs text-rose-500">
          {downloadError}
        </p>
      )}
    </>
  );
}
function AttachmentVersionDialog({
  projectId,
  noteId,
  file,
  onClose,
  onSaved,
  onUnauthorized,
}) {
  const [versions, setVersions] = useState([]),
    [selected, setSelected] = useState(file.version_id || ""),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    saving = useRef(false);
  useEffect(() => {
    live.current = true;
    api("/documents/" + file.document_id)
      .then((result) => {
        if (!live.current) return;
        if (result.document?.project_id !== projectId)
          throw new Error("附件不属于当前项目");
        setVersions(result.versions || []);
        setLoaded(true);
      })
      .catch((e) => {
        if (!live.current) return;
        if (e.status === 401) {
          onUnauthorized?.();
          onClose();
          return;
        }
        setError(e);
        setLoaded(true);
      });
    return () => {
      live.current = false;
    };
  }, [projectId, file.document_id]);
  async function save(e) {
    e.preventDefault();
    if (saving.current || !selected) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "/notes/" + noteId + "/files/" + file.document_id,
        "PATCH",
        { version_id: selected, link_version: file.link_version },
      );
      if (!live.current) return;
      try {
        await onSaved(result.note);
        onClose();
      } catch {
        if (live.current)
          setError("附件版本已固定，列表刷新失败，请关闭后刷新查看。");
      }
    } catch (e) {
      if (!live.current) return;
      if (e.status === 401) {
        onUnauthorized?.();
        onClose();
        return;
      }
      setError(
        e.status === 409 ? e.message + "；请关闭后重新打开再选择版本。" : e,
      );
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="选择附件版本"
      sub={file.title + " · 人工确认当时使用的版本"}
      icon={Paperclip}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={save}>
        <div className="space-y-4 px-6">
          <p className="text-xs leading-relaxed text-slate-500">
            {file.version_id
              ? "更正后，记录将引用所选版本。"
              : "这条历史关联未固定版本，无法自动恢复当时版本；请核实后选择。"}
          </p>
          <Field label="文件版本">
            <select
              className={inputClass}
              value={selected}
              disabled={!loaded || busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择版本</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {"V" +
                    v.number +
                    " · " +
                    v.filename +
                    (v.conflict ? "（冲突版）" : "")}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <FormError error={error} />
        <div className="flex justify-end gap-2 px-6 py-5">
          <button
            type="button"
            className={secondary}
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className={primary} disabled={!selected || busy || !loaded}>
            {busy ? "保存中…" : "确认固定版本"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
// Shared by the timeline, the checklist ("记一条") and task details.
export function NoteDialog(props) {
  const key = [
    props.project.id,
    props.user?.id,
    props.note?.id || props.draft?.parent_note_id || "new",
  ].join(":");
  return props.user ? <NoteComposer key={key} {...props} /> : null;
}
export function NoteComposer({
  project,
  user,
  records = [],
  people = [],
  note: initial,
  draft = {},
  onClose,
  onSaved,
  onUnauthorized,
  onOpenDocument,
}) {
  const [note, setNote] = useState(initial || null),
    [kind, setKind] = useState(initial?.kind || draft.kind || "site"),
    [body, setBody] = useState(initial?.body || ""),
    [occurred, setOccurred] = useState(
      initial ? initial.occurred_on : beijingDate(),
    ),
    [fileDirection, setFileDirection] = useState(initial?.file_direction || ""),
    [counterparty, setCounterparty] = useState(initial?.counterparty || ""),
    [exchangeTime, setExchangeTime] = useState(initial?.exchange_time || ""),
    [channel, setChannel] = useState(initial?.channel || ""),
    [names, setNames] = useState(splitNames(initial?.people)),
    [deliverableId, setDeliverableId] = useState(
      initial?.deliverable_id || draft.deliverable_id || "",
    ),
    [taskId, setTaskId] = useState(initial?.task_id || draft.task_id || ""),
    [deliverables, setDeliverables] = useState([]),
    [documents, setDocuments] = useState(null),
    [documentId, setDocumentId] = useState(""),
    [documentVersions, setDocumentVersions] = useState([]),
    [documentVersionId, setDocumentVersionId] = useState(""),
    [existingFiles, setExistingFiles] = useState([]),
    [versionFile, setVersionFile] = useState(null),
    [denied, setDenied] = useState(false),
    [pending, setPending] = useState([]),
    [progress, setProgress] = useState(""),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    saving = useRef(false),
    uploaded = useRef(new Map()),
    controller = useRef(null);
  function unauthorized(e) {
    if (e?.status !== 401) return false;
    setDenied(true);
    setBody("");
    setNames([]);
    setFileDirection("");
    setCounterparty("");
    setExchangeTime("");
    setChannel("");
    setPending([]);
    uploaded.current.clear();
    setDeliverables([]);
    setDeliverableId("");
    setTaskId("");
    setDocuments(null);
    setDocumentId("");
    setDocumentVersions([]);
    setDocumentVersionId("");
    setExistingFiles([]);
    setVersionFile(null);
    setNote(null);
    setError("");
    controller.current?.abort();
    onUnauthorized?.();
    onClose();
    return true;
  }
  useEffect(() => {
    live.current = true;
    controller.current = new AbortController();
    api("/projects/" + project.id + "/deliverables")
      .then((r) => live.current && setDeliverables(r.items))
      .catch((e) => {
        if (live.current) unauthorized(e);
      });
    return () => {
      live.current = false;
      controller.current?.abort();
    };
  }, [project.id, user.id]);
  function changeKind(next) {
    setKind(next);
    if (next !== "file") {
      setFileDirection("");
      setCounterparty("");
      setExchangeTime("");
      setChannel("");
    }
  }
  const tasks = records.filter((r) => r.project_id === project.id);
  function addFiles(list) {
    if (busy) return;
    // Copy now: the input's live FileList is cleared right after this call.
    const files = [...list];
    setPending((old) => [
      ...old,
      ...files.filter(
        (f) => !old.some((o) => o.name === f.name && o.size === f.size),
      ),
    ]);
  }
  async function publishSaved(saved, options) {
    try {
      await onSaved(saved, options);
    } catch (e) {
      if (!live.current) return;
      if (unauthorized(e)) return;
      setError("内容已保存，列表刷新失败，请关闭后刷新查看。");
    }
  }
  async function submit(e) {
    e.preventDefault();
    if (saving.current || denied) return;
    saving.current = true;
    setBusy(true);
    setError("");
    let saved = note;
    try {
      const selected = selectedExisting();
      const attachments = [
        ...existingFiles,
        ...(selected ? [selected] : []),
      ].map(({ document_id, version_id }) => ({ document_id, version_id }));
      if (attachments.length > 100) throw new Error("一次最多关联 100 份资料");
      const fields = {
        attachments,
        kind,
        body,
        occurred_on: occurred || "",
        people: names.join("、"),
        deliverable_id: deliverableId || null,
        task_id: taskId || null,
        file_direction: kind === "file" ? fileDirection : "",
        counterparty: kind === "file" ? counterparty : "",
        exchange_time: kind === "file" ? exchangeTime : "",
        channel: kind === "file" ? channel : "",
      };
      saved = (
        await (saved
          ? api("/notes/" + saved.id, "PATCH", {
              ...fields,
              version: saved.version,
            })
          : api("/projects/" + project.id + "/notes", "POST", {
              ...fields,
              parent_note_id: draft.parent_note_id || null,
            }))
      ).note;
      if (!live.current) return;
      setNote(saved);
      setExistingFiles([]);
      setDocumentId("");
      setDocumentVersions([]);
      setDocumentVersionId("");
      const failed = [];
      if (pending.length) {
        const folder = await ensureFolder(project.id, ATTACHMENT_FOLDER);
        if (!live.current) return;
        for (const [index, file] of pending.entries()) {
          try {
            let result = uploaded.current.get(file);
            if (!result) {
              result = await uploadFile(
                file,
                {
                  title: file.name,
                  folder_id: folder,
                  category: ATTACHMENT_FOLDER,
                  description: body.trim().slice(0, 200),
                  task_id: taskId || null,
                  tags: [noteKind(kind).label],
                },
                {
                  userId: user.id,
                  projectId: project.id,
                  signal: controller.current?.signal,
                  onProgress: ({ loaded, total }) =>
                    live.current &&
                    setProgress(
                      "附件 " +
                        (index + 1) +
                        "/" +
                        pending.length +
                        " · " +
                        Math.round((loaded / Math.max(total, 1)) * 100) +
                        "%",
                    ),
                },
              );
              if (!live.current) return;
              uploaded.current.set(file, result);
            }
            if (!result.version_id)
              throw new Error("上传未返回固定版本，请刷新资料库核实");
            const attached = (
              await api("/notes/" + saved.id + "/files", "POST", {
                document_id: result.document_id,
                version_id: result.version_id,
              })
            ).note;
            saved = { ...saved, files: attached.files };
            if (!live.current) return;
            setNote(saved);
            uploaded.current.delete(file);
          } catch (uploadError) {
            if (!live.current || unauthorized(uploadError)) return;
            failed.push({ file, message: uploadError.message });
          }
        }
      }
      if (!live.current) return;
      setPending(failed.map((f) => f.file));
      if (failed.length) {
        setError(
          "内容已保存，以下附件未关联成功，可再点保存重试：" +
            failed.map((f) => f.file.name + "（" + f.message + "）").join("、"),
        );
        await publishSaved(saved, { keepOpen: true });
        return;
      }
      await publishSaved(saved);
    } catch (e) {
      if (live.current && !unauthorized(e)) setError(e);
    } finally {
      saving.current = false;
      if (live.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function detach(file) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const next = (
        await api(
          "/notes/" + note.id + "/files/" + file.document_id,
          "DELETE",
          { link_version: file.link_version },
        )
      ).note;
      if (!live.current) return;
      setNote((current) => ({ ...current, files: next.files }));
      await publishSaved(next, { keepOpen: true });
    } catch (e) {
      if (live.current && !unauthorized(e)) setError(e);
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function loadDocuments() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api("/projects/" + project.id + "/documents");
      if (live.current) setDocuments(result.documents || []);
    } catch (e) {
      if (live.current && !unauthorized(e)) setError(e);
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function chooseDocument(id) {
    if (saving.current) return;
    setDocumentId(id);
    setDocumentVersions([]);
    setDocumentVersionId("");
    setError("");
    if (!id) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await api("/documents/" + id);
      if (!live.current) return;
      const d = result.document;
      if (d?.project_id !== project.id || d.deleted || d.sensitive)
        throw new Error("请选择当前项目的有效非敏感资料");
      const versions = (result.versions || []).filter(
        (v) =>
          !v.conflict ||
          v.id === d.current_version_id ||
          v.id === d.published_version_id,
      );
      setDocuments((old) =>
        (old || []).map((doc) => (doc.id === id ? d : doc)),
      );
      setDocumentVersions(versions);
      setDocumentVersionId(
        versions.some((v) => v.id === d.current_version_id)
          ? d.current_version_id
          : "",
      );
      if (!versions.length)
        throw new Error("该资料暂无可关联版本，请选择其他资料");
    } catch (e) {
      if (live.current && !unauthorized(e)) setError(e);
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  function selectedExisting() {
    if (!documentId) return null;
    const doc = documents?.find((d) => d.id === documentId);
    const version = documentVersions.find((v) => v.id === documentVersionId);
    if (!doc || !version)
      throw new Error("请为所选资料选择具体文件版本，或清除这份选择");
    if (
      existingFiles.some((f) => f.document_id === documentId) ||
      note?.files?.some((f) => f.document_id === documentId)
    )
      throw new Error("该资料已选择或已关联，请勿重复添加");
    return {
      document_id: doc.id,
      version_id: version.id,
      title: doc.title,
      filename: version.filename,
      number: version.number,
    };
  }
  function queueExisting() {
    if (saving.current) return;
    try {
      const choice = selectedExisting();
      if (!choice) return;
      if (existingFiles.length >= 99)
        throw new Error("一次最多关联 100 份资料");
      setExistingFiles((old) => [...old, choice]);
      setDocumentId("");
      setDocumentVersions([]);
      setDocumentVersionId("");
      setError("");
    } catch (e) {
      setError(e);
    }
  }
  if (denied) return null;
  return (
    <Modal
      title={
        note ? "编辑随手记" : draft.parent_note_id ? "补充一条" : "记一条随手记"
      }
      sub={
        project.name +
        (draft.parent_note_id || initial?.parent_note_id
          ? " · 同一事项的独立补充，可填写自己的发生日期与附件"
          : " · 现场设置、口头约定、群里的文件，当天记下来")
      }
      icon={NotebookPen}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="min-w-0 space-y-5 px-6 pb-2">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-slate-600">
              类型
            </legend>
            <div className="flex flex-wrap gap-2">
              {NOTE_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={kind === k.id}
                  onClick={() => changeKind(k.id)}
                  className={
                    "rounded-xl px-3 py-1.5 text-[13px] ring-1 transition-colors " +
                    (kind === k.id
                      ? "bg-indigo-600 text-white ring-indigo-600"
                      : "bg-white text-slate-500 ring-slate-200 hover:text-indigo-600")
                  }
                >
                  {k.label}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="内容">
            <textarea
              required
              rows={4}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={noteKind(kind).hint}
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="发生日期"
              hint={
                kind === "file"
                  ? "文件往来发生的业务日期，可以补记；与登记时间分别保存。"
                  : "可以补记，例如前天在现场改的设置"
              }
            >
              <input
                type="date"
                value={occurred}
                onChange={(e) => {
                  setOccurred(e.target.value);
                  if (!e.target.value) setExchangeTime("");
                }}
                className={inputClass}
              />
            </Field>
            <Field label="关联资料项（选填）">
              <select
                value={deliverableId}
                onChange={(e) => setDeliverableId(e.target.value)}
                className={inputClass}
              >
                <option value="">不关联</option>
                {deliverables
                  .filter((d) => d.applicable || d.id === deliverableId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {(d.stage ? d.stage + " · " : "") + d.title}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {kind === "file" && (
            <fieldset className="space-y-4 rounded-2xl border border-indigo-100 bg-indigo-50/30 p-4">
              <legend className="px-1 text-[13px] font-medium text-slate-600">
                文件收发信息（选填）
              </legend>
              <p className="text-xs leading-relaxed text-slate-400">
                记录已经发生的文件往来；选择“发出”只登记事实，不会向外发送文件。
              </p>
              <Field label="收发方向">
                <select
                  className={inputClass}
                  value={fileDirection}
                  onChange={(e) => setFileDirection(e.target.value)}
                >
                  <option value="">未区分</option>
                  {FILE_DIRECTIONS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={
                  (fileDirection === "received"
                    ? "提供方"
                    : fileDirection === "sent"
                      ? "接收方"
                      : "往来方") + "（选填）"
                }
              >
                <input
                  value={counterparty}
                  maxLength={200}
                  onChange={(e) => setCounterparty(e.target.value)}
                  placeholder={
                    fileDirection === "received"
                      ? "谁提供的，例如客户张工、设计院"
                      : fileDirection === "sent"
                        ? "交给谁，例如业主项目组、施工单位"
                        : "往来人员或单位，未知可留空"
                  }
                  className={inputClass}
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="具体时间（选填，北京时间）"
                  hint={
                    occurred
                      ? "只填写已知的业务时间，未知可留空。"
                      : "先填写发生日期；日期留空时不记录具体时间。"
                  }
                >
                  <input
                    type="time"
                    step={60}
                    value={exchangeTime}
                    disabled={!occurred}
                    onChange={(e) => setExchangeTime(e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="渠道（选填）">
                  <input
                    value={channel}
                    maxLength={100}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder="如微信、邮件、现场拷贝，可自由填写"
                    className={inputClass}
                  />
                </Field>
              </div>
            </fieldset>
          )}
          <Field label="关联任务（选填）">
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className={inputClass}
            >
              <option value="">不关联</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.task.length > 60 ? t.task.slice(0, 60) + "…" : t.task}
                </option>
              ))}
            </select>
          </Field>
          <PersonPicker
            label="相关人员（选填）"
            hint="当事人、确认人或在场的人。"
            selected={names}
            onChange={setNames}
            people={people}
            multi
          />
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-slate-600">
              附件（选填）
            </legend>
            {note && (
              <NoteFiles
                files={note.files}
                onRemove={busy ? null : detach}
                onChooseVersion={busy ? null : setVersionFile}
                onOpenDocument={onOpenDocument}
                onUnauthorized={() => unauthorized({ status: 401 })}
              />
            )}
            <div className="mt-3 space-y-2">
              {existingFiles.length > 0 && (
                <ul aria-label="待关联资料" className="space-y-1.5">
                  {existingFiles.map((f) => (
                    <li
                      key={f.document_id}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-indigo-50/60 px-3 py-2 text-xs text-slate-600"
                    >
                      <span className="min-w-0 break-words">
                        {f.title} · V{f.number} · {f.filename}
                      </span>
                      <button
                        type="button"
                        aria-label={"取消关联选择：" + f.title}
                        className="shrink-0 text-slate-400 hover:text-rose-500"
                        onClick={() =>
                          setExistingFiles((old) =>
                            old.filter(
                              (file) => file.document_id !== f.document_id,
                            ),
                          )
                        }
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {documents === null ? (
                <button
                  type="button"
                  className="text-xs text-indigo-500 hover:underline"
                  onClick={loadDocuments}
                >
                  关联已有资料
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                    <select
                      aria-label="选择已有资料"
                      value={documentId}
                      onChange={(e) => chooseDocument(e.target.value)}
                      className={inputClass + " min-w-0"}
                    >
                      <option value="">选择已有资料（可不选）</option>
                      {documents
                        .filter(
                          (d) =>
                            !d.deleted &&
                            !d.sensitive &&
                            d.current_version_id &&
                            !existingFiles.some(
                              (f) => f.document_id === d.id,
                            ) &&
                            !note?.files?.some((f) => f.document_id === d.id),
                        )
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.title}
                          </option>
                        ))}
                    </select>
                    <select
                      aria-label="选择资料版本"
                      value={documentVersionId}
                      onChange={(e) => setDocumentVersionId(e.target.value)}
                      disabled={!documentId || !documentVersions.length}
                      className={inputClass + " min-w-0"}
                    >
                      <option value="">请选择具体版本</option>
                      {documentVersions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {"V" +
                            v.number +
                            " · " +
                            v.filename +
                            (documents.find((d) => d.id === documentId)
                              ?.current_version_id === v.id
                              ? " · 当前工作版"
                              : "")}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-indigo-500 hover:underline disabled:text-slate-300"
                    disabled={!documentId || !documentVersionId}
                    onClick={queueExisting}
                  >
                    再选一份资料
                  </button>
                </div>
              )}
              <p className="text-xs leading-relaxed text-slate-400">
                选择文件和版本后直接点保存，与正文一起关联；可用“再选一份资料”添加多份。取消不建立新关联。
              </p>
            </div>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              className={
                "relative mt-2 flex cursor-pointer flex-col items-center rounded-2xl border border-dashed px-4 py-5 text-center text-xs transition-colors " +
                (dragging
                  ? "border-indigo-400 bg-indigo-50 text-indigo-600"
                  : "border-slate-200 text-slate-400 hover:border-indigo-300 hover:text-indigo-500")
              }
            >
              <Paperclip className="mb-1.5 h-4 w-4" />
              点击选择，或把照片、文件拖到这里（可多选）
              <input
                type="file"
                multiple
                aria-label="添加附件"
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            {pending.length > 0 && (
              <ul className="mt-2 space-y-1">
                {pending.map((f) => (
                  <li
                    key={f.name + f.size}
                    className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-slate-400">
                      {fileSize(f.size)}
                      <button
                        type="button"
                        aria-label={"不上传：" + f.name}
                        disabled={busy}
                        className="hover:text-rose-500"
                        onClick={() =>
                          setPending((old) => old.filter((o) => o !== f))
                        }
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              附件同时保存在“项目资料 → {ATTACHMENT_FOLDER}
              ”目录，可在资料库中查找。
            </p>
          </fieldset>
        </fieldset>
        {progress && (
          <p role="status" className="mx-6 text-xs text-indigo-500">
            正在上传{progress}
          </p>
        )}
        <FormError error={error} />
        <div className="flex items-center justify-end gap-2.5 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-[13px] font-medium text-slate-500 hover:bg-slate-100"
          >
            {note && !initial ? "完成" : "取消"}
          </button>
          <button
            type="submit"
            disabled={
              busy || !body.trim() || (!!documentId && !documentVersionId)
            }
            className={primary}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
      {versionFile && (
        <AttachmentVersionDialog
          projectId={project.id}
          noteId={note.id}
          file={versionFile}
          onClose={() => setVersionFile(null)}
          onUnauthorized={() => unauthorized({ status: 401 })}
          onSaved={async (next) => {
            setNote((current) => ({ ...current, files: next.files }));
            await publishSaved(next, { keepOpen: true });
          }}
        />
      )}
    </Modal>
  );
}
function dayOf(note) {
  return note.occurred_on || beijingDate(new Date(note.created));
}
function NoteThread({
  noteId,
  project,
  revision,
  onClose,
  onCreate,
  onEdit,
  onOpenTask,
  onOpenDocument,
  onChanged,
  onUnauthorized,
}) {
  const [thread, setThread] = useState(null),
    [error, setError] = useState(""),
    [versionChoice, setVersionChoice] = useState(null),
    [localRevision, setLocalRevision] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const serial = ++seq.current;
    setThread(null);
    setError("");
    setVersionChoice(null);
    api("/notes/" + noteId + "/thread")
      .then((result) => {
        if (serial !== seq.current) return;
        if (
          result.root?.project_id !== project.id ||
          result.notes?.some((n) => n.project_id !== project.id)
        )
          throw new Error("这条记录不属于当前项目，请从所属项目打开。");
        setThread(result);
      })
      .catch((e) => {
        if (serial !== seq.current) return;
        if (e.status === 401) {
          onClose();
          onUnauthorized?.();
          return;
        }
        setError(e.message);
      });
    return () => {
      seq.current++;
    };
  }, [noteId, project.id, revision, localRevision]);
  const active =
    thread?.notes.find((n) => n.id === noteId && !n.deleted) ||
    thread?.notes.find((n) => !n.deleted);
  return (
    <Modal
      title="事项详情"
      sub={project.name + " · 按发生日期查看原记录和补充"}
      icon={NotebookPen}
      onClose={onClose}
      wide
    >
      <div className="space-y-4 px-6 pb-6">
        {error ? (
          <p role="alert" className="text-sm text-rose-500">
            {error}
          </p>
        ) : !thread ? (
          <p role="status" className="py-6 text-sm text-slate-400">
            正在加载事项…
          </p>
        ) : (
          <>
            {thread.root.deleted && (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600">
                原事项已删除，已有补充仍保留。
              </p>
            )}
            <ol className="space-y-3">
              {thread.notes.map((n) => (
                <li
                  key={n.id}
                  data-thread-note-id={n.id}
                  className={
                    "rounded-2xl border p-4 " +
                    (n.id === noteId
                      ? "border-indigo-200 bg-indigo-50/30"
                      : "border-slate-200 bg-white")
                  }
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <KindBadge kind={n.kind} />
                    <span>{n.parent_note_id ? "补充记录" : "原事项"}</span>
                    <time dateTime={dayOf(n)}>
                      {n.kind === "file" && !n.occurred_on
                        ? "按登记日显示：" + dayOf(n)
                        : dayOf(n)}
                    </time>
                    {n.deleted && (
                      <span className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-600">
                        已删除
                      </span>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                    {n.body}
                  </p>
                  {n.people && (
                    <p className="mt-2 text-xs text-slate-400">
                      相关人员：{n.people}
                    </p>
                  )}
                  <NoteExchange note={n} />
                  <NoteFiles
                    files={n.files}
                    onOpenDocument={onOpenDocument}
                    onUnauthorized={() => {
                      onClose();
                      onUnauthorized?.();
                    }}
                    onChooseVersion={
                      n.deleted
                        ? null
                        : (file) => setVersionChoice({ note: n, file })
                    }
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs text-slate-400">
                    <span>
                      {n.author_name} 记录于 {displayTime(n.created)}
                      {n.version > 1 ? " · 已修改" : ""}
                    </span>
                    <div className="flex flex-wrap gap-3">
                      {n.task_id && (
                        <button
                          type="button"
                          className="text-indigo-500 hover:underline"
                          onClick={() => onOpenTask?.(n.task_id)}
                        >
                          关联任务
                        </button>
                      )}
                      {!n.deleted && (
                        <>
                          <button
                            type="button"
                            className="text-indigo-500 hover:underline"
                            aria-label={"编辑事项记录：" + n.body.slice(0, 20)}
                            onClick={() => onEdit(n)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="text-indigo-500 hover:underline"
                            onClick={() => onCreate({ parent_note_id: n.id })}
                          >
                            补充一条
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {active && (
              <div className="flex justify-end">
                <button
                  type="button"
                  className={primary}
                  onClick={() => onCreate({ parent_note_id: active.id })}
                >
                  <Plus className="h-4 w-4" />
                  补充一条
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {versionChoice && (
        <AttachmentVersionDialog
          projectId={project.id}
          noteId={versionChoice.note.id}
          file={versionChoice.file}
          onClose={() => setVersionChoice(null)}
          onUnauthorized={() => {
            onClose();
            onUnauthorized?.();
          }}
          onSaved={async () => {
            setLocalRevision((n) => n + 1);
            await onChanged?.();
          }}
        />
      )}
    </Modal>
  );
}
export default function SiteLog({
  project,
  user,
  revision = 0,
  onLogin,
  onCreate,
  onEdit,
  onOpenTask,
  onOpenDocument,
  initialNoteId,
  onUnauthorized,
  onChanged = () => {},
}) {
  const [notes, setNotes] = useState([]),
    [loaded, setLoaded] = useState(false),
    [trash, setTrash] = useState(false),
    [kind, setKind] = useState(""),
    [directionFilter, setDirectionFilter] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [threadNoteId, setThreadNoteId] = useState(initialNoteId || null),
    [versionChoice, setVersionChoice] = useState(null),
    [denied, setDenied] = useState(false);
  const seq = useRef(0),
    actionSeq = useRef(0);
  const authFailed = useCallback(() => {
    setDenied(true);
    setNotes([]);
    setThreadNoteId(null);
    setVersionChoice(null);
    setQuery("");
    onUnauthorized?.();
  }, [onUnauthorized]);
  useEffect(() => {
    setThreadNoteId(initialNoteId || null);
  }, [initialNoteId]);
  const load = useCallback(async () => {
    if (!project || !user) return;
    const serial = ++seq.current;
    try {
      const result = await api(
        "/projects/" + project.id + "/notes" + (trash ? "?deleted=1" : ""),
      );
      if (serial !== seq.current) return;
      setNotes(result.notes);
      setLoaded(true);
      setError("");
    } catch (e) {
      if (serial === seq.current) {
        if (e.status === 401) {
          authFailed();
          return;
        }
        setError(e.message);
        setLoaded(true);
      }
    }
  }, [project?.id, user?.id, trash, authFailed]);
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load, revision]);
  useEffect(() => {
    setNotes([]);
    setLoaded(false);
    setThreadNoteId(initialNoteId || null);
    setVersionChoice(null);
    setDenied(false);
    return () => {
      actionSeq.current++;
    };
  }, [project?.id, user?.id]);
  if (!user || denied)
    return (
      <div className="mt-8 rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center">
        <NotebookPen className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm text-slate-500">
          随手记可能包含现场 IP、账号位置等内部信息，登录后查看
        </p>
        <button className={primary + " mt-5"} onClick={onLogin}>
          <LogIn className="h-4 w-4" />
          登录后查看
        </button>
      </div>
    );
  async function act(work, message) {
    const serial = ++actionSeq.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (serial !== actionSeq.current) return;
      setNotice(message);
      await load();
      onChanged();
    } catch (e) {
      if (serial === actionSeq.current) {
        if (e.status === 401) authFailed();
        else setError(e.message);
      }
    } finally {
      if (serial === actionSeq.current) setBusy(false);
    }
  }
  const q = query.trim().toLocaleLowerCase();
  const visible = notes.filter(
    (n) =>
      (!kind || n.kind === kind) &&
      (!directionFilter ||
        (n.kind === "file" &&
          (directionFilter === "unclassified"
            ? !n.file_direction
            : n.file_direction === directionFilter))) &&
      (!q ||
        [
          n.body,
          n.people,
          n.author_name,
          n.deliverable_title,
          n.task_title,
          n.counterparty,
          n.channel,
          ...(n.files || []).map((f) => f.filename || f.title),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q)),
  );
  const days = [];
  for (const n of visible) {
    const day = dayOf(n);
    if (days.at(-1)?.day !== day) days.push({ day, notes: [] });
    days.at(-1).notes.push(n);
  }
  return (
    <section aria-label="随手记" className="pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            随手记
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            现场改的设置、口头的约定、收到或发出的文件，当天记下来；换人接手时按时间线就能查到。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className={secondary}
            aria-label="刷新随手记"
            disabled={busy}
            onClick={load}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button className={primary} onClick={() => onCreate()}>
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            记一条
          </button>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input
            aria-label="搜索随手记"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索内容、人员、往来方、渠道、附件名"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-[13px] text-slate-700 shadow-sm outline-none placeholder:text-slate-300 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
          />
        </div>
        <div
          role="group"
          aria-label="类型筛选"
          className="flex flex-wrap rounded-xl bg-slate-200/50 p-1"
        >
          {[{ id: "", label: "全部" }, ...NOTE_KINDS].map((k) => (
            <button
              key={k.id || "all"}
              aria-pressed={kind === k.id}
              onClick={() => {
                setKind(k.id);
                if (k.id !== "file") setDirectionFilter("");
              }}
              className={
                "rounded-lg px-3 py-1 text-xs font-medium " +
                (kind === k.id
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {k.label}
            </button>
          ))}
        </div>
        <select
          aria-label="收发筛选"
          value={directionFilter}
          onChange={(e) => {
            setDirectionFilter(e.target.value);
            if (e.target.value) setKind("file");
          }}
          className="max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
        >
          <option value="">全部收发</option>
          {FILE_DIRECTIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
          <option value="unclassified">未区分收发</option>
        </select>
        <button
          aria-pressed={trash}
          onClick={() => {
            setTrash((v) => !v);
            setLoaded(false);
          }}
          className={
            "ml-auto rounded-lg px-2.5 py-1.5 text-xs " +
            (trash
              ? "bg-rose-50 text-rose-500"
              : "text-slate-400 hover:bg-white hover:text-slate-600")
          }
        >
          <Trash2 className="mr-1 inline h-3.5 w-3.5" />
          回收站
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-3 text-xs text-emerald-600">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-rose-500">
          {error}
        </p>
      )}
      <div className="mt-5">
        {!loaded ? (
          <div className="rounded-2xl border border-slate-200 bg-white py-16 text-center text-sm text-slate-400">
            正在加载…
          </div>
        ) : !visible.length ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-6 py-14 text-center">
            <NotebookPen className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm text-slate-500">
              {trash
                ? "回收站是空的"
                : notes.length
                  ? "没有符合条件的随手记"
                  : "还没有随手记"}
            </p>
            {!trash && !notes.length && (
              <p className="mt-1 text-xs text-slate-400">
                比如：“3 号柜交换机 IP 改为
                192.168.1.20”或“客户张工电话确认报表按月汇总”
              </p>
            )}
          </div>
        ) : (
          <ol className="site-timeline space-y-6">
            {days.map(({ day, notes: list }) => (
              <li key={day}>
                <h2 className="mb-2 text-xs font-semibold text-slate-400">
                  <time dateTime={day}>{day}</time>
                </h2>
                <ul className="space-y-3">
                  {list.map((n) => (
                    <li
                      key={n.id}
                      data-note-id={n.id}
                      className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <KindBadge kind={n.kind} />
                        {n.kind === "file" && !n.occurred_on && (
                          <span className="text-[11px] text-slate-400">
                            业务日期未记录，按登记日分组
                          </span>
                        )}
                        <button
                          type="button"
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-500 hover:underline"
                          onClick={() => setThreadNoteId(n.id)}
                        >
                          {n.parent_note_id ? "补充 · 查看原事项" : "查看事项"}
                          {n.thread_count > 1
                            ? " · " + n.thread_count + " 条"
                            : ""}
                        </button>
                        {n.deliverable_title && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-600">
                            <ClipboardCheck className="h-3 w-3" />
                            {n.deliverable_title}
                          </span>
                        )}
                        {n.task_title && (
                          <button
                            onClick={() => onOpenTask?.(n.task_id)}
                            className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-500 hover:underline"
                          >
                            <GitBranch className="h-3 w-3 shrink-0" />
                            {n.task_title}
                          </button>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">
                        {n.body}
                      </p>
                      {n.people && (
                        <p className="mt-1.5 text-xs text-slate-400">
                          相关人员：{n.people}
                        </p>
                      )}
                      <NoteExchange note={n} />
                      <NoteFiles
                        files={n.files}
                        onOpenDocument={onOpenDocument}
                        onUnauthorized={authFailed}
                        onChooseVersion={
                          trash
                            ? null
                            : (file) => setVersionChoice({ note: n, file })
                        }
                      />
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-50 pt-2 text-[11px] text-slate-400">
                        <span>
                          {n.author_name} 记录于 {displayTime(n.created)}
                          {n.updated !== n.created && n.version > 1
                            ? " · 已修改"
                            : ""}
                        </span>
                        <span className="flex gap-1">
                          {trash ? (
                            <button
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-emerald-50 hover:text-emerald-600"
                              onClick={() =>
                                act(
                                  () =>
                                    api("/notes/" + n.id + "/restore", "POST", {
                                      version: n.version,
                                    }),
                                  "已恢复",
                                )
                              }
                            >
                              <RotateCcw className="h-3 w-3" />
                              恢复
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-indigo-50 hover:text-indigo-600"
                                onClick={() =>
                                  onCreate({ parent_note_id: n.id })
                                }
                              >
                                <Plus className="h-3 w-3" />
                                补充一条
                              </button>
                              <button
                                aria-label={
                                  "编辑随手记：" + n.body.slice(0, 20)
                                }
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-indigo-50 hover:text-indigo-600"
                                onClick={() => onEdit(n)}
                              >
                                <Pencil className="h-3 w-3" />
                                编辑
                              </button>
                              <button
                                aria-label={
                                  "删除随手记：" + n.body.slice(0, 20)
                                }
                                disabled={busy}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-rose-50 hover:text-rose-500"
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "把这条随手记移入回收站？附件文件保留在资料库，操作会留日志。",
                                    )
                                  )
                                    act(
                                      () =>
                                        api("/notes/" + n.id, "DELETE", {
                                          version: n.version,
                                        }),
                                      "已移入回收站，可在回收站恢复",
                                    );
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                                删除
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>
      {threadNoteId && (
        <NoteThread
          key={project.id + ":" + threadNoteId}
          noteId={threadNoteId}
          project={project}
          revision={revision}
          onClose={() => setThreadNoteId(null)}
          onCreate={onCreate}
          onEdit={onEdit}
          onOpenTask={onOpenTask}
          onOpenDocument={onOpenDocument}
          onChanged={onChanged}
          onUnauthorized={authFailed}
        />
      )}
      {versionChoice && (
        <AttachmentVersionDialog
          projectId={project.id}
          noteId={versionChoice.note.id}
          file={versionChoice.file}
          onClose={() => setVersionChoice(null)}
          onUnauthorized={authFailed}
          onSaved={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
// Files and site-log entries linked to one task, shown in task details.
export function TaskMaterials({ record, user, revision = 0, onAddNote }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (!user) return;
    let live = true;
    api("/records/" + record.id + "/materials")
      .then(
        (r) =>
          live &&
          (setData({ ...r, recordId: record.id, userId: user.id }),
          setError("")),
      )
      .catch((e) => {
        if (live) {
          setData(null);
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [record.id, user?.id, revision]);
  if (!user) return null;
  const visibleData =
    data?.recordId === record.id && data?.userId === user.id ? data : null;
  return (
    <section
      aria-label="相关资料"
      className="mt-5 rounded-2xl border border-slate-100 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-700">相关资料</h4>
        {onAddNote && (
          <button
            className="inline-flex items-center gap-1 text-xs text-indigo-500 hover:underline"
            onClick={() => onAddNote(record)}
          >
            <NotebookPen className="h-3.5 w-3.5" />
            记一条随手记
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
      {visibleData &&
        !visibleData.documents.length &&
        !visibleData.notes.length && (
          <p className="mt-2 text-xs text-slate-400">
            暂无关联的文件或随手记。上传资料时选择这个任务，或在随手记里关联它。
          </p>
        )}
      {visibleData?.documents.length > 0 && (
        <ul className="mt-2 space-y-1">
          {visibleData.documents.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 text-xs text-slate-500"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate">{d.title}</span>
                {!d.published_version_id && (
                  <span className="shrink-0 text-amber-600">工作版</span>
                )}
              </span>
              {d.current_version_id && (
                <button
                  aria-label={"下载：" + d.title}
                  className="shrink-0 rounded p-1 hover:text-indigo-600"
                  onClick={() =>
                    internalDownload(
                      "/documents/" +
                        d.id +
                        "/versions/" +
                        d.current_version_id +
                        "/download",
                      d.filename || d.title,
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {visibleData?.notes.length > 0 && (
        <ul className="mt-3 space-y-2">
          {visibleData.notes.map((n) => (
            <li key={n.id} className="rounded-xl bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <KindBadge kind={n.kind} />
                <span>
                  {n.kind === "file" && !n.occurred_on
                    ? "按登记日显示：" + dayOf(n)
                    : dayOf(n)}
                </span>
                <span>{n.author_name}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">
                {n.body}
              </p>
              <NoteExchange note={n} />
              <NoteFiles
                files={n.files}
                onUnauthorized={() => {
                  setData(null);
                  setError("登录已失效，请重新登录后查看相关资料。");
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
