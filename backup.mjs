import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function tableExists(db, name) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

export async function createWorkspaceBackup({
  dataDir = process.env.DATA_DIR || "data",
  filesDir = process.env.FILES_DIR || path.join(dataDir, "files"),
  destination = process.env.BACKUP_DIR || path.join(dataDir, "backups"),
  keep = Number(process.env.BACKUP_KEEP || 30),
} = {}) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 3650)
    throw new Error("BACKUP_KEEP must be 1–3650");
  const databasePath = path.join(dataDir, "worklog.sqlite");
  if (!(await exists(databasePath))) throw new Error("Database does not exist");
  const name =
    "worklog-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID().slice(0, 8);
  const folder = path.resolve(destination, name),
    staging = folder + ".incomplete";
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  let live, snapshot;
  try {
    live = new DatabaseSync(databasePath);
    await backup(live, path.join(staging, "worklog.sqlite"));
    live.close();
    live = null;
    snapshot = new DatabaseSync(path.join(staging, "worklog.sqlite"), {
      readOnly: true,
    });
    const manifest = {
      format: "worklog-backup-v2",
      created: new Date().toISOString(),
      database: "worklog.sqlite",
      files: [],
      requiredKeyVersions: [],
      keyMaterialIncluded: false,
    };
    if (tableExists(snapshot, "document_versions")) {
      const blobs = snapshot
        .prepare("SELECT DISTINCT blob_hash,size FROM document_versions")
        .all();
      const minimumFree = Number(
        process.env.WORKLOG_MIN_FREE_BYTES ?? 268435456,
      );
      if (!Number.isSafeInteger(minimumFree) || minimumFree < 0)
        throw new Error(
          "WORKLOG_MIN_FREE_BYTES must be a non-negative integer",
        );
      const space = await fs.statfs(staging);
      if (
        Number(space.bavail) * Number(space.bsize) <
        minimumFree + blobs.reduce((total, item) => total + item.size, 0)
      )
        throw new Error(
          "Backup storage space is insufficient; choose BACKUP_DIR on a larger volume",
        );
      for (const { blob_hash: hash } of blobs) {
        if (!/^[a-f0-9]{64}$/.test(hash))
          throw new Error("Invalid blob key in backup snapshot");
        const relative = "files/blobs/" + hash.slice(0, 2) + "/" + hash;
        const target = path.join(staging, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(
          path.join(filesDir, "blobs", hash.slice(0, 2), hash),
          target,
        );
        if ((await hashFile(target)) !== hash)
          throw new Error("File checksum mismatch during backup");
        manifest.files.push({
          path: relative,
          sha256: hash,
          size: (await fs.stat(target)).size,
        });
      }
    }
    const keyVersions = new Set();
    for (const table of [
      "credentials",
      "credential_versions",
      "configurations",
      "configuration_versions",
    ]) {
      if (!tableExists(snapshot, table)) continue;
      const columns = snapshot
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (columns.includes("key_version"))
        for (const row of snapshot
          .prepare(
            `SELECT DISTINCT key_version FROM ${table} WHERE key_version IS NOT NULL`,
          )
          .all())
          keyVersions.add(String(row.key_version));
    }
    manifest.requiredKeyVersions = [...keyVersions].sort();
    snapshot.close();
    snapshot = null;
    manifest.databaseSha256 = await hashFile(
      path.join(staging, "worklog.sqlite"),
    );
    await fs.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(staging, "RESTORE.txt"),
      "Restore with restoreWorkspaceBackup from backup.mjs into an empty directory.\nEncryption keys are NOT included. Restore each required key version separately before reading secrets.\nRetain old keys until every retained backup and historical secret is recoverable.\nCopy this complete backup to an independent storage location.\n",
      { mode: 0o600 },
    );
    await fs.rename(staging, folder);
    const entries = (await fs.readdir(destination, { withFileTypes: true }))
      .filter(
        (item) =>
          item.isDirectory() &&
          /^worklog-\d{4}-.*-[a-f0-9]{8}$/.test(item.name),
      )
      .map((item) => item.name)
      .sort();
    for (const old of entries.slice(0, -keep)) {
      const target = path.resolve(destination, old);
      if (path.dirname(target) !== path.resolve(destination))
        throw new Error("Invalid backup cleanup target");
      await fs.rm(target, { recursive: true });
    }
    return { folder, manifest };
  } catch (error) {
    try {
      snapshot?.close();
    } catch {}
    try {
      live?.close();
    } catch {}
    throw error;
  }
}

export async function restoreWorkspaceBackup({ backupDir, targetDir }) {
  if (!backupDir || !targetDir)
    throw new Error("backupDir and targetDir are required");
  const source = path.resolve(backupDir),
    target = path.resolve(targetDir);
  if (
    source === target ||
    target.startsWith(source + path.sep) ||
    source.startsWith(target + path.sep)
  )
    throw new Error("Restore paths must be independent");
  if (await exists(target)) {
    const stat = await fs.lstat(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.readdir(target)).length
    )
      throw new Error("Restore target must be an empty directory");
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== "worklog-backup-v2" ||
    manifest.database !== "worklog.sqlite" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Unsupported backup manifest");
  if (
    (await hashFile(path.join(source, "worklog.sqlite"))) !==
    manifest.databaseSha256
  )
    throw new Error("Database checksum mismatch");
  const listed = new Map();
  for (const item of manifest.files) {
    if (
      !/^files\/blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(item.path) ||
      item.path.split("/").at(-1) !== item.sha256 ||
      item.path.split("/")[2] !== item.sha256.slice(0, 2) ||
      listed.has(item.sha256)
    )
      throw new Error("Invalid backup file path");
    const file = path.join(source, ...item.path.split("/"));
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== item.size ||
      (await hashFile(file)) !== item.sha256
    )
      throw new Error("Backup file checksum mismatch");
    listed.set(item.sha256, item.size);
  }
  const snapshot = new DatabaseSync(path.join(source, "worklog.sqlite"), {
    readOnly: true,
  });
  try {
    const expected = tableExists(snapshot, "document_versions")
      ? snapshot
          .prepare("SELECT DISTINCT blob_hash,size FROM document_versions")
          .all()
      : [];
    const expectedHashes = new Set(expected.map((row) => row.blob_hash));
    if (
      expectedHashes.size !== listed.size ||
      expected.some((row) => listed.get(row.blob_hash) !== row.size)
    )
      throw new Error("Backup manifest does not cover all historical files");
  } finally {
    snapshot.close();
  }
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await fs.copyFile(
    path.join(source, "worklog.sqlite"),
    path.join(target, "worklog.sqlite"),
  );
  for (const item of manifest.files) {
    const destination = path.join(target, ...item.path.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(source, ...item.path.split("/")), destination);
  }
  const restored = new DatabaseSync(path.join(target, "worklog.sqlite"));
  try {
    restored.exec("BEGIN IMMEDIATE");
    if (tableExists(restored, "document_uploads")) {
      if (tableExists(restored, "document_upload_parts"))
        restored.exec(
          "DELETE FROM document_upload_parts WHERE upload_id IN (SELECT id FROM document_uploads WHERE status='active')",
        );
      restored.exec(
        "UPDATE document_uploads SET status='expired' WHERE status='active'",
      );
    }
    if (tableExists(restored, "document_blob_orphans"))
      restored.exec("DELETE FROM document_blob_orphans");
    restored.exec("COMMIT");
  } catch (error) {
    restored.exec("ROLLBACK");
    throw error;
  } finally {
    restored.close();
  }
  return {
    targetDir: target,
    requiredKeyVersions: manifest.requiredKeyVersions || [],
    keyMaterialIncluded: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await createWorkspaceBackup();
  console.log("Backup completed:", result.folder);
  if (result.manifest.requiredKeyVersions.length)
    console.log(
      "Encryption keys must be backed up separately; key versions:",
      result.manifest.requiredKeyVersions.join(", "),
    );
}
