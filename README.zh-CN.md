<p align="center">
  <img src="./docs/assets/threadferry-hero-v2.png" alt="ThreadFerry 将 Codex、Pi、Claude 和 Grok 连接到企业微信" width="100%">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#首次运行">首次运行</a> ·
  <a href="#对话使用">对话使用</a> · <a href="#安全边界">安全边界</a> ·
  <a href="#运维">运维</a> · <a href="./CHANGELOG.md">更新日志</a>
</p>

ThreadFerry 把企业微信连接到相互隔离的本地 AI Agent。一个 Agent 对应一个企业微信智能机器人，
独立拥有 Owner、凭据、群、Workspace、Runtime 和 Session。Owner 可以直接私聊；授权成员可以在
已配置群中 `@机器人` 发起任务。

<p align="center">
  <img src="./docs/assets/threadferry-poster.png" alt="ThreadFerry 支持企业微信群聊、私聊以及 Codex、Pi、Claude、Grok" width="560">
</p>

## 主要能力

- 在固定本地 Workspace 中运行 Codex、Pi、Claude Code 或 Grok Build。
- 分析私聊和受控群聊上下文，不向 Runtime 开放文件写入或任意 shell。
- 读取图片、UTF-8 文本附件、引用资源和近期会话资源。
- 由企业微信官方 `wecomcli-*` Skill 驱动日程、会议、待办、邮件、文档、微盘、表格和智能表格，
  通过受控 `wecom-cli` Broker 执行。
- 创建提醒，并在同一 Owner 的 Agent 之间交接工作。
- 重启后恢复 Session、排队任务和未投递回复。

## 安装

运行要求：

- macOS、Linux 或 Windows
- Node.js 22+
- 一个企业微信智能机器人
- 任一 Runtime：Codex CLI `0.138.0+`、Pi CLI `0.84.2+`、Claude Code `2.1.233+` 或 Grok Build `1.0.5+`
- 企业微信官方 `wecom-cli 1.1.0+`（安装器会在需要时补装）

macOS 或 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.ps1 | iex
```

完成 CLI 安装和首次设置后，日常使用推荐从
[GitHub Releases](https://github.com/GnaixEuy/threadferry/releases/latest) 下载桌面版：Apple Silicon Mac
使用 arm64 DMG，Intel Mac 使用 x64 DMG，Windows 使用 NSIS 安装程序，Linux 使用 AppImage 或 DEB。
桌面版提供常驻托盘菜单；Runtime 和企业微信官方 `wecom-cli` 仍沿用上面的本机安装与登录状态。

## 首次运行

在交互式终端运行初始化向导：

```sh
threadferry onboard
```

向导会安装企业微信官方 Skills、授权机器人、确认 Owner、选择 Runtime 和 Workspace、执行诊断并启动
ThreadFerry。

以后直接打开 ThreadFerry 桌面应用即可。它会自动启动已配置 Agent；点击菜单栏或任务栏通知区域中的
ThreadFerry 图标，可以打开管理台、重启或停止服务、查看日志和退出。关闭管理台窗口只会收回托盘。
管理台左下角提供日志追踪和偏好设置。日志追踪用于按错误编号、Agent、动作或资源定位脱敏运行记录，
入口可以在偏好设置中隐藏；偏好设置还可以切换主题，并控制登录时启动、服务自动启动、启动后打开
管理台和 macOS Dock 入口。首次打开管理台会显示状态驱动的开始使用清单和三步界面引导；完成
机器人授权和第一次 Owner 私聊后清单自动收起，群聊接入保持可选，引导可以跳过或从偏好设置重新查看。
概览还会用近 7 天处理趋势和任务状态分布展示脱敏运行状态。桌面偏好只保存在当前设备。

需要终端运维时仍可直接启动：

```sh
threadferry start
```

本机管理台地址是 [http://127.0.0.1:17638](http://127.0.0.1:17638)，用于管理 Agent、机器人授权、
Workspace、群、用户、Session、提醒、协作任务和近期 Activity。

## 对话使用

Owner 可以直接私聊机器人：

```text
帮我排查登录请求为什么开始超时。
```

授权成员可以在已配置群中 `@机器人`：

```text
@机器人 总结刚才的讨论，并检查相关代码。
```

群任务会补充最近 6 小时、最多 80 条消息作为不可信上下文；私聊任务会补充最近 7 天、最多 80 条
消息。普通群消息不会启动 Runtime。

### 企业数据与操作

直接用自然语言描述任务，例如：

```text
查看我今天下午的会议。
创建明天上午 10 点、时长 30 分钟的评审会议。
把这些数据追加到项目智能表格。
```

Agent 按对应的企业微信官方 Skill 选择能力、补齐必要信息、生成当前 CLI 命令并解释结果。
ThreadFerry 校验 Skill 与命令路径的对应关系、命令结构、身份、会话边界、操作影响和确认规则，再使用该
Agent 自己的 `wecom-cli` 凭据执行，并把结果交还同一 Agent。

查询只允许在 Owner 私聊中执行。每次写操作都会先进行本地 `--dry-run` 校验。删除、取消、覆盖、
完成待办、发送消息和发送邮件需要 Owner 输入新的确认码。

### 图片和文件

可以在 Owner 私聊中发送图片或文件，也可以在已配置群中附带或引用资源并 `@机器人`。UTF-8 文本可供
所有 Runtime 读取；图片使用各 Runtime 的原生视觉输入。不支持的二进制格式会明确说明已收到但无法解析。

单个资源最大 20 MB，单轮合计最大 50 MB。每个 Agent 在
`~/.threadferry/history/<Agent>/` 保留最多 7 天、1,000 条消息和 200 MB 的授权会话历史，Agent 与
会话之间保持分区。交给 Runtime 的副本会在单轮结束后删除；持久化历史不保存资源 URL、AES Key、
`media_id` 或临时路径。

Grok Build 的编码后图片请求上限为 700 KB；更大的图片请使用 Codex、Pi 或 Claude。

### Agent 与群

可从管理台或终端新增并授权 Agent：

```sh
threadferry agent add --name reviewer --runtime pi --workspace /absolute/path/to/project
threadferry agent login reviewer
threadferry agent list
```

Claude Code 和 Grok Build 使用本机 CLI 的登录与模型配置：

```sh
claude auth login
threadferry agent add --name claude-reviewer --runtime claude --workspace /absolute/path/to/project

grok login
threadferry agent add --name grok-reviewer --runtime grok --workspace /absolute/path/to/project
```

Owner 通过私聊目标机器人管理它自己的群：

| 命令 | 用途 |
| --- | --- |
| `threadferry groups` | 查看可见群和可用状态 |
| `threadferry users <群>` | 查看授权用户 |
| `threadferry invite <群>` | 生成一次性邀请码 |
| `threadferry add <群> <姓名>` | 授权用户 |
| `threadferry remove <群> <姓名>` | 移除用户 |
| `threadferry open <群>` | 允许群内所有成员使用 |
| `threadferry close <群>` | 恢复授权名单 |
| `threadferry whoami` | 查看当前用户的 ThreadFerry userid |

把机器人拉入内部群后，在群里 @它一次。ThreadFerry 收到第一次回调就会自动启用这台机器人，默认仅
Owner 可用，不再需要单独绑定。之后在管理台群详情中控制机器人是否可用，以及哪些群成员可以使用。
群列表可发现最近 7 天有消息的群。

## 安全边界

- 每台机器人只接受自己 Owner 的私聊 Agent 请求。
- 已停用群、未授权用户和没有 `@机器人` 的消息不会启动 Runtime。
- Agent 之间不共享凭据、Owner、Session、会话历史或 Workspace。
- Codex 禁用网络和文件写入；Pi 只开放经过路径守卫的 `read` 和 `ls`；Claude Code 使用 Safe Mode
  和只读工具；Grok Build 使用 strict sandbox，并关闭 Web、子 Agent 和 Memory。
- Runtime 不能提交、推送、部署、删除文件、执行任意 shell，也不能直接调用 `wecom-cli`。
- 机器人凭据保存在各 Agent 的 `wecom-cli` 加密存储中。ThreadFerry 不会把 Bot Secret 写入配置、
  状态、日志、URL、测试夹具或环境变量。
- 群历史、引用消息、附件和企业内容始终按不可信输入处理。

## 运维

```sh
threadferry doctor
threadferry skills install
threadferry status
threadferry agent list
threadferry update
```

只启动指定 Agent：`threadferry start --agents frontend,reviewer`。重置群 Session：
`threadferry session reset --group <群 ID>`。

本地文件：

- 配置：`~/.threadferry/threadferry.yaml`
- 状态：`~/.threadferry/state-v3.json`
- Agent 凭据：`~/.threadferry/wecom/<Agent>/`
- 配置示例：[threadferry.example.yaml](./threadferry.example.yaml)

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run desktop:pack
```

验收步骤见 [POC.md](./POC.md)，Gitmoji 提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。项目使用
[MIT License](./LICENSE)。
