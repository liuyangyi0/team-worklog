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
    path.join(os.tmpdir(), "worklog-replay-integration-"),
  );
  const origin = "http://127.0.0.1:8818",
    base = origin + "/worklog/api";
  let app, browser;
  async function start() {
    app = await createApp({
      dataDir,
      filesDir: path.join(dataDir, "files"),
      vaultKey: "ce".repeat(32),
      origin,
      adminPassword: "Temporary-replay-integration-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8818, "127.0.0.1", r));
  }
  async function stop() {
    const closing = app.close();
    app.server.closeAllConnections();
    await closing;
    app = null;
  }
  try {
    await start();
    async function api(route, method = "GET", body, cookie = "") {
      const r = await fetch(base + route, {
        method,
        headers: {
          Origin: origin,
          "X-Worklog-Request": "1",
          "Content-Type": "application/json",
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
      password: "Temporary-replay-integration-123",
    });
    const project = (await api("/state")).data.projects[0];
    async function upload(filename, content) {
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
    const old = await upload("Replay-original.txt", "Synthetic original"),
      extra = await upload("Replay-extra.txt", "Synthetic extra");
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
      posts = [];
    context.setDefaultTimeout(15000);
    const [name, value] = admin.cookie.split(/=(.*)/);
    await context.addCookies([{ name, value, url: origin }]);
    page.on("pageerror", (e) => errors.push(e.message));
    let corrupt = true;
    await page.route(
      "**/api/projects/" + project.id + "/notes",
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts.push(route.request().postDataJSON());
        if (corrupt) {
          corrupt = false;
          const r = await route.fetch();
          assert.equal(r.status(), 201);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "invalid-json-after-real-commit",
          });
        } else await route.continue();
      },
    );
    const ready = await fetch(origin + "/worklog/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200);
    await ready.text();
    await page.goto(origin + "/worklog/?module=notes&project=" + project.id);
    await page
      .getByRole("region", { name: "随手记", exact: true })
      .getByRole("button", { name: "记一条", exact: true })
      .click();
    let d = page.getByRole("dialog", { name: "记一条随手记", exact: true });
    await d
      .getByLabel("内容", { exact: true })
      .fill("Original unconfirmed creation");
    await d.getByRole("button", { name: "关联已有资料", exact: true }).click();
    async function choose(documentId, versionId) {
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
    await choose(old.document_id, old.version_id);
    await d.getByRole("button", { name: "保存", exact: true }).click();
    await d.getByRole("alert").waitFor();
    const committed = (await notes())[0];
    assert.equal((await notes()).length, 1);
    assert.ok(posts[0].client_request_id);
    const foreign = await api(
      "/notes/" + committed.id,
      "PATCH",
      { version: committed.version, body: "Content saved in another session" },
      admin.cookie,
    );
    const oldDoc = (
      await api("/documents/" + old.document_id, "GET", undefined, admin.cookie)
    ).data.document;
    await api(
      "/documents/" + oldDoc.id,
      "DELETE",
      { version: oldDoc.version },
      admin.cookie,
    );
    // Persisted receipts must survive a server restart, not only in-memory deduplication.
    await stop();
    await start();
    await d
      .getByLabel("内容", { exact: true })
      .fill("Locally revised unconfirmed draft");
    await d.getByLabel("选择已有资料", { exact: true }).selectOption("");
    await choose(extra.document_id, extra.version_id);
    const replayResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          "/worklog/api/projects/" + project.id + "/notes" &&
        r.request().method() === "POST",
    );
    await d.getByRole("button", { name: "保存", exact: true }).click();
    const replay = await replayResponse;
    assert.ok(replay.ok());
    const data = await replay.json();
    assert.equal(data.replayed, true);
    assert.equal(data.creation_version, 1);
    assert.equal(data.note.id, committed.id);
    assert.equal(data.note.version, foreign.data.note.version);
    d = page.getByRole("dialog", { name: "编辑随手记", exact: true });
    await d.getByRole("alert").waitFor();
    assert.equal(
      await d.getByLabel("内容", { exact: true }).inputValue(),
      "Locally revised unconfirmed draft",
    );
    assert.deepEqual(posts[1], posts[0]);
    assert.equal((await notes()).length, 1);
    assert.equal((await notes())[0].body, "Content saved in another session");
    assert.deepEqual(
      (await notes())[0].files.map((f) => f.version_id),
      [old.version_id],
    );
    const conflict = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/worklog/api/notes/" + committed.id &&
        r.request().method() === "PATCH",
    );
    await d.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await conflict).status(), 409);
    await d.getByRole("alert").waitFor();
    assert.equal((await notes())[0].body, "Content saved in another session");
    assert.equal((await notes())[0].files.length, 1);
    await d.getByRole("button", { name: "完成", exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(
      "Replay integration browser passed: malformed committed response, durable restart recovery after file deletion, same original request replay, retained revised draft, original creation CAS and no overwrite or duplicate associations.",
    );
  } finally {
    await browser?.close();
    if (app) await stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
