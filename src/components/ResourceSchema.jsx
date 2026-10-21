import React, { useState } from "react";
import { Plus, Settings2, ArrowUp, ArrowDown, X } from "lucide-react";
import { api } from "../api.js";
import {
  Field,
  FormActions,
  FormError,
  Modal,
  inputClass,
  primary,
  secondary,
} from "./UI.jsx";

const fieldTypes = {
  text: "单行文字",
  textarea: "多行文字",
  number: "数字",
  date: "日期",
  select: "下拉选择",
  boolean: "是 / 否",
};
const families = { software: "软件", hardware: "硬件", other: "其他" };
const newField = () => ({
  key: "f_" + crypto.randomUUID().replaceAll("-", ""),
  label: "",
  type: "text",
  required: false,
  archived: false,
  options: [],
});
export const resourceCategoryName = (resource) =>
  resource.category?.name || resource.type;

export function ResourceFields({ category, values, onChange }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-label="分类专属字段">
      {category.fields
        .filter(
          (f) =>
            !f.archived ||
            (values[f.key] !== undefined && values[f.key] !== ""),
        )
        .map((f) => {
          const value = values[f.key] ?? "";
          const props = {
            className: inputClass,
            value,
            required: f.required && !f.archived,
            onChange: (e) =>
              onChange(
                f.key,
                f.type === "number"
                  ? e.target.value === ""
                    ? ""
                    : Number(e.target.value)
                  : f.type === "boolean"
                    ? e.target.value === ""
                      ? ""
                      : e.target.value === "true"
                    : e.target.value,
              ),
          };
          return (
            <div
              className={f.type === "textarea" ? "sm:col-span-2" : ""}
              key={f.key}
            >
              <Field
                label={
                  f.label +
                  (f.required && !f.archived ? " *" : "") +
                  (f.archived ? "（已停用，保留原值）" : "")
                }
              >
                {f.type === "textarea" ? (
                  <textarea {...props} rows={3} maxLength={3000} />
                ) : f.type === "select" || f.type === "boolean" ? (
                  <select {...props} value={String(value)}>
                    <option value="">请选择</option>
                    {f.type === "boolean" ? (
                      <>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </>
                    ) : (
                      f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))
                    )}
                  </select>
                ) : (
                  <input
                    {...props}
                    type={
                      f.type === "number" || f.type === "date" ? f.type : "text"
                    }
                    step={f.type === "number" ? "any" : undefined}
                    maxLength={1000}
                  />
                )}
              </Field>
            </div>
          );
        })}
    </div>
  );
}

export function ResourceFieldDetails({ item, categories = [] }) {
  const values = item.field_values || {},
    ownFields = item.category?.fields || [];
  const labels = new Map(
    categories.flatMap((c) => c.fields).map((f) => [f.key, f.label]),
  );
  for (const f of ownFields) labels.set(f.key, f.label);
  const entries = Object.entries(values).filter(
    ([, v]) => v !== "" && v != null,
  );
  if (!entries.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-label="资源专属信息">
      {entries.map(([key, value]) => (
        <div className="rounded-xl bg-slate-50 p-3" key={key}>
          <p className="text-xs text-slate-400">
            {labels.get(key) || "历史字段"}
            {!ownFields.some((f) => f.key === key && !f.archived)
              ? " · 历史保留"
              : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
            {typeof value === "boolean" ? (value ? "是" : "否") : String(value)}
          </p>
        </div>
      ))}
    </div>
  );
}

export function ResourceCategoryManager({
  categories,
  projectId,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const update = (key, value) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const editField = (i, key, value) =>
    update(
      "fields",
      form.fields.map((f, j) => (j === i ? { ...f, [key]: value } : f)),
    );
  function select(value) {
    if (dirty && !window.confirm("切换将放弃当前分类未保存的修改，是否继续？"))
      return;
    setForm(
      value
        ? structuredClone(value)
        : {
            name: "",
            family: "software",
            base_type: "application",
            fields: [],
            archived: false,
          },
    );
    setDirty(false);
    setError(null);
  }
  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(
        form.id
          ? "/resource-categories/" + form.id
          : "/projects/" + projectId + "/resource-categories",
        form.id ? "PATCH" : "POST",
        {
          name: form.name,
          family: form.family,
          base_type: form.base_type,
          fields: form.fields.map((f) => ({
            ...f,
            options:
              f.type === "select"
                ? f.options.map((o) => o.trim()).filter(Boolean)
                : [],
          })),
          archived: form.archived,
          ...(form.id ? { version: form.version } : {}),
        },
      );
      setDirty(false);
      await onSaved("分类和字段已保存");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function move(i, offset) {
    const fields = [...form.fields];
    [fields[i], fields[i + offset]] = [fields[i + offset], fields[i]];
    update("fields", fields);
  }
  return (
    <Modal
      title="分类与字段"
      sub="按项目维护软件和硬件模板。普通字段用于资料，密码和密钥请放在账号库。"
      icon={Settings2}
      wide
      onClose={onClose}
    >
      <div className="grid max-h-[68dvh] gap-5 overflow-y-auto px-6 pb-6 md:grid-cols-[180px_1fr]">
        <div className="space-y-2">
          <button
            type="button"
            className={secondary + " w-full"}
            disabled={busy}
            onClick={() => select(null)}
          >
            <Plus size={14} />
            新建分类
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              onClick={() => select(c)}
              className={
                "w-full rounded-xl px-3 py-2.5 text-left text-sm " +
                (form?.id === c.id
                  ? "bg-indigo-50 text-indigo-600"
                  : "bg-slate-50 text-slate-600 hover:bg-slate-100")
              }
            >
              <span className="break-words">{c.name}</span>
              <span className="mt-1 block text-[11px] text-slate-400">
                {families[c.family]} ·{" "}
                {c.archived
                  ? "已停用"
                  : c.fields.filter((f) => !f.archived).length + " 个字段"}
              </span>
            </button>
          ))}
        </div>
        {!form ? (
          <p className="py-12 text-center text-sm text-slate-400">
            选择分类进行修改，或新建分类
          </p>
        ) : (
          <form onSubmit={save} className="min-w-0 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="分类名称">
                <input
                  required
                  maxLength={80}
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                />
              </Field>
              <Field label="所属大类">
                <select
                  className={inputClass}
                  value={form.family}
                  onChange={(e) => {
                    update("family", e.target.value);
                    update(
                      "base_type",
                      e.target.value === "software"
                        ? "application"
                        : e.target.value === "hardware"
                          ? "device"
                          : "other",
                    );
                  }}
                >
                  {Object.entries(families).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!form.id && (
              <Field label="从现有分类复制字段（可选）">
                <select
                  className={inputClass}
                  defaultValue=""
                  onChange={(e) => {
                    const c = categories.find((c) => c.id === e.target.value);
                    if (c) {
                      update(
                        "fields",
                        structuredClone(
                          c.fields.filter((f) => !f.archived),
                        ).map((f) => ({
                          ...f,
                          key: [
                            "model",
                            "serial_number",
                            "location",
                            "software_version",
                          ].includes(f.key)
                            ? f.key
                            : newField().key,
                        })),
                      );
                      update("family", c.family);
                      update("base_type", c.base_type);
                    }
                  }}
                >
                  <option value="">空白模板</option>
                  {categories
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={form.archived}
                onChange={(e) => update("archived", e.target.checked)}
              />
              停用分类（原资源仍可查看和编辑）
            </label>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">填写字段</h3>
              <button
                type="button"
                className={secondary}
                disabled={form.fields.length >= 32}
                onClick={() => update("fields", [...form.fields, newField()])}
              >
                <Plus size={13} />
                添加字段
              </button>
            </div>
            {form.fields.map((f, i) => (
              <div
                key={f.key}
                className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3"
                aria-label={"字段" + (i + 1)}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={"字段名称" + (i + 1)}>
                    <input
                      className={inputClass}
                      required
                      maxLength={60}
                      value={f.label}
                      onChange={(e) => editField(i, "label", e.target.value)}
                    />
                  </Field>
                  <Field label={"字段类型" + (i + 1)}>
                    <select
                      className={inputClass}
                      disabled={
                        !!categories
                          .find((c) => c.id === form.id)
                          ?.fields.some((p) => p.key === f.key)
                      }
                      value={f.type}
                      onChange={(e) => editField(i, "type", e.target.value)}
                    >
                      {Object.entries(fieldTypes).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {f.type === "select" && (
                  <Field
                    label={"下拉选项" + (i + 1)}
                    hint="每行一个选项；已被资源使用的选项不能移除。"
                  >
                    <textarea
                      rows={3}
                      className={inputClass}
                      value={f.options.join("\n")}
                      onChange={(e) =>
                        editField(i, "options", e.target.value.split("\n"))
                      }
                    />
                  </Field>
                )}
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) =>
                        editField(i, "required", e.target.checked)
                      }
                    />
                    必填
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={f.archived}
                      onChange={(e) =>
                        editField(i, "archived", e.target.checked)
                      }
                    />
                    停用字段
                  </label>
                  <div className="ml-auto flex gap-2">
                    <button
                      aria-label={"上移字段" + (i + 1)}
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      className="disabled:opacity-25"
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      aria-label={"下移字段" + (i + 1)}
                      type="button"
                      disabled={i === form.fields.length - 1}
                      onClick={() => move(i, 1)}
                      className="disabled:opacity-25"
                    >
                      <ArrowDown size={14} />
                    </button>
                    {!categories
                      .find((c) => c.id === form.id)
                      ?.fields.some((p) => p.key === f.key) && (
                      <button
                        type="button"
                        aria-label={"移除字段" + (i + 1)}
                        onClick={() =>
                          update(
                            "fields",
                            form.fields.filter((_, j) => j !== i),
                          )
                        }
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <p className="text-xs leading-relaxed text-slate-400">
              保存后字段标识与类型固定；不再使用的字段可停用，已有填写内容会保留。
            </p>
            <FormError error={error} />
            <FormActions busy={busy} onClose={onClose} />
          </form>
        )}
      </div>
    </Modal>
  );
}
