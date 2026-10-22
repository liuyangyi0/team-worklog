const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
(async () => {
  const { createApp } = await import(pathToFileURL(path.resolve(__dirname, "../server.mjs")).href);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-file-exchange-routing-"));
  const origin = "http://127.0.0.1:8815", base = origin + "/worklog/api";
  let app, browser;
  try {
    app = await createApp({ dataDir, origin, adminPassword: "Temporary-exchange-routing-123", dist: path.resolve(__dirname, "../dist") });
    await new Promise(r => app.server.listen(8815, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const r = await fetch(base + route, { method, headers: { Origin: origin, "Content-Type": "application/json", "X-Worklog-Request": "1", Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await r.json(); assert.ok(r.ok, JSON.stringify(data));
      return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] || "" };
    }
    const admin = await api("/login", "POST", { login: "admin", password: "Temporary-exchange-routing-123" });
    const p1 = (await api("/state")).data.projects[0];
    const p2 = { id: (await api("/projects", "POST", { name: "收发追溯乙" }, admin.cookie)).data.id };
    for (const row of [ { task: "Actual-only", actual: "Fixture member", date: "" }, { task: "Date-only", actual: "", date: "2001-01-01" }, { task: "Pending", actual: "", date: "" } ])
      await api("/records", "POST", { project_id: p2.id, owner: "Fixture owner", ...row }, admin.cookie);
    const recordsBefore = (await api("/state")).data.records;
    async function upload(filename, content, extra = {}) {
      const bytes = Buffer.from(content);
      const u = (await api("/uploads", "POST", { project_id: p2.id, filename, size: bytes.length, ...extra }, admin.cookie)).data;
      const r = await fetch(base + "/uploads/" + u.id + "/chunks/0", { method: "PUT", headers: { Origin: origin, "Content-Type": "application/octet-stream", "X-Worklog-Request": "1", Cookie: admin.cookie }, body: bytes });
      assert.equal(r.status, 200);
      return (await api("/uploads/" + u.id + "/complete", "POST", {}, admin.cookie)).data;
    }
    const v1 = await upload("ExchangeSource-v1.txt", "Synthetic received version", { title: "收发共同资料" });
    async function note(body, fields = {}, projectId = p2.id) {
      return (await api("/projects/" + projectId + "/notes", "POST", { kind: "file", body, ...fields }, admin.cookie)).data.note;
    }
    const root = await note("EXCHANGE-RECEIVED-ROOT", { file_direction: "received", counterparty: "PRIVATE-SOURCE-PARTY", occurred_on: "2001-01-01", exchange_time: "09:15", channel: "PRIVATE-MAIL-CHANNEL" });
    await api("/notes/" + root.id + "/files", "POST", { document_id: v1.document_id, version_id: v1.version_id }, admin.cookie);
    const v2 = await upload("ExchangeSent-v2.txt", "Synthetic sent version", { document_id: v1.document_id, base_version_id: v1.version_id });
    const sent = await note("EXCHANGE-SENT-SUPPLEMENT", { parent_note_id: root.id, file_direction: "sent", counterparty: "PRIVATE-DEST-PARTY", occurred_on: "2001-01-02", exchange_time: "14:35", channel: "PRIVATE-ONSITE-CHANNEL" });
    await api("/notes/" + sent.id + "/files", "POST", { document_id: v2.document_id, version_id: v2.version_id }, admin.cookie);
    await note("EXCHANGE-LEGACY-UNKNOWN");
    await note("EXCHANGE-OTHER-PROJECT", { file_direction: "received", counterparty: "OTHER-PARTY" }, p1.id);
    await note("EXCHANGE-NONFILE", { kind: "verbal", occurred_on: "2001-01-03" });
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const ready = await fetch(origin + "/worklog/", { signal: AbortSignal.timeout(5000) });
    assert.equal(ready.status, 200); assert.ok((await ready.text()).includes("/worklog/assets/"));
    await page.goto(origin + "/worklog/?view=archive");
    await page.getByRole("heading", { name: "登录后查看项目档案", exact: true }).waitFor();
    assert.equal(await page.getByText("PRIVATE-SOURCE-PARTY", { exact: true }).count(), 0);
    async function login() {
      await page.locator("main").getByRole("button", { name: "登录 / 注册", exact: true }).click();
      const auth = page.getByRole("dialog", { name: "欢迎来到项目工作台" });
      await auth.locator('input[name="login"]').fill("admin");
      await auth.locator('input[name="password"]').fill("Temporary-exchange-routing-123");
      await auth.getByRole("button", { name: "登录", exact: true }).last().click();
      await auth.waitFor({ state: "hidden" });
    }
    await login();
    async function archiveAction(action, expectedParams) {
      const response = page.waitForResponse(r => {
        const u = new URL(r.url());
        return u.pathname === "/worklog/api/project-archive" && Object.entries(expectedParams).every(([k, v]) => u.searchParams.get(k) === v);
      });
      await action(); const r = await response; assert.equal(r.status(), 200); const data = await r.json();
      await page.waitForFunction(({ titles, total }) => {
        const section = document.querySelector('section[aria-label="项目档案"]');
        if (!section || !section.textContent.includes("共 " + total + " 项")) return false;
        return JSON.stringify([...section.querySelectorAll("article h2")].map(h => h.textContent)) === JSON.stringify(titles);
      }, { titles: data.items.map(i => i.title), total: data.total });
      return data;
    }
    async function query(expected) { return archiveAction(() => page.getByRole("button", { name: "查询档案", exact: true }).click(), expected); }
    await page.getByLabel("项目范围", { exact: true }).selectOption(p2.id);
    await page.getByLabel("文件收发", { exact: true }).selectOption("received");
    assert.equal(await page.getByLabel("来源类型", { exact: true }).inputValue(), "note");
    let result = await query({ project_id: p2.id, mode: "search", kind: "note", file_direction: "received" });
    assert.deepEqual(result.items.map(i => i.entity_id), [root.id]);
    let receivedArticle = page.getByRole("article").filter({ has: page.getByRole("heading", { name: root.body, exact: true }) });
    await receivedArticle.getByLabel("文件收发信息", { exact: true }).getByText("提供方：PRIVATE-SOURCE-PARTY", { exact: true }).waitFor();
    await receivedArticle.getByText("收到时间：2001-01-01 09:15（北京时间）", { exact: true }).waitFor();
    await receivedArticle.getByText("渠道：PRIVATE-MAIL-CHANNEL", { exact: true }).waitFor();
    await page.getByLabel("文件收发", { exact: true }).selectOption("sent");
    result = await query({ file_direction: "sent", mode: "search" });
    assert.deepEqual(result.items.map(i => i.entity_id), [sent.id]);
    result = await archiveAction(() => page.getByRole("tab", { name: "大事记", exact: true }).click(), { mode: "timeline", file_direction: "sent" });
    assert.deepEqual(result.items.map(i => i.entity_id), [sent.id]);
    await page.getByRole("article").getByText("接收方：PRIVATE-DEST-PARTY", { exact: true }).waitFor();
    await page.getByLabel("文件收发", { exact: true }).selectOption("unclassified");
    result = await query({ mode: "timeline", file_direction: "unclassified" });
    assert.equal(result.total, 1); assert.equal(result.items[0].occurred_on, "");
    await page.getByRole("article").getByText("业务时间：未记录", { exact: true }).waitFor();
    await page.getByRole("article").getByText("发生日：未记录", { exact: true }).waitFor();
    await page.getByLabel("来源类型", { exact: true }).selectOption("document");
    assert.equal(await page.getByLabel("文件收发", { exact: true }).inputValue(), "");
    await page.getByLabel("文件收发", { exact: true }).selectOption("received");
    await page.getByLabel("项目范围", { exact: true }).selectOption("");
    await page.getByLabel("查档关键词", { exact: true }).fill("PRIVATE-MAIL-CHANNEL");
    result = await archiveAction(() => page.getByRole("tab", { name: "统一查档", exact: true }).click(), { mode: "search", project_id: "", q: "PRIVATE-MAIL-CHANNEL", file_direction: "received" });
    assert.deepEqual(result.items.map(i => i.entity_id), [root.id]);
    await page.getByLabel("查档关键词", { exact: true }).fill("PRIVATE-SOURCE-PARTY");
    result = await query({ q: "PRIVATE-SOURCE-PARTY" });
    assert.deepEqual(result.items.map(i => i.entity_id), [root.id]);
    await page.getByLabel("查档关键词", { exact: true }).fill("ExchangeSource-v1.txt");
    result = await query({ q: "ExchangeSource-v1.txt" });
    assert.deepEqual(result.items.map(i => i.entity_id), [root.id]);
    await page.getByRole("button", { name: "打开原始内容：" + root.body, exact: true }).click();
    const thread = page.getByRole("dialog", { name: "事项详情", exact: true });
    await thread.getByText(sent.body, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), p2.id);
    await thread.getByTitle("下载当时版本：ExchangeSource-v1.txt", { exact: true }).waitFor();
    await thread.getByTitle("下载当时版本：ExchangeSent-v2.txt", { exact: true }).waitFor();
    const rrow = thread.locator('[data-thread-note-id="' + root.id + '"]'), srow = thread.locator('[data-thread-note-id="' + sent.id + '"]');
    await rrow.getByText("提供方：PRIVATE-SOURCE-PARTY", { exact: true }).waitFor();
    await srow.getByText("接收方：PRIVATE-DEST-PARTY", { exact: true }).waitFor();
    const beforeDownload = page.waitForEvent("download");
    await rrow.getByTitle("下载当时版本：ExchangeSource-v1.txt", { exact: true }).click();
    const download = await beforeDownload;
    assert.equal(download.suggestedFilename(), "ExchangeSource-v1.txt");
    assert.equal(await fs.readFile(await download.path(), "utf8"), "Synthetic received version");
    assert.equal((await api("/documents/" + v1.document_id, "GET", undefined, admin.cookie)).data.document.current_version_id, v2.version_id);
    await thread.getByRole("button", { name: "关闭", exact: true }).first().click();
    await page.locator("aside").getByRole("button", { name: "统一查档", exact: true }).click();
    await page.getByLabel("查档关键词", { exact: true }).fill("PRIVATE-SOURCE-PARTY");
    await query({ q: "PRIVATE-SOURCE-PARTY" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const session = (await context.cookies(origin + "/worklog/")).find(c => c.name === "worklog_session");
    await api("/logout", "POST", {}, session.name + "=" + session.value);
    const unauthorized = page.waitForResponse(r => new URL(r.url()).pathname === "/worklog/api/project-archive" && r.status() === 401);
    await page.getByRole("button", { name: "刷新项目档案", exact: true }).click(); await unauthorized;
    await page.getByRole("heading", { name: "登录后查看项目档案", exact: true }).waitFor();
    assert.equal(await page.getByText("提供方：PRIVATE-SOURCE-PARTY", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("查档关键词", { exact: true }).count(), 0);
    await login();
    await page.getByLabel("查档关键词", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("查档关键词", { exact: true }).inputValue(), "");
    assert.deepEqual((await api("/state")).data.records, recordsBefore);
    const publicState = JSON.stringify((await api("/state")).data);
    for (const secret of ["PRIVATE-SOURCE-PARTY", "PRIVATE-DEST-PARTY", "PRIVATE-MAIL-CHANNEL", "Synthetic received version", "EXCHANGE-RECEIVED-ROOT"]) assert.ok(!publicState.includes(secret));
    assert.deepEqual(errors, []);
    console.log("File exchange integration browser passed: bidirectional archive filters, business-time provenance, party/channel and fixed-filename search, continuous matter links, exact V1 download after V2 upload, session cleanup, mobile, and unchanged task completion.");
  } finally {
    await browser?.close();
    if (app) { await new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }); app.db.close(); }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
