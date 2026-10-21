import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Clipboard,
  Database,
  Eye,
  EyeOff,
  FileCode2,
  Globe,
  History,
  KeyRound,
  Layers3,
  Link2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api.js";
import { displayTime, fileSize } from "../library-api.js";
import { InternalLogin } from "./ProjectLibrary.jsx";
import {
  ResourceCategoryManager,
  ResourceFields,
  ResourceFieldDetails,
  resourceCategoryName,
} from "./ResourceSchema.jsx";
import ProjectDeployments from "./ProjectDeployments.jsx";
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
const tiny =
  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-40";
const types = {
  application: "应用软件",
  database: "数据库",
  host: "服务器 / 主机",
  device: "设备",
  service: "服务",
  other: "其他",
};
const statusLabels = {
  unverified: "尚未核实",
  verified: "已核实可用",
  failed: "核实未通过",
};
const kindLabels = {
  password: "密码",
  private_key: "私钥",
  token: "令牌",
  other: "其他",
};
const iconFor = (type) =>
  type === "database"
    ? Database
    : type === "application"
      ? Layers3
      : type === "service"
        ? Globe
        : Server;
const moment = (value) => displayTime(value);
const created = (item) => item.created_at || item.created;
const resourceName = (id, resources) =>
  resources.find((r) => r.id === id)?.name || "独立账号 / 未关联";
const environmentName = (id, environments) =>
  environments.find((e) => e.id === id)?.name || "未指定环境";

export default function ProjectResources(props) {
  if (!props.user)
    return <InternalLogin onLogin={props.onLogin} label="资源与配置" />;
  return (
    <ResourceSession key={props.project.id + ":" + props.user.id} {...props} />
  );
}
function ResourceSession({ project, user, members = [] }) {
  const [tab, setTab] = useState("resources"),
    [data, setData] = useState({
      resources: [],
      categories: [],
      environments: [],
      credentials: [],
      configurations: [],
    });
  const [search, setSearch] = useState(""),
    [resourceFilter, setResourceFilter] = useState(""),
    [error, setError] = useState(null),
    [loaded, setLoaded] = useState(false),
    [modal, setModal] = useState(null),
    [notice, setNotice] = useState("");
  const active = useRef(true),
    sequence = useRef(0);
  useEffect(
    () => () => {
      active.current = false;
      sequence.current++;
    },
    [],
  );
  async function load() {
    const token = ++sequence.current;
    try {
      const [resources, credentials, configurations] = await Promise.all([
        api("/projects/" + project.id + "/resources"),
        api("/projects/" + project.id + "/credentials"),
        api("/projects/" + project.id + "/configurations"),
      ]);
      if (active.current && token === sequence.current) {
        setData({
          resources: resources.resources || [],
          categories: resources.categories || [],
          environments: resources.environments || [],
          credentials: credentials.credentials || [],
          configurations: configurations.configurations || [],
        });
        setLoaded(true);
        setError(null);
      }
    } catch (e) {
      if (active.current && token === sequence.current) {
        setError(e);
        setLoaded(true);
      }
    }
  }
  useEffect(() => {
    load();
  }, []);
  const { resources, categories, environments, credentials, configurations } =
    data;
  const matching = (item) =>
    (!resourceFilter ||
      (tab === "resources" ? item.id : item.resource_id) === resourceFilter) &&
    (!search ||
      [
        item.name,
        item.title,
        item.username,
        item.description,
        item.owner,
        item.path,
        item.category?.name,
        ...Object.values(item.field_values || {}),
        resourceName(item.resource_id, resources),
        ...(item.endpoints || []).map((e) => e.address),
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()));
  async function saved(message = "已保存，操作已记录") {
    setModal(null);
    await load();
    setNotice(message);
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
            资源与配置
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            设备、软件与数据库统一管理，账号和配置随项目完整交接。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondary}
            onClick={() => setModal({ type: "recycle" })}
          >
            <Trash2 size={15} />
            回收站
          </button>
          {["resources", "credentials"].includes(tab) && (
            <button
              className={secondary}
              onClick={() => setModal({ type: "share", entity: tab })}
            >
              <Link2 size={15} />
              关联已有
            </button>
          )}
          <button
            className={secondary}
            onClick={() => setModal({ type: "environments" })}
          >
            <Globe size={15} />
            环境管理
          </button>
          <button
            className={secondary}
            onClick={() => setModal({ type: "categories" })}
          >
            <Settings2 size={15} />
            分类与字段
          </button>
          {tab !== "deployments" && (
            <button
              className={primary}
              onClick={() =>
                setModal({
                  type:
                    tab === "resources"
                      ? "resource"
                      : tab === "credentials"
                        ? "credential"
                        : "configuration",
                  create: true,
                })
              }
            >
              <Plus size={15} />
              {tab === "resources"
                ? "添加资源"
                : tab === "credentials"
                  ? "添加账号"
                  : "添加配置"}
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            Server,
            "项目资源",
            resources.length + " 项",
            "软件项目不必先建设备",
          ],
          [
            KeyRound,
            "登录账号",
            credentials.length + " 组",
            "密码按需查看，披露有记录",
          ],
          [
            FileCode2,
            "配置资料",
            configurations.length + " 份",
            "工作版、正式版与现场使用分开记录",
          ],
        ].map(([Icon, title, n, hint]) => (
          <div
            className={card + " flex items-center gap-3 px-4 py-4"}
            key={title}
          >
            <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-500">
              <Icon size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-400">{title}</p>
              <p className="mt-1 text-lg font-bold text-slate-800">{n}</p>
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
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl bg-rose-50 p-3 text-sm text-rose-600"
        >
          {error.message}
          <button className="ml-3 underline" onClick={load}>
            重试
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-full overflow-x-auto rounded-xl bg-slate-200/50 p-1">
          {[
            ["resources", "设备与应用"],
            ["credentials", "账号密码"],
            ["configurations", "配置管理"],
            ["deployments", "部署信息"],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setTab(value);
                setModal(null);
                setSearch("");
              }}
              className={
                "shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm transition " +
                (tab === value
                  ? "bg-white font-medium text-slate-700 shadow-sm"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== "deployments" && (
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search
                size={15}
                className="absolute left-3 top-2.5 text-slate-300"
              />
              <input
                aria-label="搜索资源或账号"
                placeholder="名称、用户名、IP…"
                className={inputClass + " max-w-64 py-2 pl-9 text-xs"}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              aria-label="按资源筛选"
              className={inputClass + " w-auto max-w-44 py-2 text-xs"}
              value={resourceFilter}
              onChange={(e) => setResourceFilter(e.target.value)}
            >
              <option value="">全部资源</option>
              {resources.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {tab === "deployments" && (
        <ProjectDeployments
          projectId={project.id}
          resources={resources}
          environments={environments}
        />
      )}
      {tab === "resources" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {resources.filter(matching).map((resource) => {
            const Icon = iconFor(resource.type);
            return (
              <button
                onClick={() => setModal({ type: "resource", item: resource })}
                key={resource.id}
                className={
                  card +
                  " group p-5 text-left transition hover:border-indigo-200 hover:shadow-md"
                }
              >
                <div className="flex items-start gap-3">
                  <span className="rounded-xl bg-slate-50 p-2.5 text-indigo-400">
                    <Icon size={22} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold text-slate-700 group-hover:text-indigo-600">
                      {resource.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {resourceCategoryName(resource)} ·{" "}
                      {environmentName(resource.environment_id, environments)}
                    </p>
                  </div>
                  <MoreHorizontal size={18} className="text-slate-300" />
                </div>
                <div className="mt-4 min-h-12 space-y-1.5">
                  {(resource.endpoints || [])
                    .slice(0, 3)
                    .map((point, index) => (
                      <p
                        key={index}
                        className="truncate font-mono text-xs text-slate-500"
                      >
                        {point.protocol ? point.protocol + "://" : ""}
                        {point.address}
                        {point.port ? ":" + point.port : ""}
                        <span className="ml-2 font-sans text-slate-300">
                          {point.purpose}
                        </span>
                      </p>
                    ))}
                  {!resource.endpoints?.length && (
                    <p className="text-xs text-slate-300">暂未填写访问地址</p>
                  )}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400">
                  <span>维护人 {resource.owner || "未指定"}</span>
                  <span>
                    {
                      credentials.filter((c) => c.resource_id === resource.id)
                        .length
                    }{" "}
                    组账号 ·{" "}
                    {
                      configurations.filter(
                        (c) => c.resource_id === resource.id,
                      ).length
                    }{" "}
                    份配置
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {tab === "credentials" && (
        <div className={card + " overflow-x-auto"}>
          <table className="w-full min-w-[660px] text-left text-sm">
            <thead className="bg-slate-50/70 text-xs text-slate-400">
              <tr>
                <th className="px-5 py-3.5 font-medium">账号用途</th>
                <th className="px-3 py-3.5 font-medium">用户名</th>
                <th className="px-3 py-3.5 font-medium">关联资源</th>
                <th className="px-3 py-3.5 font-medium">密码 / 状态</th>
                <th className="px-4 py-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {credentials.filter(matching).map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-4">
                    <button
                      className="font-medium text-slate-700 hover:text-indigo-600"
                      onClick={() => setModal({ type: "credential", item })}
                    >
                      {item.title}
                    </button>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {kindLabels[item.kind] || "登录账号"}
                    </p>
                  </td>
                  <td className="px-3 py-4 font-mono text-xs text-slate-500">
                    {item.username || "—"}
                  </td>
                  <td className="px-3 py-4 text-xs text-slate-500">
                    {resourceName(item.resource_id, resources)}
                  </td>
                  <td className="px-3 py-4">
                    <p className="tracking-widest text-slate-300">
                      {item.has_secret ? "••••••••" : "未填写"}
                    </p>
                    <p
                      className={
                        "mt-1 text-[11px] " +
                        (item.verified_status === "verified"
                          ? "text-emerald-600"
                          : item.verified_status === "failed"
                            ? "text-rose-500"
                            : "text-slate-400")
                      }
                    >
                      {statusLabels[item.verified_status] || "尚未核实"}
                    </p>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      className={tiny}
                      aria-label={"查看账号 " + item.title}
                      onClick={() => setModal({ type: "credential", item })}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "configurations" && (
        <div className={card + " overflow-x-auto"}>
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="bg-slate-50/70 text-xs text-slate-400">
              <tr>
                <th className="px-5 py-3.5 font-medium">配置名称</th>
                <th className="px-3 py-3.5 font-medium">资源 / 环境</th>
                <th className="px-3 py-3.5 font-medium">工作版</th>
                <th className="px-3 py-3.5 font-medium">正式版</th>
                <th className="px-3 py-3.5 font-medium">已登记使用</th>
                <th className="px-4 py-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {configurations.filter(matching).map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-4">
                    <button
                      className="font-medium text-slate-700 hover:text-indigo-600"
                      onClick={() => setModal({ type: "configuration", item })}
                    >
                      {item.name}
                    </button>
                    <p className="mt-1 max-w-64 truncate font-mono text-[11px] text-slate-400">
                      {item.path || "未填写目标路径"}
                    </p>
                  </td>
                  <td className="px-3 py-4 text-xs text-slate-500">
                    {resourceName(item.resource_id, resources)}
                    <p className="mt-1 text-[11px] text-slate-400">
                      {environmentName(item.environment_id, environments)}
                    </p>
                  </td>
                  <td className="px-3 py-4 text-xs text-indigo-600">
                    V
                    {item.latest_version_number ||
                      item.latest_version?.number ||
                      "—"}
                  </td>
                  <td className="px-3 py-4 text-xs text-emerald-600">
                    {item.published_version_id
                      ? "V" +
                        (item.published_version_number ||
                          item.published_version?.number ||
                          "—")
                      : "未发布"}
                  </td>
                  <td className="px-3 py-4 text-xs text-slate-500">
                    {item.application_count || item.applications?.length || 0}{" "}
                    条记录
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      className={tiny}
                      aria-label={"查看配置 " + item.name}
                      onClick={() => setModal({ type: "configuration", item })}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loaded &&
        tab !== "deployments" &&
        !(
          tab === "resources"
            ? resources
            : tab === "credentials"
              ? credentials
              : configurations
        ).filter(matching).length && (
          <div
            className={
              card +
              " flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-9 text-sm text-slate-400"
            }
          >
            <LockKeyhole size={28} className="text-slate-200" />
            <p>
              {search || resourceFilter
                ? "没有找到符合条件的内容"
                : tab === "resources"
                  ? "先添加设备、应用或数据库，也可以直接建立独立账号。"
                  : tab === "credentials"
                    ? "还没有账号，保存后密码默认隐藏。"
                    : "还没有配置，配置内容将加密保存。"}
            </p>
          </div>
        )}
      {!loaded && (
        <p className="py-10 text-center text-sm text-slate-400">
          正在载入项目资源…
        </p>
      )}
      {tab === "configurations" && (
        <div className="rounded-xl bg-indigo-50/60 px-4 py-3 text-xs leading-relaxed text-indigo-500">
          最新上传、正式发布、现场实际使用分别记录。登记使用是人工记录，不会自动连接设备或执行配置。
        </div>
      )}
      {modal?.type === "categories" && (
        <ResourceCategoryManager
          categories={categories}
          projectId={project.id}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
      {modal?.type === "environments" && (
        <EnvironmentDialog
          environments={environments}
          projectId={project.id}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      )}
      {modal?.type === "share" && (
        <ShareDialog
          entity={modal.entity}
          projectId={project.id}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
      {modal?.type === "recycle" && (
        <ResourceRecycle
          projectId={project.id}
          onClose={() => setModal(null)}
          onChanged={load}
        />
      )}
      {modal?.type === "resource" && (
        <ResourceDialog
          item={modal.item}
          projectId={project.id}
          resources={resources}
          categories={categories}
          environments={environments}
          credentials={credentials}
          configurations={configurations}
          onClose={() => setModal(null)}
          onSaved={saved}
          onOpenCredential={(item) => setModal({ type: "credential", item })}
          onOpenConfig={(item) => setModal({ type: "configuration", item })}
        />
      )}
      {modal?.type === "credential" && (
        <CredentialDialog
          key={modal.item?.id || "new"}
          item={modal.item}
          projectId={project.id}
          resources={resources}
          onClose={() => setModal(null)}
          onSaved={saved}
        />
      )}
      {modal?.type === "configuration" && (
        <ConfigurationDialog
          key={modal.item?.id || "new"}
          item={modal.item}
          projectId={project.id}
          resources={resources}
          environments={environments}
          onClose={() => setModal(null)}
          onSaved={saved}
          onChanged={load}
        />
      )}
    </div>
  );
}

function EnvironmentDialog({ environments, projectId, onClose, onSaved }) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/projects/" + projectId + "/environments", "POST", { name });
      setName("");
      await onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function change(item, remove) {
    const value = remove ? null : window.prompt("环境名称", item.name);
    if (!remove && !value?.trim()) return;
    if (
      remove &&
      !window.confirm("删除这个环境？仍被资源或配置引用的环境不能删除。")
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/environments/" + item.id, remove ? "DELETE" : "PATCH", {
        version: item.version,
        ...(!remove ? { name: value } : {}),
      });
      await onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="环境管理"
      sub="按项目划分开发、测试、现场生产等实际环境。"
      icon={Globe}
      onClose={onClose}
    >
      <div className="space-y-2 px-6">
        {environments.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2"
          >
            <span className="flex-1 text-sm text-slate-600">{item.name}</span>
            <button
              className={tiny}
              disabled={busy}
              onClick={() => change(item, false)}
            >
              重命名
            </button>
            <button
              className={tiny + " text-rose-400"}
              disabled={busy}
              onClick={() => change(item, true)}
              aria-label={"删除环境 " + item.name}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <form onSubmit={save}>
        <div className="mt-4 flex gap-2 px-6">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="添加环境名称"
            required
            maxLength={80}
          />
          <button className={primary} disabled={busy}>
            添加
          </button>
        </div>
        <div className="mt-3">
          <FormError error={error} />
        </div>
        <div className="flex justify-end px-6 py-5">
          <button type="button" className={secondary} onClick={onClose}>
            关闭
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ResourceDialog({
  item,
  projectId,
  resources,
  categories,
  environments,
  credentials,
  configurations,
  onClose,
  onSaved,
  onOpenCredential,
  onOpenConfig,
}) {
  const [form, setForm] = useState({
      name: "",
      type: "application",
      category_id: "",
      field_values: {},
      owner: "",
      description: "",
      environment_id: "",
      endpoints: [],
      relations: [],
      ...item,
    }),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(!item);
  const categoryOptions = [
    ...categories,
    ...(item?.category && !categories.some((c) => c.id === item.category.id)
      ? [item.category]
      : []),
  ];
  const selectedCategory = categoryOptions.find(
    (c) => c.id === form.category_id,
  );
  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(
        item
          ? "/resources/" + item.id
          : "/projects/" + projectId + "/resources",
        item ? "PATCH" : "POST",
        {
          name: form.name,
          type: selectedCategory?.base_type || form.type,
          category_id: selectedCategory?.id,
          category_version: selectedCategory?.version,
          field_values: Object.fromEntries(
            (selectedCategory?.fields || [])
              .filter((f) => Object.hasOwn(form.field_values, f.key))
              .map((f) => [f.key, form.field_values[f.key]]),
          ),
          description: form.description,
          owner: form.owner,
          environment_id: form.environment_id || null,
          endpoints: form.endpoints
            .filter((p) => p.address?.trim())
            .map((p) => ({ ...p, port: p.port ? Number(p.port) : null })),
          relations: form.relations.filter((r) => r.target_id),
          ...(item ? { version: item.version } : {}),
        },
      );
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove() {
    const projects = item.project_ids || [item.project_id];
    if (projects.length > 1 && item.project_id === projectId) {
      setError(
        new Error(
          "此资源正在多个项目共享。请先在其他项目取消关联，再从创建项目移入回收站。",
        ),
      );
      return;
    }
    if (
      !window.confirm(
        projects.length > 1
          ? "仅从当前项目取消关联？其他项目中的资源记录会保留。"
          : "移除这个资源？请先确认账号和配置的关联。",
      )
    )
      return;
    setBusy(true);
    try {
      await api(
        "/resources/" + item.id,
        projects.length > 1 ? "PATCH" : "DELETE",
        {
          version: item.version,
          ...(projects.length > 1
            ? { project_ids: projects.filter((id) => id !== projectId) }
            : {}),
        },
      );
      onSaved("资源已移除，操作已记录");
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item ? item.name : "添加项目资源"}
      sub="软件、数据库、设备可以独立建立，按实际关系关联。"
      icon={iconFor(selectedCategory?.base_type || form.type)}
      onClose={onClose}
      wide
    >
      <form onSubmit={save}>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto px-6">
          {item && !editing ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  ["类型", resourceCategoryName(item)],
                  ["环境", environmentName(item.environment_id, environments)],
                  ["维护人", item.owner || "未指定"],
                ].map(([name, value]) => (
                  <div className="rounded-xl bg-slate-50 p-3" key={name}>
                    <p className="text-xs text-slate-400">{name}</p>
                    <p className="mt-1 text-sm text-slate-700">{value}</p>
                  </div>
                ))}
              </div>
              <ResourceFieldDetails item={item} categories={categories} />
              {item.description && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-500">
                  {item.description}
                </p>
              )}
              <div className="rounded-xl border border-slate-100 p-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">
                  访问地址
                </h3>
                {(item.endpoints || []).length ? (
                  (item.endpoints || []).map((p, i) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-50 py-2 first:border-0"
                      key={i}
                    >
                      <span className="break-all font-mono text-xs text-slate-600">
                        {p.protocol ? p.protocol + "://" : ""}
                        {p.address}
                        {p.port ? ":" + p.port : ""}
                      </span>
                      <span className="text-xs text-slate-400">
                        {p.purpose || "—"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400">暂未填写</p>
                )}
              </div>
              {(item.relations || []).length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    资源关系
                  </h3>
                  {item.relations.map((r, i) => (
                    <p key={i} className="py-1 text-xs text-slate-500">
                      {
                        {
                          runs_on: "运行在",
                          connects_to: "连接到",
                          depends_on: "依赖于",
                        }[r.type]
                      }{" "}
                      → {resourceName(r.target_id, resources)}
                    </p>
                  ))}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    登录账号
                  </h3>
                  {credentials
                    .filter((c) => c.resource_id === item.id)
                    .map((c) => (
                      <button
                        type="button"
                        className="mb-2 flex w-full items-center gap-2 rounded-xl bg-slate-50 p-3 text-left text-xs text-slate-600 hover:bg-indigo-50"
                        key={c.id}
                        onClick={() => onOpenCredential(c)}
                      >
                        <KeyRound size={14} className="text-indigo-400" />
                        {c.title}
                        <span className="ml-auto text-slate-400">
                          {c.username}
                        </span>
                        <ChevronRight size={12} />
                      </button>
                    ))}
                  {!credentials.some((c) => c.resource_id === item.id) && (
                    <p className="text-xs text-slate-400">暂未关联账号</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    配置文件
                  </h3>
                  {configurations
                    .filter((c) => c.resource_id === item.id)
                    .map((c) => (
                      <button
                        type="button"
                        className="mb-2 flex w-full items-center gap-2 rounded-xl bg-slate-50 p-3 text-left text-xs text-slate-600 hover:bg-indigo-50"
                        key={c.id}
                        onClick={() => onOpenConfig(c)}
                      >
                        <FileCode2 size={14} className="text-indigo-400" />
                        {c.name}
                        <ChevronRight size={12} className="ml-auto" />
                      </button>
                    ))}
                  {!configurations.some((c) => c.resource_id === item.id) && (
                    <p className="text-xs text-slate-400">暂未关联配置</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <Field
                label="资源类型"
                hint="先选择分类，再填写对应资料。切换类型保留已有资源的历史字段。"
              >
                <select
                  required
                  autoFocus={!item}
                  className={inputClass}
                  value={form.category_id}
                  onChange={(e) => update("category_id", e.target.value)}
                >
                  <option value="">请选择资源类型</option>
                  {categoryOptions
                    .filter(
                      (c) =>
                        (!c.archived &&
                          c.project_id === (item?.project_id || projectId)) ||
                        c.id === item?.category_id,
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.archived ? "（已停用）" : ""}
                      </option>
                    ))}
                </select>
              </Field>
              {selectedCategory ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="资源名称">
                      <input
                        required
                        maxLength={150}
                        value={form.name}
                        onChange={(e) => update("name", e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="所属环境">
                      <select
                        value={form.environment_id || ""}
                        onChange={(e) =>
                          update("environment_id", e.target.value)
                        }
                        className={inputClass}
                      >
                        <option value="">未指定</option>
                        {environments.map((e) => (
                          <option value={e.id} key={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="维护人">
                      <input
                        maxLength={80}
                        value={form.owner || ""}
                        onChange={(e) => update("owner", e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <ResourceFields
                    category={selectedCategory}
                    values={form.field_values}
                    onChange={(key, value) =>
                      update("field_values", {
                        ...form.field_values,
                        [key]: value,
                      })
                    }
                  />
                  <Field
                    label="用途说明"
                    hint="密码请放在账号库中，勿填写在公开说明或地址中。"
                  >
                    <textarea
                      rows={2}
                      maxLength={3000}
                      value={form.description || ""}
                      onChange={(e) => update("description", e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-medium text-slate-600">
                        访问地址 / IP
                      </h3>
                      <button
                        type="button"
                        className={tiny}
                        onClick={() =>
                          update("endpoints", [
                            ...form.endpoints,
                            {
                              address: "",
                              port: "",
                              protocol: "",
                              purpose: "",
                            },
                          ])
                        }
                      >
                        <Plus size={13} />
                        添加地址
                      </button>
                    </div>
                    <div className="space-y-2">
                      {form.endpoints.map((point, i) => (
                        <div
                          className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-2 sm:grid-cols-[1fr_70px_80px_1fr_28px]"
                          key={i}
                        >
                          {[
                            ["address", "IP / 地址"],
                            ["port", "端口"],
                            ["protocol", "协议"],
                            ["purpose", "用途"],
                          ].map(([field, placeholder]) => (
                            <input
                              aria-label={placeholder + (i + 1)}
                              key={field}
                              value={point[field] || ""}
                              type={field === "port" ? "number" : "text"}
                              min={field === "port" ? 1 : undefined}
                              max={field === "port" ? 65535 : undefined}
                              placeholder={placeholder}
                              onChange={(e) =>
                                update(
                                  "endpoints",
                                  form.endpoints.map((p, j) =>
                                    i === j
                                      ? { ...p, [field]: e.target.value }
                                      : p,
                                  ),
                                )
                              }
                              className={
                                inputClass + " min-w-0 px-2 py-2 text-xs"
                              }
                            />
                          ))}
                          <button
                            type="button"
                            className="text-slate-400 hover:text-rose-500"
                            aria-label="移除地址"
                            onClick={() =>
                              update(
                                "endpoints",
                                form.endpoints.filter((_, j) => i !== j),
                              )
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-medium text-slate-600">
                        关联资源
                      </h3>
                      <button
                        type="button"
                        className={tiny}
                        onClick={() =>
                          update("relations", [
                            ...form.relations,
                            { type: "runs_on", target_id: "" },
                          ])
                        }
                      >
                        <Plus size={13} />
                        添加关联
                      </button>
                    </div>
                    {form.relations.map((r, i) => (
                      <div className="mb-2 flex gap-2" key={i}>
                        <select
                          className={inputClass + " w-auto"}
                          value={r.type}
                          onChange={(e) =>
                            update(
                              "relations",
                              form.relations.map((p, j) =>
                                i === j ? { ...p, type: e.target.value } : p,
                              ),
                            )
                          }
                        >
                          <option value="runs_on">运行在</option>
                          <option value="connects_to">连接到</option>
                          <option value="depends_on">依赖于</option>
                        </select>
                        <select
                          className={inputClass}
                          value={r.target_id}
                          onChange={(e) =>
                            update(
                              "relations",
                              form.relations.map((p, j) =>
                                i === j
                                  ? { ...p, target_id: e.target.value }
                                  : p,
                              ),
                            )
                          }
                        >
                          <option value="">选择项目资源</option>
                          {resources
                            .filter((p) => p.id !== item?.id)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          className={tiny}
                          aria-label="移除关联"
                          onClick={() =>
                            update(
                              "relations",
                              form.relations.filter((_, j) => i !== j),
                            )
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">
                  选择软件、硬件或自定义分类后显示填写内容
                </p>
              )}
            </>
          )}
        </div>
        <div className="mt-3">
          <FormError error={error} />
        </div>
        {editing ? (
          <FormActions
            onClose={onClose}
            busy={busy}
            disabled={!selectedCategory}
          />
        ) : (
          <div className="flex items-center justify-end gap-2 px-6 py-5">
            <button
              type="button"
              className={tiny + " mr-auto text-rose-500"}
              disabled={busy}
              onClick={remove}
            >
              <Trash2 size={14} />
              移除资源
            </button>
            <button type="button" className={secondary} onClick={onClose}>
              关闭
            </button>
            <button
              type="button"
              className={primary}
              onClick={() => setEditing(true)}
            >
              编辑资源
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function CredentialDialog({ item, projectId, resources, onClose, onSaved }) {
  const [detail, setDetail] = useState(item),
    [history, setHistory] = useState([]),
    [editing, setEditing] = useState(!item),
    [form, setForm] = useState({
      title: "",
      username: "",
      resource_id: "",
      kind: "password",
      url: "",
      notes: "",
      verified_status: "unverified",
      ...item,
    }),
    [verificationDirty, setVerificationDirty] = useState(false),
    [changeSecret, setChangeSecret] = useState(!item),
    [secret, setSecret] = useState(""),
    [revealed, setRevealed] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState("");
  const active = useRef(true),
    timer = useRef(null),
    revealSequence = useRef(0);
  useEffect(
    () => () => {
      active.current = false;
      revealSequence.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (item)
      api("/credentials/" + item.id)
        .then((r) => {
          if (active.current) {
            setDetail(r.credential || r);
            setForm((f) => ({ ...f, ...(r.credential || r) }));
            setHistory(r.history || r.credential?.history || []);
          }
        })
        .catch((e) => {
          if (active.current) setError(e);
        });
  }, [item?.id]);
  function hide() {
    revealSequence.current++;
    setRevealed(null);
    clearTimeout(timer.current);
  }
  async function show(versionId, copy = false) {
    const token = ++revealSequence.current;
    setError(null);
    try {
      const result = await api(
        "/credentials/" + item.id + "/reveal",
        "POST",
        versionId ? { version_id: versionId } : {},
      );
      if (!active.current || token !== revealSequence.current) return;
      if (copy) {
        await navigator.clipboard.writeText(result.secret || "");
        if (active.current) setToast("密码已复制，查看操作已记录");
      } else {
        setRevealed({
          value: result.secret || "",
          versionId: versionId || null,
        });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setRevealed(null);
          revealSequence.current++;
        }, 45000);
      }
    } catch (e) {
      if (active.current && token === revealSequence.current)
        setError(
          new Error(e.status ? e.message : "无法读取或复制密码，请重试"),
        );
    }
  }
  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  async function save(e) {
    e.preventDefault();
    hide();
    setBusy(true);
    setError(null);
    try {
      await api(
        item
          ? "/credentials/" + item.id
          : "/projects/" + projectId + "/credentials",
        item ? "PATCH" : "POST",
        {
          title: form.title,
          username: form.username,
          resource_id: form.resource_id || null,
          kind: form.kind,
          url: form.url,
          notes: form.notes,
          ...(verificationDirty
            ? { verified_status: form.verified_status || "unverified" }
            : {}),
          ...(changeSecret ? { secret } : {}),
          ...(item ? { version: detail.version } : {}),
        },
      );
      setSecret("");
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function remove() {
    const projects = detail.project_ids || [detail.project_id];
    if (projects.length > 1 && detail.project_id === projectId) {
      setError(
        new Error(
          "此账号正在多个项目共享。请先在其他项目取消关联，再从创建项目移入回收站。",
        ),
      );
      return;
    }
    if (
      !window.confirm(
        projects.length > 1
          ? "仅从当前项目取消关联？其他项目的账号和密码仍会保留。"
          : "移除这个账号？操作日志会保留。",
      )
    )
      return;
    hide();
    setBusy(true);
    try {
      await api(
        "/credentials/" + item.id,
        projects.length > 1 ? "PATCH" : "DELETE",
        {
          version: detail.version,
          ...(projects.length > 1
            ? { project_ids: projects.filter((id) => id !== projectId) }
            : {}),
        },
      );
      onSaved("账号已移除，操作已记录");
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  async function verify(status) {
    hide();
    setBusy(true);
    setError(null);
    try {
      const result = await api("/credentials/" + item.id, "PATCH", {
        version: detail.version,
        verified_status: status,
      });
      setDetail(result.credential || result);
      setForm((f) => ({ ...f, ...(result.credential || result) }));
      setToast("核实状态已记录");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item ? item.title : "添加登录账号"}
      sub="已注册成员均可查看和修改，密码查看与更新保留记录。"
      icon={KeyRound}
      onClose={() => {
        hide();
        setSecret("");
        onClose();
      }}
      wide
    >
      <form onSubmit={save}>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto px-6">
          {toast && (
            <div
              role="status"
              className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
            >
              {toast}
            </div>
          )}
          {editing ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="账号用途 / 名称">
                  <input
                    autoFocus
                    required
                    maxLength={150}
                    value={form.title || ""}
                    onChange={(e) => update("title", e.target.value)}
                    className={inputClass}
                    placeholder="如：生产数据库只读账号"
                  />
                </Field>
                <Field label="用户名">
                  <input
                    maxLength={200}
                    value={form.username || ""}
                    autoComplete="off"
                    onChange={(e) => update("username", e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="关联资源（可选）">
                  <select
                    value={form.resource_id || ""}
                    onChange={(e) => update("resource_id", e.target.value)}
                    className={inputClass}
                  >
                    <option value="">独立账号，不关联设备</option>
                    {resources.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="账号类别">
                  <select
                    value={form.kind || "password"}
                    onChange={(e) => update("kind", e.target.value)}
                    className={inputClass}
                  >
                    <option value="password">密码</option>
                    <option value="private_key">私钥</option>
                    <option value="token">令牌</option>
                    <option value="other">其他</option>
                  </select>
                </Field>
                <Field label="登录入口">
                  <input
                    value={form.url || ""}
                    maxLength={1000}
                    onChange={(e) => update("url", e.target.value)}
                    placeholder="地址中请勿嵌入密码"
                    className={inputClass}
                  />
                </Field>
                <Field label="核实状态">
                  <select
                    value={form.verified_status || "unverified"}
                    onChange={(e) => {
                      setVerificationDirty(true);
                      update("verified_status", e.target.value);
                    }}
                    className={inputClass}
                  >
                    {Object.entries(statusLabels).map(([v, t]) => (
                      <option value={v} key={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
                {item && (
                  <label className="mb-3 flex items-center gap-2 text-xs font-medium text-indigo-600">
                    <input
                      type="checkbox"
                      className="accent-indigo-500"
                      checked={changeSecret}
                      onChange={(e) => {
                        setChangeSecret(e.target.checked);
                        setSecret("");
                      }}
                    />
                    更换密码 / 密钥
                  </label>
                )}
                {changeSecret ? (
                  <Field
                    label="密码 / 密钥"
                    hint={
                      item
                        ? "留空并保存会清空密码。未勾选更换时保留原密码。"
                        : "可存密码或密钥，加密保存。"
                    }
                  >
                    <textarea
                      className={inputClass + " font-mono"}
                      rows={3}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                      style={{ WebkitTextSecurity: "disc" }}
                    />
                  </Field>
                ) : (
                  <p className="text-xs text-slate-500">当前密码保持不变。</p>
                )}
              </div>
              <Field
                label="备注"
                hint="仅填写用途与操作说明。密码、私钥等请填写到上方加密字段。"
              >
                <textarea
                  value={form.notes || ""}
                  maxLength={3000}
                  onChange={(e) => update("notes", e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["用户名", detail?.username || "—"],
                  ["关联资源", resourceName(detail?.resource_id, resources)],
                  ["账号类别", kindLabels[detail?.kind] || "未指定"],
                  [
                    "核实状态",
                    statusLabels[detail?.verified_status] || "尚未核实",
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400">{label}</p>
                    <p className="mt-1 break-all text-sm font-medium text-slate-700">
                      {value}
                    </p>
                  </div>
                ))}
              </div>
              {detail?.url && (
                <p className="break-all rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-500">
                  登录入口：{detail.url}
                </p>
              )}
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-slate-700">
                    密码 / 密钥
                  </h3>
                  <span className="text-[11px] text-indigo-400">
                    查看有记录 · 45 秒后隐藏
                  </span>
                </div>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white px-3 py-3 font-mono text-sm text-slate-600">
                  {revealed
                    ? revealed.value
                    : detail?.has_secret
                      ? "••••••••••••"
                      : "尚未填写密码"}
                </pre>
                {revealed?.versionId && (
                  <p className="mt-2 text-xs text-amber-600">
                    当前展示历史版本密码，请确认使用场景。
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={secondary}
                    disabled={!detail?.has_secret}
                    onClick={() => (revealed ? hide() : show())}
                  >
                    {revealed ? <EyeOff size={14} /> : <Eye size={14} />}{" "}
                    {revealed ? "隐藏" : "查看密码"}
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    disabled={!detail?.has_secret}
                    onClick={() => show(null, true)}
                  >
                    <Clipboard size={14} />
                    复制密码
                  </button>
                  <button
                    type="button"
                    className={tiny}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          detail.username || "",
                        );
                        setToast("用户名已复制");
                      } catch {
                        setError(new Error("复制失败，请手动复制用户名"));
                      }
                    }}
                  >
                    复制用户名
                  </button>
                </div>
              </div>
              {detail?.notes && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-500">
                  {detail.notes}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3">
                <span className="mr-auto text-xs text-slate-400">
                  人工核实账号是否可用
                </span>
                <button
                  type="button"
                  disabled={busy}
                  className={tiny + " text-emerald-600"}
                  onClick={() => verify("verified")}
                >
                  <Check size={13} />
                  可用
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={tiny + " text-rose-500"}
                  onClick={() => verify("failed")}
                >
                  不可用
                </button>
              </div>
              {detail?.verified_at && (
                <p className="text-[11px] text-slate-400">
                  {detail.verified_by_name || detail.verified_by || "成员"} 于{" "}
                  {moment(detail.verified_at)} 核实
                </p>
              )}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  账号历史
                </h3>
                {history.length ? (
                  history.map((v, i) => (
                    <div
                      className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2"
                      key={v.id || i}
                    >
                      <div>
                        <p className="text-xs text-slate-600">
                          V{v.number || i + 1} ·{" "}
                          {v.username || detail?.username || "账号更新"}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-400">
                          {moment(created(v))} · {v.created_by_name || "成员"}
                        </p>
                      </div>
                      {v.has_secret && (
                        <button
                          type="button"
                          className={tiny}
                          onClick={() => show(v.id)}
                        >
                          <Eye size={13} />
                          查看此版密码
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400">暂无历史版本</p>
                )}
              </div>
            </>
          )}
        </div>
        <div className="mt-3">
          <FormError error={error} />
        </div>
        {editing ? (
          <FormActions
            onClose={() => {
              hide();
              setSecret("");
              onClose();
            }}
            busy={busy}
          />
        ) : (
          <div className="flex justify-end gap-2 px-6 py-5">
            <button
              type="button"
              className={tiny + " mr-auto text-rose-500"}
              disabled={busy}
              onClick={remove}
            >
              <Trash2 size={14} />
              移除账号
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => {
                hide();
                onClose();
              }}
            >
              关闭
            </button>
            <button
              type="button"
              className={primary}
              onClick={() => {
                hide();
                setEditing(true);
              }}
            >
              编辑账号
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function ConfigurationDialog({
  item,
  projectId,
  resources,
  environments,
  onClose,
  onSaved,
  onChanged,
}) {
  const [data, setData] = useState(null),
    [form, setForm] = useState({
      name: "",
      resource_id: "",
      environment_id: "",
      path: "",
      notes: "",
      ...item,
    }),
    [editing, setEditing] = useState(!item),
    [content, setContent] = useState(""),
    [contentLoaded, setContentLoaded] = useState(!item),
    [note, setNote] = useState(""),
    [revealed, setRevealed] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [application, setApplication] = useState(false),
    [metadataOnly, setMetadataOnly] = useState(false),
    [toast, setToast] = useState("");
  const active = useRef(true),
    sequence = useRef(0),
    timer = useRef(null);
  useEffect(
    () => () => {
      active.current = false;
      sequence.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  function clearContent() {
    sequence.current++;
    setContent("");
    setRevealed(null);
    setContentLoaded(!item);
    clearTimeout(timer.current);
  }
  async function load() {
    if (!item) return;
    try {
      const r = await api("/configurations/" + item.id);
      if (active.current) {
        setData(r);
        setForm((f) => ({ ...f, ...r.configuration }));
      }
    } catch (e) {
      if (active.current) setError(e);
    }
  }
  useEffect(() => {
    load();
  }, [item?.id]);
  const config = data?.configuration || item,
    versions = data?.versions || [],
    applications = data?.applications || [];
  const versionNumber = (id) =>
    versions.find((v) => v.id === id)?.number || "—";
  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  async function reveal(versionId, edit = false, copy = false) {
    const token = ++sequence.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api(
        "/configurations/" + item.id + "/versions/" + versionId + "/reveal",
        "POST",
        {},
      );
      if (!active.current || token !== sequence.current) return;
      if (copy) {
        await navigator.clipboard.writeText(r.content || "");
        if (active.current) setToast("配置内容已复制，操作已记录");
      } else if (edit) {
        setContent(r.content || "");
        setContentLoaded(true);
        setEditing(true);
        setMetadataOnly(false);
      } else {
        setRevealed({ versionId, content: r.content || "" });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setRevealed(null);
          sequence.current++;
        }, 60000);
      }
    } catch (e) {
      if (active.current && token === sequence.current)
        setError(
          new Error(e.status ? e.message : "无法读取或复制配置内容，请重试"),
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function importText(file) {
    if (!file) return;
    setError(null);
    if (file.size > 512 * 1024) {
      setError(new Error("配置文本不能超过 512 KiB，请拆分后导入"));
      return;
    }
    if (
      !/\.(ini|ya?ml|json|xml|conf|config|env|properties|toml|txt|cnf|cfg|sh|bat|ps1|sql)$/i.test(
        file.name,
      ) &&
      file.name !== ".env"
    ) {
      setError(
        new Error("请选择 ini、yaml、json、xml、conf、env 等文本配置文件"),
      );
      return;
    }
    const token = ++sequence.current;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!active.current || token !== sequence.current) return;
      if (text.includes("\0")) {
        setError(new Error("文件包含二进制内容，请使用 UTF-8 文本配置"));
        return;
      }
      setContent(text);
      setContentLoaded(true);
      setEditing(true);
      setMetadataOnly(false);
      if (!form.path) update("path", file.name);
      if (!form.name) update("name", file.name);
    } catch {
      if (active.current)
        setError(
          new Error("无法按 UTF-8 读取文件，请先转换为 UTF-8 编码后导入"),
        );
    }
  }
  async function save(e) {
    e.preventDefault();
    setError(null);
    if (!metadataOnly && !contentLoaded) {
      setError(new Error("请先读取原配置或导入新的文本，避免误覆盖"));
      return;
    }
    if (new TextEncoder().encode(content).length > 512 * 1024) {
      setError(new Error("配置文本不能超过 512 KiB"));
      return;
    }
    setBusy(true);
    try {
      if (!item) {
        await api("/projects/" + projectId + "/configurations", "POST", {
          name: form.name,
          resource_id: form.resource_id || null,
          environment_id: form.environment_id || null,
          path: form.path,
          notes: form.notes,
          content,
          note,
        });
        clearContent();
        onSaved();
      } else {
        let current = config;
        if (metadataOnly) {
          await api("/configurations/" + item.id, "PATCH", {
            version: current.version,
            name: form.name,
            resource_id: form.resource_id || null,
            environment_id: form.environment_id || null,
            path: form.path,
            notes: form.notes,
          });
        } else {
          await api("/configurations/" + item.id + "/versions", "POST", {
            version: current.version,
            content,
            note,
          });
        }
        clearContent();
        setEditing(false);
        await load();
        await onChanged();
        setToast(
          metadataOnly
            ? "配置信息已保存"
            : "新工作版已保存，正式版与现场使用记录保持独立",
        );
      }
    } catch (e) {
      setError(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function publish(v) {
    if (
      !window.confirm(
        "将 V" + v.number + " 发布为正式版？现场使用记录不会自动变更。",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/configurations/" + item.id + "/publish", "POST", {
        version: config.version,
        version_id: v.id,
      });
      await load();
      await onChanged();
      setToast("正式版已更新，请在实际应用后单独登记使用");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm("移除这份配置？历史操作记录仍会保留。")) return;
    clearContent();
    setBusy(true);
    try {
      await api("/configurations/" + item.id, "DELETE", {
        version: config.version,
      });
      onSaved("配置已移除，操作已记录");
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title={item ? item.name : "添加配置"}
        sub="配置内容加密保存，读取有日志；上传、发布和现场应用分别记录。"
        icon={FileCode2}
        onClose={() => {
          clearContent();
          onClose();
        }}
        wide
      >
        <form onSubmit={save}>
          <div className="max-h-[66dvh] space-y-4 overflow-y-auto px-6">
            {toast && (
              <div
                role="status"
                className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
              >
                {toast}
              </div>
            )}
            {editing ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(!item || metadataOnly) && (
                    <>
                      <Field label="配置名称">
                        <input
                          required
                          maxLength={150}
                          value={form.name || ""}
                          onChange={(e) => update("name", e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="目标路径 / 文件名">
                        <input
                          maxLength={1000}
                          value={form.path || ""}
                          onChange={(e) => update("path", e.target.value)}
                          className={inputClass}
                          placeholder="如：/etc/myapp/application.yaml"
                        />
                      </Field>
                      <Field label="关联资源">
                        <select
                          value={form.resource_id || ""}
                          onChange={(e) =>
                            update("resource_id", e.target.value)
                          }
                          className={inputClass}
                        >
                          <option value="">不关联资源</option>
                          {resources.map((r) => (
                            <option value={r.id} key={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="目标环境">
                        <select
                          value={form.environment_id || ""}
                          onChange={(e) =>
                            update("environment_id", e.target.value)
                          }
                          className={inputClass}
                        >
                          <option value="">未指定环境</option>
                          {environments.map((env) => (
                            <option value={env.id} key={env.id}>
                              {env.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </>
                  )}
                </div>
                {!metadataOnly && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-600">
                        加密配置内容
                      </span>
                      <label className={secondary + " cursor-pointer"}>
                        <Upload size={14} />
                        从文本文件导入
                        <input
                          type="file"
                          accept=".ini,.yaml,.yml,.json,.xml,.conf,.config,.env,.properties,.toml,.txt,.cnf,.cfg,.sh,.bat,.ps1,.sql"
                          className="hidden"
                          onChange={(e) => {
                            importText(e.target.files[0]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    <textarea
                      aria-label="加密配置内容"
                      value={content}
                      onChange={(e) => {
                        setContent(e.target.value);
                        setContentLoaded(true);
                      }}
                      rows={13}
                      spellCheck={false}
                      autoComplete="off"
                      className={
                        inputClass + " font-mono text-xs leading-relaxed"
                      }
                      placeholder="粘贴配置文本，或导入 UTF-8 文本文件…"
                    />
                    <p className="text-[11px] text-slate-400">
                      {fileSize(new TextEncoder().encode(content).length)} / 512
                      KiB · 仅在当前编辑窗口保留明文，关闭后清除。
                    </p>
                    <Field label="本次版本说明">
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={1000}
                        placeholder="描述改动，不要在说明中填写密码"
                        className={inputClass}
                      />
                    </Field>
                  </>
                )}
                {(!item || metadataOnly) && (
                  <Field
                    label="备注"
                    hint="说明用途，配置内容和密码放在加密文本中。"
                  >
                    <textarea
                      rows={2}
                      value={form.notes || ""}
                      onChange={(e) => update("notes", e.target.value)}
                      maxLength={3000}
                      className={inputClass}
                    />
                  </Field>
                )}
              </>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    [
                      "最新工作版",
                      config?.latest_version_id
                        ? "V" + versionNumber(config.latest_version_id)
                        : "暂无",
                    ],
                    [
                      "正式发布版",
                      config?.published_version_id
                        ? "V" + versionNumber(config.published_version_id)
                        : "尚未发布",
                    ],
                    ["实际使用记录", applications.length + " 条"],
                  ].map(([name, value]) => (
                    <div className="rounded-xl bg-slate-50 p-3" key={name}>
                      <p className="text-xs text-slate-400">{name}</p>
                      <p className="mt-1 text-base font-semibold text-slate-700">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="rounded-xl border border-slate-100 p-4 text-xs text-slate-500">
                  <p>
                    关联资源：{resourceName(config?.resource_id, resources)}
                  </p>
                  <p className="mt-2">
                    目标环境：
                    {environmentName(config?.environment_id, environments)}
                  </p>
                  <p className="mt-2 break-all font-mono">
                    目标路径：{config?.path || "未填写"}
                  </p>
                  {config?.notes && (
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed">
                      {config.notes}
                    </p>
                  )}
                </div>
                {(config?.current_applications || []).length > 0 && (
                  <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
                    <h3 className="mb-2 text-sm font-semibold text-emerald-700">
                      各目标当前实际使用
                    </h3>
                    {config.current_applications.map((a, i) => (
                      <p
                        key={a.id || i}
                        className="mt-2 text-xs text-emerald-700"
                      >
                        {resourceName(a.resource_id, resources)} ·{" "}
                        {environmentName(a.environment_id, environments)}：V
                        {a.version_number || versionNumber(a.version_id)}{" "}
                        <span className="ml-2 text-emerald-500">
                          {moment(a.applied_at)}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={primary}
                    disabled={busy || !config?.latest_version_id}
                    onClick={() => reveal(config.latest_version_id, true)}
                  >
                    <FileCode2 size={14} />
                    读取并更新配置
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => {
                      clearContent();
                      setMetadataOnly(true);
                      setEditing(true);
                    }}
                  >
                    编辑信息
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => setApplication(true)}
                    disabled={!versions.length}
                  >
                    <Check size={14} />
                    登记现场使用
                  </button>
                </div>
                {revealed && (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/30 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs text-indigo-600">
                        正在查看 V{versionNumber(revealed.versionId)} · 60
                        秒后隐藏
                      </p>
                      <button
                        type="button"
                        className={tiny}
                        onClick={() => {
                          setRevealed(null);
                          sequence.current++;
                          clearTimeout(timer.current);
                        }}
                      >
                        <EyeOff size={13} />
                        隐藏
                      </button>
                    </div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-xs leading-relaxed text-slate-600">
                      {revealed.content}
                    </pre>
                  </div>
                )}
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    配置版本
                  </h3>
                  {versions.map((v) => (
                    <div
                      className="mb-2 rounded-xl border border-slate-100 p-3"
                      key={v.id}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-700">
                          V{v.number}
                        </span>
                        {v.id === config?.latest_version_id && (
                          <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-600">
                            最新工作版
                          </span>
                        )}
                        {v.id === config?.published_version_id && (
                          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600">
                            正式版
                          </span>
                        )}
                        <span className="ml-auto text-[11px] text-slate-400">
                          {moment(created(v))}
                        </span>
                      </div>
                      {v.note && (
                        <p className="mt-2 text-xs text-slate-500">{v.note}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        <button
                          type="button"
                          className={tiny}
                          disabled={busy}
                          onClick={() => reveal(v.id)}
                        >
                          <Eye size={13} />
                          查看内容
                        </button>
                        <button
                          type="button"
                          className={tiny}
                          disabled={busy}
                          onClick={() => reveal(v.id, false, true)}
                        >
                          <Clipboard size={13} />
                          复制
                        </button>
                        <button
                          type="button"
                          className={tiny}
                          disabled={busy}
                          onClick={() => reveal(v.id, true)}
                        >
                          基于此版更新
                        </button>
                        {v.id !== config?.published_version_id && (
                          <button
                            type="button"
                            className={tiny}
                            disabled={busy}
                            onClick={() => publish(v)}
                          >
                            <ShieldCheck size={13} />
                            发布正式版
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-700">
                      现场使用 / 回退记录
                    </h3>
                    <span className="text-[11px] text-slate-400">
                      人工记录，不自动执行部署
                    </span>
                  </div>
                  {!applications.length && (
                    <p className="rounded-xl bg-slate-50 p-4 text-xs text-slate-400">
                      尚未登记实际应用。正式发布不会自动改变现场使用状态。
                    </p>
                  )}
                  {applications.map((a, i) => (
                    <div
                      className="mb-2 rounded-xl border border-slate-100 p-3"
                      key={a.id || i}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-slate-700">
                          {resourceName(a.resource_id, resources)} ·{" "}
                          {environmentName(a.environment_id, environments)}
                        </p>
                        <span className="ml-auto rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">
                          V
                          {versionNumber(
                            a.version_id || a.configuration_version_id,
                          )}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        验证结果：
                        {{
                          applied: "已应用，待验证",
                          verified: "验证通过",
                          failed: "验证失败",
                          rolled_back: "已回退",
                        }[a.result] ||
                          a.result ||
                          "未填写"}
                        {a.rollback_version_id
                          ? " · 回退前版本 V" +
                            versionNumber(a.rollback_version_id)
                          : ""}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {moment(a.applied_at || created(a))} ·{" "}
                        {a.applied_by_name || a.created_by_name || "成员"}
                      </p>
                      {a.note && (
                        <p className="mt-2 text-xs text-slate-500">{a.note}</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="mt-3">
            <FormError error={error} onReload={load} />
          </div>
          {editing ? (
            <div className="flex justify-end gap-2 px-6 py-5">
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  clearContent();
                  if (item) setEditing(false);
                  else onClose();
                }}
              >
                取消
              </button>
              <button
                className={primary}
                disabled={busy || (!metadataOnly && !contentLoaded)}
                type="submit"
              >
                {busy
                  ? "保存中…"
                  : item && !metadataOnly
                    ? "保存为新工作版"
                    : "保存"}
              </button>
            </div>
          ) : (
            <div className="flex justify-end gap-2 px-6 py-5">
              <button
                type="button"
                className={tiny + " mr-auto text-rose-500"}
                disabled={busy}
                onClick={remove}
              >
                <Trash2 size={14} />
                移除配置
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => {
                  clearContent();
                  onClose();
                }}
              >
                关闭
              </button>
            </div>
          )}
        </form>
      </Modal>
      {application && (
        <ApplicationDialog
          config={config}
          versions={versions}
          resources={resources}
          environments={environments}
          onClose={() => setApplication(false)}
          onSaved={async () => {
            setApplication(false);
            await load();
            await onChanged();
            setToast("实际使用记录已保存");
          }}
        />
      )}
    </>
  );
}
function ApplicationDialog({
  config,
  versions,
  resources,
  environments,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState({
      resource_id: config.resource_id || "",
      environment_id: config.environment_id || "",
      version_id: config.published_version_id || config.latest_version_id || "",
      applied_at: "",
      result: "applied",
      rollback_version_id: "",
      note: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/configurations/" + config.id + "/applications", "POST", {
        ...form,
        version: config.version,
        environment_id: form.environment_id || null,
        applied_at: form.applied_at
          ? new Date(form.applied_at).toISOString()
          : undefined,
        rollback_version_id: form.rollback_version_id || null,
      });
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="登记现场使用"
      sub="记录实际已经应用的版本与验证结果，便于定位现场差异和回退。"
      icon={Check}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="space-y-4 px-6">
          <Field label="目标资源">
            <select
              className={inputClass}
              required
              value={form.resource_id}
              onChange={(e) => update("resource_id", e.target.value)}
            >
              <option value="">选择应用到的资源</option>
              {resources.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标环境">
            <select
              className={inputClass}
              value={form.environment_id}
              onChange={(e) => update("environment_id", e.target.value)}
            >
              <option value="">未指定</option>
              {environments.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="实际使用版本">
              <select
                className={inputClass}
                required
                value={form.version_id}
                onChange={(e) => update("version_id", e.target.value)}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    V{v.number}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="验证结果">
              <select
                className={inputClass}
                value={form.result}
                onChange={(e) => update("result", e.target.value)}
              >
                <option value="applied">已应用，待验证</option>
                <option value="verified">验证通过</option>
                <option value="failed">验证失败</option>
                <option value="rolled_back">已回退</option>
              </select>
            </Field>
          </div>
          <Field label="实际应用时间（可选）">
            <input
              type="datetime-local"
              className={inputClass}
              value={form.applied_at}
              onChange={(e) => update("applied_at", e.target.value)}
            />
          </Field>
          <Field
            label={
              form.result === "rolled_back"
                ? "回退前的版本（必填）"
                : "回退前的版本（可选）"
            }
          >
            <select
              className={inputClass}
              required={form.result === "rolled_back"}
              value={form.rollback_version_id}
              onChange={(e) => update("rollback_version_id", e.target.value)}
            >
              <option value="">未发生回退</option>
              {versions.map((v) => (
                <option value={v.id} key={v.id}>
                  V{v.number}
                </option>
              ))}
            </select>
          </Field>
          <Field label="说明">
            <textarea
              className={inputClass}
              rows={2}
              maxLength={2000}
              value={form.note}
              onChange={(e) => update("note", e.target.value)}
              placeholder="记录现场差异或验证结果，不填写密码"
            />
          </Field>
        </div>
        <div className="mt-3">
          <FormError error={error} />
        </div>
        <FormActions onClose={onClose} busy={busy} label="保存使用记录" />
      </form>
    </Modal>
  );
}

function ShareDialog({ entity, projectId, onClose, onSaved }) {
  const [items, setItems] = useState([]),
    [resources, setResources] = useState([]),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(null),
    [error, setError] = useState(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    Promise.all([
      api("/" + entity),
      entity === "credentials" ? api("/resources") : Promise.resolve(null),
    ])
      .then(([list, related]) => {
        if (active.current) {
          setItems(list[entity] || []);
          setResources(related?.resources || []);
        }
      })
      .catch((e) => {
        if (active.current) setError(e);
      });
    return () => {
      active.current = false;
    };
  }, [entity]);
  async function link(item) {
    setBusy(item.id);
    setError(null);
    try {
      if (entity === "credentials" && item.resource_id) {
        const target = resources.find((r) => r.id === item.resource_id);
        if (!target) throw new Error("关联资源已移除，请先修正账号的资源关联");
        if (!(target.project_ids || [target.project_id]).includes(projectId))
          await api("/resources/" + target.id, "PATCH", {
            version: target.version,
            project_ids: [
              ...new Set([
                ...(target.project_ids || [target.project_id]),
                projectId,
              ]),
            ],
          });
      }
      await api("/" + entity + "/" + item.id, "PATCH", {
        version: item.version,
        project_ids: [
          ...new Set([...(item.project_ids || [item.project_id]), projectId]),
        ],
      });
      if (active.current) onSaved("已关联到当前项目，共享同一份资源和账号记录");
    } catch (e) {
      if (active.current) {
        setError(e);
        setBusy(null);
      }
    }
  }
  const candidates = items.filter(
    (item) =>
      !(item.project_ids || [item.project_id]).includes(projectId) &&
      (!search ||
        [item.name, item.title, item.username]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  return (
    <Modal
      title={entity === "resources" ? "关联已有资源" : "关联已有账号"}
      sub="复用其他项目已有记录，更新同一份资料，避免复制多套密码。"
      icon={Link2}
      onClose={onClose}
    >
      <div className="space-y-3 px-6">
        <input
          aria-label="查找已有共享记录"
          className={inputClass}
          placeholder="搜索名称或用户名"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {candidates.map((item) => (
            <div
              className="flex items-center gap-3 rounded-xl border border-slate-100 p-3"
              key={item.id}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-slate-700">
                  {item.name || item.title}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {entity === "resources"
                    ? types[item.type]
                    : item.username || "未填写用户名"}{" "}
                  · 已关联 {(item.project_ids || [item.project_id]).length}{" "}
                  个项目
                </p>
              </div>
              <button
                className={secondary}
                disabled={!!busy}
                onClick={() => link(item)}
              >
                {busy === item.id ? "关联中…" : "关联"}
              </button>
            </div>
          ))}
          {!candidates.length && (
            <p className="py-8 text-center text-sm text-slate-400">
              暂无可关联记录
            </p>
          )}
        </div>
      </div>
      <div className="mt-3">
        <FormError error={error} />
      </div>
      <div className="flex justify-end px-6 py-5">
        <button className={secondary} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
function ResourceRecycle({ projectId, onClose, onChanged }) {
  const [items, setItems] = useState([]),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(null);
  const active = useRef(true);
  async function load() {
    try {
      const kinds = ["resources", "credentials", "configurations"];
      const result = await Promise.all(
        kinds.map((kind) =>
          api("/projects/" + projectId + "/" + kind + "?deleted=1"),
        ),
      );
      if (active.current)
        setItems(
          result.flatMap((r, i) =>
            (r[kinds[i]] || []).map((item) => ({ ...item, entity: kinds[i] })),
          ),
        );
    } catch (e) {
      if (active.current) setError(e);
    }
  }
  useEffect(() => {
    load();
    return () => {
      active.current = false;
    };
  }, [projectId]);
  async function restore(item) {
    setBusy(item.id);
    setError(null);
    try {
      await api("/" + item.entity + "/" + item.id + "/restore", "POST", {
        version: item.version,
      });
      await load();
      await onChanged();
    } catch (e) {
      if (active.current) setError(e);
    } finally {
      if (active.current) setBusy(null);
    }
  }
  return (
    <Modal
      title="资源与配置回收站"
      sub="恢复保留的记录与版本，恢复操作同样写入日志。"
      icon={Trash2}
      onClose={onClose}
    >
      <div className="max-h-96 space-y-2 overflow-y-auto px-6">
        {items.map((item) => (
          <div
            className="flex items-center gap-3 rounded-xl border border-slate-100 p-3"
            key={item.entity + item.id}
          >
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium text-slate-700">
                {item.name || item.title}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {
                  {
                    resources: "项目资源",
                    credentials: "登录账号",
                    configurations: "加密配置",
                  }[item.entity]
                }
              </p>
            </div>
            <button
              className={secondary}
              disabled={!!busy}
              onClick={() => restore(item)}
            >
              {busy === item.id ? "恢复中…" : "恢复"}
            </button>
          </div>
        ))}
        {!items.length && (
          <p className="py-10 text-center text-sm text-slate-400">
            回收站暂无内容
          </p>
        )}
      </div>
      <div className="mt-3">
        <FormError error={error} />
      </div>
      <div className="flex justify-end px-6 py-5">
        <button className={secondary} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
