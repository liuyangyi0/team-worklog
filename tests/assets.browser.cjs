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
  const { REGISTRATION_NAMES } = await import(
    pathToFileURL(path.resolve(__dirname, "../registration.mjs")).href
  );
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-assets-browser-"),
  );
  const artifacts =
    process.env.WORKLOG_ARTIFACTS_DIR ||
    path.join(os.tmpdir(), "worklog-assets-proof");
  await fs.mkdir(artifacts, { recursive: true });
  const origin = "http://127.0.0.1:8791";
  let app, browser, page;
  try {
    app = await createApp({
      dataDir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((r) => app.server.listen(8791, "127.0.0.1", r));
    async function api(route, method = "GET", body, cookie = "") {
      const res = await fetch(origin + "/worklog/api" + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return { data, cookie: res.headers.get("set-cookie")?.split(";")[0] };
    }
    const member = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "assets_browser",
      password: "Temporary-assets-browser-123",
    });
    const project = (await api("/state")).data.projects[0];
    await api(
      "/projects/" + project.id + "/environments",
      "POST",
      { name: "生产环境" },
      member.cookie,
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    const internal = [];
    page.on("request", (r) => {
      if (
        /\/api\/projects\/[^/]+\/(resources|resource-categories|deployments)/.test(
          r.url(),
        )
      )
        internal.push(r.url());
    });
    await page.goto(
      origin + "/worklog/?module=resources&project=" + project.id,
    );
    await page
      .getByRole("heading", { name: "登录后查看资源与配置", exact: true })
      .waitFor();
    assert.equal(internal.length, 0);
    await context.addCookies([
      {
        name: "worklog_session",
        value: member.cookie.split("=").slice(1).join("="),
        url: origin + "/worklog/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.reload();
    await page.getByRole("button", { name: "添加资源", exact: true }).waitFor();
    await page.getByRole("button", { name: "添加资源", exact: true }).click();
    let dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel("资源名称", { exact: true }).count(),
      0,
    );
    assert.ok(
      await dialog
        .getByRole("button", { name: "保存", exact: true })
        .isDisabled(),
    );
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption({ label: "数据库" });
    await dialog.getByLabel("数据库 / 实例名", { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel("序列号", { exact: true }).count(), 0);
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption({ label: "服务器 / 主机" });
    await dialog.getByLabel("序列号", { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel("数据库 / 实例名", { exact: true }).count(),
      0,
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "分类与字段", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "新建分类", exact: true }).click();
    await dialog.getByLabel("分类名称", { exact: true }).fill("工业网关");
    await dialog
      .getByLabel("所属大类", { exact: true })
      .selectOption("hardware");
    const defs = [
      ["资产编号", "text"],
      ["接口数量", "number"],
      ["安装方式", "select"],
      ["带电池", "boolean"],
    ];
    for (let i = 0; i < defs.length; i++) {
      await dialog
        .getByRole("button", { name: "添加字段", exact: true })
        .click();
      await dialog
        .getByLabel("字段名称" + (i + 1), { exact: true })
        .fill(defs[i][0]);
      await dialog
        .getByLabel("字段类型" + (i + 1), { exact: true })
        .selectOption(defs[i][1]);
    }
    await dialog
      .locator('[aria-label="字段1"]')
      .getByLabel("必填", { exact: true })
      .check();
    await dialog.getByLabel("下拉选项3", { exact: true }).fill("机架\n壁挂");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "添加资源", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption({ label: "工业网关" });
    await dialog.getByLabel("资源名称", { exact: true }).fill("工业网关1");
    await dialog.getByLabel("资产编号 *", { exact: true }).fill("GW-001");
    await dialog.getByLabel("接口数量", { exact: true }).fill("0");
    await dialog.getByLabel("安装方式", { exact: true }).selectOption("机架");
    await dialog.getByLabel("带电池", { exact: true }).selectOption("false");
    await page.screenshot({
      path: path.join(artifacts, "动态资源表单.png"),
      fullPage: true,
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /工业网关1/ }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("GW-001", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("否", { exact: true }).count(), 1);
    await dialog.getByRole("button", { name: "编辑资源", exact: true }).click();
    await dialog
      .getByLabel("资源类型", { exact: true })
      .selectOption({ label: "应用软件" });
    await dialog.getByLabel("软件版本", { exact: true }).fill("3.2");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /工业网关1/ }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("GW-001", { exact: true }).waitFor();
    await dialog.getByText("3.2", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: "部署信息", exact: true }).click();
    await page.getByRole("button", { name: "添加部署", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("部署名称", { exact: true }).fill("客户A正式现场");
    await dialog.getByLabel("部署状态", { exact: true }).selectOption("live");
    await dialog
      .getByLabel("所属环境", { exact: true })
      .selectOption({ label: "生产环境" });
    await dialog
      .getByLabel("客户 / 部署单位", { exact: true })
      .fill("演示单位");
    await dialog
      .getByLabel("部署位置", { exact: true })
      .fill("A楼三层机房，机柜01");
    await dialog
      .getByLabel("访问入口", { exact: true })
      .fill("https://gateway.example.invalid");
    await dialog.getByLabel("部署版本", { exact: true }).fill("3.2");
    await dialog.getByLabel("维护人", { exact: true }).fill("测试维护人");
    await dialog.getByLabel("工业网关1", { exact: true }).check();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("heading", { name: "客户A正式现场", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(artifacts, "项目部署信息.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "查看 / 修改", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByLabel("部署位置", { exact: true }).inputValue(),
      "A楼三层机房，机柜01",
    );
    await dialog
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "部署回收站", exact: true }).click();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await page
      .getByRole("heading", { name: "客户A正式现场", exact: true })
      .waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "返回部署信息", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "客户A正式现场", exact: true })
      .waitFor();
    const saved = (
      await api(
        "/projects/" + project.id + "/deployments",
        "GET",
        undefined,
        member.cookie,
      )
    ).data.deployments[0];
    assert.equal(saved.resource_ids.length, 1);
    assert.equal(saved.deployed_at, "");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(artifacts, "部署信息_手机.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page
      .getByRole("button", { name: "查看 / 修改", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", {name:"设备与应用",exact:true}).click();
    await page.getByRole("button", {name:"添加资源",exact:true}).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("资源类型", {exact:true}).selectOption({label:"服务器 / 主机"});
    await dialog.getByRole("button", {name:"添加地址",exact:true}).click();
    await dialog.getByLabel("IP / 地址1", {exact:true}).fill("127.0.0.2");
    assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(artifacts,"资源表单_手机.png"),fullPage:true,animations:"disabled"});
    await dialog.getByRole("button", {name:"取消",exact:true}).click();
    assert.deepEqual(errors, []);
    console.log(
      "PASS dynamic category templates, conditional fields, historical values, multi-site deployment, recycle and mobile layouts",
    );
  } catch (e) {
    if (page)
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          fullPage: true,
          animations: "disabled",
        })
        .catch(() => {});
    throw e;
  } finally {
    if (browser) await browser.close();
    if (app) {
      await new Promise((r) => app.server.close(r));
      app.db.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
