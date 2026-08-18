# Warden V0.8 POC

## 1. Mock end-to-end check

Build Warden and prepare a real directory to act as the Workspace:

```sh
npm install
npm run build
mkdir -p ./tmp/mock-workspace
pwd -P
```

Copy `warden.example.yaml` to `warden.yaml`. Replace the example Workspace with the absolute canonical path ending in `/tmp/mock-workspace`; leave one group ID and one allowed user ID configured.

```sh
node dist/src/cli.js start --config ./warden.yaml --mock
```

Expected output includes:

```text
[mock] Agent default: codex workspace=/absolute/path/to/Warden/tmp/mock-workspace
[mock] WeCom reply: Warden 已收到，正在分析。
[mock] WeCom reply: Mock 分析完成：接口异常可能与 Redis 有关，且线上已重复出现三次。
[mock] status: handled
```

The mock history contains:

```text
张三：这个接口有问题
李四：可能是 Redis
王五：线上出现三次
用户：@Warden 帮忙分析
```

Remove the local `tmp/` directory after the POC if it is no longer needed. `warden.yaml` is ignored by Git.

## 2. Dependency diagnosis

```sh
node dist/src/cli.js doctor --config ./warden.yaml
```

Every missing item is reported with a next action. The command must fail until real bot environment variables and wecom-cli authentication are available; this is expected in a mock-only environment.

## 3. Real Enterprise WeCom acceptance

1. Install official `wecom-cli 1.1.0+` and run `wecom-cli auth init` for the target enterprise.
2. Verify `wecom-cli identity whoami --json '{}'` succeeds.
3. Run `codex login`, then verify `codex --version` is at least `0.138.0`.
4. Create an Enterprise WeCom intelligent robot and add it to the configured internal group.
5. Run `warden onboard`; enter the Bot ID and hidden Bot Secret when prompted.
6. Complete the Agent and Workspace prompts, then send the printed one-time pairing command by selecting the robot with WeCom's `@` picker. Do not derive `allow_users` from `wecom-cli identity`; the WebSocket SDK can use a different userid scope.
7. Run `warden doctor` and require all checks to pass.
8. Run `warden start`.
9. Send three ordinary messages, then have an allowed user send `@Warden 帮忙分析`.
10. Verify the reply appears in the same group and reflects the three preceding messages.
11. Verify the stream first shows the processing acknowledgement and then the final result.
12. Send two mentions quickly in the same group and verify the second is queued and Runtime executions do not overlap.
13. Restart Warden, repeat a handled callback msgid in a controlled test, and verify it is not executed again.
14. Send a second new mention and verify `warden status` reports one persisted Codex Session.
15. Verify an unconfigured group, a non-allowlisted user, and a message without a robot mention do not start Codex.
16. Send a new group message while Codex is analyzing and verify Warden asks for a new mention instead of returning the stale result.
17. While Codex is analyzing, terminate the Warden process abnormally, restart it, and verify the terminal logs `正在恢复 1 个上次中断的任务` and the result is actively sent to the original group.
18. Simulate a reply interruption, restart Warden, and verify it logs `已补发 1 条上次未投递的回复`; `warden status` must then show `outbox=0`.
19. Start a second `warden start` process and verify it is rejected with `Warden 已在运行` without creating another WebSocket consumer.
20. Send another ordinary message in the same second while Codex runs and verify the completed analysis is marked stale.
21. Stop Warden with `Ctrl+C` during Codex execution and verify the child process is cancelled and the task reaches a terminal failure state.
22. Have the robot creator privately message the bot with `warden groups`; verify configured groups show their Agent and recent unconfigured groups are marked `[未配置 Agent]`.
23. Have the Owner privately send `warden add <群名> <姓名>` and verify Warden resolves the member through `contact users search`, persists the real userid, and grants access without restarting.
24. Search a duplicated name and verify Warden does not change the allowlist; it must return candidate departments and `id:<userid>` values for explicit selection.
25. Have the Owner privately send `warden invite <群名>`, then have an unauthorized member privately send `warden join <邀请码>` (or send it with `@机器人` in that group); verify access works immediately without restarting Warden.
26. Have a non-Owner privately send `warden groups`, `warden users`, `warden invite`, `warden add`, and `warden remove`; verify none reveals or changes the allowlist.
27. Send an Owner management command in a group and verify Warden asks the Owner to use private chat without changing the allowlist.
28. Have the Owner privately remove the newly authorized member by name and verify its next analysis request returns `unauthorized_user` without starting Codex.
29. Add a Pi Agent with `warden agent add`, then have the Owner privately send `warden agents` and `warden use <群名> <Agent名>`.
30. Send a new group mention and verify it runs in the Pi Agent Workspace with only `read` and `ls`; switch back to Codex and verify each Agent resumes only its own Session.
31. Open `http://127.0.0.1:17638`; add an Agent, switch a group Agent, and add/remove an authorized user. Verify each change updates `~/.warden/warden.yaml` and affects the next group mention without restarting.
32. Verify the management server is bound only to `127.0.0.1`, rejects a POST without its CSRF token, and does not expose bot credentials or environment variables.

V0.1 的真实 WebSocket 接收、群历史拉取、Codex 执行和原群回复已在目标企业手工打通。V0.2～V0.8 新增的队列、Session 续接、崩溃恢复、创建者私聊管理、Pi Runtime、本机管理台和安装向导仍需按以上步骤完成真实验收，不能用 Mock 结果代替。
