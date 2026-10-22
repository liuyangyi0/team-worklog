import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardCheck,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Upload,
  NotebookPen,
  BookmarkPlus,
  Star,
  X,
} from "lucide-react";
import { api } from "../api.js";
import { uploadFile, ensureFolder } from "../library-api.js";
import {
  STAGES,
  PROJECT_KINDS,
  EVIDENCE_KINDS,
  checklistProgress,
  evidenceProgress,
} from "../checklist.js";
import {
  Modal,
  primary,
  secondary,
  inputClass,
  FormError,
  Field,
} from "./UI.jsx";

const statusLabels = {
  missing: "缺少资料",
  draft: "只有工作版",
  ready: "已齐备",
  recorded: "已有记录",
  linked: "已关联",
  "needs-file": "待提供文件",
  "needs-published": "待提供正式版",
  "needs-credential": "待关联账号",
  "needs-configuration": "待关联配置",
  "not-applicable": "不适用",
};
const statusClasses = {
  missing: "bg-rose-50 text-rose-500",
  draft: "bg-amber-50 text-amber-600",
  ready: "bg-emerald-50 text-emerald-600",
  recorded: "bg-sky-50 text-sky-600",
  linked: "bg-emerald-50 text-emerald-600",
  "needs-file": "bg-rose-50 text-rose-500",
  "needs-published": "bg-amber-50 text-amber-600",
  "needs-credential": "bg-rose-50 text-rose-500",
  "needs-configuration": "bg-rose-50 text-rose-500",
  "not-applicable": "bg-slate-100 text-slate-400",
};
const OTHER_STAGE = "其他资料";
function groupByStage(items) {
  const groups = new Map([...STAGES, OTHER_STAGE].map((s) => [s, []]));
  for (const item of items)
    groups
      .get(STAGES.includes(item.stage) ? item.stage : OTHER_STAGE)
      .push(item);
  return [...groups].filter(([, list]) => list.length);
}
export default function Deliverables({
  project,
  user,
  members = [],
  onChanged = () => {},
  onAddNote,
}) {
  const [items, setItems] = useState([]),
    [templates, setTemplates] = useState([]),
    [documents, setDocuments] = useState([]),
    [folders, setFolders] = useState([]),
    [evidenceOptions, setEvidenceOptions] = useState({
      credentials: [],
      configurations: [],
    }),
    [gaps, setGaps] = useState({
      unverified_credentials: [],
      unconfirmed_configurations: [],
      unowned_documents: [],
    }),
    [loaded, setLoaded] = useState(false),
    [edit, setEdit] = useState(null),
    [saving, setSaving] = useState(null),
    [uploading, setUploading] = useState({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const seq = useRef(0),
    alive = useRef(true);
  const load = useCallback(async () => {
    if (!project || !user) return;
    const serial = ++seq.current;
    try {
      const [list, docs, saved] = await Promise.all([
        api(`/projects/${project.id}/deliverables`),
        api(`/projects/${project.id}/documents`),
        api("/checklist-templates"),
      ]);
      if (serial !== seq.current || !alive.current) return;
      setItems(list.items);
      setDocuments(docs.documents);
      setFolders(docs.folders || []);
      setTemplates(saved.templates);
      setEvidenceOptions(
        list.evidence_options || { credentials: [], configurations: [] },
      );
      setGaps(
        list.gaps || {
          unverified_credentials: [],
          unconfirmed_configurations: [],
          unowned_documents: [],
        },
      );
      setLoaded(true);
      setError("");
    } catch (e) {
      if (serial === seq.current && alive.current) setError(e.message);
    }
  }, [project?.id, user?.id]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      seq.current++;
    };
  }, [load]);
  async function run(work, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (alive.current) {
        setEdit(null);
        setSaving(null);
        if (message) setNotice(message);
        await load();
        onChanged();
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // Files uploaded from the checklist land in one folder per stage, so the
  // library stays organised without asking people to pick a folder.
  const stageFolder = (stage) =>
    ensureFolder(
      project.id,
      STAGES.includes(stage) ? stage : OTHER_STAGE,
      folders,
    );
  async function uploadTo(item, files) {
    const list = [...files];
    if (!list.length) return;
    setError("");
    setNotice("");
    try {
      for (const [index, file] of list.entries()) {
        const progress = (loaded, total) =>
          alive.current &&
          setUploading((old) => ({
            ...old,
            [item.id]:
              (list.length > 1 ? index + 1 + "/" + list.length + " · " : "") +
              Math.round((loaded / Math.max(total, 1)) * 100) +
              "%",
          }));
        progress(0, 1);
        const current = (
          await api(`/projects/${project.id}/deliverables`)
        ).items.find((i) => i.id === item.id);
        if (!current) throw new Error("资料项已被删除，请刷新");
        const options = {
          userId: user.id,
          projectId: project.id,
          onProgress: ({ loaded, total }) => progress(loaded, total),
        };
        // One file on an item that already has a document is its next version;
        // several files are separate documents filed under the item.
        if (
          list.length === 1 &&
          current.document_id &&
          current.working_version_id
        )
          await uploadFile(
            file,
            {
              document_id: current.document_id,
              base_version_id: current.working_version_id,
              note: "通过资料清单上传",
            },
            options,
          );
        else {
          const result = await uploadFile(
            file,
            {
              title: file.name,
              folder_id: await stageFolder(current.stage),
              category: current.title,
              owner: current.owner || "",
              tags: [],
            },
            options,
          );
          if (!current.document_id || current.document_deleted)
            await api(`/deliverables/${current.id}`, "PATCH", {
              version: current.version,
              document_id: result.document_id,
            });
        }
      }
      if (alive.current)
        setNotice(
          "已上传到“" +
            item.title +
            "”" +
            (list.length > 1 ? "，共 " + list.length + " 个文件" : ""),
        );
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) {
        setUploading((old) => {
          const next = { ...old };
          delete next[item.id];
          return next;
        });
        await load();
        onChanged();
      }
    }
  }
  if (!user || !project) return null;
  const progress = checklistProgress(items);
  const evidence = evidenceProgress(items);
  const gapGroups = [
    {
      key: "unverified_credentials",
      title: "账号待核实",
      help: "资源与配置 → 账号：搜索名称，登记真实设备或服务的核实结果。",
      module: "resources",
      tab: "credentials",
    },
    {
      key: "unconfirmed_configurations",
      title: "配置未确认现场应用",
      help: "资源与配置 → 配置：搜索名称，登记具体现场实例的实际使用版本。",
      module: "resources",
      tab: "configurations",
    },
    {
      key: "unowned_documents",
      title: "文件无人维护",
      help: "打开文件详情，补充维护人。",
      module: "documents",
    },
  ];
  const gapLink = (group, item) => {
    const params = new URLSearchParams({
      project: project.id,
      module: group.module,
    });
    if (group.module === "documents") params.set("document", item.id);
    else {
      params.set("resourceTab", group.tab);
      params.set(
        group.tab === "credentials" ? "credential" : "configuration",
        item.id,
      );
    }
    return "?" + params.toString();
  };
  const applyButtons = (
    <>
      {PROJECT_KINDS.map((kind) => (
        <button
          key={kind.id}
          disabled={busy}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-500 hover:border-indigo-200 hover:text-indigo-500"
          onClick={() =>
            run(async () => {
              const result = await api(
                `/projects/${project.id}/deliverables/apply`,
                "POST",
                { kind: kind.id },
              );
              setNotice(
                result.added
                  ? "已添加 " + result.added + " 项"
                  : "清单中已包含这些资料项",
              );
            })
          }
        >
          {kind.label}
        </button>
      ))}
      {templates.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center rounded-lg border border-indigo-100 bg-indigo-50/60 text-indigo-600"
        >
          <button
            disabled={busy}
            title={"由 " + t.creator_name + " 保存 · " + t.items.length + " 项"}
            className="py-1.5 pl-2.5 pr-1"
            onClick={() =>
              run(async () => {
                const result = await api(
                  `/projects/${project.id}/deliverables/apply`,
                  "POST",
                  { template_id: t.id },
                );
                setNotice(
                  result.added
                    ? "已按模板“" + t.name + "”添加 " + result.added + " 项"
                    : "清单中已包含这些资料项",
                );
              })
            }
          >
            {t.name}
          </button>
          <button
            aria-label={"删除模板：" + t.name}
            disabled={busy}
            className="rounded-r-lg px-1.5 py-1.5 text-indigo-300 hover:text-rose-500"
            onClick={() => {
              if (
                window.confirm(
                  "删除模板“" + t.name + "”？已套用的项目清单不受影响。",
                )
              )
                run(() =>
                  api(`/checklist-templates/${t.id}`, "DELETE", {
                    version: t.version,
                  }),
                );
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </>
  );
  return (
    <section
      aria-label="交接资料清单"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-700">
            <ClipboardCheck className="h-5 w-5 text-indigo-400" />
            交接资料清单
          </h2>
          {items.length > 0 && (
            <p className="checklist-progress mt-1 text-xs text-slate-500">
              {progress.required ? (
                <>
                  必需资料已提供{" "}
                  <strong className="text-slate-700">
                    {progress.provided}/{progress.required}
                  </strong>
                  {progress.missing > 0 && (
                    <span className="ml-1.5 text-rose-500">
                      缺 {progress.missing} 项
                    </span>
                  )}
                  {progress.unpublished > 0 && (
                    <span className="ml-1.5 text-amber-600">
                      {progress.unpublished} 项待发布正式版
                    </span>
                  )}
                  <span
                    className={
                      "ml-1.5 " +
                      (evidence.missing ? "text-amber-600" : "text-emerald-600")
                    }
                  >
                    · 符合证据要求 {evidence.met}/{evidence.required}
                  </span>
                </>
              ) : (
                "尚未标记必需资料"
              )}
              <span className="ml-1.5 text-slate-400">
                · 资料状态不影响任务完成统计
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondary}
            disabled={busy}
            onClick={load}
            aria-label="刷新交接清单"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {items.length > 0 && (
            <button
              className={secondary}
              disabled={busy}
              onClick={() => setSaving({ name: "" })}
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              另存为模板
            </button>
          )}
          <button
            className={primary}
            disabled={busy}
            onClick={() => {
              load();
              setEdit({
                title: "",
                owner: "",
                stage: "",
                hint: "",
                required: false,
                applicable: true,
                document_id: "",
                version_id: "",
                evidence_kind: "record",
                credential_id: "",
                configuration_id: "",
              });
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            添加资料项
          </button>
        </div>
      </div>
      {progress.required > 0 && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label="必需资料完整度"
          aria-valuemin={0}
          aria-valuemax={progress.required}
          aria-valuenow={progress.provided}
        >
          <div
            className="h-full rounded-full bg-emerald-400 transition-all"
            style={{
              width: (progress.provided / progress.required) * 100 + "%",
            }}
          />
        </div>
      )}
      {loaded && !items.length ? (
        <div className="checklist-empty mt-4 rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/40 px-5 py-6 text-center">
          <p className="text-sm font-medium text-slate-600">
            这个项目还没有资料清单
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            选择项目类型生成起步清单，之后可以增删资料项、标记不适用；改好的清单可另存为模板，供同类项目使用。
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
            {applyButtons}
          </div>
        </div>
      ) : (
        items.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>补充清单：</span>
            {applyButtons}
          </div>
        )
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-emerald-600">
          {notice}
        </p>
      )}
      <FormError error={error} />
      {loaded && (
        <details className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3 text-xs">
          <summary className="cursor-pointer font-medium text-slate-600">
            交接检查
            <span className="ml-2 font-normal text-slate-400">
              {gapGroups
                .map(
                  (group) => group.title + " " + (gaps[group.key]?.length || 0),
                )
                .join(" · ")}
            </span>
          </summary>
          <p className="mt-2 text-slate-400">
            这里核对现有登记，不代表已在现场自动检测或客户已验收。
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {gapGroups.map((group) => (
              <div
                key={group.key}
                className="min-w-0 rounded-xl border border-slate-100 bg-white p-3"
              >
                <p className="font-medium text-slate-600">
                  {group.title} · {gaps[group.key]?.length || 0}
                </p>
                <p className="mt-1 leading-relaxed text-slate-400">
                  {group.help}
                </p>
                <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                  {(gaps[group.key] || []).map((item) => (
                    <li key={item.id}>
                      <a
                        className="break-words text-indigo-500 hover:underline"
                        href={gapLink(group, item)}
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                  {!gaps[group.key]?.length && (
                    <li className="text-emerald-600">暂无此类缺口</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
      {items.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="checklist-table w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-2 font-medium">应交资料</th>
                <th className="py-2 font-medium">维护人</th>
                <th className="py-2 font-medium">现有资料</th>
                <th className="py-2 font-medium">状态</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            {groupByStage(items).map(([stage, list]) => (
              <tbody
                key={stage}
                className="divide-y divide-slate-100 border-t border-slate-100"
              >
                <tr>
                  <th
                    colSpan={5}
                    scope="rowgroup"
                    className="bg-slate-50/70 px-2 py-1.5 text-[11px] font-medium tracking-wide text-slate-400"
                  >
                    {stage}
                  </th>
                </tr>
                {list.map((item) => (
                  <tr
                    key={item.id}
                    className={item.applicable ? "" : "opacity-60"}
                  >
                    <td className="py-3 pr-3 text-slate-700">
                      <span className="inline-flex items-center gap-1">
                        {item.required && (
                          <Star
                            aria-label="必需"
                            className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400"
                          />
                        )}
                        {item.title}
                      </span>
                      {item.hint && (
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">
                          {item.hint}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[11px] text-indigo-400">
                        {EVIDENCE_KINDS.find(
                          (kind) => kind.id === item.evidence_kind,
                        )?.label || "记录即可"}
                      </span>
                    </td>
                    <td className="pr-3 text-slate-500">{item.owner || "—"}</td>
                    <td className="max-w-52 py-3 pr-3 text-xs text-slate-400">
                      <span className="break-words">
                        {item.document_title || "尚未关联文件"}
                      </span>
                      {item.document_id && (
                        <span className="mt-0.5 block">
                          {item.version_id
                            ? `固定 V${item.number || "?"}`
                            : "跟随正式版"}
                        </span>
                      )}
                      {item.note_count > 0 && (
                        <span className="mt-0.5 block text-sky-600">
                          随手记 {item.note_count} 条
                        </span>
                      )}
                      {item.evidence_title && (
                        <span className="mt-0.5 block text-indigo-500">
                          {item.evidence_kind === "credential"
                            ? "账号："
                            : "配置："}
                          {item.evidence_title}
                        </span>
                      )}
                    </td>
                    <td className="pr-3">
                      <span
                        className={
                          "whitespace-nowrap rounded-full px-2 py-1 text-xs " +
                          (item.status === "missing" && !item.required
                            ? statusClasses["not-applicable"]
                            : statusClasses[item.status])
                        }
                      >
                        {uploading[item.id]
                          ? "上传中 " + uploading[item.id]
                          : item.status === "missing" && !item.required
                            ? "未提供"
                            : statusLabels[item.status]}
                      </span>
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {item.applicable && (
                          <label
                            className={
                              "relative cursor-pointer rounded-lg p-2 text-slate-400 hover:bg-indigo-50 hover:text-indigo-500 " +
                              (uploading[item.id]
                                ? "pointer-events-none opacity-40"
                                : "")
                            }
                            title={
                              item.document_id
                                ? "上传新版本"
                                : "上传文件到这一项"
                            }
                          >
                            <Upload className="h-3.5 w-3.5" />
                            <input
                              type="file"
                              multiple
                              aria-label={"上传到：" + item.title}
                              className="sr-only"
                              disabled={Boolean(uploading[item.id])}
                              onChange={(event) => {
                                const files = event.target.files;
                                uploadTo(item, files).finally(() => {
                                  event.target.value = "";
                                });
                              }}
                            />
                          </label>
                        )}
                        {item.applicable && onAddNote && (
                          <button
                            className="rounded-lg p-2 text-slate-400 hover:bg-sky-50 hover:text-sky-600"
                            aria-label={"随手记：" + item.title}
                            title="记一条随手记到这一项"
                            onClick={() => onAddNote(item)}
                          >
                            <NotebookPen className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          className="rounded-lg p-2 text-slate-400 hover:bg-indigo-50 hover:text-indigo-500"
                          aria-label={"编辑资料项：" + item.title}
                          disabled={busy}
                          onClick={() => {
                            load();
                            setEdit({ ...item });
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          aria-label={"删除资料项：" + item.title}
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                "删除清单项“" +
                                  item.title +
                                  "”？关联文件保留，操作会留日志。",
                              )
                            )
                              run(() =>
                                api(`/deliverables/${item.id}`, "DELETE", {
                                  version: item.version,
                                }),
                              );
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {saving && (
        <Modal
          title="另存为清单模板"
          sub="保存当前适用的资料项及证据要求，不复制关联文件、账号和配置"
          icon={BookmarkPlus}
          onClose={() => !busy && setSaving(null)}
        >
          <form
            className="space-y-4 px-6 pb-6"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () =>
                  api("/checklist-templates", "POST", {
                    name: saving.name,
                    project_id: project.id,
                  }),
                "模板已保存",
              );
            }}
          >
            <Field label="模板名称">
              <input
                className={inputClass}
                required
                maxLength={60}
                placeholder="例如：智慧园区项目"
                value={saving.name}
                onChange={(e) => setSaving({ name: e.target.value })}
              />
            </Field>
            <FormError error={error} />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={secondary}
                disabled={busy}
                onClick={() => setSaving(null)}
              >
                取消
              </button>
              <button className={primary} disabled={busy}>
                {busy ? "保存中…" : "保存模板"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {edit && (
        <Modal
          title={edit.id ? "修改交接资料项" : "添加交接资料项"}
          sub="指定应交资料、所属阶段及其维护人"
          onClose={() => {
            if (!busy) {
              setEdit(null);
              setError("");
            }
          }}
          icon={ClipboardCheck}
        >
          <form
            className="space-y-4 px-6 pb-6"
            onSubmit={(event) => {
              event.preventDefault();
              run(() =>
                api(
                  edit.id
                    ? `/deliverables/${edit.id}`
                    : `/projects/${project.id}/deliverables`,
                  edit.id ? "PATCH" : "POST",
                  {
                    title: edit.title,
                    owner: edit.owner,
                    stage: edit.stage || "",
                    hint: edit.hint || "",
                    required: Boolean(edit.required),
                    applicable: Boolean(edit.applicable),
                    version: edit.version,
                    document_id: edit.document_id || null,
                    version_id: edit.version_id || null,
                    evidence_kind: edit.evidence_kind || "record",
                    credential_id: edit.credential_id || null,
                    configuration_id: edit.configuration_id || null,
                  },
                ),
              );
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <label className="block text-xs text-slate-500">
                应交资料名称
                <input
                  className={inputClass + " mt-1.5"}
                  required
                  maxLength={200}
                  value={edit.title}
                  onChange={(event) =>
                    setEdit({ ...edit, title: event.target.value })
                  }
                />
              </label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="所属阶段">
                  <select
                    className={inputClass}
                    value={edit.stage || ""}
                    onChange={(event) =>
                      setEdit({ ...edit, stage: event.target.value })
                    }
                  >
                    <option value="">{OTHER_STAGE}</option>
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="block text-xs text-slate-500">
                  维护人
                  <input
                    className={inputClass + " mt-1.5"}
                    list="deliverable-members"
                    maxLength={100}
                    value={edit.owner}
                    onChange={(event) =>
                      setEdit({ ...edit, owner: event.target.value })
                    }
                  />
                  <datalist id="deliverable-members">
                    {members.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
              </div>
              <label className="block text-xs text-slate-500">
                填写说明（选填）
                <input
                  className={inputClass + " mt-1.5"}
                  maxLength={300}
                  placeholder="例如：型号、序列号、数量和安装位置"
                  value={edit.hint || ""}
                  onChange={(event) =>
                    setEdit({ ...edit, hint: event.target.value })
                  }
                />
              </label>
              <Field
                label="证据要求"
                hint="普通事项保留记录即可；关键资料可要求文件或账号配置引用。"
              >
                <select
                  className={inputClass}
                  value={edit.evidence_kind || "record"}
                  onChange={(event) =>
                    setEdit({
                      ...edit,
                      evidence_kind: event.target.value,
                      credential_id: null,
                      configuration_id: null,
                    })
                  }
                  disabled={busy}
                >
                  {EVIDENCE_KINDS.map((kind) => (
                    <option key={kind.id} value={kind.id}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </Field>
              {["credential", "configuration"].includes(edit.evidence_kind) && (
                <>
                  <Field
                    label={
                      edit.evidence_kind === "credential"
                        ? "关联加密账号"
                        : "关联加密配置"
                    }
                    hint="这里只保存引用，不会把密码或配置正文复制到清单、模板和普通交付包。"
                  >
                    <select
                      className={inputClass}
                      value={
                        edit.evidence_kind === "credential"
                          ? edit.credential_id || ""
                          : edit.configuration_id || ""
                      }
                      disabled={busy}
                      onChange={(event) =>
                        setEdit({
                          ...edit,
                          [edit.evidence_kind === "credential"
                            ? "credential_id"
                            : "configuration_id"]: event.target.value || null,
                        })
                      }
                    >
                      <option value="">尚未关联</option>
                      {(edit.evidence_kind === "credential"
                        ? evidenceOptions.credentials
                        : evidenceOptions.configurations
                      ).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {((edit.evidence_kind === "credential" &&
                    edit.credential_id &&
                    !evidenceOptions.credentials.some(
                      (item) => item.id === edit.credential_id,
                    )) ||
                    (edit.evidence_kind === "configuration" &&
                      edit.configuration_id &&
                      !evidenceOptions.configurations.some(
                        (item) => item.id === edit.configuration_id,
                      ))) && (
                    <p className="mt-1 text-xs text-amber-600">
                      原关联已失效，请重新选择；保留历史引用不会满足交接要求。
                    </p>
                  )}
                </>
              )}
              <Field label="关联项目文档">
                <select
                  className={inputClass + " mt-1.5"}
                  value={edit.document_id || ""}
                  onChange={(event) =>
                    setEdit({
                      ...edit,
                      document_id: event.target.value,
                      version_id: null,
                    })
                  }
                >
                  <option value="">尚未提供</option>
                  {documents.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title}
                    </option>
                  ))}
                </select>
              </Field>
              {edit.version_id ? (
                <label className="flex items-center gap-2 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={() => setEdit({ ...edit, version_id: null })}
                  />
                  保留固定版本引用（取消后跟随文档正式版）
                </label>
              ) : (
                <p className="text-xs text-slate-400">
                  关联后跟随正式版。要求正式文件时，固定版本也必须曾被发布；“已有资料”不代表客户验收通过。
                </p>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-500">
                  <input
                    type="checkbox"
                    checked={Boolean(edit.required)}
                    onChange={(event) =>
                      setEdit({ ...edit, required: event.target.checked })
                    }
                  />
                  必需资料
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-500">
                  <input
                    type="checkbox"
                    checked={Boolean(edit.applicable)}
                    onChange={(event) =>
                      setEdit({ ...edit, applicable: event.target.checked })
                    }
                  />
                  适用于本项目
                </label>
              </div>
              <FormError error={error} />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  onClick={() => setEdit(null)}
                >
                  取消
                </button>
                <button className={primary} disabled={busy}>
                  {busy ? "保存中…" : "保存资料项"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </section>
  );
}
