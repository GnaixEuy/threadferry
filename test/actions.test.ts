import assert from "node:assert/strict";
import test from "node:test";
import { actionCatalog, extractAction, isKnownAction, prepareAction, type ProposedAction } from "../src/actions.js";

const fence = (body: string) => "```threadferry-action\n" + body + "\n```";

function wecom(command: string[], skill: string, summary = "执行测试操作"): ProposedAction {
  return { name: "wecom-cli", skill, userIntent: "explicit", arguments: { command, summary } };
}

test("a generic CLI proposal is removed from the visible reply and preserved verbatim", () => {
  const command = ["meeting", "create", "--json", JSON.stringify({ subject: "回归测试", begin_time: "2026-08-21 10:00:00", end_time: "2026-08-21 10:30:00" })];
  const result = extractAction(`好的，我来处理。\n\n${fence(JSON.stringify({
    action: "wecom-cli", skill: "wecom-unified", user_intent: "explicit", command, summary: "创建回归测试会议",
  }))}`);
  assert.equal(result.reply, "好的，我来处理。");
  assert.deepEqual(result.action, wecom(command, "wecom-unified", "创建回归测试会议"));
});

test("unknown, legacy, and malformed actions never reach the user or executor", () => {
  for (const body of [
    '{"action":"shell.exec","command":"rm -rf /"}',
    '{"action":"meeting.create","subject":"旧协议"}',
    '{"action":"wecom-cli"',
  ]) {
    const result = extractAction(`结论如下\n${fence(body)}`);
    assert.equal(result.action, undefined);
    assert.equal(result.reply, "结论如下");
  }
  assert.deepEqual(extractAction("普通回复"), { reply: "普通回复" });
  assert.equal(isKnownAction("wecom-cli"), true);
  assert.equal(isKnownAction("meeting.create"), false);
  assert.equal(isKnownAction("reminder.create"), true);
  assert.match(actionCatalog(), /wecom-cli[\s\S]*command[\s\S]*reminder\.create/);
});

test("only the first proposal is considered and every internal fence is hidden", () => {
  const first = JSON.stringify({
    action: "wecom-cli", skill: "wecom-unified", user_intent: "explicit",
    command: ["meeting", "create", "--json", "{}"], summary: "创建会议",
  });
  const second = JSON.stringify({
    action: "wecom-cli", skill: "wecom-unified", user_intent: "explicit",
    command: ["meeting", "cancel", "--json", "{}"], summary: "取消会议",
  });
  const result = extractAction(`给用户的回复\n${fence(first)}\n${fence(second)}`);
  assert.equal(result.reply, "给用户的回复");
  assert.deepEqual(result.action?.arguments.command, ["meeting", "create", "--json", "{}"]);

  const invalidFirst = extractAction(`给用户的回复\n${fence("not-json")}\n${fence(second)}`);
  assert.equal(invalidFirst.reply, "给用户的回复");
  assert.equal(invalidFirst.action, undefined);
});

test("the broker keeps the Skill command intact and classifies only its safety mode", async () => {
  const command = ["meeting", "create", "--json", JSON.stringify({
    subject: "项目复盘", begin_time: "2026-08-21 10:00:00", end_time: "2026-08-21 10:30:00",
    attendees: [{ userid: "woxxx" }],
  })];
  const prepared = await prepareAction(wecom(command, "wecom-unified", "创建项目复盘在线会议"));
  assert.equal(prepared.name, "meeting.create");
  assert.equal(prepared.mode, "write");
  assert.equal(prepared.private, undefined);
  assert.deepEqual(prepared.command, command);
  assert.equal(prepared.summary, "创建项目复盘在线会议");
  assert.match(prepared.resource ?? "", /^meeting\.create:[a-f0-9]{16}$/);
});

test("service routing requires the official unified Skill", async () => {
  const cases: Array<[string[], string]> = [
    [["calendar", "schedules", "list", "--json", "{}"], "wecom-unified"],
    [["contact", "users", "search", "--json", "{}"], "wecom-unified"],
    [["chat", "messages", "list", "--json", "{}"], "wecom-unified"],
    [["doc", "contents", "get", "--json", "{}"], "wecom-unified"],
    [["doc", "search", "--json", "{}"], "wecom-unified"],
    [["smartsheet", "records", "list", "--json", "{}"], "wecom-unified"],
  ];
  for (const [command, skill] of cases) await prepareAction(wecom(command, skill));
  await assert.rejects(prepareAction(wecom(["meeting", "create", "--json", "{}"], "wecomcli-meeting")), /wecom-unified/);
  await assert.rejects(prepareAction(wecom(["auth", "show", "--json", "{}"], "wecom-unified")), /不允许/);
});

test("reads, writes, destructive operations, and payload-level deletion are fail-closed", async () => {
  const cases: Array<[string[], string, "read" | "write" | "destructive"]> = [
    [["meeting", "search", "--json", "{}"], "wecom-unified", "read"],
    [["meeting", "rooms", "buildings", "list", "--json", "{}"], "wecom-unified", "read"],
    [["smartsheet", "records", "query", "--json", '{"docid":"doc","sql":["SELECT COUNT(*)"]}'], "wecom-unified", "read"],
    [["disk", "files", "rename", "--json", "{}"], "wecom-unified", "write"],
    [["meeting", "cancel", "--json", "{}"], "wecom-unified", "destructive"],
    [["doc", "contents", "overwrite", "--json", "{}"], "wecom-unified", "destructive"],
    [["mail", "send", "--json", "{}"], "wecom-unified", "destructive"],
    [["message", "aibot", "send", "--json", "{}"], "wecom-unified", "destructive"],
    [["smartsheet", "records", "update", "--json", '{"type":"delete"}'], "wecom-unified", "destructive"],
  ];
  for (const [command, skill, mode] of cases) assert.equal((await prepareAction(wecom(command, skill))).mode, mode);
  await assert.rejects(prepareAction(wecom(["meeting", "frobnicate", "--json", "{}"], "wecom-unified")), /未识别/);
});

test("the broker accepts CLI introspection but rejects arbitrary options, paths, credentials, and invalid JSON", async () => {
  const inspection = await prepareAction(wecom(["smartsheet", "records", "update", "--schema"], "wecom-unified", "读取当前记录更新契约"));
  assert.equal(inspection.mode, "read");
  assert.equal(inspection.private, true);

  await assert.rejects(prepareAction(wecom(["meeting", "create", "--dry-run", "--json", "{}"], "wecom-unified")), /命令路径无效|只接受/);
  await assert.rejects(prepareAction(wecom(["meeting", "create", "--json", "not-json"], "wecom-unified")), /有效 JSON/);
  await assert.rejects(prepareAction(wecom(["media", "upload", "--json", '{"file_path":"/etc/passwd"}'], "wecom-unified")), /本地文件路径/);
  await assert.rejects(prepareAction(wecom(["meeting", "create", "--json", '{"bot_secret":"nope"}'], "wecom-unified")), /凭据字段/);
  await assert.rejects(prepareAction({
    name: "wecom-cli", skill: "wecom-unified", userIntent: "explicit", arguments: { command: ["meeting", "create", "--json", "{}"] },
  }), /动作摘要不能为空/);
});

test("internal reminders and work remain ThreadFerry-owned and validated", async () => {
  const reminder = await prepareAction({
    name: "reminder.create", skill: "threadferry", userIntent: "explicit",
    arguments: { instruction: "检查待办", run_at: "2026-08-21 09:00:00" },
  });
  assert.equal(reminder.mode, "write");
  assert.deepEqual(reminder.command.slice(0, 4), ["internal", "reminder", "create", "--json"]);

  const work = await prepareAction({
    name: "work.create", skill: "threadferry", userIntent: "explicit",
    arguments: { title: "复盘", description: "整理结论", assignee_agent: "reviewer" },
  });
  assert.equal(work.private, true);
  await assert.rejects(prepareAction({
    name: "work.create", skill: "wecom-unified", userIntent: "explicit",
    arguments: { title: "复盘", description: "整理结论", assignee_agent: "reviewer" },
  }), /threadferry Skill/);
  await assert.rejects(prepareAction({
    name: "reminder.create", skill: "threadferry", userIntent: "explicit",
    arguments: { instruction: "检查待办", run_at: "明天" },
  }), /必须形如/);
});

test("activity identity hashes enterprise URLs instead of persisting them", async () => {
  const prepared = await prepareAction(wecom([
    "doc", "contents", "get", "--json", JSON.stringify({ docid: "https://doc.example/path?token=secret" }),
  ], "wecom-unified"));
  assert.match(prepared.resource ?? "", /^doc\.contents\.get:[a-f0-9]{16}$/);
  assert.doesNotMatch(prepared.resource ?? "", /token|secret|https/);
});
