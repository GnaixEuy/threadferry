import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireHostLock, sessionScope, ThreadFerryState } from "../src/state.js";
import type { IncomingMention } from "../src/types.js";

const message: IncomingMention = {
  msgId: "msg-1",
  groupId: "group-1",
  senderId: "user-1",
  senderName: "用户",
  time: new Date("2026-08-18T10:05:00+08:00"),
  text: "@ThreadFerry 分析",
  mentioned: true,
};

test("state durably recovers inbox and outbox without retaining completed content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "state-v3.json");
  const first = new ThreadFerryState(path);

  assert.equal(await first.enqueue(message), true);
  await first.markRunning(message.msgId);
  await first.setSession(message.groupId, "/workspace", "session-1");

  const restarted = new ThreadFerryState(path);
  const recovered = await restarted.recoverPending();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.message.text, message.text);
  assert.equal(recovered[0]?.message.time.toISOString(), message.time.toISOString());
  assert.equal(await restarted.enqueue(message), false);
  assert.equal(await restarted.session(message.groupId, "/workspace"), "session-1");

  const deliveryId = await restarted.finishWithDelivery(message.msgId, message.groupId, "handled", "分析结果");
  let snapshot = await new ThreadFerryState(path).snapshot();
  assert.equal(snapshot.inbox.length, 0);
  assert.equal(snapshot.outbox[0]?.content, "分析结果");
  assert.equal(snapshot.turns[0]?.status, "handled");

  await restarted.deliveryFailed(deliveryId, "TF-1234ABCD");
  assert.equal((await restarted.pendingDeliveries())[0]?.attempts, 1);
  await restarted.completeDelivery(deliveryId);
  snapshot = await new ThreadFerryState(path).snapshot();
  assert.equal(snapshot.outbox.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /@ThreadFerry|分析结果/);
  assert.equal(await restarted.clearSession(message.groupId), true);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const invalid = join(root, "invalid.json");
  await writeFile(invalid, '{"version":3,"turns":[],"sessions":[],"inbox":[],"outbox":[],"unexpected":true}');
  await assert.rejects(new ThreadFerryState(invalid).snapshot(), /版本或结构无效/);
});

test("host lock rejects a second process owner and replaces a stale lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "host.lock");

  const first = await acquireHostLock(path);
  await assert.rejects(acquireHostLock(path), /已在运行/);
  await first.release();

  await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: "stale" }), { mode: 0o600 });
  const recovered = await acquireHostLock(path);
  await recovered.release();
});

test("resetting a session only clears the requested agent's session for that group", async () => {
  const state = new ThreadFerryState();
  const front = sessionScope("frontend", { runtime: "codex", workspace: "/ws-a" });
  const back = sessionScope("backend", { runtime: "pi", workspace: "/ws-b" });
  // 两个机器人同在一个群：各自有独立 Session。
  await state.setSession("shared-group", front, "front-session");
  await state.setSession("shared-group", back, "back-session");

  assert.equal(await state.clearSession("shared-group", front), true);
  assert.equal(await state.session("shared-group", front), undefined);
  // 对方的 Session 必须还在。
  assert.equal(await state.session("shared-group", back), "back-session");

  assert.equal(await state.clearSession("shared-group", front), false);
  assert.equal(await state.clearSession("shared-group", back), true);
  assert.equal(await state.session("shared-group", back), undefined);

  // 不传 scope 时清掉该群所有 Agent 的 Session。
  await state.setSession("shared-group", front, "front-again");
  await state.setSession("shared-group", back, "back-again");
  assert.equal(await state.clearSession("shared-group"), true);
  assert.equal(await state.session("shared-group", front), undefined);
  assert.equal(await state.session("shared-group", back), undefined);
});
