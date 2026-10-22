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
    path.join(os.tmpdir(), "worklog-archive-routing-"),
  );
  const origin = "http://127.0.0.1:8813",
    base = origin + "/worklog/api";
  let app, browser;
  try {
    app = await createApp({
      dataDir,
      origin,
      adminPassword: "Temporary-archive-routing-123",
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8813, "127.0.0.1", r));
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
      password: "Temporary-archive-routing-123",
    });
    const p1 = (await api("/state")).data.projects[0];
    const p2 = {
      id: (await api("/projects", "POST", { name: "档案导航乙" }, admin.cookie))
        .data.id,
      name: "档案导航乙",
    };
    for (const row of [
      { task: "Actual-only", actual: "Fixture member", date: "" },
      { task: "Date-only", actual: "", date: "2001-01-01" },
      { task: "Pending", actual: "", date: "" },
    ])
      await api(
        "/records",
        "POST",
        { project_id: p2.id, owner: "Fixture owner", ...row },
        admin.cookie,
      );
    const recordsBefore = (await api("/state")).data.records;
    async function upload(filename, content, extra = {}) {
      const bytes = Buffer.from(content),
        u = (
          await api(
            "/uploads",
            "POST",
            { project_id: p2.id, filename, size: bytes.length, ...extra },
            admin.cookie,
          )
        ).data;
      const r = await fetch(base + "/uploads/" + u.id + "/chunks/0", {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: admin.cookie,
        },
        body: bytes,
      });
      assert.equal(r.status, 200);
      return (
        await api("/uploads/" + u.id + "/complete", "POST", {}, admin.cookie)
      ).data;
    }
    const v1 = await upload("ArchiveOriginal-v1.txt", "Synthetic version one", {
      title: "版本追溯资料",
      source_path: "handover-original/trace.txt",
    });
    const root = (
      await api(
        "/projects/" + p2.id + "/notes",
        "POST",
        { body: "PRIVATE-ARCHIVE-ROOT", occurred_on: "2001-01-01" },
        admin.cookie,
      )
    ).data.note;
    await api(
      "/notes/" + root.id + "/files",
      "POST",
      { document_id: v1.document_id },
      admin.cookie,
    );
    const supplement = (
      await api(
        "/projects/" + p2.id + "/notes",
        "POST",
        {
          body: "PRIVATE-ARCHIVE-SUPPLEMENT",
          parent_note_id: root.id,
          occurred_on: "2001-01-02",
        },
        admin.cookie,
      )
    ).data.note;
    const v2 = await upload("ArchiveNew-v2.txt", "Synthetic version two", {
      document_id: v1.document_id,
      base_version_id: v1.version_id,
    });
    const doc = (
      await api("/documents/" + v1.document_id, "GET", undefined, admin.cookie)
    ).data.document;
    await api(
      "/documents/" + doc.id + "/publish",
      "POST",
      { version: doc.version, version_id: v1.version_id },
      admin.cookie,
    );
    const release = (
      await api(
        "/projects/" + p2.id + "/releases",
        "POST",
        {
          name: "档案定位交付",
          items: [{ document_id: doc.id, version_id: v1.version_id }],
        },
        admin.cookie,
      )
    ).data;
    const milestone = (
      await api(
        "/projects/" + p2.id + "/milestones",
        "POST",
        {
          title: "现场已确认节点",
          status: "achieved",
          actual_date: "2001-01-03",
        },
        admin.cookie,
      )
    ).data.milestone;
    const timeline = (
      await api(
        "/project-archive?mode=timeline&project_id=" + p2.id,
        "GET",
        undefined,
        admin.cookie,
      )
    ).data;
    assert.ok(
      timeline.items.some(
        (i) => i.entity_id === milestone.id && i.occurred_on === "2001-01-03",
      ),
    );
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
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const ready = await fetch(origin + "/worklog/", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ready.status, 200);
    assert.ok((await ready.text()).includes("/worklog/assets/"));
    await page.goto(origin + "/worklog/?view=archive");
    await page
      .getByRole("heading", { name: "登录后查看项目档案", exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("PRIVATE-ARCHIVE-ROOT", { exact: true }).count(),
      0,
    );
    await page
      .locator("main")
      .getByRole("button", { name: "登录 / 注册", exact: true })
      .click();
    async function loginInDialog() {
      const auth = page.getByRole("dialog", { name: "欢迎来到项目工作台" });
      await auth.locator('input[name="login"]').fill("admin");
      await auth
        .locator('input[name="password"]')
        .fill("Temporary-archive-routing-123");
      await auth
        .getByRole("button", { name: "登录", exact: true })
        .last()
        .click();
      await auth.waitFor({ state: "hidden" });
    }
    await loginInDialog();
    async function search(q) {
      await page.getByLabel("查档关键词", { exact: true }).fill(q);
      await page.getByRole("button", { name: "查询档案", exact: true }).click();
    }
    await search("PRIVATE-ARCHIVE-ROOT");
    await page
      .getByRole("button", {
        name: "打开原始内容：PRIVATE-ARCHIVE-ROOT",
        exact: true,
      })
      .click();
    let thread = page.getByRole("dialog", { name: "事项详情", exact: true });
    await thread
      .getByText("PRIVATE-ARCHIVE-SUPPLEMENT", { exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), p2.id);
    assert.equal(new URL(page.url()).searchParams.get("note"), root.id);
    await thread
      .getByTitle("下载当时版本：ArchiveOriginal-v1.txt", { exact: true })
      .waitFor();
    await thread
      .getByRole("button", { name: "补充一条", exact: true })
      .last()
      .click();
    const composer = page.getByRole("dialog", {
      name: "补充一条",
      exact: true,
    });
    await composer.locator("textarea").fill("集成界面追加的事项事实");
    await composer.getByRole("button", { name: "保存", exact: true }).click();
    await composer.waitFor({ state: "hidden" });
    await thread.getByText("集成界面追加的事项事实", { exact: true }).waitFor();
    const added = (
      await api("/notes/" + root.id + "/thread", "GET", undefined, admin.cookie)
    ).data.notes.find((n) => n.body === "集成界面追加的事项事实");
    assert.equal(added.parent_note_id, root.id);
    await thread.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("navigation", { name: "项目模块", exact: true })
      .getByRole("button", { name: "项目大事记", exact: true })
      .click();
    assert.equal(new URL(page.url()).searchParams.has("note"), false);
    await page
      .getByRole("heading", { name: "项目大事记", exact: true })
      .waitFor();
    await page.getByRole("tab", { name: "统一查档", exact: true }).click();
    await search("ArchiveOriginal-v1.txt");
    await page
      .getByRole("article")
      .filter({ hasText: "文件：ArchiveOriginal-v1.txt" })
      .getByRole("button", { name: "打开原始内容：版本追溯资料", exact: true })
      .click();
    let detail = page.getByRole("dialog", {
      name: "版本追溯资料",
      exact: true,
    });
    await detail
      .getByLabel("查档定位版本", { exact: true })
      .getByText("本次定位：V1 · ArchiveOriginal-v1.txt", { exact: true })
      .waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get("version"),
      v1.version_id,
    );
    assert.equal(
      (await api("/documents/" + doc.id, "GET", undefined, admin.cookie)).data
        .document.current_version_id,
      v2.version_id,
    );
    const session = (await context.cookies(origin + "/worklog/")).find(
      (c) => c.name === "worklog_session",
    );
    await api("/logout", "POST", {}, session.name + "=" + session.value);
    await detail
      .getByRole("button", { name: "下载此版本", exact: true })
      .click();
    await detail.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "登录后查看项目资料", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("查档定位版本", { exact: true }).count(),
      0,
    );
    await page
      .locator("main")
      .getByRole("button", { name: "登录 / 注册", exact: true })
      .click();
    await loginInDialog();
    detail = page.getByRole("dialog", { name: "版本追溯资料", exact: true });
    await detail.getByLabel("查档定位版本", { exact: true }).waitFor();
    await detail
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page
      .locator("aside")
      .getByRole("button", { name: "统一查档", exact: true })
      .click();
    await search("档案定位交付");
    await page
      .getByRole("button", { name: "打开原始内容：档案定位交付", exact: true })
      .click();
    detail = page.getByRole("dialog", { name: "交付归档", exact: true });
    await detail
      .getByLabel("查档定位归档", { exact: true })
      .getByText("档案定位交付", { exact: true })
      .waitFor();
    await detail
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page
      .getByRole("navigation", { name: "项目", exact: true })
      .getByRole("button", { name: p1.name, exact: true })
      .click();
    const params = new URL(page.url()).searchParams;
    for (const key of ["note", "version", "release", "document", "view"])
      assert.equal(params.has(key), false, key + " stale");
    // Wrong-project note links never render private content in the wrong project context.
    await page.goto(
      origin +
        "/worklog/?module=notes&project=" +
        p1.id +
        "&note=" +
        supplement.id,
    );
    thread = page.getByRole("dialog", { name: "事项详情", exact: true });
    await thread.getByText(/不属于当前项目/).waitFor();
    assert.equal(
      await thread
        .getByText("PRIVATE-ARCHIVE-SUPPLEMENT", { exact: true })
        .count(),
      0,
    );
    await thread.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .locator("aside")
      .getByRole("button", { name: "统一查档", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("heading", { name: "统一查档", exact: true })
      .waitFor();
    assert.ok(
      await page
        .locator("main")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
    assert.deepEqual((await api("/state")).data.records, recordsBefore);
    const pub = JSON.stringify((await api("/state")).data);
    assert.ok(!pub.includes("PRIVATE-ARCHIVE-"));
    assert.deepEqual(errors, []);
    console.log(
      "Archive integration browser passed: private login, cross-project matter links, supplement composer, historical-version and release navigation, date provenance, unchanged completion and mobile.",
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
