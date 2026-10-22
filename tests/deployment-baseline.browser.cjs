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
    path.join(os.tmpdir(), "worklog-delivery-browser-"),
  );
  const artifacts =
    process.env.WORKLOG_ARTIFACTS_DIR ||
    path.join(os.tmpdir(), "worklog-delivery-proof");
  await fs.mkdir(artifacts, { recursive: true });
  const origin = "http://127.0.0.1:8805";
  let app, browser, page;
  try {
    app = await createApp({
      allowUninvitedRegistration: true,
      dataDir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8805, "127.0.0.1", r));
    let cookie = "";
    async function api(route, method = "GET", body) {
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
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return data;
    }
    await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "delivery_fixture",
      password: "Synthetic-fixture-123",
    });
    const project = (await api("/state")).projects[0];
    const config = (
      await api(`/projects/${project.id}/configurations`, "POST", {
        name: "现场配置",
        content: "password=synthetic-private-marker",
      })
    ).configuration;
    const upload = await api("/uploads", "POST", {
      project_id: project.id,
      filename: "安装说明.txt",
      size: 5,
    });
    const chunk = await fetch(
      `${origin}/worklog/api/uploads/${upload.id}/chunks/0`,
      {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        body: Buffer.from("hello"),
      },
    );
    assert.equal(chunk.status, 200);
    const doc = await api(`/uploads/${upload.id}/complete`, "POST", {});
    const release = await api(`/projects/${project.id}/releases`, "POST", {
      name: "首次交付包",
      items: [{ document_id: doc.document_id, version_id: doc.version_id }],
    });
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
    page = await context.newPage();
    const errors = [],
      reveals = [];
    page.on("dialog", (d) => d.accept());
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/\/reveal(?:\?|$)/.test(r.url())) reveals.push(r.url());
    });
    await page.goto(
      `${origin}/worklog/?module=resources&project=${project.id}&resourceTab=deployments`,
    );
    await page.getByRole("button", { name: "添加部署", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("部署名称", { exact: true }).fill("A现场交付");
    await dialog.getByLabel("部署版本", { exact: true }).fill("2.0");
    await dialog
      .getByLabel("固定文件交付归档", { exact: true })
      .selectOption(release.id);
    await dialog
      .getByLabel("现场配置交付版本", { exact: true })
      .selectOption(config.latest_version_id);
    assert.ok(!(await dialog.innerText()).includes("synthetic-private-marker"));
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "A现场交付", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "查看 / 修改", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("第 1 次记录", { exact: false }).waitFor();
    assert.equal(
      await dialog.getByLabel("固定文件交付归档", { exact: true }).inputValue(),
      release.id,
    );
    await dialog.getByLabel("部署版本", { exact: true }).fill("2.1");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "查看 / 修改", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("第 2 次记录", { exact: false }).waitFor();
    assert.ok((await dialog.innerText()).includes("2.0"));
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByText("交付基线历史", { exact: true })
      .scrollIntoViewIfNeeded();
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: path.join(artifacts, "固定交付版本与历史_手机.png"),
      fullPage: true,
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "记录新交付", exact: true }).click();
    dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel("部署名称", { exact: true }).inputValue(),
      "A现场交付 · 新交付",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await api(`/projects/${project.id}/deployments`)).deployments.length,
      2,
    );
    await page.goto(
      `${origin}/worklog/?module=resources&project=${project.id}&resourceTab=configurations&configuration=${config.id}`,
    );
    dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("heading", { name: /现场配置/ }).waitFor();
    await api(`/releases/${release.id}/void`, "POST", {
      reason: "虚构测试作废",
    });
    await api(`/configurations/${config.id}`, "DELETE", {
      version: config.version,
    });
    await page.goto(
      `${origin}/worklog/?module=resources&project=${project.id}&resourceTab=deployments`,
    );
    await page
      .getByRole("button", { name: "记录新交付", exact: true })
      .first()
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByText("原交付中已作废的归档、已移除的配置不会复制到新交付", {
        exact: false,
      })
      .waitFor();
    assert.equal(
      await dialog.getByLabel("固定文件交付归档", { exact: true }).inputValue(),
      "",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      (await api(`/projects/${project.id}/deployments`)).deployments.length,
      3,
    );
    const originalCard = page
      .getByRole("heading", { name: "A现场交付", exact: true })
      .locator("xpath=../../..");
    await originalCard
      .getByRole("button", { name: "查看 / 修改", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "部署回收站", exact: true }).click();
    await page
      .getByRole("button", { name: "查看交付历史", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("第 1 次记录", { exact: false }).waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: "保存", exact: true }).count(),
      0,
    );
    await dialog
      .getByText("归档：首次交付包", { exact: false })
      .first()
      .waitFor();
    assert.deepEqual(reveals, []);
    assert.deepEqual(errors, []);
    console.log(
      "PASS fixed deployment archives/config versions, immutable history, new delivery, mobile layout and safe handover deep links",
    );
  } catch (e) {
    if (page)
      await page
        .screenshot({
          path: path.join(artifacts, "delivery-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
    throw e;
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
