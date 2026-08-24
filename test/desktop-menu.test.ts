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
