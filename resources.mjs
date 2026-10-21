import { randomUUID } from "node:crypto";
import { createVault } from "./vault.mjs";
import { createProjectAssets } from "./project-assets.mjs";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
  installLibraryCommon,
} from "./library-common.mjs";

const now = () => new Date().toISOString();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const types = ["application", "database", "host", "device", "service", "other"];
const parse = (json, fallback = []) => {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
};
const storedArray = (value) =>
  Array.isArray(value) ? value : parse(value, null);
const metadataKeys = new Set([
  "name",
  "category_id",
  "field_values",
  "type",
  "project_ids",
  "environment_id",
  "description",
  "owner",
  "model",
  "serial_number",
  "location",
  "software_version",
  "state",
  "endpoints",
  "relations",
  "parent_id",
  "resource_id",
  "title",
  "username",
  "kind",
  "url",
  "notes",
  "secret",
  "verified_status",
  "verified",
  "verification_note",
  "path",
  "document_id",
]);
const changedFields = (body) =>
  Object.keys(body).filter((key) => metadataKeys.has(key));
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
function secret(value, label = "密码或密钥", bytes = 65536) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > bytes)
    fail(400, `${label}内容过大或格式无效`);
  return value;
}
function optimistic(body, row) {
  if (!Number.isSafeInteger(body.version) || body.version !== row.version)
    fail(409, "内容已被修改，请刷新后重试");
}
function timestamp(value, label) {
  if (!value) return now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail(400, `${label}无效`);
  return new Date(value).toISOString();
}

export function installResourceSchema(db) {
  tx(db, () =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS environments(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS environments_name ON environments(project_id,name) WHERE deleted=0;
    CREATE TABLE IF NOT EXISTS resources(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), project_ids TEXT NOT NULL,
      name TEXT NOT NULL, type TEXT NOT NULL, environment_id TEXT REFERENCES environments(id),
      description TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      serial_number TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', software_version TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_endpoints(
      resource_id TEXT NOT NULL REFERENCES resources(id), position INTEGER NOT NULL,
      address TEXT NOT NULL, port INTEGER, protocol TEXT NOT NULL, purpose TEXT NOT NULL,
      PRIMARY KEY(resource_id,position)
    );
    CREATE TABLE IF NOT EXISTS resource_relations(
      resource_id TEXT NOT NULL REFERENCES resources(id), target_id TEXT NOT NULL REFERENCES resources(id),
      type TEXT NOT NULL, PRIMARY KEY(resource_id,target_id,type)
    );
    CREATE TABLE IF NOT EXISTS credentials(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), project_ids TEXT NOT NULL,
      resource_id TEXT REFERENCES resources(id), title TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'password', url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
      current_version_id TEXT, verified_status TEXT NOT NULL DEFAULT 'unverified', verified_by TEXT NOT NULL DEFAULT '',
      verified_by_id TEXT NOT NULL DEFAULT '', verified_at TEXT NOT NULL DEFAULT '', verification_note TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credential_versions(
      id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id), number INTEGER NOT NULL,
      title TEXT NOT NULL, username TEXT NOT NULL, kind TEXT NOT NULL,
      secret_payload TEXT NOT NULL, secret_context TEXT NOT NULL, key_version TEXT NOT NULL DEFAULT 'v1',
      note TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL,
      UNIQUE(credential_id,number)
    );
    CREATE TABLE IF NOT EXISTS configurations(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      resource_id TEXT REFERENCES resources(id), environment_id TEXT REFERENCES environments(id),
      path TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '',
      document_id TEXT, latest_version_id TEXT, published_version_id TEXT,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS configuration_versions(
      id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL REFERENCES configurations(id), number INTEGER NOT NULL,
      secret_payload TEXT NOT NULL, secret_context TEXT NOT NULL, key_version TEXT NOT NULL DEFAULT 'v1',
      document_version_id TEXT, note TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL,
      UNIQUE(configuration_id,number)
    );
    CREATE TABLE IF NOT EXISTS configuration_releases(
      id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL REFERENCES configurations(id),
      version_id TEXT NOT NULL REFERENCES configuration_versions(id), number INTEGER NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL,
      UNIQUE(configuration_id,number)
    );
    CREATE TABLE IF NOT EXISTS configuration_applications(
      id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL REFERENCES configurations(id),
      resource_id TEXT NOT NULL REFERENCES resources(id), environment_id TEXT REFERENCES environments(id),
      version_id TEXT NOT NULL REFERENCES configuration_versions(id), rollback_version_id TEXT REFERENCES configuration_versions(id),
      applied_at TEXT NOT NULL, result TEXT NOT NULL, note TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS resources_project ON resources(project_id,deleted);
    CREATE INDEX IF NOT EXISTS credentials_project ON credentials(project_id,deleted);
    CREATE INDEX IF NOT EXISTS configurations_project ON configurations(project_id,deleted);
    CREATE INDEX IF NOT EXISTS configuration_applications_target ON configuration_applications(configuration_id,resource_id,environment_id,created_at);
  `),
  );
  for (const table of [
    "credential_versions",
    "configuration_versions",
    "configuration_releases",
    "configuration_applications",
  ])
    for (const operation of ["UPDATE", "DELETE"])
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'历史记录不可修改或删除'); END;`,
      );
  for (const [table, parent] of [
    ["credential_versions", "credential_id"],
    ["configuration_versions", "configuration_id"],
    ["configuration_releases", "configuration_id"],
    ["configuration_applications", null],
  ]) {
    const uniqueCheck = parent
      ? ` OR EXISTS(SELECT 1 FROM ${table} WHERE ${parent}=NEW.${parent} AND number=NEW.number)`
      : "";
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id)${uniqueCheck} BEGIN SELECT RAISE(ABORT,'历史记录不可替换'); END;`,
    );
  }
}

/** All routes are internal-only. Secrets are returned exclusively by POST reveal. */
export function createResources({ db, dataDir, documents, vaultKey } = {}) {
  installLibraryCommon(db);
  installResourceSchema(db);
  const vault = createVault({ db, dataDir, masterKey: vaultKey });
  const assets = createProjectAssets(db);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const event = (user, action, entityType, row, details = {}) =>
    resourceEvent(db, user, {
      action,
      entityType,
      entityId: row.id,
      projectId: row.project_id,
      details: { title: row.name || row.title || "", ...details },
    });
  function project(id) {
    const row = get("SELECT id FROM projects WHERE id=?", id);
    if (!row) fail(404, "项目不存在");
    return row;
  }
  function row(table, id, deleted = false) {
    const value = get(
      `SELECT * FROM ${table} WHERE id=?${deleted ? "" : " AND deleted=0"}`,
      id,
    );
    if (!value) fail(404, "记录不存在或已删除");
    return value;
  }
  function projectIds(value, initial) {
    const ids = value ?? [initial];
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 30 ||
      ids.some((x) => typeof x !== "string" || !x)
    )
      fail(400, "关联项目无效");
    const unique = [...new Set(ids)];
    if (!unique.includes(initial)) fail(400, "必须保留创建记录时所属的项目");
    for (const id of unique) project(id);
    return unique;
  }
  function environment(id, projectId) {
    if (!id) return null;
    if (typeof id !== "string") fail(400, "环境无效");
    const found = get(
      "SELECT * FROM environments WHERE id=? AND deleted=0",
      id,
    );
    if (!found || found.project_id !== projectId)
      fail(400, "请选择本项目中的有效环境");
    return id;
  }
  function linkedResource(id, projectId, preserveDeleted = false) {
    if (!id) return null;
    if (typeof id !== "string") fail(400, "资源无效");
    const resource = get("SELECT * FROM resources WHERE id=?", id);
    if (
      !resource ||
      (resource.deleted && !preserveDeleted) ||
      !parse(resource.project_ids).includes(projectId)
    )
      fail(400, "请选择本项目中的有效资源");
    return id;
  }
  function resourceEnvironment(id, projects) {
    if (!id) return null;
    if (typeof id !== "string") fail(400, "环境无效");
    const found = get(
      "SELECT * FROM environments WHERE id=? AND deleted=0",
      id,
    );
    if (!found || !projects.includes(found.project_id))
      fail(400, "环境必须属于资源关联的项目");
    return id;
  }
  function endpoints(value = []) {
    if (!Array.isArray(value) || value.length > 30)
      fail(400, "每个资源最多记录 30 个地址");
    return value.map((item) => {
      if (!item || typeof item !== "object") fail(400, "地址填写无效");
      let port = item.port;
      if (port === "" || port == null) port = null;
      else if (
        !/^[0-9]+$/.test(String(port)) ||
        !Number.isInteger(Number(port)) ||
        Number(port) < 1 ||
        Number(port) > 65535
      )
        fail(400, "端口需为 1–65535");
      else port = Number(port);
      return {
        address: text(item.address, "地址", 500, true),
        port,
        protocol: text(item.protocol, "协议", 30),
        purpose: text(item.purpose, "地址用途", 100),
      };
    });
  }
  function relationFields(value, id, projects, existing = []) {
    if (!Array.isArray(value) || value.length > 50)
      fail(400, "资源关联最多 50 项");
    const seen = new Set();
    return value.map((item) => {
      if (
        !item ||
        !["runs_on", "connects_to", "depends_on"].includes(item.type) ||
        typeof item.target_id !== "string" ||
        item.target_id === id
      )
        fail(400, "资源关联无效或引用自身");
      const target = get("SELECT * FROM resources WHERE id=?", item.target_id);
      const preserved = existing.some(
        (r) => r.target_id === item.target_id && r.type === item.type,
      );
      if (
        !target ||
        (target.deleted && !preserved) ||
        !parse(target.project_ids).some((p) => projects.includes(p))
      )
        fail(400, "关联资源必须在同一个项目中");
      const key = item.type + ":" + item.target_id;
      if (seen.has(key)) fail(400, "资源关联重复");
      seen.add(key);
      if (["runs_on", "depends_on"].includes(item.type)) {
        const cycle = get(
          "WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT rr.target_id FROM resource_relations rr JOIN chain c ON c.id=rr.resource_id WHERE rr.type IN ('runs_on','depends_on')) SELECT id FROM chain WHERE id=?",
          item.target_id,
          id,
        );
        if (cycle) fail(400, "运行或依赖关系不能形成循环");
      }
      return { type: item.type, target_id: target.id };
    });
  }
  function resourceData(body, old = {}) {
    const extra = assets.resourceFields(body, old);
    const type = extra.type;
    if (!types.includes(type)) fail(400, "资源类型无效");
    const ids = projectIds(
      body.project_ids ?? storedArray(old.project_ids),
      old.project_id,
    );
    const env = resourceEnvironment(
      own(body, "environment_id") ? body.environment_id : old.environment_id,
      ids,
    );
    const metadata = {};
    for (const [key, label, max] of [
      ["description", "用途", 3000],
      ["owner", "维护人", 100],
      ["model", "型号", 200],
      ["serial_number", "序列号", 200],
      ["location", "位置", 300],
      ["software_version", "软件版本", 100],
    ])
      metadata[key] = text(
        extra.field_values[key] ?? body[key] ?? old[key],
        label,
        max,
      );
    const state = body.state ?? old.state ?? "active";
    if (!["active", "inactive", "retired"].includes(state))
      fail(400, "资源状态无效");
    const addresses = endpoints(body.endpoints ?? old.endpoints ?? []);
    let relations = body.relations ?? old.relations ?? [];
    if (own(body, "parent_id"))
      relations = [
        ...relations.filter((r) => r.type !== "runs_on"),
        ...(body.parent_id
          ? [{ type: "runs_on", target_id: body.parent_id }]
          : []),
      ];
    return {
      name: text(body.name ?? old.name, "资源名称", 200, true),
      type,
      ...extra,
      project_ids: ids,
      environment_id: env,
      state,
      ...metadata,
      endpoints: addresses,
      relations: relationFields(relations, old.id, ids, old.relations),
    };
  }
  function hydratedResource(value) {
    return {
      ...value,
      ...assets.hydrateResource(value),
      project_ids: parse(value.project_ids),
      environment_name: value.environment_id
        ? get("SELECT name FROM environments WHERE id=?", value.environment_id)
            ?.name || ""
        : "",
      endpoints: all(
        "SELECT address,port,protocol,purpose FROM resource_endpoints WHERE resource_id=? ORDER BY position",
        value.id,
      ),
      relations: all(
        "SELECT rr.target_id,rr.type,r.name AS target_name,r.deleted AS target_deleted FROM resource_relations rr JOIN resources r ON r.id=rr.target_id WHERE rr.resource_id=? ORDER BY r.name",
        value.id,
      ),
    };
  }
  function saveResourceRelations(id, data) {
    assets.saveResource(id, data);
    run("DELETE FROM resource_endpoints WHERE resource_id=?", id);
    data.endpoints.forEach((e, i) =>
      run(
        "INSERT INTO resource_endpoints VALUES(?,?,?,?,?,?)",
        id,
        i,
        e.address,
        e.port,
        e.protocol,
        e.purpose,
      ),
    );
    run("DELETE FROM resource_relations WHERE resource_id=?", id);
    for (const relation of data.relations)
      run(
        "INSERT INTO resource_relations VALUES(?,?,?)",
        id,
        relation.target_id,
        relation.type,
      );
  }
  function safeCredential(value) {
    const latest = value.current_version_id
      ? get(
          "SELECT secret_payload FROM credential_versions WHERE id=?",
          value.current_version_id,
        )
      : null;
    return {
      ...value,
      project_ids: parse(value.project_ids),
      has_secret: Boolean(latest?.secret_payload),
      resource_name: value.resource_id
        ? get("SELECT name FROM resources WHERE id=?", value.resource_id)
            ?.name || ""
        : "",
    };
  }
  function credentialHistory(id) {
    return all(
      "SELECT id,number,title,username,kind,CASE WHEN secret_payload<>'' THEN 1 ELSE 0 END AS has_secret,note,created_at,created_by,created_by_name FROM credential_versions WHERE credential_id=? ORDER BY number DESC",
      id,
    ).map((v) => ({ ...v, has_secret: Boolean(v.has_secret) }));
  }
  function credentialData(body, old = {}) {
    const kind = body.kind ?? old.kind ?? "password";
    if (!["password", "private_key", "token", "other"].includes(kind))
      fail(400, "账号类型无效");
    const ids = projectIds(
      body.project_ids ?? storedArray(old.project_ids),
      old.project_id,
    );
    const requestedResource = own(body, "resource_id")
      ? body.resource_id
      : old.resource_id;
    const resourceId = linkedResource(
      requestedResource,
      old.project_id,
      Boolean(old.resource_id && requestedResource === old.resource_id),
    );
    if (resourceId) {
      const available = parse(row("resources", resourceId, true).project_ids);
      if (ids.some((id) => !available.includes(id)))
        fail(400, "账号关联的所有项目需先关联该资源");
    }
    return {
      title: text(body.title ?? old.title, "账号用途", 200, true),
      username: text(body.username ?? old.username, "用户名", 300),
      kind,
      resource_id: resourceId,
      project_ids: ids,
      url: text(body.url ?? old.url, "登录入口", 1000),
      notes: text(body.notes ?? old.notes, "账号备注", 3000),
      owner: text(body.owner ?? old.owner, "维护人", 100),
    };
  }
  function verification(body, old, user, changed) {
    const explicit = own(body, "verified_status") || own(body, "verified");
    let status =
      body.verified_status ??
      (own(body, "verified")
        ? body.verified === true
          ? "verified"
          : body.verified === false
            ? "unverified"
            : "invalid"
        : changed
          ? "unverified"
          : old.verified_status || "unverified");
    if (!["unverified", "verified", "failed"].includes(status))
      fail(400, "请选择账号核实状态");
    const note = text(
      body.verification_note ?? (changed ? "" : old.verification_note),
      "核实说明",
      1000,
    );
    return {
      verified_status: status,
      verified_by:
        explicit && status !== "unverified"
          ? user.name
          : changed || status === "unverified"
            ? ""
            : old.verified_by || "",
      verified_by_id:
        explicit && status !== "unverified"
          ? user.id
          : changed || status === "unverified"
            ? ""
            : old.verified_by_id || "",
      verified_at:
        explicit && status !== "unverified"
          ? now()
          : changed || status === "unverified"
            ? ""
            : old.verified_at || "",
      verification_note: note,
    };
  }
  function insertCredentialVersion(value, body, user, previous) {
    const id = randomUUID();
    let payload = previous?.secret_payload || "",
      context = previous?.secret_context || id;
    if (own(body, "secret") || !previous) {
      if (own(body, "secret") && !vault.status().available)
        fail(503, vault.status().message);
      const plain = secret(own(body, "secret") ? body.secret : "");
      payload = plain
        ? vault.encrypt(plain, `credential:${value.id}:${id}`)
        : "";
      context = id;
    }
    const number = get(
      "SELECT COALESCE(MAX(number),0)+1 AS n FROM credential_versions WHERE credential_id=?",
      value.id,
    ).n;
    run(
      "INSERT INTO credential_versions(id,credential_id,number,title,username,kind,secret_payload,secret_context,note,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      value.id,
      number,
      value.title,
      value.username,
      value.kind,
      payload,
      context,
      text(body.note, "版本说明", 1000),
      now(),
      user.id,
      user.name,
    );
    return id;
  }
  function validateDocument(projectId, body, old = {}) {
    let documentId = own(body, "document_id")
      ? body.document_id || null
      : old.document_id || null;
    const versionId = body.document_version_id || null;
    if (documentId || versionId) {
      if (body.attachment_non_secret !== true)
        fail(
          400,
          "关联附件须明确确认为不含密码或密钥的说明文件；敏感配置请填写加密文本",
        );
      if (
        !get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
        )
      )
        fail(400, "文档模块尚未可用");
      if (
        (documentId && typeof documentId !== "string") ||
        (versionId && typeof versionId !== "string")
      )
        fail(400, "关联文档无效");
      const version = versionId
        ? get(
            "SELECT id,document_id FROM document_versions WHERE id=?",
            versionId,
          )
        : null;
      if (versionId && !version) fail(400, "关联文档版本不存在");
      if (version && !documentId) documentId = version.document_id;
      const document = get(
        "SELECT id,project_id,deleted FROM documents WHERE id=?",
        documentId,
      );
      if (
        !document ||
        document.deleted ||
        document.project_id !== projectId ||
        (version && version.document_id !== document.id)
      )
        fail(400, "请选择本项目中的有效文档版本");
    }
    return { document_id: documentId, document_version_id: versionId };
  }
  function configurationData(body, old = {}) {
    const document = validateDocument(old.project_id, body, old);
    return {
      name: text(body.name ?? old.name, "配置名称", 200, true),
      resource_id: linkedResource(
        own(body, "resource_id") ? body.resource_id : old.resource_id,
        old.project_id,
        Boolean(
          old.resource_id &&
            (!own(body, "resource_id") || body.resource_id === old.resource_id),
        ),
      ),
      environment_id: environment(
        own(body, "environment_id") ? body.environment_id : old.environment_id,
        old.project_id,
      ),
      path: text(body.path ?? old.path, "配置路径", 1000),
      notes: text(body.notes ?? old.notes, "配置说明", 3000),
      owner: text(body.owner ?? old.owner, "维护人", 100),
      ...document,
    };
  }
  function configVersion(config, id) {
    if (typeof id !== "string" && !Number.isSafeInteger(id))
      fail(400, "配置版本无效");
    id = String(id);
    const value = get(
      "SELECT * FROM configuration_versions WHERE configuration_id=? AND (id=? OR CAST(number AS TEXT)=?)",
      config.id,
      id,
      id,
    );
    if (!value) fail(404, "配置版本不存在");
    return value;
  }
  function safeConfigVersion(value) {
    const { secret_payload, secret_context, ...safe } = value;
    return { ...safe, has_content: Boolean(secret_payload) };
  }
  function hydratedConfig(value) {
    const applications = applicationList(value.id),
      seen = new Set();
    const currentApplications = applications.filter((application) => {
      const target = `${application.resource_id}:${application.environment_id || ""}`;
      if (application.result === "failed" || seen.has(target)) return false;
      seen.add(target);
      return true;
    });
    return {
      ...value,
      latest_version_number: value.latest_version_id
        ? get(
            "SELECT number FROM configuration_versions WHERE id=?",
            value.latest_version_id,
          )?.number
        : null,
      published_version_number: value.published_version_id
        ? get(
            "SELECT number FROM configuration_versions WHERE id=?",
            value.published_version_id,
          )?.number
        : null,
      resource_name: value.resource_id
        ? get("SELECT name FROM resources WHERE id=?", value.resource_id)
            ?.name || ""
        : "",
      environment_name: value.environment_id
        ? get("SELECT name FROM environments WHERE id=?", value.environment_id)
            ?.name || ""
        : "",
      applications,
      current_applications: currentApplications,
    };
  }
  function applicationList(id) {
    return all(
      "SELECT ca.*,r.name AS resource_name,e.name AS environment_name,cv.number AS version_number FROM configuration_applications ca JOIN resources r ON r.id=ca.resource_id LEFT JOIN environments e ON e.id=ca.environment_id JOIN configuration_versions cv ON cv.id=ca.version_id WHERE ca.configuration_id=? ORDER BY ca.applied_at DESC,ca.created_at DESC,ca.rowid DESC",
      id,
    );
  }
  function insertConfigVersion(config, body, user, validDocument) {
    const id = randomUUID();
    const number = get(
      "SELECT COALESCE(MAX(number),0)+1 AS n FROM configuration_versions WHERE configuration_id=?",
      config.id,
    ).n;
    if (!own(body, "content") && !validDocument.document_version_id)
      fail(400, "请填写配置文本，或关联明确不含秘密的文档版本");
    const payload = own(body, "content")
      ? vault.encrypt(
          secret(body.content, "配置内容", 512 * 1024),
          `configuration:${config.id}:${id}`,
        )
      : "";
    run(
      "INSERT INTO configuration_versions(id,configuration_id,number,secret_payload,secret_context,document_version_id,note,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      config.id,
      number,
      payload,
      id,
      validDocument.document_version_id,
      text(body.note, "版本说明", 1000),
      now(),
      user.id,
      user.name,
    );
    return id;
  }
  const deletedFilter = (params) =>
    ["1", "true"].includes(params.get("deleted"))
      ? " AND deleted=1"
      : ["1", "true"].includes(
            params.get("include_deleted") || params.get("trash"),
          )
        ? ""
        : " AND deleted=0";
  function filtered(items, params, fields) {
    const query = (params.get("q") || "").trim().toLowerCase();
    return query
      ? items.filter((item) =>
          fields.some((field) =>
            String(item[field] || "")
              .toLowerCase()
              .includes(query),
          ),
        )
      : items;
  }

  async function api({
    route,
    method,
    b = {},
    user,
    params = new URLSearchParams(),
  }) {
    route = route.replace(/^\/api(?=\/)/, "");
    const extended = await assets.api({ route, method, b, user, params });
    if (extended) return extended;
    if (["/resources", "/credentials"].includes(route)) {
      if (!user) fail(401, "请先登录后查看项目内部资料");
      if (method !== "GET") fail(405, "不支持的资料操作");
      const table = route.slice(1),
        values = all(
          `SELECT * FROM ${table} WHERE 1=1${deletedFilter(params)} ORDER BY created_at`,
        );
      return {
        data: {
          [table]: filtered(
            values.map(
              table === "resources" ? hydratedResource : safeCredential,
            ),
            params,
            table === "resources"
              ? ["name", "description", "owner"]
              : ["title", "username", "owner", "resource_name"],
          ),
          vault: vault.status(),
        },
      };
    }
    const matches =
      route.match(
        /^\/projects\/([\w-]+)\/(resources|environments|credentials|configurations)$/,
      ) ||
      route.match(
        /^\/(resources|environments|credentials|configurations)\/([\w-]+)(?:\/(restore|reveal|versions|publish|applications)(?:\/([\w-]+)(?:\/(reveal))?)?)?$/,
      );
    if (!matches) return null;
    if (!user) fail(401, "请先登录后查看项目内部资料");
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "请求内容无效");
    const collection = route.startsWith("/projects/");
    const projectId = collection ? matches[1] : null;
    const entity = collection ? matches[2] : matches[1];
    const id = collection ? null : matches[2];
    const action = collection ? null : matches[3];
    const versionId = collection ? null : matches[4];
    if (projectId) project(projectId);

    if (entity === "environments") {
      if (collection && method === "GET")
        return {
          data: {
            environments: all(
              "SELECT * FROM environments WHERE project_id=? AND deleted=0 ORDER BY created_at",
              projectId,
            ),
          },
        };
      if (collection && method === "POST")
        return tx(db, () => {
          const name = text(b.name, "环境名称", 80, true);
          if (
            get(
              "SELECT id FROM environments WHERE project_id=? AND name=? AND deleted=0",
              projectId,
              name,
            )
          )
            fail(409, "该环境名称已存在");
          const value = { id: randomUUID(), project_id: projectId, name };
          run(
            "INSERT INTO environments(id,project_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
            value.id,
            projectId,
            name,
            now(),
            now(),
          );
          event(user, "create-environment", "environment", value);
          return {
            status: 201,
            data: {
              id: value.id,
              version: 1,
              environment: row("environments", value.id),
            },
          };
        });
      if (!collection && !action && ["PATCH", "DELETE"].includes(method))
        return tx(db, () => {
          const value = row("environments", id);
          optimistic(b, value);
          if (method === "DELETE") {
            if (
              get(
                "SELECT id FROM resources WHERE environment_id=? UNION ALL SELECT id FROM configurations WHERE environment_id=? LIMIT 1",
                id,
                id,
              ) ||
              get(
                "SELECT id FROM configuration_applications WHERE environment_id=? UNION ALL SELECT id FROM project_deployments WHERE environment_id=? LIMIT 1",
                id,
                id,
              )
            )
              fail(409, "此环境仍被资源、配置或实际使用记录引用，不能删除");
            run(
              "UPDATE environments SET deleted=1,version=version+1,updated_at=? WHERE id=?",
              now(),
              id,
            );
          } else {
            const name = text(b.name ?? value.name, "环境名称", 80, true);
            if (
              get(
                "SELECT id FROM environments WHERE project_id=? AND name=? AND id<>? AND deleted=0",
                value.project_id,
                name,
                id,
              )
            )
              fail(409, "该环境名称已存在");
            run(
              "UPDATE environments SET name=?,version=version+1,updated_at=? WHERE id=?",
              name,
              now(),
              id,
            );
          }
          event(
            user,
            method === "DELETE" ? "delete-environment" : "update-environment",
            "environment",
            value,
            { fields: method === "PATCH" ? ["name"] : [] },
          );
          return { data: { ok: true, version: value.version + 1 } };
        });
    }
    if (entity === "resources") {
      if (collection && method === "GET") {
        const values = all(
          "SELECT * FROM resources WHERE EXISTS(SELECT 1 FROM json_each(resources.project_ids) WHERE value=?)" +
            deletedFilter(params) +
            " ORDER BY created_at",
          projectId,
        ).map(hydratedResource);
        return {
          data: {
            categories: assets.categories(projectId),
            resources: filtered(values, params, [
              "name",
              "description",
              "owner",
              "location",
              "model",
            ]),
            environments: all(
              "SELECT * FROM environments WHERE project_id=? AND deleted=0 ORDER BY created_at",
              projectId,
            ),
            vault: vault.status(),
          },
        };
      }
      if (collection && method === "POST")
        return tx(db, () => {
          const value = { id: randomUUID(), project_id: projectId };
          const data = resourceData(b, value);
          run(
            "INSERT INTO resources(id,project_id,project_ids,name,type,environment_id,description,owner,model,serial_number,location,software_version,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            value.id,
            projectId,
            JSON.stringify(data.project_ids),
            data.name,
            data.type,
            data.environment_id,
            data.description,
            data.owner,
            data.model,
            data.serial_number,
            data.location,
            data.software_version,
            data.state,
            now(),
            now(),
          );
          saveResourceRelations(value.id, data);
          event(
            user,
            "create-resource",
            "resource",
            { ...value, ...data },
            { type: data.type, project_ids: data.project_ids },
          );
          return {
            status: 201,
            data: {
              id: value.id,
              version: 1,
              resource: hydratedResource(row("resources", value.id)),
            },
          };
        });
      if (!collection && !action && method === "GET")
        return {
          data: {
            resource: hydratedResource(row("resources", id)),
            credentials: all(
              "SELECT * FROM credentials WHERE resource_id=? AND deleted=0 ORDER BY created_at",
              id,
            ).map(safeCredential),
            configurations: all(
              "SELECT * FROM configurations WHERE resource_id=? AND deleted=0 ORDER BY created_at",
              id,
            ).map(hydratedConfig),
          },
        };
      if (!collection && !action && method === "PATCH")
        return tx(db, () => {
          const value = row("resources", id);
          optimistic(b, value);
          const before = hydratedResource(value),
            data = resourceData(b, before);
          const removed = before.project_ids.filter(
            (p) => !data.project_ids.includes(p),
          );
          for (const p of removed) {
            if (
              get(
                "SELECT id FROM project_deployments WHERE project_id=? AND deleted=0 AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.resource_ids')) WHERE value=?) LIMIT 1",
                p,
                id,
              )
            )
              fail(409, "该项目仍有部署记录关联此资源，请先调整部署信息");
            if (
              get(
                "SELECT id FROM credentials WHERE resource_id=? AND deleted=0 AND EXISTS(SELECT 1 FROM json_each(credentials.project_ids) WHERE value=?) UNION ALL SELECT id FROM configurations WHERE resource_id=? AND deleted=0 AND project_id=? LIMIT 1",
                id,
                p,
                id,
                p,
              )
            )
              fail(409, "该项目仍有账号或配置关联此资源，请先调整关联");
          }
          run(
            "UPDATE resources SET project_ids=?,name=?,type=?,environment_id=?,description=?,owner=?,model=?,serial_number=?,location=?,software_version=?,state=?,version=version+1,updated_at=? WHERE id=?",
            JSON.stringify(data.project_ids),
            data.name,
            data.type,
            data.environment_id,
            data.description,
            data.owner,
            data.model,
            data.serial_number,
            data.location,
            data.software_version,
            data.state,
            now(),
            id,
          );
          saveResourceRelations(id, data);
          event(user, "update-resource", "resource", before, {
            fields: changedFields(b),
            project_ids: data.project_ids,
          });
          return {
            data: {
              ok: true,
              version: value.version + 1,
              resource: hydratedResource(row("resources", id)),
            },
          };
        });
    }
    if (entity === "credentials") {
      if (collection && method === "GET")
        return {
          data: {
            credentials: filtered(
              all(
                "SELECT * FROM credentials WHERE EXISTS(SELECT 1 FROM json_each(credentials.project_ids) WHERE value=?)" +
                  deletedFilter(params) +
                  " ORDER BY created_at",
                projectId,
              ).map(safeCredential),
              params,
              ["title", "username", "owner", "notes", "resource_name"],
            ),
            vault: vault.status(),
          },
        };
      if (collection && method === "POST")
        return tx(db, () => {
          const value = { id: randomUUID(), project_id: projectId },
            data = credentialData(b, value),
            verified = verification(b, {}, user, true);
          run(
            "INSERT INTO credentials(id,project_id,project_ids,resource_id,title,username,kind,url,notes,owner,verified_status,verified_by,verified_by_id,verified_at,verification_note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            value.id,
            projectId,
            JSON.stringify(data.project_ids),
            data.resource_id,
            data.title,
            data.username,
            data.kind,
            data.url,
            data.notes,
            data.owner,
            verified.verified_status,
            verified.verified_by,
            verified.verified_by_id,
            verified.verified_at,
            verified.verification_note,
            now(),
            now(),
          );
          const version = insertCredentialVersion(
            { ...value, ...data },
            b,
            user,
          );
          run(
            "UPDATE credentials SET current_version_id=? WHERE id=?",
            version,
            value.id,
          );
          event(
            user,
            "create-credential",
            "credential",
            { ...value, ...data },
            { fields: ["title", "username", "secret"], version_id: version },
          );
          return {
            status: 201,
            data: {
              id: value.id,
              version: 1,
              credential: safeCredential(row("credentials", value.id)),
            },
          };
        });
      if (!collection && !action && method === "GET") {
        const value = row("credentials", id);
        const history = credentialHistory(id);
        return {
          data: {
            credential: safeCredential(value),
            versions: history,
            history,
            vault: vault.status(),
          },
        };
      }
      if (!collection && !action && method === "PATCH")
        return tx(db, () => {
          const value = row("credentials", id);
          optimistic(b, value);
          const data = credentialData(b, value),
            changed =
              own(b, "secret") ||
              data.username !== value.username ||
              data.resource_id !== value.resource_id;
          const verified = verification(b, value, user, changed),
            previous = get(
              "SELECT * FROM credential_versions WHERE id=?",
              value.current_version_id,
            );
          const newVersion = insertCredentialVersion(
            { ...value, ...data },
            b,
            user,
            previous,
          );
          run(
            "UPDATE credentials SET project_ids=?,resource_id=?,title=?,username=?,kind=?,url=?,notes=?,owner=?,current_version_id=?,verified_status=?,verified_by=?,verified_by_id=?,verified_at=?,verification_note=?,version=version+1,updated_at=? WHERE id=?",
            JSON.stringify(data.project_ids),
            data.resource_id,
            data.title,
            data.username,
            data.kind,
            data.url,
            data.notes,
            data.owner,
            newVersion,
            verified.verified_status,
            verified.verified_by,
            verified.verified_by_id,
            verified.verified_at,
            verified.verification_note,
            now(),
            id,
          );
          event(user, "update-credential", "credential", value, {
            fields: changedFields(b),
            version_id: newVersion,
            status: verified.verified_status,
          });
          return {
            data: {
              ok: true,
              version: value.version + 1,
              credential: safeCredential(row("credentials", id)),
            },
          };
        });
      if (!collection && action === "reveal" && method === "POST") {
        const value = row("credentials", id);
        if (
          own(b, "version_id") &&
          b.version_id !== null &&
          typeof b.version_id !== "string"
        )
          fail(400, "账号版本无效");
        const version = b.version_id
          ? get(
              "SELECT * FROM credential_versions WHERE id=? AND credential_id=?",
              b.version_id,
              id,
            )
          : get(
              "SELECT * FROM credential_versions WHERE id=?",
              value.current_version_id,
            );
        if (!version) fail(404, "账号版本不存在");
        if (!vault.status().available && version.secret_payload)
          fail(503, vault.status().message);
        // The event must commit before plaintext is produced or sent.
        tx(db, () =>
          event(user, "reveal-credential", "credential", value, {
            version_id: version.id,
            purpose: "view-or-copy",
          }),
        );
        return {
          data: {
            secret: version.secret_payload
              ? vault.decrypt(
                  version.secret_payload,
                  `credential:${id}:${version.secret_context}`,
                )
              : "",
            version_id: version.id,
            number: version.number,
            username: version.username,
            kind: version.kind,
          },
        };
      }
    }
    if (entity === "configurations") {
      if (collection && method === "GET")
        return {
          data: {
            configurations: filtered(
              all(
                "SELECT * FROM configurations WHERE project_id=?" +
                  deletedFilter(params) +
                  " ORDER BY created_at",
                projectId,
              ).map(hydratedConfig),
              params,
              ["name", "path", "notes", "owner", "resource_name"],
            ),
            vault: vault.status(),
          },
        };
      if (collection && method === "POST")
        return tx(db, () => {
          const value = { id: randomUUID(), project_id: projectId },
            data = configurationData(b, value);
          run(
            "INSERT INTO configurations(id,project_id,name,resource_id,environment_id,path,notes,owner,document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            value.id,
            projectId,
            data.name,
            data.resource_id,
            data.environment_id,
            data.path,
            data.notes,
            data.owner,
            data.document_id,
            now(),
            now(),
          );
          const version = insertConfigVersion(value, b, user, data);
          run(
            "UPDATE configurations SET latest_version_id=? WHERE id=?",
            version,
            value.id,
          );
          event(
            user,
            "create-configuration",
            "configuration",
            { ...value, ...data },
            { version_id: version, fields: ["name", "content"] },
          );
          return {
            status: 201,
            data: {
              id: value.id,
              version: 1,
              configuration: hydratedConfig(row("configurations", value.id)),
            },
          };
        });
      if (!collection && !action && method === "GET") {
        const value = row("configurations", id);
        return {
          data: {
            configuration: hydratedConfig(value),
            versions: all(
              "SELECT * FROM configuration_versions WHERE configuration_id=? ORDER BY number DESC",
              id,
            ).map(safeConfigVersion),
            releases: all(
              "SELECT * FROM configuration_releases WHERE configuration_id=? ORDER BY number DESC",
              id,
            ),
            applications: applicationList(id),
            vault: vault.status(),
          },
        };
      }
      if (!collection && !action && method === "PATCH")
        return tx(db, () => {
          const value = row("configurations", id);
          optimistic(b, value);
          if (own(b, "content")) fail(400, "修改配置内容请创建新版本");
          // An unchanged association does not require resubmitting the confirmation.
          const data = configurationData(
            {
              ...b,
              attachment_non_secret:
                b.attachment_non_secret ??
                (!own(b, "document_id") && Boolean(value.document_id)),
            },
            value,
          );
          run(
            "UPDATE configurations SET name=?,resource_id=?,environment_id=?,path=?,notes=?,owner=?,document_id=?,version=version+1,updated_at=? WHERE id=?",
            data.name,
            data.resource_id,
            data.environment_id,
            data.path,
            data.notes,
            data.owner,
            data.document_id,
            now(),
            id,
          );
          event(user, "update-configuration", "configuration", value, {
            fields: changedFields(b),
          });
          return {
            data: {
              ok: true,
              version: value.version + 1,
              configuration: hydratedConfig(row("configurations", id)),
            },
          };
        });
      if (
        !collection &&
        action === "versions" &&
        !versionId &&
        method === "POST"
      )
        return tx(db, () => {
          const value = row("configurations", id);
          optimistic(b, value);
          const document = validateDocument(value.project_id, b);
          if (
            document.document_id &&
            value.document_id &&
            document.document_id !== value.document_id
          )
            fail(400, "请选择此配置已关联文档的版本");
          const version = insertConfigVersion(value, b, user, document);
          run(
            "UPDATE configurations SET latest_version_id=?,document_id=COALESCE(?,document_id),version=version+1,updated_at=? WHERE id=?",
            version,
            document.document_id,
            now(),
            id,
          );
          event(user, "add-configuration-version", "configuration", value, {
            version_id: version,
          });
          return {
            status: 201,
            data: {
              id: version,
              version_id: version,
              version: value.version + 1,
              configuration: hydratedConfig(row("configurations", id)),
            },
          };
        });
      if (
        !collection &&
        action === "versions" &&
        versionId &&
        matches[5] === "reveal" &&
        method === "POST"
      ) {
        const value = row("configurations", id),
          version = configVersion(value, versionId);
        if (!vault.status().available && version.secret_payload)
          fail(503, vault.status().message);
        tx(db, () =>
          event(user, "reveal-configuration-version", "configuration", value, {
            version_id: version.id,
            purpose: "view-or-diff",
          }),
        );
        return {
          data: {
            content: version.secret_payload
              ? vault.decrypt(
                  version.secret_payload,
                  `configuration:${id}:${version.secret_context}`,
                )
              : "",
            version_id: version.id,
            number: version.number,
            document_version_id: version.document_version_id,
          },
        };
      }
      if (!collection && action === "publish" && method === "POST")
        return tx(db, () => {
          const value = row("configurations", id);
          optimistic(b, value);
          const version = configVersion(value, b.version_id || "");
          const release = randomUUID(),
            number = get(
              "SELECT COALESCE(MAX(number),0)+1 AS n FROM configuration_releases WHERE configuration_id=?",
              id,
            ).n;
          run(
            "INSERT INTO configuration_releases VALUES(?,?,?,?,?,?,?)",
            release,
            id,
            version.id,
            number,
            now(),
            user.id,
            user.name,
          );
          run(
            "UPDATE configurations SET published_version_id=?,version=version+1,updated_at=? WHERE id=?",
            version.id,
            now(),
            id,
          );
          event(user, "publish-configuration", "configuration", value, {
            version_id: version.id,
            release_id: release,
            number,
          });
          return {
            data: {
              ok: true,
              id: release,
              release_id: release,
              version: value.version + 1,
              configuration: hydratedConfig(row("configurations", id)),
            },
          };
        });
      if (!collection && action === "applications" && method === "POST")
        return tx(db, () => {
          const value = row("configurations", id),
            target = linkedResource(b.resource_id, value.project_id);
          if (!target) fail(400, "请选择实际使用此配置的资源");
          if (own(b, "version")) optimistic(b, value);
          const version = configVersion(value, b.version_id || ""),
            env = environment(b.environment_id, value.project_id);
          const rollback = b.rollback_version_id
            ? configVersion(value, b.rollback_version_id).id
            : null;
          const result = b.result ?? "applied";
          if (
            !["applied", "verified", "failed", "rolled_back"].includes(result)
          )
            fail(400, "请选择应用或核实结果");
          const applied = timestamp(b.applied_at, "应用时间"),
            note = text(b.note, "应用说明", 2000),
            applicationId = randomUUID();
          if (result === "rolled_back" && !rollback)
            fail(400, "回退记录需选择回退前的版本");
          run(
            "INSERT INTO configuration_applications VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            applicationId,
            id,
            target,
            env,
            version.id,
            rollback,
            applied,
            result,
            note,
            now(),
            user.id,
            user.name,
          );
          event(
            user,
            "record-configuration-application",
            "configuration",
            value,
            {
              application_id: applicationId,
              resource_id: target,
              environment_id: env,
              version_id: version.id,
              result,
              rollback_version_id: rollback,
            },
          );
          return {
            status: 201,
            data: { id: applicationId, applications: applicationList(id) },
          };
        });
    }
    if (
      ["resources", "credentials", "configurations"].includes(entity) &&
      !collection &&
      ((method === "DELETE" && !action) ||
        (method === "POST" && action === "restore"))
    )
      return tx(db, () => {
        const value = row(entity, id, true);
        optimistic(b, value);
        const deleting = method === "DELETE";
        if (deleting && value.deleted) fail(409, "记录已删除");
        if (!deleting && !value.deleted) fail(409, "记录尚未删除");
        if (
          deleting &&
          value.project_ids &&
          parse(value.project_ids).length > 1
        )
          fail(
            409,
            "此记录已被多个项目引用，请先取消其他项目的关联，避免影响共享资料",
          );
        if (
          deleting &&
          entity === "resources" &&
          get(
            "SELECT id FROM project_deployments WHERE deleted=0 AND EXISTS(SELECT 1 FROM json_each(json_extract(data_json,'$.resource_ids')) WHERE value=?) LIMIT 1",
            id,
          )
        )
          fail(409, "资源仍被部署记录关联，请先调整部署信息");
        run(
          `UPDATE ${entity} SET deleted=?,version=version+1,updated_at=? WHERE id=?`,
          deleting ? 1 : 0,
          now(),
          id,
        );
        const entityType =
          entity === "resources"
            ? "resource"
            : entity === "credentials"
              ? "credential"
              : "configuration";
        event(
          user,
          `${deleting ? "delete" : "restore"}-${entityType}`,
          entityType,
          value,
          {
            project_ids: value.project_ids
              ? parse(value.project_ids)
              : [value.project_id],
          },
        );
        return { data: { ok: true, version: value.version + 1 } };
      });
    fail(405, "不支持的资料操作");
  }
  return { api, vault, installSchema: () => installResourceSchema(db) };
}
