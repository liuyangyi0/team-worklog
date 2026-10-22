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
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-change-ui-"),
  );
  const origin = "http://127.0.0.1:8808",
    base = origin + "/worklog/api";
  const artifacts =
    process.env.WORKLOG_ARTIFACTS_DIR ||
    path.join(os.tmpdir(), "worklog-change-proof");
  await fs.mkdir(artifacts, { recursive: true });
  let app, browser, page;
  try {
    app = await createApp({
      allowUninvitedRegistration: true,
      dataDir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8808, "127.0.0.1", r));
    async function api(
      route,
      method = "GET",
      body,
      cookie = "",
      expected = 200,
    ) {
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
      assert.equal(r.status, expected, JSON.stringify(data));
      return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] || "" };
    }
    const alice = await api(
      "/register",
      "POST",
      {
        name: REGISTRATION_NAMES[0],
        login: "change_alice",
        password: "Synthetic-fixture-123",
      },
      "",
      201,
    );
    const bob = await api(
      "/register",
      "POST",
      {
        name: REGISTRATION_NAMES[1],
        login: "change_bob",
        password: "Synthetic-fixture-123",
      },
      "",
      201,
    );
    const project = (await api("/state")).data.projects[0];
    const task = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "按月报表联调",
          owner: REGISTRATION_NAMES[0],
          actual: "",
          date: "",
          due_date: "2026-11-02",
        },
        alice.cookie,
        201,
      )
    ).data.id;
    const milestone = (
      await api(
        `/projects/${project.id}/milestones`,
        "POST",
        {
          title: "报表联调完成",
          owner: REGISTRATION_NAMES[0],
          planned_date: "2026-11-03",
        },
        alice.cookie,
        201,
      )
    ).data.milestone;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      {
        name: "worklog_session",
        value: alice.cookie.split("=").slice(1).join("="),
        url: origin + "/worklog/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(`${origin}/worklog/?module=changes&project=${project.id}`);
    await page.getByRole("button", { name: "记录变更", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "记录需求变更" });
    await dialog.getByLabel("变更标题", { exact: true }).fill("增加月报功能");
    await dialog
      .getByLabel("原约定（选填）", { exact: true })
      .fill("原约定：按日统计");
    await dialog
      .getByLabel("本次调整", { exact: true })
      .fill("客户内部范围标记：增加按月统计");
    await dialog.getByLabel("提出人（选填）", { exact: true }).fill("客户代表");
    await dialog
      .getByLabel("执行状态", { exact: true })
      .selectOption("implemented");
    await dialog.getByLabel("工期影响天数（选填）", { exact: true }).fill("3");
    await dialog
      .getByLabel("关联里程碑（选填）", { exact: true })
      .selectOption(milestone.id);
    await dialog.locator("summary").filter({ hasText: "关联任务" }).click();
    await dialog
      .getByRole("checkbox", { name: "按月报表联调", exact: true })
      .check();
    await dialog.getByRole("button", { name: "保存变更", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "增加月报功能", exact: true })
      .waitFor();

    let row = (
      await api(
        `/projects/${project.id}/changes`,
        "GET",
        undefined,
        alice.cookie,
      )
    ).data.changes[0];
    assert.equal(row.confirmation_status, "pending");
    assert.equal(row.progress_status, "implemented");
    const unchanged = (await api("/state")).data.records.find(
      (r) => r.id === task,
    );
    assert.equal(unchanged.actual, "");
    assert.equal(unchanged.date, "");
    assert.equal(unchanged.due_date, "2026-11-02");
    await page.getByLabel("编辑变更：增加月报功能", { exact: true }).click();
    dialog = page.getByRole("dialog", { name: "编辑需求变更" });
    await dialog
      .getByLabel("本次调整", { exact: true })
      .fill("甲尚未保存的草稿");
    await api(
      `/changes/${row.id}`,
      "PATCH",
      {
        version: row.version,
        requested_scope: "乙已经保存的新范围",
        confirmation_status: "confirmed",
        confirmed_by: "客户代表",
      },
      bob.cookie,
    );
    const sync = page.waitForResponse((r) =>
      r.url().includes(`/api/projects/${project.id}/changes`),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await sync;
    assert.equal(
      await dialog.getByLabel("本次调整", { exact: true }).inputValue(),
      "甲尚未保存的草稿",
    );
    await dialog.getByRole("button", { name: "保存变更", exact: true }).click();
    await dialog
      .getByText("这条变更记录已被他人修改，请刷新后重试", { exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "载入最新内容", exact: true })
      .click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("textarea")].some(
        (e) => e.value === "乙已经保存的新范围",
      ),
    );
    await dialog
      .getByLabel("本次调整", { exact: true })
      .fill("确认后的月报范围");
    await dialog.getByRole("button", { name: "保存变更", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    let failDetailOnce = true;

    await page.route("**/api/changes/" + row.id, async (route) => {
      if (route.request().method() === "GET" && failDetailOnce) {
        failDetailOnce = false;
        return route.abort("failed");
      }
      return route.continue();
    });
    await page
      .getByRole("button", { name: "增加月报功能", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "变更详情与历史" });
    await dialog
      .getByRole("button", { name: "重新加载变更详情", exact: true })
      .click();
    await dialog.getByText("完整修改历史", { exact: true }).waitFor();

    await dialog.locator("summary").filter({ hasText: "第 2 版" }).click();
    const historyEntry = dialog
      .locator("details")
      .filter({ hasText: "第 2 版" });
    await historyEntry
      .getByText("客户内部范围标记：增加按月统计", { exact: true })
      .waitFor();
    await historyEntry
      .getByText("乙已经保存的新范围", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "mobile change history overflow",
    );
    await page.screenshot({
      path: path.join(artifacts, "需求变更历史_手机.png"),
      fullPage: true,
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByLabel("删除变更：增加月报功能", { exact: true }).click();
    await page.getByRole("button", { name: "变更回收站", exact: true }).click();
    await page
      .getByRole("button", { name: "增加月报功能", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await page
      .getByRole("button", { name: "返回变更列表", exact: true })
      .click();
    await page
      .getByRole("button", { name: "增加月报功能", exact: true })
      .waitFor();
    await page
      .getByLabel("变更确认状态筛选", { exact: true })
      .selectOption("pending");
    await page.getByText("没有符合条件的变更", { exact: true }).waitFor();
    await page
      .getByLabel("变更确认状态筛选", { exact: true })
      .selectOption("confirmed");
    await page
      .getByRole("button", { name: "增加月报功能", exact: true })
      .waitFor();

    const guest = await browser.newPage();
    await guest.goto(`${origin}/worklog/?module=changes&project=${project.id}`);
    await guest
      .getByRole("heading", { name: "登录后查看需求变更台账", exact: true })
      .waitFor();
    assert.ok(!(await guest.innerText("body")).includes("增加月报功能"));
    await api(`/changes/${row.id}`, "GET", undefined, "", 401);
    const publicData =
      JSON.stringify((await api("/state")).data) +
      JSON.stringify((await api("/logs")).data);
    assert.ok(!publicData.includes("客户内部范围标记"));
    assert.deepEqual(errors, []);
    console.log(
      "Change ledger browser passed: internal access, scope and impact, independent confirmation/execution, unchanged completion, concurrent editing recovery, immutable history, recycle, filters and mobile layout.",
    );
  } catch (e) {
    console.error("change-ui failed before cleanup:", e);
    await page
      ?.screenshot({
        path: path.join(artifacts, "change-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw e;
  } finally {
    await browser?.close();
    if (app) {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
