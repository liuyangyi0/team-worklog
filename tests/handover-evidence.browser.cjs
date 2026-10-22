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
    path.join(os.tmpdir(), "worklog-evidence-browser-"),
  );
  const origin = "http://127.0.0.1:17981",
    base = origin + "/worklog/api";
  let app, browser;
  try {
    app = await createApp({
      allowUninvitedRegistration: true,
      dataDir: dir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((resolve) =>
      app.server.listen(17981, "127.0.0.1", resolve),
    );
    async function api(route, method = "GET", body, cookie = "") {
      const response = await fetch(base + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return {
        data,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const member = await api("/register", "POST", {
      name: "胡示例三",
      login: "evidence_alice",
      password: "Temporary-fixture-123",
    });
    const cookie = member.cookie,
      project = (await api("/state")).data.projects[0].id;
    const item = (
      await api(
        "/projects/" + project + "/deliverables",
        "POST",
        { title: "关键验收单", evidence_kind: "published", required: true },
        cookie,
      )
    ).data.item;
    await api(
      "/projects/" + project + "/notes",
      "POST",
      { kind: "verbal", body: "下周补签", deliverable_id: item.id },
      cookie,
    );
    const credential = (
      await api(
        "/projects/" + project + "/credentials",
        "POST",
        {
          title: "现场维护账号",
          username: "fixture",
          secret: "SYNTHETIC-BROWSER-SECRET",
        },
        cookie,
      )
    ).data.credential;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const [name, value] = cookie.split(/=(.*)/);
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?module=documents&project=" + project);
    const checklist = page.getByRole("region", { name: "交接资料清单" });
    const row = (title) =>
      checklist
        .getByRole("row")
        .filter({ has: page.getByText(title, { exact: true }) });
    await row("关键验收单")
      .getByText("待提供正式版", { exact: true })
      .waitFor();
    await checklist.getByText("符合证据要求 0/1", { exact: false }).waitFor();
    assert.ok(
      (await checklist.locator(".checklist-progress").innerText()).includes(
        "1/1",
      ),
      "collection progress remains separate",
    );
    await checklist.getByText("交接检查", { exact: false }).first().click();
    await checklist
      .getByRole("link", { name: "现场维护账号", exact: true })
      .waitFor();
    await checklist
      .getByRole("button", { name: "添加资料项", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "添加交接资料项" });
    await dialog.getByLabel("应交资料名称", { exact: true }).fill("账号交接项");
    await dialog
      .getByLabel("证据要求", { exact: true })
      .selectOption("credential");
    await dialog
      .getByLabel("关联加密账号", { exact: true })
      .selectOption(credential.id);
    await dialog.getByLabel("必需资料", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "保存资料项", exact: true })
      .click();
    await row("账号交接项").getByText("已关联", { exact: true }).waitFor();
    await checklist.getByText("符合证据要求 1/2", { exact: false }).waitFor();
    assert.ok(
      !(await page.locator("body").innerText()).includes(
        "SYNTHETIC-BROWSER-SECRET",
      ),
    );
    await checklist
      .getByRole("button", { name: "编辑资料项：关键验收单", exact: true })
      .click();
    const edit = page.getByRole("dialog", { name: "修改交接资料项" });
    assert.equal(
      await edit.getByLabel("证据要求", { exact: true }).inputValue(),
      "published",
    );
    await edit.getByLabel("证据要求", { exact: true }).selectOption("record");
    await edit.getByRole("button", { name: "保存资料项", exact: true }).click();
    await row("关键验收单").getByText("已有记录", { exact: true }).waitFor();
    await checklist.getByText("符合证据要求 2/2", { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Handover evidence browser passed: typed requirements, note versus formal evidence, account metadata link, independent collection/evidence progress, gaps and mobile layout.",
    );
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
