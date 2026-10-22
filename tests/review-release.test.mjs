import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { REGISTRATION_NAMES } from "../registration.mjs";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "worklog-release-review-"),
  );
  const origin = "http://127.0.0.1";
  const app = await createApp({ allowUninvitedRegistration: true, dataDir, origin });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/worklog/api`;
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
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const member = await api("/register", "POST", {
    name: REGISTRATION_NAMES[0],
    login: "release_review",
    password: "Temporary-review-123",
  });
  assert.equal(member.status, 201);
  const project = (await api("/state")).data.projects[0];
  return {
    app,
    project,
    api: (route, method = "GET", body) =>
      api(route, method, body, member.cookie),
  };
}

test("release review: invalid site-log calendar dates are validation errors without writes", async (t) => {
  const { app, project, api } = await fixture(t);
  for (const occurred_on of [
    "2026-13-01",
    "2026-00-01",
    "2026-01-32",
    "2026-02-30",
    "9999-99-99",
    "not-a-date",
  ]) {
    const response = await api(`/projects/${project.id}/notes`, "POST", {
      body: "无效日期不应保存",
      occurred_on,
    });
    assert.equal(response.status, 400, occurred_on);
  }
  assert.equal(
    app.db.prepare("SELECT COUNT(*) n FROM project_notes").get().n,
    0,
  );
  assert.equal(
    app.db
      .prepare(
        "SELECT COUNT(*) n FROM resource_events WHERE entity_type='note'",
      )
      .get().n,
    0,
  );
});

test("release review: note edits keep complete before and after wording in immutable history", async (t) => {
  const { app, project, api } = await fixture(t);
  const before = "旧".repeat(3500) + "原始结尾";
  const after = "新".repeat(3995) + "修改结尾";
  const created = await api(`/projects/${project.id}/notes`, "POST", {
    body: before,
  });
  assert.equal(created.status, 201);
  const note = created.data.note;
  assert.equal(
    (
      await api(`/notes/${note.id}`, "PATCH", {
        version: note.version,
        body: after,
      })
    ).status,
    200,
  );
  const event = (
    await api(`/resource-events?project_id=${project.id}`)
  ).data.entries.find((e) => e.action === "update-note");
  assert.equal(event.details.from, before);
  assert.equal(event.details.to, after);
  assert.throws(() =>
    app.db.prepare("DELETE FROM resource_events WHERE id=?").run(event.id),
  );
});

test("release review: undated notes use the Beijing calendar day for timeline order", async (t) => {
  const { app, project, api } = await fixture(t);
  const create = async (body, occurred_on, created) => {
    const n = (
      await api(`/projects/${project.id}/notes`, "POST", { body, occurred_on })
    ).data.note;
    app.db
      .prepare("UPDATE project_notes SET created=? WHERE id=?")
      .run(created, n.id);
    return n.id;
  };
  const midnight = await create(
    "北京时间22日凌晨登记",
    "",
    "2026-10-21T17:30:00.000Z",
  );
  const explicitToday = await create(
    "补记22日",
    "2026-10-22",
    "2026-10-20T06:00:00.000Z",
  );
  const explicitYesterday = await create(
    "补记21日",
    "2026-10-21",
    "2026-10-21T18:00:00.000Z",
  );
  const list = (await api(`/projects/${project.id}/notes`)).data.notes;
  assert.deepEqual(
    list.map((n) => n.id),
    [midnight, explicitToday, explicitYesterday],
  );
});
