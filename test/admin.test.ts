import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    groups: { group: { agents: { default: { allowUsers: ["owner"] } }, context: { lookbackHours: 6, maxMessages: 80 } } },
    security: { requireMention: true, readOnly: true },
  };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // 企业微信不支持按 userid 反查通讯录，名字是从别处收集来的，管理台只做同步查表。
  const remembered = new Map([["owner", "苏粤翔"]]);
  const now = new Date().toISOString();
  const resetCalls: string[] = [];
  const authCalls: Array<{ agentId: string; mode: string; botId?: string; secret?: string }> = [];
  const directoryAgents: string[] = [];
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async (agentId) => agentId === "default"
      ? [{ id: "group", name: "AI Coding", hasBotSession: true }, { id: "new-group", name: "新群" }]
      : [],
    botStatus: async (agentId) => agentId === "default"
      ? { authorized: true, botId: "aib-default", botName: "默认助手", ownerName: "苏粤翔", org: "月相工作室" }
      : { authorized: false, hint: `请执行 threadferry agent login ${agentId}` },
    authorizeBot: async (agentId, authorization) => {
      authCalls.push({ agentId, ...authorization });
    },
    searchUsers: async (agentId, keywords) => {
      directoryAgents.push(agentId);
      return keywords.includes("张三")
        ? [{ id: "zhangsan", name: "张三", matchedKeywords: ["张三"] }]
        : [];
    },
    userName: (userId) => remembered.get(userId),
    rememberUser: (userId, name) => { remembered.set(userId, name); },
    snapshot: async () => ({
      turns: [
        { id: digest("msg-1"), group: digest("group"), status: "running", receivedAt: now, updatedAt: now },
        { id: digest("msg-2"), group: digest("group"), status: "failed", receivedAt: now, updatedAt: now, errorId: "TF-12345678", failurePhase: "runtime" },
      ],
      sessions: [{ group: digest("group"), workspace: digest(workspace), sessionId: "session-1", updatedAt: now }],
      inbox: [],
      outbox: [],
      reminders: [{ id: "R-123456789ABC", agent: "default", chatId: "owner", chatType: "single", createdBy: "owner", instruction: "检查待办", nextRunAt: now, status: "scheduled", failures: 0, createdAt: now, updatedAt: now }],
      workItems: [{ id: "W-123456789ABC", title: "核对季度复盘", description: "读取复盘", createdBy: "owner", createdAgent: "default", assignedAgent: "reviewer", reviewerAgent: "default", sourceChatId: "owner", sourceChatType: "single", status: "queued", createdAt: now, updatedAt: now }],
      activities: [{ id: "A-123456789ABC", agent: "default", type: "action.read", outcome: "success", resource: "doc:doc-1", at: now }],
    }),
    resetSession: async (groupId, agentId) => { resetCalls.push(`${groupId}:${agentId}`); return true; },
  }, 0);
  t.after(() => admin.close());

  const overview = await (await fetch(`${admin.url}/`)).text();
  assert.match(overview, /ThreadFerry 管理台/);
  assert.match(overview, /概览/);
  assert.match(overview, /class="app-shell"/);
  assert.match(overview, /class="sidebar"/);
  assert.match(overview, /aria-current="page"/);
  assert.match(overview, /data-theme-toggle/);
  assert.match(overview, /class="sidebar-bottom"/);
  assert.doesNotMatch(overview, /class="top-actions"/);
  assert.match(overview, /待绑定群/);
  assert.match(overview, /新群/);
  assert.match(overview, /排队 \/ 运行中/);
  assert.match(overview, /TF-12345678/);
  assert.match(overview, /主动工作[\s\S]*R-123456789ABC[\s\S]*核对季度复盘/);
  assert.match(overview, /最近 Activity[\s\S]*action\.read[\s\S]*doc:doc-1/);

  const agentsPage = await (await fetch(`${admin.url}/agents`)).text();
  assert.match(agentsPage, /机器人管理/);
  assert.match(agentsPage, /default/);
  assert.match(agentsPage, /AI Coding/);
  assert.match(agentsPage, /Claude Code/);
  assert.match(agentsPage, /Grok Build/);
  // 添加表单只在对话框里，页面上只留一个按钮；默认关着。
  assert.match(agentsPage, /data-dialog="add-agent"/);
  assert.match(agentsPage, /<dialog id="add-agent" class="modal"/);
  assert.match(agentsPage, /name="configDir"/);
  assert.match(agentsPage, /name="authMode" value="qr" checked/);
  assert.match(agentsPage, /name="botId"/);
  assert.match(agentsPage, /name="secret" type="password"/);
  assert.doesNotMatch(agentsPage, /aria-labelledby="add-agent-title" open/);
  assert.match(await (await fetch(`${admin.url}/agents?new=1`)).text(), /aria-labelledby="add-agent-title" open/);

  // 样式和脚本必须同源可取，否则 CSP 只放开 'self' 的页面会变成裸 HTML。
  const stylesheet = await fetch(`${admin.url}/admin.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  assert.match(await stylesheet.text(), /\.picker-panel/);
  const script = await fetch(`${admin.url}/admin.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  const clientScript = await script.text();
  assert.match(clientScript, /showModal/);
  assert.match(clientScript, /threadferry-theme/);

  const first = await fetch(`${admin.url}/groups`);
  const page = await first.text();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(first.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(page, /AI Coding/);
  assert.match(page, /待绑定/);
  assert.match(page, /href="\/groups">↻ 刷新群列表<\/a>/);
  assert.match(page, /class="list-panel"/);
  assert.match(page, /href="\/groups\/detail\?id=group"/);
  assert.match(page, /href="\/groups\/detail\?id=new-group"/);
  assert.doesNotMatch(page, /重置 Session|解绑|开启全员可用/);

  const groupDetail = await (await fetch(`${admin.url}/groups/detail?id=group`)).text();
  assert.match(groupDetail, /返回群聊列表/);
  assert.match(groupDetail, /重置 Session/);
  assert.match(groupDetail, /解绑/);
  assert.match(groupDetail, /1 台机器人已启用/);
  assert.match(groupDetail, /仅授权成员/);
  assert.match(groupDetail, /开启全员可用/);
  // 名单里有名字就把名字放主位、加密 id 退成次要信息。
  assert.match(groupDetail, /<b>苏粤翔<\/b><code class="faint">owner<\/code>/);
  // 添加用户同样收进对话框，输入框挂着通讯录搜索菜单。
  assert.match(groupDetail, /data-dialog="add-user-0"/);
  assert.match(groupDetail, /<dialog id="add-user-0"/);
  assert.match(groupDetail, /data-picker="users"/);
  assert.match(groupDetail, /data-agent-id="default"/);
  // 候选是复选框：一个群可以一次勾多台机器人。new-group 还没人 @ 过，不能声称机器人在群里。
  const pendingDetail = await (await fetch(`${admin.url}/groups/detail?id=new-group`)).text();
  assert.match(pendingDetail, /<input type="checkbox" id="bind-0-0" name="agentId" value="default" checked>/);
  assert.match(pendingDetail, /绑定所选/);
  assert.doesNotMatch(groupDetail, /id="add-user-0"[^>]*open>/);
  // 对话框按「Agent + 群」定位：同一个群里两台机器人各有各的添加入口。
  const userKey = encodeURIComponent("default\ngroup");
  assert.match(await (await fetch(`${admin.url}/groups/detail?id=group&user=${userKey}`)).text(), /id="add-user-0"[^>]*open>/);

  const found = await (await fetch(`${admin.url}/api/users?agent=default&q=${encodeURIComponent("张三")}`)).json();
  assert.deepEqual(found.users.map((user: { id: string }) => user.id), ["zhangsan"]);
  assert.deepEqual((await (await fetch(`${admin.url}/api/users?agent=default&q=`)).json()).users, []);
  assert.equal((await fetch(`${admin.url}/api/users?q=张三`)).status, 400);
  assert.equal((await fetch(`${admin.url}/api/users?agent=missing&q=张三`)).status, 400);
  assert.deepEqual(directoryAgents, ["default"]);
  const hostileStatus = await new Promise<number | undefined>((resolve, reject) => {
    const target = new URL(admin.url);
    const request = httpRequest({ hostname: target.hostname, port: target.port, headers: { host: "evil.example" } }, (response) => resolve(response.statusCode));
    request.on("error", reject);
    request.end();
  });
  assert.equal(hostileStatus, 403);
  const csrf = groupDetail.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(csrf);

  const post = (path: string, values: Record<string, string>, withCsrf = true) => fetch(admin.url + path, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...(withCsrf ? { csrf } : {}), ...values }),
  });

  assert.equal((await post("/agents/add", { agentId: "blocked", runtime: "pi", workspace }, false)).status, 403);
  assert.equal(config.agents.blocked, undefined);

  const badSecret = await post("/agents/add", {
    agentId: "bad-secret", runtime: "pi", workspace, authMode: "manual", botId: "aib-bad", secret: "",
  });
  assert.match(badSecret.headers.get("location") ?? "", /error=/);
  assert.equal(config.agents["bad-secret"], undefined);
  const badConfigDir = await post("/agents/add", {
    agentId: "bad-config", runtime: "pi", workspace, authMode: "later", configDir: "relative/wecom",
  });
  assert.match(badConfigDir.headers.get("location") ?? "", /error=/);
  assert.equal(config.agents["bad-config"], undefined);

  const configDir = join(root, "reviewer-wecom");
  const added = await post("/agents/add", {
    agentId: "reviewer",
    runtime: "pi",
    workspace,
    model: "provider/model",
    configDir,
    authMode: "manual",
    botId: "aib-reviewer",
    secret: "super-secret",
  });
  assert.equal(added.status, 303);
  assert.match(added.headers.get("location") ?? "", /^\/agents\?ok=/);
  assert.doesNotMatch(added.headers.get("location") ?? "", /super-secret|aib-reviewer/);
  // 新增 Agent 的机器人还没授权，Owner 先继承主 Agent 的；该 Agent 授权后启动时会提示更正。
  assert.deepEqual(config.agents.reviewer, { runtime: "pi", workspace, model: "provider/model", configDir, ownerUser: "owner" });
  assert.deepEqual(authCalls, [{ agentId: "reviewer", mode: "manual", botId: "aib-reviewer", secret: "super-secret" }]);

  // 1:1 之后没有「切换 Agent」这个路由：换 Agent 等于换机器人，而那台机器人未必在这个群。
  assert.equal((await post("/groups/agent", { groupId: "group", agentId: "reviewer" })).status, 404);
  assert.deepEqual(Object.keys(config.groups.group!.agents), ["default"]);
  // Agent 卡片必须显示机器人授权状态和该 Agent 自己的 Owner。
  const agentCards = await (await fetch(`${admin.url}/agents`)).text();
  assert.match(agentCards, /已授权[\s\S]*aib-default/);
  assert.match(agentCards, /未授权/);
  // 卡片要能一眼分辨归属：机器人自己的名字、Owner 姓名、Owner 顶层部门。
  assert.match(agentCards, /<span class="badge org">月相工作室<\/span>/);
  assert.match(agentCards, /机器人 <b>默认助手<\/b>/);
  assert.match(agentCards, /Owner <b>苏粤翔<\/b>/);
  assert.match(agentCards, /threadferry agent login reviewer/);
  assert.match(agentCards, /Owner[\s\S]*owner/);
  assert.match(agentCards, /授权机器人/);
  assert.doesNotMatch(agentCards, /super-secret/);

  const qr = await post("/agents/auth", { agentId: "reviewer", authMode: "qr" });
  assert.equal(qr.status, 303);
  assert.match(qr.headers.get("location") ?? "", /^\/agents\?ok=/);
  assert.deepEqual(authCalls.at(-1), { agentId: "reviewer", mode: "qr" });

  // 名单是「群 + Agent」的，所以每个写操作都带 agentId。
  await post("/groups/users/add", { groupId: "group", agentId: "default", user: "张三" });
  assert.deepEqual(directoryAgents, ["default", "default"]);
  assert.deepEqual(config.groups.group?.agents.default?.allowUsers, ["owner", "zhangsan"]);
  // 按姓名添加成功的那一刻就记下映射，列表里立刻能显示名字。
  assert.equal(remembered.get("zhangsan"), "张三");
  assert.match(await (await fetch(`${admin.url}/groups/detail?id=group`)).text(), /<b>张三<\/b><code class="faint">zhangsan<\/code>/);
  await post("/groups/users/remove", { groupId: "group", agentId: "default", userId: "zhangsan" });
  assert.deepEqual(config.groups.group?.agents.default?.allowUsers, ["owner"]);
  const ownerRemoval = await post("/groups/users/remove", { groupId: "group", agentId: "default", userId: "owner" });
  assert.match(ownerRemoval.headers.get("location") ?? "", /error=/);
  assert.deepEqual(config.groups.group?.agents.default?.allowUsers, ["owner"]);

  const accessOn = await post("/groups/access", { groupId: "group", agentId: "default", allowAll: "on" });
  assert.match(accessOn.headers.get("location") ?? "", /^\/groups\/detail\?id=group&ok=/);
  assert.equal(config.groups.group?.agents.default?.allowAll, true);
  assert.match(await (await fetch(`${admin.url}/groups/detail?id=group`)).text(), /全员可用/);
  const accessOff = await post("/groups/access", { groupId: "group", agentId: "default", allowAll: "off" });
  assert.equal(accessOff.status, 303);
  assert.equal(config.groups.group?.agents.default?.allowAll, undefined);
  const badAccess = await post("/groups/access", { groupId: "group", agentId: "default", allowAll: "yes" });
  assert.match(badAccess.headers.get("location") ?? "", /error=/);

  // 绑定必须用目标 Agent 自己的机器人校验：reviewer 的机器人不在 new-group 里。
  const wrongBot = await post("/groups/bind", { groupId: "new-group", agentId: "reviewer" });
  assert.match(wrongBot.headers.get("location") ?? "", /error=/);
  assert.equal(config.groups["new-group"], undefined);

  await post("/groups/bind", { groupId: "new-group", agentId: "default" });
  assert.deepEqual(config.groups["new-group"], {
    agents: { default: { allowUsers: ["owner"] } },
    context: { lookbackHours: 6, maxMessages: 80 },
  });

  const boundRemoval = await post("/agents/remove", { agentId: "default" });
  assert.match(boundRemoval.headers.get("location") ?? "", /error=/);
  assert.ok(config.agents.default);

  // Session 也是按「群 + Agent」的：同群两台机器人不能互相清掉对方的。
  const reset = await post("/groups/session/reset", { groupId: "group", agentId: "default" });
  assert.equal(reset.status, 303);
  assert.match(reset.headers.get("location") ?? "", /^\/groups\/detail\?id=group&ok=/);
  assert.deepEqual(resetCalls, ["group:default"]);

  const unbound = await post("/groups/unbind", { groupId: "new-group", agentId: "default" });
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
  const escapedLocation = escaped.headers.get("location") ?? "";
  assert.match(escapedLocation, /error=/);
  assert.equal(config.agents.escape, undefined);
  // 报错要带着填过的值回到还开着的对话框，不能让用户重填一遍。
  assert.match(escapedLocation, /^\/agents\?new=1&/);
  assert.match(escapedLocation, /name=escape/);
  assert.match(escapedLocation, /workspace=/);
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

  // 输入框上的选择菜单读同一份目录列表，只是走 JSON。
  const listing = await (await fetch(`${admin.url}/api/dirs?path=${encodeURIComponent(workspace)}`)).json();
  assert.equal(listing.current, workspace);
  assert.equal(listing.parent, dirname(workspace));
  assert.equal(listing.filter, "");
  assert.deepEqual(listing.entries.map((entry: { name: string }) => entry.name), ["project-a", "project-b"]);
  assert.deepEqual(listing.entries[0].path, join(workspace, "project-a"));

  // 边打字边筛：路径还不是真实目录时，把最后一段当筛选词，列出上级目录里匹配的子目录。
  const partial = await (await fetch(`${admin.url}/api/dirs?path=${encodeURIComponent(join(workspace, "project-"))}`)).json();
  assert.equal(partial.current, workspace);
  assert.equal(partial.filter, "project-");
  assert.deepEqual(partial.entries.map((entry: { name: string }) => entry.name), ["project-a", "project-b"]);
  const narrowed = await (await fetch(`${admin.url}/api/dirs?path=${encodeURIComponent(join(workspace, "project-b"))}`)).json();
  assert.equal(narrowed.current, join(workspace, "project-b"));
  assert.match((await (await fetch(`${admin.url}/api/dirs?path=some/relative`)).json()).note ?? "", /绝对路径/);

  const prefilled = await (await fetch(`${admin.url}/agents?${new URLSearchParams({ workspace, name: "reviewer", runtime: "pi", new: "1" })}`)).text();
  assert.ok(prefilled.includes(`value="${workspace}"`));
  assert.ok(prefilled.includes('value="reviewer"'));
  assert.match(prefilled, /<option value="pi" selected>/);
  assert.match(prefilled, /整页浏览目录/);
  assert.match(prefilled, /aria-labelledby="add-agent-title" open>/);
  assert.match(prefilled, /data-picker="dirs"/);
});

test("group discovery reports failures and explains an empty list instead of claiming success", async (t) => {
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "owner",
    agents: {
      alpha: { runtime: "codex", workspace: "/tmp", ownerUser: "owner" },
      beta: { runtime: "codex", workspace: "/tmp", ownerUser: "owner" },
    },
    groups: {},
    security: { requireMention: true, readOnly: true },
  };
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    // alpha 查得到但机器人还没被 @ 过（未确认），beta 整个查询失败。
    listGroups: async (agentId) => {
      if (agentId === "beta") throw new Error("企业未授权机器人访问会话数据（errcode 853006）");
      return [{ id: "new-group", name: "月相工作室" }, { id: "seen-group", name: "已互动群", hasBotSession: true }];
    },
    searchUsers: async () => [],
  }, 0);
  t.after(() => admin.close());

  const groups = await (await fetch(`${admin.url}/groups`)).text();
  // 失败必须说出来，并且承认列表不完整。
  assert.match(groups, /群查询失败/);
  assert.match(groups, /errcode 853006/);
  assert.match(groups, /并不完整/);
  // 列表只做导航，绑定控件进入群详情后才出现。
  assert.match(groups, /月相工作室/);
  assert.doesNotMatch(groups, /name="agentId" value="alpha"/);
  const seenDetail = await (await fetch(`${admin.url}/groups/detail?id=seen-group`)).text();
  assert.match(seenDetail, /name="agentId" value="alpha"/);
  assert.match(seenDetail, /value="alpha"[^>]*>[\s\S]{0,80}机器人已在群/);
  assert.match(seenDetail, /绑完即可 @ 使用/);

  const empty = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async () => [],
    searchUsers: async () => [],
  }, 0);
  t.after(() => empty.close());
  const emptyPage = await (await fetch(`${empty.url}/groups`)).text();
  // 一个群都没发现时，不能说成「都已绑定」，要讲清楚企业微信的发现规则。
  assert.doesNotMatch(emptyPage, /都绑定完了/);
  assert.match(emptyPage, /还没发现任何群/);
  assert.match(emptyPage, /最近 7 天/);
  assert.match(emptyPage, /@ 一次机器人/);
});
