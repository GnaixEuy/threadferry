import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startAdminServer } from "../src/admin.js";
import type { ThreadFerryConfig } from "../src/types.js";

test("localhost admin manages agents, groups, and users with CSRF protection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-admin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await realpath(root);
  const config: ThreadFerryConfig = {
    version: 5,
    ownerUser: "owner",
    agents: { default: { runtime: "codex", workspace } },
    groups: { group: { agent: "default", allowUsers: ["owner"], context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const now = new Date().toISOString();
  const resetCalls: string[] = [];
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async () => [{ id: "group", name: "AI Coding" }, { id: "new-group", name: "新群" }],
    searchUsers: async (keywords) => keywords.includes("张三")
      ? [{ id: "zhangsan", name: "张三", matchedKeywords: ["张三"] }]
      : [],
    snapshot: async () => ({
      turns: [
        { id: digest("msg-1"), group: digest("group"), status: "running", receivedAt: now, updatedAt: now },
        { id: digest("msg-2"), group: digest("group"), status: "failed", receivedAt: now, updatedAt: now, errorId: "TF-12345678", failurePhase: "runtime" },
      ],
      sessions: [{ group: digest("group"), workspace: digest(workspace), sessionId: "session-1", updatedAt: now }],
      inbox: [],
      outbox: [],
    }),
    resetSession: async (groupId) => { resetCalls.push(groupId); return true; },
  }, 0);
  t.after(() => admin.close());

  const overview = await (await fetch(`${admin.url}/`)).text();
  assert.match(overview, /ThreadFerry 管理台/);
  assert.match(overview, /概览/);
  assert.match(overview, /待绑定群/);
  assert.match(overview, /新群/);
  assert.match(overview, /排队 \/ 运行中/);
  assert.match(overview, /TF-12345678/);

  const agentsPage = await (await fetch(`${admin.url}/agents`)).text();
  assert.match(agentsPage, /AI 空间/);
  assert.match(agentsPage, /default/);
  assert.match(agentsPage, /AI Coding/);

  const first = await fetch(`${admin.url}/groups`);
  const page = await first.text();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(page, /AI Coding/);
  assert.match(page, /待绑定/);
  assert.match(page, /重置 Session/);
  assert.match(page, /解绑群/);
  const hostileStatus = await new Promise<number | undefined>((resolve, reject) => {
    const target = new URL(admin.url);
    const request = httpRequest({ hostname: target.hostname, port: target.port, headers: { host: "evil.example" } }, (response) => resolve(response.statusCode));
    request.on("error", reject);
    request.end();
  });
  assert.equal(hostileStatus, 403);
  const csrf = page.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(csrf);

  const post = (path: string, values: Record<string, string>, withCsrf = true) => fetch(admin.url + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...(withCsrf ? { csrf } : {}), ...values }),
  });

  assert.equal((await post("/agents/add", { agentId: "blocked", runtime: "pi", workspace }, false)).status, 403);
  assert.equal(config.agents.blocked, undefined);

  const added = await post("/agents/add", { agentId: "reviewer", runtime: "pi", workspace, model: "provider/model" });
  assert.equal(added.status, 303);
  assert.match(added.headers.get("location") ?? "", /^\/agents\?ok=/);
  assert.deepEqual(config.agents.reviewer, { runtime: "pi", workspace, model: "provider/model" });

  const switched = await post("/groups/agent", { groupId: "group", agentId: "reviewer" });
  assert.match(switched.headers.get("location") ?? "", /^\/groups\?ok=.*#group$/);
  assert.equal(config.groups.group?.agent, "reviewer");
  await post("/groups/users/add", { groupId: "group", user: "张三" });
  assert.deepEqual(config.groups.group?.allowUsers, ["owner", "zhangsan"]);
  await post("/groups/users/remove", { groupId: "group", userId: "zhangsan" });
  assert.deepEqual(config.groups.group?.allowUsers, ["owner"]);
  const ownerRemoval = await post("/groups/users/remove", { groupId: "group", userId: "owner" });
  assert.match(ownerRemoval.headers.get("location") ?? "", /error=/);
  assert.deepEqual(config.groups.group?.allowUsers, ["owner"]);

  await post("/groups/bind", { groupId: "new-group", agentId: "default" });
  assert.deepEqual(config.groups["new-group"], {
    agent: "default",
    allowUsers: ["owner"],
    context: { lookbackHours: 6, maxMessages: 80 },
  });

  const boundRemoval = await post("/agents/remove", { agentId: "default" });
  assert.match(boundRemoval.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.default);

  const reset = await post("/groups/session/reset", { groupId: "group" });
  assert.equal(reset.status, 303);
  assert.match(reset.headers.get("location") ?? "", /^\/groups\?ok=.*#group$/);
  assert.deepEqual(resetCalls, ["group"]);

  const unbound = await post("/groups/unbind", { groupId: "new-group" });
  assert.equal(unbound.status, 303);
  assert.match(unbound.headers.get("location") ?? "", /^\/groups\?ok=/);
  assert.equal(config.groups["new-group"], undefined);

  const removed = await post("/agents/remove", { agentId: "default" });
  assert.equal(removed.status, 303);
  assert.match(removed.headers.get("location") ?? "", /^\/agents\?ok=/);
  assert.equal(config.agents.default, undefined);

  const boundReviewer = await post("/agents/remove", { agentId: "reviewer" });
  assert.match(boundReviewer.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.reviewer);

  await post("/groups/unbind", { groupId: "group" });
  const lastRemoval = await post("/agents/remove", { agentId: "reviewer" });
  assert.match(lastRemoval.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.reviewer);

  const escaped = await post("/agents/add", { agentId: "escape", runtime: "codex", workspace: "../outside" });
  assert.match(escaped.headers.get("location") ?? "", /error=/);
  assert.equal(config.agents.escape, undefined);
});
