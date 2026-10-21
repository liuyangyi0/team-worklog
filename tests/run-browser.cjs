const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!modulePath) {
  try {
    modulePath = require.resolve("playwright");
  } catch {
    const bundled = path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
      "playwright",
    );
    try {
      modulePath = require.resolve(bundled);
    } catch {
      throw new Error(
        "Install Playwright and Chromium, or set PLAYWRIGHT_MODULE_PATH and PLAYWRIGHT_EXECUTABLE_PATH. See README.md.",
      );
    }
  }
}
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "browser.cjs",
      "collaboration.browser.cjs",
      "planning.browser.cjs",
      "dependencies.browser.cjs",
      "library.browser.cjs",
      "assets.browser.cjs",
      "review-ui.browser.cjs",
    ];
let executable = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
if (!executable && process.platform === "win32") {
  executable = [
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ].find((file) => fs.existsSync(file));
}
for (const name of targets) {
  if (!/^[a-z.-]+\.cjs$/.test(name) || name.includes(".."))
    throw new Error("Invalid browser suite");
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    stdio: "inherit",
    timeout: 300000,
    env: {
      ...process.env,
      PLAYWRIGHT_MODULE_PATH: modulePath,
      ...(executable ? { PLAYWRIGHT_EXECUTABLE_PATH: executable } : {}),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
