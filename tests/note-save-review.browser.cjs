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
    path.join(os.tmpdir(), "worklog-note-save-review-"),
  );
  const origin = "http://127.0.0.1:8817",
    base = origin + "/worklog/api";
  let app, browser, page;
  const findings = [];
  try {
    app = await createApp({
      allowUninvitedRegistration: true,
      dataDir,
      filesDir: path.join(dataDir, "files"),
      vaultKey: Buffer.alloc(32, 73),
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((resolve) =>
      app.server.listen(8817, "127.0.0.1", resolve),
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
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return {
        data: result,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const member = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "note_save_review",
      password: "Temporary-fixture-123",
    });
    const cookie = member.cookie,
      project = (await api("/state")).data.projects[0];
    const notes = () =>
      api("/projects/" + project.id + "/notes", "GET", undefined, cookie).then(
        (r) => r.data.notes,
      );
    const documents = () =>
      api(
        "/projects/" + project.id + "/documents",
        "GET",
        undefined,
        cookie,
      ).then((r) => r.data.documents);
    async function upload(filename, content, metadata = {}) {
      const bytes = Buffer.from(content),
        session = (
          await api(
            "/uploads",
            "POST",
            {
              project_id: project.id,
              filename,
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
    const a1 = await upload("甲-v1.txt", "EXISTING A ONE", {
      title: "既有资料甲",
    });
    const a2 = await upload("甲-v2.txt", "EXISTING A TWO", {
      document_id: a1.document_id,
      base_version_id: a1.version_id,
    });
    const b = await upload("乙-v1.txt", "EXISTING B ONE", {
      title: "既有资料乙",
    });
    const c = await upload("丙-v1.txt", "CANCELLED C", { title: "待取消资料" });
    const task = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "保存审查合成任务",
          owner: REGISTRATION_NAMES[0],
        },
        cookie,
      )
    ).data.id;
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
    await context.addInitScript(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });
    });
    const [name, value] = cookie.split(/=(.*)/);
    await context.addCookies([{ name, value, url: origin }]);
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(origin + "/worklog/?module=notes&project=" + project.id);
    const log = page.getByRole("region", { name: "随手记", exact: true });
    const row = (id) => log.locator('[data-note-id="' + id + '"]');
    const editor = () => page.getByRole("dialog").last();
    async function createDraft(body) {
      await log.getByRole("button", { name: "记一条", exact: true }).click();
      await editor().getByLabel("内容", { exact: true }).fill(body);
    }
    async function pick(docId, versionId) {
      if (
        await editor()
          .getByRole("button", { name: "关联已有资料", exact: true })
          .count()
      )
        await editor()
          .getByRole("button", { name: "关联已有资料", exact: true })
          .click();
      await editor()
        .getByLabel("选择已有资料", { exact: true })
        .selectOption(docId);
      await editor()
        .getByLabel("选择资料版本", { exact: true })
        .selectOption(versionId);
    }
    async function save() {
      await editor().getByRole("button", { name: "保存", exact: true }).click();
    }
    async function loseCreateResponse() {
      let created;
      await page.route(
        "**/api/projects/" + project.id + "/notes",
        async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          const response = await route.fetch();
          const result = await response.json();
          assert.ok(response.ok());
          created = result.note;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: "FIXTURE CREATE RESPONSE LOST AFTER COMMIT",
            }),
          });
        },
        { times: 1 },
      );
      await save();
      await editor()
        .getByText("FIXTURE CREATE RESPONSE LOST AFTER COMMIT", { exact: true })
        .waitFor();
      return created;
    }
    // One save chooses exact existing versions, multiple files and cancellation without writes.
    const beforeCancel = (await notes()).length;
    await createDraft("取消不应创建记录或关联");
    await pick(c.document_id, c.version_id);
    await editor()
      .getByRole("button", { name: "再选一份资料", exact: true })
      .click();
    await editor().getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await notes()).length, beforeCancel);
    await createDraft("一次保存保留明确历史版本");
    await pick(a1.document_id, a1.version_id);
    await editor()
      .getByRole("button", { name: "再选一份资料", exact: true })
      .click();
    await pick(b.document_id, b.version_id);
    await upload("甲-v3.txt", "EXISTING A THREE", {
      document_id: a1.document_id,
      base_version_id: a2.version_id,
    });
    await save();
    await log.getByText("一次保存保留明确历史版本", { exact: true }).waitFor();
    let saved = (await notes()).find(
      (n) => n.body === "一次保存保留明确历史版本",
    );
    assert.equal(saved.files.length, 2);
    assert.equal(
      saved.files.find((f) => f.document_id === a1.document_id).version_id,
      a1.version_id,
    );
    const downloadEvent = page.waitForEvent("download");
    await row(saved.id)
      .getByRole("button", { name: "甲-v1.txt", exact: true })
      .click();
    assert.equal(
      await fs.readFile(await (await downloadEvent).path(), "utf8"),
      "EXISTING A ONE",
    );
    await row(saved.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    await pick(c.document_id, c.version_id);
    await editor().getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      (await api("/notes/" + saved.id, "GET", undefined, cookie)).data.note
        .files.length,
      2,
    );
    // A definite, rolled-back 409 must let the selection be corrected without discarding the draft.
    const conflictBase = await upload("冲突底稿.txt", "CONFLICT BASE", {
      title: "待更正冲突资料",
    });
    const conflictCurrent = await upload("冲突正常版.txt", "CONFLICT CURRENT", {
      document_id: conflictBase.document_id,
      base_version_id: conflictBase.version_id,
    });
    const adoptedConflict = await upload(
      "冲突候选.txt",
      "CONFLICT ADOPTED THEN RETIRED",
      {
        document_id: conflictBase.document_id,
        base_version_id: conflictBase.version_id,
      },
    );
    assert.equal(adoptedConflict.conflict, true);
    async function selectCurrent(documentId, versionId) {
      const doc = (
        await api("/documents/" + documentId, "GET", undefined, cookie)
      ).data.document;
      await api(
        "/documents/" + documentId + "/select-version",
        "POST",
        { version: doc.version, version_id: versionId },
        cookie,
      );
    }
    await selectCurrent(conflictBase.document_id, adoptedConflict.version_id);
    await createDraft("确定未提交冲突可修正选择");
    await pick(conflictBase.document_id, adoptedConflict.version_id);
    await selectCurrent(conflictBase.document_id, conflictCurrent.version_id);
    await save();
    await editor()
      .getByText(/请先采用待合并版本/)
      .waitFor();
    assert.equal(
      (await notes()).some((n) => n.body === "确定未提交冲突可修正选择"),
      false,
    );
    await pick(b.document_id, b.version_id);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const correctedSelection = (await notes()).find(
      (n) => n.body === "确定未提交冲突可修正选择",
    );
    assert.equal(correctedSelection.files.length, 1);
    assert.equal(correctedSelection.files[0].document_id, b.document_id);
    // The first create really commits before the response is replaced by a server error.
    await createDraft("创建响应丢失后原样重试");
    await pick(a1.document_id, a2.version_id);
    const firstLost = await loseCreateResponse();
    assert.equal(
      (await notes()).filter((n) => n.body === "创建响应丢失后原样重试").length,
      1,
    );
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const replayed = (await notes()).filter(
      (n) => n.body === "创建响应丢失后原样重试",
    );
    if (replayed.length !== 1 || replayed[0].id !== firstLost.id)
      findings.push(
        "P1 committed create response lost then retry created " +
          replayed.length +
          " notes",
      );
    await createDraft("连接中断后仍只创建一条");
    let disconnectedCreated;
    await page.route(
      "**/api/projects/" + project.id + "/notes",
      async (route) => {
        const response = await route.fetch();
        disconnectedCreated = (await response.json()).note;
        await route.abort("connectionreset");
      },
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/网络连接失败/)
      .waitFor();
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const disconnectedNotes = (await notes()).filter(
      (n) => n.body === "连接中断后仍只创建一条",
    );
    assert.equal(disconnectedNotes.length, 1);
    assert.equal(disconnectedNotes[0].id, disconnectedCreated.id);
    // An ambiguous create with a changed local draft first recovers, then requires an explicit edit save.
    await createDraft("丢响应后保留改稿 原始");
    const changedOriginal = await loseCreateResponse();
    await editor()
      .getByLabel("内容", { exact: true })
      .fill("丢响应后保留改稿 修订");
    await save();
    await page.waitForTimeout(100);
    if (await page.getByRole("dialog").count()) {
      await editor()
        .getByText(/上次新建已保存|已恢复原记录/)
        .waitFor();
      assert.equal(
        await editor().getByLabel("内容", { exact: true }).inputValue(),
        "丢响应后保留改稿 修订",
      );
      await save();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    }
    const changedNotes = (await notes()).filter((n) =>
      n.body.startsWith("丢响应后保留改稿"),
    );
    if (
      changedNotes.length !== 1 ||
      changedNotes[0].id !== changedOriginal.id ||
      changedNotes[0].body !== "丢响应后保留改稿 修订"
    )
      findings.push(
        "P1 ambiguous create with changed draft duplicated or lost the intended correction",
      );
    await createDraft("创建后已删除的记录不得续传");
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "禁止复活上传.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("DO NOT UPLOAD TO DELETED NOTE"),
      });
    const deletedOriginal = await loseCreateResponse();
    await api(
      "/notes/" + deletedOriginal.id,
      "DELETE",
      { version: deletedOriginal.version },
      cookie,
    );
    await save();
    await editor()
      .getByText(/该记录现已被删除/)
      .waitFor();
    assert.equal(
      await editor()
        .getByRole("button", { name: "保存", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (await notes()).filter((n) => n.body === "创建后已删除的记录不得续传")
        .length,
      0,
    );
    assert.equal(
      (await documents()).filter((d) => d.filename === "禁止复活上传.txt")
        .length,
      0,
    );
    await editor().getByRole("button", { name: "完成", exact: true }).click();
    // An unknown error can also mean no commit happened; newer drafts must still survive the first successful retry.
    await createDraft("未提交五百后改稿 原始");
    await pick(a1.document_id, a1.version_id);
    await page.route(
      "**/api/projects/" + project.id + "/notes",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "FIXTURE NOT COMMITTED 500" }),
        }),
      { times: 1 },
    );
    await save();
    await editor()
      .getByText("FIXTURE NOT COMMITTED 500", { exact: true })
      .waitFor();
    assert.equal(
      (await notes()).some((n) => n.body === "未提交五百后改稿 原始"),
      false,
    );
    await editor()
      .getByLabel("内容", { exact: true })
      .fill("未提交五百后改稿 修订");
    await pick(b.document_id, b.version_id);
    await save();
    await editor()
      .getByText(/已恢复原记录/)
      .waitFor();
    assert.equal(
      await editor().getByLabel("内容", { exact: true }).inputValue(),
      "未提交五百后改稿 修订",
    );
    assert.equal(
      await editor().getByLabel("选择已有资料", { exact: true }).inputValue(),
      b.document_id,
    );
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const newlyCommittedDrafts = (await notes()).filter((n) =>
      n.body.startsWith("未提交五百后改稿"),
    );
    assert.equal(newlyCommittedDrafts.length, 1);
    assert.equal(newlyCommittedDrafts[0].body, "未提交五百后改稿 修订");
    assert.equal(
      newlyCommittedDrafts[0].files.some(
        (f) => f.document_id === b.document_id,
      ),
      true,
    );
    // Save-first uploads retain their original resume metadata after the note text/task changes.
    await createDraft("完成响应丢失后更正文案 原始");
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "完成响应丢失.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("UPLOAD COMPLETED ONCE"),
      });
    let completed;
    await page.route(
      "**/api/uploads/*/complete",
      async (route) => {
        const response = await route.fetch();
        completed = await response.json();
        assert.ok(response.ok());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "FIXTURE COMPLETE RESPONSE LOST AFTER COMMIT",
          }),
        });
      },
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/以下附件未关联成功/)
      .waitFor();
    await editor()
      .getByLabel("内容", { exact: true })
      .fill("完成响应丢失后更正文案 修订");
    await editor()
      .getByLabel("关联任务（选填）", { exact: true })
      .selectOption(task);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const completedDocs = (await documents()).filter(
      (d) => d.filename === "完成响应丢失.txt",
    );
    const completedNote = (await notes()).find(
      (n) => n.body === "完成响应丢失后更正文案 修订",
    );
    if (
      completedDocs.length !== 1 ||
      completedNote.files[0]?.version_id !== completed.version_id
    )
      findings.push(
        "P1 completed upload response lost plus changed note metadata uploaded " +
          completedDocs.length +
          " documents",
      );
    // A committed upload-session POST with a lost response must reuse its reservation too.
    await createDraft("初始上传会话响应丢失不重复预留");
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "会话初始响应丢失.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("SINGLE SESSION RESERVATION"),
      });
    let firstSession;
    const sessionCount = () =>
      app.db
        .prepare("SELECT COUNT(*) n FROM document_uploads WHERE filename=?")
        .get("会话初始响应丢失.txt").n;
    const activeReservation = () =>
      app.db
        .prepare(
          "SELECT COALESCE(SUM(size),0) n FROM document_uploads WHERE filename=? AND status='active'",
        )
        .get("会话初始响应丢失.txt").n;
    await page.route(
      "**/api/uploads",
      async (route) => {
        const response = await route.fetch();
        firstSession = await response.json();
        assert.ok(response.ok());
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "FIXTURE UPLOAD SESSION RESPONSE LOST",
          }),
        });
      },
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/以下附件未关联成功/)
      .waitFor();
    assert.equal(sessionCount(), 1);
    assert.ok(activeReservation() > 0);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(sessionCount(), 1);
    assert.equal(activeReservation(), 0);
    assert.equal(
      (await api("/uploads/" + firstSession.id, "GET", undefined, cookie)).data
        .status,
      "complete",
    );
    const sessionNote = (await notes()).filter(
      (n) => n.body === "初始上传会话响应丢失不重复预留",
    );
    assert.equal(sessionNote.length, 1);
    assert.equal(sessionNote[0].files.length, 1);
    assert.equal(
      (await documents()).filter((d) => d.filename === "会话初始响应丢失.txt")
        .length,
      1,
    );
    // A failed new upload leaves one saved note and can be retried with its existing-file links intact.
    await createDraft("新上传失败仍保留一次正文");
    await pick(b.document_id, b.version_id);
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "分片重试.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("SINGLE RETRIED UPLOAD"),
      });
    await page.route(
      "**/api/uploads/*/chunks/*",
      (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "FIXTURE RETRY CHUNK" }),
        }),
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/以下附件未关联成功/)
      .waitFor();
    const failedNote = (await notes()).find(
      (n) => n.body === "新上传失败仍保留一次正文",
    );
    assert.equal(failedNote.files.length, 1);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const retried = (await notes()).filter(
      (n) => n.body === "新上传失败仍保留一次正文",
    );
    assert.equal(retried.length, 1);
    assert.equal(retried[0].id, failedNote.id);
    assert.equal(retried[0].files.length, 2);
    // A known validation failure may correct its task metadata instead of staying frozen forever.
    const staleTask = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: "上传期间删除的任务",
          owner: REGISTRATION_NAMES[0],
        },
        cookie,
      )
    ).data.id;
    await page.reload();
    await log.getByRole("button", { name: "记一条", exact: true }).waitFor();
    await createDraft("未完成上传允许修正失效任务");
    await editor()
      .getByLabel("关联任务（选填）", { exact: true })
      .selectOption(staleTask);
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles({
        name: "修正失效任务.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("VALIDATED TASK RECOVERY"),
      });
    await page.route(
      "**/api/uploads/*/complete",
      async (route) => {
        const currentTask = (await api("/state")).data.records.find(
          (r) => r.id === staleTask,
        );
        await api(
          "/records/" + staleTask,
          "DELETE",
          { version: currentTask.version },
          cookie,
        );
        const response = await route.fetch();
        assert.equal(response.status(), 400);
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/以下附件未关联成功/)
      .waitFor();
    await editor()
      .getByLabel("关联任务（选填）", { exact: true })
      .selectOption(task);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const correctedUpload = (await notes()).filter(
      (n) => n.body === "未完成上传允许修正失效任务",
    );
    assert.equal(correctedUpload.length, 1);
    assert.equal(correctedUpload[0].task_id, task);
    assert.equal(correctedUpload[0].files.length, 1);
    assert.equal(
      (await documents()).filter((d) => d.filename === "修正失效任务.txt")
        .length,
      1,
    );
    // A File selected again in a reopened dialog retains the original resume target format.
    const reopenFile = path.join(dataDir, "跨弹窗续传.txt");
    await fs.writeFile(reopenFile, "PRESERVE LEGACY RESUME TARGET");
    await createDraft("跨弹窗重选文件继续旧续传");
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles(reopenFile);
    await page.route(
      "**/api/uploads/*/chunks/*",
      (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "FIXTURE REOPEN PART" }),
        }),
      { times: 1 },
    );
    await save();
    await editor()
      .getByText(/以下附件未关联成功/)
      .waitFor();
    await editor().getByRole("button", { name: "完成", exact: true }).click();
    const reopenNote = (await notes()).find(
      (n) => n.body === "跨弹窗重选文件继续旧续传",
    );
    await row(reopenNote.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    await editor()
      .getByLabel("添加附件", { exact: true })
      .setInputFiles(reopenFile);
    await save();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(
      app.db
        .prepare("SELECT COUNT(*) n FROM document_uploads WHERE filename=?")
        .get("跨弹窗续传.txt").n,
      1,
      "execution client keys must not break legacy metadata-based resume matching",
    );
    assert.equal(
      (await api("/notes/" + reopenNote.id, "GET", undefined, cookie)).data.note
        .files.length,
      1,
    );
    // Known ended sessions are renewed once automatically; other upload conflicts are not blindly retried.
    for (const endedStatus of ["expired", "cancelled"]) {
      const filename = "会话自动恢复-" + endedStatus + ".txt";
      await createDraft("已结束上传会话自动恢复 " + endedStatus);
      await editor()
        .getByLabel("添加附件", { exact: true })
        .setInputFiles({
          name: filename,
          mimeType: "text/plain",
          buffer: Buffer.from("RENEW ENDED SESSION " + endedStatus),
        });
      let endedSessionId;
      await page.route(
        "**/api/uploads/*/complete",
        (route) => {
          endedSessionId = route
            .request()
            .url()
            .match(/uploads\/([^/]+)\/complete$/)[1];
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "FIXTURE INCOMPLETE SESSION" }),
          });
        },
        { times: 1 },
      );
      await save();
      await editor()
        .getByText(/以下附件未关联成功/)
        .waitFor();
      // Only this synthetic app.db under dataDir is changed to model expiry/cancellation.
      app.db
        .prepare("UPDATE document_uploads SET status=? WHERE id=?")
        .run(endedStatus, endedSessionId);
      await save();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      assert.equal(
        app.db
          .prepare("SELECT COUNT(*) n FROM document_uploads WHERE filename=?")
          .get(filename).n,
        2,
      );
      assert.equal(
        app.db
          .prepare(
            "SELECT COUNT(*) n FROM document_uploads WHERE filename=? AND status='complete'",
          )
          .get(filename).n,
        1,
      );
      assert.equal(
        (await documents()).filter((d) => d.filename === filename).length,
        1,
      );
      assert.equal(
        (await notes()).filter(
          (n) => n.body === "已结束上传会话自动恢复 " + endedStatus,
        ).length,
        1,
      );
    }
    // Existing note CAS remains active when the draft also selects another existing file.
    saved = (await api("/notes/" + saved.id, "GET", undefined, cookie)).data
      .note;
    await row(saved.id)
      .getByRole("button", { name: /^编辑随手记：/ })
      .click();
    await editor()
      .getByLabel("内容", { exact: true })
      .fill("LOCAL CAS DRAFT MUST STAY");
    await pick(c.document_id, c.version_id);
    await api(
      "/notes/" + saved.id,
      "PATCH",
      { body: "OTHER EDITOR CAS WINS", version: saved.version },
      cookie,
    );
    await save();
    await editor()
      .getByText(/这条随手记已被修改/)
      .waitFor();
    assert.equal(
      await editor().getByLabel("内容", { exact: true }).inputValue(),
      "LOCAL CAS DRAFT MUST STAY",
    );
    const casNote = (await api("/notes/" + saved.id, "GET", undefined, cookie))
      .data.note;
    assert.equal(casNote.body, "OTHER EDITOR CAS WINS");
    assert.equal(
      casNote.files.some((f) => f.document_id === c.document_id),
      false,
    );
    await editor().getByRole("button", { name: "取消", exact: true }).click();
    // A private-document lookup returning 401 clears the complete new-record draft and choices.
    await createDraft("PRIVATE AMBIGUOUS SAVE DRAFT");
    if (
      await editor()
        .getByRole("button", { name: "关联已有资料", exact: true })
        .count()
    )
      await editor()
        .getByRole("button", { name: "关联已有资料", exact: true })
        .click();
    await page.route(
      "**/api/documents/" + c.document_id,
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "FIXTURE SESSION EXPIRED" }),
        }),
      { times: 1 },
    );
    await editor()
      .getByLabel("选择已有资料", { exact: true })
      .selectOption(c.document_id);
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.ok(
      !(await page.locator("body").innerText()).includes(
        "PRIVATE AMBIGUOUS SAVE DRAFT",
      ),
    );
    assert.equal(
      await page.evaluate(() => typeof globalThis.crypto.randomUUID),
      "undefined",
      "this suite exercises the insecure-context UUID fallback",
    );
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(findings, [], findings.join("; "));
    console.log(
      "Note save review browser passed: create response replay, changed-draft recovery, upload-complete resume, save-first retry, exact existing versions/multiple/cancel, background version changes, CAS and 401 cleanup.",
    );
  } catch (error) {
    if (page && process.env.WORKLOG_QA_SCREENSHOT_DIR)
      await page
        .screenshot({
          path: path.join(
            process.env.WORKLOG_QA_SCREENSHOT_DIR,
            "note-save-review-failure.png",
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
