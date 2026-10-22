import {
  installDependencySchema,
  hydrateRelations,
  relationSnapshot,
  relationFields,
  saveRelations,
  notifyRelations,
  notifyDependents,
} from "./dependencies.mjs";
import {
  installPlanningSchema,
  planningFields,
  notifyRecord,
  ensureDueNotifications,
  notificationsAPI,
} from "./planning.mjs";
import { registrationName } from "./registration.mjs";
import { splitNames } from "./src/people.js";
import { isCompleted } from "./src/model.js";
import {
  installTaskSchema,
  validateParent,
  activeDescendants,
  commentsAPI,
} from "./tasks.mjs";
import {
  installAuditSchema,
  appendAudit,
  readAudit,
  redactAudit,
} from "./audit.mjs";
import {
  installMemberSchema,
  isMemberActive,
  requireMemberAdmin,
  consumeInvitation,
  createMemberAdmin,
} from "./members.mjs";
import { installLibraryCommon, readResourceEvents } from "./library-common.mjs";
import { createDocuments } from "./documents.mjs";
import { createResources } from "./resources.mjs";
import { createNotes } from "./notes.mjs";
import { createMilestones } from "./milestones.mjs";
import { createChangeLedger } from "./change-ledger.mjs";
import { createProjectOverview } from "./project-overview.mjs";
import { createProjectArchive } from "./project-archive.mjs";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scrypt,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const derive = promisify(scrypt),
  digest = (x) => createHash("sha256").update(x).digest("hex"),
  now = () => new Date().toISOString();
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
async function hashPassword(p) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await derive(p, salt, 64)).toString("hex");
}
async function verifyPassword(p, stored) {
  const [salt, h] = stored.split(":");
  return timingSafeEqual(await derive(p, salt, 64), Buffer.from(h, "hex"));
}
function field(b, k, max = 80, optional = false) {
  const v = b[k];
  if (
    typeof v !== "string" ||
    v.trim().length > max ||
    (!optional && !v.trim())
  )
    fail(400, "请检查填写内容");
  return v.trim();
}
const projectColors = ["indigo", "emerald", "amber", "rose", "sky", "violet"];
function projectFields(
  b,
  old = { color: "indigo", members: "[]", archived: 0 },
) {
  const color = b.color === undefined ? old.color : b.color;
  if (!projectColors.includes(color)) fail(400, "项目标识色无效");
  const archived = b.archived === undefined ? old.archived || 0 : b.archived;
  if (![true, false, 0, 1].includes(archived)) fail(400, "归档状态无效");
  let members = b.members === undefined ? JSON.parse(old.members) : b.members;
  if (
    !Array.isArray(members) ||
    members.length > 100 ||
    members.some(
      (x) => typeof x !== "string" || !x.trim() || x.trim().length > 30,
    )
  )
    fail(400, "成员姓名需为 1–30 字，最多 100 人");
  members = [...new Set(members.map((x) => x.trim()))];
  return {
    color,
    members: JSON.stringify(members),
    archived: Number(archived),
  };
}
function password(b, k = "password") {
  const p = b[k];
  if (typeof p !== "string" || p.length < 8 || p.length > 128)
    fail(400, "密码需为 8–128 位");
  return p;
}
function fields(b, old = {}) {
  const task = field(b, "task", 300),
    owner = splitNames(field(b, "owner", 300)).join("、"),
    actual =
      b.actual == null
        ? ""
        : splitNames(field(b, "actual", 300, true)).join("、"),
    date = b.date == null ? "" : field(b, "date", 10, true),
    description =
      b.description === undefined ? old.description || "" : b.description;
  if (typeof description !== "string" || description.trim().length > 2000)
    fail(400, "任务说明最多 2000 字");
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    fail(400, "完成日期无效");
  if (!owner) fail(400, "请选择原定负责人");
  return {
    task,
    description: description.trim(),
    owner,
    actual,
    date,
    ...planningFields(b, old),
    ...relationFields(b, old),
  };
}
export async function createApp({
  dataDir = process.env.DATA_DIR || "data",
  origin = process.env.APP_ORIGIN || "http://127.0.0.1:8766",
  base = "/worklog",
  adminPassword = process.env.ADMIN_PASSWORD,
  adminLogin = process.env.ADMIN_LOGIN || "admin",
  dist = path.resolve("dist"),
  filesDir = process.env.FILES_DIR,
  vaultKey = process.env.VAULT_MASTER_KEY,
  allowUninvitedRegistration = false,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,login TEXT UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',created TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,creator TEXT REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),task TEXT NOT NULL,owner TEXT NOT NULL,actual TEXT NOT NULL,date TEXT NOT NULL DEFAULT '',creator TEXT NOT NULL REFERENCES users(id),created TEXT NOT NULL,updated TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0);" +
      "CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity TEXT,before_json TEXT,after_json TEXT,created TEXT);" +
      "CREATE INDEX IF NOT EXISTS records_project ON records(project_id,deleted); CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);",
  );
  installMemberSchema(db);
  const projectColumns = db
    .prepare("PRAGMA table_info(projects)")
    .all()
    .map((c) => c.name);
  if (!projectColumns.includes("color"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT 'indigo'",
    );
  if (!projectColumns.includes("members"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN members TEXT NOT NULL DEFAULT '[]'",
    );
  if (!projectColumns.includes("archived"))
    db.exec(
      "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    );
  const get = (sql, ...p) => db.prepare(sql).get(...p),
    all = (sql, ...p) => db.prepare(sql).all(...p),
    run = (sql, ...p) => db.prepare(sql).run(...p);
  if (adminPassword && !get("SELECT id FROM users WHERE role='admin'")) {
    adminLogin =
      typeof adminLogin === "string" ? adminLogin.trim().toLowerCase() : "";
    if (!/^[a-z0-9_\-]{3,32}$/.test(adminLogin)) {
      db.close();
      throw new Error("ADMIN_LOGIN 需为3–32位字母、数字、下划线或短横线");
    }
    if (get("SELECT id FROM users WHERE login=?", adminLogin)) {
      db.close();
      throw new Error(
        "管理员登录账号已被已有成员占用，请设置其他 ADMIN_LOGIN；不会自动提升已有成员权限",
      );
    }
    password({ password: adminPassword });
    run(
      "INSERT INTO users VALUES(?,?,?,?,?,?)",
      randomUUID(),
      adminLogin,
      "管理员",
      await hashPassword(adminPassword),
      "admin",
      now(),
    );
  }
  if (!get("SELECT id FROM projects LIMIT 1"))
    run(
      "INSERT INTO projects(id,name,creator,version,created) VALUES(?,?,?,?,?)",
      randomUUID(),
      "示例项目",
      null,
      1,
      now(),
    );
  installTaskSchema(db);
  installAuditSchema(db);
  installPlanningSchema(db);
  installDependencySchema(db);
  installLibraryCommon(db);
  const documents = createDocuments({ db, dataDir, filesDir });
  const resources = createResources({ db, dataDir, documents, vaultKey });
  const notes = createNotes({ db });
  const milestones = createMilestones({ db });
  const changes = createChangeLedger({ db });
  const projectArchive = createProjectArchive({ db });
  const projectOverview = createProjectOverview({
    db,
    getMilestoneSummary: (projectId) => milestones.summary(projectId),
    getChangeSummary: (projectId) => changes.summary(projectId),
    checklistSummary: () => documents.checklistSummary(),
  });
  const limits = new Map(),
    secure = origin.startsWith("https:");
  function rate(req, kind, max, period) {
    const ip = req.headers["x-real-ip"] || req.socket.remoteAddress,
      key = kind + ":" + ip;
    let bucket = limits.get(key);
    if (!bucket || bucket.until < Date.now()) {
      bucket = { count: 0, until: Date.now() + period };
      limits.set(key, bucket);
    }
    if (++bucket.count > max) fail(429, "操作较频繁，请稍后再试");
    if (limits.size > 10000)
      for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k);
  }
  function tokenOf(req) {
    return (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("worklog_session="))
      ?.slice(16);
  }
  function currentUser(req) {
    const token = tokenOf(req);
    return token
      ? get(
          "SELECT u.id,u.login,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND NOT EXISTS(SELECT 1 FROM member_status WHERE user_id=u.id AND disabled_at<>'')",
          digest(token),
          Date.now(),
        ) || null
      : null;
  }
  function session(res, id) {
    const token = randomBytes(32).toString("hex");
    run("DELETE FROM sessions WHERE expires<?", Date.now());
    run(
      "INSERT INTO sessions VALUES(?,?,?)",
      digest(token),
      id,
      Date.now() + 604800000,
    );
    res.setHeader(
      "Set-Cookie",
      "worklog_session=" +
        token +
        "; Path=" +
        base +
        "; HttpOnly; SameSite=Lax; Max-Age=604800" +
        (secure ? "; Secure" : ""),
    );
  }
  function audit(user, action, id, before, after) {
    appendAudit(db, user, action, id, before, after);
  }
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const memberAdmin = createMemberAdmin({
    db,
    tx,
    hashPassword,
    validatePassword: password,
  });
  const canEdit = (user) => Boolean(user);
  // The navigation badge is a convenience; never let it break the main state.
  function checklistSummary() {
    try {
      return documents.checklistSummary();
    } catch {
      return {};
    }
  }
  function updateRecord(user, r, f) {
    const completedAt = isCompleted(f) ? r.completed_at || now() : "";
    run(
      "UPDATE records SET task=?,description=?,owner=?,actual=?,date=?,due_date=?,priority=?,blocked=?,blocker_note=?,support_people=?,completed_at=?,version=version+1,updated=? WHERE id=?",
      f.task,
      f.description,
      f.owner,
      f.actual,
      f.date,
      f.due_date,
      f.priority,
      f.blocked,
      f.blocker_note,
      f.support_people,
      completedAt,
      now(),
      r.id,
    );
    saveRelations(db, r.id, f.dependency_ids, r.dependency_ids);
    notifyRelations(db, user, r, { ...r, ...f });
    notifyDependents(db, user, r, { ...r, ...f });
    notifyRecord(db, user, r, { ...r, ...f });
    audit(user, "update-record", r.id, r, {
      ...f,
      parent_id: r.parent_id,
      parent_task: r.parent_id
        ? get("SELECT task FROM records WHERE id=?", r.parent_id)?.task || ""
        : "",
    });
  }
  // Every deleted row shares one group so a single restore undoes the batch.
  function deleteRecords(user, list) {
    const group = randomUUID();
    for (const r of list)
      for (const item of activeDescendants(db, r.id)) {
        run(
          "UPDATE records SET deleted=1,delete_group=?,version=version+1,updated=? WHERE id=?",
          group,
          now(),
          item.id,
        );
        audit(user, "delete-record", item.id, item, null);
        notifyDependents(db, user, item, { ...item, deleted: 1 });
      }
    return get(
      "SELECT r.id,r.version FROM records r LEFT JOIN records p ON p.id=r.parent_id WHERE r.delete_group=? AND r.deleted=1 AND (p.id IS NULL OR p.deleted=0 OR p.delete_group<>r.delete_group) ORDER BY r.created LIMIT 1",
      group,
    );
  }
  const batchChanges = ["actual", "date", "priority", "due_date"];
  function batchRecords(user, b) {
    if (!canEdit(user)) fail(403, "请先登录后修改记录");
    const items = b.items;
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 200 ||
      items.some(
        (x) =>
          !x ||
          typeof x.id !== "string" ||
          !/^[-\w]{1,100}$/.test(x.id) ||
          !Number.isSafeInteger(x.version),
      ) ||
      new Set(items.map((x) => x.id)).size !== items.length
    )
      fail(400, "请选择 1–200 条记录");
    if (!["update", "delete"].includes(b.action)) fail(400, "不支持的批量操作");
    const changes = b.action === "update" ? b.changes : {};
    if (
      !changes ||
      typeof changes !== "object" ||
      Array.isArray(changes) ||
      Object.keys(changes).some((k) => !batchChanges.includes(k)) ||
      (b.action === "update" && !Object.keys(changes).length)
    )
      fail(400, "请选择要批量修改的内容");
    return tx(() => {
      const list = items.map((x) => {
        const r = relationSnapshot(
          db,
          get("SELECT * FROM records WHERE id=?", x.id),
        );
        if (!r || r.deleted || r.version !== x.version)
          fail(409, "部分记录已被修改或删除，请刷新后重试");
        return r;
      });
      if (b.action === "delete")
        return {
          ok: true,
          count: list.length,
          undo: deleteRecords(user, list),
        };
      for (const r of list)
        updateRecord(
          user,
          r,
          fields(
            {
              task: r.task,
              owner: r.owner,
              actual: r.actual,
              date: r.date,
              ...changes,
            },
            r,
          ),
        );
      return { ok: true, count: list.length };
    });
  }
  async function body(req, maxBytes = 65536) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) fail(413, "提交内容过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      fail(400, "请求格式错误");
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    const json = (data, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, "http://localhost"),
        route = url.pathname.startsWith(base + "/")
          ? url.pathname.slice(base.length)
          : url.pathname;
      if (route.startsWith("/api/")) {
        const chunkUpload =
          req.method === "PUT" &&
          /^\/api\/uploads\/[\w-]+\/chunks\/\d+$/.test(route);
        if (!["GET", "HEAD"].includes(req.method)) {
          if (
            req.headers.origin !== origin ||
            req.headers["x-worklog-request"] !== "1" ||
            !String(req.headers["content-type"]).startsWith(
              chunkUpload ? "application/octet-stream" : "application/json",
            )
          )
            fail(403, "请求来源不被允许，请刷新页面重试");
          rate(
            req,
            chunkUpload
              ? "file-upload"
              : /^\/api\/uploads(?:\/|$)/.test(route)
                ? "file-control"
                : "write",
            chunkUpload
              ? 3600
              : /^\/api\/uploads(?:\/|$)/.test(route)
                ? 1200
                : 180,
            60000,
          );
        }
        let user = currentUser(req);
        if (
          route === "/api/resource-events" ||
          route.startsWith("/api/resource-events/")
        ) {
          if (!user) fail(401, "请先登录");
          if (req.method !== "GET") fail(405, "操作日志不可修改或删除");
          return json(readResourceEvents(db, url.searchParams));
        }
        if (
          await documents.binary({
            route,
            method: req.method,
            req,
            res,
            user,
            json,
            params: url.searchParams,
          })
        )
          return;
        if (route === "/api/logs" && req.method === "GET")
          return json(readAudit(db, url.searchParams));
        if (
          (route === "/api/logs" || route.startsWith("/api/logs/")) &&
          req.method !== "GET"
        )
          fail(405, "操作日志不可修改或删除");
        if (route === "/api/health" && req.method === "GET")
          return json({ ok: true });
        if (route === "/api/state" && req.method === "GET") {
          if (user) ensureDueNotifications(db);
          return json({
            unread_notifications: user
              ? get(
                  "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at=''",
                  user.id,
                ).n
              : 0,
            members: user
              ? all("SELECT DISTINCT name FROM users ORDER BY name").map(
                  (u) => u.name,
                )
              : [],
            user,
            checklist: user ? checklistSummary() : {},
            projects: all("SELECT * FROM projects ORDER BY created").map(
              (p) => ({ ...p, members: JSON.parse(p.members) }),
            ),
            records: hydrateRelations(
              db,
              all(
                "SELECT r.*,u.name AS creator_name,(SELECT COUNT(*) FROM records c WHERE c.parent_id=r.id AND c.deleted=0) AS child_count,(SELECT COUNT(*) FROM task_comments c WHERE c.record_id=r.id AND c.deleted=0) AS comment_count FROM records r JOIN users u ON r.creator=u.id WHERE r.deleted=0 ORDER BY r.created DESC",
              ),
            ).map((r) => ({ ...r, editable: !!canEdit(user, r) })),
          });
        }
        const configurationWrite =
          /^\/api\/(?:projects\/[\w-]+\/configurations|configurations\/[\w-]+\/versions)$/.test(
            route,
          );
        const credentialWrite =
          /^\/api\/(?:projects\/[\w-]+\/credentials|credentials\/[\w-]+)$/.test(
            route,
          );
        const b =
          req.method === "GET"
            ? {}
            : await body(
                req,
                configurationWrite ? 4194304 : credentialWrite ? 262144 : 65536,
              );
        if (!b || typeof b !== "object" || Array.isArray(b))
          fail(400, "请求格式错误");
        // A member can be disabled or have their sessions reset while a request body is arriving.
        user = currentUser(req);
        const memberResult = await memberAdmin({
          route,
          method: req.method,
          b,
          user,
          sessionValid: () => currentUser(req)?.id === user?.id,
        });
        if (memberResult)
          return json(memberResult.data, memberResult.status || 200);
        if (route === "/api/admin/audit-redactions" && req.method === "POST") {
          requireMemberAdmin(db, user);
          if (b.currentContentReviewed !== true)
            fail(400, "请先处理仍在公开的正文及其他副本，再确认遮蔽历史");
          return json(
            tx(() => redactAudit(db, user, b.auditId)),
            201,
          );
        }
        for (const service of [
          documents,
          resources,
          notes,
          milestones,
          changes,
          projectOverview,
          projectArchive,
        ]) {
          const result = await service.api({
            route,
            method: req.method,
            params: url.searchParams,
            b,
            user,
          });
          if (result) return json(result.data, result.status || 200);
        }
        const notificationResult = notificationsAPI(db, {
          route,
          method: req.method,
          params: url.searchParams,
          b,
          user,
        });
        if (notificationResult)
          return json(
            notificationResult.data,
            notificationResult.status || 200,
          );
        const commentResult = commentsAPI(db, {
          route,
          method: req.method,
          params: url.searchParams,
          b,
          user,
        });
        if (commentResult)
          return json(commentResult.data, commentResult.status || 200);
        if (route === "/api/register" && req.method === "POST") {
          rate(req, "register", 12, 3600000);
          const name = registrationName(b.name);
          const login = field(b, "login", 32).toLowerCase(),
            p = password(b);
          if (!/^[a-z0-9_\-]{3,32}$/.test(login))
            fail(400, "账号使用 3–32 位字母、数字、下划线或短横线");
          if (get("SELECT id FROM users WHERE login=?", login))
            fail(409, "这个账号已被使用");
          const id = randomUUID(),
            hash = await hashPassword(p);
          try {
            tx(() => {
              run(
                "INSERT INTO users VALUES(?,?,?,?,?,?)",
                id,
                login,
                name,
                hash,
                "member",
                now(),
              );
              if (!allowUninvitedRegistration)
                consumeInvitation(db, id, name, b.invitationCode);
              session(res, id);
            });
          } catch (e) {
            if (String(e).includes("UNIQUE")) fail(409, "这个账号已被使用");
            throw e;
          }
          return json({ ok: true }, 201);
        }
        if (route === "/api/login" && req.method === "POST") {
          rate(req, "login", 40, 900000);
          const login = field(b, "login", 32),
            p = password(b),
            target = get("SELECT * FROM users WHERE login=?", login);
          if (!target || !isMemberActive(db, target.id)) {
            await derive(p, "worklog-dummy-salt", 64);
            fail(401, "账号或密码不正确");
          }
          if (!(await verifyPassword(p, target.password)))
            fail(401, "账号或密码不正确");
          // Verification is asynchronous: a concurrent password change must invalidate this login.
          if (
            get("SELECT password FROM users WHERE id=?", target.id)
              ?.password !== target.password ||
            !isMemberActive(db, target.id)
          )
            fail(401, "账号或密码不正确");
          session(res, target.id);
          return json({ ok: true });
        }
        if (!user) fail(401, "请先登录");
        if (route === "/api/logout" && req.method === "POST") {
          const token = tokenOf(req);
          if (token) run("DELETE FROM sessions WHERE token=?", digest(token));
          res.setHeader(
            "Set-Cookie",
            "worklog_session=; Path=" +
              base +
              "; HttpOnly; SameSite=Lax; Max-Age=0" +
              (secure ? "; Secure" : ""),
          );
          return json({ ok: true });
        }
        if (route === "/api/password" && req.method === "POST") {
          const old = password(b, "oldPassword"),
            next = password(b);
          const previousHash = get(
            "SELECT password FROM users WHERE id=?",
            user.id,
          ).password;
          if (!(await verifyPassword(old, previousHash)))
            fail(400, "原密码不正确");
          const nextHash = await hashPassword(next);
          tx(() => {
            if (!isMemberActive(db, user.id))
              fail(401, "账号已停用，请联系管理员");
            if (
              get("SELECT password FROM users WHERE id=?", user.id)
                ?.password !== previousHash
            )
              fail(409, "密码已被修改，请重新登录后重试");
            if (!currentUser(req)) fail(401, "登录已失效，请重新登录");
            const changed = run(
              "UPDATE users SET password=? WHERE id=? AND password=?",
              nextHash,
              user.id,
              previousHash,
            );
            if (changed.changes !== 1)
              fail(409, "密码已被修改，请重新登录后重试");
            run("DELETE FROM sessions WHERE user_id=?", user.id);
            session(res, user.id);
          });
          return json({ ok: true });
        }
        if (route === "/api/projects" && req.method === "POST") {
          const name = field(b, "name", 60);
          if (get("SELECT id FROM projects WHERE name=?", name))
            fail(409, "已有同名项目");
          const id = randomUUID(),
            f = projectFields(b);
          tx(() => {
            run(
              "INSERT INTO projects(id,name,creator,version,created,color,members) VALUES(?,?,?,?,?,?,?)",
              id,
              name,
              user.id,
              1,
              now(),
              f.color,
              f.members,
            );
            audit(user, "create-project", id, null, {
              name,
              color: f.color,
              members: f.members,
            });
          });
          return json({ id }, 201);
        }
        const pm = route.match(/^\/api\/projects\/([\w-]+)$/);
        if (pm && req.method === "PATCH") {
          const p = get("SELECT * FROM projects WHERE id=?", pm[1]);
          if (!p) fail(404, "项目不存在");
          if (!canEdit(user, p)) fail(403, "请先登录后修改项目");
          if (b.version !== p.version) fail(409, "项目已被修改，请刷新后重试");
          const name = field(b, "name", 60);
          if (get("SELECT id FROM projects WHERE name=? AND id<>?", name, p.id))
            fail(409, "已有同名项目");
          const f = projectFields(b, p);
          tx(() => {
            run(
              "UPDATE projects SET name=?,color=?,members=?,archived=?,version=version+1 WHERE id=?",
              name,
              f.color,
              f.members,
              f.archived,
              p.id,
            );
            audit(user, "update-project", p.id, p, { name, ...f });
          });
          return json({ ok: true });
        }
        if (route === "/api/records" && req.method === "POST") {
          const f = fields(b);
          if (
            typeof b.project_id !== "string" ||
            !get("SELECT id FROM projects WHERE id=?", b.project_id)
          )
            fail(404, "项目不存在");
          const id = randomUUID();
          const parent = validateParent(db, b.parent_id, b.project_id);
          const completedAt = isCompleted(f) ? now() : "";
          tx(() => {
            run(
              "INSERT INTO records(id,project_id,task,description,owner,actual,date,creator,created,updated,version,deleted,parent_id,completed_at,due_date,priority,blocked,blocker_note,support_people) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              id,
              b.project_id,
              f.task,
              f.description,
              f.owner,
              f.actual,
              f.date,
              user.id,
              now(),
              now(),
              1,
              0,
              parent?.id || null,
              completedAt,
              f.due_date,
              f.priority,
              f.blocked,
              f.blocker_note,
              f.support_people,
            );
            saveRelations(db, id, f.dependency_ids);
            notifyRelations(db, user, null, {
              ...f,
              id,
              project_id: b.project_id,
            });
            notifyRecord(db, user, null, {
              ...f,
              id,
              project_id: b.project_id,
            });
            audit(user, "create-record", id, null, {
              ...f,
              parent_id: parent?.id || null,
              parent_task: parent?.task || "",
            });
          });
          return json({ id }, 201);
        }
        if (route === "/api/records/batch" && req.method === "POST")
          return json(batchRecords(user, b));
        const rm = route.match(/^\/api\/records\/([\w-]+)(\/restore)?$/);
        if (rm && ["PATCH", "DELETE", "POST"].includes(req.method)) {
          const r = relationSnapshot(
            db,
            get("SELECT * FROM records WHERE id=?", rm[1]),
          );
          if (!r) fail(404, "记录不存在");
          if (!canEdit(user, r)) fail(403, "请先登录后修改记录");
          if (b.version !== r.version)
            fail(409, "这条记录已被修改，请刷新后重试");
          if (rm[2] && req.method === "POST" && r.deleted) {
            if (
              r.parent_id &&
              get("SELECT deleted FROM records WHERE id=?", r.parent_id)
                ?.deleted
            )
              fail(409, "请先恢复上级任务");
            tx(() => {
              const restore = r.delete_group
                ? all(
                    "SELECT * FROM records WHERE delete_group=? AND deleted=1",
                    r.delete_group,
                  )
                : [r];
              for (const item of restore) {
                run(
                  "UPDATE records SET deleted=0,delete_group='',version=version+1,updated=? WHERE id=?",
                  now(),
                  item.id,
                );
                audit(user, "restore-record", item.id, item, null);
                notifyDependents(db, user, item, { ...item, deleted: 0 });
              }
            });
            return json({ ok: true });
          }
          if (r.deleted) fail(404, "记录已删除");
          if (!rm[2] && req.method === "PATCH") {
            const f = fields(b, r);
            if (
              b.parent_id !== undefined &&
              (b.parent_id || null) !== r.parent_id
            )
              fail(400, "暂不支持调整上级任务");
            tx(() => updateRecord(user, r, f));
            return json({ ok: true });
          }
          if (!rm[2] && req.method === "DELETE") {
            tx(() => deleteRecords(user, [r]));
            return json({ ok: true, version: r.version + 1 });
          }
        }
        fail(404, "接口不存在");
      }
      if (!["GET", "HEAD"].includes(req.method)) fail(405, "不支持的请求");
      const rel =
          route === "/" || route === ""
            ? "index.html"
            : decodeURIComponent(route).replace(/^\//, ""),
        file = path.resolve(dist, rel);
      if (
        !file.startsWith(path.resolve(dist) + path.sep) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      )
        fail(404, "页面不存在");
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control":
          rel === "index.html" ? "no-cache" : "public, max-age=86400",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (!e.status) console.error("Request failed:", e.message);
      if (!res.headersSent)
        json(
          {
            error: e.status ? e.message : "保存失败，请稍后重试",
            ...(e.code === "NOTE_CREATE_NOT_COMMITTED" ? { code: e.code } : {}),
          },
          e.status || 500,
        );
      else res.end();
    }
  });
  const dueTimer = setInterval(() => {
    try {
      ensureDueNotifications(db);
    } catch (e) {
      console.error("Due reminder failed:", e.message);
    }
  }, 60000);
  dueTimer.unref();
  // Upload bodies are streamed in bounded chunks; allow slower connections.
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  return {
    server,
    db,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          clearInterval(dueTimer);
          db.close();
          resolve();
        }),
      ),
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  app.server.listen(
    Number(process.env.PORT || 8766),
    process.env.HOST || "127.0.0.1",
    () => console.log("Worklog ready"),
  );
  const stop = () => app.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
