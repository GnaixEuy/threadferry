import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../src/process.js";

test("Windows command shims preserve arguments without shell injection", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only command shim check");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "threadferry-windows-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "args.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const shim = join(root, "echo-args.cmd");
  await writeFile(shim, '@echo off\r\nnode "%~dp0args.js" %*\r\n');

  const expected = ["plain", "space value", "a&echo INJECTED", "%PATH%"];
  const result = await runCommand(shim, expected, { env: process.env });
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
