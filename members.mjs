import { createHash, randomBytes, randomUUID } from "node:crypto";
import { REGISTRATION_NAMES, registrationName } from "./registration.mjs";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

export function installMemberSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_status(user_id TEXT PRIMARY KEY REFERENCES users(id),disabled_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS member_invitations(id TEXT PRIMARY KEY,name TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_by TEXT REFERENCES users(id),consumed_at TEXT NOT NULL DEFAULT '',revoked_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS member_events(id INTEGER PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,target_name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS member_events_no_update BEFORE UPDATE ON member_events BEGIN SELECT RAISE(ABORT,'member logs are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS member_events_no_delete BEFORE DELETE ON member_events BEGIN SELECT RAISE(ABORT,'member logs are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS member_events_no_replace BEFORE INSERT ON member_events WHEN EXISTS(SELECT 1 FROM member_events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'member logs are append-only'); END;
  `);
}

export function isMemberActive(db, id) {
  return Boolean(
    db
      .prepare(
        "SELECT id FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM member_status WHERE user_id=users.id AND disabled_at<>'')",
      )
      .get(id),
  );
}

export function requireMemberAdmin(db, user) {
  if (!user) fail(401, "请先登录");
  if (
    !db
      .prepare("SELECT id FROM users WHERE id=? AND role='admin'")
      .get(user.id) ||
    !isMemberActive(db, user.id)
  )
    fail(403, "仅管理员可管理成员和敏感内容遮蔽");
}

export function consumeInvitation(db, userId, name, rawCode) {
  if (typeof rawCode !== "string" || !/^[a-f0-9]{48}$/i.test(rawCode.trim()))
    fail(400, "请填写管理员为你生成的有效邀请码");
  const invitation = db
    .prepare(
      "SELECT * FROM member_invitations WHERE code_hash=? AND name=? AND consumed_at='' AND revoked_at='' AND expires_at>?",
    )
    .get(digest(rawCode.trim().toLowerCase()), name, now());
  if (!invitation) fail(400, "邀请码无效、已使用或与姓名不符");
  if (
    db.prepare("SELECT id FROM users WHERE name=? AND id<>?").get(name, userId)
  )
    fail(409, "该姓名已有账号，请联系管理员恢复账号");
  const changed = db
    .prepare(
      "UPDATE member_invitations SET consumed_by=?,consumed_at=? WHERE id=? AND consumed_at='' AND revoked_at='' AND expires_at>?",
    )
    .run(userId, now(), invitation.id, now());
  if (changed.changes !== 1) fail(409, "邀请码已失效，请联系管理员重新生成");
}

export function createMemberAdmin({ db, tx, hashPassword, validatePassword }) {
  const event = (user, action, id, name) =>
    db
      .prepare(
        "INSERT INTO member_events(actor_id,actor_name,action,target_id,target_name,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(user.id, user.name, action, id, name, now());
  return async ({ route, method, b, user, sessionValid }) => {
    const checkAdmin = () => {
      requireMemberAdmin(db, user);
      if (sessionValid && !sessionValid()) fail(401, "登录已失效，请重新登录");
    };
    if (
      !route.startsWith("/api/admin/members") &&
      !route.startsWith("/api/admin/invitations") &&
      route !== "/api/admin/member-events"
    )
      return null;
    checkAdmin();
    if (route === "/api/admin/members" && method === "GET")
      return {
        data: {
          members: db
            .prepare(
              "SELECT u.id,u.login,u.name,u.role,u.created,COALESCE(ms.disabled_at,'') AS disabled_at FROM users u LEFT JOIN member_status ms ON ms.user_id=u.id ORDER BY u.created,u.id",
            )
            .all(),
          registrationNames: REGISTRATION_NAMES,
        },
      };
    if (route === "/api/admin/member-events" && method === "GET")
      return {
        data: {
          entries: db
            .prepare("SELECT * FROM member_events ORDER BY id DESC LIMIT 100")
            .all(),
        },
      };
    if (route === "/api/admin/invitations" && method === "GET")
      return {
        data: {
          invitations: db
            .prepare(
              "SELECT id,name,created_at,expires_at,consumed_at,revoked_at FROM member_invitations ORDER BY created_at DESC LIMIT 100",
            )
            .all(),
        },
      };
    if (route === "/api/admin/invitations" && method === "POST") {
      const name = registrationName(b.name);
      const id = randomUUID(),
        code = randomBytes(24).toString("hex"),
        created = now(),
        expires = new Date(Date.now() + 7 * 86400000).toISOString();
      tx(() => {
        checkAdmin();
        if (db.prepare("SELECT id FROM users WHERE name=?").get(name))
          fail(409, "该姓名已有账号，请恢复原账号，不要重复注册");
        db.prepare(
          "UPDATE member_invitations SET revoked_at=? WHERE name=? AND consumed_at='' AND revoked_at=''",
        ).run(created, name);
        db.prepare(
          "INSERT INTO member_invitations(id,name,code_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?)",
        ).run(id, name, digest(code), user.id, created, expires);
        event(user, "create-invitation", id, name);
      });
      return { status: 201, data: { id, name, code, expires_at: expires } };
    }
    const invitation = route.match(
      /^\/api\/admin\/invitations\/([\w-]+)\/revoke$/,
    );
    if (invitation && method === "POST") {
      tx(() => {
        checkAdmin();
        const row = db
          .prepare("SELECT * FROM member_invitations WHERE id=?")
          .get(invitation[1]);
        if (!row) fail(404, "邀请不存在");
        if (row.consumed_at || row.revoked_at) fail(409, "邀请已使用或撤销");
        db.prepare("UPDATE member_invitations SET revoked_at=? WHERE id=?").run(
          now(),
          row.id,
        );
        event(user, "revoke-invitation", row.id, row.name);
      });
      return { data: { ok: true } };
    }
    const member = route.match(
      /^\/api\/admin\/members\/([\w-]+)\/(status|reset-password)$/,
    );
    if (member && method === "POST") {
      const previous = db
        .prepare("SELECT password FROM users WHERE id=?")
        .get(member[1]);
      if (!previous) fail(404, "成员不存在");
      const nextHash =
        member[2] === "reset-password"
          ? await hashPassword(validatePassword(b))
          : null;
      tx(() => {
        checkAdmin();
        const target = db
          .prepare("SELECT id,name,role FROM users WHERE id=?")
          .get(member[1]);
        if (!target) fail(404, "成员不存在");
        if (member[2] === "status") {
          if (typeof b.disabled !== "boolean") fail(400, "成员状态无效");
          if (
            b.disabled &&
            target.role === "admin" &&
            isMemberActive(db, target.id)
          ) {
            const count = db
              .prepare(
                "SELECT COUNT(*) n FROM users u WHERE role='admin' AND NOT EXISTS(SELECT 1 FROM member_status WHERE user_id=u.id AND disabled_at<>'')",
              )
              .get().n;
            if (count <= 1) fail(409, "不能停用最后一位有效管理员");
          }
          db.prepare(
            "INSERT INTO member_status(user_id,disabled_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET disabled_at=excluded.disabled_at",
          ).run(target.id, b.disabled ? now() : "");
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
          event(
            user,
            b.disabled ? "disable-member" : "enable-member",
            target.id,
            target.name,
          );
        } else {
          const changed = db
            .prepare("UPDATE users SET password=? WHERE id=? AND password=?")
            .run(nextHash, target.id, previous.password);
          if (changed.changes !== 1) fail(409, "密码已被修改，请刷新后重试");
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
          event(user, "reset-password", target.id, target.name);
        }
      });
      return { data: { ok: true } };
    }
    fail(405, "不支持的成员管理操作");
  };
}
