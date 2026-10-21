import React, { useEffect, useRef, useState } from "react";
import {
  MapPin,
  Plus,
  Server,
  Trash2,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
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

const statuses = {
  planned: "计划部署",
  testing: "测试运行",
  live: "正式运行",
  retired: "已停用",
};
const methods = {
  onsite: "客户 / 项目现场",
  cloud: "云平台",
  hosted: "第三方托管",
  local: "本地 / 公司内部",
  other: "其他",
};
const fields = [
  ["site", "客户 / 部署单位", 200],
  ["location", "部署位置", 500, "如：某园区A楼3层机房 / 云地域与可用区"],
  ["provider", "云平台 / 托管方", 200],
  ["entry_url", "访问入口", 1000, "如：https://system.example.com"],
  ["network_address", "IP / 网络说明", 1000, "如：内网地址、VPN访问方式"],
  ["install_path", "部署路径", 1000],
  ["deployed_version", "部署版本", 100],
  ["maintainer", "维护人", 100],
  ["contact", "现场联系人", 200],
];
export default function ProjectDeployments({
  projectId,
  resources,
  environments,
}) {
  const [items, setItems] = useState([]),
    [trash, setTrash] = useState(false),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const seq = useRef(0),
    active = useRef(true),
    view = useRef({ projectId, trash });
  view.current = { projectId, trash };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      seq.current++;
    };
  }, []);
  async function load() {
    if (!active.current) return;
    const { projectId: currentProject, trash: currentTrash } = view.current;
    const serial = ++seq.current;
    setBusy(true);
    try {
      const r = await api(
        "/projects/" +
          currentProject +
          "/deployments" +
          (currentTrash ? "?deleted=1" : ""),
      );
      if (active.current && serial === seq.current) {
        setItems(r.deployments);
        setError(null);
      }
    } catch (e) {
      if (active.current && serial === seq.current) setError(e);
    } finally {
      if (active.current && serial === seq.current) setBusy(false);
    }
  }
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [projectId, trash]);
  async function restore(item) {
    setError(null);
    try {
      await api("/deployments/" + item.id + "/restore", "POST", {
        version: item.version,
      });
      await load();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <section className="space-y-4" aria-label="项目部署信息">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-700">
            {trash ? "已移除的部署记录" : "项目部署去向"}
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            记录最终交付到哪里、运行哪个版本、由谁维护。一个项目可有多个部署地点。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondary}
            onClick={() => {
              setTrash(!trash);
              setModal(null);
            }}
          >
            <Trash2 size={14} />
            {trash ? "返回部署信息" : "部署回收站"}
          </button>
          {!trash && (
            <button
              className={primary}
              onClick={() => setModal({ create: true })}
            >
              <Plus size={14} />
              添加部署
            </button>
          )}
        </div>
      </div>
      <input
        className={inputClass + " sm:max-w-sm"}
        aria-label="搜索部署信息"
        placeholder="部署名称、地点、版本、维护人…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <FormError error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        {items
          .filter((d) =>
            Object.values(d)
              .filter((v) => typeof v === "string")
              .join(" ")
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((d) => (
            <div
              key={d.id}
              className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-400">
                  <MapPin size={21} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-semibold text-slate-700">
                    {d.name}
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {d.environment_name || "未指定环境"} · {methods[d.method]}
                  </p>
                </div>
                <span
                  className={
                    "shrink-0 rounded-full px-2 py-1 text-[11px] " +
                    (d.status === "live"
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-slate-100 text-slate-500")
                  }
                >
                  {statuses[d.status]}
                </span>
              </div>
              <div className="mt-4 space-y-2 text-xs text-slate-500">
                <p className="break-words">部署单位：{d.site || "未填写"}</p>
                <p className="break-words">位置：{d.location || "未填写"}</p>
                <p className="break-all">
                  入口：{d.entry_url || d.network_address || "未填写"}
                </p>
                <p>
                  版本：{d.deployed_version || "未登记"} · 维护人：
                  {d.maintainer || "未指定"}
                </p>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <span className="text-[11px] text-slate-400">
                  {d.deployed_at || "部署日期未填写"}
                </span>
                {trash ? (
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() => restore(d)}
                  >
                    <RotateCcw size={13} />
                    恢复
                  </button>
                ) : (
                  <button
                    className="inline-flex items-center gap-1 text-xs text-indigo-500"
                    onClick={() => setModal({ item: d })}
                  >
                    查看 / 修改
                    <ChevronRight size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>
      {!items.length && !busy && (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white py-12 text-center text-sm text-slate-400">
          {trash
            ? "没有已移除的部署记录"
            : "还没有部署信息，可先登记计划，正式交付后补充实际位置和版本。"}
        </p>
      )}
      {busy && (
        <p className="py-5 text-center text-xs text-slate-400">正在载入…</p>
      )}
      {modal && (
        <DeploymentDialog
          key={modal.item?.id || "new"}
          item={modal.item}
          projectId={projectId}
          environments={environments}
          resources={resources}
          onClose={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            await load();
          }}
        />
      )}
    </section>
  );
}
function DeploymentDialog({
  item,
  projectId,
  environments,
  resources,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState({
      name: "",
      status: "planned",
      method: "onsite",
      environment_id: "",
      resource_ids: [],
      deployed_at: "",
      notes: "",
      ...item,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        status: form.status,
        method: form.method,
        environment_id: form.environment_id || null,
        resource_ids: form.resource_ids,
        deployed_at: form.deployed_at,
        notes: form.notes,
        ...Object.fromEntries(fields.map(([k]) => [k, form[k] || ""])),
        ...(item ? { version: item.version } : {}),
      };
      await api(
        item
          ? "/deployments/" + item.id
          : "/projects/" + projectId + "/deployments",
        item ? "PATCH" : "POST",
        payload,
      );
      await onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm("将这条部署记录移入回收站？操作日志会保留。")) return;
    setBusy(true);
    try {
      await api("/deployments/" + item.id, "DELETE", { version: item.version });
      await onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item ? "项目部署 · " + item.name : "添加项目部署"}
      sub="登记实际部署与交付去向；这里只保存资料，不会自动执行部署。"
      icon={MapPin}
      wide
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto px-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="部署名称">
              <input
                autoFocus
                required
                maxLength={200}
                className={inputClass}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="如：客户A生产环境"
              />
            </Field>
            <Field label="部署状态">
              <select
                className={inputClass}
                value={form.status}
                onChange={(e) => update("status", e.target.value)}
              >
                {Object.entries(statuses).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="部署方式">
              <select
                className={inputClass}
                value={form.method}
                onChange={(e) => update("method", e.target.value)}
              >
                {Object.entries(methods).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="所属环境">
              <select
                className={inputClass}
                value={form.environment_id || ""}
                onChange={(e) => update("environment_id", e.target.value)}
              >
                <option value="">未指定</option>
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            {fields.map(([k, l, max, placeholder]) => (
              <Field key={k} label={l}>
                <input
                  className={inputClass}
                  maxLength={max}
                  value={form[k] || ""}
                  onChange={(e) => update(k, e.target.value)}
                  placeholder={placeholder}
                />
              </Field>
            ))}
            <Field label="部署日期（可选）">
              <input
                className={inputClass}
                type="date"
                value={form.deployed_at}
                onChange={(e) => update("deployed_at", e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="关联部署资源"
            hint="将现场的软件、主机、数据库等资料关联到这条部署记录。"
          >
            <div className="grid max-h-40 gap-2 overflow-y-auto rounded-xl border border-slate-100 p-3 sm:grid-cols-2">
              {resources.map((r) => (
                <label
                  key={r.id}
                  className="flex items-center gap-2 text-xs text-slate-600"
                >
                  <input
                    type="checkbox"
                    checked={form.resource_ids.includes(r.id)}
                    onChange={(e) =>
                      update(
                        "resource_ids",
                        e.target.checked
                          ? [...form.resource_ids, r.id]
                          : form.resource_ids.filter((id) => id !== r.id),
                      )
                    }
                  />
                  <Server size={13} className="shrink-0 text-slate-400" />
                  <span className="break-words">{r.name}</span>
                </label>
              ))}
              {!resources.length && (
                <p className="text-xs text-slate-400">
                  可以先保存部署信息，再添加和关联资源。
                </p>
              )}
              {form.resource_ids
                .filter((id) => !resources.some((r) => r.id === id))
                .map((id) => (
                  <label key={id} className="text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(
                          "resource_ids",
                          form.resource_ids.filter((x) => x !== id),
                        )
                      }
                    />
                    已移除资源（保留关联）
                  </label>
                ))}
            </div>
          </Field>
          <Field
            label="部署说明"
            hint="可填写访问前提和交接信息；密码、私钥请保存在账号库。"
          >
            <textarea
              rows={3}
              maxLength={3000}
              className={inputClass}
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
            />
          </Field>
          <FormError error={error} />
          {item && (
            <button
              type="button"
              disabled={busy}
              className="text-xs text-rose-500"
              onClick={remove}
            >
              移入回收站
            </button>
          )}
        </div>
        <FormActions busy={busy} onClose={onClose} />
      </form>
    </Modal>
  );
}
