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
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-project-overview-ui-"),
  );
  const origin = "http://127.0.0.1:8806";
  let app, browser;
  try {
    app = await createApp({
      dataDir: dir,
      origin,
      adminPassword: "Temporary-overview-fixture-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8806, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const response = await fetch(origin + "/worklog/api" + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return {
        data,
        cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
      };
    }
    const admin = await api("/login", "POST", {
      login: "admin",
      password: "Temporary-overview-fixture-123",
    });
    const a = (
      await api("/projects", "POST", { name: "总览验收A" }, admin.cookie)
    ).data.id;
    const b = (
      await api("/projects", "POST", { name: "总览验收B" }, admin.cookie)
    ).data.id;
    await api(
      "/projects/" + b,
      "PATCH",
      { version: 1, name: "总览验收B", archived: true },
      admin.cookie,
    );
    const parent = (
      await api(
        "/records",
        "POST",
        {
          project_id: a,
          task: "整体任务",
          owner: "测试负责人",
          actual: "测试负责人",
        },
        admin.cookie,
      )
    ).data.id;
    await api(
      "/records",
      "POST",
      {
        project_id: a,
        parent_id: parent,
        task: "待完成子项",
        owner: "测试负责人",
        due_date: "2000-01-01",
      },
      admin.cookie,
    );
    await api(
      "/records",
      "POST",
      { project_id: a, task: "等待联调", owner: "测试负责人", blocked: true },
      admin.cookie,
    );
    const publicData = (await api("/project-overview")).data;
    assert.equal(
      Object.hasOwn(
        publicData.projects.find((p) => p.id === a),
        "changes",
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        publicData.projects.find((p) => p.id === a),
        "handover_missing",
      ),
      false,
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const guest = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await guest.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?view=projects");
    await page.getByRole("heading", { name: "项目进展，一处看清" }).waitFor();
    await page.getByRole("article", { name: "项目总览：总览验收A" }).waitFor();
    assert.equal(
      await page.getByRole("article", { name: "项目总览：总览验收B" }).count(),
      0,
    );
    await page
      .getByText("登录后可查看交接缺项和需求变更", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "编辑 总览验收A 的管理资料", exact: true })
        .count(),
      0,
    );
    await page.getByLabel("项目归档筛选", { exact: true }).selectOption("all");
    await page.getByRole("article", { name: "项目总览：总览验收B" }).waitFor();
    await guest.close();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies([
      {
        name: "worklog_session",
        value: admin.cookie.split("=").slice(1).join("="),
        domain: "127.0.0.1",
        path: "/worklog",
      },
    ]);
    const member = await context.newPage();
    member.on("pageerror", (e) => errors.push(e.message));
    await member.goto(origin + "/worklog/?view=projects");
    let projectCard = member.getByRole("article", {
      name: "项目总览：总览验收A",
    });
    await projectCard
      .getByRole("button", { name: "编辑 总览验收A 的管理资料", exact: true })
      .click();
    let dialog = member.getByRole("dialog", { name: "项目管理资料" });
    await dialog
      .getByLabel("项目负责人（选填）", { exact: true })
      .fill("原草稿负责人");
    await dialog.getByLabel("当前阶段（选填）", { exact: true }).fill("实施");
    await api(
      "/projects/" + a + "/management",
      "PATCH",
      {
        version: 0,
        owner: "他人已更新",
        stage: "联调",
        target_date: "2026-11-01",
      },
      admin.cookie,
    );
    const synced = member.waitForResponse((r) =>
      r.url().endsWith("/api/project-overview"),
    );
    await member.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await synced;
    assert.equal(
      await dialog
        .getByLabel("项目负责人（选填）", { exact: true })
        .inputValue(),
      "原草稿负责人",
    );
    const conflict = member.waitForResponse(
      (r) =>
        r.url().endsWith("/management") && r.request().method() === "PATCH",
    );
    await dialog
      .getByRole("button", { name: "保存项目资料", exact: true })
      .click();
    assert.equal((await conflict).status(), 409);
    await dialog
      .getByRole("button", {
        name: "载入最新资料（将替换当前草稿）",
        exact: true,
      })
      .click();
    await member.waitForFunction(() =>
      Array.from(document.querySelectorAll("dialog input")).some(
        (e) => e.value === "他人已更新",
      ),
    );
    await dialog
      .getByLabel("项目负责人（选填）", { exact: true })
      .fill("最终负责人");
    await dialog.getByLabel("当前阶段（选填）", { exact: true }).fill("试运行");
    let releasePatch, patchStarted;
    const patchGate = new Promise((resolve) => {
      releasePatch = resolve;
    });
    const started = new Promise((resolve) => {
      patchStarted = resolve;
    });
    await member.route("**/management", async (route) => {
      if (route.request().method() === "PATCH") {
        patchStarted();
        await patchGate;
      }
      await route.continue();
    });
    await dialog
      .getByRole("button", { name: "保存项目资料", exact: true })
      .click();
    await started;
    try {
      await member.keyboard.press("Escape");
      assert.equal(
        await dialog.evaluate((e) => e.open),
        true,
        "Escape must not close an in-flight save",
      );
      const cancelSave = dialog.getByRole("button", {
        name: "取消",
        exact: true,
      });
      if (await cancelSave.isEnabled()) await cancelSave.click();
      assert.equal(
        await dialog.evaluate((e) => e.open),
        true,
        "cancel must not discard an in-flight save",
      );
    } finally {
      releasePatch();
    }
    await dialog.waitFor({ state: "hidden" });
    await member.unroute("**/management");
    await projectCard
      .getByText("负责人：最终负责人", { exact: false })
      .waitFor();
    await member
      .getByLabel("项目负责人筛选", { exact: true })
      .selectOption("最终负责人");
    assert.equal(await member.getByRole("article").count(), 1);
    await member
      .getByLabel("项目阶段筛选", { exact: true })
      .selectOption("试运行");
    assert.equal(await member.getByRole("article").count(), 1);
    await member
      .getByLabel("搜索项目总览", { exact: true })
      .fill("不存在的项目");
    await member.getByText("当前筛选下没有项目", { exact: false }).waitFor();
    await member.getByRole("button", { name: "查看全部", exact: true }).click();
    await member.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await member.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
      "overview mobile overflow",
    );
    await member
      .getByRole("button", { name: "编辑 总览验收A 的管理资料", exact: true })
      .click();
    dialog = member.getByRole("dialog", { name: "项目管理资料" });
    assert.ok(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
      "profile dialog mobile overflow",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await member
      .getByRole("article", { name: "项目总览：总览验收A" })
      .getByRole("button", { name: "待完成子项", exact: false })
      .click();
    await member
      .getByRole("dialog")
      .getByRole("heading", { name: "待完成子项", exact: true })
      .waitFor();
    await member
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await member
      .getByRole("button", { name: "跨项目总览", exact: true })
      .click();
    await member
      .getByRole("button", { name: "编辑 总览验收A 的管理资料", exact: true })
      .click();
    const expiredDraft = member.getByRole("dialog", { name: "项目管理资料" });
    await expiredDraft
      .getByLabel("项目负责人（选填）", { exact: true })
      .fill("会话失效草稿");
    const capturedState = (await api("/state", "GET", undefined, admin.cookie))
      .data;
    await member.route("**/api/state", (route) =>
      route.fulfill({ json: capturedState }),
    );
    await context.clearCookies();
    const publicRefresh = member.waitForResponse((r) =>
      r.url().endsWith("/api/project-overview"),
    );
    await member.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    const publicResult = await publicRefresh;
    assert.equal((await publicResult.json()).can_view_internal, false);
    await expiredDraft.waitFor({ state: "hidden" });
    await member
      .getByText("登录后可查看交接缺项和需求变更", { exact: false })
      .waitFor();
    assert.equal(
      await member
        .getByRole("button", { name: "编辑 总览验收A 的管理资料", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await member
        .getByRole("button", { name: "交接缺", exact: false })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Project overview browser passed: public/private summaries, archive/owner/stage/search filters, guarded metadata editing after sync conflicts, task navigation, stale-user session expiry and mobile layouts.",
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
