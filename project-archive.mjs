import { libraryFail as fail } from "./library-common.mjs";

const KINDS = ["note", "milestone", "change", "document", "delivery"];
const NOTICE =
  "仅检索资料元数据和记录正文；不解析文件正文，不做 OCR。日期优先使用明确发生日，缺失时按系统登记时间排序。";
const empty =
  "SELECT '' id,'' source_type,'' project_id,'' title,'' summary,'' occurred_on,'' recorded_at,'' entity_id,NULL version_id,NULL version_number,'' version_name,'' event_type,'' search_text,'' path_text WHERE 0";
const validDay = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number(value.slice(0, 4)) > 0 &&
  Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
function excerpt(value, query) {
  const text = String(value || "").replace(/\s+/g, " ");
  const hit = query
      ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      : -1,
    start = Math.max(0, hit - 70);
  return (
    (start ? "…" : "") +
    text.slice(start, start + 360) +
    (text.length > start + 360 ? "…" : "")
  );
}
function integer(params, key, fallback, maximum) {
  const raw = params.get(key);
  if (raw === null || raw === "") return fallback;
  if (
    !/^[1-9]\d*$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) > maximum
  )
    fail(400, key === "page" ? "页码无效" : "每页条数应为 1 至 50");
  return Number(raw);
}
// Every branch is a safe, explicit projection. Credentials/configurations and file
// bytes are deliberately absent; no dynamic table or column names come from input.
export function createProjectArchive({ db }) {
  const has = (name) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name),
    );
  const noteMetadata = () => {
    const exists = has("project_notes");
    const columns = exists
      ? new Set(
          db
            .prepare("PRAGMA table_info(project_notes)")
            .all()
            .map((column) => column.name),
        )
      : new Set();
    const value = (key) =>
      columns.has(key) ? "COALESCE(n." + key + ",'')" : "''";
    const onlyFile = (expression) =>
      exists
        ? "CASE WHEN n.kind='file' THEN " + expression + " ELSE '' END"
        : "''";
    return {
      note_kind: exists ? "COALESCE(n.kind,'')" : "''",
      file_direction: onlyFile(
        "CASE WHEN " +
          value("file_direction") +
          " IN ('received','sent') THEN " +
          value("file_direction") +
          " ELSE '' END",
      ),
      counterparty: onlyFile("substr(" + value("counterparty") + ",1,200)"),
      exchange_time: onlyFile("substr(" + value("exchange_time") + ",1,5)"),
      channel: onlyFile("substr(" + value("channel") + ",1,100)"),
    };
  };
  const sources = (mode, exchange) => {
    const sql = [];
    if (has("project_notes")) {
      let attachments = "''";
      if (
        mode === "search" &&
        has("project_note_files") &&
        has("documents") &&
        has("document_versions")
      ) {
        const fixedVersion = db
          .prepare("PRAGMA table_info(project_note_files)")
          .all()
          .some((column) => column.name === "version_id")
          ? "NULLIF(f.version_id,'')"
          : "NULL";
        attachments =
          "COALESCE((SELECT group_concat(attachment_text,'；') FROM (SELECT '关联附件：'||d.title||CASE WHEN " +
          fixedVersion +
          " IS NOT NULL THEN CASE WHEN v.id IS NOT NULL THEN ' · 当时 V'||v.number||'：'||v.filename ELSE ' · 固定版本不可用' END ELSE ' · 未固定版本，仅当前文件名：'||COALESCE(v.filename,'当前版本不可用') END attachment_text FROM project_note_files f JOIN documents d ON d.id=f.document_id AND d.project_id=n.project_id AND d.deleted=0 AND d.sensitive=0 LEFT JOIN document_versions v ON v.document_id=d.id AND v.id=COALESCE(" +
          fixedVersion +
          ",d.current_version_id) WHERE f.note_id=n.id ORDER BY d.title,d.id)),'')";
      }
      sql.push(
        "SELECT 'note:'||n.id id,'note' source_type,n.project_id,substr(n.body,1,80) title,n.body||CASE WHEN n.people<>'' THEN ' · 相关人员：'||n.people ELSE '' END||CASE WHEN n.archive_attachments<>'' THEN ' · '||n.archive_attachments ELSE '' END summary,n.occurred_on,n.created recorded_at,n.id entity_id,NULL version_id,NULL version_number,'' version_name,'note-recorded' event_type,n.body||' '||n.people||' '||n.author_name||' '||n.archive_attachments||' '||(" +
          exchange.counterparty +
          ")||' '||(" +
          exchange.channel +
          ")||' '||(" +
          exchange.exchange_time +
          ") search_text,'' path_text FROM (SELECT n.*, " +
          attachments +
          " archive_attachments FROM project_notes n) n WHERE n.deleted=0",
      );
    }
    if (has("project_milestones")) {
      if (mode === "search")
        sql.push(
          "SELECT 'milestone:'||m.id,'milestone',m.project_id,m.title,m.description||CASE WHEN m.owner<>'' THEN ' · 负责人：'||m.owner ELSE '' END,CASE WHEN m.status='achieved' THEN m.actual_date ELSE '' END,m.created,m.id,NULL,NULL,'','milestone-record',m.title||' '||m.description||' '||m.owner,'' FROM project_milestones m WHERE m.deleted=0",
        );
      else {
        if (has("resource_events"))
          sql.push(
            "SELECT 'milestone-event:'||e.id,'milestone',m.project_id,COALESCE(json_extract(e.details_json,'$.title'),m.title),CASE WHEN json_extract(e.details_json,'$.status')='achieved' THEN CASE WHEN e.action='create-milestone' THEN '里程碑登记时已达成' ELSE '里程碑达成登记' END||CASE WHEN COALESCE(json_extract(e.details_json,'$.occurred_on'),'')='' THEN '；发生日未在该历史事件中保存' ELSE '' END ELSE '里程碑登记' END,CASE WHEN json_extract(e.details_json,'$.status')='achieved' THEN COALESCE(json_extract(e.details_json,'$.occurred_on'),'') ELSE '' END,e.created,m.id,NULL,NULL,'',CASE WHEN json_extract(e.details_json,'$.status')='achieved' THEN 'milestone-achieved' ELSE 'milestone-recorded' END,COALESCE(json_extract(e.details_json,'$.title'),m.title),'' FROM resource_events e JOIN project_milestones m ON m.id=e.entity_id AND m.project_id=e.project_id WHERE m.deleted=0 AND e.entity_type='milestone' AND ((e.action='create-milestone' AND e.id=(SELECT MIN(first.id) FROM resource_events first WHERE first.entity_type='milestone' AND first.entity_id=m.id AND first.action='create-milestone')) OR (e.action='update-milestone' AND json_extract(e.details_json,'$.to')='achieved' AND EXISTS(SELECT 1 FROM json_each(e.details_json,'$.fields') WHERE value='status')))",
          );
        sql.push(
          "SELECT 'milestone-register:'||m.id,'milestone',m.project_id,m.title,'里程碑登记（旧记录未保留初始事件快照）','',m.created,m.id,NULL,NULL,'','milestone-recorded',m.title||' '||m.description||' '||m.owner,'' FROM project_milestones m WHERE m.deleted=0" +
            (has("resource_events")
              ? " AND NOT EXISTS(SELECT 1 FROM resource_events e WHERE e.entity_type='milestone' AND e.entity_id=m.id AND e.action='create-milestone')"
              : ""),
        );
      }
    }
    if (has("project_changes")) {
      if (mode === "search")
        sql.push(
          "SELECT 'change:'||c.id,'change',c.project_id,c.title,c.requested_scope||CASE WHEN c.requester<>'' THEN ' · 提出人：'||c.requester ELSE '' END,c.requested_on,c.created,c.id,NULL,NULL,'','change-record',c.title||' '||c.original_scope||' '||c.requested_scope||' '||c.requester||' '||c.confirmed_by||' '||c.owner||' '||c.schedule_impact,'' FROM project_changes c WHERE c.deleted=0",
        );
      else {
        if (has("project_change_history"))
          sql.push(
            "SELECT 'change-history:'||h.id,'change',c.project_id,COALESCE(json_extract(h.after_json,'$.title'),c.title),CASE WHEN h.action='create' THEN CASE WHEN json_extract(h.after_json,'$.confirmation_status')='confirmed' THEN '需求变更登记并确认：' ELSE '需求变更登记：' END ELSE '需求变更确认：' END||COALESCE(json_extract(h.after_json,'$.requested_scope'),''),CASE WHEN json_extract(h.after_json,'$.confirmation_status')='confirmed' THEN COALESCE(json_extract(h.after_json,'$.confirmed_on'),'') ELSE COALESCE(json_extract(h.after_json,'$.requested_on'),'') END,h.created,c.id,NULL,NULL,'',CASE WHEN json_extract(h.after_json,'$.confirmation_status')='confirmed' THEN 'change-confirmed' ELSE 'change-recorded' END,COALESCE(json_extract(h.after_json,'$.title'),'')||' '||COALESCE(json_extract(h.after_json,'$.requested_scope'),'')||' '||COALESCE(json_extract(h.after_json,'$.requester'),'')||' '||COALESCE(json_extract(h.after_json,'$.confirmed_by'),''),'' FROM project_change_history h JOIN project_changes c ON c.id=h.change_id WHERE c.deleted=0 AND (h.action='create' OR (h.action='update' AND json_extract(h.after_json,'$.confirmation_status')='confirmed' AND COALESCE(json_extract(h.before_json,'$.confirmation_status'),'')<>'confirmed'))",
          );
        sql.push(
          "SELECT 'change-register:'||c.id,'change',c.project_id,c.title,'需求变更登记（旧记录未保留初始事件快照）：'||c.requested_scope,c.requested_on,c.created,c.id,NULL,NULL,'','change-recorded',c.title||' '||c.requested_scope||' '||c.requester,'' FROM project_changes c WHERE c.deleted=0" +
            (has("project_change_history")
              ? " AND NOT EXISTS(SELECT 1 FROM project_change_history h WHERE h.change_id=c.id AND h.action='create')"
              : ""),
        );
      }
    }
    if (has("documents") && has("document_versions")) {
      if (mode === "search")
        sql.push(
          "SELECT 'document:'||d.id||':'||v.id,'document',d.project_id,d.title,d.description, '',v.created,d.id,v.id,v.number,v.filename,'document-version',d.title||' '||d.description||' '||d.tags||' '||d.owner||' '||d.category||' '||v.filename,d.source_path FROM documents d JOIN document_versions v ON v.document_id=d.id WHERE d.deleted=0 AND d.sensitive=0",
        );
      else if (has("resource_events"))
        sql.push(
          "SELECT 'document-publish:'||e.id,'document',d.project_id,d.title,'正式文件发布', '',e.created,d.id,v.id,v.number,v.filename,'document-published',d.title||' '||v.filename,'' FROM resource_events e JOIN documents d ON d.id=e.entity_id AND d.project_id=e.project_id JOIN document_versions v ON v.document_id=d.id AND v.id=json_extract(e.details_json,'$.version_id') WHERE e.entity_type='document' AND e.action='publish' AND d.deleted=0 AND d.sensitive=0",
        );
    }
    if (has("document_releases"))
      sql.push(
        "SELECT 'delivery:'||r.id,'delivery',r.project_id,r.name,'固定版本交付归档'||CASE WHEN " +
          (has("document_release_voids")
            ? "EXISTS(SELECT 1 FROM document_release_voids x WHERE x.release_id=r.id)"
            : "0") +
          " THEN '（已作废，原归档保留）' ELSE '' END,'',r.created,r.id,NULL,NULL,'','delivery-created',r.name||' '||r.created_by,'' FROM document_releases r",
      );
    return sql.length ? sql.join(" UNION ALL ") : empty;
  };
  async function api({ route, method, user, params = new URLSearchParams() }) {
    route = route.replace(/^\/api(?=\/)/, "");
    if (route !== "/project-archive") return null;
    if (!user) fail(401, "请先登录后查看项目档案");
    if (method !== "GET") fail(405, "项目档案仅供读取");
    for (const key of [
      "mode",
      "project_id",
      "q",
      "kind",
      "from",
      "to",
      "page",
      "limit",
      "file_direction",
    ])
      if (params.getAll(key).length > 1) fail(400, "查询参数不能重复");
    const mode = params.get("mode") || "timeline",
      projectId = params.get("project_id") || "",
      q = (params.get("q") || "").trim(),
      kind = params.get("kind") || "",
      fileDirection = params.get("file_direction") || "",
      from = params.get("from") || "",
      to = params.get("to") || "";
    if (!["timeline", "search"].includes(mode)) fail(400, "查询模式无效");
    if (
      projectId &&
      (!/^[\w-]{1,100}$/.test(projectId) ||
        !db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
    )
      fail(404, "项目不存在");
    if (q.length > 200 || /[\x00-\x1f]/.test(q))
      fail(400, "关键词最多 200 字，不能包含控制字符");
    if (kind && !KINDS.includes(kind)) fail(400, "来源类型无效");
    if (
      fileDirection &&
      !["received", "sent", "unclassified"].includes(fileDirection)
    )
      fail(400, "文件收发筛选无效");
    if (fileDirection && kind && kind !== "note")
      fail(400, "文件收发筛选仅适用于随手记来源");
    if (
      (from && !validDay(from)) ||
      (to && !validDay(to)) ||
      (from && to && from > to)
    )
      fail(400, "时间范围无效");
    const page = integer(params, "page", 1, 100000),
      limit = integer(params, "limit", 20, 50),
      filters = [],
      values = [];
    if (projectId) {
      filters.push("a.project_id=?");
      values.push(projectId);
    }
    if (kind) {
      filters.push("a.source_type=?");
      values.push(kind);
    }
    if (fileDirection) {
      filters.push(
        "a.source_type='note' AND a.note_kind='file' AND a.file_direction=?",
      );
      values.push(fileDirection === "unclassified" ? "" : fileDirection);
    }
    if (q) {
      filters.push(
        "(instr(lower(a.search_text),lower(?))>0 OR instr(lower(a.path_text),lower(?))>0)",
      );
      values.push(q, q);
    }
    if (from) {
      filters.push("a.sort_day>=?");
      values.push(from);
    }
    if (to) {
      filters.push("a.sort_day<=?");
      values.push(to);
    }
    const exchange = noteMetadata();
    const exchangeProjection = Object.entries(exchange)
      .map(([key, value]) => value + " " + key)
      .join(",");
    const noteJoin = has("project_notes")
      ? " LEFT JOIN project_notes n ON entries.source_type='note' AND n.id=entries.entity_id AND n.project_id=entries.project_id"
      : "";
    const cte =
      "WITH entries(id,source_type,project_id,title,summary,occurred_on,recorded_at,entity_id,version_id,version_number,version_name,event_type,search_text,path_text) AS (" +
      sources(mode, exchange) +
      "), archive AS (SELECT entries.*," +
      exchangeProjection +
      ",CASE WHEN entries.occurred_on<>'' THEN entries.occurred_on ELSE COALESCE(date(entries.recorded_at,'+8 hours'),'') END sort_day FROM entries" +
      noteJoin +
      "), filtered AS (SELECT a.*,p.name project_name FROM archive a JOIN projects p ON p.id=a.project_id" +
      (filters.length ? " WHERE " + filters.join(" AND ") : "") +
      ") ";
    const total = db
      .prepare(cte + "SELECT COUNT(*) total FROM filtered")
      .get(...values).total;
    const rows = db
      .prepare(
        cte +
          "SELECT id,source_type,project_id,project_name,title,summary,occurred_on,recorded_at,entity_id,version_id,version_number,version_name,event_type,note_kind,file_direction,counterparty,exchange_time,channel,search_text context_text,CASE WHEN ?<>'' AND instr(lower(path_text),lower(?))>0 THEN 1 ELSE 0 END path_match FROM filtered ORDER BY sort_day DESC,recorded_at DESC,id ASC LIMIT ? OFFSET ?",
      )
      .all(...values, q, q, limit, (page - 1) * limit);
    return {
      data: {
        mode,
        scope: projectId || "all",
        items: rows.map(({ path_match, context_text, ...row }) => ({
          ...row,
          summary: excerpt(
            q &&
              !String(row.summary || "")
                .toLocaleLowerCase()
                .includes(q.toLocaleLowerCase()) &&
              String(context_text || "")
                .toLocaleLowerCase()
                .includes(q.toLocaleLowerCase())
              ? context_text
              : row.summary,
            q,
          ),
          time_basis: row.occurred_on ? "occurred" : "recorded",
          match_hint: path_match
            ? "来源路径命中"
            : q
              ? row.version_id
                ? "资料元数据 / 文件名"
                : "记录正文 / 元数据"
              : row.version_id
                ? "资料版本"
                : "记录摘要",
        })),
        total,
        page,
        limit,
        projects: db
          .prepare("SELECT id,name FROM projects ORDER BY name,id")
          .all(),
        kinds: KINDS,
        notice: NOTICE,
      },
    };
  }
  return { api };
}
