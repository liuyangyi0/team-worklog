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
    path.join(os.tmpdir(), "task-materials-review-"),
  );
  const origin = "http://127.0.0.1:8819",
    base = origin + "/worklog/api";
  let app, browser;
  try {
    app = await createApp({
      dataDir,
      filesDir: path.join(dataDir, "synthetic-files"),
      vaultKey: Buffer.alloc(32, 9).toString("base64"),
      origin,
      adminLogin: "compat_admin",
      adminPassword: "Task-materials-fixture-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8819, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const response = await fetch(base + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return {
        data,
        cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
      };
    }
    const admin = await api("/login", "POST", {
        login: "compat_admin",
        password: "Task-materials-fixture-123",
      }),
      cookie = admin.cookie;
    const project = (await api("/state")).data.projects[0];
    const taskTitle = "Compatibility task fixture";
    const task = (
      await api(
        "/records",
        "POST",
        {
          project_id: project.id,
          task: taskTitle,
          owner: "管理员",
          actual: "",
          date: "",
        },
        cookie,
      )
    ).data.id;
    const otherTaskTitle = "Other compatibility task fixture";
    await api(
      "/records",
      "POST",
      {
        project_id: project.id,
        task: otherTaskTitle,
        owner: "管理员",
        actual: "",
        date: "",
      },
      cookie,
    );
    const checklist = (
      await api(
        "/projects/" + project.id + "/deliverables",
        "POST",
        { title: "Compatibility checklist fixture", evidence_kind: "record" },
        cookie,
      )
    ).data.item;
    async function upload(filename, extra = {}) {
      const bytes = Buffer.from("Synthetic compatibility file " + filename);
      const start = (
        await api(
          "/uploads",
          "POST",
          {
            project_id: project.id,
            filename,
            title: filename,
            size: bytes.length,
            ...extra,
          },
          cookie,
        )
      ).data;
      const response = await fetch(
        base + "/uploads/" + start.id + "/chunks/0",
        {
          method: "PUT",
          headers: {
            Origin: origin,
            "Content-Type": "application/octet-stream",
            "X-Worklog-Request": "1",
            Cookie: cookie,
          },
          body: bytes,
        },
      );
      assert.equal(response.status, 200);
      return (
        await api("/uploads/" + start.id + "/complete", "POST", {}, cookie)
      ).data;
    }
    const one = await upload("Fixture-task-doc-v1.txt", { task_id: task });
    const oneV2 = await upload("Fixture-task-doc-v2.txt", {
      document_id: one.document_id,
      base_version_id: one.version_id,
    });
    const two = await upload("Fixture-checklist-doc.txt");
    await api(
      "/projects/" + project.id + "/notes",
      "POST",
      { body: "TASK-MATERIAL-INTERNAL-BODY", task_id: task },
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
      acceptDownloads: true,
    });
    context.setDefaultTimeout(15000);
    const [cookieName, cookieValue] = cookie.split(/=(.*)/);
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: origin },
    ]);
    const page = await context.newPage(),
      errors = [],
      noteWrites = [],
      binaryRequests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        url.pathname === "/worklog/api/projects/" + project.id + "/notes"
      )
        noteWrites.push(request.postDataJSON());
    });
    // Chromium can stream native anchor downloads outside page request events.
    // Observe the isolated fixture server so forbidden original requests cannot escape counting.
    app.server.on("request", (request) => {
      const pathname = new URL(request.url, origin).pathname;
      if (/\/api\/documents\/[^/]+\/versions\/[^/]+\/download$/.test(pathname))
        binaryRequests.push(pathname);
    });
    const ready = await fetch(origin + "/worklog/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200);
    await ready.text();
    async function openTask() {
      await page.goto(
        origin + "/worklog/?project=" + project.id + "&module=records",
        { waitUntil: "domcontentloaded" },
      );
      await page.getByRole("button", { name: taskTitle, exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "任务详情",
        exact: true,
      });
      await dialog.waitFor();
      const materials = dialog.getByRole("region", {
        name: "相关资料",
        exact: true,
      });
      await materials
        .getByText("TASK-MATERIAL-INTERNAL-BODY", { exact: true })
        .waitFor();
      return { dialog, materials };
    }
    async function choose(dialog, documentId, versionId) {
      await dialog
        .getByRole("button", { name: "关联已有资料", exact: true })
        .click();
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            "/worklog/api/documents/" + documentId &&
          r.request().method() === "GET",
      );
      await dialog
        .getByLabel("选择已有资料", { exact: true })
        .selectOption(documentId);
      assert.equal((await response).status(), 200);
      await dialog
        .getByLabel("选择资料版本", { exact: true })
        .locator('option[value="' + versionId + '"]')
        .waitFor({ state: "attached" });
      await dialog
        .getByLabel("选择资料版本", { exact: true })
        .selectOption(versionId);
    }
    async function save(dialog) {
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            "/worklog/api/projects/" + project.id + "/notes" &&
          r.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      const result = await response;
      assert.equal(result.status(), 201, await result.text());
      await dialog.waitFor({ state: "hidden" });
      return (await result.json()).note;
    }
    let { dialog: taskDialog, materials } = await openTask();
    await materials
      .getByRole("button", { name: "记一条随手记", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "记一条随手记",
      exact: true,
    });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("TASK-ONE-SAVE-HISTORICAL");
    assert.equal(
      await dialog.getByLabel("关联任务（选填）", { exact: true }).inputValue(),
      task,
    );
    await choose(dialog, one.document_id, one.version_id);
    const taskNote = await save(dialog);
    assert.equal(taskNote.task_id, task);
    assert.equal(taskNote.files[0].version_id, one.version_id);
    assert.equal(noteWrites.length, 1);
    assert.deepEqual(noteWrites[0].attachments, [
      { document_id: one.document_id, version_id: one.version_id },
    ]);
    await materials
      .getByText("TASK-ONE-SAVE-HISTORICAL", { exact: true })
      .waitFor();
    await taskDialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page.goto(
      origin + "/worklog/?project=" + project.id + "&module=documents",
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByRole("button", {
        name: "随手记：Compatibility checklist fixture",
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await dialog
      .getByLabel("内容", { exact: true })
      .fill("CHECKLIST-ONE-SAVE-HISTORICAL");
    assert.equal(
      await dialog
        .getByLabel("关联资料项（选填）", { exact: true })
        .inputValue(),
      checklist.id,
    );
    await choose(dialog, two.document_id, two.version_id);
    const checklistNote = await save(dialog);
    assert.equal(checklistNote.deliverable_id, checklist.id);
    assert.equal(checklistNote.files[0].version_id, two.version_id);
    assert.equal(noteWrites.length, 2);
    assert.deepEqual(noteWrites[1].attachments, [
      { document_id: two.document_id, version_id: two.version_id },
    ]);
    assert.equal(
      (
        await api(
          "/projects/" + project.id + "/deliverables",
          "GET",
          undefined,
          cookie,
        )
      ).data.items.find((i) => i.id === checklist.id).note_count,
      1,
    );
    assert.deepEqual((await api("/state")).data.records, before);
    assert.equal(
      (await api("/documents/" + one.document_id, "GET", undefined, cookie))
        .data.document.current_version_id,
      oneV2.version_id,
    );
    ({ dialog: taskDialog, materials } = await openTask());
    const fresh = await upload("Fixture-task-doc-v3.txt", {
      document_id: one.document_id,
      base_version_id: oneV2.version_id,
    });
    const downloadPath =
      "/worklog/api/documents/" +
      one.document_id +
      "/versions/" +
      fresh.version_id +
      "/download";
    const native = page.waitForEvent("download");
    await materials
      .getByRole("button", {
        name: "下载：Fixture-task-doc-v1.txt",
        exact: true,
      })
      .click();
    const download = await native;
    assert.equal(new URL(download.url()).pathname, downloadPath);
    await download.cancel();
    assert.equal(binaryRequests.at(-1), downloadPath);
    app.db
      .prepare("UPDATE documents SET sensitive=1 WHERE id=?")
      .run(one.document_id);
    let binaryBefore = binaryRequests.length;
    let preflight = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/documents/" + one.document_id &&
        r.request().method() === "GET",
    );
    await materials
      .getByRole("button", {
        name: "下载：Fixture-task-doc-v1.txt",
        exact: true,
      })
      .click();
    assert.equal((await preflight).status(), 200);
    await materials.getByText(/受限|不可用/).waitFor();
    assert.equal(binaryRequests.length, binaryBefore);
    app.db
      .prepare("UPDATE documents SET sensitive=0 WHERE id=?")
      .run(one.document_id);
    ({ dialog: taskDialog, materials } = await openTask());
    app.db
      .prepare("UPDATE documents SET deleted=1 WHERE id=?")
      .run(one.document_id);
    binaryBefore = binaryRequests.length;
    preflight = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/documents/" + one.document_id &&
        r.request().method() === "GET",
    );
    await materials
      .getByRole("button", {
        name: "下载：Fixture-task-doc-v1.txt",
        exact: true,
      })
      .click();
    await preflight;
    await materials.getByText(/删除|不可用/).waitFor();
    assert.equal(binaryRequests.length, binaryBefore);
    app.db
      .prepare("UPDATE documents SET deleted=0 WHERE id=?")
      .run(one.document_id);
    // A successful slow preflight from a closed task must not download into the new task.
    ({ dialog: taskDialog, materials } = await openTask());
    binaryBefore = binaryRequests.length;
    const metadataPattern = "**/api/documents/" + one.document_id;
    let releaseClosed, sawClosed;
    const closedGate = new Promise((resolve) => {
      releaseClosed = resolve;
    });
    const closedStarted = new Promise((resolve) => {
      sawClosed = resolve;
    });
    await page.route(metadataPattern, async (route) => {
      const response = await route.fetch();
      sawClosed();
      await closedGate;
      await route.fulfill({ response });
    });
    await materials
      .getByRole("button", {
        name: "下载：Fixture-task-doc-v1.txt",
        exact: true,
      })
      .click();
    await closedStarted;
    await taskDialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: otherTaskTitle, exact: true })
      .click();
    const otherDialog = page.getByRole("dialog", {
      name: "任务详情",
      exact: true,
    });
    await otherDialog
      .getByRole("region", { name: "相关资料", exact: true })
      .getByText(/暂无关联的文件或随手记/)
      .waitFor();
    let slowResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/documents/" + one.document_id && r.status() === 200,
    );
    releaseClosed();
    await (await slowResponse).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(binaryRequests.length, binaryBefore);
    assert.ok(
      !(await otherDialog.innerText()).includes("TASK-MATERIAL-INTERNAL-BODY"),
    );
    await page.unroute(metadataPattern);
    // Invalidate both kinds of download entry, including another preflight already returning 200.
    for (const firstEntry of ["primary", "attachment"]) {
      ({ dialog: taskDialog, materials } = await openTask());
      binaryBefore = binaryRequests.length;
      let releaseExpired,
        sawExpired,
        attempts = 0;
      const expiredGate = new Promise((resolve) => {
        releaseExpired = resolve;
      });
      const expiredStarted = new Promise((resolve) => {
        sawExpired = resolve;
      });
      await page.route(metadataPattern, async (route) => {
        attempts++;
        if (attempts === 1) {
          const response = await route.fetch();
          sawExpired();
          await expiredGate;
          await route.fulfill({ response });
        } else
          await route.fulfill({
            status: 401,
            json: { error: "Fixture expired session" },
          });
      });
      const primary = materials.getByRole("button", {
        name: "下载：Fixture-task-doc-v1.txt",
        exact: true,
      });
      const attachment = materials
        .locator("li")
        .filter({
          has: page.getByText("TASK-ONE-SAVE-HISTORICAL", { exact: true }),
        })
        .getByRole("button", { name: "Fixture-task-doc-v1.txt", exact: true });
      await (firstEntry === "primary" ? primary : attachment).click();
      await expiredStarted;
      const expiredResponse = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            "/worklog/api/documents/" + one.document_id && r.status() === 401,
      );
      await (firstEntry === "primary" ? attachment : primary).click();
      await expiredResponse;
      await materials
        .getByText("TASK-MATERIAL-INTERNAL-BODY", { exact: true })
        .waitFor({ state: "hidden" });
      await materials
        .getByText("TASK-ONE-SAVE-HISTORICAL", { exact: true })
        .waitFor({ state: "hidden" });
      await materials.getByText(/登录.*失效|重新登录/).waitFor();
      assert.equal(await primary.count(), 0);
      slowResponse = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            "/worklog/api/documents/" + one.document_id && r.status() === 200,
      );
      releaseExpired();
      await (await slowResponse).finished();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        binaryRequests.length,
        binaryBefore,
        firstEntry + " preflight survived session expiry",
      );
      await page.unroute(metadataPattern);
    }
    const allNotes = (
      await api("/projects/" + project.id + "/notes", "GET", undefined, cookie)
    ).data.notes;
    assert.equal(allNotes.length, 3);
    assert.equal(noteWrites.length, 2);
    assert.deepEqual((await api("/state")).data.records, before);
    assert.equal(
      (await api("/documents/" + one.document_id, "GET", undefined, cookie))
        .data.document.current_version_id,
      fresh.version_id,
    );
    assert.deepEqual(errors, []);
    console.log("Task materials compatibility review passed");
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    assert.ok(
      path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
