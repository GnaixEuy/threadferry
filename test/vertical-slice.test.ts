import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { listWecomGroups, searchWecomUsers, sendWecomReply, wecomFailureReason } from "../src/channels/wecom.js";
import { addAgent, agentView, loadConfig, onboardingDefaults, pairConfig, refreshAgentView, resolveWorkspace, saveConfig, setupConfig } from "../src/config.js";
import { fetchWecomHistory } from "../src/history/wecom-cli.js";
import { CommandExecutionError, runCommand } from "../src/process.js";
import { runCodex } from "../src/runtimes/codex.js";
import { allowedReadPath } from "../src/runtimes/pi-readonly-extension.js";
import { runPi } from "../src/runtimes/pi.js";
import { ThreadFerryState } from "../src/state.js";
import type { AgentView, CommandRunner, GroupMessage, IncomingMention, ThreadFerryConfig } from "../src/types.js";

function testConfig(workspace = "/workspace", ownerUser = "user", groupId = "group"): AgentView {
  return {
    version: 6,
    ownerUser,
    agents: { default: { workspace, runtime: "codex", ownerUser } },
    groups: { [groupId]: { agent: "default", allowUsers: [ownerUser], context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
}

// 全量配置形状：群按 Agent 记授权，一个群可以同时挂多台机器人。
function fullConfig(workspace = "/workspace", ownerUser = "user", groupId = "group"): ThreadFerryConfig {
  return {
    version: 6,
    ownerUser,
    agents: { default: { workspace, runtime: "codex", ownerUser } },
    groups: { [groupId]: { agents: { default: { allowUsers: [ownerUser] } }, context: { lookbackHours: 6, maxMessages: 80 } } },
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
  config.agents.reviewer = { workspace: "/review-workspace", runtime: "pi", model: "provider/reviewer", ownerUser: "owner" };
  const persisted: Array<{ groupId: string; users: string[] }> = [];
  const boundGroups: string[] = [];
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
    bindGroup: async (groupId) => { boundGroups.push(groupId); },
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

  assert.equal(await direct("owner", "threadferry help"), "command");
  assert.match(replies.at(-1) ?? "", /接入群聊.*数据访问权限.*threadferry groups.*threadferry bind/s);
  // 1:1 之后 help 不再提 Agent 参数，也不再有 use 命令。
  assert.doesNotMatch(replies.at(-1) ?? "", /threadferry use </);
  assert.doesNotMatch(replies.at(-1) ?? "", /bind <群名或ID> <Agent名>/);
  assert.equal(await direct("new-user", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /只有.*Owner/);
  assert.equal(await direct("owner", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /AI Coding/);
  assert.match(replies.at(-1) ?? "", /\[default\].*\[未配置 Agent\]/s);
  assert.equal(await direct("owner", "threadferry agents"), "command");
  assert.match(replies.at(-1) ?? "", /reviewer.*pi.*provider\/reviewer/s);
  // bind 不接受 Agent 参数：绑定到「正在对话的这个 Agent」。
  assert.equal(await direct("owner", "threadferry bind 未配置群"), "command");
  assert.deepEqual(boundGroups, ["group-unconfigured"]);
  assert.equal(config.groups["group-unconfigured"]?.agent, "default");
  assert.match(replies.at(-1) ?? "", /已绑定到我/);
  // 已绑定的群不能重复绑定。
  assert.equal(await direct("owner", "threadferry bind 未配置群"), "command");
  assert.match(replies.at(-1) ?? "", /已经绑给我了/);
  // 机器人看不见的群要说清楚，而不是含糊报错。
  assert.equal(await direct("owner", "threadferry bind 不存在的群"), "command");
  assert.match(replies.at(-1) ?? "", /我看不到群/);
  // 非 Owner 的私聊被拒绝时，回调 userid 会映射到目录 ID 以判断是否 Owner（缓存后不再搜索）。
  assert.equal(searchCalls, 1);
  assert.equal(await group("owner", "@机器人 先用默认 Agent 分析"), "handled");
  assert.equal(runtimeAgents[0], "default:codex:/workspace");
  // 群改绑到别的 Agent 现在只能通过配置/管理台完成（1:1 后私聊没有 use 命令）。
  config.groups.group!.agent = "reviewer";
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

test("owner is recognized when the callback uses a different userid namespace than the config", async () => {
  const config = testConfig("/workspace", "wow-owner-directory-id");
  let runtimeCalls = 0;
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => { runtimeCalls += 1; return { text: "分析结果", sessionId: "s" }; },
    searchUsers: async (keywords) => keywords
      .filter((keyword) => keyword === "SuYueXiang" || keyword === "wow-owner-directory-id")
      .map((keyword) => ({ id: "wow-owner-directory-id", name: "苏粤翔", matchedKeywords: [keyword] })),
  });
  const replies: string[] = [];
  const send = (msgId: string, senderId: string, text: string) => app.handleDirect({
    msgId, senderId, time: new Date(), text,
  }, async (content) => { replies.push(content); });

  // 回调给明文 userid（SuYueXiang），配置存的是目录 ID（wow-...），映射后应识别为 Owner。
  assert.equal(await send("m1", "SuYueXiang", "帮我分析一下"), "handled");
  assert.equal(runtimeCalls, 1);
  assert.equal(replies[0], "ThreadFerry 已收到，正在分析。");
  // whoami 展示统一为目录 ID，和配置/管理台一致，不再一会儿拼音一会儿官方 ID。
  assert.equal(await send("m2", "SuYueXiang", "threadferry whoami"), "command");
  assert.match(replies.at(-1) ?? "", /wow-owner-directory-id/);
  // 非 Owner 的明文回调 ID 映射后仍被拒绝。
  assert.equal(await send("m3", "OtherUser", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /只有.*Owner/);
});

test("a non-owner direct message explains the fix without leaking the configured owner", async () => {
  const config = testConfig("/workspace", "owner-from-old-corp");
  const app = createApp(config, { history: async () => [], runtime: async () => ({ text: "不应执行" }) });
  const replies: string[] = [];
  const send = (text: string, msgId: string) => app.handleDirect({
    msgId, senderId: "owner-from-new-corp", time: new Date(), text,
  }, async (content) => { replies.push(content); });

  assert.equal(await send("你好", "chat"), "command");
  assert.equal(await send("threadferry groups", "manage"), "command");
  for (const reply of replies) {
    assert.match(reply, /ThreadFerry Owner/);
    // 告诉对方自己的 userid（与公开的 whoami 一致）和恢复办法。
    assert.match(reply, /owner-from-new-corp/);
    assert.match(reply, /threadferry setup/);
    assert.match(reply, /更换了企业/);
    // 但绝不回显配置里的 Owner。
    assert.doesNotMatch(reply, /owner-from-old-corp/);
  }
  assert.match(replies[0] ?? "", /私聊 Agent/);
  assert.match(replies[1] ?? "", /管理群权限/);

  // whoami 仍对任何人开放，是使用者自助拿到新 userid 的入口。
  assert.equal(await send("threadferry whoami", "who"), "command");
  assert.match(replies.at(-1) ?? "", /owner-from-new-corp/);
});

test("owner toggles all-member access in direct chat", async () => {
  const config = testConfig("/workspace", "owner");
  const access: Array<{ groupId: string; allowAll: boolean }> = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => ({ text: "分析结果" }),
    updateGroupAccess: async (groupId, allowAll) => { access.push({ groupId, allowAll }); },
    listGroups: async () => [{ id: "group", name: "AI Coding" }],
  });
  const replies: string[] = [];
  let sequence = 0;
  const direct = (senderId: string, text: string) => app.handleDirect({
    msgId: `direct-${sequence += 1}`,
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
  }, async () => undefined);

  assert.equal(await group("guest", "@机器人 分析"), "unauthorized_user");
  assert.equal(await direct("guest", "threadferry open AI Coding"), "command");
  assert.equal(access.length, 0);
  assert.equal(await direct("owner", "threadferry open AI Coding"), "command");
  assert.match(replies.at(-1) ?? "", /所有成员/);
  assert.deepEqual(access, [{ groupId: "group", allowAll: true }]);
  assert.equal(config.groups.group?.allowAll, true);
  assert.equal(await group("guest", "@机器人 分析"), "handled");
  assert.equal(await direct("owner", "threadferry users AI Coding"), "command");
  assert.match(replies.at(-1) ?? "", /已开启全员可用/);
  assert.equal(await direct("owner", "threadferry groups"), "command");
  assert.match(replies.at(-1) ?? "", /全员可用 AI Coding/);
  assert.equal(await direct("owner", "threadferry close AI Coding"), "command");
  assert.match(replies.at(-1) ?? "", /仅授权成员/);
  assert.deepEqual(access.at(-1), { groupId: "group", allowAll: false });
  assert.equal(await group("guest", "@机器人 再分析"), "unauthorized_user");
  assert.equal(await direct("owner", "threadferry users AI Coding"), "command");
  assert.doesNotMatch(replies.at(-1) ?? "", /全员可用/);
});

test("a write request is proposed, waits for the owner, and only then executes", async () => {
  // Runtime 仍然只读：它只输出一个动作提议，执行由 ThreadFerry 在 Owner 确认后进行。
  const config = testConfig("/workspace", "owner");
  const executed: string[][] = [];
  const groupNotices: Array<{ groupId: string; content: string }> = [];
  const replies: string[] = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => ({
      text: "好的，我建议这样安排。\n\n```threadferry-action\n"
        + '{"action":"schedule.create","subject":"回归测试复盘","begin_time":"2026-08-21 10:00:00","end_time":"2026-08-21 11:00:00"}'
        + "\n```",
    }),
    runAction: async (command) => { executed.push(command); },
    notifyGroup: async (groupId, content) => { groupNotices.push({ groupId, content }); },
  });
  const push = async (content: string, finish = true) => { if (finish) replies.push(content); };

  const asked = await app.handle({
    msgId: "m-action-1", groupId: "group", senderId: "owner", time: new Date(),
    text: "@机器人 帮我建个日程，关于刚才的测试", mentioned: true,
  }, push);
  assert.equal(asked, "handled");
  // 群里看到的是自然语言 + 待确认摘要，绝不能出现原始 JSON。
  const proposal = replies.at(-1) ?? "";
  assert.match(proposal, /好的，我建议这样安排/);
  assert.match(proposal, /创建日程[\s\S]*回归测试复盘/);
  assert.match(proposal, /threadferry confirm [0-9A-F]{6}/);
  assert.ok(!proposal.includes("threadferry-action"));
  assert.ok(!proposal.includes("\"action\""));
  // 没确认之前一次都不能执行。
  assert.deepEqual(executed, []);

  const code = /threadferry confirm ([0-9A-F]{6})/.exec(proposal)![1]!;
  // 每次都给新的 msgId：命令按 msgId 去重，重发同一条会被正确判成 duplicate。
  let sequence = 0;
  const direct = (text: string, senderId = "owner") => app.handleDirect(
    { msgId: `d-${sequence += 1}`, senderId, time: new Date(), text }, push);

  // 非 Owner 连确认命令都走不到（私聊管理命令本来就只对 Owner 开放）。
  assert.equal(await direct(`threadferry confirm ${code}`, "someone-else"), "command");
  assert.match(replies.at(-1) ?? "", /只有机器人创建者/);
  assert.deepEqual(executed, []);

  // 错误确认码不执行任何东西。
  assert.equal(await direct("threadferry confirm 000000"), "command");
  assert.match(replies.at(-1) ?? "", /确认码无效或已过期/);
  assert.deepEqual(executed, []);

  // Owner 确认后才真正执行，并把回执发回原来的群。
  assert.equal(await direct(`threadferry confirm ${code}`), "command");
  assert.deepEqual(executed, [["calendar", "schedules", "create", "--json",
    JSON.stringify({ subject: "回归测试复盘", begin_time: "2026-08-21 10:00:00", end_time: "2026-08-21 11:00:00" })]]);
  assert.match(replies.at(-1) ?? "", /已执行[\s\S]*回归测试复盘/);
  assert.deepEqual(groupNotices.map((notice) => notice.groupId), ["group"]);
  assert.match(groupNotices[0]!.content, /已按 Owner 确认执行/);

  // 确认码是一次性的。
  assert.equal(await direct(`threadferry confirm ${code}`), "command");
  assert.match(replies.at(-1) ?? "", /确认码无效或已过期/);
  assert.equal(executed.length, 1);
});

test("an unexecutable proposal explains itself instead of silently dropping", async () => {
  const config = testConfig("/workspace", "owner");
  const replies: string[] = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => ({
      text: "安排好了。\n\n```threadferry-action\n"
        + '{"action":"schedule.create","subject":"会","begin_time":"明天十点","end_time":"2026-08-21 11:00:00"}'
        + "\n```",
    }),
    runAction: async () => { throw new Error("不该被调用"); },
  });
  await app.handleDirect({ msgId: "d-bad", senderId: "owner", time: new Date(), text: "建个日程" },
    async (content) => { replies.push(content); });
  assert.match(replies.at(-1) ?? "", /这个动作我没法执行[\s\S]*2026-08-21 10:00:00/);
  assert.ok(!(replies.at(-1) ?? "").includes("threadferry-action"));
});

test("both bots answer when one @ message mentions them together", async (t) => {
  // 群里同时 @ 两台机器人时，企业微信给每台各发一次回调，msgId 是同一条消息的。
  // 「已处理」的判定必须带上 Agent，否则第二台会被当成重复消息丢掉——用户看到的就是有一台不回话。
  const root = await mkdtemp(join(tmpdir(), "threadferry-both-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const state = new ThreadFerryState(join(root, "state.json"));
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "owner",
    agents: {
      "叶翔": { workspace, runtime: "codex", ownerUser: "owner" },
      "悦翔": { workspace, runtime: "pi", ownerUser: "owner" },
    },
    groups: {
      group: {
        agents: { "叶翔": { allowUsers: ["owner"] }, "悦翔": { allowUsers: ["owner"] } },
        context: { lookbackHours: 6, maxMessages: 80 },
      },
    },
    security: { requireMention: true, readOnly: true },
  };
  const replies: Array<{ agentId: string; text: string }> = [];
  const appFor = (agentId: string) => createApp(agentView(config, agentId), {
    history: async () => [],
    runtime: async ({ runtime }) => ({ text: `${runtime} 的回答`, sessionId: `${runtime}-session` }),
  }, state);
  const mention: IncomingMention = {
    msgId: "shared-msg-1",
    groupId: "group",
    senderId: "owner",
    time: new Date(),
    text: "@叶翔 @悦翔 你们好",
    mentioned: true,
  };

  const statuses = await Promise.all(["叶翔", "悦翔"].map(async (agentId) => appFor(agentId).handle(
    { ...mention },
    async (content, finish = true) => { if (finish) replies.push({ agentId, text: content }); },
  )));
  assert.deepEqual(statuses, ["handled", "handled"]);
  assert.deepEqual(replies.map((reply) => reply.agentId).sort(), ["叶翔", "悦翔"]);
  assert.deepEqual(replies.map((reply) => reply.text).sort(), ["codex 的回答", "pi 的回答"]);

  // 两台机器人各留一条 turn，各自完成，互不覆盖。
  const snapshot = await state.snapshot();
  assert.equal(snapshot.turns.filter((turn) => turn.status === "handled").length, 2);
  assert.equal(snapshot.outbox.length, 0);
  assert.equal(snapshot.inbox.length, 0);

  // 同一台机器人重复收到同一条消息仍然算重复，不会答两次。
  assert.equal(await appFor("叶翔").handle({ ...mention }, async () => undefined), "duplicate");

  // 群命令同理：@ 两台机器人发一条 threadferry 命令，两台都要认。
  const command: IncomingMention = { ...mention, msgId: "shared-cmd-1", text: "@叶翔 @悦翔 threadferry help" };
  const commandStatuses = await Promise.all(["叶翔", "悦翔"].map((agentId) =>
    appFor(agentId).handle({ ...command }, async () => undefined)));
  assert.deepEqual(commandStatuses, ["command", "command"]);
});

test("group discovery merges messaged groups with the bot's own sessions", async () => {
  // 拉机器人进群不会产生机器人会话，所以群只能从「有消息的群会话」里发现；
  // 机器人会话只用来给已经互动过的群盖「机器人已在群」的章。
  const calls: string[][] = [];
  const now = new Date("2026-08-19T18:00:00");
  const groups = await listWecomGroups(async (command, args) => {
    assert.equal(command, "wecom-cli");
    calls.push(args);
    if (args[0] === "chat") {
      const request = JSON.parse(args[4]!) as { begin_time: string; end_time: string; cursor?: string };
      assert.equal(request.end_time, "2026-08-19 18:00:00");
      assert.equal(request.begin_time, "2026-08-12 18:01:00");
      // 翻页是时间切片，同一个群会重复出现，必须去重。
      return request.cursor
        ? { stdout: JSON.stringify({ chats: [{ chat_id: "group-1", chat_name: "月相工作室" }], has_more: false }), stderr: "" }
        : {
          stdout: JSON.stringify({
            chats: [
              { chat_id: "group-1", chat_name: "月相工作室" },
              { chat_id: "group-2", chat_name: "新群" },
              // 私聊不能混进待绑定群：私聊靠 Owner 配对，不走群绑定。
              { chat_id: "user-1", chat_name: "苏粤翔", chat_type: "single" },
            ],
            has_more: true,
            next_cursor: "page-2",
          }),
          stderr: "",
        };
    }
    return {
      stdout: JSON.stringify({
        sessions: [
          { chat_id: "group-1", chat_name: "月相工作室", chat_type: "group" },
          { chat_id: "user-1", chat_name: "苏粤翔", chat_type: "single" },
        ],
      }),
      stderr: "",
    };
  }, now);
  assert.deepEqual(groups, [
    { id: "group-1", name: "月相工作室", hasBotSession: true },
    { id: "group-2", name: "新群" },
  ]);
  assert.deepEqual(calls.filter((args) => args[0] === "message")[0], ["message", "aibot", "sessions", "list", "--json", "{}"]);
  assert.equal(calls.filter((args) => args[0] === "chat").length, 2);
});

test("group discovery survives one source failing but not both", async () => {
  const onlySessions = await listWecomGroups(async (_command, args) => args[0] === "chat"
    ? { stdout: JSON.stringify({ errcode: 853006 }), stderr: "" }
    : { stdout: JSON.stringify({ sessions: [{ chat_id: "group-1", chat_type: "group" }] }), stderr: "" });
  assert.deepEqual(onlySessions, [{ id: "group-1", hasBotSession: true }]);

  const onlyMessaged = await listWecomGroups(async (_command, args) => args[0] === "chat"
    ? { stdout: JSON.stringify({ chats: [{ chat_id: "group-2", chat_name: "新群" }], has_more: false }), stderr: "" }
    : { stdout: "not json", stderr: "" });
  assert.deepEqual(onlyMessaged, [{ id: "group-2", name: "新群" }]);

  await assert.rejects(
    listWecomGroups(async () => ({ stdout: JSON.stringify({ errcode: 853006 }), stderr: "" })),
    /853006/,
  );
});

test("a failed group lookup reports the reason wecom-cli printed, not just the exit code", async () => {
  const stderr = JSON.stringify({
    error: { type: "UnknownError", code: 893999, message: "AuthError: 该请求需要授权，请先运行 `wecom-cli auth init` 登录 [code=893201]" },
  });
  // wecom-cli 把结构化错误打在 stdout 上，退出码才是 1——只读 stderr 会永远只看到「退出码 1」。
  const failure = new CommandExecutionError("wecom-cli", 1, stderr, "");
  assert.equal(failure.message, "wecom-cli 执行失败（退出码 1）");
  assert.match(wecomFailureReason(failure), /该请求需要授权/);
  assert.match(wecomFailureReason(new CommandExecutionError("wecom-cli", 1, "", stderr)), /该请求需要授权/);
  // 非 JSON 输出退回第一行；什么都没有时退回原始 message。
  assert.equal(wecomFailureReason(new CommandExecutionError("wecom-cli", 1, "boom\nmore", "")), "boom");
  assert.equal(wecomFailureReason(new CommandExecutionError("wecom-cli", 1, "  ", "  ")), "wecom-cli 执行失败（退出码 1）");
  assert.equal(wecomFailureReason("not an error"), "企业微信查询失败");
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
  await writeFile(configPath, `version: 6\nagents:\n  default:\n    runtime: codex\n    workspace: ../outside\n    owner_user: user\n    groups:\n      group:\n        allow_users: [user]\n`);
  await assert.rejects(loadConfig(configPath), /绝对路径/);

  const compactPath = join(root, "compact.yaml");
  const workspace = await realpath(root);
  const defaultAgent = { workspace, runtime: "codex" as const };
  await writeFile(compactPath, setupConfig("group", "default", defaultAgent, "user"));
  const compact = await loadConfig(compactPath);
  assert.equal(compact.agents.default?.runtime, "codex");
  assert.equal(compact.ownerUser, "user");
  assert.deepEqual(compact.groups.group?.context, { lookbackHours: 6, maxMessages: 80 });
  assert.deepEqual(compact.groups.group?.agents.default?.allowUsers, ["user"]);

  const mergedPath = join(root, "merged.yaml");
  await writeFile(mergedPath, setupConfig("group", "default", defaultAgent, "user", compact));
  const merged = await loadConfig(mergedPath);
  assert.deepEqual(merged.groups.group?.agents.default?.allowUsers, ["user"]);
  await writeFile(mergedPath, setupConfig("group-2", "default", defaultAgent, "user-2", compact));
  const pairedByCode = await loadConfig(mergedPath);
  assert.equal(pairedByCode.ownerUser, "user");
  assert.deepEqual(pairedByCode.groups["group-2"]?.agents.default?.allowUsers, ["user"]);
  await writeFile(mergedPath, pairConfig("default", defaultAgent, "user-2", compact));
  const pairedDirectly = await loadConfig(mergedPath);
  assert.equal(pairedDirectly.ownerUser, "user-2");
  assert.deepEqual(pairedDirectly.groups.group?.agents.default?.allowUsers, ["user-2"]);
  await writeFile(mergedPath, pairConfig("default", defaultAgent, "user-3"));
  assert.deepEqual((await loadConfig(mergedPath)).groups, {});

  compact.groups.group!.agents.default!.allowUsers.push("user-2");
  await saveConfig(compactPath, compact);
  assert.deepEqual((await loadConfig(compactPath)).groups.group?.agents.default?.allowUsers, ["user", "user-2"]);

  compact.groups.group!.agents.default!.allowAll = true;
  await saveConfig(compactPath, compact);
  assert.equal((await loadConfig(compactPath)).groups.group?.agents.default?.allowAll, true);
  delete compact.groups.group!.agents.default!.allowAll;
  await saveConfig(compactPath, compact);
  assert.equal((await loadConfig(compactPath)).groups.group?.agents.default?.allowAll, undefined);
});

test("one group can run two bots at once, each with its own allowlist and switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-multi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const path = join(root, "two-bots.yaml");
  // 群里有两台机器人：同一个群分别绑给两个 Agent，各自一份名单。
  const first = setupConfig("group", "叶翔", { workspace, runtime: "codex" }, "owner");
  await writeFile(path, first);
  const withOne = await loadConfig(path);
  const both = addAgent(withOne, "悦翔", { workspace, runtime: "pi" });
  await writeFile(path, setupConfig("group", "悦翔", { workspace, runtime: "pi" }, "owner", both));
  const loaded = await loadConfig(path);

  assert.deepEqual(Object.keys(loaded.groups.group!.agents).sort(), ["叶翔", "悦翔"]);
  loaded.groups.group!.agents["悦翔"]!.allowUsers = ["owner", "teammate"];
  loaded.groups.group!.agents["悦翔"]!.allowAll = true;
  await saveConfig(path, loaded);
  const reloaded = await loadConfig(path);
  // 两台机器人的名单和开关互不影响。
  assert.deepEqual(reloaded.groups.group?.agents["叶翔"]?.allowUsers, ["owner"]);
  assert.equal(reloaded.groups.group?.agents["叶翔"]?.allowAll, undefined);
  assert.deepEqual(reloaded.groups.group?.agents["悦翔"]?.allowUsers, ["owner", "teammate"]);
  assert.equal(reloaded.groups.group?.agents["悦翔"]?.allowAll, true);

  // 单 Agent 运行视图里，这个群仍然只归它自己——app.ts 完全看不到另一台机器人。
  const view = agentView(reloaded, "叶翔");
  assert.deepEqual(Object.keys(view.groups), ["group"]);
  assert.equal(view.groups.group?.agent, "叶翔");
  assert.deepEqual(view.groups.group?.allowUsers, ["owner"]);
  assert.equal(agentView(reloaded, "悦翔").groups.group?.allowAll, true);
});

test("agent names must be directory-safe while onboarding uses the invocation directory", () => {
  const current = fullConfig("/saved/workspace");
  const defaults = onboardingDefaults(current, "/current/invocation");

  assert.deepEqual(defaults, {
    agentId: "default",
    runtime: "codex",
    workspace: "/current/invocation",
    model: undefined,
  });
  assert.doesNotThrow(() => setupConfig("group", "code-review_2", {
    workspace: "/current/invocation",
    runtime: "codex",
  }, "user"));
  // 中文和空格是合法目录名，v5 起支持；路径分隔符、`.`/`..`、开头结尾空格和超长才拒绝。
  assert.doesNotThrow(() => setupConfig("group", "代码审查 Agent", {
    workspace: "/current/invocation",
    runtime: "codex",
  }, "user"));
  for (const bad of [" Agent", "a/b", "../escape", ".", "..", "超".repeat(129)]) {
    assert.throws(() => setupConfig("group", bad, {
      workspace: "/current/invocation",
      runtime: "codex",
    }, "user"), /Agent 名/);
  }
});

test("the v6 disk format round-trips agents, their groups and credential overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-v6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const source = join(root, "source.yaml");
  await writeFile(source, [
    "version: 6",
    "agents:",
    "  default:",
    "    runtime: codex",
    `    workspace: ${JSON.stringify(workspace)}`,
    "    owner_user: woOWNER",
    "    groups:",
    "      g1:",
    "        allow_users: [woOWNER, woTEAM]",
    "  reviewer:",
    "    runtime: pi",
    `    workspace: ${JSON.stringify(workspace)}`,
    "    model: provider/model",
    "    owner_user: woOWNER",
    "    groups:",
    "      g2:",
    "        allow_users: [woOWNER]",
    "        allow_all: true",
    "",
  ].join("\n"));

  const fromV5 = await loadConfig(source);
  const upgraded = join(root, "written.yaml");
  await saveConfig(upgraded, fromV5);
  const text = await readFile(upgraded, "utf8");
  assert.match(text, /^version: 6$/m);
  assert.doesNotMatch(text, /^owner_user:/m);
  assert.doesNotMatch(text, /^groups:/m);
  assert.match(text, /default:[\s\S]*owner_user: woOWNER[\s\S]*groups:[\s\S]*g1:/);
  assert.match(text, /reviewer:[\s\S]*model: provider\/model[\s\S]*g2:[\s\S]*allow_all: true/);

  // 再读回来语义必须完全一致。
  const fromV6 = await loadConfig(upgraded);
  assert.deepEqual(fromV6, fromV5);
  assert.equal(fromV6.version, 6);
  assert.equal(fromV6.ownerUser, "woOWNER");
  assert.deepEqual(Object.keys(fromV6.groups.g1!.agents), ["default"]);
  assert.deepEqual(Object.keys(fromV6.groups.g2!.agents), ["reviewer"]);
  assert.equal(fromV6.groups.g2?.agents.reviewer?.allowAll, true);
  assert.equal(fromV6.agents.reviewer?.model, "provider/model");

  // config_dir 往返保留。
  fromV6.agents.reviewer!.configDir = join(workspace, "creds");
  await saveConfig(upgraded, fromV6);
  assert.match(await readFile(upgraded, "utf8"), /config_dir: /);
  assert.equal((await loadConfig(upgraded)).agents.reviewer?.configDir, join(workspace, "creds"));
});

test("v6 configuration rejects shapes the runtime cannot honour", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-v6-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const agent = (id: string, body: string[]) => [`  ${id}:`, "    runtime: codex", `    workspace: ${JSON.stringify(workspace)}`, ...body];
  const write = async (name: string, lines: string[]) => {
    const target = join(root, name);
    await writeFile(target, ["version: 6", "agents:", ...lines, ""].join("\n"));
    return target;
  };

  // 同一个群挂在两个 Agent 下是**合法**的：群里可以同时有两台机器人，各自一份授权。
  const shared = await write("shared.yaml", [
    ...agent("a", ["    owner_user: woOWNER", "    groups:", "      shared:", "        allow_users: [woOWNER]"]),
    ...agent("b", ["    owner_user: woOWNER", "    groups:", "      shared:", "        allow_users: [woOWNER]", "        allow_all: true"]),
  ]);
  const twoBots = await loadConfig(shared);
  assert.deepEqual(Object.keys(twoBots.groups.shared!.agents).sort(), ["a", "b"]);
  assert.equal(twoBots.groups.shared?.agents.a?.allowAll, undefined);
  assert.equal(twoBots.groups.shared?.agents.b?.allowAll, true);

  // 每个 Agent 独立 Owner 是本改造的目标能力（跨企业时同一个人 userid 不同）。
  const perAgentOwners = await write("per-agent-owner.yaml", [
    ...agent("a", ["    owner_user: woOWNER"]),
    ...agent("b", ["    owner_user: woOTHER"]),
  ]);
  const loaded = await loadConfig(perAgentOwners);
  assert.equal(loaded.agents.a?.ownerUser, "woOWNER");
  assert.equal(loaded.agents.b?.ownerUser, "woOTHER");

  const noOwner = await write("no-owner.yaml", agent("a", []));
  await assert.rejects(loadConfig(noOwner), /缺少有效的 owner_user/);
  const badOwner = await write("bad-owner.yaml", agent("a", ["    owner_user: \"has space\""]));
  await assert.rejects(loadConfig(badOwner), /缺少有效的 owner_user/);

  // 群的授权名单必须包含**所属 Agent 自己**的 Owner，不是别的 Agent 的。
  const wrongOwnerInGroup = await write("wrong-owner.yaml", [
    ...agent("a", ["    owner_user: woA", "    groups:", "      g1:", "        allow_users: [woB]"]),
    ...agent("b", ["    owner_user: woB"]),
  ]);
  await assert.rejects(loadConfig(wrongOwnerInGroup), /必须包含该 Agent 的 owner_user/);

  const relativeDir = await write("relative.yaml", agent("a", ["    owner_user: woOWNER", "    config_dir: relative/dir"]));
  await assert.rejects(loadConfig(relativeDir), /config_dir 必须是绝对路径/);

  const strayRoot = await write("stray.yaml", [...agent("a", ["    owner_user: woOWNER"]), "owner_user: woOWNER"]);
  await assert.rejects(loadConfig(strayRoot), /不支持字段: owner_user/);

  const strayGroupKey = await write("stray-group.yaml", [
    ...agent("a", ["    owner_user: woOWNER", "    groups:", "      g1:", "        allow_users: [woOWNER]", "        agent: a"]),
  ]);
  await assert.rejects(loadConfig(strayGroupKey), /不支持字段: agent/);

  // 群的授权名单仍然必须包含 Owner。
  const ownerMissing = await write("owner-missing.yaml", [
    ...agent("a", ["    owner_user: woOWNER", "    groups:", "      g1:", "        allow_users: [woTEAM]"]),
  ]);
  await assert.rejects(loadConfig(ownerMissing), /必须包含该 Agent 的 owner_user/);
});

test("legacy and extra configuration fields are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyPath = join(root, "legacy.yaml");
  await writeFile(legacyPath, "version: 1\nchannels: {}\n");
  await assert.rejects(loadConfig(legacyPath), /version 必须为 6/);

  const extraPath = join(root, "extra.yaml");
  await writeFile(extraPath, `version: 6\nagents:\n  default:\n    runtime: codex\n    workspace: ${JSON.stringify(await realpath(root))}\n    owner_user: user\n    groups:\n      group:\n        allow_users: [user]\n        runtime: codex\n`);
  await assert.rejects(loadConfig(extraPath), /不支持字段: runtime/);

  const badAccessPath = join(root, "bad-access.yaml");
  await writeFile(badAccessPath, `version: 6\nagents:\n  default:\n    runtime: codex\n    workspace: ${JSON.stringify(await realpath(root))}\n    owner_user: user\n    groups:\n      group:\n        allow_users: [user]\n        allow_all: 1\n`);
  await assert.rejects(loadConfig(badAccessPath), /allow_all 必须是布尔值/);
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
  const errors: Array<{ errorId: string; phase: string; reason?: string }> = [];
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
  // 产品决策变更（2026-08-19）：失败原因直接回给用户。只给错误编号让人再去跑
  // threadferry status 实测毫无帮助——原因本来就来自 Runtime CLI 的固定文案。
  assert.match(replies.at(-1) ?? "", /原因：.*secret detail must not escape/);
  assert.equal(errors[0]?.phase, "runtime");
  assert.equal(errors[0]?.reason, "secret detail must not escape");
  assert.equal((await state.snapshot()).turns[0]?.errorId, errors[0]?.errorId);
});

test("a history failure reports its cause to the operator but never to the group", async () => {
  const config = testConfig();
  const state = new ThreadFerryState();
  const errors: Array<{ errorId: string; phase: string; reason?: string }> = [];
  const app = createApp(config, {
    history: async () => {
      throw new Error("企业未授权群消息历史能力（errcode 853006）；请让企业管理员批准机器人数据访问权限");
    },
    runtime: async () => ({ text: "不应该执行 Runtime" }),
    onError: (error) => { errors.push(error); },
  }, state);
  const replies: string[] = [];
  const result = await app.handle({
    msgId: "history-failure", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async (content) => { replies.push(content); });

  assert.equal(result, "failed");
  assert.equal(errors[0]?.phase, "history");
  assert.match(errors[0]?.reason ?? "", /errcode 853006/);
  assert.match(replies.at(-1) ?? "", /错误编号 TF-[A-F0-9]{8}/);
  // 853006 这种「企业未开通某能力」正是最该让群里看到的原因。
  assert.match(replies.at(-1) ?? "", /原因：.*errcode 853006/);
  // 但本地状态库仍然只存 errorId + phase，不落原因。
  assert.doesNotMatch(JSON.stringify(await state.snapshot()), /853006/);
});

test("a failure reason is flattened to one line and length-capped", async () => {
  const config = testConfig();
  const errors: Array<{ errorId: string; phase: string; reason?: string }> = [];
  const app = createApp(config, {
    history: async () => { throw new Error(`第一行\n\t第二行  ${"很长".repeat(200)}`); },
    runtime: async () => ({ text: "未使用" }),
    onError: (error) => { errors.push(error); },
  }, new ThreadFerryState());
  await app.handle({
    msgId: "long-failure", groupId: "group", senderId: "user", time: new Date(), text: "@ThreadFerry 分析", mentioned: true,
  }, async () => undefined);

  const reason = errors[0]?.reason ?? "";
  assert.doesNotMatch(reason, /[\n\t]/);
  assert.match(reason, /^第一行 第二行 /);
  assert.equal(reason.length, 201);
  assert.ok(reason.endsWith("…"));
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

test("wecom history reports unavailable corporation permission", async () => {
  const runner: CommandRunner = async () => {
    throw new CommandExecutionError("wecom-cli", 1, JSON.stringify({
      errcode: 853006,
      errmsg: "this tool is not available for your corporation",
    }), "");
  };

  await assert.rejects(fetchWecomHistory("group_allowed", {
    lookbackHours: 6,
    maxMessages: 80,
    endTime: new Date("2026-08-18T10:05:00+08:00"),
  }, runner), /企业未授权群消息历史能力.*853006/);
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
  const pendingMessage = pending.message;
  const config = testConfig();
  const replies: string[] = [];
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => ({ text: "恢复后的结果", sessionId: "recovered-session" }),
  }, restarted);
  assert.equal(await app.replay(pendingMessage, async (content) => { replies.push(content); }), "handled");
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

test("per-agent config views isolate groups, owners and runtime scope", async () => {
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "owner-a",
    agents: {
      frontend: { workspace: "/ws-a", runtime: "codex", ownerUser: "owner-a" },
      backend: { workspace: "/ws-b", runtime: "pi", ownerUser: "owner-b" },
    },
    groups: {
      "group-a": { agents: { frontend: { allowUsers: ["owner-a"] } }, context: { lookbackHours: 6, maxMessages: 80 } },
      "group-b": { agents: { backend: { allowUsers: ["owner-b"] } }, context: { lookbackHours: 6, maxMessages: 80 } },
    },
    security: { requireMention: true, readOnly: true },
  };

  const front = agentView(config, "frontend");
  const back = agentView(config, "backend");
  assert.deepEqual(Object.keys(front.agents), ["frontend"]);
  assert.deepEqual(Object.keys(front.groups), ["group-a"]);
  assert.equal(front.ownerUser, "owner-a");
  assert.deepEqual(Object.keys(back.groups), ["group-b"]);
  assert.equal(back.ownerUser, "owner-b");
  assert.throws(() => agentView(config, "missing"), /Agent missing 未配置/);

  // 每个视图起一个 app：私聊必定落到该视图唯一的 Agent 上，跨 Agent 的群一律拒绝。
  const runtimeCalls: Array<{ agentId: string; workspace: string }> = [];
  const makeApp = (view: AgentView) => createApp(view, {
    history: async () => [],
    runtime: async ({ agentId, workspace }) => {
      runtimeCalls.push({ agentId, workspace });
      return { text: "ok" };
    },
  });
  const frontApp = makeApp(front);
  const backApp = makeApp(back);

  // frontend 的机器人收到 group-b 的消息 → 不是自己的群。
  const mention = (groupId: string, senderId: string, msgId: string) => ({
    msgId, groupId, senderId, time: new Date(), text: "@机器人 分析", mentioned: true,
  });
  assert.equal(await frontApp.handle(mention("group-b", "owner-b", "x1"), async () => undefined), "unauthorized_group");
  assert.equal(await backApp.handle(mention("group-a", "owner-a", "x2"), async () => undefined), "unauthorized_group");
  assert.equal(await frontApp.handle(mention("group-a", "owner-a", "x3"), async () => undefined), "handled");
  assert.equal(await backApp.handle(mention("group-b", "owner-b", "x4"), async () => undefined), "handled");

  // Owner 也按 Agent 隔离：A 的 Owner 不能私聊 B 的 Agent。
  const direct = (app: ReturnType<typeof createApp>, senderId: string, msgId: string) => {
    const replies: string[] = [];
    return app.handleDirect({ msgId, senderId, time: new Date(), text: "分析一下" }, async (content) => {
      replies.push(content);
    }).then((status) => ({ status, replies }));
  };
  const crossOwner = await direct(backApp, "owner-a", "d1");
  assert.equal(crossOwner.status, "command");
  assert.match(crossOwner.replies[0] ?? "", /只有机器人创建者/);
  assert.equal((await direct(backApp, "owner-b", "d2")).status, "handled");

  // 私聊必定用该视图自己的 Workspace，不会取到别的 Agent。
  assert.deepEqual(runtimeCalls.filter((call) => call.agentId === "backend").map((call) => call.workspace), ["/ws-b", "/ws-b"]);
  assert.deepEqual(runtimeCalls.filter((call) => call.agentId === "frontend").map((call) => call.workspace), ["/ws-a"]);
});

test("refreshing a view propagates config changes and disables a removed agent", () => {
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "owner-a",
    agents: { frontend: { workspace: "/ws-a", runtime: "codex", ownerUser: "owner-a" } },
    groups: { "group-a": { agents: { frontend: { allowUsers: ["owner-a"] } }, context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
  const view = agentView(config, "frontend");

  const updated: ThreadFerryConfig = {
    ...config,
    agents: { frontend: { workspace: "/ws-a", runtime: "codex", ownerUser: "owner-new" } },
    groups: {
      ...config.groups,
      "group-c": { agents: { frontend: { allowUsers: ["owner-new"] } }, context: { lookbackHours: 6, maxMessages: 80 } },
      "group-d": { agents: { other: { allowUsers: ["x"] } }, context: { lookbackHours: 6, maxMessages: 80 } },
    },
  };
  refreshAgentView(view, updated, "frontend");
  assert.equal(view.ownerUser, "owner-new");
  assert.deepEqual(Object.keys(view.groups).sort(), ["group-a", "group-c"]);

  // Agent 被删掉后视图清空，该 app 随即拒绝所有群消息。
  refreshAgentView(view, { ...updated, agents: {} }, "frontend");
  assert.deepEqual(view.agents, {});
  assert.deepEqual(view.groups, {});
});

test("failure replies carry the reason, with local paths masked in group chats", async () => {
  const config = testConfig("/workspace", "owner");
  const quota = new Error("Codex：You've hit your usage limit. Visit https://example.test/usage");
  const withPath = new Error("Workspace 不存在: /Users/somebody/Desktop/SecretProject/sub");
  const build = (error: Error) => {
    const replies: string[] = [];
    const app = createApp(config, {
      history: async () => [],
      runtime: async () => { throw error; },
    }, new ThreadFerryState());
    return { app, replies, push: async (content: string) => { replies.push(content); } };
  };

  // 私聊对象只可能是 Owner，原因给全，不做任何遮掩。
  const direct = build(withPath);
  await direct.app.handleDirect({ msgId: "d1", senderId: "owner", time: new Date(), text: "分析" }, direct.push);
  assert.match(direct.replies.at(-1) ?? "", /原因：Workspace 不存在: \/Users\/somebody\/Desktop\/SecretProject\/sub/);

  // 群里有非 Owner 的同事，本机路径要遮掉，其余原因照给。
  const group = build(withPath);
  await group.app.handle({
    msgId: "g1", groupId: "group", senderId: "owner", time: new Date(), text: "@bot 分析", mentioned: true,
  }, group.push);
  assert.match(group.replies.at(-1) ?? "", /原因：Workspace 不存在: <本机路径>/);
  assert.doesNotMatch(group.replies.at(-1) ?? "", /SecretProject/);

  // 额度耗尽这类外部限制，群里也应该看到完整原话（不含路径，无需遮掩）。
  const limited = build(quota);
  await limited.app.handle({
    msgId: "g2", groupId: "group", senderId: "owner", time: new Date(), text: "@bot 分析", mentioned: true,
  }, limited.push);
  assert.match(limited.replies.at(-1) ?? "", /原因：Codex：You've hit your usage limit/);
  assert.match(limited.replies.at(-1) ?? "", /https:\/\/example\.test\/usage/);
});

test("a direct-chat failure is persisted so threadferry status can find it", async () => {
  const config = testConfig("/workspace", "owner");
  const state = new ThreadFerryState();
  const app = createApp(config, {
    history: async () => [],
    runtime: async () => { throw new Error("Codex：额度用完"); },
  }, state);
  assert.equal(await app.handleDirect({
    msgId: "direct-fail", senderId: "owner", time: new Date(), text: "分析",
  }, async () => undefined), "failed");

  // 原先私聊失败只回复不落盘，回复里却叫用户去跑 threadferry status。
  const turn = (await state.snapshot()).turns.at(-1);
  assert.equal(turn?.status, "failed");
  assert.equal(turn?.failurePhase, "runtime");
  assert.match(turn?.errorId ?? "", /^TF-[A-F0-9]{8}$/);
});
