import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../backup.mjs";

test("integrated private library, secrets, configuration and portable recovery", async (t) => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "worklog-library-integration-"),
  );
  const dataDir = path.join(temp, "source"),
    origin = "https://worklog.example.com";
  let app, restoredApp;
  try {
    app = await createApp({ dataDir, origin });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    let base = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
    async function api(
      route,
      method = "GET",
      body,
      cookie = "",
      customBase = base,
    ) {
      const response = await fetch(customBase + route, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Worklog-Request": "1",
          Cookie: cookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        data: await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    const a = await api("/register", "POST", {
      name: REGISTRATION_NAMES[0],
      login: "library_alice",
      password: "Temporary-test-123",
    });
    const b = await api("/register", "POST", {
      name: REGISTRATION_NAMES[1],
      login: "library_bob",
      password: "Temporary-test-123",
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const project = (await api("/state")).data.projects[0].id;
    const bytes = Buffer.from("Internal project handover file\n验收资料 V1\n");
    const secret = "TEST-ONLY-Database-Password-7842";
    const content =
      "# TEST ONLY CONFIG\npassword=" +
      secret +
      "\n" +
      "#0123456789\n".repeat(7000);
    let doc,
      versionId,
      resourceId,
      credentialId,
      configId,
      configVersionId,
      releaseId;

    await t.test(
      "new APIs require login and do not tighten public task access",
      async () => {
        for (const suffix of [
          "documents",
          "resources",
          "credentials",
          "configurations",
        ])
          assert.equal(
            (await api(`/projects/${project}/${suffix}`)).status,
            401,
          );
        assert.equal((await api("/resource-events")).status, 401);
        assert.equal((await api("/state")).status, 200);
        assert.equal((await api("/logs")).status, 200);
      },
    );
    await t.test(
      "streamed file upload is authenticated and download is independently protected",
      async () => {
        const start = await api(
          "/uploads",
          "POST",
          {
            project_id: project,
            filename: "内部交接.txt",
            title: "INTERNAL-DOCUMENT",
            size: bytes.length,
          },
          a.cookie,
        );
        assert.equal(start.status, 201, JSON.stringify(start.data));
        const chunkPath = "/uploads/" + start.data.id + "/chunks/0";
        const headers = {
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "X-Worklog-Request": "1",
          Cookie: a.cookie,
        };
        assert.equal(
          (
            await fetch(base + chunkPath, {
              method: "PUT",
              headers: { ...headers, Origin: "https://elsewhere.invalid" },
              body: bytes,
            })
          ).status,
          403,
        );
        const chunk = await fetch(base + chunkPath, {
          method: "PUT",
          headers,
          body: bytes,
        });
        assert.ok(chunk.ok, await chunk.text());
        const completed = await api(
          "/uploads/" + start.data.id + "/complete",
          "POST",
          {},
          a.cookie,
        );
        assert.ok(completed.status < 300, JSON.stringify(completed.data));
        doc = completed.data.document_id;
        versionId = completed.data.version_id;
        assert.ok(doc);
        assert.ok(versionId);
        const route = `/documents/${doc}/versions/${versionId}/download`;
        assert.equal((await fetch(base + route)).status, 401);
        const download = await fetch(base + route, {
          headers: { Cookie: b.cookie },
        });
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
        const head = await fetch(base + route, {
          method: "HEAD",
          headers: { Cookie: b.cookie },
        });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get("content-length")), bytes.length);
        const current = (
          await api("/documents/" + doc, "GET", undefined, b.cookie)
        ).data.document;
        assert.equal(
          (
            await api(
              `/documents/${doc}/publish`,
              "POST",
              { version: current.version, version_id: versionId },
              b.cookie,
            )
          ).status,
          200,
        );
        const release = await api(
          `/projects/${project}/releases`,
          "POST",
          {
            name: "固定交付 R1",
            items: [{ document_id: doc, version_id: versionId }],
          },
          b.cookie,
        );
        assert.equal(release.status, 201);
        releaseId = release.data.id;
        const zip = await fetch(base + `/releases/${releaseId}/download`, {
          headers: { Cookie: a.cookie },
        });
        assert.equal(zip.status, 200);
        assert.equal(
          Buffer.from(await zip.arrayBuffer()).readUInt32LE(0),
          0x04034b50,
        );
      },
    );
    await t.test(
      "software resources, shared credentials and large encrypted text configs work end to end",
      async () => {
        const resource = await api(
          `/projects/${project}/resources`,
          "POST",
          {
            name: "INTERNAL-DB",
            type: "database",
            endpoints: [
              {
                address: "db.internal.invalid",
                port: 5432,
                protocol: "postgres",
                purpose: "测试",
              },
            ],
          },
          a.cookie,
        );
        assert.equal(resource.status, 201, JSON.stringify(resource.data));
        resourceId = resource.data.id;
        const credential = await api(
          `/projects/${project}/credentials`,
          "POST",
          {
            title: "INTERNAL-CREDENTIAL",
            username: "test_admin",
            secret,
            resource_id: resourceId,
          },
          a.cookie,
        );
        assert.equal(credential.status, 201, JSON.stringify(credential.data));
        credentialId = credential.data.id;
        assert.ok(!JSON.stringify(credential.data).includes(secret));
        const reveal = await api(
          `/credentials/${credentialId}/reveal`,
          "POST",
          {},
          b.cookie,
        );
        assert.equal(reveal.status, 200);
        assert.equal(reveal.data.secret, secret);
        const config = await api(
          `/projects/${project}/configurations`,
          "POST",
          {
            name: "INTERNAL-CONFIG",
            resource_id: resourceId,
            content,
            path: "/opt/example/app.conf",
          },
          b.cookie,
        );
        assert.equal(config.status, 201, JSON.stringify(config.data));
        configId = config.data.id;
        const detail = await api(
          `/configurations/${configId}`,
          "GET",
          undefined,
          a.cookie,
        );
        configVersionId = detail.data.versions[0].id;
        assert.ok(!JSON.stringify(detail.data).includes(secret));
        const revealed = await api(
          `/configurations/${configId}/versions/${configVersionId}/reveal`,
          "POST",
          {},
          a.cookie,
        );
        assert.equal(revealed.status, 200);
        assert.equal(revealed.data.content, content);
        assert.equal(
          (
            await api(
              `/configurations/${configId}/publish`,
              "POST",
              {
                version: detail.data.configuration.version,
                version_id: configVersionId,
              },
              a.cookie,
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "secret disclosure, internal logs and public exports stay separated",
      async () => {
        for (const route of ["/state", "/logs"]) {
          const data = JSON.stringify((await api(route)).data);
          assert.ok(!data.includes(secret));
          assert.ok(!data.includes("INTERNAL-"));
        }
        const logs = await api(
          `/resource-events?project_id=${project}`,
          "GET",
          undefined,
          b.cookie,
        );
        assert.equal(logs.status, 200);
        assert.ok(
          logs.data.entries.some((event) => event.action.includes("reveal")),
        );
        assert.ok(!JSON.stringify(logs.data).includes(secret));
        assert.equal(
          (await api("/resource-events/1", "DELETE", {}, b.cookie)).status,
          405,
        );
        assert.throws(
          () => app.db.exec("DELETE FROM resource_events"),
          /immutable/,
        );
        const log = app.db
          .prepare("SELECT * FROM resource_events LIMIT 1")
          .get();
        assert.throws(
          () =>
            app.db
              .prepare(
                "INSERT OR REPLACE INTO resource_events VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(...Object.values(log)),
          /immutable/,
        );
        assert.ok(
          !(await fs.readFile(path.join(dataDir, "worklog.sqlite"))).includes(
            Buffer.from(secret),
          ),
        );
      },
    );
    await t.test(
      "backup restores files and database into a new environment; keys are restored separately",
      async () => {
        const pending = await api(
          "/uploads",
          "POST",
          { project_id: project, filename: "未提交.txt", size: bytes.length },
          a.cookie,
        );
        const pendingChunk = await fetch(
          base + "/uploads/" + pending.data.id + "/chunks/0",
          {
            method: "PUT",
            headers: {
              Origin: origin,
              "Content-Type": "application/octet-stream",
              "X-Worklog-Request": "1",
              Cookie: a.cookie,
            },
            body: bytes,
          },
        );
        assert.ok(pendingChunk.ok);
        const saved = await createWorkspaceBackup({ dataDir });
        assert.equal(saved.manifest.files.length, 1);
        assert.deepEqual(saved.manifest.requiredKeyVersions, ["v1"]);
        assert.equal(saved.manifest.keyMaterialIncluded, false);
        assert.ok(!(await fs.readdir(saved.folder)).includes(".keys"));
        const targetDir = path.join(temp, "restored");
        await restoreWorkspaceBackup({ backupDir: saved.folder, targetDir });
        await assert.rejects(
          restoreWorkspaceBackup({ backupDir: saved.folder, targetDir }),
          /empty/,
        );
        restoredApp = await createApp({ dataDir: targetDir, origin });
        await new Promise((resolve) =>
          restoredApp.server.listen(0, "127.0.0.1", resolve),
        );
        let restoredBase =
          "http://127.0.0.1:" +
          restoredApp.server.address().port +
          "/worklog/api";
        assert.equal(
          (
            await api(
              `/uploads/${pending.data.id}/complete`,
              "POST",
              {},
              a.cookie,
              restoredBase,
            )
          ).status,
          409,
        );
        const withoutKey = await api(
          `/credentials/${credentialId}/reveal`,
          "POST",
          {},
          b.cookie,
          restoredBase,
        );
        assert.equal(withoutKey.status, 503);
        const file = await fetch(
          restoredBase + `/documents/${doc}/versions/${versionId}/download`,
          { headers: { Cookie: b.cookie } },
        );
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
        await restoredApp.close();
        restoredApp = null;
        await fs.mkdir(path.join(targetDir, ".keys"), { recursive: true });
        await fs.copyFile(
          path.join(dataDir, ".keys", "vault-v1.key"),
          path.join(targetDir, ".keys", "vault-v1.key"),
        );
        restoredApp = await createApp({ dataDir: targetDir, origin });
        await new Promise((resolve) =>
          restoredApp.server.listen(0, "127.0.0.1", resolve),
        );
        restoredBase =
          "http://127.0.0.1:" +
          restoredApp.server.address().port +
          "/worklog/api";
        const decrypted = await api(
          `/credentials/${credentialId}/reveal`,
          "POST",
          {},
          b.cookie,
          restoredBase,
        );
        assert.equal(decrypted.data.secret, secret);
        assert.equal(
          (
            await api(
              `/configurations/${configId}/versions/${configVersionId}/reveal`,
              "POST",
              {},
              b.cookie,
              restoredBase,
            )
          ).data.content,
          content,
        );
        const entries = (
          await api(
            `/resource-events?project_id=${project}`,
            "GET",
            undefined,
            b.cookie,
            restoredBase,
          )
        ).data.entries;
        assert.ok(entries.length > 0);
        await fs.writeFile(
          path.join(saved.folder, "manifest.json"),
          JSON.stringify({ ...saved.manifest, files: [] }),
        );
        await assert.rejects(
          restoreWorkspaceBackup({
            backupDir: saved.folder,
            targetDir: path.join(temp, "incomplete-restore"),
          }),
          /all historical files/,
        );
      },
    );
    await t.test(
      "bulk file control requests do not exhaust ordinary form rate limits",
      async () => {
        for (let index = 0; index < 110; index++) {
          const initialized = await api(
            "/uploads",
            "POST",
            { project_id: project, filename: `批量资料-${index}.txt`, size: 1 },
            a.cookie,
          );
          assert.equal(initialized.status, 201);
          assert.equal(
            (
              await api(
                `/uploads/${initialized.data.id}/cancel`,
                "POST",
                {},
                a.cookie,
              )
            ).status,
            200,
          );
        }
      },
    );
  } finally {
    await restoredApp?.close();
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
