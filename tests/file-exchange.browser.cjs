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
    path.join(os.tmpdir(), "worklog-file-exchange-browser-"),
  );
  const origin = "http://127.0.0.1:8814",
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
      app.server.listen(8814, "127.0.0.1", resolve),
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
      login: "file_exchange_ui",
      password: "Temporary-fixture-123",
    });
    const cookie = member.cookie,
      project = (await api("/state")).data.projects[0];
    const list = () =>
      api("/projects/" + project.id + "/notes", "GET", undefined, cookie).then(
        (r) => r.data.notes,
      );
    const legacy = (
      await api(
        "/projects/" + project.id + "/notes",
        "POST",
        { kind: "file", body: "历史往来方向与时间均未知", occurred_on: "" },
        cookie,
      )
    ).data.note;
    const site = (
      await api(
        "/projects/" + project.id + "/notes",
        "POST",
        { kind: "site", body: "现场设置仍可独立筛选" },
        cookie,
      )
    ).data.note;
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
    await row(legacy.id).getByText("未区分收发", { exact: true }).waitFor();
    await row(legacy.id)
      .getByText("业务时间：未记录", { exact: true })
      .waitFor();
    await row(legacy.id).getByText("往来方：未记录", { exact: true }).waitFor();
    await row(legacy.id).getByText("渠道：未记录", { exact: true }).waitFor();
    await row(legacy.id)
      .getByText("业务日期未记录，按登记日分组", { exact: true })
      .waitFor();
    await row(legacy.id)
      .getByRole("button", { name: /^查看事项/ })
      .click();
    const legacyThread = page.getByRole("dialog", {
      name: "事项详情",
      exact: true,
    });
    await legacyThread.getByText(/^按登记日显示：/).waitFor();
    await legacyThread.getByText("业务时间：未记录", { exact: true }).waitFor();
    assert.equal(await legacyThread.getByText(/^收到时间：/).count(), 0);
    await legacyThread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    // Receiving is a record of an existing exchange, with a separately chosen business date.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    let dialog = page.getByRole("dialog", {
      name: "记一条随手记",
      exact: true,
    });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    await dialog
      .getByLabel("收发方向", { exact: true })
      .selectOption("received");
    await dialog.getByLabel("提供方（选填）", { exact: true }).fill("客户张工");
    await dialog.getByLabel("发生日期", { exact: true }).fill("2026-10-15");
    await dialog
      .getByLabel("具体时间（选填，北京时间）", { exact: true })
      .fill("09:35");
    await dialog
      .getByLabel("渠道（选填）", { exact: true })
      .fill("客户自建门户/临时交换");
    await dialog.getByLabel("内容", { exact: true }).fill("收到客户修订图纸");
    await dialog.getByLabel("添加附件", { exact: true }).setInputFiles({
      name: "修订图纸-v1.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("SYNTHETIC RECEIVED VERSION ONE"),
    });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("收到客户修订图纸", { exact: true }).waitFor();
    let received = (await list()).find((n) => n.body === "收到客户修订图纸");
    assert.equal(received.file_direction, "received");
    assert.equal(received.counterparty, "客户张工");
    assert.equal(received.occurred_on, "2026-10-15");
    assert.equal(received.exchange_time, "09:35");
    assert.equal(received.channel, "客户自建门户/临时交换");
    assert.equal(received.files.length, 1);
    assert.ok(received.files[0].version_id);
    await row(received.id).getByText("当时 V1", { exact: true }).waitFor();
    await row(received.id)
      .getByText("提供方：客户张工", { exact: true })
      .waitFor();
    await row(received.id)
      .getByText("收到时间：2026-10-15 09:35（北京时间）", { exact: true })
      .waitFor();
    // Sending never sends a message or a file; it uses the same note-save flow.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    await dialog.getByLabel("收发方向", { exact: true }).selectOption("sent");
    await dialog.getByText(/只登记事实，不会向外发送文件/).waitFor();
    await dialog
      .getByLabel("接收方（选填）", { exact: true })
      .fill("业主项目部");
    await dialog.getByLabel("发生日期", { exact: true }).fill("2026-10-16");
    await dialog.getByLabel("渠道（选填）", { exact: true }).fill("邮件");
    await dialog.getByLabel("内容", { exact: true }).fill("已向业主交付签署版");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("已向业主交付签署版", { exact: true }).waitFor();
    const sent = (await list()).find((n) => n.body === "已向业主交付签署版");
    assert.equal(sent.file_direction, "sent");
    assert.equal(sent.exchange_time, "");
    await row(sent.id)
      .getByText("发出时间：2026-10-16（未记录具体时间）", { exact: true })
      .waitFor();
    // Unknown directions and dates stay unknown, while a known counterparty is still useful.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("收发方向", { exact: true }).inputValue(),
      "",
    );
    await dialog.getByLabel("往来方（选填）", { exact: true }).fill("资料室");
    await dialog.getByLabel("发生日期", { exact: true }).fill("");
    assert.equal(
      await dialog
        .getByLabel("具体时间（选填，北京时间）", { exact: true })
        .isDisabled(),
      true,
    );
    await dialog.getByLabel("内容", { exact: true }).fill("待核实的资料往来");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("待核实的资料往来", { exact: true }).waitFor();
    const unknown = (await list()).find((n) => n.body === "待核实的资料往来");
    assert.equal(unknown.file_direction, "");
    assert.equal(unknown.occurred_on, "");
    assert.equal(unknown.exchange_time, "");
    // Existing type filters, direction filters and text search compose without losing other types.
    const direction = log.getByLabel("收发筛选", { exact: true });
    await direction.selectOption("received");
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await row(received.id).waitFor();
    await direction.selectOption("sent");
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await row(sent.id).waitFor();
    await direction.selectOption("unclassified");
    assert.equal(await log.locator("[data-note-id]").count(), 2);
    await row(legacy.id).waitFor();
    await row(unknown.id).waitFor();
    await log
      .getByRole("group", { name: "类型筛选", exact: true })
      .getByRole("button", { name: "现场设置", exact: true })
      .click();
    assert.equal(await direction.inputValue(), "");
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await row(site.id).waitFor();
    await log
      .getByRole("group", { name: "类型筛选", exact: true })
      .getByRole("button", { name: "全部", exact: true })
      .click();
    await log.getByLabel("搜索随手记", { exact: true }).fill("业主项目部");
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await row(sent.id).waitFor();
    await log.getByLabel("搜索随手记", { exact: true }).fill("临时交换");
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await row(received.id).waitFor();
    await log.getByLabel("搜索随手记", { exact: true }).fill("");
    console.log("File exchange form, unknown facts, filters and search passed");
    // A supplement records a separate exchange and must not inherit the previous exchange facts.
    await row(received.id)
      .getByRole("button", { name: "补充一条", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "补充一条", exact: true });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("收发方向", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await dialog.getByLabel("往来方（选填）", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await dialog
        .getByLabel("具体时间（选填，北京时间）", { exact: true })
        .inputValue(),
      "",
    );
    assert.equal(
      await dialog.getByLabel("渠道（选填）", { exact: true }).inputValue(),
      "",
    );
    await dialog.getByLabel("收发方向", { exact: true }).selectOption("sent");
    await dialog.getByLabel("接收方（选填）", { exact: true }).fill("施工单位");
    await dialog.getByLabel("发生日期", { exact: true }).fill("2026-10-17");
    await dialog
      .getByLabel("具体时间（选填，北京时间）", { exact: true })
      .fill("16:10");
    await dialog.getByLabel("渠道（选填）", { exact: true }).fill("线下签收");
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("补充：修订图纸已交施工方");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await log.getByText("补充：修订图纸已交施工方", { exact: true }).waitFor();
    const supplement = (await list()).find(
      (n) => n.body === "补充：修订图纸已交施工方",
    );
    assert.equal(supplement.parent_note_id, received.id);
    assert.equal(supplement.counterparty, "施工单位");
    await row(supplement.id)
      .getByRole("button", { name: /补充 · 查看原事项/ })
      .click();
    const thread = page.getByRole("dialog", { name: "事项详情", exact: true });
    await thread.getByText("提供方：客户张工", { exact: true }).waitFor();
    await thread.getByText("接收方：施工单位", { exact: true }).waitFor();
    await thread
      .getByText("发出时间：2026-10-17 16:10（北京时间）", { exact: true })
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
          "file-exchange-thread-mobile.png",
        ),
        fullPage: true,
      });
    await thread
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page.setViewportSize({ width: 1280, height: 950 });
    // A newer original never changes the version used by the received record.
    const attachment = received.files[0],
      bytes = Buffer.from("SYNTHETIC RECEIVED VERSION TWO");
    const upload = (
      await api(
        "/uploads",
        "POST",
        {
          project_id: project.id,
          document_id: attachment.document_id,
          base_version_id: attachment.version_id,
          filename: "修订图纸-v2.txt",
          size: bytes.length,
        },
        cookie,
      )
    ).data;
    const chunk = await fetch(base + "/uploads/" + upload.id + "/chunks/0", {
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
    await api("/uploads/" + upload.id + "/complete", "POST", {}, cookie);
    await log.getByRole("button", { name: "刷新随手记", exact: true }).click();
    await row(received.id).getByText("当时 V1", { exact: true }).waitFor();
    const downloadEvent = page.waitForEvent("download");
    await row(received.id)
      .getByRole("button", { name: "修订图纸-v1.txt", exact: true })
      .click();
    const downloaded = await downloadEvent;
    assert.equal(
      await fs.readFile(await downloaded.path(), "utf8"),
      "SYNTHETIC RECEIVED VERSION ONE",
    );
    // Clearing a business date clears its minute; changing to another kind clears all exchange facts.
    await row(received.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await dialog.getByLabel("发生日期", { exact: true }).fill("");
    assert.equal(
      await dialog
        .getByLabel("具体时间（选填，北京时间）", { exact: true })
        .inputValue(),
      "",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    received = (await api("/notes/" + received.id, "GET", undefined, cookie))
      .data.note;
    assert.equal(received.occurred_on, "");
    assert.equal(received.exchange_time, "");
    assert.equal(received.file_direction, "received");
    await row(received.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    dialog = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await dialog.getByRole("button", { name: "口头约定", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("收发方向", { exact: true }).count(),
      0,
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    const changed = (
      await api("/notes/" + received.id, "GET", undefined, cookie)
    ).data.note;
    for (const field of [
      "file_direction",
      "counterparty",
      "exchange_time",
      "channel",
    ])
      assert.equal(changed[field], "");
    assert.equal(changed.kind, "verbal");
    assert.equal(changed.files[0].version_id, attachment.version_id);
    const events = (
      await api(
        "/resource-events?project_id=" + project.id,
        "GET",
        undefined,
        cookie,
      )
    ).data.entries;
    const correction = events.find(
      (e) =>
        e.action === "update-note" &&
        e.entity_id === received.id &&
        e.details.after?.kind === "verbal",
    );
    assert.equal(correction.details.before.file_direction, "received");
    assert.equal(correction.details.after.file_direction, "");
    // Direction filtering also applies to the recycle bin without deleting independent supplements.
    page.once("dialog", (d) => d.accept());
    await row(sent.id)
      .getByRole("button", { name: /^删除随手记：/ })
      .click();
    await row(sent.id).waitFor({ state: "detached" });
    await direction.selectOption("sent");
    await log.getByRole("button", { name: "回收站", exact: true }).click();
    await row(sent.id).waitFor();
    assert.equal(await log.locator("[data-note-id]").count(), 1);
    await log.getByRole("button", { name: "恢复", exact: true }).click();
    await row(sent.id).waitFor({ state: "detached" });
    await log.getByRole("button", { name: "回收站", exact: true }).click();
    await row(sent.id).waitFor();
    await row(supplement.id).waitFor();
    await direction.selectOption("");
    await log
      .getByRole("group", { name: "类型筛选", exact: true })
      .getByRole("button", { name: "全部", exact: true })
      .click();
    console.log(
      "File exchange supplements, pinning, corrections, audit and recycle passed",
    );
    // Expired saves close the editor and clear its private exchange fields.
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    await dialog.getByLabel("收发方向", { exact: true }).selectOption("sent");
    await dialog
      .getByLabel("接收方（选填）", { exact: true })
      .fill("PRIVATE EXCHANGE PARTY");
    await dialog
      .getByLabel("渠道（选填）", { exact: true })
      .fill("PRIVATE EXCHANGE CHANNEL");
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("PRIVATE EXCHANGE DRAFT");
    await page.route(
      "**/api/projects/*/notes",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "fixture expired session" }),
            })
          : route.continue(),
      { times: 1 },
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(
      !(await page.locator("body").innerText()).includes("PRIVATE EXCHANGE"),
    );
    await log.getByRole("button", { name: "记一条", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog.getByRole("button", { name: "文件收发", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("往来方（选填）", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await dialog.getByLabel("渠道（选填）", { exact: true }).inputValue(),
      "",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(
      "File exchange browser passed: received/sent/unknown facts, independent business time, free-form counterparties/channels, filters/search, supplement continuity, pinned bytes, correction audit, recycle, 401 cleanup and mobile.",
    );
  } catch (error) {
    if (page && process.env.WORKLOG_QA_SCREENSHOT_DIR)
      await page
        .screenshot({
          path: path.join(
            process.env.WORKLOG_QA_SCREENSHOT_DIR,
            "file-exchange-failure.png",
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
    throw error;
  } finally {
    await browser?.close();
    await app?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
