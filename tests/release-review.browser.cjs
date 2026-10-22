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
  const { REGISTRATION_NAMES } = await import(
    pathToFileURL(path.resolve(__dirname, "../registration.mjs")).href
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-release-ui-"));
  const origin = "http://127.0.0.1:8794",
    base = origin + "/worklog/api";
  let app, browser, releaseSave;
  try {
    app = await createApp({ allowUninvitedRegistration: true,
      dataDir: dir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8794, "127.0.0.1", r));
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
    const alice = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "release_alice",
      password: "Temporary-review-123",
    });
    const bob = await api("/register", "POST", {
      name: REGISTRATION_NAMES[1],
      login: "release_bob",
      password: "Temporary-review-123",
    });
    const project = (await api("/state")).data.projects[0];
    const task = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "批量冲突审查",
          owner: REGISTRATION_NAMES[0],
          priority: "low",
        },
        alice.cookie,
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
        value: alice.cookie.split("=").slice(1).join("="),
        url: origin,
      },
    ]);
    const page = await context.newPage(),
      errors = [],
      failures = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?project=" + project.id);
    await page.getByLabel("选择：批量冲突审查", { exact: true }).check();
    await page
      .getByRole("toolbar", { name: "批量操作" })
      .getByRole("button", { name: "批量修改", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "批量修改" });
    await dialog
      .getByLabel("批量优先级", { exact: true })
      .selectOption("urgent");
    const before = (await api("/state")).data.records.find(
      (r) => r.id === task,
    );
    await api(
      "/records/" + task,
      "PATCH",
      { ...before, task: "他人更新后的任务", priority: "high" },
      bob.cookie,
    );
    const synced = page.waitForResponse((r) => r.url().endsWith("/api/state"));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await synced;
    await page.waitForFunction(() =>
      document.body.textContent.includes("他人更新后的任务"),
    );
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/records/batch"),
    );
    await dialog
      .getByRole("button", { name: "应用到 1 项", exact: true })
      .click();
    const batchResult = await response;
    if (batchResult.status() !== 409)
      failures.push(
        "背景同步升级批量编辑版本并覆盖他人修改（应409，实际" +
          batchResult.status() +
          "）",
      );
    else {
      await dialog
        .getByText("部分记录刚被他人修改或删除", { exact: false })
        .waitFor();
      assert.equal(
        (await api("/state")).data.records.find((r) => r.id === task).priority,
        "high",
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    }
    // A background sync must not upgrade a destructive confirmation either.
    await page
      .getByRole("toolbar", { name: "批量操作" })
      .getByRole("button", { name: "批量删除", exact: true })
      .click();
    const latestTask = (await api("/state")).data.records.find(
      (r) => r.id === task,
    );
    await api(
      "/records/" + task,
      "PATCH",
      { ...latestTask, task: "删除前他人再次更新" },
      bob.cookie,
    );
    const syncedDelete = page.waitForResponse((r) =>
      r.url().endsWith("/api/state"),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await syncedDelete;
    await page.waitForFunction(() =>
      document.body.textContent.includes("删除前他人再次更新"),
    );
    const deleteReply = page.waitForResponse((r) =>
      r.url().endsWith("/api/records/batch"),
    );
    const deleteDialog = page.getByRole("dialog");
    await deleteDialog
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    const deleteResult = await deleteReply;
    if (deleteResult.status() !== 409)
      failures.push("后台同步绕过批量删除的版本确认");
    else {
      assert.ok((await api("/state")).data.records.some((r) => r.id === task));
      await deleteDialog
        .getByRole("button", { name: "再想想", exact: true })
        .click();
    }
    await page
      .getByRole("navigation", { name: "项目模块" })
      .getByRole("button", { name: "随手记", exact: true })
      .click();
    await page.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记" });
    await dialog.getByLabel("内容", { exact: true }).fill("保存前的内容");
    await dialog
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "现场说明.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fixture attachment"),
      });
    let began;
    const started = new Promise((r) => {
      began = r;
    });
    const gate = new Promise((r) => {
      releaseSave = r;
    });
    await page.route("**/api/projects/*/notes", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      began();
      await gate;
      await route.continue();
    });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await started;
    const content = dialog.getByLabel("内容", { exact: true });
    if (!(await content.isDisabled())) {
      await content.fill("保存过程中输入的新内容会丢失");
      failures.push(
        "随手记保存期间仍可输入，保存完成关闭弹窗后这些新输入会丢失",
      );
    }
    if (!(await dialog.getByLabel("添加附件", { exact: true }).isDisabled()))
      failures.push("保存中仍可加入新附件，未纳入本次提交却会随弹窗关闭而丢失");
    releaseSave();
    releaseSave = null;
    await page.getByText("随手记已保存", { exact: true }).waitFor();
    assert.equal(
      (
        await api(
          `/projects/${project.id}/notes`,
          "GET",
          undefined,
          alice.cookie,
        )
      ).data.notes[0].body,
      "保存前的内容",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    console.log(
      "Release review browser passed: batch edit baselines survive background sync, site-log saves freeze input and attachments.",
    );
  } finally {
    releaseSave?.();
    if (browser) await browser.close();
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
