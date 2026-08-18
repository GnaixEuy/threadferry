import assert from "node:assert/strict";
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
  const admin = await startAdminServer(config, {
    updateConfig: async (change) => { await change(config); },
    listGroups: async () => [{ id: "group", name: "AI Coding" }, { id: "new-group", name: "新群" }],
    searchUsers: async (keywords) => keywords.includes("张三")
      ? [{ id: "zhangsan", name: "张三", matchedKeywords: ["张三"] }]
      : [],
  }, 0);
  t.after(() => admin.close());

  const first = await fetch(admin.url);
  const page = await first.text();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(page, /ThreadFerry 管理台.*AI Coding.*未绑定/s);
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
  assert.deepEqual(config.agents.reviewer, { runtime: "pi", workspace, model: "provider/model" });

  await post("/groups/agent", { groupId: "group", agentId: "reviewer" });
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

  const escaped = await post("/agents/add", { agentId: "escape", runtime: "codex", workspace: "../outside" });
  assert.match(escaped.headers.get("location") ?? "", /error=/);
  assert.equal(config.agents.escape, undefined);
});
