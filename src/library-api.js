import { api } from "./api.js";

const ROOT = "/worklog/api";
export const libraryApi = api;
export function fileSize(value = 0) {
  const n = Number(value) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
export function displayTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}
export async function internalDownload(
  route,
  filename,
  { signal, preview = false } = {},
) {
  // Let the browser stream large originals directly. The API still checks the
  // session for every request; storage paths are never exposed to the client.
  if (!preview) {
    if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    const link = document.createElement("a");
    link.href = ROOT + route;
    link.download = filename || "项目文件";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  const response = await fetch(ROOT + route, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "文件下载失败，请重试");
  }
  if (Number(response.headers.get("content-length")) > 32 * 1024 * 1024) {
    await response.body?.cancel();
    throw new Error("文件超过 32 MiB，请下载原件后查看");
  }
  const blob = await response.blob();
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  const url = URL.createObjectURL(blob);
  return { url, type: blob.type };
}
const resumeKey = (userId, projectId, file) =>
  "worklog-upload:" +
  userId +
  ":" +
  projectId +
  ":" +
  encodeURIComponent(
    [file.webkitRelativePath || file.name, file.size, file.lastModified].join(
      "|",
    ),
  );
function readResume(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function saveResume(key, value) {
  try {
    value
      ? localStorage.setItem(key, JSON.stringify(value))
      : localStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new DOMException("操作已取消", "AbortError"));
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
export async function uploadFile(
  file,
  metadata,
  { userId, projectId, signal, onProgress = () => {} } = {},
) {
  const key = resumeKey(userId, projectId, file);
  let session;
  const previous = readResume(key);
  // A resumed session must refer to the same target and base version.
  if (
    previous &&
    JSON.stringify(previous.metadata) === JSON.stringify(metadata)
  ) {
    try {
      session = await api("/uploads/" + previous.id);
    } catch (error) {
      if (![404, 410].includes(error.status)) throw error;
    }
  }
  if (!session || ["cancelled", "expired"].includes(session.status)) {
    if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    session = await api("/uploads", "POST", {
      project_id: projectId,
      ...metadata,
      filename: file.name,
      size: file.size,
      relative_path: file.webkitRelativePath || undefined,
    });
    saveResume(key, {
      id: session.id,
      metadata,
      filename: file.name,
      size: file.size,
    });
  }
  const uploadId = session.id || previous?.id;
  if (session.status === "complete" && session.result) {
    saveResume(key, null);
    onProgress({ uploadId, loaded: file.size, total: file.size });
    return session.result;
  }
  const chunkSize = session.chunk_size || 4 * 1024 * 1024;
  const received = new Set(
    (session.received_parts || []).map((part) =>
      Number(typeof part === "object" ? (part.part ?? part.part_number) : part),
    ),
  );
  const parts = Math.ceil(file.size / chunkSize);
  let sent = [...received].reduce(
    (sum, part) =>
      sum + Math.max(0, Math.min(chunkSize, file.size - part * chunkSize)),
    0,
  );
  onProgress({ uploadId, loaded: sent, total: file.size });
  for (let part = 0; part < parts; part++) {
    if (received.has(part)) continue;
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (signal?.aborted)
        throw Object.assign(new DOMException("操作已暂停", "AbortError"), {
          uploadId,
        });
      try {
        const response = await fetch(
          ROOT + "/uploads/" + uploadId + "/chunks/" + part,
          {
            method: "PUT",
            credentials: "same-origin",
            signal,
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Worklog-Request": "1",
            },
            body: file.slice(
              part * chunkSize,
              Math.min(file.size, (part + 1) * chunkSize),
            ),
          },
        );
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw Object.assign(new Error(result.error || "分片上传失败"), {
            status: response.status,
          });
        }
        success = true;
      } catch (error) {
        if (
          signal?.aborted ||
          (error.status && error.status < 500) ||
          attempt === 2
        )
          throw error;
        await pause(600 * (attempt + 1), signal);
      }
    }
    sent += Math.min(chunkSize, file.size - part * chunkSize);
    onProgress({ uploadId, loaded: sent, total: file.size });
  }
  if (signal?.aborted) throw new DOMException("操作已暂停", "AbortError");
  const result = await api("/uploads/" + uploadId + "/complete", "POST", {});
  saveResume(key, null);
  onProgress({ uploadId, loaded: file.size, total: file.size });
  return result;
}
export async function cancelUpload(uploadId) {
  if (uploadId) await api("/uploads/" + uploadId + "/cancel", "POST", {});
}
// Finds or creates a top-level folder, tolerating someone else creating it first.
export async function ensureFolder(projectId, name, known = []) {
  const find = (list) => list.find((f) => !f.parent_id && f.name === name);
  let folder = find(known);
  if (folder) return folder.id;
  try {
    return (await api("/projects/" + projectId + "/folders", "POST", { name }))
      .id;
  } catch (error) {
    if (error.status !== 409) throw error;
    folder = find((await api("/projects/" + projectId + "/documents")).folders);
    if (!folder) throw error;
    return folder.id;
  }
}
