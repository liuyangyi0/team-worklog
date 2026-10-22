const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
(async () => {
  const { createApp } = await import(
    pathToFileURL(path.resolve(__dirname, "../server.mjs")).href
  );
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-milestones-ui-"),
  );
  const origin = "http://127.0.0.1:8807";
  let app, browser;
  try {
    app = await createApp({
      dataDir: dir,
      origin,
      adminPassword: "Temporary-milestone-fixture-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8807, "127.0.0.1", r));
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
      password: "Temporary-milestone-fixture-123",
    });
    const project = (await api("/state")).data.projects[0];
    const taskId = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "里程碑关联任务",
          owner: "成员甲",
          actual: "",
          date: "",
        },
        admin.cookie,
      )
    ).data.id;
    const text = Buffer.from("Milestone fixture file");
    const upload = (
      await api(
        "/uploads",
        "POST",
        {
          project_id: project.id,
          filename: "里程碑内部说明.txt",
          size: text.length,
        },
        admin.cookie,
      )
    ).data;
    const chunk = await fetch(
      origin + "/worklog/api/uploads/" + upload.id + "/chunks/0",
      {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: admin.cookie,
        },
        body: text,
      },
    );
    assert.equal(chunk.status, 200);
    const file = (
      await api("/uploads/" + upload.id + "/complete", "POST", {}, admin.cookie)
    ).data;
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
        domain: "127.0.0.1",
        path: "/worklog",
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      origin + "/worklog/?module=milestones&project=" + project.id,
    );
    await page.getByRole("button", { name: "添加里程碑", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "添加里程碑", exact: true });
    await dialog
      .getByLabel("里程碑名称", { exact: true })
      .fill("里程碑浏览器验收");
    await dialog.getByLabel("节点负责人", { exact: true }).fill("成员甲");
    await dialog.getByLabel("计划达成日期", { exact: true }).fill("2000-01-01");
    await dialog
      .getByRole("checkbox", { name: "里程碑关联任务 · 成员甲", exact: true })
      .check();
    await dialog
      .getByRole("checkbox", { name: file.document.title, exact: true })
      .check();
    await dialog
      .getByLabel(file.document.title + "关联版本", { exact: true })
      .selectOption(file.version_id);
    await dialog
      .getByRole("button", { name: "创建里程碑", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    let item = (
      await api(
        "/projects/" + project.id + "/milestones",
        "GET",
        undefined,
        admin.cookie,
      )
    ).data.milestones[0];
    assert.equal(item.status, "planned");
    assert.equal(item.documents[0].version_id, file.version_id);
    assert.equal(
      (await api("/state")).data.records.find((t) => t.id === taskId).actual,
      "",
    );
    await page
      .getByRole("button", { name: "里程碑浏览器验收", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "里程碑 · 里程碑浏览器验收",
      exact: true,
    });
    const fixed = dialog.getByRole("link", {
      name: "下载固定版本 V1",
      exact: true,
    });
    await fixed.waitFor();
    assert.ok(
      (await fixed.getAttribute("href")).includes(
        "/versions/" + file.version_id + "/download",
      ),
    );
    await dialog
      .getByRole("button", { name: "编辑里程碑", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑里程碑", exact: true });
    await dialog
      .getByLabel("里程碑状态", { exact: true })
      .selectOption("achieved");
    assert.equal(
      await dialog
        .getByLabel("实际达成日期（可选）", { exact: true })
        .inputValue(),
      "",
    );
    await dialog
      .getByRole("button", { name: "保存里程碑", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    item = (
      await api(
        "/projects/" + project.id + "/milestones",
        "GET",
        undefined,
        admin.cookie,
      )
    ).data.milestones[0];
    assert.equal(item.status, "achieved");
    assert.equal(item.actual_date, "");
    assert.equal(
      (await api("/state")).data.records.find((t) => t.id === taskId).actual,
      "",
    );
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "编辑里程碑", exact: true });
    await dialog
      .getByLabel("里程碑名称", { exact: true })
      .fill("尚未保存的节点草稿");
    const remote = (
      await api(
        "/milestones/" + item.id,
        "PATCH",
        { version: item.version, title: "同事更新后的里程碑" },
        admin.cookie,
      )
    ).data.milestone;
    await dialog
      .getByRole("button", { name: "保存里程碑", exact: true })
      .click();
    await dialog.getByText("里程碑刚被他人修改", { exact: false }).waitFor();
    assert.equal(
      await dialog.getByLabel("里程碑名称", { exact: true }).inputValue(),
      "尚未保存的节点草稿",
    );
    await dialog
      .getByRole("button", { name: "载入最新内容", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("dialog[open] input")?.value ===
        "同事更新后的里程碑",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    dialog = page.getByRole("dialog", { name: "编辑里程碑", exact: true });
    assert.ok(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
      "mobile editor overflow",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await api(
      "/milestones/" + item.id,
      "DELETE",
      { version: remote.version },
      admin.cookie,
    );
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await page.getByRole("button", { name: "返回里程碑", exact: true }).click();
    await page
      .getByRole("button", { name: "同事更新后的里程碑", exact: true })
      .waitFor();
    // A slow initial deep link cannot override a form the user opens afterwards.
    let releaseDeep, startedDeep;
    const deepStarted = new Promise((r) => {
      startedDeep = r;
    });
    await page.route("**/api/milestones/" + item.id, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      startedDeep();
      await new Promise((r) => {
        releaseDeep = r;
      });
      await route.continue();
    });
    await page.goto(
      origin +
        "/worklog/?module=milestones&project=" +
        project.id +
        "&milestone=" +
        item.id,
    );
    await deepStarted;
    await page.getByRole("button", { name: "添加里程碑", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "添加里程碑", exact: true });
    await dialog
      .getByLabel("里程碑名称", { exact: true })
      .fill("保留后打开的草稿");
    const deepResponse = page.waitForResponse((r) => r.url().endsWith("/api/milestones/" + item.id));
    releaseDeep();
    await deepResponse;
    await page.waitForTimeout(100);
    assert.equal(
      await dialog.getByLabel("里程碑名称", { exact: true }).inputValue(),
      "保留后打开的草稿",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.unroute("**/api/milestones/" + item.id);
    // Explicit 401 from an editor's internal options closes its private draft immediately.
    await page.route(
      "**/api/projects/" + project.id + "/milestone-options",
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture session expired" }),
        }),
    );
    const expiredOptions = page.waitForResponse((r) => r.url().endsWith("/milestone-options") && r.status() === 401);
    await page.getByRole("button", { name: "添加里程碑", exact: true }).click();
    await expiredOptions;
    await page
      .getByRole("dialog", { name: "添加里程碑", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "添加里程碑", exact: true }).click();
    const expiredAuth = page.getByRole("dialog", {
      name: "欢迎来到项目工作台",
    });
    await expiredAuth.waitFor();
    await expiredAuth
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.unroute("**/api/projects/" + project.id + "/milestone-options");
    await page.goto(
      origin + "/worklog/?module=milestones&project=" + project.id,
    );

    // A public list arriving before /state notices session expiry must not crash or expose documents.
    const guestData = (await api("/projects/" + project.id + "/milestones"))
      .data;
    assert.equal(guestData.can_view_internal, false);
    assert.ok(!JSON.stringify(guestData).includes(file.document.title));
    await page.route("**/api/projects/" + project.id + "/milestones", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(guestData),
      }),
    );
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page
      .getByRole("button", { name: "同事更新后的里程碑", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "里程碑 · 同事更新后的里程碑",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "登录后查看关联资料", exact: true })
      .waitFor();
    assert.ok(!(await dialog.innerText()).includes(file.document.title));
    assert.deepEqual(errors, []);
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await guest.goto(
      origin + "/worklog/?module=milestones&project=" + project.id,
    );
    await guest
      .getByRole("button", { name: "添加里程碑", exact: true })
      .click();
    await guest.getByRole("dialog", { name: "欢迎来到项目工作台" }).waitFor();
    console.log(
      "Milestone browser passed: manual achievement, unchanged task completion, private fixed document link, conflict recovery, recycle, mobile layout, slow deep-link drafts and expired-session public responses.",
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
