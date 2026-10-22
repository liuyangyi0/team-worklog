import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";
import { createMemberAdmin } from "../members.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worklog-members-"));
  const origin = "http://127.0.0.1:9876";
  const app = await createApp({
    dataDir: dir,
    origin,
    adminPassword: "Fixture-admin-1234",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const root = `http://127.0.0.1:${app.server.address().port}/worklog/api`;
  async function call(route, method = "GET", body, cookie = "") {
    const r = await fetch(root + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Worklog-Request": "1",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const admin = await call("/login", "POST", {
    login: "admin",
    password: "Fixture-admin-1234",
  });
  assert.equal(admin.status, 200);
  return { app, call, admin };
}

test("strict invitations bind a name, consume once atomically, retain only a digest and prevent duplicate identities", async (t) => {
  const { app, call, admin } = await fixture(t);
  const signup = {
    login: "member_a",
    name: REGISTRATION_NAMES[0],
    password: "Fixture-member-1234",
  };
  assert.equal((await call("/register", "POST", signup)).status, 400);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
  assert.equal(
    (await call("/admin/invitations", "POST", { name: signup.name })).status,
    401,
  );
  const issued = await call(
    "/admin/invitations",
    "POST",
    { name: signup.name },
    admin.cookie,
  );
  assert.equal(issued.status, 201);
  assert.equal(issued.data.code.length, 48);
  const stored = app.db
    .prepare("SELECT * FROM member_invitations WHERE id=?")
    .get(issued.data.id);
  assert.equal(JSON.stringify(stored).includes(issued.data.code), false);
  const wrong = await call("/register", "POST", {
    ...signup,
    name: REGISTRATION_NAMES[1],
    invitationCode: issued.data.code,
  });
  assert.equal(wrong.status, 400);
  const attempts = await Promise.all([
    call("/register", "POST", { ...signup, invitationCode: issued.data.code }),
    call("/register", "POST", {
      ...signup,
      login: "member_b",
      invitationCode: issued.data.code,
    }),
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 400]);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) n FROM users WHERE name=?").get(signup.name)
      .n,
    1,
  );
  assert.equal(
    (
      await call(
        "/admin/invitations",
        "POST",
        { name: signup.name },
        admin.cookie,
      )
    ).status,
    409,
  );
  const listed = await call(
    "/admin/invitations",
    "GET",
    undefined,
    admin.cookie,
  );
  assert.equal(JSON.stringify(listed.data).includes(issued.data.code), false);
  assert.equal(JSON.stringify(listed.data).includes("code_hash"), false);
  const member = attempts.find((r) => r.status === 201);
  assert.equal(
    (await call("/admin/members", "GET", undefined, member.cookie)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/projects",
        "POST",
        { name: "成员可维护的项目" },
        member.cookie,
      )
    ).status,
    201,
  );
});

test("revoked and expired invites fail and replacement invalidates the previous code", async (t) => {
  const { app, call, admin } = await fixture(t);
  const name = REGISTRATION_NAMES[1];
  const issue = () =>
    call("/admin/invitations", "POST", { name }, admin.cookie);
  const old = await issue(),
    current = await issue();
  const signup = (invitationCode) =>
    call("/register", "POST", {
      login: "member_x",
      name,
      invitationCode,
      password: "Fixture-member-1234",
    });
  assert.equal((await signup(old.data.code)).status, 400);
  assert.equal(
    (
      await call(
        `/admin/invitations/${current.data.id}/revoke`,
        "POST",
        {},
        admin.cookie,
      )
    ).status,
    200,
  );
  assert.equal((await signup(current.data.code)).status, 400);
  const expired = await issue();
  app.db
    .prepare("UPDATE member_invitations SET expires_at=? WHERE id=?")
    .run("2000-01-01T00:00:00.000Z", expired.data.id);
  assert.equal((await signup(expired.data.code)).status, 400);
});

test("disable and reset revoke all sessions, retain history and protect the last administrator", async (t) => {
  const { app, call, admin } = await fixture(t);
  const name = REGISTRATION_NAMES[2];
  const invite = await call(
    "/admin/invitations",
    "POST",
    { name },
    admin.cookie,
  );
  const member = await call("/register", "POST", {
    login: "member_c",
    name,
    password: "Fixture-member-1234",
    invitationCode: invite.data.code,
  });
  const second = await call("/login", "POST", {
    login: "member_c",
    password: "Fixture-member-1234",
  });
  const id = (await call("/state", "GET", undefined, member.cookie)).data.user
    .id;
  const project = await call(
    "/projects",
    "POST",
    { name: "历史保留" },
    member.cookie,
  );
  assert.equal(project.status, 201);
  assert.equal(
    (
      await call(
        `/admin/members/${id}/status`,
        "POST",
        { disabled: true },
        admin.cookie,
      )
    ).status,
    200,
  );
  for (const cookie of [member.cookie, second.cookie])
    assert.equal(
      (await call("/state", "GET", undefined, cookie)).data.user,
      null,
    );
  assert.equal(
    (
      await call("/login", "POST", {
        login: "member_c",
        password: "Fixture-member-1234",
      })
    ).status,
    401,
  );
  assert.ok((await call("/logs")).data.entries.some((e) => e.actor === name));
  assert.equal(
    (
      await call(
        `/admin/members/${id}/status`,
        "POST",
        { disabled: false },
        admin.cookie,
      )
    ).status,
    200,
  );
  const restored = await call("/login", "POST", {
    login: "member_c",
    password: "Fixture-member-1234",
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (
      await call(
        `/admin/members/${id}/reset-password`,
        "POST",
        { password: "Fixture-next-9876" },
        admin.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/state", "GET", undefined, restored.cookie)).data.user,
    null,
  );
  assert.equal(
    (
      await call("/login", "POST", {
        login: "member_c",
        password: "Fixture-member-1234",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("/login", "POST", {
        login: "member_c",
        password: "Fixture-next-9876",
      })
    ).status,
    200,
  );
  const adminId = app.db
    .prepare("SELECT id FROM users WHERE role='admin'")
    .get().id;
  assert.equal(
    (
      await call(
        `/admin/members/${adminId}/status`,
        "POST",
        { disabled: true },
        admin.cookie,
      )
    ).status,
    409,
  );
  const history = JSON.stringify(
    (await call("/admin/member-events", "GET", undefined, admin.cookie)).data,
  );
  assert.equal(history.includes("Fixture-next-9876"), false);
  assert.throws(() => app.db.exec("DELETE FROM member_events"), /append-only/);
});

test("admin redaction hides both snapshots from every log reader while retaining immutable source and attribution", async (t) => {
  const { app, call, admin } = await fixture(t);
  const project = await call(
    "/projects",
    "POST",
    { name: "待处理项目" },
    admin.cookie,
  );
  const record = await call(
    "/records",
    "POST",
    {
      project_id: project.data.id,
      task: "普通事项",
      owner: REGISTRATION_NAMES[0],
      description: "synthetic-leaked-secret",
    },
    admin.cookie,
  );
  assert.equal(record.status, 201);
  const logs = await call("/logs");
  const entry = logs.data.entries.find((e) => e.action === "create-record");
  const original = app.db
    .prepare("SELECT * FROM audit WHERE id=?")
    .get(entry.id);
  assert.equal(
    (
      await call("/admin/audit-redactions", "POST", {
        auditId: entry.id,
        currentContentReviewed: true,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        "/admin/audit-redactions",
        "POST",
        { auditId: entry.id },
        admin.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/records/" + record.data.id,
        "PATCH",
        {
          version: 1,
          task: "普通事项",
          owner: REGISTRATION_NAMES[0],
          actual: "",
          description: "已清理正文",
        },
        admin.cookie,
      )
    ).status,
    200,
  );
  const publicBefore = (await call("/logs")).data.entries.filter(
    (e) => e.entityId === record.data.id,
  );
  for (const item of publicBefore)
    assert.equal(
      (
        await call(
          "/admin/audit-redactions",
          "POST",
          { auditId: item.id, currentContentReviewed: true },
          admin.cookie,
        )
      ).status,
      201,
    );
  for (const cookie of ["", admin.cookie]) {
    const after = await call(
      "/logs?project=" + project.data.id,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(
      JSON.stringify(after.data).includes("synthetic-leaked-secret"),
      false,
    );
    const redacted = after.data.entries.find((e) => e.id === entry.id);
    assert.equal(redacted.before, null);
    assert.equal(redacted.after, null);
    assert.equal(redacted.redaction.reason, "误贴敏感信息");
    assert.equal(redacted.redaction.actor, "管理员");
    assert.equal(
      JSON.stringify(
        (await call("/state", "GET", undefined, cookie)).data,
      ).includes("synthetic-leaked-secret"),
      false,
    );
  }
  assert.deepEqual(
    app.db.prepare("SELECT * FROM audit WHERE id=?").get(entry.id),
    original,
  );
  assert.throws(
    () => app.db.exec("DELETE FROM audit_redactions"),
    /append-only/,
  );
  assert.throws(() => app.db.exec("DELETE FROM audit"), /append-only/);
  assert.equal(
    (
      await call(
        "/admin/audit-redactions",
        "POST",
        { auditId: entry.id, currentContentReviewed: true },
        admin.cookie,
      )
    ).status,
    409,
  );
});

test("an admin reset that loses its session while hashing cannot commit", async (t) => {
  const { app } = await fixture(t);
  const admin = app.db
    .prepare("SELECT id,name,role FROM users WHERE role='admin'")
    .get();
  const previous = app.db
    .prepare("SELECT password FROM users WHERE id=?")
    .get(admin.id).password;
  let release, hashing;
  const started = new Promise((r) => {
    hashing = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  let sessionValid = true;
  const handler = createMemberAdmin({
    db: app.db,
    tx: (fn) => fn(),
    validatePassword: (b) => b.password,
    hashPassword: async () => {
      hashing();
      await gate;
      return "synthetic-uncommitted-hash";
    },
  });
  const pending = handler({
    route: `/api/admin/members/${admin.id}/reset-password`,
    method: "POST",
    b: { password: "Fixture-next-1234" },
    user: admin,
    sessionValid: () => sessionValid,
  });
  await started;
  sessionValid = false;
  release();
  await assert.rejects(pending, (e) => e.status === 401);
  assert.equal(
    app.db.prepare("SELECT password FROM users WHERE id=?").get(admin.id)
      .password,
    previous,
  );
});

test("concurrent admin password resets cannot silently overwrite each other", async (t) => {
  const { app, call, admin } = await fixture(t);
  const id = "synthetic-reset-target";
  app.db
    .prepare(
      "INSERT INTO users(id,login,name,password,role,created) SELECT ?,?,?,password,'member',created FROM users WHERE role='admin' LIMIT 1",
    )
    .run(id, "reset_target", REGISTRATION_NAMES[1]);
  const result = await Promise.all([
    call(
      `/admin/members/${id}/reset-password`,
      "POST",
      { password: "Fixture-next-a-1234" },
      admin.cookie,
    ),
    call(
      `/admin/members/${id}/reset-password`,
      "POST",
      { password: "Fixture-next-b-1234" },
      admin.cookie,
    ),
  ]);
  assert.deepEqual(result.map((v) => v.status).sort(), [200, 409]);
  assert.equal(
    app.db
      .prepare(
        "SELECT COUNT(*) n FROM member_events WHERE action='reset-password'",
      )
      .get().n,
    1,
  );
});

test("legacy admin login collision can be resolved explicitly without promoting an existing member", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "worklog-admin-bootstrap-"));
  let app = await createApp({ dataDir: dir });
  const legacyHash = "fixture-not-used-for-login";
  app.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,?,?)")
    .run(
      "legacy-user",
      "admin",
      REGISTRATION_NAMES[0],
      legacyHash,
      "member",
      new Date().toISOString(),
    );
  app.db.close();
  await assert.rejects(
    createApp({ dataDir: dir, adminPassword: "Fixture-admin-1234" }),
    /ADMIN_LOGIN/,
  );
  app = await createApp({
    dataDir: dir,
    adminLogin: "workspace_admin",
    adminPassword: "Fixture-admin-1234",
  });
  t.after(async () => {
    app.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(
    app.db.prepare("SELECT role FROM users WHERE id='legacy-user'").get().role,
    "member",
  );
  assert.equal(
    app.db.prepare("SELECT login FROM users WHERE role='admin'").get().login,
    "workspace_admin",
  );
});
