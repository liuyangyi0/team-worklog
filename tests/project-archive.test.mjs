import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProjectArchive } from "../project-archive.mjs";
import { installDocumentSchema } from "../documents.mjs";
import { installNotesSchema } from "../notes.mjs";
import { installMilestoneSchema } from "../milestones.mjs";
import { installChangeLedgerSchema } from "../change-ledger.mjs";
import { installLibraryCommon } from "../library-common.mjs";
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p1','项目甲'),('p2','项目乙'); CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT,task TEXT,deleted INTEGER DEFAULT 0,actual TEXT,date TEXT); INSERT INTO records VALUES('task','p1','不要自动完成任务',0,'','');",
  );
  installDocumentSchema(db);
  installNotesSchema(db);
  installMilestoneSchema(db);
  installChangeLedgerSchema(db);
  installLibraryCommon(db);
  const insert = (table, row) =>
    db
      .prepare(
        "INSERT INTO " +
          table +
          "(" +
          Object.keys(row).join(",") +
          ") VALUES(" +
          Object.keys(row)
            .map(() => "?")
            .join(",") +
          ")",
      )
      .run(...Object.values(row));
  const created = "2026-01-01T18:00:00.000Z";
  insert("project_notes", {
    id: "n1",
    project_id: "p1",
    kind: "verbal",
    body: "客户确认月报。" + "正文".repeat(220) + "关键词在末尾",
    people: "张工",
    author_id: "u",
    author_name: "成员甲",
    occurred_on: "2025-12-30",
    created,
    updated: "2026-12-30T00:00:00Z",
  });
  insert("project_notes", {
    id: "n2",
    project_id: "p2",
    kind: "site",
    body: "无发生日的现场记录",
    people: "李工",
    author_id: "u",
    author_name: "成员甲",
    created,
    updated: "2026-12-30T00:00:00Z",
  });
  insert("project_notes", {
    id: "deleted-note",
    project_id: "p1",
    kind: "other",
    body: "DELETED-SECRET",
    author_id: "u",
    author_name: "成员甲",
    created,
    updated: created,
    deleted: 1,
  });
  insert("project_milestones", {
    id: "m1",
    project_id: "p1",
    title: "联调完成",
    description: "当前节点说明",
    actual_date: "2026-02-10",
    status: "achieved",
    created,
    updated: "2026-12-30T00:00:00Z",
  });
  insert("project_milestones", {
    id: "m-old",
    project_id: "p1",
    title: "旧记录里程碑",
    created,
    updated: "2026-12-30T00:00:00Z",
  });
  const event = (id, action, type, entity, details, time = created) =>
    insert("resource_events", {
      id,
      request_id: "test-" + id,
      actor_id: "u",
      actor_login: "fixture",
      actor_name: "成员甲",
      project_id: "p1",
      action,
      entity_type: type,
      entity_id: entity,
      details_json: JSON.stringify(details),
      created: time,
    });
  event(1, "create-milestone", "milestone", "m1", {
    title: "原始里程碑标题",
    status: "planned",
  });
  event(
    2,
    "update-milestone",
    "milestone",
    "m1",
    {
      title: "达成时标题",
      status: "achieved",
      fields: ["status"],
      from: "active",
      to: "achieved",
    },
    "2026-02-11T00:00:00Z",
  );
  event(
    3,
    "update-milestone",
    "milestone",
    "m1",
    {
      title: "后来改名",
      status: "achieved",
      fields: ["title"],
      from: "达成时标题",
      to: "后来改名",
    },
    "2026-12-30T00:00:00Z",
  );
  insert("project_changes", {
    id: "c1",
    project_id: "p1",
    title: "当前变更名称",
    requested_scope: "当前正文",
    requested_on: "2026-01-02",
    creator_id: "u",
    creator_name: "成员甲",
    created,
    updated: "2026-12-30T00:00:00Z",
  });
  const before = {
    id: "c1",
    title: "原始变更名称",
    requested_scope: "增加月报",
    requested_on: "2026-01-02",
    confirmation_status: "pending",
  };
  const after = {
    ...before,
    title: "确认时变更名称",
    confirmation_status: "confirmed",
    confirmed_on: "2026-01-05",
    confirmed_by: "客户张工",
  };
  for (const [id, revision, action, a, b, time] of [
    [1, 1, "create", before, null, created],
    [2, 2, "update", after, before, "2026-01-06T00:00:00Z"],
    [
      3,
      3,
      "update",
      { ...after, title: "改标题" },
      after,
      "2026-12-30T00:00:00Z",
    ],
  ])
    insert("project_change_history", {
      id,
      change_id: "c1",
      revision,
      action,
      actor_id: "u",
      actor_name: "成员甲",
      before_json: b ? JSON.stringify(b) : null,
      after_json: JSON.stringify(a),
      created: time,
    });
  insert("document_blobs", { sha256: "hash", size: 12, created });
  for (const [id, sensitive, deleted] of [
    ["d1", 0, 0],
    ["sensitive-doc", 1, 0],
    ["removed-doc", 0, 1],
  ]) {
    insert("documents", {
      id,
      project_id: "p1",
      title: id === "d1" ? "客户正式说明" : "NO-LEAK-" + id,
      description: "说明文本",
      tags: '["联调"]',
      source_path: "C:/内部交付/源路径标记",
      creator: "u",
      current_version_id: id + "-v2",
      created,
      updated: "2026-12-30T00:00:00Z",
      sensitive,
      deleted,
    });
    for (const [number, filename] of [
      [1, "原始历史名称.docx"],
      [2, "现行文件.docx"],
    ])
      insert("document_versions", {
        id: id + "-v" + number,
        document_id: id,
        number,
        filename,
        size: 12,
        sha256: "hash",
        blob_hash: "DO-NOT-EXPOSE-BLOB",
        created_by: "成员甲",
        creator_id: "u",
        created,
        conflict: 0,
      });
  }
  event(
    4,
    "publish",
    "document",
    "d1",
    { version_id: "d1-v1", number: 1 },
    "2026-02-01T00:00:00Z",
  );
  event(
    5,
    "download",
    "document",
    "d1",
    { version_id: "d1-v1" },
    "2026-12-30T00:00:00Z",
  );
  event(
    6,
    "publish",
    "document",
    "sensitive-doc",
    { version_id: "sensitive-doc-v1" },
    "2026-12-30T00:00:00Z",
  );
  insert("document_releases", {
    id: "r1",
    project_id: "p1",
    name: "固定交付归档",
    created: "2026-02-02T00:00:00Z",
    created_by: "成员甲",
    creator_id: "u",
    manifest_json: '{"credential":"DO-NOT-EXPOSE-MANIFEST"}',
  });
  db.exec(
    "CREATE TABLE credentials(id TEXT,secret TEXT); INSERT INTO credentials VALUES('credential','PRIVATE-CREDENTIAL-PAYLOAD'); CREATE TABLE configurations(id TEXT,body TEXT); INSERT INTO configurations VALUES('config','PRIVATE-CONFIG-PAYLOAD');",
  );
  const service = createProjectArchive({ db });
  t.after(() => db.close());
  const api = async (
    url = "/project-archive",
    user = { id: "u" },
    method = "GET",
  ) => {
    const u = new URL(url, "http://archive.test");
    try {
      const r = await service.api({
        route: u.pathname,
        params: u.searchParams,
        user,
        method,
      });
      return { status: r?.status || 200, ...r?.data };
    } catch (e) {
      return { status: e.status || 500, error: e.message };
    }
  };
  return { db, api };
}
test("archive requires login, validates all boundaries, and never exposes sensitive sources", async (t) => {
  const { api } = fixture(t);
  assert.equal((await api("/project-archive", null)).status, 401);
  assert.equal(
    (await api("/project-archive", { id: "other" }, "PATCH")).status,
    405,
  );
  for (const query of [
    "mode=bad",
    "kind=credential",
    "project_id=missing",
    "from=2026-02-30",
    "from=2026-03-01&to=2026-01-01",
    "limit=51",
    "limit=0",
    "page=-1",
    "page=1.1",
    "page=999999999999999999999999",
    "q=a&q=b",
    "q=" + encodeURIComponent("a".repeat(201)),
  ])
    assert.ok(
      [400, 404].includes((await api("/project-archive?" + query)).status),
      query,
    );
  const result = await api("/project-archive?mode=search");
  const raw = JSON.stringify(result);
  for (const banned of [
    "NO-LEAK",
    "PRIVATE-CREDENTIAL",
    "PRIVATE-CONFIG",
    "DO-NOT-EXPOSE",
    "DELETED-SECRET",
    "blob_hash",
    "manifest_json",
    "source_path",
    "details_json",
    "search_text",
    "context_text",
    "path_text",
  ])
    assert.ok(!raw.includes(banned), banned);
  assert.ok(result.notice.includes("不解析文件正文"));
  assert.deepEqual(
    (await api("/project-archive?mode=search", { id: "another-member" })).items,
    result.items,
  );
});
test("timeline uses original business history and distinguishes occurrence from registration", async (t) => {
  const { api, db } = fixture(t);
  const result = await api("/project-archive?mode=timeline&limit=50");
  assert.equal(result.status, 200);
  assert.equal(
    result.items.filter((i) => i.source_type === "milestone").length,
    3,
  );
  assert.ok(result.items.find((i) => i.title === "原始里程碑标题"));
  const achieved = result.items.find(
    (i) => i.event_type === "milestone-achieved",
  );
  assert.equal(achieved.recorded_at, "2026-02-11T00:00:00Z");
  assert.equal(achieved.occurred_on, "");
  assert.equal(achieved.time_basis, "recorded");
  assert.equal(
    result.items.filter((i) => i.source_type === "change").length,
    2,
  );
  const confirmed = result.items.find(
    (i) => i.event_type === "change-confirmed",
  );
  assert.equal(confirmed.title, "确认时变更名称");
  assert.equal(confirmed.occurred_on, "2026-01-05");
  assert.equal(confirmed.recorded_at, "2026-01-06T00:00:00Z");
  const published = result.items.filter((i) => i.source_type === "document");
  assert.equal(published.length, 1);
  assert.equal(published[0].version_id, "d1-v1");
  assert.equal(published[0].recorded_at, "2026-02-01T00:00:00Z");
  assert.ok(
    !result.items.some((i) => i.recorded_at === "2026-12-30T00:00:00Z"),
  );
  assert.equal(
    db
      .prepare("SELECT actual||date untouched FROM records WHERE id='task'")
      .get().untouched,
    "",
  );
  assert.equal(
    db.prepare("SELECT current_version_id FROM documents WHERE id='d1'").get()
      .current_version_id,
    "d1-v2",
  );
});
test("search matches historical filenames and body/people metadata with fixed version navigation", async (t) => {
  const { api } = fixture(t);
  let r = await api(
    "/api/project-archive?mode=search&q=" + encodeURIComponent("原始历史名称"),
  );
  assert.equal(r.total, 1);
  assert.equal(r.items[0].version_id, "d1-v1");
  assert.equal(r.items[0].version_number, 1);
  r = await api(
    "/project-archive?mode=search&q=" + encodeURIComponent("源路径标记"),
  );
  assert.equal(r.total, 2);
  assert.equal(r.items[0].match_hint, "来源路径命中");
  assert.ok(!JSON.stringify(r).includes("C:/"));
  r = await api(
    "/project-archive?mode=search&q=" + encodeURIComponent("关键词在末尾"),
  );
  assert.equal(r.total, 1);
  assert.ok(r.items[0].summary.includes("关键词在末尾"));
  r = await api("/project-archive?mode=search&q=" + encodeURIComponent("张工"));
  assert.ok(r.items.some((i) => i.source_type === "note"));
  for (const q of ["%", "' OR 1=1 --", "_"])
    assert.equal(
      (await api("/project-archive?mode=search&q=" + encodeURIComponent(q)))
        .total,
      0,
    );
});
test("project/type/time filters run before pagination and stable ordering has no gaps", async (t) => {
  const { api } = fixture(t);
  let r = await api("/project-archive?mode=search&project_id=p2");
  assert.equal(r.total, 1);
  assert.ok(r.items.every((i) => i.project_id === "p2"));
  r = await api(
    "/project-archive?mode=search&kind=note&from=2026-01-02&to=2026-01-02",
  );
  assert.deepEqual(
    r.items.map((i) => i.entity_id),
    ["n2"],
  );
  assert.equal(r.items[0].occurred_on, "");
  assert.equal(r.items[0].time_basis, "recorded");
  const all = (await api("/project-archive?mode=search&limit=50")).items;
  const pages = [];
  for (let page = 1; page <= Math.ceil(all.length / 2); page++)
    pages.push(
      ...(await api("/project-archive?mode=search&limit=2&page=" + page)).items,
    );
  assert.deepEqual(
    pages.map((i) => i.id),
    all.map((i) => i.id),
  );
  assert.equal(new Set(pages.map((i) => i.id)).size, all.length);
  assert.equal(
    (await api("/project-archive?mode=search&page=100")).items.length,
    0,
  );
});
test("archive degrades safely when optional modules have no schema, without creating tables", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p','项目');",
  );
  const before = db
    .prepare("SELECT name FROM sqlite_master ORDER BY name")
    .all();
  const r = await createProjectArchive({ db }).api({
    route: "/project-archive",
    method: "GET",
    user: { id: "member" },
  });
  assert.equal(r.data.total, 0);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),
    before,
  );
});

test("new immutable milestone dates and registration in achieved/confirmed state are explicit", async (t) => {
  const { db, api } = fixture(t);
  db.prepare(
    "INSERT INTO project_milestones(id,project_id,title,status,actual_date,created,updated) VALUES('m-new','p1','登记即达成','achieved','2026-06-01','2026-06-02T00:00:00Z','2026-12-31T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO resource_events(request_id,actor_id,actor_login,actor_name,project_id,action,entity_type,entity_id,details_json,created) VALUES('new','u','','成员','p1','create-milestone','milestone','m-new',?,'2026-06-02T00:00:00Z')",
  ).run(
    JSON.stringify({
      title: "登记即达成",
      status: "achieved",
      occurred_on: "2026-05-30",
    }),
  );
  db.prepare(
    "INSERT INTO project_changes(id,project_id,title,requested_scope,creator_id,creator_name,created,updated) VALUES('c-new','p1','登记即确认','调整范围','u','成员','2026-06-02T00:00:00Z','2026-12-31T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO project_change_history(change_id,revision,action,actor_id,actor_name,after_json,created) VALUES('c-new',1,'create','u','成员',?,'2026-06-02T00:00:00Z')",
  ).run(
    JSON.stringify({
      title: "登记即确认",
      requested_scope: "确认调整",
      requested_on: "2026-05-29",
      confirmation_status: "confirmed",
      confirmed_on: "2026-05-31",
    }),
  );
  const all = (await api("/project-archive?limit=50")).items,
    milestone = all.find((i) => i.entity_id === "m-new"),
    change = all.find((i) => i.entity_id === "c-new");
  assert.equal(milestone.event_type, "milestone-achieved");
  assert.equal(milestone.occurred_on, "2026-05-30");
  assert.equal(milestone.time_basis, "occurred");
  assert.ok(milestone.summary.includes("登记时已达成"));
  assert.ok(!milestone.summary.includes("未在该历史"));
  assert.equal(change.event_type, "change-confirmed");
  assert.equal(change.occurred_on, "2026-05-31");
  assert.ok(change.summary.includes("登记并确认"));
});

test("search overview includes the actual hit from original scope or author, without exposing query internals", async (t) => {
  const { api, db } = fixture(t);
  db.prepare(
    "UPDATE project_changes SET original_scope='原约定检索片段' WHERE id='c1'",
  ).run();
  const r = await api(
    "/project-archive?mode=search&q=" + encodeURIComponent("原约定检索片段"),
  );
  assert.equal(r.total, 1);
  assert.ok(r.items[0].summary.includes("原约定检索片段"));
  assert.ok(!JSON.stringify(r).includes("context_text"));
});

test("search finds process notes through the linked file version while hiding unsafe attachments", async (t) => {
  const { db, api } = fixture(t);
  db.prepare(
    "INSERT INTO project_notes(id,project_id,kind,body,author_id,author_name,created,updated) VALUES('legacy-note','p1','file','收到文件后的过程说明','u','成员甲','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')",
  ).run();
  const attach = db.prepare(
    "INSERT INTO project_note_files(note_id,document_id,version_id,created) VALUES(?,?,?,'2026-01-02T00:00:00Z')",
  );
  attach.run("n1", "d1", "d1-v1");
  attach.run("legacy-note", "d1", null);
  attach.run("n1", "sensitive-doc", "sensitive-doc-v1");
  attach.run("n1", "removed-doc", "removed-doc-v1");
  attach.run("n2", "d1", "d1-v1"); // Invalid cross-project legacy link must not expose metadata.
  const search = (q) =>
    api("/project-archive?mode=search&q=" + encodeURIComponent(q));
  let result = await search("原始历史名称");
  assert.equal(result.status, 200);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items
      .filter((i) => i.source_type === "note")
      .map((i) => i.entity_id),
    ["n1"],
  );
  const fixed = result.items.find((i) => i.entity_id === "n1");
  assert.ok(fixed.summary.includes("关联附件：客户正式说明"));
  assert.ok(fixed.summary.includes("当时 V1：原始历史名称.docx"));
  assert.ok(!fixed.summary.includes("现行文件"));
  assert.equal(
    result.items.find((i) => i.source_type === "document").version_id,
    "d1-v1",
  );
  result = await search("现行文件");
  assert.deepEqual(
    result.items
      .filter((i) => i.source_type === "note")
      .map((i) => i.entity_id),
    ["legacy-note"],
  );
  const legacy = result.items.find((i) => i.entity_id === "legacy-note");
  assert.ok(legacy.summary.includes("关联附件：客户正式说明"));
  assert.ok(legacy.summary.includes("未固定版本，仅当前文件名：现行文件.docx"));
  for (const keyword of ["NO-LEAK-sensitive-doc", "NO-LEAK-removed-doc"])
    assert.equal((await search(keyword)).total, 0);
  result = await api("/project-archive?mode=search&kind=note&limit=50");
  assert.ok(!JSON.stringify(result).includes("NO-LEAK"));
  assert.ok(!JSON.stringify(result).includes("C:/"));
  const timeline = await api(
    "/project-archive?mode=timeline&kind=note&limit=50",
  );
  assert.ok(
    !timeline.items
      .find((i) => i.entity_id === "n1")
      .summary.includes("关联附件"),
  );
  db.exec("DROP TABLE project_note_files");
  assert.equal((await search("原始历史名称")).total, 1);
  db.exec(
    "CREATE TABLE project_note_files(note_id TEXT,document_id TEXT,created TEXT,PRIMARY KEY(note_id,document_id)); INSERT INTO project_note_files VALUES('legacy-note','d1','2026-01-02T00:00:00Z')",
  );
  result = await search("现行文件");
  assert.equal(result.status, 200);
  assert.ok(
    result.items
      .find((i) => i.entity_id === "legacy-note")
      .summary.includes("未固定版本"),
  );
});
