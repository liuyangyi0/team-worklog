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
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-pm-routing-"),
  );
  const origin = "http://127.0.0.1:8810";
  let app, browser;
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Temporary-routing-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8810, "127.0.0.1", r));
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
      password: "Temporary-routing-123",
    });
    const p1 = (await api("/state")).data.projects[0];
    const p2 = {
      id: (await api("/projects", "POST", { name: "导航项目乙" }, admin.cookie))
        .data.id,
      name: "导航项目乙",
    };
    const taskId = (
      await api(
        "/records",
        "POST",
        {
          project_id: p1.id,
          task: "跨模块待办",
          owner: "Fixture owner",
          actual: "",
          date: "",
        },
        admin.cookie,
      )
    ).data.id;
    const milestone = (
      await api(
        "/projects/" + p1.id + "/milestones",
        "POST",
        { title: "跨模块节点", owner: "Fixture owner", task_ids: [taskId] },
        admin.cookie,
      )
    ).data.milestone;
    const change = (
      await api(
        "/projects/" + p1.id + "/changes",
        "POST",
        {
          title: "PRIVATE-CUSTOMER-CHANGE",
          requested_scope: "PRIVATE-SCOPE-MARKER",
          task_ids: [taskId],
          milestone_id: milestone.id,
        },
        admin.cookie,
      )
    ).data.change;
    const tasksBefore = (await api("/state")).data.records;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?view=projects");
    const card = page.getByRole("article", {
      name: "项目总览：" + p1.name,
      exact: true,
    });
    await card.getByRole("button", { name: /下一节点：跨模块节点/ }).click();
    let dialog = page.getByRole("dialog", {
      name: "里程碑 · 跨模块节点",
      exact: true,
    });
    await dialog.waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("milestone"),
      milestone.id,
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("navigation", { name: "项目模块", exact: true })
      .getByRole("button", { name: "需求变更", exact: true })
      .click();
    assert.equal(new URL(page.url()).searchParams.has("milestone"), false);
    await page
      .getByRole("heading", { name: "登录后查看需求变更台账", exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("PRIVATE-SCOPE-MARKER", { exact: true }).count(),
      0,
    );
    await page
      .locator("main")
      .getByRole("button", { name: "登录 / 注册", exact: true })
      .click();
    async function login() {
      const auth = page.getByRole("dialog", { name: "欢迎来到项目工作台" });
      await auth.locator('input[name="login"]').fill("admin");
      await auth
        .locator('input[name="password"]')
        .fill("Temporary-routing-123");
      await auth
        .getByRole("button", { name: "登录", exact: true })
        .last()
        .click();
      await auth.waitFor({ state: "hidden" });
    }
    await login();
    await page
      .getByRole("button", { name: "PRIVATE-CUSTOMER-CHANGE", exact: true })
      .waitFor();
    await page.goto(
      origin +
        "/worklog/?module=changes&project=" +
        p2.id +
        "&change=" +
        change.id,
    );
    dialog = page.getByRole("dialog", { name: "变更详情与历史", exact: true });
    await dialog.getByText(/不属于当前项目/).waitFor();
    assert.equal(
      await dialog.getByText("PRIVATE-SCOPE-MARKER", { exact: true }).count(),
      0,
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("navigation", { name: "项目", exact: true })
      .getByRole("button", { name: p1.name, exact: true })
      .click();
    assert.equal(new URL(page.url()).searchParams.has("change"), false);
    await page.getByRole("button", { name: "跨项目总览", exact: true }).click();
    await page
      .getByRole("article", { name: "项目总览：" + p1.name, exact: true })
      .getByRole("button", { name: /需求变更 1 项/ })
      .click();
    await page
      .getByRole("button", { name: "PRIVATE-CUSTOMER-CHANGE", exact: true })
      .waitFor();
    // A successful POST followed by a failed GET must close the creator and never repeat POST.
    let blockGet = false,
      postCount = 0;
    const listUrl = "**/api/projects/" + p1.id + "/changes";
    await page.route(listUrl, async (route) => {
      if (route.request().method() === "POST") {
        postCount++;
        const response = await route.fetch();
        blockGet = true;
        return route.fulfill({ response });
      }
      if (blockGet)
        return route.fulfill({
          status: 503,
          json: { error: "Fixture sync failure" },
        });
      return route.continue();
    });
    await page.getByRole("button", { name: "记录变更", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记录需求变更", exact: true });
    await dialog
      .getByLabel("变更标题", { exact: true })
      .fill("POST成功后同步失败");
    await dialog.getByLabel("本次调整", { exact: true }).fill("Fixture scope");
    await dialog.getByRole("button", { name: "保存变更", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(postCount, 1);
    assert.equal(
      (
        await api(
          "/projects/" + p1.id + "/changes",
          "GET",
          undefined,
          admin.cookie,
        )
      ).data.changes.filter((r) => r.title === "POST成功后同步失败").length,
      1,
    );
    blockGet = false;
    await page.unroute(listUrl);
    await page.getByLabel("刷新变更台账", { exact: true }).click();
    await page
      .getByRole("button", { name: "POST成功后同步失败", exact: true })
      .waitFor();
    // Force only the private module to observe an expired session; keep parent user props stale.
    await page
      .getByLabel("编辑变更：PRIVATE-CUSTOMER-CHANGE", { exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑需求变更", exact: true });
    await dialog
      .getByLabel("变更标题", { exact: true })
      .fill("未保存的旧身份草稿");
    const browserSession = (await context.cookies(origin + "/worklog/")).find(
      (c) => c.name === "worklog_session",
    );
    const cookie = browserSession.name + "=" + browserSession.value;
    const stale = (await api("/state", "GET", undefined, cookie)).data;
    await page.route("**/api/state", (route) =>
      route.fulfill({ status: 200, json: stale }),
    );
    await api("/logout", "POST", {}, cookie);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "登录后查看需求变更台账", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "PRIVATE-CUSTOMER-CHANGE", exact: true })
        .count(),
      0,
    );
    await page.unroute("**/api/state");
    await page
      .locator("main")
      .getByRole("button", { name: "登录 / 注册", exact: true })
      .click();
    await login();
    await page
      .getByRole("button", { name: "PRIVATE-CUSTOMER-CHANGE", exact: true })
      .waitFor();
    assert.deepEqual((await api("/state")).data.records, tasksBefore);
    assert.deepEqual(errors, []);
    console.log(
      "Project management integration browser passed: overview/deep links, project isolation, private login, successful-write recovery, expired-session draft clearing and same-account login recovery.",
    );
  } finally {
    await browser?.close();
    if (app) {
      await new Promise((r) => {
        app.server.close(r);
        app.server.closeAllConnections();
      });
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
