const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);

(async () => {
  const repo = path.resolve(__dirname, "..");
  const { createApp } = await import(
    pathToFileURL(path.join(repo, "server.mjs")).href
  );
  const { REGISTRATION_NAMES } = await import(
    pathToFileURL(path.join(repo, "registration.mjs")).href
  );
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-members-ui-"),
  );
  const origin = "http://127.0.0.1:8798";
  let phase = "setup",
    app,
    browser,
    cookie = "";
  async function api(route, method = "GET", body) {
    const res = await fetch(origin + "/worklog/api" + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Worklog-Request": "1",
        Cookie: cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    assert.ok(res.ok, JSON.stringify(data));
    if (res.headers.get("set-cookie"))
      cookie = res.headers.get("set-cookie").split(";")[0];
    return data;
  }
  const cookieObject = (value) => ({
    name: "worklog_session",
    value: value.split("=").slice(1).join("="),
    domain: "127.0.0.1",
    path: "/worklog",
    httpOnly: true,
    sameSite: "Lax",
  });
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Fixture-admin-1234",
      dist: path.join(repo, "dist"),
    });
    await new Promise((r) => app.server.listen(8798, "127.0.0.1", r));
    await api("/login", "POST", {
      login: "admin",
      password: "Fixture-admin-1234",
    });
    const adminCookie = cookie;
    const project = (await api("/state")).projects[0];
    const record = await api("/records", "POST", {
      project_id: project.id,
      task: "遮蔽验收事项",
      owner: REGISTRATION_NAMES[0],
      description: "synthetic-ui-leak",
    });
    await api("/records/" + record.id, "PATCH", {
      version: 1,
      task: "遮蔽验收事项",
      owner: REGISTRATION_NAMES[0],
      description: "公开正文已清理",
    });
    const old = (await api("/logs")).entries.find(
      (e) => e.action === "create-record",
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([cookieObject(adminCookie)]);
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/");
    phase = "create invitation";
    await page.locator(".account-area button").first().click();
    await page.getByRole("button", { name: "成员与邀请", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("邀请成员", { exact: true })
      .selectOption(REGISTRATION_NAMES[1]);
    const invitationResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/invitations") &&
        r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "生成邀请", exact: true }).click();
    const issued = await (await invitationResponse).json();
    await dialog.getByText(issued.code, { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".account-area button").first().click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    phase = "register invited member";
    await page.getByRole("button", { name: /^登录 \/ 注册/ }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "注册账号", exact: true }).click();
    await dialog
      .getByLabel("你的姓名", { exact: true })
      .fill(REGISTRATION_NAMES[1]);
    await dialog.getByLabel("账号", { exact: true }).fill("invited_ui");
    await dialog
      .getByLabel("密码", { exact: true })
      .fill("Fixture-invited-1234");
    await dialog.locator('input[name="invitationCode"]').fill(issued.code);
    const signupResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/register") && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "注册并开始填写", exact: true })
      .click();
    assert.equal((await signupResponse).status(), 201);
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      (await page.locator(".account-area").innerText()).includes(
        REGISTRATION_NAMES[1],
      ),
      await page.locator(".account-area").innerText(),
    );
    await page.locator(".account-area button").first().click();
    assert.equal(
      await page
        .getByRole("button", { name: "成员与邀请", exact: true })
        .count(),
      0,
    );
    await context.clearCookies();
    await api("/login", "POST", {
      login: "admin",
      password: "Fixture-admin-1234",
    });
    await context.addCookies([cookieObject(cookie)]);
    await page.reload();
    phase = "redact audit entry";
    await page.getByRole("tab", { name: "操作日志", exact: true }).click();
    const entry = page.locator(`[data-log-id="${old.id}"]`);
    await entry
      .getByRole("button", { name: "遮蔽敏感内容", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: "确认遮蔽并留痕",
      exact: true,
    });
    assert.equal(await confirm.isDisabled(), true);
    await dialog.getByText(/请先修改仍公开的任务/).waitFor();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    await entry
      .getByText("内容已因误贴敏感信息遮蔽", { exact: true })
      .waitFor();
    assert.equal(
      (await entry.innerText()).includes("synthetic-ui-leak"),
      false,
    );
    assert.ok((await entry.innerText()).includes("原日志保留"));
    assert.equal(
      (await api("/logs")).entries.find((e) => e.id === old.id).after,
      null,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS strict invitation UI, member management visibility, redaction confirmation and mobile layout",
    );
  } catch (error) {
    console.error("Browser validation phase:", phase, error);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (app) {
      app.server.closeAllConnections();
      await app.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
