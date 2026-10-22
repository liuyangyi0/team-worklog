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
    path.join(os.tmpdir(), "worklog-ui-review-"),
  );
  const origin = "http://127.0.0.1:8793";
  let app,
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
  try {
    app = await createApp({ allowUninvitedRegistration: true, dataDir, origin, dist: path.join(repo, "dist") });
    await new Promise((r) => app.server.listen(8793, "127.0.0.1", r));
    await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "review_ui",
      password: "Temporary-review-ui-123",
    });
    const projectId = (await api("/state")).projects[0].id;
    const credential = (
      await api("/projects/" + projectId + "/credentials", "POST", {
        title: "审查账号",
        username: "original",
        secret: "synthetic-review-secret",
      })
    ).credential;
    const configuration = (
      await api("/projects/" + projectId + "/configurations", "POST", {
        name: "审查配置",
        content: "test=true",
      })
    ).configuration;
    const categories = [];
    for (const suffix of ["甲", "乙"])
      categories.push(
        (
          await api("/projects/" + projectId + "/resource-categories", "POST", {
            name: "审查分类" + suffix,
            family: "other",
            base_type: "other",
            fields: [
              {
                key: "shared_key",
                label: "字段" + suffix,
                type: "text",
                required: true,
                options: [],
                archived: false,
              },
            ],
          })
        ).category,
      );
    let resource = (
      await api("/projects/" + projectId + "/resources", "POST", {
        name: "分类历史审查资源",
        category_id: categories[0].id,
        field_values: { shared_key: "甲已保存" },
      })
    ).resource;
    for (const [index, value] of [
      [1, "乙已保存"],
      [0, "甲已保存"],
    ])
      resource = (
        await api("/resources/" + resource.id, "PATCH", {
          version: resource.version,
          category_id: categories[index].id,
          field_values: { shared_key: value },
        })
      ).resource;
    // Simulate a pre-category-map database: a historic field survives only in the flat JSON.
    const legacy = (
      await api("/projects/" + projectId + "/resources", "POST", {
        name: "旧库历史字段审查",
        type: "application",
        field_values: { software_version: "旧软件版" },
      })
    ).resource;
    app.db
      .prepare(
        "UPDATE resources SET field_values_json=?, category_values_json='{}' WHERE id=?",
      )
      .run(
        JSON.stringify({ software_version: "旧软件版", rack: "旧库保留机柜" }),
        legacy.id,
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
    await context.addCookies([
      {
        name: "worklog_session",
        value: cookie.split("=").slice(1).join("="),
        url: origin + "/worklog/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(origin + "/worklog/?module=resources&project=" + projectId);
    await page.getByRole("button", { name: /旧库历史字段审查/ }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("历史资料", { exact: true })
      .getByText("旧库保留机柜", { exact: true })
      .waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: /分类历史审查资源/ }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑资源", exact: true }).click();
    await dialog.getByLabel("字段甲 *", { exact: true }).fill("甲未保存草稿");
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption(categories[1].id);
    assert.equal(
      await dialog.getByLabel("字段乙 *", { exact: true }).inputValue(),
      "乙已保存",
    );
    await dialog.getByLabel("字段乙 *", { exact: true }).fill("乙修改后保存");
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption(categories[0].id);
    assert.equal(
      await dialog.getByLabel("字段甲 *", { exact: true }).inputValue(),
      "甲未保存草稿",
    );
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption(categories[1].id);
    assert.equal(
      await dialog.getByLabel("字段乙 *", { exact: true }).inputValue(),
      "乙修改后保存",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const saved = (await api("/resources/" + resource.id)).resource;
    assert.equal(
      saved.category_values[categories[0].id].shared_key,
      "甲已保存",
    );
    assert.equal(
      saved.category_values[categories[1].id].shared_key,
      "乙修改后保存",
    );
    await page.getByRole("button", { name: /分类历史审查资源/ }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("历史分类 · 审查分类甲", { exact: true })
      .getByText("甲已保存", { exact: true })
      .waitFor();
    await dialog.getByText("乙修改后保存", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();

    // Gate the initial detail fetch, then edit and concurrently update the same record.
    // The late response must preserve user input and the original optimistic version.
    await page.getByRole("button", { name: "账号密码", exact: true }).click();
    let release;
    const ready = new Promise((r) => (release = r));
    await page.route("**/api/credentials/" + credential.id, async (route) => {
      if (route.request().method() === "GET") await ready;
      await route.continue();
    });
    await page.getByRole("button", { name: "审查账号", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑账号", exact: true }).click();
    await dialog.getByLabel("用户名", { exact: true }).fill("本地输入");
    await api("/credentials/" + credential.id, "PATCH", {
      version: credential.version,
      username: "其他成员更新",
    });
    const detailResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/credentials/" + credential.id) &&
        r.request().method() === "GET",
    );
    release();
    await detailResponse;
    await dialog.getByText("当前密码保持不变。", { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel("用户名", { exact: true }).inputValue(),
      "本地输入",
    );
    const conflict = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/credentials/" + credential.id) &&
        r.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await conflict).status(), 409);
    assert.equal(
      (await api("/credentials/" + credential.id)).credential.username,
      "其他成员更新",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.unroute("**/api/credentials/" + credential.id);

    await page.getByRole("button", { name: "配置管理", exact: true }).click();
    let releaseConfig;
    const configReady = new Promise((r) => (releaseConfig = r));
    await page.route(
      "**/api/configurations/" + configuration.id,
      async (route) => {
        if (route.request().method() === "GET") await configReady;
        await route.continue();
      },
    );
    await page.getByRole("button", { name: "审查配置", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑信息", exact: true }).click();
    await dialog.getByLabel("配置名称", { exact: true }).fill("本地配置名");
    await api("/configurations/" + configuration.id, "PATCH", {
      version: configuration.version,
      notes: "其他成员备注",
    });
    const configResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/configurations/" + configuration.id) &&
        r.request().method() === "GET",
    );
    releaseConfig();
    await configResponse;
    assert.equal(
      await dialog.getByLabel("配置名称", { exact: true }).inputValue(),
      "本地配置名",
    );
    const configConflict = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/configurations/" + configuration.id) &&
        r.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await configConflict).status(), 409);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑信息", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("配置名称", { exact: true }).inputValue(),
      "审查配置",
    );
    await dialog.getByLabel("配置名称", { exact: true }).fill("应被取消的名称");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑信息", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("配置名称", { exact: true }).inputValue(),
      "审查配置",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page.unroute("**/api/configurations/" + configuration.id);

    await api("/projects/" + projectId + "/deployments", "POST", {
      name: "长字段部署审查",
      maintainer: "a".repeat(100),
      deployed_version: "b".repeat(100),
      site: "示例单位",
    });
    await page.getByRole("button", { name: "部署信息", exact: true }).click();
    await page
      .getByRole("heading", { name: "长字段部署审查", exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS category-scoped drafts and history, delayed account/config editing, optimistic conflicts, canceled metadata and mobile long deployment fields",
    );
  } finally {
    if (browser) await browser.close();
    if (app) {
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
