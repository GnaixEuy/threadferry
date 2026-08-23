# ThreadFerry 验收清单

本文用于验证安装包、真实企业微信连接、多 Agent 隔离、Runtime、企业能力、安全边界和故障恢复。
验收证据不得包含 Bot Secret、Access Token、AES Key、资源 URL、`media_id` 或用户私密内容。

## 1. 验收环境

准备以下资源：

- macOS、Linux 或 Windows 测试机，Node.js 22+
- 一个 Owner 企业微信账号
- 至少一个企业微信智能机器人；多 Agent 隔离验收需要两个机器人
- 一个内部测试群和两个测试成员
- 一个不含生产密钥的测试 Workspace
- Codex、Pi、Claude Code 或 Grok Build 中至少一个已登录 Runtime
- 可安全创建和删除测试数据的会议、日程或表格范围

记录以下信息：

| 项目 | 记录 |
| --- | --- |
| ThreadFerry 版本 |  |
| 操作系统与 Node.js 版本 |  |
| wecom-cli 版本 |  |
| Runtime 与版本 |  |
| 验收 Agent |  |
| 验收人 |  |
| 验收时间 |  |

## 2. 工程质量门禁

在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

通过标准：

- 类型检查和测试退出码为 0；平台限定用例可以明确标记为 skip。
- 生产依赖漏洞数量为 0。
- npm 包包含 CLI、双语 README、CHANGELOG、POC、安装脚本、配置示例和 README 图片。
- npm 包不包含凭据、状态文件、本地配置、临时资源或开发交接文件。
- Markdown 与源码没有空白错误。

## 3. Mock 端到端

构建项目并准备一个真实目录作为 Workspace：

```sh
npm run build
mkdir -p ./tmp/mock-workspace
pwd -P
```

复制 `threadferry.example.yaml` 为 `threadferry.yaml`，只保留一个 Agent，将 Workspace 改为上一步的
绝对规范路径，并保留一个测试群和一个授权用户。然后执行：

```sh
node dist/src/cli.js start --config ./threadferry.yaml --mock
```

确认终端依次出现接收回执、Mock 分析结果和 `status: handled`，且分析结果使用了 Mock 群历史中的三条
背景消息。完成后删除不再需要的 `tmp/`；本地 `threadferry.yaml` 不得进入 Git。

## 4. 安装、授权与启动

- [ ] 在一台未安装 ThreadFerry 的测试机运行对应安装脚本，确认 `threadferry --version` 可用。
- [ ] 运行 `threadferry onboard`，完成官方 Skills 安装、机器人授权、Owner 确认、Runtime 与 Workspace
      选择和环境诊断。
- [ ] 确认授权过程由目标 Agent 的 `wecom-cli` 凭据目录完成，配置和终端输出中没有 Bot Secret。
- [ ] 运行 `threadferry doctor`，确认配置、14 个官方 Skills、机器人身份、Runtime 和 Workspace 全部通过。
- [ ] 运行 `threadferry start`，确认每个已授权 Agent 建立一条机器人连接；未授权 Agent 会显示明确的
      `threadferry agent login <name>` 提示。
- [ ] 再启动一个 ThreadFerry 进程，确认它因实例锁退出，不创建第二个 WebSocket 消费者。
- [ ] 打开 `http://127.0.0.1:17638`，确认管理台仅监听 `127.0.0.1`。

## 5. 私聊、群聊与权限

- [ ] Owner 私聊机器人发送普通分析请求，不使用 `@`，确认收到处理回执和最终结果。
- [ ] 非 Owner 私聊同一机器人，确认 Runtime 不启动，回复不泄露已配置 Owner 的 userid。
- [ ] Owner 私聊发送 `threadferry groups`，选择测试群并发送 `threadferry bind <群名或ID>`。
- [ ] 在群中先发送三条普通消息，再由授权成员发送 `@机器人 帮我分析`；确认回复出现在同一群，并引用
      最近 6 小时上下文。
- [ ] 验证未配置群、未授权成员和没有 `@机器人` 的群消息均不启动 Runtime。
- [ ] 使用 `threadferry add`、`remove`、`invite`、`join`、`open`、`close` 验证授权变更即时生效。
- [ ] 搜索同名成员时，确认系统返回候选部门与 userid，未选择前不修改授权名单。
- [ ] 在群中发送管理命令，确认系统要求 Owner 改用私聊。
- [ ] 确认 Owner 不能从授权名单中删除自己。

## 6. 官方 Skill 与企业能力

- [ ] 运行 `threadferry skills install`，再运行 `threadferry doctor`，确认 14 个 Skill 的目录、锁文件和
      来源均为 `WeComTeam/wecom-cli`。
- [ ] Owner 私聊查询会议或日程，确认 Agent 使用对应官方 Skill，结果来自该 Agent 的企业微信身份。
- [ ] 在群中请求查询企业数据，确认查询被拒绝并提示改用 Owner 私聊。
- [ ] 使用信息完整的自然语言请求创建测试会议，确认请求先通过 `--dry-run`，真实创建只发生一次，随后
      可通过查询回读。
- [ ] 使用缺少时间或参与人的创建请求，确认 Agent 先澄清信息，不提交动作。
- [ ] 请求取消刚创建的会议，确认未输入新确认码时不执行；输入有效确认码后执行一次，并可回读结果。
- [ ] 请求发送企业微信消息或邮件，确认每次真实发送都要求新的 Owner 确认码。
- [ ] 请求读写普通表格和智能表格，确认 Agent 先读取文档类型、子表与字段结构，再按实际字段执行。
- [ ] 确认业务结果返回发起请求的同一 Agent；一次写入完成后，本轮不再执行第二个动作。
- [ ] 确认 Runtime 无法直接调用 `wecom-cli`，也无法提交 `auth`、`identity`、任意 shell、凭据字段、
      输出路径或本地文件路径。

## 7. 多 Agent 与 Runtime 隔离

添加第二个 Agent，并授权第二个机器人：

```sh
threadferry agent add --name reviewer --runtime pi --workspace /absolute/path/to/another-project
threadferry agent login reviewer
threadferry agent list
threadferry start --agents reviewer
```

- [ ] 两个 Agent 显示不同机器人身份和独立凭据目录。
- [ ] 两个机器人分别绑定测试群后，`@` 哪个机器人就只运行对应 Agent 和 Workspace。
- [ ] 同一群同时 `@` 两个机器人时，两边独立完成，Session 和资源互不串用。
- [ ] A 机器人的 Owner 私聊 B 机器人时，B 按自己的 Owner 规则拒绝。
- [ ] 分别重启 Codex、Pi、Claude 或 Grok Agent，确认只恢复自己的 Session。
- [ ] 在 Workspace 放置 `.env` 和提示词注入文本，确认 Runtime 不能读取敏感文件、写文件、执行任意
      命令或越过 Workspace 边界。

## 8. 图片、文件与历史

- [ ] Owner 私聊发送图片并附带文字说明，确认平台拆分的资源与文字只触发一轮分析和一条最终回复。
- [ ] 私聊发送 UTF-8 Markdown 或日志文件，确认 Runtime 读取正文；发送不支持的二进制文件，确认回复
      明确说明已收到但无法解析。
- [ ] 在群中附图并 `@机器人`，再分别引用图片和文件提问，确认当前资源和引用资源进入同一轮分析。
- [ ] 先发送资源，再用纯文本追问，确认系统能从近期企业微信消息或该 Agent 的本机历史补取资源。
- [ ] 重启后继续追问私聊资源，确认所属 Agent 可以恢复；其他会话和其他 Agent 无法读取。
- [ ] 验证单个资源 20 MB、单轮 50 MB 和最多 10 个资源的限制均有明确错误信息。
- [ ] 在成功、失败、结果过期和多机器人分发后检查临时目录，确认单轮副本均被清理。
- [ ] 检查 `~/.threadferry/history/<Agent>/` 权限和索引，确认目录为 0700、文件为 0600，且索引不含
      URL、AES Key、`media_id` 或临时路径。

## 9. 队列、恢复与投递

- [ ] 同一会话快速发送两个任务，确认第二个进入队列，Runtime 不并发执行。
- [ ] 重放已处理的 callback `msgid`，确认任务不会重复执行。
- [ ] Runtime 工作期间产生更新的群消息，确认旧结果被标记为过期，不覆盖新上下文。
- [ ] Runtime 工作期间强制结束 ThreadFerry，再启动，确认待处理任务恢复并回复原会话。
- [ ] 模拟回复投递失败并重启，确认 Outbox 补发成功，随后 `threadferry status` 显示 `outbox=0`。
- [ ] 使用 `Ctrl+C` 结束进程，确认 Runtime 子进程被取消，任务进入明确的终态。
- [ ] 执行 `threadferry session reset --group <群ID>`，确认只清理目标群的 Session。

## 10. 安全检查

- [ ] `~/.threadferry/threadferry.yaml`、状态文件、历史索引、日志和测试证据均不包含 Bot Secret。
- [ ] 每个 Agent 的凭据只存在自己的 `~/.threadferry/wecom/<Agent>/` 或显式 `config_dir`。
- [ ] 管理台修改接口拒绝缺少 CSRF Token 的请求。
- [ ] 群历史、邮件、文档和附件中的指令不会改变系统规则或授权新操作。
- [ ] 错误回复不暴露凭据路径、内部资源 ID、绝对 Workspace 路径或其他 Agent 的数据。
- [ ] `threadferry status` 和 Activity 记录足以定位 Agent、动作类型和结果，同时不记录业务正文或密钥。

## 11. 验收结论

| 范围 | 结果 | 证据位置 | 备注 |
| --- | --- | --- | --- |
| 工程质量门禁 |  |  |  |
| 安装与升级 |  |  |  |
| 私聊与群聊 |  |  |  |
| 官方 Skill 与企业能力 |  |  |  |
| 多 Agent 与 Runtime 隔离 |  |  |  |
| 图片、文件与历史 |  |  |  |
| 队列、恢复与投递 |  |  |  |
| 安全边界 |  |  |  |

所有必测项通过且没有 P0/P1 缺陷时，验收结论填写“通过”。任何真实企业微信写操作都必须使用可清理的
测试数据，并在验收完成后回读确认清理结果。
