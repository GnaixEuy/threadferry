<p align="center">
  <img src="./docs/assets/threadferry-hero-v2.png" alt="ThreadFerry 将 Codex、Pi、Claude 和 Grok 连接到企业微信" width="100%">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#使用">使用</a> ·
  <a href="#安全">安全</a> · <a href="#开发">开发</a> ·
  <a href="./CHANGELOG.md">更新日志</a>
</p>

ThreadFerry 把企业微信连接到本地只读 AI Agent。每个 Agent 独立拥有机器人、Owner、凭据、群、
Workspace、Runtime 和 Session，严格 1:1，互不串用。

<p align="center">
  <img src="./docs/assets/threadferry-poster.png" alt="ThreadFerry 支持企业微信群聊、私聊以及 Codex、Pi、Claude、Grok" width="560">
</p>

## 安装

需要 macOS 或 Linux、Node.js 22+、企业微信智能机器人，以及以下任一 Runtime：Codex CLI
`0.138.0+`、Pi CLI `0.84.2+`、Claude Code `2.1.233+` 或 Grok Build `1.0.5+`。
安装器会在需要时补装企业微信官方 `wecom-cli 1.1.0+`。

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

初始化向导会授权机器人、确认 Owner、选择 Runtime 和 Workspace、完成诊断并启动 ThreadFerry。
需要再次运行时：

```sh
threadferry onboard
```

## 使用

启动所有已授权 Agent：

```sh
threadferry start
```

本机管理台地址是 [http://127.0.0.1:17638](http://127.0.0.1:17638)，用于管理机器人、Workspace、
群、用户、Session、提醒、协作任务和 Activity。

Owner 可以直接私聊机器人：

```text
帮我排查登录请求为什么开始超时。
```

在已配置群中 `@机器人`：

```text
@机器人 总结刚才的讨论，并检查相关代码。
```

ThreadFerry 会补充最近 6 小时、最多 80 条消息作为不可信背景。普通群消息不会启动 Runtime。

### 机器人和群

一台机器人对应一个 Agent 和一个 Workspace。可从管理台新增，也可以使用终端：

```sh
threadferry agent add --name reviewer --runtime pi --workspace /absolute/path/to/project
threadferry agent login reviewer
```

原生 Claude Code 和 Grok Build 使用本机已有登录与模型，也可以在管理台选择：

```sh
claude auth login
threadferry agent add --name claude-reviewer --runtime claude --workspace /absolute/path/to/project

grok login
threadferry agent add --name grok-reviewer --runtime grok --workspace /absolute/path/to/project
```

私聊要管理的机器人，发送以下命令：

| 命令 | 用途 |
| --- | --- |
| `threadferry groups` | 查看可见群和配置状态 |
| `threadferry bind <群>` | 把群绑定到当前机器人 |
| `threadferry users <群>` | 查看授权用户 |
| `threadferry add <群> <姓名>` | 授权用户 |
| `threadferry remove <群> <姓名>` | 移除用户 |
| `threadferry open <群>` | 允许群内所有成员使用 |
| `threadferry close <群>` | 恢复仅授权名单可用 |

待绑定列表只能发现最近 7 天有消息的群。把机器人拉进新群后，先发一条消息，再刷新并绑定。

### 企业数据与代办

Agent 可以查询白名单内的日程、会议、待办、邮件、文档、微盘和表格，也能创建受控提醒，或在同一
Owner 的 Agent 之间交接任务。每个动作都要通过身份、会话、资源、当前意图和确认规则，才能交给
`wecom-cli` 执行。

个人企业数据只允许在 Owner 私聊中使用。删除、取消、完成整个待办和发送邮件始终需要新的确认码。

## 安全

- 每台机器人只接受自己 Owner 的私聊 Agent 请求。
- 未配置群、未授权用户和没有 `@机器人` 的消息不会启动 Runtime。
- Agent 之间不共享凭据、Session、群历史或 Workspace。
- Codex 禁用网络和文件写入；Pi 只开放经过路径守卫的 `read` 和 `ls`；Claude Code 使用 Safe Mode
  与只读工具；Grok Build 使用 strict sandbox 与只读工具，并关闭 Web、子 Agent 和 Memory。
- Runtime 不能提交、推送、部署、删除文件，也不能执行任意企业微信操作。
- 机器人凭据保存在各 Agent 的官方 `wecom-cli` 加密存储中。ThreadFerry 不会把 Bot Secret
  写入配置、日志、状态、URL 或环境变量。
- 群历史、引用、附件和企业内容始终按不可信输入处理。

## 运维

```sh
threadferry doctor
threadferry status
threadferry agent list
threadferry update
```

只启动指定 Agent：`threadferry start --agents frontend,reviewer`。重置群 Session：
`threadferry session reset --group <群 ID>`。

本地文件：

- 配置：`~/.threadferry/threadferry.yaml`
- 状态：`~/.threadferry/state-v3.json`
- 示例：[threadferry.example.yaml](./threadferry.example.yaml)

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

真实企业微信验收见 [POC.md](./POC.md)，Gitmoji 提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
项目使用 [MIT License](./LICENSE)。
