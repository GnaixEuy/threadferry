import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listWecomGroups, searchWecomUsers, sendWecomReply } from "../src/channels/wecom.js";
import { loadConfig, onboardingDefaults, pairConfig, resolveWorkspace, saveConfig, setupConfig } from "../src/config.js";
import { fetchWecomHistory } from "../src/history/wecom-cli.js";
import { CommandExecutionError, runCommand } from "../src/process.js";
import { runCodex } from "../src/runtimes/codex.js";
import { allowedReadPath } from "../src/runtimes/pi-readonly-extension.js";
import { runPi } from "../src/runtimes/pi.js";
import { ThreadFerryState } from "../src/state.js";
import type { CommandRunner, GroupMessage, IncomingMention, ThreadFerryConfig } from "../src/types.js";

function testConfig(workspace = "/workspace", ownerUser = "user", groupId = "group"): ThreadFerryConfig {
  return {
    version: 5,
    ownerUser,
    agents: { default: { workspace, runtime: "codex" } },
    groups: { [groupId]: { agent: "default", allowUsers: [ownerUser], context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
}

test("mock WeCom -> history -> context -> Codex -> reply vertical slice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const config = testConfig(workspace, "user_allowed", "group_allowed");
  const currentTime = new Date("2026-08-18T10:05:00+08:00");
  const history: GroupMessage[] = [
    { senderId: "user-1", senderName: "张三", time: new Date("2026-08-18T10:00:00+08:00"), text: "这个接口有问题" },
    { senderId: "user-2", senderName: "李四", time: new Date("2026-08-18T10:01:00+08:00"), text: "可能是 Redis" },
    { senderId: "user-3", senderName: "王五", time: new Date("2026-08-18T10:02:00+08:00"), text: "线上出现三次" },
  ];
  let runtimeCalls = 0;
  let receivedPrompt = "";
  const runtimeArgs: string[][] = [];
  const fakeCodex: CommandRunner = async (command, args, options) => {
    runtimeCalls += 1;
    runtimeArgs.push(args);
    receivedPrompt = options?.input ?? "";
    assert.equal(command, "codex");
    assert.equal(options?.cwd, workspace);
    assert.equal(args[args.indexOf("-C") + 1], workspace);
    assert.match(args.find((arg) => arg.startsWith("permissions.threadferry-read-only.filesystem=")) ?? "", /":workspace_roots"=\{"\."="read"/);
    assert.ok(args.includes("permissions.threadferry-read-only.network.enabled=false"));
    assert.ok(!args.includes("workspace-write"));
    assert.ok(args.indexOf("-a") < args.indexOf("exec"));
    assert.ok(args.includes("never"));
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(!args.includes("--ephemeral"));
    assert.equal(options?.env?.THREADFERRY_WECOM_BOT_SECRET, undefined);
    return {
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "session-1" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "只读分析结果" } })}\n`,
      stderr: "",
    };
  };
  const app = createApp(config, {
    history: async () => history,
    runtime: (request) => runCodex(request, fakeCodex),
  });
  const replies: Array<{ content: string; finish: boolean }> = [];
  const reply = async (content: string, finish = true) => { replies.push({ content, finish }); };
  const message: IncomingMention = {
    msgId: "msg-4",
    groupId: "group_allowed",
    senderId: "user_allowed",
    senderName: "用户",
    time: currentTime,
    text: "@ThreadFerry 帮忙分析",
    mentioned: true,
  };

  assert.equal(await app.handle(message, reply), "handled");
  assert.equal(runtimeCalls, 1);
  assert.deepEqual(replies, [
    { content: "ThreadFerry 已收到，正在分析。", finish: false },
    { content: "只读分析结果", finish: true },
  ]);
  for (const expected of ["张三", "这个接口有问题", "李四", "可能是 Redis", "王五", "线上出现三次", "@ThreadFerry 帮忙分析"]) {
    assert.match(receivedPrompt, new RegExp(expected));
  }

  assert.equal(await app.handle({ ...message, msgId: "msg-5", time: new Date(currentTime.getTime() + 60_000), text: "@ThreadFerry 继续分析" }, reply), "handled");
  assert.deepEqual(runtimeArgs[1]?.slice(-3), ["resume", "session-1", "-"]);
  assert.equal(await app.handle(message, reply), "duplicate");
  assert.equal(await app.handle({ ...message, msgId: "bad-group", groupId: "group_other" }, reply), "unauthorized_group");
  assert.equal(await app.handle({ ...message, msgId: "bad-user", senderId: "user_other" }, reply), "unauthorized_user");
  assert.equal(await app.handle({ ...message, msgId: "no-mention", mentioned: false }, reply), "missing_mention");
  assert.equal(runtimeCalls, 2);
  assert.equal(replies.length, 4);
});

test("robot owner manages per-group users in direct chat", async () => {
  const config = testConfig("/workspace", "owner");
  config.agents.reviewer = { workspace: "/review-workspace", runtime: "pi", model: "provider/reviewer" };
  const persisted: Array<{ groupId: string; users: string[] }> = [];
  const persistedAgents: Array<{ groupId: string; agentId: string }> = [];
  const boundGroups: Array<{ groupId: string; agentId: string }> = [];
  const runtimeAgents: string[] = [];
  const runtimeSessions: Array<string | undefined> = [];
  const runtimePrompts: string[] = [];
  let searchCalls = 0;
  let runtimeCalls = 0;
  const app = createApp(config, {
    history: async () => [],
    runtime: async (request) => {
      runtimeCalls += 1;
      runtimeAgents.push(`${request.agentId}:${request.runtime}:${request.workspace}`);
      runtimeSessions.push(request.sessionId);
      runtimePrompts.push(request.prompt);
      return { text: "分析结果", sessionId: `${request.agentId}-session` };
    },
    updateAllowUsers: async (groupId, users) => { persisted.push({ groupId, users: [...users] }); },
    updateGroupAgent: async (groupId, agentId) => { persistedAgents.push({ groupId, agentId }); },
    bindGroup: async (groupId, agentId) => { boundGroups.push({ groupId, agentId }); },
    listGroups: async () => [
      { id: "group", name: "AI Coding" },
      { id: "group-unconfigured", name: "未配置群" },
    ],
    searchUsers: async (keywords) => {
      searchCalls += 1;
      return [
        { id: "owner-directory", name: "创建者", callbackId: "owner" },
        { id: "new-user", name: "新用户" },
        { id: "lisi", name: "李四", callbackId: "lisi-callback" },
        { id: "zhangsan-1", name: "张三", departments: ["研发一部"] },
        { id: "zhangsan-2", name: "张三", departments: ["研发二部"] },
      ].flatMap((user) => {
        const matchedKeywords = keywords.filter((keyword) => user.id === keyword || user.name.includes(keyword) || user.callbackId === keyword);
        return matchedKeywords.length ? [{ ...user, matchedKeywords }] : [];
      });
    },
  });
  const replies: string[] = [];
  let sequence = 0;
  const direct = (senderId: string, text: string, msgId = `direct-${sequence += 1}`) => app.handleDirect({
    msgId,
    senderId,
    time: new Date(),
    text,
  }, async (content) => { replies.push(content); });
  const group = (senderId: string, text: string) => app.handle({
    msgId: `group-${sequence += 1}`,
    groupId: "group",
    senderId,
    time: new Date(),
    text,
    mentioned: true,
  }, async (content) => { replies.push(content); });

  assert.equal(await direct("new-user", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /只有.*Owner/);
  assert.equal(await direct("new-user", "threadferry use AI Coding reviewer"), "command");
  assert.equal(persistedAgents.length, 0);
  assert.equal(await direct("owner", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /AI Coding/);
  assert.match(replies.at(-1) ?? "", /\[default\].*\[未配置 Agent\]/s);
  assert.equal(await direct("owner", "threadferry agents"), "command");
  assert.match(replies.at(-1) ?? "", /reviewer.*pi.*provider\/reviewer/s);
  assert.equal(await direct("owner", "threadferry bind 未配置群 reviewer"), "command");
  assert.deepEqual(boundGroups, [{ groupId: "group-unconfigured", agentId: "reviewer" }]);
  assert.equal(config.groups["group-unconfigured"]?.agent, "reviewer");
  assert.equal(searchCalls, 0);
  assert.equal(await group("owner", "@机器人 先用默认 Agent 分析"), "handled");
  assert.equal(runtimeAgents[0], "default:codex:/workspace");
  assert.equal(await direct("owner", "threadferry use AI Coding reviewer"), "command");
  assert.deepEqual(persistedAgents, [{ groupId: "group", agentId: "reviewer" }]);
  assert.equal(await direct("owner", "threadferry invite AI Coding"), "command");
  const code = replies.at(-1)?.match(/邀请码：`([A-F0-9]{12})`/)?.[1];
  assert.ok(code);
  assert.equal(await group("new-user", `@机器人 threadferry join ${code}`), "command");
  assert.deepEqual(persisted, [{ groupId: "group", users: ["owner", "new-user"] }]);

  assert.equal(await group("new-user", "@机器人 分析"), "handled");
  assert.equal(runtimeCalls, 2);
  assert.equal(runtimeAgents[1], "reviewer:pi:/review-workspace");
  assert.deepEqual(runtimeSessions.slice(0, 2), [undefined, undefined]);
  assert.equal(await direct("owner", "threadferry users AI Coding"), "command");
  assert.match(replies.at(-1) ?? "", /新用户/);
  assert.equal(await direct("owner", "threadferry add AI Coding 李四"), "command");
  assert.deepEqual(persisted.at(-1), { groupId: "group", users: ["owner", "new-user", "lisi"] });
  assert.match(replies.at(-1) ?? "", /授权 李四/);
  assert.equal(await group("lisi-callback", "@机器人 分析李四的问题"), "handled");
  assert.equal(runtimeCalls, 3);
  assert.equal(runtimeSessions[2], "reviewer-session");
  const beforeAmbiguous = persisted.length;
  assert.equal(await direct("owner", "threadferry add AI Coding 张三"), "command");
  assert.equal(persisted.length, beforeAmbiguous);
  assert.match(replies.at(-1) ?? "", /多个.*id:zhangsan-1.*id:zhangsan-2/s);
  assert.equal(await direct("owner", "threadferry add AI Coding id:zhangsan-2"), "command");
  assert.deepEqual(persisted.at(-1), { groupId: "group", users: ["owner", "new-user", "lisi", "zhangsan-2"] });
  assert.equal(await direct("owner", "threadferry remove AI Coding 新用户"), "command");
  assert.deepEqual(persisted.at(-1), { groupId: "group", users: ["owner", "lisi", "zhangsan-2"] });
  assert.equal(await group("new-user", "@机器人 再分析"), "unauthorized_user");
  assert.equal(await group("owner", "@机器人 threadferry users group"), "command");
  assert.match(replies.at(-1) ?? "", /请私聊/);
  assert.equal(await direct("new-user", "threadferry whoami"), "command");
  assert.match(replies.at(-1) ?? "", /new-user/);
  assert.equal(await direct("owner", "threadferry remove AI Coding 创建者"), "command");
  assert.match(replies.at(-1) ?? "", /不能移除/);
  const beforeDirectSearch = searchCalls;
  assert.equal(await direct("new-user", "帮我分析私聊问题"), "command");
  assert.match(replies.at(-1) ?? "", /只有.*Owner/);
  assert.equal(await direct("owner", "帮我分析私聊问题"), "handled");
  assert.equal(runtimeCalls, 4);
  assert.equal(runtimeAgents[3], "default:codex:/workspace");
  assert.equal(runtimeSessions[3], undefined);
  assert.match(runtimePrompts[3] ?? "", /UNTRUSTED_DIRECT_HISTORY.*企业微信私聊/s);
  assert.equal(await direct("owner", "继续分析私聊问题"), "handled");
  assert.equal(runtimeSessions[4], "default-session");
  assert.equal(searchCalls, beforeDirectSearch);
  assert.equal(await direct("owner", "threadferry groups", "duplicate-direct"), "command");
  assert.equal(await direct("owner", "threadferry groups", "duplicate-direct"), "duplicate");
  assert.equal(runtimeCalls, 5);
});

test("wecom group session listing uses the official message command", async () => {
  let received: { command: string; args: string[] } | undefined;
  const groups = await listWecomGroups(async (command, args) => {
    received = { command, args };
    return {
      stdout: JSON.stringify({
        sessions: [
          { chat_id: "group-1", chat_name: "月相工作室", chat_type: "group" },
          { chat_id: "user-1", chat_name: "苏粤翔", chat_type: "single" },
        ],
      }),
      stderr: "",
    };
  });
  assert.deepEqual(received, {
    command: "wecom-cli",
    args: ["message", "aibot", "sessions", "list", "--json", "{}"],
  });
  assert.deepEqual(groups, [{ id: "group-1", name: "月相工作室" }]);
});

test("wecom contact search uses names without shell interpolation", async () => {
  let received: { command: string; args: string[] } | undefined;
  const users = await searchWecomUsers(["张三"], async (command, args) => {
    received = { command, args };
    return {
      stdout: JSON.stringify({
        users: [{ userid: "zhangsan", name: "张三", alias: "Sam", departments: ["研发部"], matched_keywords: ["张三"] }],
      }),
      stderr: "",
    };
  });
  assert.equal(received?.command, "wecom-cli");
  assert.deepEqual(received?.args.slice(0, 5), ["contact", "users", "search", "--json", JSON.stringify({ keywords: ["张三"], search_mode: "list" })]);
  assert.deepEqual(users, [{ id: "zhangsan", name: "张三", alias: "Sam", departments: ["研发部"], matchedKeywords: ["张三"] }]);
});

test("workspace paths cannot be relative or escape through a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-path-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = `${root}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(root, link, "dir");
  await assert.rejects(resolveWorkspace("../outside"), /绝对路径/);
  await assert.rejects(resolveWorkspace(link), /符号链接/);

  const configPath = join(root, "bad.yaml");
  await writeFile(configPath, `version: 5\nowner_user: user\nagents:\n  default:\n    runtime: codex\n    workspace: ../outside\ngroups:\n  group:\n    agent: default\n    allow_users: [user]\n`);
  await assert.rejects(loadConfig(configPath), /绝对路径/);

  const compactPath = join(root, "compact.yaml");
  const workspace = await realpath(root);
  const defaultAgent = { workspace, runtime: "codex" as const };
  await writeFile(compactPath, setupConfig("group", "default", defaultAgent, "user"));
  const compact = await loadConfig(compactPath);
  assert.equal(compact.agents.default?.runtime, "codex");
  assert.equal(compact.ownerUser, "user");
  assert.deepEqual(compact.groups.group?.context, { lookbackHours: 6, maxMessages: 80 });
  assert.deepEqual(compact.groups.group?.allowUsers, ["user"]);

  const mergedPath = join(root, "merged.yaml");
  await writeFile(mergedPath, setupConfig("group", "default", defaultAgent, "user", compact));
  const merged = await loadConfig(mergedPath);
  assert.deepEqual(merged.groups.group?.allowUsers, ["user"]);
  await writeFile(mergedPath, setupConfig("group-2", "default", defaultAgent, "user-2", compact));
  const pairedByCode = await loadConfig(mergedPath);
  assert.equal(pairedByCode.ownerUser, "user");
  assert.deepEqual(pairedByCode.groups["group-2"]?.allowUsers, ["user"]);
  await writeFile(mergedPath, pairConfig("default", defaultAgent, "user-2", compact));
  const pairedDirectly = await loadConfig(mergedPath);
  assert.equal(pairedDirectly.ownerUser, "user-2");
  assert.deepEqual(pairedDirectly.groups.group?.allowUsers, ["user-2"]);
  await writeFile(mergedPath, pairConfig("default", defaultAgent, "user-3"));
  assert.deepEqual((await loadConfig(mergedPath)).groups, {});
  assert.throws(() => setupConfig("group", "other", defaultAgent, "user", compact), /已绑定其他 Agent/);

  compact.groups.group!.allowUsers.push("user-2");
  await saveConfig(compactPath, compact);
  assert.deepEqual((await loadConfig(compactPath)).groups.group?.allowUsers, ["user", "user-2"]);
});

test("agent names support Chinese and spaces while onboarding uses the invocation directory", () => {
  const current = testConfig("/saved/workspace");
  const defaults = onboardingDefaults(current, "/current/invocation");

  assert.deepEqual(defaults, {
    agentId: "default",
    runtime: "codex",
    workspace: "/current/invocation",
    model: undefined,
  });
  assert.doesNotThrow(() => setupConfig("group", "代码审查 Agent", {
    workspace: "/current/invocation",
    runtime: "codex",
  }, "user"));
  assert.throws(() => setupConfig("group", " Agent", {
    workspace: "/current/invocation",
    runtime: "codex",
  }, "user"), /Agent 名/);
  assert.throws(() => setupConfig("group", "超".repeat(65), {
    workspace: "/current/invocation",
    runtime: "codex",
  }, "user"), /1-64/);
});

test("legacy and extra configuration fields are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyPath = join(root, "legacy.yaml");
  await writeFile(legacyPath, "version: 1\nchannels: {}\n");
  await assert.rejects(loadConfig(legacyPath), /旧版配置不再兼容/);

  const extraPath = join(root, "extra.yaml");
  await writeFile(extraPath, `version: 5\nowner_user: user\nagents:\n  default:\n    runtime: codex\n    workspace: ${JSON.stringify(await realpath(root))}\ngroups:\n  group:\n    agent: default\n    allow_users: [user]\n    runtime: codex\n`);
  await assert.rejects(loadConfig(extraPath), /不支持字段: runtime/);
});

test("a newer group message makes the completed analysis stale", async () => {
  const now = new Date("2026-08-18T10:05:00+08:00");
  const config = testConfig();
  let reads = 0;
  const app = createApp(config, {
    history: async () => ++reads === 1 ? [] : [{ senderId: "other", time: new Date(now.getTime() + 1000), text: "新消息" }],
    runtime: async () => ({ text: "已经过期的分析" }),
  });
  const replies: Array<{ content: string; finish: boolean }> = [];
  const status = await app.handle({
    msgId: "freshness", groupId: "group", senderId: "user", time: now, text: "@ThreadFerry 分析", mentioned: true,
  }, async (content, finish = true) => { replies.push({ content, finish }); });

  assert.equal(status, "stale");
  assert.deepEqual(replies, [
    { content: "ThreadFerry 已收到，正在分析。", finish: false },
    { content: "分析期间群里出现了新消息。为避免发送过期结论，请重新 @机器人。", finish: true },
  ]);
});

test("same-group turns run serially and queued users get immediate feedback", async () => {
  const config = testConfig();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return { text: `result-${calls}` };
    },
  });
  const message = (msgId: string): IncomingMention => ({
    msgId, groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  });
  const firstReplies: string[] = [];
  const secondReplies: string[] = [];
  const first = app.handle(message("serial-1"), async (content) => { firstReplies.push(content); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = app.handle(message("serial-2"), async (content) => { secondReplies.push(content); });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.equal(secondReplies[0], "ThreadFerry 已收到，当前群有任务处理中，已排队。");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["handled", "handled"]);
  assert.equal(maxActive, 1);
  assert.equal(firstReplies.at(-1), "result-1");
  assert.equal(secondReplies.at(-1), "result-2");
});

test("runtime failures return and persist a redacted error id", async () => {
  const config = testConfig();
  const state = new ThreadFerryState();
  const errors: Array<{ errorId: string; phase: string }> = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => { throw new Error("secret detail must not escape"); },
    onError: (error) => { errors.push(error); },
  }, state);
  const replies: string[] = [];
  const result = await app.handle({
    msgId: "failure", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async (content) => { replies.push(content); });

  assert.equal(result, "failed");
  assert.match(replies.at(-1) ?? "", /错误编号 TF-[A-F0-9]{8}/);
  assert.doesNotMatch(replies.join("\n"), /secret detail/);
  assert.equal(errors[0]?.phase, "runtime");
  assert.equal((await state.snapshot()).turns[0]?.errorId, errors[0]?.errorId);
});

test("wecom history uses chat.messages.list arguments and keeps attachment metadata", async () => {
  const runner: CommandRunner = async (command, args) => {
    assert.equal(command, "wecom-cli");
    assert.deepEqual(args.slice(0, 3), ["chat", "messages", "list"]);
    assert.equal(args[args.indexOf("--chat-id") + 1], "group_allowed");
    return {
      stdout: JSON.stringify({
        errcode: 0,
        data: {
          messages: [
            { msg_type: "text", send_time: "2026-08-18 10:00:00", userid: "user-1", user_name: "张三", text: { content: "接口异常" } },
            { msg_type: "file", send_time: "2026-08-18 10:01:00", userid: "user-2", user_name: "李四", file: { file_name: "trace.log", media_id: "metadata-only" } },
          ],
          has_more: false,
        },
      }),
      stderr: "",
    };
  };
  const messages = await fetchWecomHistory("group_allowed", {
    lookbackHours: 6,
    maxMessages: 80,
    endTime: new Date("2026-08-18T10:05:00+08:00"),
  }, runner);
  assert.equal(messages[0]?.senderName, "张三");
  assert.equal(messages[0]?.text, "接口异常");
  assert.deepEqual(messages[1]?.attachments, [{ type: "file", name: "trace.log" }]);
  assert.doesNotMatch(JSON.stringify(messages), /metadata-only/);
});

test("same-second history changes are detected by fingerprint", async () => {
  const now = new Date("2026-08-18T10:05:00+08:00");
  const base: GroupMessage = { senderId: "first", time: new Date(now.getTime() - 60_000), text: "原消息" };
  const config = testConfig();
  let reads = 0;
  const app = createApp(config, {
    history: async () => ++reads === 1 ? [base] : [base, { senderId: "other", time: now, text: "同一秒的新消息" }],
    runtime: async () => ({ text: "已经过期的分析" }),
  });
  const status = await app.handle({
    msgId: "same-second", groupId: "group", senderId: "user", time: now, text: "@ThreadFerry 分析", mentioned: true,
  }, async () => undefined);
  assert.equal(status, "stale");
});

test("an interrupted inbox is replayed after restart and final content is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-replay-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state-v3.json");
  const state = new ThreadFerryState(statePath);
  const message: IncomingMention = {
    msgId: "replay-1", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 恢复", mentioned: true,
  };
  await state.enqueue(message);
  await state.markRunning(message.msgId);

  const restarted = new ThreadFerryState(statePath);
  const [pending] = await restarted.recoverPending();
  assert.ok(pending);
  const config = testConfig();
  const replies: string[] = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => ({ text: "恢复后的结果", sessionId: "recovered-session" }),
  }, restarted);
  assert.equal(await app.replay(pending, async (content) => { replies.push(content); }), "handled");
  assert.deepEqual(replies, ["恢复后的结果"]);
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.inbox.length, 0);
  assert.equal(snapshot.outbox.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /恢复后的结果|@ThreadFerry/);
});

test("a failed callback delivery remains in the durable outbox", async () => {
  const config = testConfig();
  const state = new ThreadFerryState();
  const app = createApp(config, { history: async () => [], runtime: async () => ({ text: "待补发结果" }) }, state);
  const result = await app.handle({
    msgId: "delivery-1", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async (_content, finish = true) => {
    if (finish) throw new Error("connection closed");
  });
  assert.equal(result, "delivery_pending");
  const snapshot = await state.snapshot();
  assert.equal(snapshot.turns[0]?.status, "handled");
  assert.equal(snapshot.inbox.length, 0);
  assert.equal(snapshot.outbox[0]?.content, "待补发结果");
  assert.equal(snapshot.outbox[0]?.attempts, 1);
});

test("active WeCom reply uses message.aibot.send with a JSON argument", async () => {
  const runner: CommandRunner = async (command, args) => {
    assert.equal(command, "wecom-cli");
    assert.deepEqual(args.slice(0, 4), ["message", "aibot", "send", "--json"]);
    assert.deepEqual(JSON.parse(args[4]!), {
      chat_id: "group",
      msg_type: "markdown",
      markdown: { content: "恢复结果" },
    });
    return { stdout: JSON.stringify({ errcode: 0, data: { success: true } }), stderr: "" };
  };
  await sendWecomReply("group", "恢复结果", runner);
});

test("Codex starts a fresh session only when a saved session is definitely missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-codex-resume-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (calls.length === 1) throw new CommandExecutionError("codex", 1, "", "No rollout found with id missing-session");
    return {
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "new-session" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "新会话结果" } })}\n`,
      stderr: "",
    };
  };
  const result = await runCodex({ workspace, prompt: "分析", sessionId: "missing-session" }, runner);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(-3), ["resume", "missing-session", "-"]);
  assert.equal(calls[1]?.at(-1), "-");
  assert.ok(!calls[1]?.includes("resume"));
  assert.deepEqual(result, { text: "新会话结果", sessionId: "new-session" });
});

test("Pi uses only guarded read tools and parses its machine-readable result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-pi-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  let received: { command: string; args: string[]; cwd?: string; input?: string; secret?: string } | undefined;
  const runner: CommandRunner = async (command, args, options) => {
    received = { command, args, cwd: options?.cwd, input: options?.input, secret: options?.env?.THREADFERRY_WECOM_BOT_SECRET };
    return {
      stdout: `${JSON.stringify({ type: "session", id: "pi-session" })}\n${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Pi 只读分析" }] },
      })}\n`,
      stderr: "",
    };
  };
  const result = await runPi({ agentId: "reviewer", workspace, prompt: "分析", model: "provider/model" }, runner, join(root, "sessions"));
  assert.deepEqual(result, { text: "Pi 只读分析", sessionId: "pi-session" });
  assert.equal(received?.command, "pi");
  assert.equal(received?.cwd, workspace);
  assert.equal(received?.input, "分析");
  assert.equal(received?.secret, undefined);
  assert.equal(received?.args[received.args.indexOf("--tools") + 1], "read,ls");
  for (const flag of ["--no-extensions", "--extension", "--no-skills", "--no-context-files", "--no-approve"]) {
    assert.ok(received?.args.includes(flag));
  }
  assert.equal(received?.args[received.args.indexOf("--model") + 1], "provider/model");
});

test("Pi read guard rejects workspace escapes, symlinks, and sensitive files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-pi-guard-"));
  const outside = await mkdtemp(join(tmpdir(), "threadferry-pi-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(root, "source.ts"), "export {};\n");
  await writeFile(join(root, ".env"), "SECRET=hidden\n");
  await symlink(outside, join(root, "outside"), "dir");
  assert.equal(allowedReadPath(root, "source.ts"), true);
  assert.equal(allowedReadPath(root, "../outside"), false);
  assert.equal(allowedReadPath(root, "~/.ssh/id_ed25519"), false);
  assert.equal(allowedReadPath(root, "outside"), false);
  assert.equal(allowedReadPath(root, ".env"), false);
});

test("running Codex work can be cancelled during shutdown", async () => {
  const config = testConfig();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const app = createApp(config, {
    history: async () => [],
    runtime: ({ signal }) => new Promise((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  const result = app.handle({
    msgId: "cancel-1", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async () => undefined);
  await running;
  await app.shutdown();
  assert.equal(await result, "failed");
});

test("running work finishes during an automatic-update drain", async () => {
  const config = testConfig();
  let started!: () => void;
  let finish!: (result: { text: string }) => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const app = createApp(config, {
    history: async () => [],
    runtime: () => new Promise((resolve) => {
      finish = resolve;
      started();
    }),
  });
  const result = app.handle({
    msgId: "drain-1", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async () => undefined);
  await running;
  let drained = false;
  const drain = app.shutdown(false).then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish({ text: "done" });
  await drain;
  assert.equal(await result, "handled");
});

test("command runner aborts the child process", async () => {
  const controller = new AbortController();
  const running = runCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
