import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const project = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("installer dry-run is non-destructive and points to onboarding", () => {
  const result = spawnSync("bash", ["install.sh", "--dry-run", "--no-onboard"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm ci/);
  assert.match(result.stdout, /warden onboard/);
  assert.doesNotMatch(result.stdout, /sudo/);
});

test("CLI exposes package version and rejects non-interactive onboarding", () => {
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.8.0");

  const onboard = spawnSync(process.execPath, [cli, "onboard"], { encoding: "utf8" });
  assert.equal(onboard.status, 1);
  assert.match(onboard.stderr, /需要交互式终端/);
});
