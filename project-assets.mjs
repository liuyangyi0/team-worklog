import { randomUUID } from "node:crypto";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
} from "./library-common.mjs";

const now = () => new Date().toISOString();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const json = (s, fallback = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const kinds = ["text", "textarea", "number", "date", "select", "boolean"];
const baseTypes = [
  "application",
  "database",
  "host",
  "device",
  "service",
  "other",
];
const legacyKeys = ["model", "serial_number", "location", "software_version"];
const field = (key, label, type = "text") => ({
  key,
  label,
  type,
  required: false,
  archived: false,
  options: [],
});
const defaults = [
  [
    "application",
    "应用软件",
    "software",
    [
      field("software_version", "软件版本"),
      field("install_path", "部署 / 安装路径"),
      field("runtime", "运行环境"),
    ],
  ],
  [
    "database",
    "数据库",
    "software",
    [
      field("engine", "数据库类型"),
      field("software_version", "数据库版本"),
      field("database_name", "数据库 / 实例名"),
      field("install_path", "安装 / 数据目录"),
    ],
  ],
  [
    "host",
    "服务器 / 主机",
    "hardware",
    [
      field("model", "型号"),
      field("serial_number", "序列号"),
      field("location", "安装位置"),
      field("operating_system", "操作系统"),
      field("specification", "CPU / 内存 / 磁盘", "textarea"),
    ],
  ],
  [
    "device",
    "设备",
    "hardware",
    [
      field("model", "型号"),
      field("serial_number", "序列号"),
      field("location", "安装位置"),
      field("manufacturer", "生产厂家"),
    ],
  ],
  [
    "service",
    "服务",
    "software",
    [
      field("software_version", "服务版本"),
      field("install_path", "部署路径"),
      field("startup", "启动方式", "textarea"),
    ],
  ],
  ["other", "其他", "other", [field("location", "位置")]],
];
function text(value, label, max = 200, required = false) {
  if (value == null && !required) return "";
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    fail(400, `${label}填写无效`);
  return value.trim();
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, `${label}格式无效`);
  return value;
}
function version(body, row) {
  if (!Number.isSafeInteger(body.version) || body.version !== row.version)
    fail(409, "内容已被修改，请刷新后重试");
}
function validDate(value, label) {
  if (!value) return "";
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail(400, `${label}无效`);
  return value;
}

export function createProjectAssets(db) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_categories(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      base_type TEXT NOT NULL, family TEXT NOT NULL, fields_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS resource_category_name ON resource_categories(project_id,name);
    CREATE TABLE IF NOT EXISTS project_deployments(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      environment_id TEXT REFERENCES environments(id), status TEXT NOT NULL, data_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const columns = all("PRAGMA table_info(resources)").map((c) => c.name);
  if (!columns.includes("category_id"))
    db.exec(
      "ALTER TABLE resources ADD COLUMN category_id TEXT NOT NULL DEFAULT ''",
    );
  if (!columns.includes("field_values_json"))
    db.exec(
      "ALTER TABLE resources ADD COLUMN field_values_json TEXT NOT NULL DEFAULT '{}'",
    );
  function project(id) {
    if (!get("SELECT id FROM projects WHERE id=?", id)) fail(404, "项目不存在");
  }
  function seed(projectId) {
    project(projectId);
    for (const [type, name, family, fields] of defaults)
      run(
        "INSERT OR IGNORE INTO resource_categories(id,project_id,name,base_type,family,fields_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        `builtin-${projectId}-${type}`,
        projectId,
        name,
        type,
        family,
        JSON.stringify(fields),
        now(),
        now(),
      );
  }
  for (const { id } of all("SELECT id FROM projects")) seed(id);
  run(
    "UPDATE resources SET category_id='builtin-'||project_id||'-'||type WHERE category_id=''",
  );
  function category(row) {
    const { fields_json, ...safe } = row;
    return {
      ...safe,
      archived: Boolean(row.archived),
      fields: json(fields_json, []),
    };
  }
  function categoryRow(id) {
    const value = get("SELECT * FROM resource_categories WHERE id=?", id);
    if (!value) fail(400, "资源分类不存在");
    return category(value);
  }
  function categories(projectId) {
    seed(projectId);
    return all(
      "SELECT * FROM resource_categories WHERE project_id=? ORDER BY created_at,id",
      projectId,
    ).map(category);
  }
  function event(user, action, entityType, row, fields = []) {
    resourceEvent(db, user, {
      action,
      entityType,
      entityId: row.id,
      projectId: row.project_id,
      details: { title: row.name, fields },
    });
  }
  function definitions(input, previous = []) {
    if (!Array.isArray(input) || input.length > 32)
      fail(400, "每类最多32个字段");
    const keys = new Set(),
      labels = new Set();
    const values = input.map((f) => {
      object(f, "字段");
      const key = text(f.key, "字段标识", 64, true),
        label = text(f.label, "字段名称", 60, true);
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        keys.has(key) ||
        labels.has(label)
      )
        fail(400, "字段标识或名称重复、无效");
      keys.add(key);
      labels.add(label);
      if (!kinds.includes(f.type)) fail(400, "字段类型无效");
      if (legacyKeys.includes(key) && f.type !== "text")
        fail(400, "内置属性须保留为文字类型，请新增自定义字段");
      if (previous.some((p) => p.key === key && p.type !== f.type))
        fail(409, "已有字段不能改变类型，可停用后新增字段");
      if (
        (own(f, "required") && typeof f.required !== "boolean") ||
        (own(f, "archived") && typeof f.archived !== "boolean")
      )
        fail(400, "字段状态无效");
      const options = f.type === "select" ? f.options : [];
      if (
        !Array.isArray(options) ||
        options.length > 50 ||
        (f.type === "select" && !options.length)
      )
        fail(400, "下拉字段需提供1至50个选项");
      const cleanOptions = options.map((o) => text(o, "选项", 100, true));
      if (new Set(cleanOptions).size !== cleanOptions.length)
        fail(400, "下拉选项重复");
      return {
        key,
        label,
        type: f.type,
        required: f.required === true,
        archived: f.archived === true,
        options: cleanOptions,
      };
    });
    if (previous.some((p) => !keys.has(p.key)))
      fail(409, "已有字段请设为停用，不能移除，以保留历史内容");
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > 24000)
      fail(400, "分类字段定义过大，请减少选项内容");
    return values;
  }
  function resourceFields(body, old) {
    seed(old.project_id);
    const id =
      body.category_id ||
      (body.type && body.type !== old.type
        ? `builtin-${old.project_id}-${body.type}`
        : old.category_id) ||
      `builtin-${old.project_id}-${body.type || old.type || "application"}`;
    const def = categoryRow(id),
      switched = old.category_id && old.category_id !== id;
    if (def.project_id !== old.project_id)
      fail(400, "请选择创建项目中的资源分类");
    if (def.archived && (!old.category_id || switched))
      fail(400, "分类已停用，不能用于新资源");
    if (own(body, "category_version") && body.category_version !== def.version)
      fail(409, "分类字段已更新，请刷新表单后重试");
    const stored = old.field_values || json(old.field_values_json || "{}");
    const supplied = own(body, "field_values")
      ? object(body.field_values, "自定义内容")
      : {};
    const known = new Set(def.fields.map((f) => f.key));
    if (Object.keys(supplied).some((k) => !known.has(k)))
      fail(400, "包含当前分类以外的字段");
    const values = Object.create(null);
    // Retain values from previous categories and disabled fields; never silently erase them.
    for (const [k, v] of Object.entries(stored)) values[k] = v;
    for (const f of def.fields) {
      let v = own(supplied, f.key)
        ? supplied[f.key]
        : legacyKeys.includes(f.key) && own(body, f.key)
          ? body[f.key]
          : (values[f.key] ??
            (legacyKeys.includes(f.key) ? old[f.key] : undefined));
      const empty = v == null || v === "";
      if (
        !f.archived &&
        f.required &&
        empty &&
        (!old.category_id || switched || own(body, "field_values"))
      )
        fail(400, `请填写${f.label}`);
      if (empty) {
        values[f.key] = "";
        continue;
      }
      if (f.type === "number") {
        if (typeof v !== "number" || !Number.isFinite(v))
          fail(400, `${f.label}必须是有效数字`);
      } else if (f.type === "boolean") {
        if (typeof v !== "boolean") fail(400, `${f.label}必须为是或否`);
      } else if (f.type === "date") v = validDate(v, f.label);
      else {
        v = text(
          v,
          f.label,
          {
            model: 200,
            serial_number: 200,
            location: 300,
            software_version: 100,
          }[f.key] || (f.type === "textarea" ? 3000 : 1000),
        );
        if (f.type === "select" && !f.options.includes(v))
          fail(400, `${f.label}选项无效`);
      }
      values[f.key] = v;
    }
    if (Buffer.byteLength(JSON.stringify(values), "utf8") > 24000)
      fail(400, "自定义内容过大，请减少字段内容");
    return { category_id: id, field_values: values, type: def.base_type };
  }
  function hydrateResource(row) {
    const def = categoryRow(
      row.category_id || `builtin-${row.project_id}-${row.type}`,
    );
    const values = json(row.field_values_json || "{}");
    for (const k of legacyKeys)
      if (row[k] && !own(values, k)) values[k] = row[k];
    return {
      category_id: def.id,
      category: def,
      field_values: values,
      ...Object.fromEntries(
        legacyKeys.filter((k) => own(values, k)).map((k) => [k, values[k]]),
      ),
    };
  }
  function saveResource(id, data) {
    run(
      "UPDATE resources SET category_id=?,field_values_json=? WHERE id=?",
      data.category_id,
      JSON.stringify(data.field_values),
      id,
    );
  }
  function deployment(row) {
    const { data_json, ...safe } = row;
    return {
      ...safe,
      ...json(data_json),
      environment_name: row.environment_id
        ? get("SELECT name FROM environments WHERE id=?", row.environment_id)
            ?.name || ""
        : "",
    };
  }
  function deploymentData(body, old) {
    const before = json(old.data_json || "{}");
    const result = {};
    for (const [key, label, max] of [
      ["site", "客户 / 部署单位", 200],
      ["location", "部署位置", 500],
      ["provider", "云平台 / 托管方", 200],
      ["entry_url", "访问入口", 1000],
      ["network_address", "IP / 网络说明", 1000],
      ["install_path", "部署路径", 1000],
      ["deployed_version", "部署版本", 100],
      ["maintainer", "维护人", 100],
      ["contact", "现场联系人", 200],
      ["notes", "部署说明", 3000],
    ])
      result[key] = text(body[key] ?? before[key], label, max);
    result.method = body.method ?? before.method ?? "onsite";
    if (
      !["onsite", "cloud", "hosted", "local", "other"].includes(result.method)
    )
      fail(400, "部署方式无效");
    result.deployed_at = validDate(
      body.deployed_at ?? before.deployed_at,
      "部署日期",
    );
    const ids = body.resource_ids ?? before.resource_ids ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string")
    )
      fail(400, "关联资源无效");
    result.resource_ids = [...new Set(ids)];
    for (const id of result.resource_ids) {
      const r = get("SELECT * FROM resources WHERE id=?", id);
      const retained = (before.resource_ids || []).includes(id);
      if (
        !r ||
        (!retained && r.deleted) ||
        !json(r.project_ids, []).includes(old.project_id)
      )
        fail(400, "请选择本项目中的资源");
    }
    const env = own(body, "environment_id")
      ? body.environment_id || null
      : old.environment_id || null;
    if (
      env &&
      !get(
        "SELECT id FROM environments WHERE id=? AND project_id=? AND deleted=0",
        env,
        old.project_id,
      )
    )
      fail(400, "请选择本项目中的有效环境");
    const status = body.status ?? old.status ?? "planned";
    if (!["planned", "testing", "live", "retired"].includes(status))
      fail(400, "部署状态无效");
    return {
      name: text(body.name ?? old.name, "部署名称", 200, true),
      status,
      environment_id: env,
      data: result,
    };
  }
  async function api({
    route,
    method,
    b = {},
    user,
    params = new URLSearchParams(),
  }) {
    const match =
      route.match(
        /^\/projects\/([\w-]+)\/(resource-categories|deployments)$/,
      ) ||
      route.match(
        /^\/(resource-categories|deployments)\/([\w-]+)(?:\/(restore))?$/,
      );
    if (!match) return null;
    if (!user) fail(401, "请先登录后查看项目内部资料");
    object(b, "请求");
    const collection = route.startsWith("/projects/"),
      projectId = collection ? match[1] : null,
      entity = collection ? match[2] : match[1],
      id = collection ? null : match[2],
      action = collection ? null : match[3];
    if (collection) project(projectId);
    if (entity === "resource-categories") {
      if (collection && method === "GET")
        return { data: { categories: categories(projectId) } };
      if (
        (collection && method === "POST") ||
        (!collection && method === "PATCH")
      )
        return tx(db, () => {
          if (collection) seed(projectId);
          const old = collection ? { project_id: projectId } : categoryRow(id);
          if (!collection) version(b, old);
          if (own(b, "archived") && typeof b.archived !== "boolean")
            fail(400, "分类状态无效");
          const name = text(b.name ?? old.name, "分类名称", 80, true),
            base_type = b.base_type ?? old.base_type ?? "other",
            family = b.family ?? old.family ?? "other";
          if (
            !baseTypes.includes(base_type) ||
            !["software", "hardware", "other"].includes(family)
          )
            fail(400, "分类归属无效");
          const fields = definitions(
            b.fields ?? old.fields ?? [],
            old.fields || [],
          );
          if (
            get(
              "SELECT id FROM resource_categories WHERE project_id=? AND name=? AND id<>?",
              old.project_id,
              name,
              id || "",
            )
          )
            fail(409, "分类名称已存在");
          if (!collection)
            for (const r of all(
              "SELECT * FROM resources WHERE category_id=?",
              id,
            )) {
              const values = hydrateResource(r).field_values;
              for (const f of fields)
                if (
                  f.type === "select" &&
                  values[f.key] &&
                  !f.options.includes(values[f.key])
                )
                  fail(409, `选项仍被资源使用，不能移除：${f.label}`);
            }
          const value = {
            id: collection ? randomUUID() : id,
            project_id: old.project_id,
            name,
          };
          if (collection)
            run(
              "INSERT INTO resource_categories(id,project_id,name,base_type,family,fields_json,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
              value.id,
              value.project_id,
              name,
              base_type,
              family,
              JSON.stringify(fields),
              b.archived ? 1 : 0,
              now(),
              now(),
            );
          else
            run(
              "UPDATE resource_categories SET name=?,base_type=?,family=?,fields_json=?,archived=?,version=version+1,updated_at=? WHERE id=?",
              name,
              base_type,
              family,
              JSON.stringify(fields),
              (b.archived ?? old.archived) ? 1 : 0,
              now(),
              id,
            );
          event(
            user,
            collection ? "create-category" : "update-category",
            "resource-category",
            value,
            ["name", "fields", "archived"],
          );
          return {
            status: collection ? 201 : 200,
            data: { category: categoryRow(value.id) },
          };
        });
    } else {
      if (collection && method === "GET")
        return {
          data: {
            deployments: all(
              "SELECT * FROM project_deployments WHERE project_id=? AND deleted=? ORDER BY created_at DESC",
              projectId,
              params.get("deleted") === "1" ? 1 : 0,
            ).map(deployment),
          },
        };
      const old = collection
        ? { project_id: projectId }
        : get("SELECT * FROM project_deployments WHERE id=?", id);
      if (!old || (old.deleted && action !== "restore"))
        fail(404, "部署记录不存在或已移除");
      if (!collection && !action && method === "GET")
        return { data: { deployment: deployment(old) } };
      if (
        (collection && method === "POST") ||
        (!collection && !action && method === "PATCH")
      )
        return tx(db, () => {
          if (!collection) version(b, old);
          const d = deploymentData(b, old),
            value = {
              id: collection ? randomUUID() : id,
              project_id: old.project_id,
              name: d.name,
            };
          if (collection)
            run(
              "INSERT INTO project_deployments(id,project_id,name,environment_id,status,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
              value.id,
              value.project_id,
              d.name,
              d.environment_id,
              d.status,
              JSON.stringify(d.data),
              now(),
              now(),
            );
          else
            run(
              "UPDATE project_deployments SET name=?,environment_id=?,status=?,data_json=?,version=version+1,updated_at=? WHERE id=?",
              d.name,
              d.environment_id,
              d.status,
              JSON.stringify(d.data),
              now(),
              id,
            );
          event(
            user,
            collection ? "create-deployment" : "update-deployment",
            "deployment",
            value,
            Object.keys(b).filter((k) => k !== "version"),
          );
          return {
            status: collection ? 201 : 200,
            data: {
              deployment: deployment(
                get("SELECT * FROM project_deployments WHERE id=?", value.id),
              ),
            },
          };
        });
      if (
        !collection &&
        ((!action && method === "DELETE") ||
          (action === "restore" && method === "POST"))
      )
        return tx(db, () => {
          version(b, old);
          if (action === "restore" && !old.deleted) fail(409, "记录未移除");
          if (action === "restore") {
            for (const resourceId of json(old.data_json).resource_ids || []) {
              const resource = get(
                "SELECT * FROM resources WHERE id=?",
                resourceId,
              );
              if (
                !resource ||
                resource.deleted ||
                !json(resource.project_ids, []).includes(old.project_id)
              )
                fail(
                  409,
                  "关联资源已移除或取消项目关联，请先恢复并重新关联该资源，再恢复部署记录",
                );
            }
          }
          run(
            "UPDATE project_deployments SET deleted=?,version=version+1,updated_at=? WHERE id=?",
            action === "restore" ? 0 : 1,
            now(),
            id,
          );
          event(
            user,
            action === "restore" ? "restore-deployment" : "delete-deployment",
            "deployment",
            old,
          );
          return { data: { ok: true } };
        });
    }
    fail(405, "不支持的资料操作");
  }
  return { api, categories, resourceFields, hydrateResource, saveResource };
}
