import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDefinitionForPairing,
  agentNameFromBot,
  authAnnouncement,
  ownerAdoptPrompt,
  pairInstructions,
  pairMismatchReply,
  pairReceivedReply,
  pairSuccessReply,
  resolveSetupPlan,
  waitForPair,
} from "../src/setup-wizard.js";
import type { ThreadFerryConfig } from "../src/types.js";

function testConfig(agents: Record<string, Partial<ThreadFerryConfig["agents"][string]>>): ThreadFerryConfig {
  return {
    version: 6,
    ownerUser: "owner",
    agents: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, {
      runtime: "codex",
      workspace: "/ws",
      ownerUser: "owner",
      ...agent,
    }])),
    groups: {},
    security: { requireMention: true, readOnly: true },
  };
}

test("auth announcement previews the browser QR flow and names the agent and credential dir", () => {
  const text = authAnnouncement("frontend", "/tmp/creds/frontend");
  assert.match(text, /frontend/);
  assert.match(text, /\/tmp\/creds\/frontend/);
  assert.match(text, /浏览器/);
  assert.match(text, /扫码/);
  assert.match(text, /不经手 Bot Secret/);
});

test("pair instructions explain where to find the bot, the owner account and the terminal confirmation", () => {
  const text = pairInstructions("frontend", "deadbeef");
  assert.match(text, /deadbeef/);
  assert.match(text, /frontend/);
  assert.match(text, /找到你刚扫码授权的那个机器人/);
  assert.match(text, /你希望成为 Owner 的那个人的账号/);
  assert.match(text, /回到电脑终端/);
});

test("pair mismatch reply never echoes the correct code", () => {
  const code = "deadbeef";
  const reply = pairMismatchReply();
  assert.match(reply, /配对码不正确/);
  assert.doesNotMatch(reply, new RegExp(code));
});

test("agent name is taken from the bot name directly", () => {
  assert.equal(agentNameFromBot("叶翔", []), "叶翔");
  assert.equal(agentNameFromBot(" 叶翔 ", []), undefined);
  assert.equal(agentNameFromBot("a/b", []), undefined);
  assert.equal(agentNameFromBot(undefined, []), undefined);
});

test("agent name suffixes when the bot name already exists", () => {
  assert.equal(agentNameFromBot("叶翔", ["叶翔"]), "叶翔2");
  assert.equal(agentNameFromBot("叶翔", ["叶翔", "叶翔2"]), "叶翔3");
});

test("pair received reply directs the sender back to the terminal", () => {
  assert.match(pairReceivedReply(), /请在电脑终端确认/);
});

test("owner adopt prompt shows the friendly name together with the official id", () => {
  const prompt = ownerAdoptPrompt("frontend", { name: "苏粤翔", id: "wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw" });
  assert.match(prompt, /苏粤翔/);
  assert.match(prompt, /wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw/);
  assert.match(prompt, /frontend/);
  assert.match(prompt, /\[Y\/n\]/);
});

test("pair success reply names the agent and workspace the bot now maps to", () => {
  const reply = pairSuccessReply("frontend", "/absolute/ws");
  assert.match(reply, /Agent：frontend/);
  assert.match(reply, /\/absolute\/ws/);
  assert.match(reply, /配对完成/);
});

test("resolveSetupPlan reuses existing workspace/runtime/model when nothing is requested", () => {
  const existing = testConfig({ frontend: { workspace: "/existing/ws", model: "provider/model" } });
  const plan = resolveSetupPlan(existing, "frontend");
  assert.equal(plan.workspace, "/existing/ws");
  assert.equal(plan.runtime, "codex");
  assert.equal(plan.model, "provider/model");
  assert.equal(plan.reused, true);
});

test("resolveSetupPlan prefers explicitly requested workspace and runtime", () => {
  const existing = testConfig({ frontend: { workspace: "/existing/ws" } });
  const plan = resolveSetupPlan(existing, "frontend", { workspace: "/new/ws", runtime: "pi" });
  assert.equal(plan.workspace, "/new/ws");
  assert.equal(plan.runtime, "pi");
  assert.equal(plan.reused, false);
});

test("resolveSetupPlan reuses existing workspace but honours an explicit runtime override", () => {
  const existing = testConfig({ frontend: { workspace: "/existing/ws" } });
  const plan = resolveSetupPlan(existing, "frontend", { runtime: "pi" });
  assert.equal(plan.workspace, "/existing/ws");
  assert.equal(plan.runtime, "pi");
  assert.equal(plan.reused, true);
});

test("resolveSetupPlan requires a workspace when there is no existing config", () => {
  assert.throws(() => resolveSetupPlan(undefined, "frontend"), /--workspace/);
});

test("resolveSetupPlan requires a workspace when the agent is not configured", () => {
  const existing = testConfig({ default: {} });
  assert.throws(() => resolveSetupPlan(existing, "frontend"), /Agent frontend 未配置/);
  assert.throws(() => resolveSetupPlan(existing, "frontend"), /已配置的 Agent：default/);
});

test("resolveSetupPlan uses a provided workspace to add a brand new agent", () => {
  const existing = testConfig({ default: {} });
  const plan = resolveSetupPlan(existing, "reviewer", { workspace: "/new/ws", runtime: "pi" });
  assert.equal(plan.workspace, "/new/ws");
  assert.equal(plan.runtime, "pi");
  assert.equal(plan.reused, false);
});

test("resolveSetupPlan requires a runtime for a brand new agent", () => {
  assert.throws(() => resolveSetupPlan(undefined, "reviewer", { workspace: "/new/ws" }), /--runtime/);
});

test("agentDefinitionForPairing preserves an existing agent's config_dir", () => {
  const definition = agentDefinitionForPairing(
    { workspace: "/ws", runtime: "pi", model: "m" },
    { workspace: "/ws", runtime: "pi", ownerUser: "owner", configDir: "/custom/creds" },
  );
  assert.deepEqual(definition, { workspace: "/ws", runtime: "pi", model: "m", configDir: "/custom/creds" });
});

test("agentDefinitionForPairing omits config_dir when the agent has none", () => {
  const definition = agentDefinitionForPairing(
    { workspace: "/ws", runtime: "codex" },
    { workspace: "/ws", runtime: "codex", ownerUser: "owner" },
  );
  assert.deepEqual(definition, { workspace: "/ws", runtime: "codex" });
});

interface FakeChannel {
  startChannel: Parameters<typeof waitForPair>[0]["startChannel"];
  replies: string[];
  feed: (event: { chatType: string; message: { text: string; senderId: string } }) => Promise<void>;
}

function fakeChannel(): FakeChannel {
  let handler: (event: { chatType: string; message: { text: string; senderId: string } }, reply: (content: string) => Promise<void>) => Promise<void>;
  const replies: string[] = [];
  const reply = async (content: string) => { replies.push(content); };
  return {
    startChannel: (h) => {
      handler = h as typeof handler;
      return { disconnect: () => undefined };
    },
    replies,
    feed: async (event) => {
      await handler(event, reply);
    },
  };
}

test("waitForPair replies to a wrong code without echoing it and still waits for the right one", async () => {
  const channel = fakeChannel();
  const code = "deadbeef";
  const confirmed: string[] = [];
  const wait = waitForPair({
    code,
    agentId: "frontend",
    workspace: "/ws",
    onLog: () => undefined,
    confirm: async (senderId) => { confirmed.push(senderId); return true; },
    onApproved: async () => undefined,
    startChannel: channel.startChannel,
    timeoutMs: 200,
    heartbeatMs: 50,
  });

  await channel.feed({ chatType: "single", message: { text: "threadferry pair wrong-code", senderId: "u1" } });
  assert.deepEqual(confirmed, []);
  assert.ok(channel.replies.length > 0);
  assert.match(channel.replies[0] ?? "", /配对码不正确/);
  assert.doesNotMatch(channel.replies[0] ?? "", new RegExp(code));

  await channel.feed({ chatType: "single", message: { text: `threadferry pair ${code}`, senderId: "u2" } });
  assert.equal(await wait, "paired");
  assert.deepEqual(confirmed, ["u2"]);
  // 手机端应立刻收到"已收到，请回终端确认"，然后才是配对完成。
  assert.ok(channel.replies.some((reply) => reply === pairReceivedReply()));
  assert.ok(channel.replies.some((reply) => reply.includes("配对完成")));
  assert.ok(channel.replies.some((reply) => reply.includes("frontend")));
  assert.ok(channel.replies.some((reply) => reply.includes("/ws")));
});

test("waitForPair asks the local terminal before approving and declines without approval", async () => {
  const channel = fakeChannel();
  const code = "deadbeef";
  const wait = waitForPair({
    code,
    agentId: "frontend",
    workspace: "/ws",
    onLog: () => undefined,
    confirm: async () => false,
    onApproved: async () => { throw new Error("should not be called"); },
    startChannel: channel.startChannel,
    timeoutMs: 200,
    heartbeatMs: 50,
  });

  await channel.feed({ chatType: "single", message: { text: `threadferry pair ${code}`, senderId: "u1" } });
  assert.match(channel.replies.at(-1) ?? "", /本机终端未确认/);
  // 拒绝后继续等待，超时结束。
  assert.equal(await wait, "timeout");
});

test("waitForPair times out with heartbeat and timeout notices when nothing arrives", async () => {
  const channel = fakeChannel();
  const logs: string[] = [];
  const wait = waitForPair({
    code: "deadbeef",
    agentId: "frontend",
    workspace: "/ws",
    onLog: (message) => logs.push(message),
    confirm: async () => true,
    onApproved: async () => undefined,
    startChannel: channel.startChannel,
    timeoutMs: 120,
    heartbeatMs: 40,
  });
  assert.equal(await wait, "timeout");
  assert.ok(logs.some((line) => /仍在等待/.test(line)));
  assert.ok(logs.some((line) => /等待超时/.test(line)));
});

test("waitForPair redirects group messages to the direct-chat pairing path", async () => {
  const channel = fakeChannel();
  const wait = waitForPair({
    code: "deadbeef",
    agentId: "frontend",
    workspace: "/ws",
    onLog: () => undefined,
    confirm: async () => true,
    onApproved: async () => undefined,
    startChannel: channel.startChannel,
    timeoutMs: 100,
    heartbeatMs: 50,
  });
  await channel.feed({ chatType: "group", message: { text: "threadferry pair deadbeef", senderId: "u1" } });
  assert.match(channel.replies[0] ?? "", /请私聊机器人/);
  assert.equal(await wait, "timeout");
});