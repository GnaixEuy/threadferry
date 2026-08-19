import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
    version: 6,
    ownerUser: "owner",
    agents: { default: { runtime: "codex", workspace, ownerUser: "owner" } },
    groups: { group: { agent: "default", allowUsers: ["owner"], context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const now = new Date().toISOString();
  const resetCalls: string[] = [];
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async (agentId) => agentId === "default"
      ? [{ id: "group", name: "AI Coding" }, { id: "new-group", name: "新群" }]
      : [],
    botStatus: async (agentId) => agentId === "default"
      ? { authorized: true, botId: "aib-default" }
      : { authorized: false, hint: `请执行 threadferry agent login ${agentId}` },
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
  assert.match(agentsPage, /Agent 工作区/);
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
  assert.match(page, /仅授权成员/);
  assert.match(page, /开启全员可用/);
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
  // 新增 Agent 的机器人还没授权，Owner 先继承主 Agent 的；该 Agent 授权后启动时会提示更正。
  assert.deepEqual(config.agents.reviewer, { runtime: "pi", workspace, model: "provider/model", ownerUser: "owner" });

  // 1:1 之后没有「切换 Agent」这个路由：换 Agent 等于换机器人，而那台机器人未必在这个群。
  assert.equal((await post("/groups/agent", { groupId: "group", agentId: "reviewer" })).status, 404);
  assert.equal(config.groups.group?.agent, "default");
  // Agent 卡片必须显示机器人授权状态和该 Agent 自己的 Owner。
  const agentCards = await (await fetch(`${admin.url}/agents`)).text();
  assert.match(agentCards, /已授权[\s\S]*aib-default/);
  assert.match(agentCards, /未授权/);
  assert.match(agentCards, /threadferry agent login reviewer/);
  assert.match(agentCards, /Owner[\s\S]*owner/);

  await post("/groups/users/add", { groupId: "group", user: "张三" });
  assert.deepEqual(config.groups.group?.allowUsers, ["owner", "zhangsan"]);
  await post("/groups/users/remove", { groupId: "group", userId: "zhangsan" });
  assert.deepEqual(config.groups.group?.allowUsers, ["owner"]);
  const ownerRemoval = await post("/groups/users/remove", { groupId: "group", userId: "owner" });
  assert.match(ownerRemoval.headers.get("location") ?? "", /error=/);
  assert.deepEqual(config.groups.group?.allowUsers, ["owner"]);

  const accessOn = await post("/groups/access", { groupId: "group", allowAll: "on" });
  assert.match(accessOn.headers.get("location") ?? "", /^\/groups\?ok=.*#group$/);
  assert.equal(config.groups.group?.allowAll, true);
  assert.match(await (await fetch(`${admin.url}/groups`)).text(), /全员可用/);
  const accessOff = await post("/groups/access", { groupId: "group", allowAll: "off" });
  assert.equal(accessOff.status, 303);
  assert.equal(config.groups.group?.allowAll, undefined);
  const badAccess = await post("/groups/access", { groupId: "group", allowAll: "yes" });
  assert.match(badAccess.headers.get("location") ?? "", /error=/);

  // 绑定必须用目标 Agent 自己的机器人校验：reviewer 的机器人不在 new-group 里。
  const wrongBot = await post("/groups/bind", { groupId: "new-group", agentId: "reviewer" });
  assert.match(wrongBot.headers.get("location") ?? "", /error=/);
  assert.equal(config.groups["new-group"], undefined);

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

  // default 仍绑着 group，删不掉。
  const stillBound = await post("/agents/remove", { agentId: "default" });
  assert.match(stillBound.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.default);

  // reviewer 没有任何群，可以删。
  const removedReviewer = await post("/agents/remove", { agentId: "reviewer" });
  assert.equal(removedReviewer.status, 303);
  assert.match(removedReviewer.headers.get("location") ?? "", /^\/agents\?ok=/);
  assert.equal(config.agents.reviewer, undefined);

  // 只剩 default：即使解绑所有群也必须保留至少一个 Agent。
  await post("/groups/unbind", { groupId: "group" });
  const lastRemoval = await post("/agents/remove", { agentId: "default" });
  assert.match(lastRemoval.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.default);

  const escaped = await post("/agents/add", { agentId: "escape", runtime: "codex", workspace: "../outside" });
  assert.match(escaped.headers.get("location") ?? "", /error=/);
  assert.equal(config.agents.escape, undefined);
});

test("workspace browser lists local directories and prefills the add form", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-browse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project-a"));
  await mkdir(join(root, "project-b"));
  await mkdir(join(root, ".hidden"));
  const workspace = await realpath(root);
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "owner",
    agents: { default: { runtime: "codex", workspace, ownerUser: "owner" } },
    groups: {},
    security: { requireMention: true, readOnly: true },
  };
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async () => [],
    botStatus: async () => ({ authorized: true, botId: "aib-x" }),
    searchUsers: async () => [],
  }, 0);
  t.after(() => admin.close());

  const params = new URLSearchParams({ path: workspace, name: " reviewer ", runtime: "pi" });
  const browse = await (await fetch(`${admin.url}/agents/browse?${params}`)).text();
  assert.match(browse, /选择 Workspace 目录/);
  assert.match(browse, /project-a\//);
  assert.match(browse, /project-b\//);
  assert.doesNotMatch(browse, /\.hidden/);
  const choose = browse.match(/href="(\/agents\?[^"]*workspace=[^"]*)"/)?.[1];
  assert.ok(choose);
  assert.ok(choose.includes(`workspace=${encodeURIComponent(workspace)}`));
  assert.ok(choose.includes("runtime=pi"));
  assert.ok(choose.includes("name=reviewer"));
  const parentLink = browse.match(/href="(\/agents\/browse\?[^"]*)"[^>]*>↑ 上级目录/)?.[1];
  assert.ok(parentLink);

  const relative = await (await fetch(`${admin.url}/agents/browse?path=some/relative`)).text();
  assert.match(relative, /绝对路径/);

  const prefilled = await (await fetch(`${admin.url}/agents?${new URLSearchParams({ workspace, name: "reviewer", runtime: "pi" })}`)).text();
  assert.ok(prefilled.includes(`value="${workspace}"`));
  assert.ok(prefilled.includes('value="reviewer"'));
  assert.match(prefilled, /<option value="pi" selected>/);
  assert.match(prefilled, /浏览本机目录选择/);
});
