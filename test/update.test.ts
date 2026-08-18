import assert from "node:assert/strict";
import test from "node:test";
import { findUpdate, installUpdate } from "../src/update.js";
import type { CommandRunner } from "../src/types.js";

const latest = (tag: string): typeof fetch => (async () => new Response(null, {
  status: 302,
  headers: { location: `https://github.com/GnaixEuy/threadferry/releases/tag/${tag}` },
})) as typeof fetch;

test("findUpdate returns only a newer stable release", async () => {
  assert.deepEqual(await findUpdate("0.10.1", latest("v0.10.2")), {
    version: "0.10.2",
    packageUrl: "https://github.com/GnaixEuy/threadferry/releases/download/v0.10.2/threadferry.tgz",
  });
  assert.equal(await findUpdate("0.10.1", latest("v0.10.1")), undefined);
  assert.equal(await findUpdate("0.10.1", latest("v0.10.0")), undefined);
  await assert.rejects(
    findUpdate("0.10.1", latest("not-a-version")),
    /Latest Release 地址无效/,
  );
  await assert.rejects(
    findUpdate("0.10.1", latest("0.10.2")),
    /Latest Release 地址无效/,
  );
});

test("installUpdate installs the release asset and verifies its version", async () => {
  const calls: Array<[string, string[]]> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, args]);
    if (command === "npm" && args[0] === "install") return { stdout: "", stderr: "" };
    if (command === "npm" && args[0] === "prefix") return { stdout: "/install\n", stderr: "" };
    if (command === "/install/bin/threadferry") return { stdout: "0.10.2\n", stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const binary = await installUpdate({
    version: "0.10.2",
    packageUrl: "https://github.com/GnaixEuy/threadferry/releases/download/v0.10.2/threadferry.tgz",
  }, runner);

  assert.equal(binary, "/install/bin/threadferry");
  assert.deepEqual(calls, [
    ["npm", ["install", "--global", "--ignore-scripts", "https://github.com/GnaixEuy/threadferry/releases/download/v0.10.2/threadferry.tgz"]],
    ["npm", ["prefix", "--global"]],
    ["/install/bin/threadferry", ["--version"]],
  ]);
});

test("installUpdate rejects an unexpected installed version", async () => {
  const runner: CommandRunner = async (command, args) => {
    if (command === "npm" && args[0] === "prefix") return { stdout: "/install\n", stderr: "" };
    if (command === "/install/bin/threadferry") return { stdout: "0.10.1\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(installUpdate({
    version: "0.10.2",
    packageUrl: "https://github.com/GnaixEuy/threadferry/releases/download/v0.10.2/threadferry.tgz",
  }, runner), /安装后版本为 0\.10\.1/);
});
