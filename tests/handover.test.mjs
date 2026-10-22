import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.mjs";
import { starterItems, checklistProgress } from "../src/checklist.js";
const origin = "https://worklog.example.com";
async function start(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "worklog-handover-"));
  const app = await createApp({ allowUninvitedRegistration: true, dataDir, origin });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port + "/worklog/api";
  const headers = (cookie, type = "application/json") => ({
    Origin: origin,
    "Content-Type": type,
    "X-Worklog-Request": "1",
    Cookie: cookie,
  });
  async function api(route, method = "GET", body, cookie = "") {
    const r = await fetch(base + route, {
      method,
      headers: headers(cookie),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const { cookie } = await api("/register", "POST", {
    name: "胡示例三",
    login: "handover_alice",
    password: "Temporary-test-123",
  });
  const project = (await api("/state")).data.projects[0].id;
  async function upload(filename, extra = {}) {
    const bytes = Buffer.from("内容：" + filename);
    const s = await api(
      "/uploads",
      "POST",
      { project_id: project, filename, size: bytes.length, ...extra },
      cookie,
    );
    assert.equal(s.status, 201, JSON.stringify(s.data));
    const put = await fetch(base + "/uploads/" + s.data.id + "/chunks/0", {
      method: "PUT",
      headers: headers(cookie, "application/octet-stream"),
      body: bytes,
    });
    assert.ok(put.ok);
    return (
      await api("/uploads/" + s.data.id + "/complete", "POST", {}, cookie)
    ).data;
  }
  const events = async () =>
    (
      await api(
        "/resource-events?project_id=" + project,
        "GET",
        undefined,
        cookie,
      )
    ).data.entries;
  return { app, api, cookie, project, upload, events, dataDir };
}
test("starter checklist adapts to the project kind", () => {
  const titles = (kind) => starterItems(kind).map((i) => i.title);
  assert.ok(titles("software").includes("部署手册"));
  assert.ok(!titles("software").includes("设备清单"));
  assert.ok(titles("equipment").includes("设备清单"));
  assert.ok(!titles("equipment").includes("部署手册"));
  assert.ok(
    titles("both").includes("部署手册") && titles("both").includes("设备清单"),
  );
  assert.ok(starterItems("both").every((i) => i.stage));
  assert.deepEqual(
    checklistProgress([
      { applicable: true, required: true, status: "missing" },
      { applicable: true, required: true, status: "draft" },
      { applicable: true, required: true, status: "recorded" },
      { applicable: false, required: true, status: "not-applicable" },
      { applicable: true, required: false, status: "missing" },
    ]),
    { required: 3, provided: 2, missing: 1, unpublished: 1 },
  );
});
test("applying, extending and saving checklists as templates", async (t) => {
  const { api, cookie, project, events } = await start(t);
  assert.equal(
    (
      await api("/projects/" + project + "/deliverables/apply", "POST", {
        kind: "software",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await api(
        "/projects/" + project + "/deliverables/apply",
        "POST",
        { kind: "robot" },
        cookie,
      )
    ).status,
    400,
  );
  let res = await api(
    "/projects/" + project + "/deliverables/apply",
    "POST",
    { kind: "software" },
    cookie,
  );
  assert.equal(res.status, 200);
  const softwareCount = starterItems("software").length;
  assert.equal(res.data.added, softwareCount);
  assert.equal(
    res.data.progress.missing,
    starterItems("software").filter((i) => i.required).length,
  );
  const deploy = res.data.items.find((i) => i.title === "部署手册");
  assert.equal(deploy.stage, "实施");
  assert.equal(deploy.required, true);
  // Re-applying, or applying the broader template, only adds what is missing.
  res = await api(
    "/projects/" + project + "/deliverables/apply",
    "POST",
    { kind: "software" },
    cookie,
  );
  assert.equal(res.data.added, 0);
  res = await api(
    "/projects/" + project + "/deliverables/apply",
    "POST",
    { kind: "both" },
    cookie,
  );
  assert.equal(res.data.added, starterItems("both").length - softwareCount);
  // Project-specific extra item and a not-applicable one.
  const extra = await api(
    "/projects/" + project + "/deliverables",
    "POST",
    {
      title: "等保测评报告",
      stage: "验收",
      required: true,
      hint: "第三方出具",
    },
    cookie,
  );
  assert.equal(extra.status, 201);
  assert.equal(extra.data.item.required, true);
  assert.equal(
    (
      await api(
        "/projects/" + project + "/deliverables",
        "POST",
        { title: "x", stage: "很长".repeat(20) },
        cookie,
      )
    ).status,
    400,
  );
  const wiring = res.data.items.find(
    (i) => i.title === "接线与安装图、现场照片",
  );
  await api(
    "/deliverables/" + wiring.id,
    "PATCH",
    { version: wiring.version, applicable: false },
    cookie,
  );
  // Save as a shared template, then apply it to a new project.
  const saved = await api(
    "/checklist-templates",
    "POST",
    { name: "智慧园区项目", project_id: project },
    cookie,
  );
  assert.equal(saved.status, 201);
  assert.ok(
    saved.data.template.items.some(
      (i) => i.title === "等保测评报告" && i.required,
    ),
  );
  assert.ok(
    !saved.data.template.items.some(
      (i) => i.title === "接线与安装图、现场照片",
    ),
    "not-applicable items stay out of templates",
  );
  assert.equal(
    (
      await api(
        "/checklist-templates",
        "POST",
        { name: "智慧园区项目", project_id: project },
        cookie,
      )
    ).status,
    409,
  );
  const second = (await api("/projects", "POST", { name: "二号园区" }, cookie))
    .data.id;
  res = await api(
    "/projects/" + second + "/deliverables/apply",
    "POST",
    { template_id: saved.data.template.id },
    cookie,
  );
  assert.equal(res.data.added, saved.data.template.items.length);
  assert.deepEqual(
    res.data.items.map((i) => i.title),
    saved.data.template.items.map((i) => i.title),
    "template order is kept",
  );
  const list = (await api("/checklist-templates", "GET", undefined, cookie))
    .data.templates;
  assert.equal(list.length, 1);
  assert.equal(
    (
      await api(
        "/checklist-templates/" + list[0].id,
        "DELETE",
        { version: list[0].version },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api("/checklist-templates", "GET", undefined, cookie)).data.templates
      .length,
    0,
  );
  assert.equal(
    (
      await api(
        "/projects/" + project + "/deliverables/apply",
        "POST",
        { template_id: list[0].id },
        cookie,
      )
    ).status,
    404,
  );
  const actions = (await events()).map((e) => e.action);
  assert.ok(
    actions.includes("apply-checklist") && actions.includes("create-template"),
  );
  // The signed-in state carries the missing-item badge counts.
  const state = (await api("/state", "GET", undefined, cookie)).data;
  assert.equal(
    state.checklist[project].missing,
    state.checklist[project].required,
  );
  assert.deepEqual(
    (await api("/state")).data.checklist,
    {},
    "guests do not see checklist state",
  );
});
test("site log entries satisfy checklist items and keep their history", async (t) => {
  const { api, cookie, project, upload, events } = await start(t);
  const items = (
    await api(
      "/projects/" + project + "/deliverables/apply",
      "POST",
      { kind: "equipment" },
      cookie,
    )
  ).data.items;
  const config = items.find((i) => i.title === "现场配置记录");
  const task = (
    await api(
      "/records",
      "POST",
      { project_id: project, task: "现场调试", owner: "胡示例三" },
      cookie,
    )
  ).data.id;
  assert.equal(
    (await api("/projects/" + project + "/notes", "GET")).status,
    401,
  );
  for (const bad of [
    { kind: "site", body: "  " },
    { kind: "nope", body: "x" },
    { kind: "site", body: "x", occurred_on: "2026-02-30" },
    { kind: "site", body: "x", deliverable_id: "missing" },
  ])
    assert.equal(
      (await api("/projects/" + project + "/notes", "POST", bad, cookie))
        .status,
      400,
      JSON.stringify(bad),
    );
  const created = await api(
    "/projects/" + project + "/notes",
    "POST",
    {
      kind: "site",
      body: "3 号柜交换机 IP 改为 192.168.1.20（原 .10）",
      occurred_on: "2026-10-19",
      people: "胡示例三、 韩示例二",
      deliverable_id: config.id,
      task_id: task,
    },
    cookie,
  );
  assert.equal(created.status, 201);
  let note = created.data.note;
  assert.equal(note.people, "胡示例三、韩示例二");
  assert.equal(note.deliverable_title, "现场配置记录");
  assert.equal(note.task_title, "现场调试");
  let item = (
    await api(
      "/projects/" + project + "/deliverables",
      "GET",
      undefined,
      cookie,
    )
  ).data.items.find((i) => i.id === config.id);
  assert.equal(item.status, "recorded");
  assert.equal(item.note_count, 1);
  // Attach a photo uploaded through the normal library pipeline.
  const photo = await upload("机柜照片.jpg", { category: "随手记附件" });
  note = (
    await api(
      "/notes/" + note.id + "/files",
      "POST",
      { document_id: photo.document_id },
      cookie,
    )
  ).data.note;
  assert.deepEqual(
    note.files.map((f) => f.filename),
    ["机柜照片.jpg"],
  );
  const otherProject = (
    await api("/projects", "POST", { name: "别的项目" }, cookie)
  ).data.id;
  const foreign = await api(
    "/projects/" + otherProject + "/notes",
    "POST",
    { kind: "other", body: "别处" },
    cookie,
  );
  assert.equal(
    (
      await api(
        "/notes/" + foreign.data.note.id + "/files",
        "POST",
        { document_id: photo.document_id },
        cookie,
      )
    ).status,
    400,
  );
  // Task detail sees both linked files and notes.
  await upload("调试报告.pdf", { task_id: task });
  const materials = (
    await api("/records/" + task + "/materials", "GET", undefined, cookie)
  ).data;
  assert.deepEqual(
    materials.documents.map((d) => d.filename),
    ["调试报告.pdf"],
  );
  assert.deepEqual(
    materials.notes.map((n) => n.id),
    [note.id],
  );
  // Edits need the current version and keep the old wording in the log.
  assert.equal(
    (
      await api(
        "/notes/" + note.id,
        "PATCH",
        { version: note.version - 1, body: "旧" },
        cookie,
      )
    ).status,
    409,
  );
  note = (
    await api(
      "/notes/" + note.id,
      "PATCH",
      { version: note.version, body: "3 号柜交换机 IP 改为 192.168.1.30" },
      cookie,
    )
  ).data.note;
  const update = (await events()).find((e) => e.action === "update-note");
  assert.equal(
    update.details.from,
    "3 号柜交换机 IP 改为 192.168.1.20（原 .10）",
  );
  assert.equal(update.details.to, "3 号柜交换机 IP 改为 192.168.1.30");
  // Soft delete drops the evidence; restore brings it back.
  const removed = await api(
    "/notes/" + note.id,
    "DELETE",
    { version: note.version },
    cookie,
  );
  assert.equal(removed.status, 200);
  item = (
    await api(
      "/projects/" + project + "/deliverables",
      "GET",
      undefined,
      cookie,
    )
  ).data.items.find((i) => i.id === config.id);
  assert.equal(item.status, "missing");
  assert.equal(
    (await api("/projects/" + project + "/notes", "GET", undefined, cookie))
      .data.notes.length,
    0,
  );
  assert.equal(
    (
      await api(
        "/projects/" + project + "/notes?deleted=1",
        "GET",
        undefined,
        cookie,
      )
    ).data.notes.length,
    1,
  );
  note = (
    await api(
      "/notes/" + note.id + "/restore",
      "POST",
      { version: removed.data.version },
      cookie,
    )
  ).data.note;
  assert.equal(note.deleted, false);
  // Timeline order: occurred date first, falling back to the entry date.
  await api(
    "/projects/" + project + "/notes",
    "POST",
    { kind: "verbal", body: "客户确认报表按月汇总", occurred_on: "2026-10-20" },
    cookie,
  );
  await api(
    "/projects/" + project + "/notes",
    "POST",
    { kind: "verbal", body: "更早的口头约定", occurred_on: "2026-01-02" },
    cookie,
  );
  const timeline = (
    await api("/projects/" + project + "/notes", "GET", undefined, cookie)
  ).data.notes.map((n) => n.body);
  assert.deepEqual(timeline.slice(-2), [
    "3 号柜交换机 IP 改为 192.168.1.30",
    "更早的口头约定",
  ]);
  // Detaching keeps the document in the library.
  note = (
    await api(
      "/notes/" + note.id + "/files/" + photo.document_id,
      "DELETE",
      {},
      cookie,
    )
  ).data.note;
  assert.equal(note.files.length, 0);
  assert.ok(
    (
      await api("/projects/" + project + "/documents", "GET", undefined, cookie)
    ).data.documents.some((d) => d.id === photo.document_id),
  );
});
test("older databases gain the checklist columns and site log tables", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "worklog-handover-migrate-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let app = await createApp({ allowUninvitedRegistration: true, dataDir, origin });
  await app.close();
  const db = new DatabaseSync(path.join(dataDir, "worklog.sqlite"));
  db.exec(
    "DROP TABLE project_note_files; DROP TABLE project_notes; ALTER TABLE document_deliverables DROP COLUMN hint; ALTER TABLE document_deliverables DROP COLUMN stage;",
  );
  db.close();
  app = await createApp({ allowUninvitedRegistration: true, dataDir, origin });
  const columns = app.db
    .prepare("PRAGMA table_info(document_deliverables)")
    .all()
    .map((c) => c.name);
  assert.ok(columns.includes("stage") && columns.includes("hint"));
  assert.ok(
    app.db
      .prepare("SELECT name FROM sqlite_master WHERE name='project_notes'")
      .get(),
  );
  await app.close();
});
