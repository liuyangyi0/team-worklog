import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createProjectArchive } from "../project-archive.mjs";
function fixture(t, { legacy = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p1','文件项目甲'),('p2','文件项目乙'); CREATE TABLE project_notes(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,body TEXT,people TEXT DEFAULT '',author_name TEXT DEFAULT '',occurred_on TEXT DEFAULT '',created TEXT,updated TEXT,deleted INTEGER DEFAULT 0" +
      (legacy
        ? ""
        : ",file_direction TEXT DEFAULT '',counterparty TEXT DEFAULT '',exchange_time TEXT DEFAULT '',channel TEXT DEFAULT ''") +
      ");",
  );
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
  for (const row of [
    {
      id: "received",
      project_id: "p1",
      kind: "file",
      body: "客户文件进入现场",
      occurred_on: "2026-02-10",
      created: "2026-02-11T01:00:00Z",
      file_direction: "received",
      counterparty: "VendorAlpha",
      exchange_time: "09:30",
      channel: "邮件Alpha",
    },
    {
      id: "sent",
      project_id: "p1",
      kind: "file",
      body: "补充材料已经提供",
      occurred_on: "2026-02-10",
      created: "2026-02-12T01:00:00Z",
      file_direction: "sent",
      counterparty: "CustomerBeta",
      exchange_time: "16:45",
      channel: "专用群Beta",
    },
    {
      id: "unclassified",
      project_id: "p1",
      kind: "file",
      body: "旧的文件转存记录",
      occurred_on: "",
      created: "2026-03-01T18:00:00Z",
      file_direction: "",
      counterparty: "",
      exchange_time: "",
      channel: "",
    },
    {
      id: "other-project",
      project_id: "p2",
      kind: "file",
      body: "其他项目收到资料",
      occurred_on: "2026-02-10",
      created: "2026-02-13T01:00:00Z",
      file_direction: "received",
      counterparty: "Elsewhere",
      exchange_time: "",
      channel: "",
    },
    {
      id: "ordinary",
      project_id: "p1",
      kind: "site",
      body: "非文件类现场记录",
      occurred_on: "2026-02-10",
      created: "2026-02-14T01:00:00Z",
      file_direction: "received",
      counterparty: "SHOULD-NOT-INDEX",
      exchange_time: "10:00",
      channel: "SHOULD-NOT-INDEX",
    },
  ]) {
    const data = { ...row, updated: "2026-12-31T00:00:00Z" };
    if (legacy)
      for (const key of [
        "file_direction",
        "counterparty",
        "exchange_time",
        "channel",
      ])
        delete data[key];
    insert("project_notes", data);
  }
  if (!legacy) {
    db.exec(
      "CREATE TABLE documents(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,description TEXT DEFAULT '',tags TEXT DEFAULT '[]',owner TEXT DEFAULT '',category TEXT DEFAULT '',source_path TEXT DEFAULT '',current_version_id TEXT,deleted INTEGER DEFAULT 0,sensitive INTEGER DEFAULT 0); CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT,number INTEGER,filename TEXT,created TEXT); CREATE TABLE project_note_files(note_id TEXT,document_id TEXT,version_id TEXT,created TEXT,PRIMARY KEY(note_id,document_id));",
    );
    insert("documents", {
      id: "document",
      project_id: "p1",
      title: "正式交付资料",
      current_version_id: "version2",
    });
    insert("documents", {
      id: "secret",
      project_id: "p1",
      title: "EXCHANGE-SENSITIVE-TITLE",
      current_version_id: "secret-version",
      sensitive: 1,
    });
    insert("document_versions", {
      id: "version1",
      document_id: "document",
      number: 1,
      filename: "互查历史来源.docx",
      created: "2026-02-01T00:00:00Z",
    });
    insert("document_versions", {
      id: "version2",
      document_id: "document",
      number: 2,
      filename: "互查工作版本.docx",
      created: "2026-02-02T00:00:00Z",
    });
    insert("document_versions", {
      id: "secret-version",
      document_id: "secret",
      number: 1,
      filename: "EXCHANGE-SENSITIVE-FILENAME",
      created: "2026-02-02T00:00:00Z",
    });
    insert("project_note_files", {
      note_id: "received",
      document_id: "document",
      version_id: "version1",
      created: "2026-02-11T00:00:00Z",
    });
    insert("project_note_files", {
      note_id: "unclassified",
      document_id: "document",
      version_id: null,
      created: "2026-02-11T00:00:00Z",
    });
    insert("project_note_files", {
      note_id: "sent",
      document_id: "secret",
      version_id: "secret-version",
      created: "2026-02-11T00:00:00Z",
    });
  }
  const service = createProjectArchive({ db });
  t.after(() => db.close());
  const api = async (query = "", user = { id: "member" }) => {
    const url = new URL("/project-archive?" + query, "http://archive.test");
    try {
      const r = await service.api({
        route: url.pathname,
        method: "GET",
        params: url.searchParams,
        user,
      });
      return { status: r.status || 200, ...r.data };
    } catch (e) {
      return { status: e.status || 500, error: e.message };
    }
  };
  return { db, api };
}
test("archive direction filters restrict both modes to matching file notes before pagination", async (t) => {
  const { api } = fixture(t);
  for (const mode of ["search", "timeline"]) {
    let r = await api("mode=" + mode + "&file_direction=received&limit=1");
    assert.equal(r.status, 200);
    assert.equal(r.total, 2);
    assert.equal(r.items.length, 1);
    assert.ok(
      r.items.every(
        (i) =>
          i.source_type === "note" &&
          i.note_kind === "file" &&
          i.file_direction === "received",
      ),
    );
    const page2 = await api(
      "mode=" + mode + "&file_direction=received&limit=1&page=2",
    );
    assert.notEqual(page2.items[0].id, r.items[0].id);
    r = await api(
      "mode=" + mode + "&project_id=p1&kind=note&file_direction=received",
    );
    assert.deepEqual(
      r.items.map((i) => i.entity_id),
      ["received"],
    );
    r = await api("mode=" + mode + "&file_direction=sent");
    assert.deepEqual(
      r.items.map((i) => i.entity_id),
      ["sent"],
    );
    r = await api("mode=" + mode + "&file_direction=unclassified");
    assert.deepEqual(
      r.items.map((i) => i.entity_id),
      ["unclassified"],
    );
    assert.equal(r.items[0].file_direction, "");
  }
});
test("archive validates file direction boundaries and keeps authentication first", async (t) => {
  const { api } = fixture(t);
  for (const query of [
    "file_direction=unknown",
    "file_direction=Received",
    "file_direction=received&file_direction=sent",
    "file_direction=&file_direction=",
    "kind=document&file_direction=received",
    "kind=delivery&file_direction=unclassified",
  ])
    assert.equal((await api(query)).status, 400, query);
  assert.equal((await api("file_direction=unknown", null)).status, 401);
  assert.equal(
    (
      await api(
        "file_direction=received&q=" + encodeURIComponent("a".repeat(201)),
      )
    ).status,
    400,
  );
});
test("archive indexes exchange parties and channels while projecting safe business fields", async (t) => {
  const { api, db } = fixture(t);
  for (const [keyword, id] of [
    ["vendoralpha", "received"],
    ["邮件Alpha", "received"],
    ["CustomerBeta", "sent"],
    ["专用群Beta", "sent"],
    ["16:45", "sent"],
  ]) {
    const r = await api("mode=search&q=" + encodeURIComponent(keyword));
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.items.map((i) => i.entity_id),
      [id],
    );
    assert.ok(r.items[0].summary.toLowerCase().includes(keyword.toLowerCase()));
  }
  const received = (
    await api("mode=timeline&file_direction=received&project_id=p1")
  ).items[0];
  assert.equal(received.note_kind, "file");
  assert.equal(received.file_direction, "received");
  assert.equal(received.counterparty, "VendorAlpha");
  assert.equal(received.exchange_time, "09:30");
  assert.equal(received.channel, "邮件Alpha");
  assert.equal(received.occurred_on, "2026-02-10");
  assert.equal(received.recorded_at, "2026-02-11T01:00:00Z");
  assert.equal(received.time_basis, "occurred");
  let r = await api(
    "mode=search&file_direction=unclassified&from=2026-03-02&to=2026-03-02",
  );
  assert.equal(r.total, 1);
  assert.equal(r.items[0].occurred_on, "");
  assert.equal(r.items[0].exchange_time, "");
  assert.equal(r.items[0].time_basis, "recorded");
  assert.equal((await api("mode=search&q=SHOULD-NOT-INDEX")).total, 0);
  const ordinary = (await api("mode=search&kind=note&limit=50")).items.find(
    (i) => i.entity_id === "ordinary",
  );
  for (const key of [
    "file_direction",
    "counterparty",
    "exchange_time",
    "channel",
  ])
    assert.equal(ordinary[key], "");
  assert.equal(
    db
      .prepare("SELECT current_version_id FROM documents WHERE id='document'")
      .get().current_version_id,
    "version2",
  );
  assert.equal(
    db.prepare("SELECT updated FROM project_notes WHERE id='received'").get()
      .updated,
    "2026-12-31T00:00:00Z",
  );
});
test("exchange filters preserve fixed attachment provenance and exclude sensitive file metadata", async (t) => {
  const { api } = fixture(t);
  let r = await api(
    "mode=search&file_direction=received&q=" +
      encodeURIComponent("互查历史来源"),
  );
  assert.equal(r.total, 1);
  assert.equal(r.items[0].entity_id, "received");
  assert.ok(r.items[0].summary.includes("当时 V1"));
  assert.equal(
    (
      await api(
        "mode=search&file_direction=received&q=" +
          encodeURIComponent("互查工作版本"),
      )
    ).total,
    0,
  );
  r = await api(
    "mode=search&file_direction=unclassified&q=" +
      encodeURIComponent("互查工作版本"),
  );
  assert.equal(r.total, 1);
  assert.ok(r.items[0].summary.includes("未固定版本"));
  for (const q of ["EXCHANGE-SENSITIVE-TITLE", "EXCHANGE-SENSITIVE-FILENAME"])
    assert.equal(
      (await api("mode=search&file_direction=sent&q=" + q)).total,
      0,
    );
});
test("legacy note schemas keep file exchanges unclassified without guessing missing business values", async (t) => {
  const { api } = fixture(t, { legacy: true });
  for (const mode of ["search", "timeline"]) {
    assert.equal(
      (await api("mode=" + mode + "&file_direction=received")).total,
      0,
    );
    assert.equal((await api("mode=" + mode + "&file_direction=sent")).total, 0);
    const r = await api("mode=" + mode + "&file_direction=unclassified");
    assert.equal(r.status, 200);
    assert.equal(r.total, 4);
    assert.ok(
      r.items.every((i) => i.source_type === "note" && i.note_kind === "file"),
    );
    for (const item of r.items)
      for (const key of [
        "file_direction",
        "counterparty",
        "exchange_time",
        "channel",
      ])
        assert.equal(item[key], "");
  }
});
