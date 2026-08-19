# 更新日志

ThreadFerry 的每个 GitHub Release 都使用这里对应版本的内容，不再依赖自动生成的空白发布说明。

## Unreleased

## 0.14.1

本次版本修复运维排查困难：群消息处理失败时，本机控制台只有错误编号和阶段，真正可操作的原因被丢弃，必须再跑一次 `threadferry doctor` 才能看到。

### 主要变化

- `[wecom] 处理失败` 日志新增 `reason=`，直接给出失败原因。例如企业未批准机器人数据访问权限时，控制台会直接显示「企业未授权群消息历史能力（errcode 853006）；请让企业管理员批准机器人数据访问权限」，不必再跑一次 doctor。
- 覆盖 history、runtime、reply、ack 和权限更新各个失败阶段，私聊失败同样输出。
- 原因只写本机控制台：群聊和私聊回复仍然只给错误编号，本地状态库也不落原因，回复内容与持久化行为完全不变。
- 原因会压成单行并截断到 200 字符，避免多行报错污染日志。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次变更不需要迁移配置，也不改变任何对外行为，升级后重启 `threadferry start` 即可。

### 安全边界

不变。新增的 `reason` 只来自 Runtime 与 wecom-cli 的固定诊断文案（不含群消息内容），且仅输出到运行 ThreadFerry 的本机控制台，不进入企业微信回复，也不写入本地状态库。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.14.0...v0.14.1 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.14.0...v0.14.1)

## 0.14.0

本次版本新增群聊「全员可用」开关：打开后该群所有成员都可以 @ 机器人使用，不必再逐个授权；私聊命令和管理台都能切换。

### 主要变化

- 新增群配置项 `allow_all`。打开后该群成员只要 @ 机器人就能使用，`allow_users` 名单原样保留，关闭后立即恢复生效。
- 新增私聊命令 `threadferry open <群名>` 和 `threadferry close <群名>`，`threadferry help` 已同步；仅 Owner 可执行，与其他权限命令共用同一条串行更新链。
- 管理台「群聊管理」页的每个已配置群卡片新增开关，并显示「全员可用」或「仅授权成员」当前状态；开启期间提示授权列表在关闭后生效。
- `threadferry users <群名>` 在开启期间说明当前是全员可用，`threadferry groups` 在对应群标出「全员可用」。
- 管理台「AI 空间」更名为「Agent 工作区」，添加表单的 Workspace 可以先浏览本机目录选择，再回填其余字段。
- 安全边界不变：仍然只处理 @ 机器人的消息，只读取已绑定群历史，Agent 仍以只读方式运行；开关只放宽“谁可以使用”。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次变更不需要迁移配置：`allow_all` 是可选项，缺省即为原有的仅授权成员可用。升级后运行 `threadferry start` 即可使用新开关。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.13.0...v0.14.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.13.0...v0.14.0)

## 0.13.0

本次版本重构本机管理台，把原先的单页拆分为概览、AI 空间、群聊管理三个页面，并补齐删除 AI 空间、解绑群、重置 Session 等常用管理能力。

### 主要变化

- 管理台拆分为「概览」「AI 空间」「群聊管理」三个页面，顶部导航直达；所有操作完成后跳回对应页面和对应卡片，不再回到单页顶部。
- 新增概览页：汇总 AI 空间数、群绑定情况、排队与运行中任务、Runtime Session 数、待补发回复数，并集中展示待绑定群（可就地绑定）和最近一次失败的错误编号与阶段。
- 原 Agents 统一更名为「AI 空间」；卡片新增绑定群列表（可跳转群聊管理），未被任何群使用的 AI 空间可直接删除，服务端兜底保证至少保留一个。
- 修复管理台添加表单在浏览器端拦截中文名的问题；名称校验统一由服务端执行，与 CLI 行为一致。
- 群聊管理页区分待绑定群和已配置群；新增「解绑群」和「重置 Session」操作，重置在群任务运行或排队时按现有保护逻辑拒绝。
- 安全模型保持不变：仅监听 127.0.0.1、Host 校验、CSRF 令牌、严格 CSP 且不引入任何 JavaScript。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次变更不需要迁移配置。升级后运行 `threadferry start`，浏览器打开 [http://127.0.0.1:17638](http://127.0.0.1:17638) 即可使用新版管理台。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.12.3...v0.13.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.12.3...v0.13.0)

## 0.12.3

本次版本完善企业微信权限诊断和首次接入引导，并为主分支补齐自动构建验证。

### 主要变化

- 修复 `threadferry doctor` 误报缺少 wecom-cli 加密凭据，并真实检查群消息历史权限。
- 企业未授权机器人数据访问时直接提示 `errcode 853006` 和管理员审批动作，不再只返回错误编号。
- 配对成功后引导用户返回终端继续启动；`threadferry help` 按权限、加群、查群、查 Agent、绑定的顺序说明群聊接入。
- 新增 `Build` 工作流，每次推送到 `main` 自动安装锁定依赖、运行类型检查、完整测试和 TypeScript 构建。
- 构建工作流仅授予仓库内容读取权限，不创建标签或发布版本。
- 保留 `Release` 工作流；推送 `v*.*.*` 标签时独立执行打包、校验和 GitHub Release 发布。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次变更不需要迁移配置。升级后运行 `threadferry doctor`；若显示 `errcode 853006`，需要企业管理员批准机器人的数据访问权限。重新运行 `threadferry onboard` 可体验新的配对引导。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.12.0...v0.12.3 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.12.0...v0.12.3)

## 0.12.0

本次版本把 Owner 认证从群聊中解耦，支持经本机确认后直接私聊 Agent，并让群聊成为按需启用的可选能力。

### 主要变化

- Owner 配对改为私聊机器人发送一次性配对码，并由本机终端人工确认回调 userid；配对不再依赖群聊或企业微信通讯录权限。
- Owner 可以直接私聊默认 Agent，私聊 Runtime Session 与各群 Session 相互隔离；群聊配置改为可选。
- 新增 Owner 私聊命令 `threadferry bind <群名或ID> <Agent名>`，可直接绑定机器人最近可见的群会话。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

新安装会引导用户私聊机器人发送一次性配对码，并在本机终端确认 Owner。现有配置可以继续使用；需要更换或修复 Owner userid 时重新运行：

```sh
threadferry setup --workspace <绝对路径>
threadferry doctor
```

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.11.0...v0.12.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.11.0...v0.12.0)

## 0.11.0

本次版本完善了 ThreadFerry 的安装、企业微信初始化和持续升级流程，让用户可以更快完成首次配置，并自动获得后续缺陷修复。

### 主要变化

- Agent 名支持中文、空格和常见符号，不再要求使用纯英文标识符。
- `threadferry onboard` 的 Workspace 默认值改为运行命令时的当前目录，不再沿用已有配置中的路径。
- `threadferry start` 会在启动前和运行期间主动检查 GitHub Latest Release，自动安装新版本并在当前任务结束后重启。
- 新增 `threadferry update` 手动更新命令；自动检查或安装失败时保留当前服务并输出告警。
- 安装器会检测 `wecom-cli 1.1.0+`，缺失或版本过低时自动执行官方 npm 安装命令，并在未授权时进入官方初始化流程。
- `wecom-cli` 已配置时，ThreadFerry 会询问是否直接读取并复用其加密凭据；读取失败或用户拒绝时仍可手动输入。
- 新增群绑定改为由本机生成的一次性配对码授权，不再因同一用户的企业微信回调 ID 形式不同而误判为非 Owner；现有 Owner 保持不变。
- Release Notes 改为从本文件提取经过整理的中文说明；缺少对应版本内容时发布流程会直接失败。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

安装器会下载本 Release 的预编译包，并检查或安装 `wecom-cli 1.1.0+`。升级完成后运行：

```sh
threadferry --version
threadferry doctor
```

现有 `~/.threadferry/threadferry.yaml`、Owner、群绑定和本地状态会保留，不需要重新配置。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.10.1...v0.11.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.10.1...v0.11.0)

## 0.10.1

本次补丁修复了预编译发布流程在不同时区下的验证问题，使 GitHub Actions 可以稳定产出经过测试的安装包。

### 主要变化

- 修复 Context Builder 测试依赖本地时区的问题，确保 UTC 和其他时区的 Release Runner 都能得到一致结果。
- 同步 npm 包、CLI 和 Git Tag 的版本号为 `0.10.1`。
- 延续 `0.10.0` 的预编译分发方式：用户安装时不再拉取源码、安装开发依赖或运行 TypeScript 编译。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

安装器会下载本 Release 的 `threadferry.tgz`。升级后可以运行：

```sh
threadferry --version
threadferry doctor
```

现有 `~/.threadferry/threadferry.yaml` 和本地状态不会被安装器删除。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.10.0...v0.10.1 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.10.0...v0.10.1)

## 0.10.0

这是 ThreadFerry 首个使用 GitHub Releases 提供预编译安装包的版本，重点改善安装速度和发布可验证性。

### 主要变化

- Release 工作流在 Git Tag 推送后自动执行 typecheck、完整测试、构建和安装验证。
- `install.sh` 改为下载已经编译的 `threadferry.tgz`，不再从 Git 仓库安装和本机编译。
- 发布包附带 `SHA256SUMS`，并在临时目录中真实安装后校验 CLI 版本。
- 修复 curl 管道执行和重复安装时替换开发软链接的问题。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

安装完成后运行 `threadferry onboard` 进入交互式配置；无人值守安装可以使用 `--no-onboard`。

### 发布资产

- `threadferry.tgz`：预编译 npm 安装包。
- `SHA256SUMS`：发布包 SHA-256 校验文件。

[查看 v0.10.0 的源码](https://github.com/GnaixEuy/threadferry/tree/v0.10.0)
