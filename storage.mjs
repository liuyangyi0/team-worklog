import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { libraryFail as fail } from "./library-common.mjs";

export const CHUNK_SIZE = 4 * 1024 * 1024;
export function safeFilename(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\\/\x00-\x1f\x7f]/.test(value) || [".", ".."].includes(value.trim())) fail(400, "文件名无效");
  return value.trim();
}
export function relativeParts(value) {
  if (!value) return [];
  if (typeof value !== "string" || value.length > 1500 || value.startsWith("/") || value.includes("\\")) fail(400, "目录路径无效");
  const parts = value.split("/");
  if (parts.length > 16 || parts.some((p) => !p || p === "." || p === ".." || /[:\x00-\x1f\x7f]/.test(p))) fail(400, "目录路径无效");
  return parts.map(safeFilename);
}
export function createStorage({ dataDir, filesDir, maxFileBytes, quotaBytes, minFreeBytes } = {}) {
  const root = path.resolve(filesDir || path.join(dataDir || "data", "files"));
  const maximum = Number(maxFileBytes ?? process.env.WORKLOG_MAX_FILE_BYTES ?? 268435456);
  const quota = Number(quotaBytes ?? process.env.WORKLOG_STORAGE_QUOTA_BYTES ?? 21474836480);
  const minimumFree = Number(minFreeBytes ?? process.env.WORKLOG_MIN_FREE_BYTES ?? 268435456);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4294967295 || !Number.isSafeInteger(quota) || quota < maximum || !Number.isSafeInteger(minimumFree) || minimumFree < 0) throw new Error("Invalid document storage limits");
  for (const dir of [root, path.join(root, "blobs"), path.join(root, "uploads")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const locks = new Map();
  let reservedDiskBytes = 0n;
  async function reserveDisk(bytes) {
    let stats;
    try { stats = await fsp.statfs(root, { bigint: true }); }
    catch { fail(503, "暂时无法检查文件存储空间，请稍后重试"); }
    const needed = BigInt(bytes);
    // This is deliberately conservative: a concurrent write can already have reduced
    // bavail, but its entire outstanding reservation still protects this operation.
    // The check and increment occur without an await, so competing uploads cannot
    // both reserve the same free bytes after their statfs calls finish.
    if (stats.bavail * stats.bsize - reservedDiskBytes - needed < BigInt(minimumFree)) fail(507, "文件存储磁盘空间不足，请释放空间后重试或联系管理员");
    reservedDiskBytes += needed;
    let released = false;
    return () => { if (!released) { reservedDiskBytes -= needed; released = true; } };
  }
  function storageError(error) {
    if (["ENOSPC", "EDQUOT"].includes(error.code)) fail(507, "文件存储磁盘空间不足，请释放空间后重试或联系管理员");
    throw error;
  }
  async function lock(id, fn) {
    const prior = locks.get(id) || Promise.resolve();
    let unlock;
    const next = new Promise((resolve) => { unlock = resolve; });
    locks.set(id, next);
    await prior;
    try { return await fn(); } finally { unlock(); if (locks.get(id) === next) locks.delete(id); }
  }
  const uploadDir = (id) => {
    if (!/^[\w-]{1,100}$/.test(id)) fail(400, "上传编号无效");
    return path.join(root, "uploads", id);
  };
  const blobPath = (hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid stored blob hash");
    return path.join(root, "blobs", hash.slice(0, 2), hash);
  };
  async function writeChunk(id, part, req, expected) {
    const dir = uploadDir(id);
    const releaseDisk = await reserveDisk(expected);
    const temporary = path.join(dir, "." + randomUUID() + ".partial");
    let count = 0;
    const hash = createHash("sha256");
    const meter = new Transform({ transform(chunk, encoding, callback) {
      count += chunk.length;
      if (count > expected) return callback(Object.assign(new Error("分片大小超出预期"), { status: 413 }));
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await pipeline(req, meter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (count !== expected) fail(400, "分片不完整，请重新上传");
      const handle = await fsp.open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      const result = { size: count, sha256: hash.digest("hex"), path: temporary };
      return result;
    } catch (e) { await fsp.rm(temporary, { force: true }).catch(() => {}); storageError(e); }
    finally { releaseDisk(); }
  }
  async function assemble(id, parts, expected, expectedHash) {
    const releaseDisk = await reserveDisk(expected);
    const temporary = path.join(root, "blobs", "." + randomUUID() + ".partial");
    let handle;
    const hash = createHash("sha256"); let count = 0;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      for (let i = 0; i < parts.length; i++) {
        const partHash = createHash("sha256");
        for await (const chunk of fs.createReadStream(path.join(uploadDir(id), String(i)))) {
          count += chunk.length; if (count > expected) fail(400, "上传大小不一致");
          hash.update(chunk); partHash.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written);
            if (!result.bytesWritten) throw new Error("File write made no progress");
            written += result.bytesWritten;
          }
        }
        if (partHash.digest("hex") !== parts[i].sha256) fail(409, "上传分片校验失败，请取消并重新上传");
      }
      if (count !== expected) fail(400, "上传大小不一致");
      const sha256 = hash.digest("hex");
      if (expectedHash && expectedHash !== sha256) fail(400, "文件校验失败，请重新上传");
      await handle.sync(); await handle.close();
      const final = blobPath(sha256);
      await fsp.mkdir(path.dirname(final), { recursive: true, mode: 0o700 });
      // Hard linking is atomic and never overwrites a content-addressed original.
      try { await fsp.link(temporary, final); } catch (e) { if (e.code !== "EEXIST") throw e; }
      await fsp.rm(temporary, { force: true });
      return { sha256, size: count, path: final };
    } catch (e) { await handle?.close().catch(() => {}); await fsp.rm(temporary, { force: true }).catch(() => {}); storageError(e); }
    finally { releaseDisk(); }
  }
  return { root, maximum, quota, minimumFree, lock, uploadDir, blobPath, writeChunk, assemble };
}

// ZIP with stored entries, streamed originals and CRC32; never buffers whole files.
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crcUpdate(crc, data) { for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return crc >>> 0; }
async function write(res, value) {
  if (res.destroyed) throw new Error("Download disconnected");
  if (!res.write(value)) await new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", done); res.off("close", close); res.off("error", error); };
    const done = () => { cleanup(); resolve(); }, close = () => { cleanup(); reject(new Error("Download disconnected")); }, error = (e) => { cleanup(); reject(e); };
    res.once("drain", done); res.once("close", close); res.once("error", error);
  });
}
export function zip32Size(entries) {
  const maximum = 0xffffffff;
  if (!Array.isArray(entries) || entries.length > 0xffff) fail(413, "单次交付包文件过多，请分批归档");
  let size = 22;
  for (const entry of entries) {
    const nameLength = Buffer.byteLength(entry.name, "utf8");
    const fileSize = entry.buffer ? entry.buffer.length : entry.size;
    if (nameLength > 0xffff || !Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > maximum) fail(413, "单次交付包超过 ZIP32 的 4GiB 限制，请分批归档");
    size += 30 + nameLength + fileSize + 16 + 46 + nameLength;
    if (size > maximum) fail(413, "单次交付包超过 ZIP32 的 4GiB 限制，请分批归档");
  }
  return size;
}
export async function streamZip(res, entries) {
  zip32Size(entries);
  let offset = 0; const directory = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const start = offset;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
    await write(res, header); await write(res, name); offset += header.length + name.length;
    let crc = 0xffffffff, size = 0;
    const source = entry.buffer ? [entry.buffer] : fs.createReadStream(entry.path);
    for await (const chunk of source) {
      size += chunk.length;
      if (size > (entry.buffer ? entry.buffer.length : entry.size)) throw new Error("Archived file length changed");
      crc = crcUpdate(crc, chunk); await write(res, chunk);
    }
    if (size !== (entry.buffer ? entry.buffer.length : entry.size)) throw new Error("Archived file length changed");
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
    await write(res, descriptor); offset += size + descriptor.length;
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x808, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(start, 42);
    directory.push(Buffer.concat([central, name]));
  }
  const directoryOffset = offset;
  for (const item of directory) { await write(res, item); offset += item.length; }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(offset - directoryOffset, 12); end.writeUInt32LE(directoryOffset, 16);
  await write(res, end); res.end();
}
