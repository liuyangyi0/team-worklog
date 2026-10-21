import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const dir = process.env.DATA_DIR || "data";
const folder = path.join(dir, "backups");
fs.mkdirSync(folder, { recursive: true });
const db = new DatabaseSync(path.join(dir, "worklog.sqlite"));
const name =
  "worklog-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite";
await backup(db, path.join(folder, name));
db.close();
const files = fs
  .readdirSync(folder)
  .filter((x) => /^worklog-.*\.sqlite$/.test(x))
  .sort();
for (const old of files.slice(0, -30)) fs.unlinkSync(path.join(folder, old));
console.log("Backup completed");
