# 更新日志

ThreadFerry 的每个 GitHub Release 都使用这里对应版本的内容，不再依赖自动生成的空白发布说明。

## Unreleased

## 0.26.14

修复企业微信动作错误误报成功、历史附件异常时遗留临时文件，以及群回执失败后的错误提示。

### 主要变化

- Broker 统一识别 `errcode` 和 `error.code/error.message`，写操作 dry-run、真实调用和主动回复都不再把结构化错误当成成功。
- 远端历史附件下载后，即使本机历史索引损坏或读取失败，也会删除本轮的隔离临时目录。
- Owner 确认的动作与原群或私聊 Session 串行执行，避免与新消息同时恢复同一 Runtime Session。
- 动作已执行但原群回执失败时，Owner 会收到真实失败状态、错误编号和完整结果，不再误报“已回执原群”。

### 安装与升级

升级并重新启动 ThreadFerry 即可；现有配置、机器人凭据、Workspace、Runtime Session、
群聊授权和本机历史均无需迁移。

[查看 v0.26.13...v0.26.14 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.13...v0.26.14)

## 0.26.13

管理台增加手动检查更新，并修复 Pi 偶发连接失败时的恢复与错误提示。

### 主要变化

- 偏好设置页增加“检查更新”按钮，使用现有 GitHub Latest Release 检查链路判断是否有新版本。
- 点击后按钮显示检查中并防止重复提交；完成后在原页面提示当前已是最新版，或展示发现的新版本号和下载升级指引。
- 更新检查继续使用本机管理台的 CSRF 保护；按钮只执行检查，不会自动下载、安装或重启服务。
- 正确识别 Pi `message_end` 事件里的 `stopReason: "error"` 与 `errorMessage`，不再把 Node.js 版本尾注当成失败原因。
- 已有 Pi Session 遇到连接或网络类错误时使用同一 Session 自动重试一次；权限、配额等非连接错误不会重试。

### 安装与升级

升级并重新启动 ThreadFerry 后，打开管理台“偏好设置”即可手动检查更新。现有配置、机器人凭据、
Workspace、Runtime Session 和群聊授权不受影响。

[查看 v0.26.11...v0.26.13 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.11...v0.26.13)

## 0.26.11

管理台概览增加运行图表，让近期处理量和当前任务状态更容易判断。

### 主要变化

- 概览页增加近 7 天处理趋势，按任务接收日期展示完成、失败和过期记录；没有已结束任务时显示明确空状态。
- 增加当前任务状态分布，区分已完成、进行中、失败和已过期，并保留原有机器人、群和 Session 数字卡片。
- 图表使用管理台现有脱敏状态快照和原生 SVG，不增加第三方依赖，也不读取消息正文。

### 安装与升级

升级并重新启动 ThreadFerry 后打开本机管理台即可看到图表。现有配置、机器人凭据、Workspace、
Runtime Session 和群聊授权不受影响。

[查看 v0.26.10...v0.26.11 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.10...v0.26.11)

## 0.26.10

管理台增加状态驱动的开始使用引导，让首次完成配置的用户知道当前状态和下一步。

### 主要变化

- 概览页根据真实机器人授权和 Owner 私聊 Session 展示两个核心步骤，并把群聊接入明确标为可选；
  核心步骤完成后清单自动收起。
- 首次进入管理台显示三步聚光引导，说明 Agent 与机器人 1:1、机器人管理入口和可选群聊入口；
  支持跳过、Esc 关闭，并可从偏好设置重新查看。
- 引导继续使用管理台现有原生 HTML、CSS、JavaScript 和本机 `localStorage`，未增加第三方依赖或改变
  企业微信授权、Owner 确认与凭据隔离边界。

### 安装与升级

升级并重新启动 ThreadFerry 后打开本机管理台即可看到引导。现有配置、机器人凭据、Workspace、
Runtime Session 和群聊授权不受影响。

[查看 v0.26.9...v0.26.10 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.9...v0.26.10)

## 0.26.9

缩小桌面安装包，避免 macOS 用户为另一套 CPU 架构和重复压缩格式付出下载体积。

### 主要变化

- macOS 不再把 x86_64 与 arm64 Electron 合成一个 Universal 包，改为分别提供 Apple Silicon arm64
  DMG 和 Intel x64 DMG；实测单个 DMG 从约 207 MiB 降到 103–105 MiB。
- 移除与 DMG 内容重复的 macOS ZIP，Release 只保留两种架构的标准安装镜像。
- 桌面包只保留英文和简体中文 Electron 语言资源，并排除运行时不需要的 TypeScript 声明与 Source Map；
  不改变 ThreadFerry 功能、Runtime、企业微信能力或安全边界。

### 安装与升级

Apple Silicon Mac 下载文件名含 `arm64` 的 DMG，Intel Mac 下载含 `x64` 的 DMG。Windows 和 Linux
继续使用对应的 EXE、AppImage 或 DEB。现有配置、机器人凭据、Runtime Session 和本机历史不受影响。

[查看 v0.26.8...v0.26.9 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.8...v0.26.9)

## 0.26.8

修复 Tag 构建时桌面打包器越过统一发布作业自行上传，正式产出可直接安装的跨平台桌面资产。

### 主要变化

- 桌面构建显式使用 `--publish never`，macOS、Windows 和 Linux 作业只负责生成并上传 workflow artifact；
  最后的 Release 作业继续统一创建 GitHub Release、上传全部资产并生成 `SHA256SUMS`。
- Release 提供 macOS Universal DMG/ZIP、Windows NSIS EXE、Linux AppImage/DEB 和 CLI
  `threadferry.tgz`。桌面包已包含 ThreadFerry 与 Electron 运行环境，不需要从源码构建。
- 包含 `0.26.7` 的桌面托盘、偏好与日志追踪、群首次 `@` 自动启用和管理台响应优化。桌面资产未做商业
  证书签名，系统可能显示来源确认。

### 安装与升级

新用户先运行安装脚本和 `threadferry onboard` 完成官方 `wecom-cli`、Runtime、机器人与 Workspace
设置，再从 GitHub Release 下载当前系统的桌面安装包。已有用户可以直接安装 `0.26.8`；现有配置、
机器人凭据、Runtime Session 和本机历史不受影响。

[查看 v0.26.7...v0.26.8 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.26.7...v0.26.8)

## 0.26.7

首次提供可直接安装的跨平台桌面应用，并把群接入、管理台和桌面启动体验整理为一条完整链路。

### 主要变化

- GitHub Release 现在同时提供 macOS Universal DMG/ZIP、Windows NSIS EXE、Linux AppImage/DEB、
  CLI `threadferry.tgz` 和统一的 `SHA256SUMS`。桌面包内已包含 ThreadFerry 与 Electron 运行环境，安装后
  可直接从菜单栏或任务栏通知区域启动，不需要在源码目录执行构建命令。
- 新增常驻托盘桌面应用，可打开管理台、启动、停止或重启 Host、查看本机日志并安全退出。外部终端已经
  启动 Host 时只接管显示，不越权停止其他进程；从图形界面启动时会恢复登录 Shell 的 `PATH`。
- 管理台新增日志追踪和偏好设置，可切换主题、隐藏日志入口，并按平台控制登录启动、自动启动服务、
  启动后打开管理台和 macOS Dock 图标；桌面偏好只保存在当前设备。
- 群接入改为机器人第一次收到群内 `@` 后自动启用，默认仅 Owner 可用，不再要求私聊执行二次绑定；
  群详情可停用单台机器人并保留授权名单和 Session。
- 概览页并行读取群会话与运行状态；托盘重复打开当前管理页面时复用已有窗口，不再整页重载和重复查询。
- 桌面窗口继续启用上下文隔离与沙箱，只允许访问本机管理台；机器人凭据、Runtime、Workspace 和 Session
  仍按 Agent 隔离，桌面包不会嵌入 Bot Secret 或本机配置。

### 安装与升级

新用户先运行安装脚本和 `threadferry onboard` 完成官方 `wecom-cli`、Runtime、机器人与 Workspace 设置，
再从 GitHub Release 下载当前系统的桌面安装包。已有用户可以直接安装 `0.26.7` 桌面版；现有配置、
机器人凭据、Runtime Session 和本机历史不受影响。当前桌面资产未做商业证书签名，系统可能显示来源确认。

[查看 v0.25.2...v0.26.7 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.25.2...v0.26.7)

## 0.25.2

修复企业微信动作意图由宿主关键词正则猜测、多机器人管理端通讯录固定使用首个机器人，以及一次
“附件 + 说明文字”被拆成多条私聊回调后重复启动 Runtime 的问题。

### 主要变化

- 同一用户短时间连续发送的私聊消息中只要包含附件，就在企业微信入口合并为一个分析轮；纯文本消息
  仍逐条处理，不改变原有对话语义。
- 聚合发生在附件下载完成前，避免文字回调先到、附件下载较慢时再次拆成两轮；合并后继续执行单轮
  附件数量、总量限制及临时文件清理。
- 删除 ThreadFerry 内 42 个会议、日程、待办、邮件、文档、微盘和表格业务动作规格及结果格式化器；
  Agent 现在按官方 Skill 直接生成资源化 `wecom-cli` 命令，通用 Broker 只校验 Skill、命令形状、
  读写影响、身份和确认策略，不再与官方 CLI 维护两套业务契约。
- 企业微信动作不再用宿主自然语言正则猜意图。缺少明确意图的写入会安全降级为 Owner 确认，Skill
  与 service 不匹配会拒绝；删除、取消、覆盖、完成、发消息和发邮件始终确认。查询与写入结果都会
  返回同一 Agent 按原 Skill 整理，写入完成后禁止同轮执行第二个动作。
- Broker 允许 Agent 只读查询当前 CLI 的 `--help` / `--doc` / `--schema`，并拒绝 `auth`、`identity`、
  任意 shell/选项、凭据字段和 Agent 提供的本地文件路径；实际 CLI 仍使用所属 Agent 的隔离凭据，
  写入先执行 `--dry-run`。
- `threadferry onboard` 每次从 WeComTeam/wecom-cli 安装或更新 14 个官方 Skills，新增
  `threadferry skills install` 补装命令；`doctor` 同时核验目录完整性和安装锁中的官方来源。Codex/Grok
  使用标准目录，Pi 逐项加载 14 个官方目录，Claude 在 Safe Mode 下仅按可信只读路径开放这 14 项，
  不把其他全局 Skills 暴露给两个 Runtime。
- 管理台搜索和添加授权用户时显式携带 Agent，通讯录查询使用该 Agent 自己的机器人凭据，不再固定
  取启动列表中的第一台机器人。
- 删除宿主在创建会议后自动植入转写提醒的业务特例；需要会后跟进时，由 Agent 按 Skill 和用户意图
  显式创建 ThreadFerry 提醒，不再由会议命令触发隐藏副作用。
- 所有 `threadferry-action` 围栏都会在回复前移除，存在多个提议时只处理第一项，避免内部 JSON 外露或
  一轮触发多项动作；长 UTF-8 回复改用 Node.js 标准解码器在线性时间内安全截断。
- TypeScript 构建新增未使用代码、遗漏返回、switch 贯穿和未检查索引门禁，防止无效代码与边界错误
  再次进入主链路。
- 中英文 README 统一提供当前产品、安装、对话、官方 Skill 企业能力、安全和运维说明；`POC.md`
  提供可执行验收清单，`WECOMCLI_GUIDE.md` 固化当前 Skill、CLI、Broker 与凭据边界；发布包包含
  README 引用的 `CONTRIBUTING.md`。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置、机器人凭据、Runtime Session 和本机历史均无需迁移。

[查看 v0.25.1...v0.25.2 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.25.1...v0.25.2)

## 0.25.1

修复 Windows 用户在 PowerShell 中执行 Unix 安装命令时被转交给 WSL、并因缺少 `/bin/bash` 而
无法安装的问题，提供不依赖 WSL 的原生 Windows 安装入口。

### 主要变化

- 新增 `install.ps1`：检查 Node.js 22+、补装或升级官方 `wecom-cli 1.1.0+`，从 GitHub Latest
  Release 安装预编译的 ThreadFerry，并继续进入现有初始化向导。
- Windows 安装器优先调用 npm 生成的 `.cmd` 入口，避免 PowerShell 执行策略拦截 `npm.ps1`；同时
  检查 npm 全局目录，并在缺失时加入当前用户 PATH。
- ThreadFerry 启动 `wecom-cli`、npm 和各 Runtime 时统一兼容 Windows `.cmd` shim；自动升级按
  Windows 的 npm 全局目录回读新版本，Grok 的提示文件也不再依赖 Unix `/dev/stdin`。
- Windows Runtime 子进程保留必要的用户目录和系统环境变量；群聊错误会遮盖 Windows 绝对路径，
  不向非 Owner 暴露本机目录。
- 中英文 README 按 macOS/Linux 与 Windows 分开给出安装命令，明确 PowerShell 路径不需要 WSL。
- Build 工作流增加 Windows 原生 `-DryRun` 验证，防止 PowerShell 安装入口发生语法或流程回归。

### 安装与升级

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.ps1 | iex
```

macOS 或 Linux 继续使用：

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置、机器人凭据、Runtime Session 和本机历史均无需迁移。

[查看 v0.25.0...v0.25.1 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.25.0...v0.25.1)

## 0.25.0

让私聊与群聊使用同一条历史链路，并为企业微信未返回的私聊资源增加 Agent 隔离的 7 天本机历史，
解决后续追问或重启后仍被误报“没有收到图片/文件”的问题。

### 主要变化

- Owner 私聊不再只把当前消息交给 Runtime；现在会读取最近 7 天、最多 80 条远端与本机历史，群聊
  继续按各群配置的时间窗口读取，两者都能把历史图片和文件交给 Runtime。
- 每个 Agent 在 `~/.threadferry/history/<Agent>/` 保留自己实际收到的授权消息与资源，私聊和群聊
  分区存储，重启后仍可回读，不跨 Agent、会话或 Workspace 共享。
- 本机历史最多保留 7 天、1,000 条消息和 200 MB 资源；目录、索引和内容文件分别使用 0700/0600，
  资源按 SHA-256 去重并校验，过期记录和孤立内容自动清理。每轮仍只向 Runtime 提供最多 10 个、
  合计 50 MB 的临时副本，完成或失败后删除副本。
- `message files get` 同时兼容实测顶层 `file_path`、文档结构 `media_item.file_path` 和小型 UTF-8
  文件的 `media_item.content`；CLI 的顶层 `error.code` 也会转换为明确错误，不再丢失真实响应。
- 历史索引不保存企业微信资源 URL、AES Key 或 `media_id`。如果企业微信远端私聊历史暂时返回空，
  当前消息仍会正常处理，并从本机已留存的历史补齐后续上下文。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、机器人凭据和既有 Runtime Session 无需迁移；首次收到授权消息时自动创建本机历史目录。
升级前已过期且企业微信接口不再返回的资源无法追溯恢复，需要重新发送一次。

## 0.24.0

补全企业微信图片和文件从实时回调、引用消息、群历史到本地 Runtime 的完整处理链，替换原先只保留
附件类型和文件名、实际内容无法进入分析的旧实现。

### 主要变化

- WebSocket 入口统一接收文本、图片、图文、语音、文件和视频消息；图片、文件及其引用资源通过官方
  SDK 下载和解密，下载失败会返回明确的资源处理错误。
- 群历史使用 `chat messages list` 返回的 `media_id`，再通过 `message files get` 取回最近资源；
  分析后的新鲜度复查不重复下载附件。
- Codex、Pi 和 Grok 接收真实图片输入，Claude Code 通过受控临时目录读取资源；UTF-8 文本文件直接
  作为不可信数据交给所有 Runtime。Runtime 不支持的二进制格式会明确说明，不能再误报“没有收到”。
- 资源单文件限制 20 MB、单轮合计限制 50 MB，最多处理 10 个；临时目录与文件分别使用 0700/0600，
  当前消息完成多机器人分发、历史分析结束或失败后都会清理。
- 状态库、群历史上下文和错误信息只保留资源类型、文件名与来源，不持久化临时路径、下载 URL、
  AES Key 或 `media_id`。
- Grok Build 使用官方 ACP JSON 图片块；由于 `--prompt-json` 受操作系统参数长度限制，编码后的请求
  超过 700 KB 时会明确提示改用 Codex、Pi 或 Claude，不会静默丢图。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、机器人凭据和既有 Session 无需迁移。

[查看 v0.23.1...v0.24.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.23.1...v0.24.0)

## 0.23.1

补齐项目首页的四 Runtime 能力海报，让群聊、私聊、1:1 机器人模型和支持的本地 Runtime 在
README 中直接可见。

### 主要变化

- 中英文 README 在产品说明下加入 Codex、Pi、Claude、Grok 能力海报。
- 海报作为正式文档资产纳入仓库和 npm 发布包，避免安装包中的 README 图片失效。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次仅调整文档与发布资产，配置、机器人凭据、Runtime 和 Session 均无需迁移。

[查看 v0.23.0...v0.23.1 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.23.0...v0.23.1)

## 0.23.0

新增 Claude Code 与 Grok Build 原生 Runtime，在保留每个 Agent 独立 Workspace 和 Session 的同时，
继续执行 ThreadFerry 的只读与敏感文件保护边界。

### 主要变化

- `runtime` 新增 `claude` 和 `grok`，可从初始化向导、终端参数、本机管理台或 v6 配置选择。
- Claude Code 使用 Safe Mode、`dontAsk` 和只读工具白名单；Grok Build 使用 strict sandbox、
  `dontAsk`、只读工具白名单，并关闭 Web、子 Agent、Memory 和自动更新。
- 两个 Runtime 都支持模型覆盖、持久 Session 和中断信号，机器输出只提取最终回复，不把机器人凭据
  或企业微信参数传入 Runtime 环境。
- `threadferry start` 和 `threadferry doctor` 会检查对应 CLI 版本与登录状态，并给出可执行的登录提示。
- 中英文 README、配置示例和真实验收清单已同步四 Runtime，并换用对应的产品主图。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

Claude Runtime 需要 Claude Code `2.1.233+` 并执行 `claude auth login`；Grok Runtime 需要 Grok Build
`1.0.5+` 并执行 `grok login`。现有 Codex、Pi、配置格式和机器人凭据无需迁移。

[查看 v0.22.0...v0.23.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.22.0...v0.23.0)

## 0.22.0

重做本机管理台与项目首页：机器人可以在管理台内完成新增和授权，群聊配置改为清晰的列表与详情页，
并补齐明暗主题、操作反馈和当前企业微信 CLI 工程契约。

### 主要变化

- 管理台改为带固定侧栏的后台布局，增加亮色与暗色主题，并统一页面按钮、状态卡片、对话框和移动端布局。
- 「Agent 工作区」升级为「机器人管理」：新增机器人时可选择 Workspace、Runtime、模型和独立
  `wecom-cli` 配置目录，并直接扫码、输入 Bot ID / Secret 或稍后授权。
- 扫码授权复用 `wecom-cli` 官方浏览器流程；手工 Secret 只由 localhost、带 CSRF 防护的请求临时
  转交给 `wecom-cli`，不写入配置、日志、状态、URL 或环境变量。
- 群聊管理改为紧凑列表；点击群聊进入独立详情页，再完成机器人绑定、成员授权、全员开关、
  Session 重置和解绑。写操作后保留当前详情页及操作结果，不再跳回总览。
- 待绑定群列表支持手动刷新；查询失败会按机器人显示原因，列表为空时说明最近 7 天发现规则。
- 重写中英文 README，并新增 ThreadFerry 产品封面；新增 `WECOMCLI_GUIDE.md`，记录当前
  `wecom-cli 1.1.0` 命令树、per-Agent 凭据隔离和安全操作边界。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、企业微信凭据和群聊授权规则不变，无需迁移。

[查看 v0.20.3...v0.22.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.20.3...v0.22.0)

## 0.21.4

调整管理台主题入口位置，并统一页面主要操作按钮的尺寸和对齐方式。

### 主要变化

- 明暗主题切换按钮移至左侧栏底部，与本机监听状态集中放置；移动端继续保留在顶部右侧。
- 页面按钮和链接按钮统一为相同高度、内边距、文字对齐与圆角，刷新、绑定、授权和危险操作不再大小不一。
- 弹出选择器内部操作继续使用紧凑尺寸，保持列表可用空间，不与页面主操作混用。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、机器人凭据和管理台业务行为不变，无需迁移。

## 0.21.3

群聊管理的“待绑定”区域新增手动刷新入口，可直接重新查询各机器人最近可见的群聊。

### 主要变化

- “待绑定”标题右侧新增“刷新群列表”按钮，不必依赖浏览器工具栏刷新页面。
- 刷新继续复用现有按 Agent 查询和错误提示流程，不新增接口，也不改变群绑定和授权规则。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、机器人凭据和管理台业务行为不变，无需迁移。

## 0.21.2

管理台新增亮色与暗色主题切换，并重新调整两套主题的颜色、层次和对比度。

### 主要变化

- 亮色主题使用浅灰页面、白色侧栏与内容面板，降低大面积深色带来的视觉压力。
- 顶部新增主题切换按钮，选择保存在本机浏览器；首次访问时自动跟随系统明暗设置。
- 暗色主题同步改用变量化色板，表单、弹窗、选择器、状态与危险操作在两套主题下均保持清晰。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、机器人凭据和管理台业务行为不变，无需迁移。

## 0.21.1

重做本机管理台布局：用后台管理式侧栏、页面标题区、状态概览和响应式内容面板替代顶部标签页与连续卡片流，业务入口和安全边界保持不变。

### 主要变化

- 概览、机器人管理和群聊管理改用固定侧栏导航，每个页面都有独立标题和当前页面标识。
- 状态数字、机器人卡片和群配置使用统一的后台管理面板样式，提高信息密度和层级辨识度。
- 窄屏下侧栏自动变为顶部横向导航，卡片改为单列，不影响已有表单、对话框和键盘操作。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、企业微信凭据和管理台业务接口均未变化，无需迁移。

## 0.21.0

把本机管理台的 Agent 配置入口改成完整的机器人管理流程：新增机器人时可以同时配置独立凭据目录
并完成企业微信授权，不再需要添加后回终端补跑命令。

### 主要变化

- 管理台「Agent 工作区」更名为「机器人管理」，数量、添加、删除和状态文案都围绕机器人表达，
  内部仍保持“一个机器人对应一个独立 Agent”的 1:1 模型。
- 添加机器人时可填写独立的 `wecom-cli` 配置目录，并选择扫码授权、输入 Bot ID / Secret 或稍后授权；
  未授权机器人卡片也可直接重新发起授权，不再要求用户回终端补跑命令。
- 扫码授权复用 `wecom-cli auth init --noninteractive` 打开官方页面；手工 Secret 仅通过本机管理台
  临时转交给该机器人的 `wecom-cli` 加密存储，不写入 ThreadFerry 配置、日志、状态或跳转 URL。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式不变。已有机器人和凭据目录无需迁移。

[查看 v0.20.3...v0.21.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.20.3...v0.21.0)

## 0.20.3

把 ThreadFerry 从单轮代办扩展为可持续工作的企业助手：能连续读取企业资料、自动邀请会议参与人、
持久执行提醒，并在隔离的 Agent 之间交接和复核任务。

### 主要变化

- 同一请求最多连续执行 8 次白名单只读动作，读取结果作为不可信业务数据回到原 Runtime Session；
  资料齐全后直接回答，或按现有授权规则完成最终写入。
- 补齐文档、表格、智能文档、智能表格、邮件、微盘、日程、待办、会议详情和会议转写读取。
  CLI 生成的内容文件只从隔离临时目录读取，限制 1 MB，注入后立即删除。Owner 完成文档授权后，
  `auth_change_event` 会让原私聊 Session 自动继续未完成请求。
- 新增持久提醒和主动唤醒：到期后自动运行对应 Agent 并私聊汇报；失败按 5～60 分钟退避重试，
  重复提醒和重启恢复均保留。主动回执先进入 outbox，投递失败只重试通知，不会重复运行 Agent。
- 新增持久 Agent Inbox 与协作任务：Owner 可指定执行 Agent 和复核 Agent；任务说明、执行结果和
  复核意见显式传递，但 Session、群历史和机器人凭据继续完全隔离。创建、转交和执行均限制在同一
  Owner 的 Agent 内，旧状态中的跨 Owner 任务也会拒绝。
- 创建会议、提醒和协作任务后直接返回资源 ID，便于后续查询、修改和交接。
- 处理中回执显示当前机器人名，例如“叶翔（ThreadFerry）已收到”；邀请参与人时自动排除通讯录中
  不存在的机器人，不再因群内机器人名称导致整场会议创建失败。
- 修正会议创建时间格式：按企业微信服务端真实契约发送 `YYYY-MM-DD HH:mm:ss`，不再受
  `wecom-cli 1.1.0` 错误 Unix 时间戳 schema 影响。
- Owner 使用“拉一场会”等自然表达时也视为明确创建会议，不再错误退回一次性确认码。
- 创建会议成功后自动安排会后任务，在结束 5 分钟后读取转写并提取结论、决定和待办。
- 所有动作统一经过资源策略；群聊中的个人数据读取直接拒绝，高风险动作始终二次确认。Activity
  只记录动作类型和资源标识（URL 先哈希），并在管理台和 `threadferry status` 展示。
- 状态格式内部升级到 v4，并自动读取旧 v3 状态；配置格式和机器人凭据目录不变。

企业微信当前智能机器人事件和 `wecom-cli 1.1.0` 尚未提供文档评论事件源，因此没有用正文轮询
冒充评论触发。官方开放事件或查询接口后再接入。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式和机器人凭据目录不变。旧 v3 状态会在首次读写时自动升级，提醒、协作任务和 Activity
继续写入原有 `~/.threadferry/state-v3.json`，不需要手工迁移。

[查看 v0.19.0...v0.20.3 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.19.0...v0.20.3)

## 0.19.0

补齐企业微信常用查询和操作链路，并把会议创建改为一次说清、自动完成。

### 主要变化

- 新增 `meeting.create` 白名单动作，复用企业微信原生 `meeting create`。支持标题、开始/结束时间、
  地点、备注和参与人；参与人先按姓名或 `id:<userid>` 解析，再随创建请求一起发送邀请。
- 日程补齐搜索、共同空闲时间、修改和取消；会议补齐搜索、修改和取消；待办补齐查询、创建、修改、
  完成和删除。查询结果直接回显时间、会议号、链接和真实资源 ID，后续操作不再依赖猜测。
- 新增邮件搜索和发送、企业微信文档搜索和创建、微盘搜索。内部收件人按通讯录解析，也支持外部邮箱；
  邮件正文和文档内容只接受消息中的文本，不读取 Runtime 给出的本地文件路径。
- 企业数据查询及邮件、文档、微盘操作只允许在 Owner 私聊执行。取消、删除、完成整个待办和发送邮件
  始终要求新的 Owner 确认；群聊不会执行或泄露这些操作的内容。
- Owner 当前消息明确要求对应创建或修改操作时直接执行。其他成员发起的写操作仍生成一次性确认码，
  由 Owner 私聊确认；高风险操作始终二次确认，原有权限边界不变。
- 自动执行额外检查当前用户原文中的操作意图。Runtime 自己生成的动作或群历史中的提示词不能替
  Owner 授权，普通分析请求不会因为错误动作提议而自动写入。
- 每个白名单动作先调用官方 CLI 的 `--dry-run` 做本地参数校验，通过后才执行真实写入。
- Runtime 动作说明补全 `attendees` 契约和带邀请人的会议示例；执行摘要显示姓名，不再把内部 userid
  当参与人名称展示。
- 已按当前 Agent 的 `wecom-cli 1.1.0` 官方文档和 schema 审核全部服务树，并用 `--dry-run` 验证新增
  命令。附件、本地文件上传下载、内容覆盖和智能表格批量修改暂不开放，等待资源级授权与文件边界。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式和机器人凭据不变。升级后重启 `threadferry start` 即可使用。

[查看 v0.18.1...v0.19.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.18.1...v0.19.0)

## 0.18.1

本次修复启动自动更新检测的漏口，并让成功检查结果在终端可见。

### 主要变化

- `threadferry start` 现在会先检查 GitHub Latest Release，再判断本机是否已有配置。首次运行转入
  初始化引导时，不再跳过启动前更新检测。
- 当前已经是最新版时，终端会明确显示检查结果，避免正常的静默检查被误认为功能失效。
- 已有配置的启动、每 6 小时定期检查、发现新版本后的安装与平滑重启逻辑保持不变。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式和机器人凭据不变，升级后直接运行 `threadferry start`。

[查看 v0.18.0...v0.18.1 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.18.0...v0.18.1)

## 0.18.0

Agent 现在能识别「帮我建个日程」这类写操作意图并**给出建议**，由 Owner 确认后 ThreadFerry
代为执行。**Runtime 的只读沙箱一点没松**——它只能提议，不能动手。

### 主要变化

- **新增白名单动作机制**（`src/actions.ts`）。链路是：Runtime 识别意图 → 输出一个结构化提议 →
  ThreadFerry 校验它在白名单里且参数合法 → 群里/私聊里给出人类可读摘要和一个 6 位确认码 →
  **Owner 私聊发送 `threadferry confirm <码>`** → ThreadFerry 用该 Agent 自己的凭据调 wecom-cli 执行 →
  回执发回私聊，提议发生在群里时也发回那个群。
- **首个动作：`schedule.create`（创建日程）**。支持标题、开始/结束时间、地点、备注、参与人
  （参与人按姓名或 `id:<userid>` 经通讯录解析，不接受直接塞 userid）。已在真实企业微信日历上
  端到端验证：提议 → 确认 → 日程真的建出来 → 回查确认。
- **Runtime 仍然只读**：Codex 沙箱（文件系统只读、无网络、不继承环境变量）和 Pi 只读扩展
  （只放行 `read`/`ls`）都不变，提示词里「禁止写操作」也保留。新增的只是「可以提议」这一条例外，
  并明确告诉它时间格式和「信息不全先问清楚，不要臆造」。
- **提示词注入的边界没有变**：群历史仍是 `UNTRUSTED_GROUP_HISTORY`。注入最多让 Runtime 提议一个
  动作，而动作必须在白名单里、参数必须过校验、还必须由 Owner 亲自确认——非 Owner 连确认命令
  都走不到（私聊管理命令本来就只对 Owner 开放）。
- 提议围栏块会从回复里整块摘掉：群里只看到自然语言和确认摘要，看不到原始 JSON。解析失败或动作
  不在白名单时按「没有提议」处理，绝不猜测用户意图。
- 确认码一次性、10 分钟过期、只存在内存里——没人确认过的写操作不会跨重启存活。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

配置格式、凭据和既有命令都不变，升级后直接：

```sh
threadferry start
```

想再加动作（待办、文档、邮件等）只需在 `src/actions.ts` 的白名单表里加一项：给出参数校验和
摘要渲染，其余流程（提议摘取、确认、执行、回执）自动复用。

### 安全边界

- Runtime 沙箱未放开任何权限；写操作一律由 ThreadFerry 执行，且只限白名单里的动作。
- 每个动作都要 Owner 在私聊里确认；确认码一次性、10 分钟过期。
- 参与人只能经通讯录解析，不接受调用方直接提供 userid。
- 执行失败时把 wecom-cli 的真实原因回给 Owner（私聊对象只可能是 Owner）。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.17.0...v0.18.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.17.0...v0.18.0)

## 0.17.0

本次版本重做本机管理台的两个添加流程：**添加 Agent 工作区**和**添加群可使用用户**不再是页面上
散着的一排输入框，而是点按钮弹出对话框；**路径和人名都在输入框上直接选**，不用先跳到另一个页面
再跳回来。

### 主要变化

- **添加表单改为对话框**：Agent 工作区页顶部只留一个「＋ 添加 Agent 工作区」按钮，群卡片上只留
  一个「＋ 添加可使用用户」按钮，表单在对话框里填，填错不会把整页挤变形。
- **点输入框就弹选择菜单**：Workspace 输入框点一下就在下面展开本机目录列表，点子目录逐层进入、
  「↑ 上级」回退、「使用此目录」确认；边打字边筛（`/Users/x/Desk` 直接列出上级目录里匹配的项），
  ↑↓ 选、回车进入、Esc 收起。原来那个需要整页跳转的目录浏览页保留为无脚本回退。
- **可使用用户改为搜通讯录选人**：输入框里打姓名或别名就列出候选人（带别名和部门），点一下即选中，
  不再"名字撞了才在报错里看到候选列表"。也仍然可以直接填 `id:userid`。
- **填错不用重填**：表单校验失败时对话框带着已填的值重新打开，错误提示显示在对话框里而不是被
  对话框挡住的页面顶部。
- **样式与脚本改为同源单独提供**（`/admin.css`、`/admin.js`），CSP 收紧为
  `style-src 'self'; script-src 'self'; connect-src 'self'`，不再需要 `unsafe-inline`。
- 目录列表新增 `/api/dirs`、通讯录搜索新增 `/api/users`，两个都是只读 GET，仍然只监听
  `127.0.0.1` 并校验 Host。

### 一个群可以同时启用多台机器人

原来一个群只能绑一个 Agent，配置加载时会直接报错「群 X 同时挂在 Agent A 和 B 下；一个群只能归属
一个 Agent」。群里放了两台机器人却只能用一台，这个限制取消了。

- **群里 @ 哪台机器人，就由它用自己的 Workspace 回答**。两台机器人的授权名单、全员可用开关和
  Runtime Session 完全独立，互不影响。
- **磁盘格式没有变**：v6 本来就是把群嵌套在 Agent 下的，同一个群 id 出现在两个 Agent 的 `groups`
  里即可。现有配置文件不需要改动。
- **运行时本来就按机器人隔离**：群回调只发给被 @ 的那台机器人，每个 Agent 各有连接、app 实例、
  串行队列；Session 记录同时按「群 + Agent」定位。这次只是让配置能表达出来。
- **管理台群卡片按 Agent 分段**：每台机器人一段，各自有全员可用开关、可使用用户名单、重置 Session
  和解绑；最后一台解绑后整条群配置移除。
- **待绑定的候选从下拉改成复选框**：群里有几台机器人就勾几台，一次提交全部绑上（原来只能选一个、
  绑完再绑第二次）。已配置群卡片底部同样可以勾选「再加机器人」。只有一个候选时默认勾好。
- **中断恢复认得出机器人**：待处理消息和待补发回复现在记下当初受理它的 Agent，重启后由同一台机器人
  接手。旧状态记录没有这个字段，只有群里恰好只有一台机器人时才兜底，否则宁可不发也不冒用另一台的身份。
- `threadferry reset <群>` 会把该群里每台机器人的 Session 都清掉并报出数量。

### 修复：同时 @ 两台机器人时只有一台回话

群里发 `@叶翔 @悦翔 你们好`，只有一台机器人回答；单独 @ 另一台又是好的。这里其实有**两个**
独立的原因，都修了。

#### 原因一：状态去重把第二台当成了重复消息

- 假设企业微信给每台被 @ 的机器人各发一次回调，**msgId 是同一条消息的**。而
  ThreadFerry 里所有 Agent 共用一份状态存储，turn 的身份只由 msgId 算（`sha256(msgId)`），
  于是先到的那台建好 turn，第二台被 `enqueue` / `claimCommand` 判成「已经处理过」直接丢掉——
  用户看到的就是有一台不吭声。待发送回复的 id 同样只由 msgId 算，两台机器人的回复会互相覆盖。
- **改法**：turn 和待发送记录的身份改成 `sha256(agentId + \0 + msgId)`，
  `enqueue` / `claimCommand` / `markRunning` / `finish` / `finishWithDelivery` 全部按 Agent 分开；
  收件箱清理也只清属于自己的那条。不带 Agent 时保持原样，0.16.0 写下的记录升级后仍能收尾
  （找不到带 Agent 的身份时回退到旧身份）。
- 群命令同理：`@两台机器人 threadferry help` 现在两台都会回。

#### 原因二：企业微信只把消息投给第一个被 @ 的机器人

修完去重之后仍然只有一台回话。实测（同一个群、两台都已绑定、去重修复已生效）：

| 消息 | 回话的 | 状态里的 turn 数 |
| --- | --- | --- |
| `@叶翔 @悦翔 你们好` | 叶翔 | 1 |
| `@悦翔 @叶翔 你们好` | 悦翔 | 1 |

交换 @ 顺序，回话的机器人跟着换，而且**每条消息始终只有一条 turn**——去重修复在跑的情况下，
两份回调必然产生两条 turn，所以结论是第二台**根本没收到回调**，不是 ThreadFerry 丢了它。
后续用日志复核确认：被转交的那台打印的是「接手转交」而不是「收到群内 @消息」，即企业微信确实
只投了一份回调。

- **改法**（`src/group-fanout.ts`）：ThreadFerry 的多个 Agent 本来就跑在同一个进程里，所以由
  收到回调的那台把同一条消息**在进程内转交**给「也被 @ 到、也绑了这个群」的其他 Agent，
  各自用自己的机器人凭据回复。两台都会先发「已收到，正在分析」再各给自己的结论。
- 被 @ 但没绑这个群的不转交；收到回调的那台不重复处理。
- **@ 匹配要求名字后面是空白、标点或另一个 `@`**：企业微信的回调帧里没有结构化的被 @ 列表
  （`BaseMessage` 只给 `text.content`），只能按文本匹配 Agent 名和机器人名；加了边界判断，
  `@叶翔2` / `@叶翔的助手` 不会被误判成 @ 了「叶翔」，窄空格（U+2005）和连续 `@` 也照样识别。
- 若企业微信将来改成投给所有被 @ 的机器人，多出来的那份会被上面按 Agent 的 turn 去重挡掉，
  不会答两遍；日志会打印「已自己收到…转交被去重挡下」，据此就能把转交去掉。
- **转交出去的回复带上原消息引用**：群里那种「引用气泡」来自 SDK 的 `replyStream`，它绑定在
  「收到的那一帧」上；被转交的机器人没有这一帧，而 `message.aibot.send` 也没有引用字段
  （只有 chat_id + 正文）。所以它的回复会把原消息压成一行放进 markdown 引用块（超长截断），
  群里仍然看得出在回哪一条。
- **转交回复改走该 Agent 自己的 WS 连接**（SDK 的 `sendMessage`，"无需依赖收到的回调帧"），
  不再为每条回复起一个 wecom-cli 子进程；发不出去时回退 wecom-cli，不丢回复。
- **已知差异，以及为什么不是凭据隔离的问题**：引用气泡来自 SDK 的 `replyStream`，它按收到回调时
  的 `headers.req_id` 在**那条连接上**关联（SDK 内部的 `replyQueues` / `pendingAcks` 都按 req_id
  分组）。req_id 是企业微信针对**某台机器人的某一次回调**下发的一次性凭证，而企业微信只把消息投给
  第一个被 @ 的机器人——所以另一台压根没有这次回调的 req_id，跟它有没有独立凭据、独立连接无关。
  两条主动发送通道（SDK `sendMessage` 与 `wecom-cli message aibot send`）的 body 都只有
  `markdown` / `template_card`，**都没有引用字段**。
  结果就是：收到回调的那台是一个流式气泡（ack 逐步变成结论，带「内容由 AI 生成」脚注和引用样式），
  被转交的那台是两条普通消息（ack、结论），引用是正文里的 markdown 引用块。
  （`template_card` 有 `quote_area` 可以画引用区，但整条消息会变成卡片样式，离另一台的气泡更远，
  所以没用它。）

  为什么不能让另一台自己发起一次 `replyStream`：SDK 里 `reply` 和 `sendMessage` 走的是同一个
  `sendReply(reqId, body, cmd)`，区别只在——`reply` 用 `frame.headers.req_id` 且 `cmd` 默认
  `RESPONSE`（对服务端某次请求的**应答**，伪造 req_id 没有东西可对应），`sendMessage` 用
  `generateReqId()` 自己生成的 req_id 且 `cmd=SEND_MSG`（客户端主动发起）。也就是说 req_id 确实
  可以自己生成，但只对主动发起的 cmd 有效；而主动发送的 `SendMsgBody` 只有 markdown / 卡片 / 媒体
  三种，**没有 stream 变体**，所以那条路上根本没有流式气泡。
  帧里的 `response_url`（「支持主动回复消息的临时 url」）同理，是发给收到回调那台的，用它发出来
  仍然是那台的身份。

### 群成员名单显示姓名，不再是一串加密 userid

原来群卡片里只有 `wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw` 这样的加密 id，根本看不出是谁。

- **先说清一个坑**：企业微信通讯录**不支持按 userid 反查**——`contact users search` 只认姓名/别名
  关键词，拿 userid 当关键词一律返回空。所以原来那套「用 userid 当关键词搜通讯录」的代码
  对真实的加密 userid 永远查不到东西，已删除。
- **改成顺手收集映射**（`src/directory-names.ts`），三个来源：
  1. `message aibot sessions list` 的**单聊会话**——`chat_id` 就是对方 userid，`chat_name` 就是姓名。
     这个调用群发现时本来就要发，等于免费。
  2. **群历史消息**——每条都带 `userid` + `user_name`，覆盖群里说过话的人。
  3. **按姓名添加用户成功的那一刻**——那时我们本来就同时知道 id 和姓名，记下来。
- 名单里**姓名放主位、加密 id 退成下面一行小字**（仍然完整显示，便于排查和复制）。
- 同样绝不阻塞：管理台只做同步查表，收集在后台跑、限时 8 秒、按 Agent 每 10 分钟一次；
  没有会话或历史权限就一直显示 id，不报错也不变慢。

### Agent 工作区能看出机器人属于哪个企业

多个企业的机器人混在一起时，卡片上只有 Agent 名和加密 userid，分不清谁是谁。

- 卡片右上角显示 **Owner 在通讯录里的顶层部门**（小企业里就是企业名）。企业微信没有「机器人属于
  哪个企业」的查询——`auth show`、`identity whoami`、本地凭据和缓存里都没有——所以这是两步推出来的：
  `identity whoami` 拿 Owner 姓名 → 用姓名搜通讯录 → 取第一个部门。页面上直接说明了它是什么，
  不假装是企业名。
- **Owner 显示姓名**（原来只有 `wowBknbg…` 这样的加密 userid，id 仍然并排显示便于核对）。
- 机器人自己的名字和 Agent 名不一致时也显示出来，便于发现改名后的错配。
- **这是纯装饰，绝不阻塞任何流程**（`src/agent-origin.ts`）。部分机器人根本没有企业通讯录权限，
  所以：页面只读缓存、从不等这两个调用，缺失或过期时后台补一次；两个调用都限时 5 秒
  （远小于默认 30 秒）；身份信息先落缓存再去查通讯录，通讯录慢、被拒甚至挂住也只是少一个部门
  徽章，机器人名和 Owner 姓名照常显示；失败也记时间戳按住重试，TTL 到了自己再试，
  权限后来被授予时不用重启。启动时后台预热一次，管理台首次打开就能看到。

### 修复：群聊识别不到

把机器人拉进群以后，管理台和 `threadferry groups` 都看不到那个群——这是本次一并修掉的实打实的 bug。

- **根因**：群发现走的是 `message aibot sessions list`，它的官方定义是「机器人**最近的会话**列表，
  按最后一条消息时间倒序返回**最多 20 个**」。机器人被拉进群不会产生会话，所以**没人 @ 过它的群
  永远不出现**；会话多了还会被 20 条截断。
- **改法**：改用 `chat groups list`（按时间范围翻页取有消息的群，覆盖最近 7 天）作为发现来源，
  再用 `aibot sessions list` 给「机器人确实在这个群」盖章，两个来源合并。翻页是按时间切片的，
  同一个群会在多页重复出现，按 chat_id 去重。任一来源可用就出结果：企业没开会话数据权限时
  退回机器人会话，机器人还没被 @ 过时只用有消息的群。
- **绑定校验不再假装知道成员**：企业微信不提供群成员查询，`aibot sessions list` 只能**确认**
  机器人在群、不能证明它不在。所以下拉里给确认过的 Agent 标「机器人已在群」，未确认的照样允许
  绑定，并提示「绑完在群里 @ 一次机器人；它没反应说明那台机器人还不在群里」。
- **不再把查不到说成查完了**：每个 Agent 的群查询失败会单独列出原因，并声明列表并不完整；
  一个群都没发现时说明发现规则（最近 7 天要有消息、或先 @ 一次机器人），而不是显示
  「所有可见群会话都已绑定」。
- **失败原因是能照着做的那一句**：wecom-cli 失败时把结构化错误打在 **stdout**（退出码非 0），
  `Error.message` 只剩「执行失败（退出码 1）」。现在会取出真正的原因（例如「该请求需要授权」），
  授权类失败再补上本项目的补救办法 `threadferry agent login <Agent名>`。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

本次改动集中在管理台前端、群发现逻辑和相关只读接口，配置格式、凭据和命令都不变，升级后直接：

```sh
threadferry start
```

### 安全边界

- 管理台仍然只监听 `127.0.0.1`，仍然校验 `Host`、仍然带 CSRF token；新增的两个接口是只读 GET。
- 新增脚本只从同源 `/admin.js` 加载，CSP 不放开 `unsafe-inline`。
- 目录接口只返回子目录名，不读文件内容，隐藏目录不列出，单次最多 500 项。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.16.0...v0.17.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.16.0...v0.17.0)

## 0.16.0

本次版本把 ThreadFerry 改成**一个 Agent 对应一个企业微信机器人（严格 1:1）**，多个 Agent 的
连接并发跑在同一个进程里，彼此完全独立——各自的机器人凭据、Owner、群与授权名单、Workspace
和 Session。想用哪个 Workspace，就和那个机器人聊。

### 💥 破坏性变更（内部测试阶段，不提供兼容层）

- **配置只接受 `version: 6`**，v5 配置不再自动升级。
- **Agent 名支持中文和空格（最多 128 字符）**：agentId 同时是机器人凭据目录名，因此挡掉路径分隔符、
  控制字符、`.`/`..` 和超长，但中文等常见字符不受限制（v5 即支持，恢复）。
- **移除 `THREADFERRY_WECOM_BOT_ID` / `THREADFERRY_WECOM_BOT_SECRET` 环境变量**，
  也移除启动时交互式输入 Bot ID / Secret 的流程。机器人凭据统一由
  `threadferry agent login <name>` 交给 wecom-cli 加密保存。
- **`default` Agent 不再复用 `~/.config/wecom`**：所有 Agent 统一使用
  `~/.threadferry/wecom/<agentId>`，需要重新授权一次。

**安全收益**：ThreadFerry 现在完全不经手 Bot Secret——不提示输入、不写入环境变量，
只在建立连接时从 wecom-cli 的加密存储读取。`doctor` 也改为按 Agent 分别检查凭据与身份。

### 主要变化

- `threadferry start` 启动时亮明当前机器人、当前授权真人用户和配置里的 Owner。
- 当前授权用户与配置 Owner 不一致时警告，并在本机终端询问是否更新（默认否）；非交互式启动只警告。
- 私聊被拒的回复带上对方自己的 userid 和恢复办法，但不回显配置里的 Owner。
- 新增 `src/identity.ts`：解析 `wecom-cli identity whoami` 的 `extra_identity_context`，容错降级。

### 引导体验重做（onboard / setup）

- **开场先讲清 1:1 心智模型**：一个 Agent 对应一个企业微信机器人，想加第二个 Workspace 就再加
  一个 Agent + 一个机器人。
- **扫码授权有预告**：进入 `wecom-cli auth init` 前先说明"接下来会打开浏览器扫码"，不再让用户
  从表单里被突然丢进第三方流程。
- **步骤计数修正**：`onboard` 从 4 步改为 5 步，把「扫码授权机器人」和「私聊配对 Owner」拆成
  两个独立编号步骤。
- **`onboard` 支持已有配置**：识别已有配置后给出「新增一个 Agent」/「重新配对已有 Agent 的
  Owner」/「取消」三种选择，覆盖 1:1 架构下最常见的"再加一个机器人"需求。
- **配对码提示完整**：说明去哪找机器人、必须用希望成为 Owner 的账号发送、发完要回终端确认。
- **配对等待不再无限挂住**：默认 5 分钟超时（`--timeout <秒>` 可调），等待期间每 30 秒提示一次
  剩余时间；配对码错误会**回复用户**而不只是写本机终端（回复不回显正确配对码）。
- **`threadferry setup` 的 `--workspace` 改为可选**：已有配置且该 Agent 存在时，沿用其
  Workspace/Runtime/Model；没有配置或 Agent 不存在时才要求提供。
- **配对成功回复更新**：明确告诉用户「你现在私聊的这个机器人 = Agent X / Workspace Y」。
- **授权后直接认领 Owner**：扫码授权机器人的人就是创建者，`wecom-cli identity whoami` 直接读取其身份，
  终端一键确认（默认同意）即设为本 Agent 的 Owner，不再需要手机配对；想指定别人当 Owner 时才走手机配对。
- **Agent 名自动取自机器人名**：onboard 先扫码授权机器人，再从机器人配置读取名字直接用作 Agent 名，
  用户不再手敲，杜绝名字与机器人对不上的混乱；撞名自动追加序号，机器人名不合法才兜底询问。
- **Owner 私聊授权适配双 userid 体系**：企业微信存在两套 ID——事件回调用明文 corp userid（如
  `SuYueXiang`），目录/identity 用加密 userid（如 `wowBknbg...`）。此前配置存的是目录 ID 而私聊检查
  直接比回调 ID，导致创建者本人私聊被当成陌生人拒绝。现在私聊授权、`whoami`、邀请码授权都会先做
  回调→目录 ID 映射，`whoami` 和拒绝消息统一展示目录 ID，不再一会儿拼音一会儿官方 ID。
- **Owner 展示统一显示名字 + 官方 ID**：不再一会儿拼音一会儿微信官方 ID，身份展示格式一致。
- **诊断失败给出去路**：修复后重新运行 `threadferry onboard` 会复用已有配置和配对，或直接
  `threadferry start`，不需要从头再来。

### 多机器人并发运行

- `threadferry start` 为**每个已授权 Agent** 各建立一条机器人连接和一个独立处理实例。
  没有机器人凭据的 Agent 会被逐个报出来再跳过，不静默忽略。
- 新增 `threadferry start --agents a,b` 只启动指定 Agent。
- 每个 Agent 的所有 wecom-cli 调用（群历史、群列表、成员搜索、发送回复、身份查询）
  都使用它自己的凭据目录。
- **私聊直达**：跟哪个机器人私聊，就用那个 Agent 的 Workspace。不再固定使用第一个 Agent。
- **群与 Owner 按 Agent 隔离**：A 机器人收到 B 的群消息会被拒绝；A 的 Owner 不能私聊 B 的 Agent。
- 崩溃恢复的补发和重放都使用该群所属 Agent 的机器人，不会从错误的机器人身份发出。
- 配置热更新会就地刷新每个 Agent 的视图，立即生效；Agent 被删除后其连接随即拒绝所有消息。

⚠️ **尚未在双机器人环境实测**。逻辑与隔离已有测试覆盖，但两条真实连接并发需要第二个
企业微信机器人才能验证。

### Owner 下沉到 Agent

- **每个 Agent 有自己的 `owner_user`**。换企业后同一个人的回调 userid 不同，Owner 因此必须
  跟着 Agent 走——这也是「换企业后私聊被拒」那个问题的结构性解法。
- 群的授权名单校验改为必须包含**所属 Agent 自己**的 Owner。
- `threadferry start` 的身份核对改为按 Agent：用该 Agent 自己的凭据目录查询当前授权用户，
  与该 Agent 配置的 Owner 比对。
- 新增 Agent 时其机器人尚未授权，Owner 先继承主 Agent 的；该 Agent 授权后启动时会提示更正。

### 配置格式 v6

- 配置磁盘格式升级到 `version: 6`：**群和 Owner 都挂到各自 Agent 下**，顶层不再有
  `owner_user` 和 `groups`。Agent 成为配置里的隔离单元。
- **v5 配置自动升级，不需要手工迁移**：`loadConfig` 同时接受 v5 和 v6，v5 在读取时升级；
  下次写盘统一输出 v6。
- Agent 新增可选 `config_dir`，用于覆盖机器人凭据目录。
- 校验收紧：同一个群不能挂在两个 Agent 下；Agent 缺少 `owner_user` 会被拒绝；
  `config_dir` 必须是绝对路径。
- 当前运行时仍是单机器人模式，因此**各 Agent 的 `owner_user` 必须一致**，不一致会明确报错
  而不是静默取其中一个。多机器人落地后会放开。

### 凭据按 Agent 隔离

- 新增 `src/bots.ts`：每个 Agent 一个 `WECOM_CLI_CONFIG_DIR`（默认
  `~/.threadferry/wecom/<agentId>`）。名为 `default` 的 Agent 沿用 `~/.config/wecom`，
  现有单机器人安装升级后不必重新授权。
- Agent 名会拼进凭据目录路径，因此收紧校验为 `^[A-Za-z0-9_-]{1,64}$`，挡住路径穿越。
- 只有 `default` Agent 继续认 `THREADFERRY_WECOM_BOT_*` 环境变量，避免多机器人下
  一组环境变量被所有 Agent 误用。
- `threadferry agent list` 增列机器人授权状态，未授权的 Agent 直接给出授权命令。
- 新增 `threadferry agent login <name>`：在该 Agent 的凭据目录直连终端跑
  `wecom-cli auth init`。**Secret 从终端直接进 wecom-cli 的加密存储，ThreadFerry 全程不经手。**
- 配置文件只记目录，绝不存 Secret。
- 中文或含空格的 Agent 名（v5 起支持）是合法目录名，可以正常拥有独立机器人和凭据目录。

### 管理台与命令按 Agent 重构

- 管理台「Agent 工作区」页显示每个 Agent 的**机器人授权状态、Bot ID 和它自己的 Owner**。
- 绑定待绑定群时，下拉**只列出机器人确实在该群的 Agent**；绑给不在群里的机器人会静默失效，
  因此直接挡住。服务端也按目标 Agent 自己的机器人校验。
- 移除管理台的「切换群 Agent」操作与私聊 `threadferry use` 命令：1:1 之后换 Agent 等于换机器人，
  而那台机器人未必在该群。要换 Agent，解绑后用目标机器人重新绑定。
- `threadferry bind <群名或ID>` 不再接受 Agent 参数——你在跟哪个机器人说话就是哪个 Agent。
- `threadferry session reset` 与管理台重置只清该群**所属 Agent** 的 Session；两个机器人同在一个群
  时不会清掉对方的。

### 安装与升级

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

**本次为破坏性变更，需要重新配置**（详见上方「破坏性变更」）：配置必须是 v6、Agent 名只允许
ASCII、凭据目录迁移到 `~/.threadferry/wecom/<Agent名>`。升级后执行：

```sh
threadferry agent login <Agent名>
threadferry doctor
threadferry start
```

### 安全边界

- **ThreadFerry 完全不经手 Bot Secret**：不提示输入、不写配置、不写环境变量。凭据由官方
  `wecom-cli` 在各 Agent 自己的目录里加密保存，只在建立连接时读取。
- **Agent 之间相互隔离**：A 的机器人拒绝 B 的群消息，A 的 Owner 不能私聊 B 的 Agent。
- 每个 Agent 的所有企业微信调用都使用它自己的凭据目录，不会串到别的机器人。
- 崩溃恢复的补发与重放使用该群所属 Agent 的机器人，不会从错误身份发出。
- 其余边界不变：只处理 @ 消息、Runtime 固定在 Workspace 内只读、群历史是不可信输入。

### 尚未验证

⚠️ **多机器人并发尚未在双机器人环境实测**，需要第二个企业微信机器人。逻辑与隔离已有自动化
测试覆盖（64 项全绿），但两条真实连接并发必须真机验收，见 `POC.md` 第 29-33 项。

### 发布资产

- `threadferry.tgz`：包含已经编译的 CLI，可直接由 npm 全局安装。
- `SHA256SUMS`：用于校验发布包完整性。

### 运行要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+` 或 Pi CLI `0.84.2+`

[查看 v0.14.1...v0.16.0 的完整变更](https://github.com/GnaixEuy/threadferry/compare/v0.14.1...v0.16.0)

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
