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
import { NOTE_KINDS, noteKind } from "../notes.js";
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
export function NoteFiles({ files, onRemove }) {
  if (!files?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li
          key={f.document_id}
          className="inline-flex max-w-full items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-500 ring-1 ring-slate-100"
        >
          <Paperclip className="h-3 w-3 shrink-0" />
          {f.deleted || !f.current_version_id ? (
            <span className="truncate line-through">{f.title}（已删除）</span>
          ) : (
            <button
              type="button"
              className="truncate hover:text-indigo-600 hover:underline"
              title={"下载 " + (f.filename || f.title)}
              onClick={() =>
                internalDownload(
                  "/documents/" +
                    f.document_id +
                    "/versions/" +
                    f.current_version_id +
                    "/download",
                  f.filename || f.title,
                )
              }
            >
              {f.filename || f.title}
            </button>
          )}
          {f.size > 0 && (
            <span className="shrink-0 text-slate-300">{fileSize(f.size)}</span>
          )}
          {onRemove && (
            <button
              type="button"
              aria-label={"移除附件：" + (f.filename || f.title)}
              className="shrink-0 rounded p-0.5 text-slate-300 hover:text-rose-500"
              onClick={() => onRemove(f)}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
// Shared by the timeline, the checklist ("记一条") and task details.
export function NoteDialog({
  project,
  user,
  records = [],
  people = [],
  note: initial,
  draft = {},
  onClose,
  onSaved,
}) {
  const [note, setNote] = useState(initial || null),
    [kind, setKind] = useState(initial?.kind || draft.kind || "site"),
    [body, setBody] = useState(initial?.body || ""),
    [occurred, setOccurred] = useState(
      initial ? initial.occurred_on : beijingDate(),
    ),
    [names, setNames] = useState(splitNames(initial?.people)),
    [deliverableId, setDeliverableId] = useState(
      initial?.deliverable_id || draft.deliverable_id || "",
    ),
    [taskId, setTaskId] = useState(initial?.task_id || draft.task_id || ""),
    [deliverables, setDeliverables] = useState([]),
    [pending, setPending] = useState([]),
    [progress, setProgress] = useState(""),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api("/projects/" + project.id + "/deliverables")
      .then((r) => live && setDeliverables(r.items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.id]);
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
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    let saved = note;
    try {
      const fields = {
        kind,
        body,
        occurred_on: occurred || "",
        people: names.join("、"),
        deliverable_id: deliverableId || null,
        task_id: taskId || null,
      };
      saved = (
        await (saved
          ? api("/notes/" + saved.id, "PATCH", {
              ...fields,
              version: saved.version,
            })
          : api("/projects/" + project.id + "/notes", "POST", fields))
      ).note;
      setNote(saved);
      // The text is saved before any upload, so a failed attachment never loses it.
      const failed = [];
      if (pending.length) {
        const folder = await ensureFolder(project.id, ATTACHMENT_FOLDER);
        for (const [index, file] of pending.entries()) {
          try {
            const result = await uploadFile(
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
                onProgress: ({ loaded, total }) =>
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
            saved = (
              await api("/notes/" + saved.id + "/files", "POST", {
                document_id: result.document_id,
              })
            ).note;
          } catch (uploadError) {
            failed.push({ file, message: uploadError.message });
          }
        }
        setNote(saved);
      }
      if (failed.length) {
        setPending(failed.map((f) => f.file));
        setError(
          "内容已保存，以下附件未上传成功，可再点保存重试：" +
            failed.map((f) => f.file.name + "（" + f.message + "）").join("、"),
        );
        await onSaved(saved, { keepOpen: true });
        return;
      }
      await onSaved(saved);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }
  async function detach(file) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = (
        await api(
          "/notes/" + note.id + "/files/" + file.document_id,
          "DELETE",
          {},
        )
      ).note;
      setNote(next);
      await onSaved(next, { keepOpen: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={note ? "编辑随手记" : "记一条随手记"}
      sub={project.name + " · 现场设置、口头约定、群里的文件，当天记下来"}
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
                  onClick={() => setKind(k.id)}
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
            <Field label="发生日期" hint="可以补记，例如前天在现场改的设置">
              <input
                type="date"
                value={occurred}
                onChange={(e) => setOccurred(e.target.value)}
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
              <NoteFiles files={note.files} onRemove={busy ? null : detach} />
            )}
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
            disabled={busy || !body.trim()}
            className={primary}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function dayOf(note) {
  return note.occurred_on || beijingDate(new Date(note.created));
}
export default function SiteLog({
  project,
  user,
  revision = 0,
  onLogin,
  onCreate,
  onEdit,
  onOpenTask,
  onChanged = () => {},
}) {
  const [notes, setNotes] = useState([]),
    [loaded, setLoaded] = useState(false),
    [trash, setTrash] = useState(false),
    [kind, setKind] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const seq = useRef(0);
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
        setError(e.message);
        setLoaded(true);
      }
    }
  }, [project?.id, user?.id, trash]);
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load, revision]);
  if (!user)
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(message);
      await load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const q = query.trim().toLocaleLowerCase();
  const visible = notes.filter(
    (n) =>
      (!kind || n.kind === kind) &&
      (!q ||
        [
          n.body,
          n.people,
          n.author_name,
          n.deliverable_title,
          n.task_title,
          ...n.files.map((f) => f.filename || f.title),
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
            现场改的设置、口头的约定、群里收到的文件，当天记下来；换人接手时按时间线就能查到。
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
            placeholder="搜索内容、人员、附件名"
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
              onClick={() => setKind(k.id)}
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
                      <NoteFiles files={n.files} />
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
    </section>
  );
}
// Files and site-log entries linked to one task, shown in task details.
export function TaskMaterials({ record, user, revision = 0, onAddNote }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!user) return;
    let live = true;
    api("/records/" + record.id + "/materials")
      .then((r) => live && (setData(r), setError("")))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [record.id, user?.id, revision]);
  if (!user) return null;
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
      {data && !data.documents.length && !data.notes.length && (
        <p className="mt-2 text-xs text-slate-400">
          暂无关联的文件或随手记。上传资料时选择这个任务，或在随手记里关联它。
        </p>
      )}
      {data?.documents.length > 0 && (
        <ul className="mt-2 space-y-1">
          {data.documents.map((d) => (
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
      {data?.notes.length > 0 && (
        <ul className="mt-3 space-y-2">
          {data.notes.map((n) => (
            <li key={n.id} className="rounded-xl bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <KindBadge kind={n.kind} />
                <span>{dayOf(n)}</span>
                <span>{n.author_name}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">
                {n.body}
              </p>
              <NoteFiles files={n.files} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
