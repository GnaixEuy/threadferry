# ThreadFerry

[English](./README.md)

ThreadFerry 支持经本机确认的企业微信用户直接私聊本机 AI Agent，也可以把群里的 `@机器人` 请求和近期讨论一起交给 Agent，在指定 Workspace 中完成只读分析。

```text
10:00 张三：这个接口有问题
10:01 李四：可能是 Redis
10:02 王五：线上出现三次
10:05 用户：@机器人 帮忙分析
```

**一个 Agent 对应一个企业微信机器人，严格 1:1。** 每个 Agent 独立拥有自己的机器人凭据、
Owner、群与授权名单、Workspace、Runtime、模型和 Session——想用哪个 Workspace，就和那个机器人聊。
多个 Agent 的连接并发跑在同一个 ThreadFerry 进程里，彼此互不影响。

当前支持企业微信私聊、内部群、Codex 和 Pi。机器人只在收到 `@` 后补拉最近 6 小时、
最多 80 条群消息，普通消息不会实时回调。

[查看更新日志](./CHANGELOG.md)

> **迭代中，尚未正式发布。** 多机器人能力已完成，但尚未在双机器人环境实测，
> 改造记录见 [MULTI_BOT_PLAN.md](./MULTI_BOT_PLAN.md)。

## 快速开始

### 1. 准备依赖

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`（安装器会自动检测并补装）
- Codex CLI `0.138.0+`，或 Pi CLI `0.84.2+`
- 企业微信智能机器人，**每个 Agent 一个**；只有需要群聊时才需要把对应机器人加入内部群

使用 Codex 时先完成登录：

```sh
codex login
```

使用 Pi 时，另按 Pi 的方式完成模型授权。

### 2. 安装并配置

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

安装器会检查操作系统、Node.js、npm 和 `wecom-cli 1.1.0+`。缺少 `wecom-cli` 或版本过低时，会执行官方安装命令 `npm install --global @wecom/cli`；其他依赖不满足时会给出修复提示。ThreadFerry 使用 [GitHub Releases](https://github.com/GnaixEuy/threadferry/releases/latest) 中已经编译和测试的安装包，不会在本机拉取源码、安装开发依赖或运行 TypeScript 编译。

终端可交互时会自动进入向导。也可以手动运行：

```sh
threadferry onboard
```

向导会引导你：

1. 讲解「一个 Agent = 一个机器人」的心智模型；已有配置时可以选择**新增一个 Agent**，
   或为已有 Agent **重新配对 Owner**。
2. 为该 Agent 授权企业微信机器人：先说明接下来会打开浏览器，再用 `wecom-cli auth init`
   扫码授权。Agent 名直接取自机器人名（撞名自动追加序号），无需手敲；只需确认 Runtime、
   模型和 Workspace（默认当前目录）。凭据由 wecom-cli 在它自己的目录里加密保存，ThreadFerry
   全程不经手。
3. 认领 Owner：扫码授权的人就是机器人创建者，直接读取其身份并询问是否设为本 Agent 的 Owner（默认同意）。
   想指定别人当 Owner 时拒绝，改走手机私聊配对。
4. 运行环境诊断。
5. 启动 ThreadFerry。

本机终端确认的授权用户会成为 Owner，并可立即私聊这个 Agent。配对和私聊 Agent 直接使用
机器人事件中的回调 userid，不需要企业微信通讯录权限。重新运行 `threadferry onboard` 可以新增
Agent 或为已有 Agent 重新配对 Owner；`threadferry setup` 也可以单独重新认领（已有配置时不必
再传 `--workspace`，会沿用该 Agent 已配置的 Workspace）。群聊配置是可选的。

只安装而不进入向导，或检查安装动作：

```sh
./install.sh
./install.sh --dry-run
./install.sh --no-onboard
```

### 3. 启动

```sh
threadferry start
```

`threadferry start` 会为**每个已授权 Agent** 各建立一条机器人连接。没有机器人凭据的 Agent
会被逐个报出来再跳过，不会静默忽略。只想启动部分 Agent：

```sh
threadferry start --agents frontend,backend
```

启动时还会亮明每个 Agent 的机器人身份、当前授权用户和配置里的 Owner。换企业或重建机器人后
回调 userid 会变，此时会提示不一致，并在本机终端询问是否更新（默认否；非交互式启动只警告）。

启动后保持终端运行。浏览器访问 [http://127.0.0.1:17638](http://127.0.0.1:17638) 可以使用本机管理台。

`threadferry start` 会在启动前检查 GitHub Latest Release，运行期间每 6 小时再检查一次。发现新版本后会自动安装，等待当前任务结束，再使用新版本重启；检查或安装失败时会告警并继续运行当前版本。也可以随时手动执行：

```sh
threadferry update
```

Owner 可以不带 `@`，直接私聊机器人。**跟哪个机器人私聊，就用那个 Agent 的 Workspace**：

```text
帮我排查登录失败问题
```

在已配置群中，通过企业微信的 `@` 选择器选中机器人：

```text
@机器人 帮忙分析刚才讨论的问题
```

## 管理群和用户

Owner 可以直接私聊机器人：

命令发给哪个机器人，就作用于那个 Agent。

| 命令 | 用途 |
| --- | --- |
| `threadferry groups` | 查看这个机器人所在的群及绑定情况 |
| `threadferry agents` | 查看已配置 Agent |
| `threadferry bind <群名或ID>` | 把该群绑定到**当前对话的这个 Agent** |
| `threadferry users <群名>` | 查看可使用成员 |
| `threadferry add <群名> <姓名>` | 按通讯录姓名授权 |
| `threadferry remove <群名> <姓名>` | 移除授权 |
| `threadferry invite <群名>` | 生成一次性邀请码 |
| `threadferry open <群名>` | 允许群内所有成员使用机器人 |
| `threadferry close <群名>` | 恢复仅授权成员可用 |
| `threadferry whoami` | 查看自己的回调 userid |

`bind` 不接受 Agent 参数——你在跟哪个机器人说话，就是绑给哪个 Agent。

**一个群可以同时启用多台机器人**：把机器人都拉进群，在管理台「群聊管理」页的待绑定卡片上
**勾选多台再点「绑定所选」**（也可以分别私聊每台机器人各发一次 `threadferry bind <群名>`）。
之后群里 @ 哪台机器人，就由它用自己的 Workspace 回答；每台的授权名单、全员可用开关和 Session
各自独立。不想让某台再参与，只解绑它就行，另一台不受影响。

一条消息里同时 @ 多台也可以（`@叶翔 @悦翔 你们好`），两台都会各给一份结论。注意企业微信只把
这条消息投给**第一个被 @ 的机器人**，所以这是 ThreadFerry 在进程内转交实现的——因此同时 @ 的
几台机器人必须都由**同一个 `threadferry start` 进程**托管（默认就是这样）。

两台的回复样式会有差异，原因不是凭据隔离而是引用机制：原生引用气泡由 SDK 的 `replyStream`
产生，它按收到回调时的 `req_id` 在那条连接上关联，而 `req_id` 是企业微信针对**某台机器人的某一次
回调**下发的——另一台压根没有这次回调的 req_id。两条主动发送通道（SDK `sendMessage`、
`wecom-cli message aibot send`）都没有引用字段。所以**第一个被 @ 的**那台是带原生引用样式的流式
气泡，**被转交的**那台是普通消息，引用以正文里的 markdown 引用块呈现。另外机器人的回答快慢取决于各自的 Runtime——codex 跑几十秒
是正常的，期间只会看到「已收到，正在分析」。

同名群或同名成员会返回候选 ID，按提示使用 `id:<userid>` 或群 ID 重试。管理命令和私聊 Agent
只对**该 Agent 自己的 Owner** 开放：Agent A 的 Owner 不能管理 Agent B 的群。
只有 `add`、`remove` 按姓名解析成员时需要通讯录权限；配对、私聊 Agent 和群绑定都不需要。

### 全员可用开关

`threadferry open <群名>` 打开后，该群所有成员都可以 @ 机器人使用，不再需要逐个授权；`threadferry close <群名>` 关闭后立即恢复为仅 `allow_users` 名单可用，名单在打开期间保持不变。管理台「群聊管理」页的每个已配置群卡片上也有同一个开关。两处修改都会写入配置文件的 `allow_all`，下一条 @ 消息生效。

开关只放宽“谁可以使用”，不改变其他限制：机器人仍然只处理被 @ 的消息，只读取已绑定群的历史，Agent 仍然以只读方式运行。

目标用户拿到邀请码后，可以私聊机器人：

```text
threadferry join <邀请码>
```

也可以在对应群发送：

```text
@机器人 threadferry join <邀请码>
```

## 管理 Agent

新增一个 Agent 就是新增一个机器人，两步：

```sh
threadferry agent add \
  --name reviewer \
  --runtime pi \
  --workspace /absolute/path/to/project \
  --model provider/model

threadferry agent login reviewer
```

`agent login` 会在该 Agent 自己的凭据目录（默认 `~/.threadferry/wecom/<Agent名>`）里引导完成
`wecom-cli auth init` 扫码授权。**ThreadFerry 全程不经手 Bot Secret**——凭据由 wecom-cli 自己
加密保存，ThreadFerry 只在建立连接时读取。

Agent 名会用作凭据目录名，因此支持中文和空格（最多 128 个字符），但不能包含路径分隔符或控制字符。

查看所有 Agent 及其机器人授权状态：

```sh
threadferry agent list
```

Agent 工作区的卡片右上角显示 **Owner 在通讯录里的顶层部门**（小企业里就是企业名），Owner 也显示
姓名而不只是加密 userid——多个企业的机器人混在一起时用来分辨。企业微信不提供「机器人属于哪个企业」
的查询，这个部门是由 `identity whoami` 的 Owner 姓名反查通讯录得到的最接近信息。

这些标识是纯装饰：**没有企业通讯录权限的机器人只会少一个部门徽章**，其余信息照常显示，页面也
不会因此变慢——管理台只读后台刷新好的缓存，从不等这些查询。

群聊管理页的可使用用户名单同样显示姓名（加密 userid 保留在下面一行小字里）。企业微信不支持按
userid 反查通讯录，所以姓名是从三处顺手收集的：单聊会话列表、群历史消息、以及按姓名添加用户的
那一刻。收集不到的人继续显示 id。

管理台分为「概览」「Agent 工作区」「群聊管理」三个页面：概览页汇总运行状态和待处理事项；
Agent 工作区页显示每个 Agent 的机器人授权状态、Owner、Workspace 和绑定的群，可以新增和删除
未被使用的 Agent；群聊管理页可以绑定或解绑群、切换全员可用开关、管理可使用用户和重置群
Session。修改立即生效。

新增操作都在对话框里完成：Agent 工作区页顶部的「＋ 添加 Agent 工作区」、群卡片上的
「＋ 添加可使用用户」。两个对话框的输入框都自带选择菜单——点 Workspace 输入框就地浏览本机目录
（可以边打字边筛，↑↓ 和回车逐层进入，「使用此目录」确认）；点用户输入框直接搜通讯录选人。
提交被拒时对话框会带着已填的值重新打开，原因就写在对话框里。

**群是怎么被发现的**：企业微信不提供「机器人在哪些群」的查询，ThreadFerry 只能列出
**最近 7 天里有消息的群**。所以把机器人拉进一个新群后，群里要先有一条消息（随便发一条，
或直接 @ 一次机器人），它才会出现在待绑定列表里。绑定下拉里标了「机器人已在群」的 Agent
是确认过有会话记录的；没标的照样可以绑，绑完在群里 @ 一次机器人，它没反应就说明那台机器人
还不在群里。查询失败（例如企业没开会话数据权限）会单独列出原因，不会假装列表是完整的。

## 让 Agent 查询和代做事

Agent 本身是**只读**的：沙箱不给网络和 shell，也不继承环境变量。但它能提议白名单里的企业微信
操作，由 ThreadFerry 校验后使用当前 Agent 自己的凭据执行。Owner 当前消息明确要求安全写入时直接
执行，其他成员的请求再交 Owner 确认：

```text
你（Owner）：@机器人 创建会议，明天上午十点复盘刚才的测试，邀请张三和李四
机器人：已自动执行：

  动作：创建会议
  标题：刚才的测试复盘
  时间：2026-08-21 10:00:00 → 2026-08-21 10:30:00
  参与人：张三、李四（创建时主动邀请）
```

要点：

- **只有白名单里的动作能执行**。当前支持：

  | 领域 | 动作 |
  | --- | --- |
  | 日程 | `schedule.search`、`schedule.free`、`schedule.create`、`schedule.update`、`schedule.cancel` |
  | 会议 | `meeting.search`、`meeting.create`、`meeting.update`、`meeting.cancel` |
  | 待办 | `todo.list`、`todo.create`、`todo.update`、`todo.finish`、`todo.delete` |
  | 邮件 | `mail.search`、`mail.send` |
  | 文档与微盘 | `doc.search`、`doc.create`、`disk.search` |

- 企业数据查询及邮件、文档、微盘操作只在 **Owner 私聊**中执行，不把个人数据或邮件正文发进群里。
- **Owner 的明确创建或修改指令就是授权**，包括在信息确认后回复“创建，没问题”；其他成员发起的
  普通写入仍需 Owner 私聊发送一次性确认码。取消、删除、完成整个待办和发送邮件始终要求一枚新的
  确认码。确认码 10 分钟过期且只存在内存里。
- 群历史仍然是不可信输入：自动执行还会检查 Owner 当前消息里是否明确要求了对应操作，
  Runtime 或历史消息不能替 Owner 授权。
- 参与人按姓名或 `id:<userid>` 经通讯录解析，并随会议创建请求主动邀请。信息不全时 Agent 会先
  问清楚，不会臆造时间或人员。
- 查询结果会直接整理成会议号、链接、时间和资源 ID；修改、取消、完成或删除时必须使用查询得到的
  真实 ID，不能猜。
- 真实写入前会先执行官方 CLI 的 `--dry-run` 本地校验。

官方 CLI 还提供附件上传/下载、文档和表格内容覆盖、智能表格结构与记录修改、通用主动消息等能力。
这些操作会跨越本地文件边界或大面积改写企业数据，当前没有放进白名单；需要先补资源级授权和明确的
文件范围，不能只因为 CLI 能调用就交给 Agent。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `threadferry doctor` | 检查配置、依赖和授权 |
| `threadferry start` | 启动所有已授权 Agent 的连接和管理台 |
| `threadferry start --agents a,b` | 只启动指定 Agent |
| `threadferry agent list` | 查看 Agent 及其机器人授权状态 |
| `threadferry agent login <名称>` | 为该 Agent 授权企业微信机器人 |
| `threadferry status` | 查看队列、Session 和最近失败 |
| `threadferry update` | 立即检查并安装最新版本 |
| `threadferry setup [--workspace <绝对路径>]` | 通过本机确认的私聊配对或更换 Owner（已有配置时可省略 `--workspace`，沿用该 Agent 配置） |
| `threadferry session reset --group <群ID>` | 重置指定群的 Runtime Session |
| `threadferry start --mock` | 运行无真实凭据的 Mock 链路 |

管理台默认监听 `127.0.0.1:17638`。修改端口：

```sh
threadferry start --admin-port 18080
```

## 本地数据

- 配置：`~/.threadferry/threadferry.yaml`
- 状态：`~/.threadferry/state-v3.json`
- 配置示例：[threadferry.example.yaml](./threadferry.example.yaml)

正常使用不需要手工配置环境变量。`wecom-cli auth init` 按官方机制加密保存自身凭据，ThreadFerry
只在建立连接时读取，不会把凭据写入配置、日志或状态文件，也不会提示你输入 Bot ID / Secret。

## 安全边界

- 私聊中只有**该 Agent 自己的 Owner** 的消息会启动 Runtime；群聊中只有当前 `@机器人` 的消息是用户指令。历史消息、引用和附件元数据都是不可信背景。
- **Agent 之间相互隔离**：A 的机器人收到 B 的群消息会被拒绝，A 的 Owner 也不能私聊 B 的 Agent。
- 未配置群、未授权用户和未 `@机器人` 的消息不会启动 Runtime；开启全员可用（`allow_all`）的群把“未授权用户”放宽为该群全体成员，其余限制不变。
- **ThreadFerry 不经手 Bot Secret**：不提示输入、不写入配置文件、不写入环境变量。凭据由官方 `wecom-cli` 在各 Agent 自己的目录里加密保存，ThreadFerry 只在建立连接时读取。
- 每个 Agent 的所有企业微信调用都使用它自己的凭据目录，不会串到别的机器人身上。
- Runtime 固定在 Agent Workspace，不能读取 Workspace 外文件。
- Codex 禁用网络和写文件；Pi 只开放受路径守卫保护的 `read` 和 `ls`。
- Agent Runtime 不允许提交、推送、删除、部署或其他写操作；自动更新只会从官方 GitHub Release 替换全局安装的 ThreadFerry 包。
- 附件只使用元数据，不下载内容，也不做 OCR。

## 排查问题

先运行：

```sh
threadferry status
threadferry doctor
```

- 私聊被回「只有机器人创建者（ThreadFerry Owner）可以…」：多半是换了企业或重建了机器人，回调 userid 变了。重启 `threadferry start`，按提示把该 Agent 的 Owner 更新为当前授权用户；或私聊发送 `threadferry whoami` 拿到 userid 后执行 `threadferry setup`。
- 启动时报「跳过 Agent X：没有机器人凭据」：执行 `threadferry agent login X` 完成授权。
- `unauthorized_user`：让 Owner 私聊机器人执行 `threadferry add <群名> <姓名>`。
- `unauthorized_group`：让 Owner 私聊机器人执行 `threadferry bind <群名或ID> <Agent名>`，或通过管理台绑定群。
- 缺少 `wecom-cli` 或版本过低：重新运行安装器，或执行 `npm install --global @wecom/cli`。
- `wecom-cli` 授权失效：重新运行 `wecom-cli auth init`，然后重启 ThreadFerry。

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

推送与 `package.json` 版本一致的 `v*.*.*` 标签后，GitHub Actions 会执行检查、生成预编译包和 SHA-256 校验文件，并创建 GitHub Release。

真实企业微信验收步骤见 [POC.md](./POC.md)，提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
