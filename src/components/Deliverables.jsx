import React, { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { api } from "../api.js";
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
  "not-applicable": "不适用",
};
const statusClasses = {
  missing: "bg-rose-50 text-rose-500",
  draft: "bg-amber-50 text-amber-600",
  ready: "bg-emerald-50 text-emerald-600",
  "not-applicable": "bg-slate-100 text-slate-400",
};
const templates = {
  software: [
    "需求与接口说明",
    "部署手册",
    "数据库脚本",
    "运行配置说明",
    "测试与验收资料",
    "运维交接说明",
  ],
  equipment: ["设备清单", "网络规划", "接线与安装图", "设备说明书"],
};
export default function Deliverables({ project, user, members = [] }) {
  const [items, setItems] = useState([]),
    [documents, setDocuments] = useState([]),
    [edit, setEdit] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const seq = useRef(0),
    alive = useRef(true);
  const load = useCallback(async () => {
    if (!project || !user) return;
    const serial = ++seq.current;
    try {
      const [list, docs] = await Promise.all([
        api(`/projects/${project.id}/deliverables`),
        api(`/projects/${project.id}/documents`),
      ]);
      if (serial !== seq.current || !alive.current) return;
      setItems(list.items);
      setDocuments(docs.documents);
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
  async function run(work) {
    setBusy(true);
    setError("");
    try {
      await work();
      if (alive.current) {
        setEdit(null);
        await load();
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!user || !project) return null;
  return (
    <section
      aria-label="交接资料清单"
      className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-700">
            <ClipboardCheck className="h-5 w-5 text-indigo-400" />
            交接资料清单
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {
              items.filter((item) => item.applicable && item.status === "ready")
                .length
            }{" "}
            / {items.filter((item) => item.applicable).length} 项已齐备 ·
            资料状态不影响任务完成统计
          </p>
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
          <button
            className={primary}
            disabled={busy}
            onClick={() => {
              load();
              setEdit({
                title: "",
                owner: "",
                applicable: true,
                document_id: "",
                version_id: "",
              });
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            添加资料项
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>快速建立清单：</span>
        {[
          ["software", "软件项目资料"],
          ["equipment", "设备配套资料"],
        ].map(([kind, label]) => (
          <button
            key={kind}
            disabled={busy}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-500 hover:border-indigo-200 hover:text-indigo-500"
            onClick={() =>
              run(async () => {
                const existing = new Set(items.map((item) => item.title));
                for (const title of templates[kind])
                  if (!existing.has(title))
                    await api(`/projects/${project.id}/deliverables`, "POST", {
                      title,
                      applicable: true,
                    });
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <FormError error={error} />
      {!items.length ? (
        <p className="py-7 text-center text-sm text-slate-400">
          添加应交资料项，或使用模板检查项目还缺什么。
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-2 font-medium">应交资料</th>
                <th className="py-2 font-medium">维护人</th>
                <th className="py-2 font-medium">关联文档</th>
                <th className="py-2 font-medium">状态</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 pr-3 text-slate-700">{item.title}</td>
                  <td className="pr-3 text-slate-500">{item.owner || "—"}</td>
                  <td className="max-w-48 py-3 pr-3 text-xs text-slate-400">
                    <span className="break-words">
                      {item.document_title || "尚未关联"}
                    </span>
                    {item.document_id && (
                      <span className="mt-0.5 block">
                        {item.version_id
                          ? `固定 V${item.number || "?"}`
                          : "跟随正式版"}
                      </span>
                    )}
                  </td>
                  <td className="pr-3">
                    <span
                      className={
                        "whitespace-nowrap rounded-full px-2 py-1 text-xs " +
                        statusClasses[item.status]
                      }
                    >
                      {statusLabels[item.status]}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-1">
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
          </table>
        </div>
      )}
      {edit && (
        <Modal
          title={edit.id ? "修改交接资料项" : "添加交接资料项"}
          sub="指定应交资料及其维护人"
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
                    ...edit,
                    document_id: edit.document_id || null,
                    version_id: edit.version_id || null,
                  },
                ),
              );
            }}
          >
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
                关联后跟随该文档的正式版；只有工作版时会显示待发布。
              </p>
            )}
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
          </form>
        </Modal>
      )}
    </section>
  );
}
