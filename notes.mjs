import { randomUUID } from "node:crypto";
import {
  libraryFail as fail,
  libraryTx as tx,
  resourceEvent,
} from "./library-common.mjs";
import { NOTE_KINDS } from "./src/notes.js";
import { splitNames } from "./src/people.js";

const now = () => new Date().toISOString();
const excerpt = (body) => body.replace(/\s+/g, " ").slice(0, 80);
export function installNotesSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_notes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,body TEXT NOT NULL,occurred_on TEXT NOT NULL DEFAULT '',people TEXT NOT NULL DEFAULT '',deliverable_id TEXT REFERENCES document_deliverables(id),task_id TEXT REFERENCES records(id),author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS project_notes_project ON project_notes(project_id,deleted,occurred_on);
    CREATE INDEX IF NOT EXISTS project_notes_deliverable ON project_notes(deliverable_id,deleted);
    CREATE INDEX IF NOT EXISTS project_notes_task ON project_notes(task_id,deleted);
    CREATE TABLE IF NOT EXISTS project_note_files(note_id TEXT NOT NULL REFERENCES project_notes(id),document_id TEXT NOT NULL REFERENCES documents(id),created TEXT NOT NULL,PRIMARY KEY(note_id,document_id));
    CREATE INDEX IF NOT EXISTS project_note_files_document ON project_note_files(document_id);`);
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
        (!/^\d{4}-\d{2}-\d{2}$/.test(occurred) ||
          !Number.isFinite(Date.parse(occurred + "T00:00:00Z")) ||
          new Date(occurred + "T00:00:00Z").toISOString().slice(0, 10) !==
            occurred))
    )
      fail(400, "发生日期无效");
    const people = pick("people", old.people || "");
    if (typeof people !== "string" || people.length > 300)
      fail(400, "相关人员最多 300 字");
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
    };
  }
  function present(n) {
    return {
      ...n,
      deleted: Boolean(n.deleted),
      deliverable_title: n.deliverable_id
        ? get(
            "SELECT title FROM document_deliverables WHERE id=?",
            n.deliverable_id,
          )?.title || ""
        : "",
      task_title: n.task_id
        ? get("SELECT task FROM records WHERE id=?", n.task_id)?.task || ""
        : "",
      files: all(
        "SELECT d.id document_id,d.title,d.deleted,d.current_version_id,v.filename,v.size FROM project_note_files f JOIN documents d ON d.id=f.document_id LEFT JOIN document_versions v ON v.id=d.current_version_id WHERE f.note_id=? ORDER BY f.created,d.title",
        n.id,
      ).map((f) => ({ ...f, deleted: Boolean(f.deleted) })),
    };
  }
  const order =
    "ORDER BY CASE WHEN occurred_on='' THEN date(created,'+8 hours') ELSE occurred_on END DESC,created DESC";
  async function api({ route, method, params, b = {}, user }) {
    route = route.replace(/^\/api(?=\/)/, "");
    const list = route.match(/^\/projects\/([\w-]+)\/notes$/);
    const item = route.match(
      /^\/notes\/([\w-]+)(?:\/(restore|files)(?:\/([\w-]+))?)?$/,
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
      return {
        data: {
          notes: all(
            "SELECT * FROM project_notes WHERE project_id=? AND deleted=? " +
              order,
            list[1],
            deleted,
          ).map(present),
        },
      };
    }
    if (list && method === "POST") {
      const projectId = project(list[1]);
      const f = fields(b, projectId);
      const id = randomUUID(),
        created = now();
      tx(db, () => {
        run(
          "INSERT INTO project_notes(id,project_id,kind,body,occurred_on,people,deliverable_id,task_id,author_id,author_name,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
        );
        event(user, "create-note", { id, project_id: projectId, ...f });
      });
      return { status: 201, data: { note: present(note(id)) } };
    }
    if (!item) fail(405, "不支持的随手记操作");
    const n = note(item[1], true);
    const [, , action, documentId] = item;
    if (!action && method === "PATCH") {
      if (n.deleted) fail(404, "记录不存在或已删除");
      checkVersion(n, b);
      const f = fields(b, n.project_id, n);
      tx(db, () => {
        run(
          "UPDATE project_notes SET kind=?,body=?,occurred_on=?,people=?,deliverable_id=?,task_id=?,version=version+1,updated=? WHERE id=?",
          f.kind,
          f.body,
          f.occurred_on,
          f.people,
          f.deliverable_id,
          f.task_id,
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
        event(user, "delete-note", n);
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
        event(user, "restore-note", n);
      });
      return { data: { note: present(note(n.id)) } };
    }
    if (action === "files") {
      if (n.deleted) fail(404, "记录不存在或已删除");
      // Attachments are their own collection, so linking does not bump the note version.
      if (method === "POST" && !documentId) {
        const d =
          typeof b.document_id === "string" &&
          get(
            "SELECT * FROM documents WHERE id=? AND deleted=0",
            b.document_id,
          );
        if (!d || d.project_id !== n.project_id || d.sensitive)
          fail(400, "只能附加当前项目的非敏感资料");
        tx(db, () => {
          run(
            "INSERT OR IGNORE INTO project_note_files(note_id,document_id,created) VALUES(?,?,?)",
            n.id,
            d.id,
            now(),
          );
          run("UPDATE project_notes SET updated=? WHERE id=?", now(), n.id);
          event(user, "attach-note", n, {
            document_id: d.id,
            filename: d.title,
          });
        });
        return { status: 201, data: { note: present(note(n.id)) } };
      }
      if (method === "DELETE" && documentId) {
        if (
          !get(
            "SELECT 1 FROM project_note_files WHERE note_id=? AND document_id=?",
            n.id,
            documentId,
          )
        )
          fail(404, "附件不存在");
        tx(db, () => {
          run(
            "DELETE FROM project_note_files WHERE note_id=? AND document_id=?",
            n.id,
            documentId,
          );
          event(user, "detach-note", n, { document_id: documentId });
        });
        return { data: { note: present(note(n.id)) } };
      }
    }
    fail(405, "不支持的随手记操作");
  }
  return { api };
}
