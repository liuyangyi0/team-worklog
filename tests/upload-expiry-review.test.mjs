import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createUploads } from "../uploads.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob');
    CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('p1');
    CREATE TABLE document_blobs(sha256 TEXT PRIMARY KEY,size INTEGER);
    CREATE TABLE documents(id TEXT PRIMARY KEY);
    CREATE TABLE document_versions(id TEXT PRIMARY KEY,document_id TEXT);`);
  const temporaryRoot = path.join(
    os.tmpdir(),
    "worklog-expiry-review-" + randomUUID(),
  );
  assert.ok(temporaryRoot.startsWith(os.tmpdir() + path.sep));
  const locks = new Map();
  let gate = null;
  let assemblyCount = 0;
  let completeCount = 0;
  const blob = { sha256: "a".repeat(64), size: 7 };
  const store = {
    maximum: 100,
    quota: 100,
    // No files are created. Cleanup only sees nonexistent, synthetic temp paths.
    uploadDir: (id) => path.join(temporaryRoot, id),
    lock(id, work) {
      const pending = (locks.get(id) || Promise.resolve())
        .catch(() => {})
        .then(work);
      locks.set(id, pending);
      return pending;
    },
    async assemble() {
      assemblyCount++;
      if (gate) {
        const current = gate;
        gate = null;
        current.enter();
        await current.wait;
      }
      return blob;
    },
  };
  const service = createUploads({
    db,
    store,
    project(id) {
      if (id !== "p1")
        throw Object.assign(new Error("missing project"), { status: 404 });
    },
    document() {
      throw new Error("this fixture only creates new documents");
    },
    metadata(b) {
      return { title: b.title || b.filename };
    },
    event() {},
    complete(row, assembled) {
      completeCount++;
      const result = { document_id: randomUUID(), version_id: randomUUID() };
      db.prepare("INSERT INTO document_blobs VALUES(?,?)").run(
        assembled.sha256,
        assembled.size,
      );
      db.prepare("INSERT INTO documents VALUES(?)").run(result.document_id);
      db.prepare("INSERT INTO document_versions VALUES(?,?)").run(
        result.version_id,
        result.document_id,
      );
      db.prepare(
        "UPDATE document_uploads SET status='complete',result_json=? WHERE id=?",
      ).run(JSON.stringify(result), row.id);
      return result;
    },
  });
  const api = async (route, method = "GET", b = {}, actor = "alice") => {
    try {
      const result = await service.api({
        route,
        method,
        b,
        user: actor ? { id: actor } : null,
      });
      return {
        status: result?.status || 200,
        ...result?.data,
        httpStatus: result?.status || 200,
      };
    } catch (error) {
      return { status: error.status || 500, error: error.message };
    }
  };
  async function upload(extra = {}) {
    const body = {
      project_id: "p1",
      filename: "synthetic.txt",
      size: blob.size,
      client_id: randomUUID(),
      ...extra,
    };
    const result = await api("/uploads", "POST", body);
    assert.equal(result.httpStatus, 201, JSON.stringify(result));
    db.prepare(
      "INSERT INTO document_upload_parts(upload_id,part,size,sha256) VALUES(?,0,?,?)",
    ).run(result.id, body.size, blob.sha256);
    return { ...result, body };
  }
  function holdAssembly() {
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    gate = { enter, wait };
    return { entered, release };
  }
  const state = () => ({
    documents: db.prepare("SELECT COUNT(*) n FROM documents").get().n,
    versions: db.prepare("SELECT COUNT(*) n FROM document_versions").get().n,
    orphanBytes: db
      .prepare("SELECT COALESCE(SUM(size),0) n FROM document_blob_orphans")
      .get().n,
    assemblyCount,
    completeCount,
  });
  return { db, api, service, upload, holdAssembly, state };
}

test("expiry review: cleanup cannot expose expired and later let an in-flight assembly commit a document", async (t) => {
  const { db, api, service, upload, holdAssembly, state } = fixture(t);
  const original = await upload();
  const gate = holdAssembly();
  const completing = api(`/uploads/${original.id}/complete`, "POST");
  await gate.entered;
  db.prepare("UPDATE document_uploads SET expires=? WHERE id=?").run(
    "2000-01-01T00:00:00Z",
    original.id,
  );
  const cleaning = service.cleanup();
  const during = await api(`/uploads/${original.id}`);
  assert.equal(during.status, "expired");
  gate.release();
  const completed = await completing;
  assert.equal(completed.status, 409);
  await cleaning;
  assert.deepEqual(state(), {
    documents: 0,
    versions: 0,
    orphanBytes: 7,
    assemblyCount: 1,
    completeCount: 0,
  });
  assert.equal(
    db
      .prepare("SELECT status FROM document_uploads WHERE id=?")
      .get(original.id).status,
    "expired",
  );
  const quota = await api("/uploads", "POST", {
    project_id: "p1",
    filename: "quota.txt",
    size: 94,
    client_id: randomUUID(),
  });
  assert.equal(
    quota.status,
    413,
    "assembled orphan must remain counted against storage quota",
  );
});

test("expiry review: crossing the expiry timestamp during assembly also rejects without relying on cleanup", async (t) => {
  const { db, api, upload, holdAssembly, state } = fixture(t);
  const original = await upload();
  const gate = holdAssembly();
  const completing = api(`/uploads/${original.id}/complete`, "POST");
  await gate.entered;
  db.prepare("UPDATE document_uploads SET expires=? WHERE id=?").run(
    "2000-01-01T00:00:00Z",
    original.id,
  );
  const during = await api(`/uploads/${original.id}`);
  assert.equal(during.status, "expired");
  assert.equal(
    db
      .prepare("SELECT status FROM document_uploads WHERE id=?")
      .get(original.id).status,
    "active",
    "summary projection need not mutate storage state",
  );
  gate.release();
  assert.equal((await completing).status, 409);
  assert.equal(state().orphanBytes, 7);
  assert.equal(state().documents, 0);
  assert.equal(state().completeCount, 0);
});

test("expiry review: completed session replay survives old expiry without another assembly, quota reservation or document", async (t) => {
  const { db, api, upload, state } = fixture(t);
  const original = await upload();
  const completed = await api(`/uploads/${original.id}/complete`, "POST");
  assert.equal(completed.status, 201);
  db.prepare("UPDATE document_uploads SET expires=? WHERE id=?").run(
    "2000-01-01T00:00:00Z",
    original.id,
  );
  const directReplay = await api(`/uploads/${original.id}/complete`, "POST");
  assert.equal(directReplay.status, 200);
  assert.equal(directReplay.document_id, completed.document_id);
  const createReplay = await api("/uploads", "POST", original.body);
  assert.equal(createReplay.status, "complete");
  assert.equal(createReplay.id, original.id);
  assert.equal(createReplay.result.document_id, completed.document_id);
  assert.deepEqual(state(), {
    documents: 1,
    versions: 1,
    orphanBytes: 0,
    assemblyCount: 1,
    completeCount: 1,
  });
  assert.equal(
    (await api(`/uploads/${original.id}/cancel`, "POST")).status,
    409,
  );
});

test("expiry review: cancellation and actor authentication stay enforced before assembly", async (t) => {
  const { api, upload, state } = fixture(t);
  const original = await upload();
  assert.equal(
    (await api(`/uploads/${original.id}`, "GET", {}, "bob")).status,
    404,
  );
  assert.equal(
    (await api(`/uploads/${original.id}/complete`, "POST", {}, "bob")).status,
    404,
  );
  assert.equal(
    (await api(`/uploads/${original.id}/complete`, "POST", {}, null)).status,
    401,
  );
  assert.equal(
    (await api(`/uploads/${original.id}/cancel`, "POST")).status,
    200,
  );
  assert.equal((await api(`/uploads/${original.id}`)).status, "cancelled");
  assert.equal(
    (await api(`/uploads/${original.id}/complete`, "POST")).status,
    409,
  );
  assert.deepEqual(state(), {
    documents: 0,
    versions: 0,
    orphanBytes: 0,
    assemblyCount: 0,
    completeCount: 0,
  });
});
