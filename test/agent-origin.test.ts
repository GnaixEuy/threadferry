import assert from "node:assert/strict";
import test from "node:test";
import { AgentOriginCache } from "../src/agent-origin.js";
import { CommandExecutionError } from "../src/process.js";
import type { CommandRunner } from "../src/types.js";

const whoami = (botName: string, ownerName: string) => JSON.stringify({
  extra_identity_context: `<extra_identity_context>\n机器人身份：\n名字：${botName}\nID：aib-1\n授权真人用户身份：\n名字：${ownerName}\nID：wowOWNER\n</extra_identity_context>`,
});

const directory = JSON.stringify({ users: [{ userid: "wowOWNER", name: "苏粤翔", departments: ["月相工作室"] }] });

test("agent origin never blocks a page render and survives a bot without directory permission", async () => {
  const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  const runner: CommandRunner = async (_command, args, options) => {
    calls.push({ args, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    if (args[0] === "identity") return { stdout: whoami("叶翔", "苏粤翔"), stderr: "" };
    // 通讯录未授权：wecom-cli 把结构化错误打在 stdout，退出码非 0。
    throw new CommandExecutionError("wecom-cli", 1, JSON.stringify({ error: { message: "AuthError: 无权限" } }), "");
  };

  const cache = new AgentOriginCache();
  // 第一次读取只看缓存，立刻返回空值——页面不会等 whoami / 通讯录。
  assert.deepEqual(cache.read("叶翔", runner), {});

  // 后台那次刷新即使通讯录被拒也要拿到其余信息，且不抛错。
  const refreshed = await cache.refresh("叶翔", runner);
  assert.deepEqual(refreshed, { botName: "叶翔", ownerName: "苏粤翔" });
  assert.deepEqual(cache.read("叶翔", runner), { botName: "叶翔", ownerName: "苏粤翔" });
  // 可选查询必须带远小于默认 30s 的超时，慢接口不能拖住管理台。
  assert.ok(calls.every((call) => (call.timeoutMs ?? Infinity) <= 5_000), JSON.stringify(calls));
});

test("agent origin reports the owner's top-level department when the directory answers", async () => {
  const runner: CommandRunner = async (_command, args) => args[0] === "identity"
    ? { stdout: whoami("悦翔", "苏粤翔"), stderr: "" }
    : { stdout: directory, stderr: "" };
  const cache = new AgentOriginCache();
  assert.deepEqual(await cache.refresh("悦翔", runner), {
    botName: "悦翔",
    ownerName: "苏粤翔",
    org: "月相工作室",
  });
});

test("a hanging directory lookup still leaves the identity usable", async () => {
  // 没有通讯录权限时，wecom-cli 可能不是快速报错而是卡住。这时机器人名和 Owner 姓名
  // 必须已经进了缓存，页面照样能分辨，只是少一个部门徽章。
  const runner: CommandRunner = async (_command, args) => args[0] === "identity"
    ? { stdout: whoami("叶翔", "苏粤翔"), stderr: "" }
    : new Promise(() => {});
  const cache = new AgentOriginCache();
  cache.read("叶翔", runner);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cache.read("叶翔", runner), { botName: "叶翔", ownerName: "苏粤翔" });
});

test("agent origin caches a failed lookup instead of retrying on every render", async () => {
  let attempts = 0;
  const runner: CommandRunner = async () => {
    attempts += 1;
    throw new Error("wecom-cli 不可用");
  };
  const clock = { value: 0 };
  const cache = new AgentOriginCache(() => clock.value);

  assert.deepEqual(cache.read("叶翔", runner), {});
  await new Promise((resolve) => setImmediate(resolve));
  const afterFirst = attempts;
  assert.equal(afterFirst, 1);

  // 同一个 TTL 内反复渲染不会再打一次注定失败的调用。
  cache.read("叶翔", runner);
  cache.read("叶翔", runner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, afterFirst);

  // TTL 过后自己再试一次：权限后来被授予时不需要重启。
  clock.value += 5 * 60 * 1000;
  cache.read("叶翔", runner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, afterFirst + 1);
});
