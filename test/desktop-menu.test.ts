import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("desktop tray uses one state-aware service action", async () => {
  const source = await readFile(resolve("src/desktop.ts"), "utf8");

  assert.match(source, /label: showStopService \? "停止服务" : "启动服务"/);
  assert.doesNotMatch(source, /label: "(?:启动|停止)服务"/);
});

test("desktop reuses the visible management page instead of reloading it", async () => {
  const source = await readFile(resolve("src/desktop.ts"), "utf8");

  assert.match(source, /managementWindow\?\.webContents\.getURL\(\) === url/);
  assert.match(source, /managementWindow\.show\(\);\s*managementWindow\.focus\(\);\s*} else {\s*openManagementWindow\(url\)/);
});

test("desktop installs updates and restarts instead of opening downloaded installers", async () => {
  const [source, preload, cli] = await Promise.all([
    readFile(resolve("src/desktop.ts"), "utf8"),
    readFile(resolve("build/desktop-preload.cjs"), "utf8"),
    readFile(resolve("src/cli.ts"), "utf8"),
  ]);

  assert.match(preload, /desktop-update:install/);
  assert.match(preload, /desktop-update:status/);
  assert.match(source, /installDesktopUpdate\(autoUpdater/);
  assert.match(source, /setTimeout\(\(\) => void runDesktopUpdate/);
  assert.match(source, /setInterval\(\(\) => void runDesktopUpdate/);
  assert.match(source, /stopService\(false\)/);
  assert.match(source, /postMessage\(\{ type: "threadferry:stop", cancel \}\)/);
  assert.match(cli, /stop\(message\.cancel !== false\)/);
  assert.doesNotMatch(source, /webContents\.downloadURL|shell\.openPath/);
});
