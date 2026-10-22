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
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-new-note-files-"),
  );
  const origin = "http://127.0.0.1:8816",
    base = origin + "/worklog/api";
  let app, browser;
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Temporary-note-files-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8816, "127.0.0.1", r));
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
    const admin = await api("/login", "POST", {
      login: "admin",
      password: "Temporary-note-files-123",
    });
    const project = (await api("/state")).data.projects[0];
    const recordsBefore = (await api("/state")).data.records;
    async function upload(filename, content, extra = {}) {
      const bytes = Buffer.from(content),
        u = (
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
            admin.cookie,
          )
        ).data;
      const r = await fetch(base + "/uploads/" + u.id + "/chunks/0", {
        method: "PUT",
        headers: {
          Origin: origin,
          "X-Worklog-Request": "1",
          Cookie: admin.cookie,
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
      });
      assert.equal(r.status, 200);
      return (
        await api("/uploads/" + u.id + "/complete", "POST", {}, admin.cookie)
      ).data;
    }
    const one = await upload(
        "Existing-one-v1.txt",
        "Synthetic historical file",
      ),
      two = await upload("Existing-two.txt", "Synthetic second file"),
      removed = await upload("Existing-removed.txt", "Synthetic removed file");
    const oneV2 = await upload(
      "Existing-one-v2.txt",
      "Synthetic current file",
      { document_id: one.document_id, base_version_id: one.version_id },
    );
    const notes = async () =>
      (
        await api(
          "/projects/" + project.id + "/notes",
          "GET",
          undefined,
          admin.cookie,
        )
      ).data.notes;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [],
      writes = [];
    context.setDefaultTimeout(15000);
    const [name, value] = admin.cookie.split(/=(.*)/);
    await context.addCookies([{ name, value, url: origin }]);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (
        ["POST", "PATCH", "DELETE"].includes(r.method()) &&
        new URL(r.url()).pathname.startsWith("/worklog/api/")
      )
        writes.push({
          path: new URL(r.url()).pathname,
          method: r.method(),
          body: r.postDataJSON(),
        });
    });
    const ready = await fetch(origin + "/worklog/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200);
    await ready.text();
    await page.goto(origin + "/worklog/?module=notes&project=" + project.id);
    const log = page.getByRole("region", { name: "随手记", exact: true });
    async function newDialog(body) {
      await log.getByRole("button", { name: "记一条", exact: true }).click();
      const d = page.getByRole("dialog", { name: "记一条随手记", exact: true });
      await d.getByLabel("内容", { exact: true }).fill(body);
      await d
        .getByRole("button", { name: "关联已有资料", exact: true })
        .click();
      await d.getByLabel("选择已有资料", { exact: true }).waitFor();
      return d;
    }
    async function choose(d, documentId, versionId) {
      const response = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            "/worklog/api/documents/" + documentId &&
          r.request().method() === "GET",
      );
      await d
        .getByLabel("选择已有资料", { exact: true })
        .selectOption(documentId);
      assert.equal((await response).status(), 200);
      await d
        .getByLabel("选择资料版本", { exact: true })
        .locator('option[value="' + versionId + '"]')
        .waitFor({ state: "attached" });
      await d
        .getByLabel("选择资料版本", { exact: true })
        .selectOption(versionId);
    }
    let d = await newDialog("Canceled correspondence");
    await choose(d, one.document_id, one.version_id);
    await d.getByRole("button", { name: "再选一份资料", exact: true }).click();
    await d.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await notes()).length, 0);
    assert.equal(writes.length, 0);
    d = await newDialog("ONE-SAVE-EXISTING-FILES");
    await d.getByRole("button", { name: "文件收发", exact: true }).click();
    await d.getByLabel("收发方向", { exact: true }).selectOption("sent");
    await d
      .getByLabel("接收方（选填）", { exact: true })
      .fill("Fixture recipient");
    await choose(d, one.document_id, one.version_id);
    await d.getByRole("button", { name: "再选一份资料", exact: true }).click();
    await d.getByLabel("待关联资料", { exact: true }).getByText(/V1/).waitFor();
    await choose(d, two.document_id, two.version_id);
    // A new current upload after choosing an older version must never retarget it.
    const oneV3 = await upload("Existing-one-v3.txt", "Synthetic newer file", {
      document_id: one.document_id,
      base_version_id: oneV2.version_id,
    });
    const createResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/projects/" + project.id + "/notes" &&
        r.request().method() === "POST",
    );
    await d.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await createResponse).status(), 201);
    await d.waitFor({ state: "hidden" });
    let list = await notes();
    assert.equal(list.length, 1);
    const n = list[0];
    assert.deepEqual(
      n.files.map((f) => f.version_id).sort(),
      [one.version_id, two.version_id].sort(),
    );
    const posts = writes.filter(
      (w) => w.method === "POST" && w.path.endsWith("/notes"),
    );
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.attachments.length, 2);
    assert.equal(
      writes.filter((w) => /\/notes\/[^/]+\/files/.test(w.path)).length,
      0,
    );
    const row = log.locator('[data-note-id="' + n.id + '"]');
    await row.getByText("当时 V1", { exact: true }).first().waitFor();
    const downloading = page.waitForEvent("download");
    await row
      .getByTitle("下载当时版本：Existing-one-v1.txt", { exact: true })
      .click();
    const download = await downloading;
    assert.equal(
      await fs.readFile(await download.path(), "utf8"),
      "Synthetic historical file",
    );
    assert.equal(
      (
        await api(
          "/documents/" + one.document_id,
          "GET",
          undefined,
          admin.cookie,
        )
      ).data.document.current_version_id,
      oneV3.version_id,
    );
    // Staged attachments on edits also wait for Save; Cancel discards them.
    await row.getByRole("button", { name: /^编辑随手记：/ }).click();
    d = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await d.getByRole("button", { name: "关联已有资料", exact: true }).click();
    await choose(d, removed.document_id, removed.version_id);
    await d.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await notes())[0].files.length, 2);
    // Unavailable choices cause atomic failure while retaining the complete draft.
    d = await newDialog("RETAINED-FAILED-DRAFT");
    await choose(d, removed.document_id, removed.version_id);
    const doc = (
      await api(
        "/documents/" + removed.document_id,
        "GET",
        undefined,
        admin.cookie,
      )
    ).data.document;
    await api(
      "/documents/" + doc.id,
      "DELETE",
      { version: doc.version },
      admin.cookie,
    );
    const failure = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/projects/" + project.id + "/notes" &&
        r.request().method() === "POST",
    );
    await d.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await failure).status(), 400);
    await d.getByRole("alert").waitFor();
    assert.equal(
      await d.getByLabel("内容", { exact: true }).inputValue(),
      "RETAINED-FAILED-DRAFT",
    );
    assert.equal((await notes()).length, 1);
    await d.getByLabel("选择已有资料", { exact: true }).selectOption("");
    await choose(d, two.document_id, two.version_id);
    await d.getByRole("button", { name: "保存", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    list = await notes();
    assert.equal(list.length, 2);
    assert.equal(
      list.find((n) => n.body === "RETAINED-FAILED-DRAFT").files.length,
      1,
    );
    // Choosing a document is read-only and session failure clears its private draft.
    await page.setViewportSize({ width: 390, height: 844 });
    d = await newDialog("PRIVATE-EXISTING-DRAFT");
    await choose(d, one.document_id, one.version_id);
    assert.ok(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    await api("/logout", "POST", {}, admin.cookie);
    await d
      .getByLabel("选择已有资料", { exact: true })
      .selectOption(two.document_id);
    await d.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByText("PRIVATE-EXISTING-DRAFT", { exact: true }).count(),
      0,
    );
    assert.deepEqual((await api("/state")).data.records, recordsBefore);
    assert.deepEqual(errors, []);
    console.log(
      "New note existing-file browser passed: direct explicit historical versions, multiple files in one create, no premature writes, cancel, atomic stale-file failure and retry, exact pinned download, edit draft cancellation, 401 cleanup, mobile, and unchanged completion.",
    );
  } finally {
    await browser?.close();
    if (app) {
      await new Promise((r) => {
        app.server.close(r);
        app.server.closeAllConnections();
      });
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
