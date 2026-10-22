import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPublicSource } from "../scripts/check-public-source.mjs";

test("publication check scans exact staged bytes and treats URL schemes case-insensitively", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-publication-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git(["init", "--quiet"]);
    git(["config", "core.autocrlf", "false"]);
    const source = path.join(root, "settings.js");
    await fs.writeFile(
      source,
      'const origin = "' + "Https" + "://private.customer.corp" + '";\n',
    );
    git(["add", "settings.js"]);
    await fs.writeFile(source, 'const origin = "https://example.invalid";\n');
    let result = checkPublicSource(root);
    assert.ok(
      result.problems.some(
        (p) => p.includes("[index]") && p.includes("external host"),
      ),
    );
    assert.ok(!result.problems.some((p) => p.includes("[worktree]")));
    git(["add", "settings.js"]);
    assert.deepEqual(checkPublicSource(root).problems, []);
    await fs.writeFile(
      source,
      'const key = "' + "ghp_" + "a".repeat(36) + '";\n',
    );
    git(["add", "settings.js"]);
    await fs.writeFile(source, "export const cleared=true;\n");
    result = checkPublicSource(root);
    assert.ok(
      result.problems.some(
        (p) => p.includes("[index]") && p.includes("key/token"),
      ),
    );
    assert.ok(
      result.problems.every((p) => !p.includes("a".repeat(36))),
      "reports must not echo matching secret bytes",
    );
    git(["add", "settings.js"]);
    await fs.mkdir(path.join(root, "files"));
    await fs.writeFile(path.join(root, "files", "upload.txt"), "fixture");
    git(["add", "files/upload.txt"]);
    assert.ok(
      checkPublicSource(root).problems.some((p) =>
        p.includes("excluded runtime"),
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
