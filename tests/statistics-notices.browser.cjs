const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
(async () => {
  const { createApp } = await import(
    pathToFileURL(path.resolve(__dirname, "../server.mjs")).href
  );
  const { REGISTRATION_NAMES } = await import(
    pathToFileURL(path.resolve(__dirname, "../registration.mjs")).href
  );
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-statistics-ui-"),
  );
  const origin = "http://127.0.0.1:8796";
  let app, browser;
  try {
    app = await createApp({
      dataDir: dir,
      origin,
      adminPassword: "Temporary-fixture-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8796, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const r = await fetch(origin + "/worklog/api" + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      assert.ok(r.ok, JSON.stringify(data));
      return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] || "" };
    }
    const admin = await api("/login", "POST", {
      login: "admin",
      password: "Temporary-fixture-123",
    });
    const project = (await api("/state")).data.projects[0];
    const id = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "统计月份验收",
          owner: REGISTRATION_NAMES[0],
          actual: REGISTRATION_NAMES[0],
          date: "2026-10-01",
        },
        admin.cookie,
      )
    ).data.id;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies([
      {
        name: "worklog_session",
        value: admin.cookie.split("=").slice(1).join("="),
        url: origin,
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?project=" + project.id);
    await page.getByLabel("操作：统计月份验收", { exact: true }).click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "编辑记录" });
    await dialog
      .getByText("此处内容及修改历史公开可见。", { exact: false })
      .waitFor();
    await dialog
      .getByLabel("完成日期（选填）", { exact: true })
      .fill("2026-09-30");
    await dialog
      .getByRole("status")
      .filter({ hasText: "统计月份将从 2026-10 调整为 2026-09" })
      .waitFor();
    await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const changed = (await api("/state")).data.records.find((r) => r.id === id);
    assert.equal(changed.date, "2026-09-30");
    assert.equal(changed.actual, REGISTRATION_NAMES[0]);
    // Use a fresh page to remove the default month filter after the date moved.
    await page.goto(origin + "/worklog/?project=" + project.id);
    await page.getByLabel("选择月份：", { exact: false }).click();
    await page.getByRole("button", { name: "全部日期", exact: true }).click();
    await page.getByLabel("操作：统计月份验收", { exact: true }).click();
    await page.getByRole("button", { name: "添加子任务", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "添加子任务" });
    await dialog
      .getByRole("status")
      .filter({ hasText: "不再单独计入完成数量" })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
      "mobile dialog overflow",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel("操作：统计月份验收", { exact: true }).click();
    await page.getByRole("button", { name: "详情与评论", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText("此处内容及修改历史公开可见。", { exact: false })
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const otherProject = (
      await api("/projects", "POST", { name: "深链切换验收" }, admin.cookie)
    ).data.id;
    await page.goto(
      origin +
        "/worklog/?project=" +
        project.id +
        "&module=resources&resourceTab=credentials&credential=stale-fixture",
    );
    await page
      .getByRole("navigation", { name: "项目", exact: true })
      .getByRole("button", { name: "深链切换验收", exact: true })
      .click();
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get("project") === id,
      otherProject,
    );
    assert.equal(new URL(page.url()).searchParams.has("credential"), false);
    assert.equal(new URL(page.url()).searchParams.has("configuration"), false);
    await page.goto(origin + "/worklog/?project=" + project.id);
    await page.getByLabel("操作：统计月份验收", { exact: true }).click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    const adminUser = (await api("/state", "GET", undefined, admin.cookie)).data
      .user;
    await api(
      "/admin/members/" + adminUser.id + "/reset-password",
      "POST",
      { password: "Temporary-after-reset-123" },
      admin.cookie,
    );
    const signedOut = page.waitForResponse((r) =>
      r.url().endsWith("/api/state"),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await signedOut;
    await page
      .getByRole("dialog", { name: "编辑记录" })
      .waitFor({ state: "hidden" });
    // Anonymous-to-member login must still continue to the requested form.
    await page.getByRole("button", { name: "记录完成", exact: true }).click();
    const auth = page.getByRole("dialog", { name: "欢迎来到项目工作台" });
    await auth.locator('input[name="login"]').fill("admin");
    await auth
      .locator('input[name="password"]')
      .fill("Temporary-after-reset-123");
    await auth
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.getByRole("dialog", { name: "记录完成", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "Statistics change notices: cross-month save, first-child notice, public content warning, project links, session cleanup and mobile layout passed.",
    );
  } finally {
    await browser?.close();
    if (app) {
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
