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
    path.join(os.tmpdir(), "worklog-library-browser-"),
  );
  const artifacts =
    process.env.WORKLOG_ARTIFACTS_DIR ||
    path.join(os.tmpdir(), "worklog-library-ui-proof");
  await fs.mkdir(artifacts, { recursive: true });
  const origin = "http://127.0.0.1:8769",
    base = origin + "/worklog/api";
  let app, browser, page;
  try {
    app = await createApp({ allowUninvitedRegistration: true,
      dataDir,
      origin,
      dist: path.resolve(__dirname, "../dist"),
    });
    await new Promise((resolve) =>
      app.server.listen(8769, "127.0.0.1", resolve),
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
      login: "ui_library",
      password: "Temporary-test-123",
    });
    const project = (await api("/state")).data.projects[0];
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      acceptDownloads: true,
    });
    page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    const errors = [],
      sensitiveRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Content Security Policy|Refused to frame|sandboxed.*blocked|blocked.*sandbox/i.test(
          message.text(),
        )
      )
        errors.push(message.text());
    });
    page.on("request", (request) => {
      if (
        /\/api\/(?:projects\/[^/]+\/(?:documents|resources|credentials|configurations|deliverables)|resource-events)/.test(
          request.url(),
        )
      )
        sensitiveRequests.push(request.url());
    });
    await page.goto(origin + "/worklog/");
    await page
      .getByRole("navigation", { name: "项目模块" })
      .getByRole("button", { name: "项目资料", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "登录后查看项目资料", exact: true })
      .waitFor();
    assert.equal(sensitiveRequests.length, 0);
    const token = member.cookie.slice(member.cookie.indexOf("=") + 1);
    await context.addCookies([
      {
        name: "worklog_session",
        value: token,
        url: origin + "/worklog/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(
      origin + "/worklog/?project=" + project.id + "&module=documents",
    );
    await page.getByRole("button", { name: "上传资料", exact: true }).waitFor();
    await page.getByRole("button", { name: "新建目录", exact: true }).click();
    await page.getByLabel("目录名称", { exact: true }).fill("部署资料");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("button", { name: "部署资料", exact: true })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "上传资料", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "部署说明.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("部署说明 TEST V1\n"),
      });
    await dialog.getByRole("button", { name: "确认上传", exact: true }).click();
    await dialog.getByText("部署说明.txt：上传完成", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "管理 部署说明.txt", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("V1", { exact: true }).first().waitFor();
    const publish = dialog
      .getByRole("button", { name: /设为正式版|发布为正式版/ })
      .first();
    await publish.click();
    await dialog.getByText("正式版", { exact: true }).first().waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    const checklist = page.getByRole("region", { name: "交接资料清单" });
    await checklist
      .getByRole("button", { name: "软件项目资料", exact: true })
      .click();
    await checklist.getByText("部署手册", { exact: true }).waitFor();
    await checklist
      .getByRole("button", { name: "编辑资料项：部署手册", exact: true })
      .click();
    await page
      .getByLabel("关联项目文档", { exact: true })
      .selectOption({ label: "部署说明.txt" });
    await page.getByRole("button", { name: "保存资料项", exact: true }).click();
    await checklist
      .getByRole("row")
      .filter({ hasText: "部署手册" })
      .getByText("已齐备", { exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(artifacts, "项目资料.png"),
      fullPage: true,
    });

    await page
      .getByRole("navigation", { name: "项目模块" })
      .getByRole("button", { name: "资源与配置", exact: true })
      .click();
    await page.getByRole("button", { name: "添加资源", exact: true }).click();
    await page
      .getByLabel("资源类型", { exact: true })
      .selectOption({ label: "数据库" });
    await page.getByLabel("资源名称", { exact: true }).fill("项目数据库");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("button", { name: /项目数据库.*数据库/ })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "账号密码", exact: true }).click();
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page
      .getByLabel("账号用途 / 名称", { exact: true })
      .fill("数据库维护账号");
    await page.getByLabel("用户名", { exact: true }).fill("test_admin");
    const secret = "SYNTHETIC-BROWSER-TEST-9138";
    await page.getByLabel("密码 / 密钥", { exact: true }).fill(secret);
    await page
      .getByLabel("关联资源（可选）", { exact: true })
      .selectOption({ label: "项目数据库" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("button", { name: "查看账号 数据库维护账号", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    assert.ok(!(await dialog.innerText()).includes(secret));
    await dialog.getByRole("button", { name: "查看密码", exact: true }).click();
    await dialog.getByText(secret, { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    assert.ok(!(await page.locator("body").innerText()).includes(secret));
    await page.screenshot({
      path: path.join(artifacts, "账号密码.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "配置管理", exact: true }).click();
    await page.getByRole("button", { name: "添加配置", exact: true }).click();
    await page.getByLabel("配置名称", { exact: true }).fill("数据库连接配置");
    await page
      .getByLabel("关联资源", { exact: true })
      .selectOption({ label: "项目数据库" });
    await page
      .getByLabel("加密配置内容", { exact: true })
      .fill("host=db.example.invalid\npassword=" + secret + "\n");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .getByRole("button", { name: "查看配置 数据库连接配置", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    assert.ok(!(await dialog.innerText()).includes(secret));
    await dialog
      .getByRole("button", { name: "查看内容", exact: true })
      .first()
      .click();
    await page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      secret,
    );
    await dialog
      .getByRole("button", { name: "发布正式版", exact: true })
      .first()
      .click();
    await dialog.getByText("正式版", { exact: true }).first().waitFor();
    await dialog
      .getByRole("button", { name: "登记现场使用", exact: true })
      .click();
    const application = page.getByRole("dialog", {
      name: "登记现场使用",
      exact: true,
    });
    await application
      .getByLabel("验证结果", { exact: true })
      .selectOption("verified");
    await application
      .getByRole("button", { name: "保存使用记录", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "数据库连接配置", exact: true });
    await dialog.getByText("验证结果：验证通过", { exact: false }).waitFor();
    await dialog
      .getByRole("button", { name: "基于此版更新", exact: true })
      .first()
      .click();
    await dialog
      .getByLabel("加密配置内容", { exact: true })
      .fill("host=db-v2.example.invalid\npassword=" + secret + "\n");
    await dialog
      .getByRole("button", { name: "保存为新工作版", exact: true })
      .click();
    await dialog
      .getByText("新工作版已保存，正式版与现场使用记录保持独立", {
        exact: true,
      })
      .waitFor();
    const configList = (
      await api(
        `/projects/${project.id}/configurations`,
        "GET",
        undefined,
        member.cookie,
      )
    ).data.configurations;
    const configDetail = (
      await api(
        `/configurations/${configList[0].id}`,
        "GET",
        undefined,
        member.cookie,
      )
    ).data;
    assert.notEqual(
      configDetail.configuration.latest_version_id,
      configDetail.configuration.published_version_id,
    );
    assert.equal(
      configDetail.applications[0].version_id,
      configDetail.configuration.published_version_id,
    );
    dialog = page.getByRole("dialog", { name: "数据库连接配置", exact: true });
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    assert.ok(!(await page.locator("body").innerText()).includes(secret));
    await page.screenshot({
      path: path.join(artifacts, "配置管理.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(artifacts, "配置管理_手机.png"),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    // A valid, generated PDF exercises the authenticated preview and blob CSP.
    const stream = "BT /F1 18 Tf 35 100 Td (PROJECT PREVIEW TEST) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n",
      offsets = [0];
    for (let index = 0; index < objects.length; index++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join(
        "",
      )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const pdfBytes = Buffer.from(pdf);
    const uploadPdf = await api(
      "/uploads",
      "POST",
      {
        project_id: project.id,
        filename: "预览验收.pdf",
        size: pdfBytes.length,
      },
      member.cookie,
    );
    const pdfPart = await fetch(
      base + `/uploads/${uploadPdf.data.id}/chunks/0`,
      {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: member.cookie,
        },
        body: pdfBytes,
      },
    );
    assert.ok(pdfPart.ok);
    await api(
      `/uploads/${uploadPdf.data.id}/complete`,
      "POST",
      {},
      member.cookie,
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page
      .getByRole("navigation", { name: "项目模块" })
      .getByRole("button", { name: "项目资料", exact: true })
      .click();
    await page
      .getByRole("button", { name: "管理 预览验收.pdf", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "预览", exact: true })
      .first()
      .click();
    const pdfPreview = page.getByRole("dialog", {
      name: "文件预览",
      exact: true,
    });
    await pdfPreview.locator('iframe[title="PDF 预览"]').waitFor();
    await page.waitForLoadState("networkidle");
    const pdfHandle = await pdfPreview
      .locator('iframe[title="PDF 预览"]')
      .elementHandle();
    const pdfFrame = await pdfHandle.contentFrame();
    assert.ok(
      !pdfFrame.url().startsWith("chrome-error:"),
      "PDF viewer must render instead of a browser blocked page",
    );
    await page.screenshot({
      path: path.join(artifacts, "PDF预览.png"),
      fullPage: true,
    });
    await pdfPreview
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();
    await page
      .getByRole("navigation", { name: "项目模块" })
      .getByRole("button", { name: "资料日志", exact: true })
      .click();
    await page.getByText("数据库维护账号", { exact: true }).first().waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes(secret));
    assert.deepEqual(errors, []);
    console.log("Library browser acceptance passed. Screenshots:", artifacts);
  } catch (error) {
    if (page) {
      await page
        .screenshot({
          path: path.join(artifacts, "failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-5000),
      );
    }
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
