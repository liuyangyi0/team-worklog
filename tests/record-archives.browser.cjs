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
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-record-archives-browser-"),
  );
  const origin = "http://127.0.0.1:8811",
    base = origin + "/worklog/api";
  let app, browser, page;
  try {
    app = await createApp({
      allowUninvitedRegistration: true,
      dataDir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((resolve) =>
      app.server.listen(8811, "127.0.0.1", resolve),
    );
    async function api(route, method = "GET", data, cookie = "") {
      const response = await fetch(base + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const body = await response.json();
      assert.ok(response.ok, JSON.stringify(body));
      return {
        data: body,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const member = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "records_archive_ui",
      password: "Temporary-fixture-123",
    });
    const cookie = member.cookie,
      projects = (await api("/state")).data.projects,
      project = projects[0];
    async function upload(filename, content, metadata = {}) {
      const bytes = Buffer.from(content);
      const session = (
        await api(
          "/uploads",
          "POST",
          {
            project_id: project.id,
            filename,
            title: "现场说明",
            size: bytes.length,
            ...metadata,
          },
          cookie,
        )
      ).data;
      const chunk = await fetch(base + "/uploads/" + session.id + "/chunks/0", {
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
        await api("/uploads/" + session.id + "/complete", "POST", {}, cookie)
      ).data;
    }
    const one = await upload("现场说明-v1.txt", "SYNTHETIC VERSION ONE");
    let root = (
      await api(
        "/projects/" + project.id + "/notes",
        "POST",
        {
          kind: "site",
          body: "原事项：现场交换机设置确认",
          occurred_on: "2026-10-19",
        },
        cookie,
      )
    ).data.note;
    root = (
      await api(
        "/notes/" + root.id + "/files",
        "POST",
        { document_id: one.document_id, version_id: one.version_id },
        cookie,
      )
    ).data.note;
    const two = await upload("现场说明-v2.txt", "SYNTHETIC VERSION TWO", {
      document_id: one.document_id,
      base_version_id: one.version_id,
    });
    let legacy = (
      await api(
        "/projects/" + project.id + "/notes",
        "POST",
        { kind: "file", body: "历史未固定资料记录" },
        cookie,
      )
    ).data.note;
    legacy = (
      await api(
        "/notes/" + legacy.id + "/files",
        "POST",
        { document_id: one.document_id },
        cookie,
      )
    ).data.note;
    // This database belongs only to this generated fixture directory.
    app.db
      .prepare("UPDATE project_note_files SET version_id=NULL WHERE note_id=?")
      .run(legacy.id);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 950 },
      acceptDownloads: true,
    });
    context.setDefaultTimeout(12000);
    const [name, value] = cookie.split(/=(.*)/);
    await context.addCookies([{ name, value, url: origin }]);
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/worklog/?module=notes&project=" + project.id);
    const log = page.getByRole("region", { name: "随手记", exact: true });
    const row = (id) => log.locator('[data-note-id="' + id + '"]');
    console.log("records fixture and UI loaded");
    await row(root.id).getByText("当时 V1", { exact: true }).waitFor();
    const downloadEvent = page.waitForEvent("download");
    await row(root.id)
      .getByRole("button", { name: "现场说明-v1.txt", exact: true })
      .click();
    const download = await downloadEvent;
    assert.equal(
      await fs.readFile(await download.path(), "utf8"),
      "SYNTHETIC VERSION ONE",
    );
    await row(root.id)
      .getByRole("button", { name: "查看最新版：现场说明-v1.txt", exact: true })
      .waitFor();
    await row(legacy.id).getByText("未固定版本", { exact: true }).waitFor();
    assert.equal(
      await row(legacy.id)
        .getByRole("button", { name: "现场说明-v2.txt", exact: true })
        .count(),
      0,
      "legacy must not present current as an original attachment",
    );
    await row(legacy.id)
      .getByRole("button", {
        name: "选择附件版本：现场说明-v2.txt",
        exact: true,
      })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "选择附件版本",
      exact: true,
    });
    await dialog
      .getByLabel("文件版本", { exact: true })
      .selectOption(one.version_id);
    await dialog
      .getByRole("button", { name: "确认固定版本", exact: true })
      .click();
    await row(legacy.id).getByText("当时 V1", { exact: true }).waitFor();
    await row(legacy.id)
      .getByRole("button", {
        name: "选择附件版本：现场说明-v1.txt",
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog", { name: "选择附件版本", exact: true });
    await dialog
      .getByLabel("文件版本", { exact: true })
      .selectOption(two.version_id);
    legacy = (await api("/notes/" + legacy.id, "GET", undefined, cookie)).data
      .note;
    await api(
      "/notes/" + legacy.id + "/files/" + one.document_id,
      "PATCH",
      {
        version_id: two.version_id,
        link_version: legacy.files[0].link_version,
      },
      cookie,
    );
    await dialog
      .getByRole("button", { name: "确认固定版本", exact: true })
      .click();
    await dialog.getByText(/请关闭后重新打开/).waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await log.getByRole("button", { name: "刷新随手记", exact: true }).click();
    await row(legacy.id).getByText("当时 V2", { exact: true }).waitFor();
    // Attachment changes must not advance the editor's text CAS baseline.
    await row(legacy.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("STALE LOCAL TEXT MUST NOT WIN");
    let latestLegacy = (
      await api("/notes/" + legacy.id, "GET", undefined, cookie)
    ).data.note;
    await api(
      "/notes/" + legacy.id,
      "PATCH",
      { body: "OTHER EDITOR WON", version: latestLegacy.version },
      cookie,
    );
    await dialog.getByRole("button", { name: /^选择附件版本：/ }).click();
    const chooseVersion = page.getByRole("dialog", {
      name: "选择附件版本",
      exact: true,
    });
    await chooseVersion
      .getByLabel("文件版本", { exact: true })
      .selectOption(one.version_id);
    await chooseVersion
      .getByRole("button", { name: "确认固定版本", exact: true })
      .click();
    await chooseVersion.waitFor({ state: "detached" });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByText(/这条随手记已被修改/).waitFor();
    assert.equal(
      (await api("/notes/" + legacy.id, "GET", undefined, cookie)).data.note
        .body,
      "OTHER EDITOR WON",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    // The optional latest-version download resolves current at click time.
    await row(root.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await upload("现场说明-v3.txt", "SYNTHETIC VERSION THREE", {
      document_id: one.document_id,
      base_version_id: two.version_id,
    });
    const latestDownloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "查看最新版：现场说明-v1.txt", exact: true })
      .click();
    const latestDownload = await latestDownloadEvent;
    assert.equal(latestDownload.suggestedFilename(), "现场说明-v3.txt");
    assert.equal(
      await fs.readFile(await latestDownload.path(), "utf8"),
      "SYNTHETIC VERSION THREE",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    console.log("records fixed download and CAS passed");
    // Supplements keep independent date, text and author; no task or person is required.
    await row(root.id)
      .getByRole("button", { name: "补充一条", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "补充一条", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("补充：客户现场验证通过");
    await dialog.getByLabel("发生日期", { exact: true }).fill("2026-10-20");
    assert.equal(
      await dialog.getByLabel("关联任务（选填）", { exact: true }).inputValue(),
      "",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("补充：客户现场验证通过", { exact: true }).waitFor();
    let child = (
      await api("/projects/" + project.id + "/notes", "GET", undefined, cookie)
    ).data.notes.find((n) => n.body === "补充：客户现场验证通过");
    assert.equal(child.parent_note_id, root.id);
    assert.equal(child.occurred_on, "2026-10-20");
    assert.equal(child.task_id, null);
    await row(child.id)
      .getByRole("button", { name: /补充 · 查看原事项/ })
      .click();
    const thread = page.getByRole("dialog", { name: "事项详情", exact: true });
    await thread.getByText(root.body, { exact: true }).waitFor();
    await thread.getByText(child.body, { exact: true }).waitFor();
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    let releaseThread, markThreadDelivered;
    const heldThread = new Promise((resolve) => {
      releaseThread = resolve;
    });
    const threadDelivered = new Promise((resolve) => {
      markThreadDelivered = resolve;
    });
    await page.route(
      "**/api/notes/" + child.id + "/thread",
      async (route) => {
        const response = await route.fetch();
        await heldThread;
        await route.fulfill({ response });
        markThreadDelivered();
      },
      { times: 1 },
    );
    await row(child.id)
      .getByRole("button", { name: /补充 · 查看原事项/ })
      .click();
    await thread.getByText("正在加载事项…", { exact: true }).waitFor();
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await row(legacy.id)
      .getByRole("button", { name: /^查看事项/ })
      .click();
    await thread.getByText("OTHER EDITOR WON", { exact: true }).waitFor();
    releaseThread();
    await threadDelivered;
    assert.equal(
      await thread.getByText(child.body, { exact: true }).count(),
      0,
      "late details must not appear in a newly selected matter",
    );
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    page.once("dialog", (d) => d.accept());
    await row(root.id)
      .getByRole("button", { name: /^删除随手记：/ })
      .click();
    await row(root.id).waitFor({ state: "detached" });
    await row(child.id).waitFor();
    await row(child.id)
      .getByRole("button", { name: /补充 · 查看原事项/ })
      .click();
    await thread
      .getByText("原事项已删除，已有补充仍保留。", { exact: true })
      .waitFor();
    await thread
      .getByRole("button", { name: "补充一条", exact: true })
      .last()
      .click();
    dialog = page.getByRole("dialog", { name: "补充一条", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("删根之后仍可补充现场结论");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await thread
      .getByText("删根之后仍可补充现场结论", { exact: true })
      .waitFor();
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    console.log("records supplement continuity passed");
    // A delayed upload result must pin the returned version even if a newer one wins first.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("上传完成后新版本竞态验证");
    await dialog.getByLabel("添加附件", { exact: true }).setInputFiles({
      name: "竞态附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("UPLOADED ORIGINAL"),
    });
    let racedOriginal;
    await page.route(
      "**/api/uploads/*/complete",
      async (route) => {
        const response = await route.fetch();
        const result = await response.json();
        racedOriginal = result;
        await upload("竞态附件-new.txt", "NEWER THAN ORIGINAL", {
          document_id: result.document_id,
          base_version_id: result.version_id,
        });
        await route.fulfill({ response, json: result });
      },
      { times: 1 },
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("上传完成后新版本竞态验证", { exact: true }).waitFor();
    const raced = (
      await api("/projects/" + project.id + "/notes", "GET", undefined, cookie)
    ).data.notes.find((n) => n.body === "上传完成后新版本竞态验证");
    assert.equal(raced.files[0].version_id, racedOriginal.version_id);
    assert.notEqual(
      raced.files[0].version_id,
      raced.files[0].current_version_id,
    );
    // A failed attachment retry reuses its already uploaded file instead of uploading twice.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("失败附件可重试且不重复上传");
    await dialog.getByLabel("添加附件", { exact: true }).setInputFiles({
      name: "重试附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("RETRY ONCE"),
    });
    let completedUploads = 0;
    const countUploads = (request) => {
      if (
        /\/api\/uploads\/[^/]+\/complete$/.test(request.url()) &&
        request.method() === "POST"
      )
        completedUploads++;
    };
    page.on("request", countUploads);
    await page.route(
      "**/api/notes/*/files",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture attach unavailable" }),
        }),
      { times: 1 },
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await dialog.getByText(/以下附件未关联成功/).waitFor();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    page.off("request", countUploads);
    assert.equal(completedUploads, 1);
    assert.equal(
      (
        await api(
          "/projects/" + project.id + "/notes",
          "GET",
          undefined,
          cookie,
        )
      ).data.notes.filter((n) => n.body === "失败附件可重试且不重复上传")
        .length,
      1,
    );
    // Deep links reject a record from another project and retain no prior detail text.
    if (projects[1]) {
      await page.goto(
        origin +
          "/worklog/?module=notes&project=" +
          projects[1].id +
          "&note=" +
          child.id,
      );
      await page
        .getByRole("dialog", { name: "事项详情", exact: true })
        .getByText(/不属于当前项目/)
        .waitFor();
      assert.ok(!(await page.locator("body").innerText()).includes(child.body));
    }
    await page.goto(
      origin +
        "/worklog/?module=notes&project=" +
        project.id +
        "&note=" +
        child.id,
    );
    await thread
      .getByText("原事项已删除，已有补充仍保留。", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    if (process.env.WORKLOG_QA_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(
          process.env.WORKLOG_QA_SCREENSHOT_DIR,
          "record-archives-mobile.png",
        ),
        fullPage: true,
      });
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("PRIVATE UNSAVED DRAFT");
    await page.route(
      "**/api/projects/*/notes",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "fixture session expired" }),
            })
          : route.continue(),
      { times: 1 },
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(
      !(await page.locator("body").innerText()).includes(
        "PRIVATE UNSAVED DRAFT",
      ),
    );
    await row(child.id)
      .getByRole("button", { name: /补充 · 查看原事项/ })
      .click();
    await thread
      .getByText("原事项已删除，已有补充仍保留。", { exact: true })
      .waitFor();
    await page.route(
      "**/api/documents/" + one.document_id,
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture download session expired" }),
        }),
      { times: 1 },
    );
    await thread
      .locator('[data-thread-note-id="' + root.id + '"]')
      .getByRole("button", { name: "现场说明-v1.txt", exact: true })
      .click();
    await thread.waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: "登录后查看", exact: true })
      .waitFor();
    assert.ok(
      !(await page.locator("body").innerText()).includes(child.body),
      "expired download must clear private record content",
    );
    await page.getByRole("button", { name: "登录后查看", exact: true }).click();
    const loginDialog = page.getByRole("dialog", {
      name: "欢迎来到项目工作台",
      exact: true,
    });
    await loginDialog
      .getByLabel("账号", { exact: true })
      .fill("records_archive_ui");
    await loginDialog
      .getByLabel("密码", { exact: true })
      .fill("Temporary-fixture-123");
    await loginDialog
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await thread.getByText(child.body, { exact: true }).waitFor();
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    assert.equal(
      await dialog.getByLabel("内容", { exact: true }).inputValue(),
      "",
      "same-account login must not restore a cleared draft",
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(
      "Record archive browser passed: pinned bytes, legacy manual pin and CAS, independent supplements, deleted root continuity, upload race/retry, cross-project deep links, mobile and 401 draft cleanup.",
    );
  } catch (e) {
    if (page && process.env.WORKLOG_QA_SCREENSHOT_DIR)
      await page
        .screenshot({
          path: path.join(
            process.env.WORKLOG_QA_SCREENSHOT_DIR,
            "record-archives-failure.png",
          ),
          fullPage: true,
        })
        .catch(() => {});
    if (page)
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-4000),
      );
    throw e;
  } finally {
    await browser?.close();
    await app?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
