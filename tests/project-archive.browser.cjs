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
      path.join(os.tmpdir(), "worklog-archive-ui-"),
    ),
    origin = "http://127.0.0.1:8812",
    base = origin + "/worklog/api";
  const artifacts =
    process.env.WORKLOG_ARTIFACTS_DIR ||
    path.join(os.tmpdir(), "worklog-archive-proof");
  await fs.mkdir(artifacts, { recursive: true });
  let app, browser;
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Archive-fixture-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8812, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const r = await fetch(base + route, {
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
    const login = await api("/login", "POST", {
        login: "admin",
        password: "Archive-fixture-123",
      }),
      cookie = login.cookie;
    const p1 = (await api("/state")).data.projects[0],
      p2 = {
        id: (await api("/projects", "POST", { name: "档案项目乙" }, cookie))
          .data.id,
        name: "档案项目乙",
      };
    const note = (
      await api(
        "/projects/" + p1.id + "/notes",
        "POST",
        {
          kind: "verbal",
          body: "档案唯一标记：客户张工确认按月汇总",
          people: "客户张工",
          occurred_on: "2026-02-03",
        },
        cookie,
      )
    ).data.note;
    await api(
      "/projects/" + p2.id + "/notes",
      "POST",
      { kind: "site", body: "项目乙独立现场事实" },
      cookie,
    );
    for (let i = 0; i < 22; i++)
      await api(
        "/projects/" + p1.id + "/notes",
        "POST",
        {
          kind: "other",
          body: "分页事实 " + String(i).padStart(2, "0"),
          occurred_on: "2026-01-01",
        },
        cookie,
      );
    const milestone = (
      await api(
        "/projects/" + p1.id + "/milestones",
        "POST",
        {
          title: "档案验收里程碑",
          status: "achieved",
          actual_date: "2026-02-04",
        },
        cookie,
      )
    ).data.milestone;
    await api(
      "/projects/" + p1.id + "/changes",
      "POST",
      {
        title: "档案需求确认",
        requested_scope: "增加月度报表",
        requested_on: "2026-02-02",
        confirmation_status: "confirmed",
        confirmed_by: "客户张工",
        confirmed_on: "2026-02-03",
      },
      cookie,
    );
    async function upload(filename, extra = {}) {
      const bytes = Buffer.from(filename);
      const start = (
        await api(
          "/uploads",
          "POST",
          {
            project_id: p1.id,
            filename,
            title: "档案正式文件",
            size: bytes.length,
            ...extra,
          },
          cookie,
        )
      ).data;
      const chunk = await fetch(base + "/uploads/" + start.id + "/chunks/0", {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        body: bytes,
      });
      assert.ok(chunk.ok);
      return (
        await api("/uploads/" + start.id + "/complete", "POST", {}, cookie)
      ).data;
    }
    const v1 = await upload("档案历史名称.txt");
    const v2 = await upload("档案现行名称.txt", {
      document_id: v1.document_id,
      base_version_id: v1.version_id,
    });
    const current = (
      await api("/documents/" + v1.document_id, "GET", undefined, cookie)
    ).data.document;
    await api(
      "/documents/" + v1.document_id + "/publish",
      "POST",
      { version: current.version, version_id: v1.version_id },
      cookie,
    );
    const before = (await api("/state")).data.records;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function archiveAction(action, expected) {
      const pending = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/worklog/api/project-archive" &&
          response.request().method() === "GET" &&
          Object.entries(expected).every(
            ([key, value]) =>
              (url.searchParams.get(key) || "") === String(value),
          )
        );
      });
      await action();
      const response = await pending;
      assert.equal(response.status(), 200);
      const data = await response.json();
      await page.waitForFunction(
        ({ titles, total }) => {
          const section = document.querySelector(
            'section[aria-label="项目档案"]',
          );
          if (!section) return false;
          const shown = [...section.querySelectorAll("article h2")].map(
            (heading) => heading.textContent.trim(),
          );
          return (
            shown.length === titles.length &&
            shown.every((title, index) => title === titles[index]) &&
            section
              .querySelector('[aria-live="polite"]')
              ?.textContent.replace(/\s/g, "")
              .includes("共" + total + "项")
          );
        },
        {
          titles: data.items.map((item) => item.title.trim()),
          total: data.total,
        },
      );
      return data;
    }
    let privateCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/project-archive")) privateCalls++;
    });
    const ready = await fetch(origin + "/worklog/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200);
    assert.ok((await ready.text()).includes("/worklog/assets/"));
    await page.goto(origin + "/worklog/?view=archive", {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "登录后查看项目档案", exact: true })
      .waitFor();
    assert.equal(privateCalls, 0);
    await context.addCookies([
      {
        name: "worklog_session",
        value: cookie.split("=").slice(1).join("="),
        url: origin + "/worklog/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await archiveAction(
      () =>
        page.goto(origin + "/worklog/?view=archive", {
          waitUntil: "domcontentloaded",
        }),
      { mode: "search", project_id: "", q: "", page: 1 },
    );
    await page
      .getByRole("heading", { name: "统一查档", exact: true })
      .waitFor();
    await page.getByLabel("查档关键词", { exact: true }).fill("档案历史名称");
    await archiveAction(
      () => page.getByRole("button", { name: "查询档案", exact: true }).click(),
      { mode: "search", project_id: "", q: "档案历史名称", page: 1 },
    );
    await page.getByText("文件：档案历史名称.txt", { exact: true }).waitFor();
    assert.equal(await page.getByRole("article").count(), 1);
    const oldVersion = (
      await api(
        "/project-archive?mode=search&q=" + encodeURIComponent("档案历史名称"),
        "GET",
        undefined,
        cookie,
      )
    ).data.items[0];
    assert.equal(oldVersion.version_id, v1.version_id);
    await page
      .getByRole("button", { name: "打开原始内容：档案正式文件", exact: true })
      .click();
    await page.getByLabel("查档定位版本", { exact: true }).waitFor();
    assert.ok(
      (
        await page.getByLabel("查档定位版本", { exact: true }).innerText()
      ).includes("档案历史名称"),
    );
    assert.equal(
      new URL(page.url()).searchParams.get("version"),
      v1.version_id,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await archiveAction(
      () =>
        page.goto(origin + "/worklog/?module=archive&project=" + p1.id, {
          waitUntil: "domcontentloaded",
        }),
      { mode: "timeline", project_id: p1.id, q: "", page: 1 },
    );
    await page
      .getByRole("heading", { name: "项目大事记", exact: true })
      .waitFor();
    await archiveAction(
      () => page.getByRole("tab", { name: "统一查档", exact: true }).click(),
      { mode: "search", project_id: p1.id, q: "", page: 1 },
    );
    await page.getByLabel("查档关键词", { exact: true }).fill("档案唯一标记");
    await archiveAction(
      () => page.getByRole("button", { name: "查询档案", exact: true }).click(),
      { mode: "search", project_id: p1.id, q: "档案唯一标记", page: 1 },
    );
    await page.getByText("发生日：2026-02-03", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: /打开原始内容：档案唯一标记/ })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.ok(
      (await page.getByRole("dialog").innerText()).includes(
        "客户张工确认按月汇总",
      ),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await archiveAction(
      () =>
        page.goto(origin + "/worklog/?view=archive", {
          waitUntil: "domcontentloaded",
        }),
      { mode: "search", project_id: "", q: "", page: 1 },
    );
    await page.getByLabel("项目范围", { exact: true }).selectOption(p2.id);
    await archiveAction(
      () => page.getByRole("button", { name: "查询档案", exact: true }).click(),
      { mode: "search", project_id: p2.id, q: "", page: 1 },
    );
    await page
      .getByRole("heading", { name: "项目乙独立现场事实", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("article").count(), 1);
    await page.getByLabel("项目范围", { exact: true }).selectOption(p1.id);
    await archiveAction(
      () => page.getByRole("button", { name: "查询档案", exact: true }).click(),
      { mode: "search", project_id: p1.id, q: "", page: 1 },
    );
    await page.getByRole("button", { name: "下一页", exact: true }).waitFor();
    await archiveAction(
      () => page.getByRole("button", { name: "下一页", exact: true }).click(),
      { mode: "search", project_id: p1.id, q: "", page: 2 },
    );
    await page.getByText("第 2 / 2 页", { exact: true }).waitFor();
    // A late query must not replace the newer result.
    let releaseSlow;
    const delayed = new Promise((r) => (releaseSlow = r));
    let sawSlowResolve;
    const sawSlow = new Promise((r) => (sawSlowResolve = r));
    await page.route("**/api/project-archive?**", async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("q") === "慢请求") {
        sawSlowResolve();
        await delayed;
      }
      await route.continue();
    });
    await page.getByLabel("查档关键词", { exact: true }).fill("慢请求");
    await page.getByRole("button", { name: "查询档案", exact: true }).click();
    await sawSlow;
    await page.getByLabel("查档关键词", { exact: true }).fill("档案唯一标记");
    await archiveAction(
      () => page.getByRole("button", { name: "查询档案", exact: true }).click(),
      { mode: "search", project_id: p1.id, q: "档案唯一标记", page: 1 },
    );
    await page.getByRole("heading", { name: /档案唯一标记/ }).waitFor();
    const slowResponse = page.waitForResponse((r) =>
      r.url().includes("q=" + encodeURIComponent("慢请求")),
    );
    releaseSlow();
    await slowResponse;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.getByRole("heading", { name: /档案唯一标记/ }).count(),
      1,
    );
    await page.unroute("**/api/project-archive?**");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(artifacts, "archive-mobile.png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    );
    // Expire the module independently while parent user props remain stale.
    await page.getByLabel("查档关键词", { exact: true }).fill("PRIVATE-DRAFT");
    await page.route("**/api/project-archive?**", (route) =>
      route.fulfill({
        status: 401,
        json: { error: "Fixture session expired" },
      }),
    );
    await page.getByRole("button", { name: "查询档案", exact: true }).click();
    await page
      .getByRole("heading", { name: "登录后查看项目档案", exact: true })
      .waitFor();
    assert.ok(
      !(await page.locator("main").innerText()).includes("档案唯一标记"),
    );
    assert.equal(
      await page.getByLabel("查档关键词", { exact: true }).count(),
      0,
    );
    assert.deepEqual((await api("/state")).data.records, before);
    assert.equal(
      (await api("/documents/" + v1.document_id, "GET", undefined, cookie)).data
        .document.current_version_id,
      v2.version_id,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Project archive browser checks passed; artifacts: " + artifacts,
    );
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
