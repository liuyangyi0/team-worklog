import { randomUUID } from "node:crypto";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
} from "./library-common.mjs";
import { NOTE_KINDS, fileDirection } from "./src/notes.js";
import { splitNames } from "./src/people.js";

const now = () => new Date().toISOString();
const excerpt = (body) => body.replace(/\s+/g, " ").slice(0, 80);
export function installNotesSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_notes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,body TEXT NOT NULL,occurred_on TEXT NOT NULL DEFAULT '',people TEXT NOT NULL DEFAULT '',deliverable_id TEXT REFERENCES document_deliverables(id),task_id TEXT REFERENCES records(id),author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL,parent_note_id TEXT REFERENCES project_notes(id),file_direction TEXT NOT NULL DEFAULT '',counterparty TEXT NOT NULL DEFAULT '',exchange_time TEXT NOT NULL DEFAULT '',channel TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS project_notes_project ON project_notes(project_id,deleted,occurred_on);
    CREATE INDEX IF NOT EXISTS project_notes_deliverable ON project_notes(deliverable_id,deleted);
    CREATE INDEX IF NOT EXISTS project_notes_task ON project_notes(task_id,deleted);
    CREATE TABLE IF NOT EXISTS project_note_files(note_id TEXT NOT NULL REFERENCES project_notes(id),document_id TEXT NOT NULL REFERENCES documents(id),created TEXT NOT NULL,version_id TEXT REFERENCES document_versions(id),link_version TEXT,PRIMARY KEY(note_id,document_id));
    CREATE INDEX IF NOT EXISTS project_note_files_document ON project_note_files(document_id);`);
  const columns = (table) =>
    db
      .prepare("PRAGMA table_info(" + table + ")")
      .all()
      .map((c) => c.name);
  const noteColumns = columns("project_notes");
  if (!noteColumns.includes("parent_note_id"))
    db.exec(
      "ALTER TABLE project_notes ADD COLUMN parent_note_id TEXT REFERENCES project_notes(id)",
    );
  for (const column of [
    "file_direction",
    "counterparty",
    "exchange_time",
    "channel",
  ])
    if (!noteColumns.includes(column))
      db.exec(
        "ALTER TABLE project_notes ADD COLUMN " +
          column +
          " TEXT NOT NULL DEFAULT ''",
      );
  const fileColumns = columns("project_note_files");
  if (!fileColumns.includes("version_id"))
    db.exec(
      "ALTER TABLE project_note_files ADD COLUMN version_id TEXT REFERENCES document_versions(id)",
    );
  if (!fileColumns.includes("link_version"))
    db.exec("ALTER TABLE project_note_files ADD COLUMN link_version TEXT");
  // A migration token protects later corrections without inventing a historical version.
  db.exec(`UPDATE project_note_files SET link_version=lower(hex(randomblob(16))) WHERE link_version IS NULL;
    CREATE INDEX IF NOT EXISTS project_notes_parent ON project_notes(parent_note_id,deleted);
    CREATE TRIGGER IF NOT EXISTS project_notes_parent_immutable BEFORE UPDATE OF parent_note_id ON project_notes
      WHEN NEW.parent_note_id IS NOT OLD.parent_note_id BEGIN SELECT RAISE(ABORT,'Note parent is immutable'); END;`);
}
export function createNotes({ db }) {
  installNotesSchema(db);
  const get = (sql, ...values) => db.prepare(sql).get(...values);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  const event = (user, action, note, details = {}) =>
    resourceEvent(db, user, {
      action,
      entityType: "note",
      entityId: note.id,
      projectId: note.project_id,
      details: { title: excerpt(note.body), kind: note.kind, ...details },
    });
  const project = (id) => {
    if (
      typeof id !== "string" ||
      !get("SELECT id FROM projects WHERE id=?", id)
    )
      fail(404, "项目不存在");
    return id;
  };
  const note = (id, deleted = false) => {
    const n = get("SELECT * FROM project_notes WHERE id=?", id);
    if (!n || (!deleted && n.deleted)) fail(404, "记录不存在或已删除");
    return n;
  };
  const checkVersion = (n, b) => {
    if (!Number.isInteger(b.version) || b.version !== n.version)
      fail(409, "这条随手记已被修改，请刷新后重试");
  };
  function fields(b, projectId, old = {}) {
    const pick = (key, fallback) => (b[key] === undefined ? fallback : b[key]);
    const kind = pick("kind", old.kind || "other");
    if (!NOTE_KINDS.some((k) => k.id === kind)) fail(400, "记录类型无效");
    const body = pick("body", old.body || "");
    if (typeof body !== "string" || !body.trim() || body.trim().length > 4000)
      fail(400, "请填写内容，最多 4000 字");
    const occurred = pick("occurred_on", old.occurred_on || "");
    if (
      typeof occurred !== "string" ||
      (occurred &&
        (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(occurred) ||
          !Number.isFinite(Date.parse(occurred + "T00:00:00Z")) ||
          new Date(occurred + "T00:00:00Z").toISOString().slice(0, 10) !==
            occurred))
    )
      fail(400, "发生日期无效");
    const people = pick("people", old.people || "");
    if (typeof people !== "string" || people.length > 300)
      fail(400, "相关人员最多 300 字");
    const exchange = {
      file_direction: "",
      counterparty: "",
      exchange_time: "",
      channel: "",
    };
    if (kind === "file") {
      for (const [key, maximum, label] of [
        ["file_direction", 8, "收发方向"],
        ["counterparty", 200, "往来方"],
        ["exchange_time", 5, "收发时间"],
        ["channel", 100, "收发渠道"],
      ]) {
        const value = pick(key, old[key] || "");
        if (
          typeof value !== "string" ||
          value.length > maximum ||
          /\x00/.test(value)
        )
          fail(400, label + "无效，最多 " + maximum + " 字");
        exchange[key] = ["counterparty", "channel"].includes(key)
          ? value.trim()
          : value;
      }
      if (exchange.file_direction && !fileDirection(exchange.file_direction))
        fail(400, "收发方向无效");
      if (
        exchange.exchange_time &&
        (!/^([01]\d|2[0-3]):[0-5]\d$/.test(exchange.exchange_time) || !occurred)
      )
        fail(400, "收发时间应为北京时间 HH:mm，且须先填写发生日期");
    } else if (
      Object.keys(exchange).some((key) => b[key] !== undefined && b[key] !== "")
    )
      fail(400, "只有文件收发记录可以填写收发信息");
    const deliverableId =
      pick("deliverable_id", old.deliverable_id || null) || null;
    if (
      deliverableId &&
      (typeof deliverableId !== "string" ||
        !get(
          "SELECT id FROM document_deliverables WHERE id=? AND project_id=? AND (deleted=0 OR id=?)",
          deliverableId,
          projectId,
          old.deliverable_id || "",
        ))
    )
      fail(400, "关联的资料项无效或不属于该项目");
    const taskId = pick("task_id", old.task_id || null) || null;
    if (
      taskId &&
      (typeof taskId !== "string" ||
        !get(
          "SELECT id FROM records WHERE id=? AND project_id=? AND (deleted=0 OR id=?)",
          taskId,
          projectId,
          old.task_id || "",
        ))
    )
      fail(400, "关联任务无效或不属于该项目");
    return {
      kind,
      body: body.trim(),
      occurred_on: occurred,
      people: splitNames(people).join("、"),
      deliverable_id: deliverableId,
      task_id: taskId,
      ...exchange,
    };
  }
  const rootId = (n) => n.parent_note_id || n.id;
  const snapshot = (n) => ({
    id: n.id,
    project_id: n.project_id,
    kind: n.kind,
    body: n.body,
    occurred_on: n.occurred_on,
    file_direction: n.file_direction,
    counterparty: n.counterparty,
    exchange_time: n.exchange_time,
    channel: n.channel,
    people: n.people,
    deliverable_id: n.deliverable_id,
    task_id: n.task_id,
    author_id: n.author_id,
    author_name: n.author_name,
    parent_note_id: n.parent_note_id,
    thread_root_id: rootId(n),
    version: n.version,
    deleted: Boolean(n.deleted),
    created: n.created,
    updated: n.updated,
  });
  const files = (noteId) =>
    all(
      `SELECT d.id document_id,d.title,d.deleted,d.current_version_id,
      f.version_id,f.link_version,f.created,v.number,v.filename,v.size,
      CASE WHEN f.version_id IS NULL THEN 'unfixed' ELSE 'fixed' END reference_mode
      FROM project_note_files f JOIN documents d ON d.id=f.document_id
      LEFT JOIN document_versions v ON v.id=COALESCE(f.version_id,d.current_version_id) AND v.document_id=d.id
      WHERE f.note_id=? ORDER BY f.created,d.title,d.id`,
      noteId,
    ).map((f) => ({ ...f, deleted: Boolean(f.deleted) }));
  const file = (noteId, documentId) =>
    files(noteId).find((f) => f.document_id === documentId);
  const link = (noteId, documentId) =>
    get(
      "SELECT * FROM project_note_files WHERE note_id=? AND document_id=?",
      noteId,
      documentId,
    );
  const checkLinkVersion = (f, body) => {
    if (
      typeof body.link_version !== "string" ||
      body.link_version !== f.link_version
    )
      fail(409, "附件引用已被修改，请刷新后重试");
  };
  const attachmentDocument = (documentId, projectId) => {
    const d =
      typeof documentId === "string" &&
      get("SELECT * FROM documents WHERE id=? AND deleted=0", documentId);
    if (!d || d.project_id !== projectId || d.sensitive)
      fail(400, "只能附加当前项目的非敏感资料");
    return d;
  };
  const attachmentVersion = (d, versionId) => {
    const v =
      typeof versionId === "string" &&
      get(
        "SELECT * FROM document_versions WHERE id=? AND document_id=?",
        versionId,
        d.id,
      );
    if (!v) fail(400, "附件版本无效或不属于该资料");
    if (
      v.conflict &&
      v.id !== d.current_version_id &&
      v.id !== d.published_version_id
    )
      fail(409, "请先采用待合并版本，再关联到随手记");
    return v;
  };
  function present(n) {
    const root = rootId(n);
    const counts = get(
      "SELECT SUM(CASE WHEN deleted=0 THEN 1 ELSE 0 END) active,SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) removed FROM project_notes WHERE project_id=? AND (id=? OR parent_note_id=?)",
      n.project_id,
      root,
      root,
    );
    return {
      ...n,
      deleted: Boolean(n.deleted),
      thread_root_id: root,
      thread_count: counts.active || 0,
      thread_deleted_count: counts.removed || 0,
      deliverable_title: n.deliverable_id
        ? get(
            "SELECT title FROM document_deliverables WHERE id=?",
            n.deliverable_id,
          )?.title || ""
        : "",
      task_title: n.task_id
        ? get("SELECT task FROM records WHERE id=?", n.task_id)?.task || ""
        : "",
      files: files(n.id),
    };
  }
  const order =
    "ORDER BY CASE WHEN occurred_on='' THEN date(created,'+8 hours') ELSE occurred_on END DESC,created DESC";
  async function api({ route, method, params, b = {}, user }) {
    route = route.replace(/^\/api(?=\/)/, "");
    const list = route.match(/^\/projects\/([\w-]+)\/notes$/);
    const item = route.match(
      /^\/notes\/([\w-]+)(?:\/(restore|files|thread)(?:\/([\w-]+))?)?$/,
    );
    const materials = route.match(/^\/records\/([\w-]+)\/materials$/);
    if (!list && !item && !materials) return null;
    if (!user) fail(401, "请先登录后查看随手记");
    if (materials && method === "GET") {
      const task = get(
        "SELECT id,project_id FROM records WHERE id=? AND deleted=0",
        materials[1],
      );
      if (!task) fail(404, "任务不存在或已删除");
      return {
        data: {
          documents: all(
            "SELECT d.id,d.title,d.category,d.current_version_id,d.published_version_id,v.filename,v.size FROM documents d LEFT JOIN document_versions v ON v.id=d.current_version_id WHERE d.task_id=? AND d.deleted=0 AND d.sensitive=0 ORDER BY d.updated DESC",
            task.id,
          ),
          notes: all(
            "SELECT * FROM project_notes WHERE task_id=? AND deleted=0 " +
              order,
            task.id,
          ).map(present),
        },
      };
    }
    if (list && method === "GET") {
      project(list[1]);
      const deleted = params?.get("deleted") === "1" ? 1 : 0;
      const direction = params?.get("file_direction");
      if (
        (params?.getAll("file_direction").length || 0) > 1 ||
        (direction != null &&
          !["received", "sent", "unclassified"].includes(direction))
      )
        fail(400, "收发方向筛选无效");
      const filters =
        direction == null ? "" : " AND kind='file' AND file_direction=?";
      const values = [list[1], deleted];
      if (direction != null)
        values.push(direction === "unclassified" ? "" : direction);
      return {
        data: {
          notes: all(
            "SELECT * FROM project_notes WHERE project_id=? AND deleted=?" +
              filters +
              " " +
              order,
            ...values,
          ).map(present),
        },
      };
    }
    if (list && method === "POST") {
      const projectId = project(list[1]);
      const f = fields(b, projectId);
      let parentId = b.parent_note_id === undefined ? null : b.parent_note_id;
      if (parentId !== null) {
        const parent =
          typeof parentId === "string" &&
          get(
            "SELECT * FROM project_notes WHERE id=? AND project_id=? AND deleted=0",
            parentId,
            projectId,
          );
        if (!parent) fail(400, "补充的原记录无效或已删除");
        const root = note(rootId(parent), true);
        if (root.project_id !== projectId || root.parent_note_id)
          fail(400, "原记录的事项关系无效");
        parentId = root.id;
      }
      if (b.thread_root_id !== undefined) fail(400, "事项根记录由系统确定");
      const id = randomUUID(),
        created = now();
      tx(db, () => {
        run(
          "INSERT INTO project_notes(id,project_id,kind,body,occurred_on,people,deliverable_id,task_id,author_id,author_name,created,updated,parent_note_id,file_direction,counterparty,exchange_time,channel) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          projectId,
          f.kind,
          f.body,
          f.occurred_on,
          f.people,
          f.deliverable_id,
          f.task_id,
          user.id,
          user.name,
          created,
          created,
          parentId,
          f.file_direction,
          f.counterparty,
          f.exchange_time,
          f.channel,
        );
        const saved = note(id);
        event(user, "create-note", saved, {
          before: null,
          after: snapshot(saved),
        });
      });
      return { status: 201, data: { note: present(note(id)) } };
    }
    if (!item) fail(405, "不支持的随手记操作");
    const n = note(item[1], true);
    const [, , action, documentId] = item;
    if (!action && method === "GET") return { data: { note: present(n) } };
    if (action === "thread" && !documentId && method === "GET") {
      const root = note(rootId(n), true);
      return {
        data: {
          root: present(root),
          notes: all(
            "SELECT * FROM project_notes WHERE project_id=? AND (id=? OR parent_note_id=?) ORDER BY CASE WHEN occurred_on='' THEN date(created,'+8 hours') ELSE occurred_on END,created,id",
            n.project_id,
            root.id,
            root.id,
          ).map(present),
        },
      };
    }
    if (!action && method === "PATCH") {
      if (n.deleted) fail(404, "记录不存在或已删除");
      checkVersion(n, b);
      if (
        (b.parent_note_id !== undefined &&
          b.parent_note_id !== n.parent_note_id) ||
        (b.thread_root_id !== undefined && b.thread_root_id !== rootId(n))
      )
        fail(400, "记录创建后不能更改所属事项");
      const f = fields(b, n.project_id, n);
      tx(db, () => {
        run(
          "UPDATE project_notes SET kind=?,body=?,occurred_on=?,people=?,deliverable_id=?,task_id=?,file_direction=?,counterparty=?,exchange_time=?,channel=?,version=version+1,updated=? WHERE id=?",
          f.kind,
          f.body,
          f.occurred_on,
          f.people,
          f.deliverable_id,
          f.task_id,
          f.file_direction,
          f.counterparty,
          f.exchange_time,
          f.channel,
          now(),
          n.id,
        );
        // Keep the previous wording in the immutable log so edits never erase history.
        event(
          user,
          "update-note",
          { ...n, ...f },
          {
            ...(f.body !== n.body ? { from: n.body, to: f.body } : {}),
            before: snapshot(n),
            after: snapshot(note(n.id)),
          },
        );
      });
      return { data: { note: present(note(n.id)) } };
    }
    if (!action && method === "DELETE") {
      if (n.deleted) fail(404, "记录不存在或已删除");
      checkVersion(n, b);
      tx(db, () => {
        run(
          "UPDATE project_notes SET deleted=1,version=version+1,updated=? WHERE id=?",
          now(),
          n.id,
        );
        event(user, "delete-note", n, {
          before: snapshot(n),
          after: snapshot(note(n.id, true)),
        });
      });
      return { data: { ok: true, version: n.version + 1 } };
    }
    if (action === "restore" && method === "POST") {
      if (!n.deleted) fail(409, "记录未删除");
      checkVersion(n, b);
      tx(db, () => {
        run(
          "UPDATE project_notes SET deleted=0,version=version+1,updated=? WHERE id=?",
          now(),
          n.id,
        );
        event(user, "restore-note", n, {
          before: snapshot(n),
          after: snapshot(note(n.id)),
        });
      });
      return { data: { note: present(note(n.id)) } };
    }
    if (action === "files") {
      if (n.deleted) fail(404, "记录不存在或已删除");
      // Attachments are their own collection, so linking does not bump the note version.
      if (method === "POST" && !documentId) {
        const d = attachmentDocument(b.document_id, n.project_id);
        // Retries never change an existing association, even after a new upload.
        if (link(n.id, d.id))
          return { status: 201, data: { note: present(note(n.id)) } };
        const v = attachmentVersion(
          d,
          b.version_id === undefined ? d.current_version_id : b.version_id,
        );
        tx(db, () => {
          run(
            "INSERT INTO project_note_files(note_id,document_id,created,version_id,link_version) VALUES(?,?,?,?,?)",
            n.id,
            d.id,
            now(),
            v.id,
            randomUUID(),
          );
          run("UPDATE project_notes SET updated=? WHERE id=?", now(), n.id);
          event(user, "attach-note", n, {
            document_id: d.id,
            version_id: v.id,
            filename: v.filename,
            before: null,
            after: file(n.id, d.id),
          });
        });
        return { status: 201, data: { note: present(note(n.id)) } };
      }
      if (method === "PATCH" && documentId) {
        const old = link(n.id, documentId);
        if (!old) fail(404, "附件不存在");
        checkLinkVersion(old, b);
        const d = attachmentDocument(documentId, n.project_id);
        const v = attachmentVersion(d, b.version_id);
        if (old.version_id === v.id)
          return { data: { note: present(note(n.id)) } };
        tx(db, () => {
          const before = file(n.id, documentId);
          const result = run(
            "UPDATE project_note_files SET version_id=?,link_version=? WHERE note_id=? AND document_id=? AND link_version=?",
            v.id,
            randomUUID(),
            n.id,
            documentId,
            b.link_version,
          );
          if (!result.changes) fail(409, "附件引用已被修改，请刷新后重试");
          run("UPDATE project_notes SET updated=? WHERE id=?", now(), n.id);
          event(user, "update-note-file", n, {
            document_id: documentId,
            version_id: v.id,
            before,
            after: file(n.id, documentId),
          });
        });
        return { data: { note: present(note(n.id)) } };
      }
      if (method === "DELETE" && documentId) {
        const old = link(n.id, documentId);
        if (!old) fail(404, "附件不存在");
        if (b.link_version !== undefined) checkLinkVersion(old, b);
        tx(db, () => {
          const before = file(n.id, documentId);
          run(
            "DELETE FROM project_note_files WHERE note_id=? AND document_id=?",
            n.id,
            documentId,
          );
          run("UPDATE project_notes SET updated=? WHERE id=?", now(), n.id);
          event(user, "detach-note", n, {
            document_id: documentId,
            before,
            after: null,
          });
        });
        return { data: { note: present(note(n.id)) } };
      }
    }
    fail(405, "不支持的随手记操作");
  }
  return { api };
}
