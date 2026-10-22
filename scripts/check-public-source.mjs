import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const forbidden =
  /(^|\/)(?:data|files|backups|\.keys|\.private|node_modules|dist)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-[^/]*)?|db(?:-[^/]*)?|zip|tar\.gz|pem|key|p12|pfx)$/i;
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /VAULT_MASTER_KEY\s*[=:]\s*["']?[a-fA-F0-9]{64}\b/,
];
const technical = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "www.w3.org",
  "registry.npmjs.org",
  "opencollective.com",
  "tidelift.com",
  "www.npmjs.com",
  "eslint.org",
]);

export function checkPublicSource(root) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  const files = new Set(
    git(["ls-files", "-c", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean),
  );
  const index = new Map(),
    problems = [];
  for (const entry of git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, hash, stage] = entry.slice(0, tab).split(" "),
      file = entry.slice(tab + 1);
    files.add(file);
    if (stage !== "0") problems.push(file + ": unresolved index conflict");
    else if (mode !== "100644" && mode !== "100755")
      problems.push(file + ": non-regular source entry");
    else index.set(file, hash);
  }
  function scan(file, text, source) {
    const prefix = file + " [" + source + "]";
    if (signatures.some((p) => p.test(text)))
      problems.push(prefix + ": possible real key/token");
    if (file === "package-lock.json") return;
    text.split(/\r?\n/).forEach((line, i) => {
      for (const match of line.matchAll(
        /https?:\/\/([^\s\/;"'<>)(\x60\\]+)/gi,
      )) {
        const host = match[1].replace(/:\d*$/, "").toLowerCase();
        const example =
          /(^|\.)example(?:\.(?:com|org|net|invalid))?$|\.(?:invalid|test)$/.test(
            host,
          );
        const local =
          host === "localhost" ||
          host === "127.0.0.1" ||
          host.startsWith("127.0.0.1:");
        const fixture = /^(?:tests\/|test\.mjs)/.test(file) && host === "a";
        if (!technical.has(host) && !example && !local && !fixture)
          problems.push(
            prefix +
              ":" +
              (i + 1) +
              ": unapproved external host; use private deployment configuration",
          );
      }
    });
  }
  for (const file of files) {
    if (forbidden.test(file) && !file.endsWith(".env.example")) {
      problems.push(file + ": excluded runtime or secret file");
      continue;
    }
    const target = path.resolve(root, file);
    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink())
        problems.push(file + ": source symlink is not publishable");
      else if (fs.statSync(target).isFile())
        scan(file, fs.readFileSync(target, "utf8"), "worktree");
    }
    // Check the exact staged blob even when a clean working copy has replaced it.
    if (index.has(file))
      scan(file, git(["cat-file", "blob", index.get(file)]), "index");
  }
  return { files: files.size, indexFiles: index.size, problems };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const result = checkPublicSource(path.resolve(import.meta.dirname, ".."));
  if (result.problems.length) {
    console.error(result.problems.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "Public-source check passed (" +
        result.files +
        " worktree files, " +
        result.indexFiles +
        " staged files; runtime paths, key signatures and external hosts checked).",
    );
}
