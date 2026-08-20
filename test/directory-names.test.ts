import assert from "node:assert/strict";
import test from "node:test";
import { DirectoryNameCache } from "../src/directory-names.js";
import type { CommandRunner } from "../src/types.js";

const sessions = JSON.stringify({
  sessions: [
    { chat_id: "wowOWNER", chat_name: "苏粤翔", chat_type: "single" },
    { chat_id: "wrwGROUP", chat_name: "月相工作室", chat_type: "group" },
  ],
});

const history = JSON.stringify({
  messages: [
    { userid: "wowOWNER", user_name: "苏粤翔", msg_type: "text", send_time: "2026-08-19 10:00:00", text: { content: "在" } },
    { userid: "wowTEAM", user_name: "平平无奇小天才", msg_type: "text", send_time: "2026-08-19 10:01:00", text: { content: "我也在" } },
  ],
});

test("names are collected from direct-chat sessions and group history, never from a userid lookup", async () => {
  const commands: string[][] = [];
  const runner: CommandRunner = async (_command, args, options) => {
    commands.push(args);
    // 可选查询必须限时，慢接口不能拖住管理台。
    assert.ok((options?.timeoutMs ?? Infinity) <= 8_000);
    if (args[0] === "message") return { stdout: sessions, stderr: "" };
    if (args[0] === "chat" && args[1] === "messages") return { stdout: history, stderr: "" };
    return { stdout: JSON.stringify({ chats: [], has_more: false }), stderr: "" };
  };

  const cache = new DirectoryNameCache();
  // 查名字永不发起 I/O：没收集过就直接返回 undefined，调用方照常显示 id。
  assert.equal(cache.name("wowOWNER"), undefined);
  assert.equal(commands.length, 0);

  await cache.refresh("叶翔", runner, ["wrwGROUP"]);
  assert.equal(cache.name("wowOWNER"), "苏粤翔");
  assert.equal(cache.name("wowTEAM"), "平平无奇小天才");
  // 群名不能被当成人名混进来。
  assert.equal(cache.name("wrwGROUP"), undefined);
  // 绝不应该拿 userid 当关键词去搜通讯录——企业微信那样查一律返回空。
  assert.ok(!commands.some((args) => args[0] === "contact"));
});

test("a bot without session or history permission just keeps showing ids", async () => {
  const runner: CommandRunner = async () => { throw new Error("AuthError: 无权限"); };
  const cache = new DirectoryNameCache();
  await cache.refresh("叶翔", runner, ["wrwGROUP"]);
  assert.equal(cache.name("wowOWNER"), undefined);
});

test("remembering a resolved user makes the name available immediately", () => {
  const cache = new DirectoryNameCache();
  cache.remember("zhangsan", "张三");
  assert.equal(cache.name("zhangsan"), "张三");
  // 空值不入缓存，免得把名字显示成空白。
  cache.remember("empty", "");
  assert.equal(cache.name("empty"), undefined);
});

test("collection is throttled per agent so a page render never hammers the CLI", async () => {
  let refreshes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "message") refreshes += 1;
    return { stdout: sessions, stderr: "" };
  };
  const clock = { value: 0 };
  const cache = new DirectoryNameCache(() => clock.value);

  cache.schedule("叶翔", runner, []);
  cache.schedule("叶翔", runner, []);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);

  cache.schedule("叶翔", runner, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);

  // TTL 过后自己再收集一次：新成员说过话后名字会补上。
  clock.value += 10 * 60 * 1000;
  cache.schedule("叶翔", runner, []);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2);
});
