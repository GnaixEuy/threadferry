# ThreadFerry 多机器人改造计划

> 本文件是这项改造的**唯一进度源**。每完成一个阶段就更新「进度」表和该阶段的勾选项。
> 换人/换 agent 接手时，先读「接手指南」。

## 进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 0.15.0 不单独发版，内容并入 `Unreleased`；版本号回退到 0.14.1 | ✅ 完成 |
| 1a | **磁盘格式** v6；v5 兼容层已删除 | ✅ 完成 |
| 1b | **内存结构**：Owner 下沉到 Agent（过渡期保留顶层 `ownerUser`） | ✅ 完成 |
| 1c | 群下沉到 Agent 内存结构 | ⬜ 主动放弃（见下方说明） |
| 2 | 凭据按 agent 隔离（per-agent `WECOM_CLI_CONFIG_DIR`）+ 授权 CLI | ✅ 完成 |
| 3 | 所有 wecom-cli 调用按 agent 注入凭据目录 | ✅ 完成 |
| 4 | N 条连接并发运行 + 入站路由 + 进程内作用域隔离 | ✅ 完成（**待双机器人真机验证**） |
| 5 | Owner 与授权按 agent；私聊直达该 agent | ✅ 完成（由单 Agent 视图达成） |
| 6 | 管理台、文档、发版 | 🟡 代码与文档已完成；**待授权提交发版** |

状态图例：⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ⛔ 阻塞　　当前测试：**64/64 通过**

---

## 目标

**ThreadFerry = larkin 的企业微信版。** 一个 agent 对应一个企业微信机器人，**严格 1:1**，
agent 之间完全独立。多条连接并发跑在一个 ThreadFerry 进程里。

参考实现 [eddiearc/larkin](https://github.com/eddiearc/larkin)：`feishuAppId = feishuProfile = agentId`
——**机器人身份就是 agent 身份，没有中间层**。

「独立」的含义（这是本次改造的验收标准）：

| 每个 agent 自带 | 说明 |
| --- | --- |
| 机器人凭据 | 独立 `WECOM_CLI_CONFIG_DIR`，各自 `wecom-cli auth init` |
| Owner | 换企业后回调 userid 不同，owner 必须跟着 agent 走 |
| 群与授权名单 | 群归属 agent，不再是全局表 |
| Workspace / Runtime / 模型 | 现状已支持 |
| Session 与运行状态 | 进程内作用域必须带 agentId，见 D6 |

加一个 agent 就是加一个机器人，删一个 agent 不影响其他任何 agent。

## 非目标

- 不做跨 agent 的会话/上下文共享。
- 不做 agent 之间的消息转发或编排。
- 不自己存储机器人 Secret（见 D1）。
- 不解决 errcode 853006。与本改造正交，见「与 853006 的关系」。

---

## 设计修正记录

**2026-08-19（四）：恢复中文/空格 Agent 名 —— 目录安全不等于 ASCII。**

此前按 D2/D3 把 Agent 名收紧为 `^[A-Za-z0-9_-]{1,64}$`，理由是 agentId 要拼进凭据目录路径。
产品负责人确认：**目录安全只需要挡住路径穿越**，中文和空格都是合法目录名（v5 即支持，管理台表单也一直
允许）。改为白名单改为黑名单：允许任意字符（含中文/空格，最多 128 字符），仅拒绝空、`.`/`..`、
路径分隔符、控制字符和超长。同时去掉 v5/v6 的兼容提示文案（破坏性改动已获授权，不需要迁移引导）。

- [x] `validateAgentId` 改为黑名单校验，`config.ts` 的 version 报错不再提示重跑 setup
- [x] 相关测试同步翻转：中文/空格名从「拒绝」改为「接受」，仅路径穿越/分隔符/超长仍拒绝

**2026-08-19（三）：不再做向后兼容 —— 删掉全部兼容层。**

产品负责人确认现在是**内部测试阶段，破坏性改动完全可接受**。为兼容而留的复杂度全部删除：

| 删掉的东西 | 原因 | 收益 |
| --- | --- | --- |
| `readV5Document` / v5 自动升级 | 不需要兼容旧配置 | `loadConfig` 只有一条路径 |
| `default` Agent 复用 `~/.config/wecom` | 不需要免重新授权 | 凭据目录规则统一无特例 |
| `THREADFERRY_WECOM_BOT_ID/SECRET` 环境变量 | 一组环境变量无法服务 N 个机器人 | **Secret 彻底离开环境变量** |
| `botCredentials()` 交互式输入 Bot ID/Secret | 凭据由 `agent login` 交给 wecom-cli | **ThreadFerry 不再提示输入 Secret** |
| `hiddenQuestion` / `validateCredential` | 上一条的配套设施 | 少一套 raw-mode 终端处理 |
| `isAgentIdUsableAsBot` / `incompatibleName` | Agent 名现在一律是合法目录名 | 少一个状态分支 |

**安全收益不只是简化**：ThreadFerry 现在完全不经手 Bot Secret——不提示输入、不写环境变量，
只在建立连接时从 wecom-cli 的加密存储读一次。

**发现的更好机制（改了 Phase 3 的做法）**：`fetchWecomHistory` / `listWecomGroups` /
`searchWecomUsers` / `sendWecomReply` / `fetchWecomIdentity` **本来就都接受可注入的 runner**。
所以 Phase 3 不需要给每个函数加 context 参数，只要给每个 Agent 造一个绑定自己 config dir 的
`wecomRunner(configDir)` 传进去。签名零改动。

**2026-08-19（二）：Phase 1 拆成 1a / 1b —— 依赖顺序修正。**

原计划把「配置模型 v6」整块放在 Phase 1，排在 Phase 4/5 之前。这是错的：
内存结构一改成 per-agent owner，**每个 owner 检查都需要 agent 上下文，而私聊路径现在
根本没有 agent 上下文**（那正是 Phase 4 要建立的）。硬改就得先造一个临时的
"取唯一 agent"，等 Phase 4 再删掉，是白做的工。

现有耦合规模：`config.groups` / `config.ownerUser` 共 56 处引用
（`app.ts` 21、`admin.ts` 18、`cli.ts` 16、`config.ts` 4、`authorization.ts` 1），
外加十几个测试 fixture。

改为 expand-contract 两步：

- **Phase 1a**：磁盘格式换成 v6（`loadConfig` 同时接受 v5/v6，`configText` 输出 v6），
  **内存结构保持现状**（顶层 `ownerUser` + 带 `agent` 字段的扁平 `groups`）。
  下游 56 处引用零改动，可独立测试。
- **Phase 1b**：内存结构换成 per-agent，与 Phase 4/5 合并做——那时运行时已经知道
  每条消息属于哪个 agent，56 处引用才有正确的上下文可用。

**2026-08-19（一）：D2 从「`bots` 独立成段，允许一个机器人挂多个 agent」改为「严格 1:1」。**

原方案为了兼容 ThreadFerry 已发布的"一个机器人 + 多 agent 按群绑定"而保留了 N:1，
并为私聊歧义引入 `direct_agent` 消歧。产品负责人确认**那个模型本身就是走偏的**，
不需要为它做兼容。

严格 1:1 带来的简化（接手时不要往回退）：

- 不需要 `bots` 配置段，也不需要 `direct_agent`
- 私聊路由天然无歧义：消息从哪个机器人进来就归哪个 agent
- `processDirect` 里写死的 `Object.entries(config.agents)[0]` 自动消失
- owner / 群 / 凭据全部下沉到 agent，agent 成为唯一的隔离单元

---

## 已验证的事实

接手时**不需要重新验证这些**，都是本机实测或读源码确认的结论。

### larkin 的做法（读源码确认）

- `HydratedAgent` 带 `feishuAppId` / `feishuAppSecret` / `feishuProfile` / `larkConfigDir`，
  且 `feishuAppId === feishuProfile === agentId`（`src/platform/config.ts` 约 224 行）。
- `agents.filter(a => a.feishuProfile)` → 每个都 `createLarkChannel({appId, appSecret, domain})`
  （`src/feishu/host-shell.ts` 约 869 行起）。**没有 profile 的 agent 直接不启动入站**。
- `channelOwners: Map<LarkChannel, ConfiguredAgent>` 把入站事件路由回对应 agent。
- `larkin start --agents a,b,c` 选择跑哪些，默认全跑（`selectedAgentIds`，`src/app/run.ts`）。
- 没有全局的"群→agent"表。per-chat 设置挂在 agent 上（`chatMentionPolicies`）。
- 配套有断线重连、枯竭检测（drought maintenance）、有界断开——这部分是真复杂度。

### 企业微信侧可行性

- **`wecom-cli` 没有 profile 概念**：`auth init` 无 profile/name/account 参数，
  `auth show` 只返回单个 Bot ID，凭据文件是单对象 `{bot:{id,secret}}`。
- **但 `wecom-cli` 认 `WECOM_CLI_CONFIG_DIR`**。实测：
  ```
  WECOM_CLI_CONFIG_DIR=<空目录> wecom-cli auth show  →  Status: unauthorized
  ```
  这是整个方案的地基：每个 agent 一个 config dir，各自 `wecom-cli auth init`。
- `@wecom/aibot-node-sdk` 的 `WSClient extends EventEmitter`，构造参数带 botId/secret，
  `.d.ts` 里没有单例/静态状态，多实例应该可行。
  **⚠️ 唯一未实测项**：只有一个机器人时无法验证两条连接并发。Phase 4 必须实测。
- `wecom-cli identity whoami` 能给出当前 config dir 下的机器人名和授权真人 userid
  （见 `src/identity.ts`）——这是 per-agent owner 自动核对的数据来源。

### ThreadFerry 现状

- 配置严格 `version: 5`，根字段白名单 `[version, owner_user, agents, groups]`，
  agent 白名单 `[runtime, workspace, model]`，群白名单 `[agent, allow_users, allow_all]`。
- 单机器人：`botCredentials()` 返回一对 `{botId, secret}`，只存进程 env，不落盘。
- `startWecomChannel(credentials, handler)` 只调一次。
- **8 处 `wecom-cli` 调用点**都用默认 config dir，Phase 3 要全部改造：
  - `src/identity.ts` — `identity whoami`
  - `src/channels/wecom.ts` ×3 — `message aibot sessions list` / `contact users search` / `message aibot send`
  - `src/history/wecom-cli.ts` — `chat messages list`
  - `src/cli.ts` ×3 — `auth show`、`--version`、`identity whoami`（前两个与 bot 无关，第三个要）
- `runCommand` 已支持 `env` 选项（`src/types.ts`），所以注入是机械改造。
- **版本号临时停在 0.14.1**（最后一个已发布版本），新变更累积在 `CHANGELOG.md` 的
  `Unreleased`，发版版本号在 Phase 6 定。这是对 `AGENTS.md` 「每次改代码同步升版本」的
  临时例外，已写进 `AGENTS.md`。
- **进程内作用域键不带 agentId**（见 D6，这是正确性问题不是洁癖）：
  - `src/app.ts` 的 `serial(groupId)`、`groupTails`、`controllers`、`cancel(groupId)`
  - 私聊作用域是 `direct:${senderId}`
  - `src/state.ts` 的 `clearSession(groupId)` 只按 groupId
  - `state.session(groupId, scope)` 的 `scope` 已含 agentId，**这一处是安全的**

---

## 设计决策

### D1：凭据存哪 — per-agent `WECOM_CLI_CONFIG_DIR`（已定，不可逆）

每个 agent 一个目录，默认 `~/.threadferry/wecom/<agentId>`，用户在该目录下跑
`wecom-cli auth init`。ThreadFerry 通过 `loadWecomCliCredentials(dir)` 读取。

**配置文件里只存目录，绝不存 Secret。** 保持现有安全姿态（"机器人凭据仅用于当前进程，
不写入配置或日志"）——凭据仍然待在 wecom-cli 的加密存储里。

名为 `default` 的 agent 沿用 `~/.config/wecom`，让现有单机器人安装升级后不必重新授权。

拒绝的方案：每个 agent 一组环境变量（启动要交互 N 次）；ThreadFerry 自己加密存储
（破坏姿态，且要自担密钥管理）。

### D2：agent 就是隔离单元，严格 1:1（已定，见「设计修正记录」）

```yaml
version: 6
agents:
  frontend:
    runtime: codex
    workspace: /path/to/frontend
    model: provider/model            # 可选
    owner_user: woEOL-DAAA3v1vZRgd…  # 该 agent 的 Owner（= 该机器人下的回调 userid）
    config_dir: /custom/path         # 可选；默认 ~/.threadferry/wecom/<agentId>
    groups:                          # 该 agent 的群，不再是全局表
      wrXXXXXXXX:
        allow_users: [woEOL-…]
        allow_all: true              # 可选
  backend:
    runtime: pi
    workspace: /path/to/backend
    owner_user: wowBknbgAAEjKsK21V…  # 另一个企业，userid 不同
    groups: {}
```

顶层没有 `owner_user`，没有 `groups`，没有 `bots`。**agent 是唯一的隔离单元。**

`agentId` 同时是凭据目录名，所以受 `^[A-Za-z0-9_-]{1,64}$` 约束（挡路径穿越）。
⚠️ **这会收紧现有约束**：v5 的 agent 名支持中文和空格（README 明确写了）。
迁移策略见 D3。

### D3：v5 → v6 迁移

v5 是"单机器人 + 全局 owner + 全局群表"。升级映射：

```
v5: owner_user: X
    agents: { a: {...}, b: {...} }
    groups: { g1: {agent: a, allow_users: [...]}, g2: {agent: b, ...} }
 ↓
v6: agents:
      a: { ..., owner_user: X, groups: { g1: {allow_users: [...]} } }
      b: { ..., owner_user: X, groups: { g2: {...} } }
```

- 每个 agent 继承 v5 的全局 owner（同一企业下 userid 相同，正确）
- 群按 v5 的 `agent` 字段归位
- **只有一个 agent 能继续用 `~/.config/wecom` 的现有凭据**。选择规则：名为 `default` 的
  agent，若无则第一个。其余 agent 标记为未授权，启动时报告并跳过（对齐 larkin 的
  `agents.filter(a => a.feishuProfile)`），提示 `wecom-cli auth init` 的具体命令。
- **agent 名不合 `^[A-Za-z0-9_-]{1,64}$` 时**（中文/空格）：不静默改名。`loadConfig` 明确报错，
  给出建议的新名字和 `threadferry agent rename` 命令。宁可让用户显式改名，
  也不要偷偷动他的 workspace 绑定。

在内存里升级，不强制改写磁盘；写盘时（`configText`）统一输出 v6。

### D4：Owner 按 agent

`config.ownerUser` → `config.agents[id].ownerUser`。所有 owner 判断都要带 agent 上下文：
`authorize()`、`handleDirect()` 两处、`adoptOwner()`、`confirmOwnerIdentity()`（逐 agent 跑
各自 config dir 的 whoami）。

工作树里那份未发布的 `identity.ts` 和 `adoptOwner` 正是这块的地基，方向一致，不是白做。
只需把「全局单 Owner」换成「按 agent 取 owner」。

### D5：入站路由

每个 agent 一条 `startWecomChannel`。回调闭包直接捕获所属 agent，所以路由是**结构性**的，
不需要查表——这是严格 1:1 最大的红利。

- 群消息：该 agent 的 `groups[groupId]`；不在自己的 groups 里就是 `unauthorized_group`
- 私聊：直接就是这个 agent，无歧义

同一个群里可以有多个机器人，各自独立处理，互不知情。这是特性不是 bug。

### D6：进程内作用域必须带 agentId（正确性）

严格 1:1 之后，同一个 groupId 可能同时属于两个 agent（两个机器人都在那个群），
同一个 senderId 也可能同时私聊两个 agent（同企业下 userid 相同）。以下键**必须**加 agentId
前缀，否则会跨 agent 串扰：

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `app.ts` `serial()` / `groupTails` | `groupId` | `${agentId}\0${groupId}` |
| `app.ts` `controllers` / `cancel()` | `groupId` | 同上 |
| `app.ts` 私聊作用域 | `direct:${senderId}` | `direct:${agentId}:${senderId}` |
| `state.clearSession()` | `groupId` | 需带 agentId |
| `state.session(groupId, scope)` | scope 已含 agentId | **已安全，不用改** |

不改的后果：A agent 在群里跑任务会阻塞 B agent 的同群任务；`cancel` 会误杀；
`clearSession` 会清掉别的 agent 的 session。**Phase 4 必须有测试覆盖跨 agent 不串扰。**

---

## 阶段任务

### Phase 0 — 0.15.0 的归属（✅ 完成）

产品负责人决定 **0.15.0 不单独发版**，内容随多机器人改造一起发。已做的账务处理：

- [x] `CHANGELOG.md` 的 `0.15.0` 章节改为 `Unreleased`，并注明其 Owner 模型是「全局单 Owner」、
      将被 Phase 5 重构为 per-agent
- [x] `package.json` / `package-lock.json` / `src/cli.ts` 版本号**回退到 0.14.1**（最后一个
      已发布版本），避免工作树声称一个不存在的发布
- [x] 从两份 README 删掉描述未发布行为的段落；排查条目改成当前真实可用的办法
      （`threadferry whoami` + `threadferry setup`）
- [x] 两份 README 顶部加横幅：声明目标架构是 1:1、当前实现仍是按群绑定、指向本计划。
      **项目尚未对外公布**，README 可自由改，但正文命令必须按当前实现写，
      不能描述还不存在的功能
- [x] `AGENTS.md` 增「当前进行中的改造」段，声明版本号临时约定与哪些文档不可当架构依据
- [x] `POC.md` 加状态横幅，标明 `bind` / `use` 群绑定流程属于待替换模型

**代码保留**：`src/identity.ts`、`adoptOwner`、`confirmOwnerIdentity` 都是本改造的地基，
不回退。Phase 1/5 会把它们改成 per-agent。

### Phase 2 补充 — 修掉自己引入的回归（✅ 完成）

Phase 2 的 `botConfigDir` 对不合 `^[A-Za-z0-9_-]{1,64}$` 的名字抛错，导致
**`threadferry agent list` 对中文 Agent 名直接崩**。而 v5 起 Agent 名允许中文和空格，
README 明确记为特性。

- [x] `isAgentIdUsableAsBot(name)`：不抛错的判定
- [x] `botStatus` 对不兼容名称返回 `{ authorized: false, incompatibleName: true }`，
      **不碰文件系统、不暴露目录**，而不是抛错
- [x] `authorizeHint` 对这类名称给出"当前单机器人模式下仍可用；改用多机器人前需要改名"，
      而不是一条跑不通的 `auth init` 命令
- [x] `agent list` 第 5 列显示「名称不兼容」；不对它输出 `agent login` 提示
- [x] `agent login <中文名>` 明确拒绝并指向改名
- [x] 测试：`bots.test.ts` 覆盖中文/空格/空名三种，断言不抛错且不泄露目录；
      `install.test.ts` 覆盖 `agent list` 对中文名返回 0 且不崩

**结论对 D3 的影响**：改名不是"迁移时顺手做"，而是**用户改用多机器人前的显式前置动作**。
在此之前中文名 Agent 在单机器人模式下继续可用，不强制改名。

### Phase 1a — 磁盘格式 v6（✅ 完成）

只改磁盘格式，**内存结构不动**，下游 56 处引用零改动。

- [x] `configText` 输出 v6：每个 agent 带 `owner_user`、可选 `config_dir`，群移进各自
      agent 的 `groups`；顶层不再有 `owner_user` 和 `groups`
- [x] `loadConfig` 按 `version` 分派 `readV5Document` / `readV6Document`，两者只做各自版本
      的结构校验与字段白名单，**摊平成同一个中间形态后共用一套语义校验**
      （workspace 解析、userid 格式、allow_users 不变式）——没有重复校验逻辑
- [x] `AgentConfig` 增补 `configDir?`（additive，下游无感）；`ThreadFerryConfig.version` → 6
- [x] `setupConfig` 不再自己拼 YAML，改为委托 `configText`，消掉第二个序列化实现
- [x] `configText` 增加守卫：群引用不存在的 Agent 时抛错，而不是静默丢群
- [x] 8 个内存 fixture `version: 5` → `6`；`install.test.ts` 里两个 **YAML 字符串保持 v5**，
      正好当 v5 升级路径的回归测试
- [x] 往返测试：v5 读入 → 写出 v6 → 再读回，`assert.deepEqual` 语义不变；`config_dir` 保留
- [x] 拒绝运行时无法正确处理的 v6 形状（7 条）：同群挂两个 Agent、Agent 间 owner 不一致、
      缺 owner_user、config_dir 非绝对路径、顶层残留 owner_user、群内残留 agent 字段、
      群授权名单不含 owner
- [x] ~~没有收紧 agent 名~~ → **已收紧**：不做兼容后，`validateAgent` 直接复用
      `validateAgentId`（`^[A-Za-z0-9_-]{1,64}$`），中文/空格/路径穿越/超长一律在加载配置时
      拒绝。`isAgentIdUsableAsBot` 与「名称不兼容」状态一并删除
- [x] 删掉 `readV5Document` 与 v5 自动升级；`loadConfig` 只接受 `version: 6`
- [x] 全部测试 fixture 转 v6；「中文名可用」那条测试语义反转为「必须被拒绝」

**关键决策 — 为什么拒绝 Agent 间 owner 不一致而不是接受**：v6 磁盘格式已经能表达
per-agent owner，但运行时（Phase 4/5 之前）还不能按 Agent 分发 Owner。与其静默取其中一个、
留一份运行时会误判的配置，不如**fail closed**：明确报错并说明「当前仍是单机器人模式」。
Phase 5 落地后删掉这条不变式即可。

**验证**：`npm run typecheck && npm test`（61/61）。真机 v5 → v6 输出：
```yaml
version: 6
agents:
  default:
    runtime: codex
    workspace: /Users/gnaixeuy/Desktop/ThreadFerry
    owner_user: woEOL-DAAA3v1vZRgdBWeNDz2brBQqOw
    groups: {}
```

### Phase 1b — Owner 下沉到 Agent（✅ 完成）

- [x] `AgentConfig` 增 `ownerUser: string`；新增 `AgentDefinition = Omit<AgentConfig, "ownerUser">`
      给「还不知道 Owner」的新建路径用
- [x] `loadConfig` 按 Agent 读 `owner_user` 并校验格式；**删掉「各 Agent Owner 必须一致」
      的不变式**——那本来就是过渡限制，现在跨企业不同 Owner 正是目标能力
- [x] 群的授权名单校验改为必须包含**所属 Agent 自己**的 Owner，不再是全局那一个
- [x] `configText` 写 `agent.ownerUser`
- [x] `adoptOwner(config, agentId, userId)` 按 Agent 迁移；只迁移该 Agent 的群
- [x] `pairConfig` 把配对者设为该 Agent 的 Owner；`addAgent` 继承主 Agent 的 Owner
      （新 Agent 机器人未授权，拿不到自己企业下的 userid；授权后由启动核对提示更正）
- [x] `confirmOwnerIdentity(config, agentId, updateConfig)` 用该 Agent 自己的凭据目录跑
      whoami，比对该 Agent 自己的 Owner
- [x] `RuntimeRequest` 改为继承 `Omit<AgentDefinition, "configDir">`——Runtime 不需要 Owner
      和凭据目录，不该把身份信息带进 Runtime 边界
- [x] 真机验证：两个 Agent 各自 Owner / 凭据目录 / Workspace / 群完全独立

**过渡期字段**：顶层 `config.ownerUser` 仍存在，等于**主 Agent**（`default`，否则第一个）
的 Owner。`admin.ts`（18 处）和 `cli.ts` 的旧路径还在读它。**权威来源是 `agents[id].ownerUser`。**
Phase 6 把管理台改成按 Agent 组织后删除这个字段。

### Phase 1c — 群下沉到 Agent 内存结构（⬜ 主动放弃）

内存里 `config.groups` 仍是扁平的（带 `agent` 字段），磁盘上已经是嵌套在 Agent 下的 v6。

**决定不做，理由**：运行时用的是**单 Agent 视图**，视图里的 `groups` 天生只含该 Agent 的群，
`app.ts` 因此完全不需要知道 agentId。如果把内存也改成嵌套，`app.ts` 每次访问群都要先取
「唯一那个 Agent」，反而变复杂。管理台需要的恰好是跨 Agent 的扁平视图。

**结论**：磁盘嵌套 + 内存扁平不是技术债，是两个消费者各取所需。除非将来出现新的消费者需要
嵌套内存结构，否则不要动。

- [ ] `src/types.ts`：`AgentConfig` 加 `ownerUser` / `configDir?` / `groups`；
      `GroupConfig` 去掉 `agent` 字段（已由归属表达）；`ThreadFerryConfig` 去掉顶层
      `ownerUser` 与 `groups`
- [ ] `src/config.ts`：`loadConfig` 接受 v5（内存升级，按 D3）与 v6；字段白名单更新；
      agent 名校验收紧并给出改名指引
- [ ] `configText` 输出 v6
- [ ] `pairConfig` / `addAgent` / `adoptOwner` 适配到 per-agent
- [ ] `threadferry agent rename <old> <new>`（D3 需要）
- [ ] 测试：v5→v6 升级（含群归位、owner 下沉、凭据目录归属）、v6 往返、
      非法配置被拒、中文 agent 名给出改名指引而不是静默改名

**验证**：`npm run typecheck && npm test` 全绿。既有测试大量构造 v5 配置，
需要同步更新 fixture——这是预期工作量，不是回归。

### Phase 2 — 凭据按 agent 隔离（✅ 完成）

`src/bots.ts` + `test/bots.test.ts` 已完成。**故意先做这一步**：全新文件，与工作树里
未提交的 0.15.0 零重叠。模块里的 `name` 参数即 agentId（严格 1:1 后两者同一）。

- [x] `botConfigDir(name, override?)`：`default` → `~/.config/wecom`（向后兼容）；
      其他 → `~/.threadferry/wecom/<name>`；override 必须是绝对路径
- [x] `validateBotName`：`^[A-Za-z0-9_-]{1,64}$`，挡路径穿越（`../escape`）和中文
- [x] `wecomEnv(configDir, base)`：只覆盖 `WECOM_CLI_CONFIG_DIR`，其余继承
- [x] `loadBotCredentials(name, override?, env?)`：按目录读 wecom-cli 加密存储；
      **只有 `default` 认 `THREADFERRY_WECOM_BOT_*` 环境变量**（否则多机器人下
      一组环境变量会被所有 agent 误用，等于串号）
- [x] `botStatus` / `authorizeHint`：授权状态与引导文案，不含 Secret
- [x] `src/bots.ts` 测试 5 条
- [x] 真机验证：`default` 读到真实 botId `aibS5gFrdrjbT-…`；`corp2` 正确报未授权
- [x] **没有新开 `threadferry bot` 命名空间**（1:1 之后 bot ≡ agent，另立一套命令等于造
      第二个概念）。全部挂到已有的 `threadferry agent` 下：
  - [x] `threadferry agent list` 增列机器人授权状态（第 5 列为 botId 或「未授权」），
        未授权的 agent 追加可执行的下一步提示
  - [x] `threadferry agent login <agentId>`：`mkdir -m 700` 建凭据目录后，以
        `stdio: "inherit"` + `wecomEnv(configDir)` 直连终端跑 `wecom-cli auth init`，
        结束后回读校验是否真的拿到凭据
- [x] 修掉实现 bug：`threadferry agent login --config x` 原会把 `--config` 当成 Agent 名
- [x] CLI 测试（`test/install.test.ts`）：用**临时 HOME 隔离**，避免读到本机真实凭据导致
      结果随机器变化；只给 `default` 造假凭据、`reviewer` 保持未授权，断言两行格式、
      引导只对未授权 agent 出现、输出不含 Secret；外加三条参数错误路径
- [ ] 术语对齐：`validateBotName` → `validateAgentName`，与 `config.ts` 的 agent 名校验
      合并成一处 ← **留到 Phase 1**（那时才会动 config.ts 的校验）

**为什么用 `stdio: "inherit"` 而不是 `runCommand`**：`wecom-cli auth init` 是扫码交互流程，
`runCommand` 会 pipe 并限流输出，交互走不通。这条直连也强化了安全叙事——**Secret 从终端
直接进 wecom-cli 的加密存储，ThreadFerry 全程不经手**。

**验证**：`npm run typecheck && npm test`（58/58）。真机 `agent list` 输出：
```
default	codex	default	/Users/gnaixeuy/Desktop/ThreadFerry	aibS5gFrdrjbT-Fluj16LwTkz9q49rDIoGL
```

### Phase 3 — wecom-cli 调用按 agent 注入（🟡）

**机制**：不给函数加 context 参数——那些封装本来就接受可注入的 runner，
所以只需 `wecomRunner(configDir)` 返回一个绑定了 `WECOM_CLI_CONFIG_DIR` 的 runner 传进去。

- [x] `wecomRunner(configDir)` 落地（`src/cli.ts`）
- [x] `doctor` 改为用**该 Agent 自己的凭据目录**查身份和群历史。原先用默认目录，
      在删掉 legacy 目录后会检查到别的机器人身上——这是必须修的正确性问题，不是精度问题
- [x] `doctor` 凭据检查改为逐 Agent 报告
- [x] `confirmOwnerIdentity` 用该 Agent 的 runner 跑 `identity whoami`
- [x] 运行时调用点全部改用所属 Agent 的 runner：`fetchWecomHistory` / `listWecomGroups` /
      `searchWecomUsers` / `sendWecomReply` / `fetchWecomIdentity`，**签名零改动**
- [x] 崩溃恢复补发也用**该群所属 Agent** 的 runner（用别的机器人会从错误身份发出去）

### Phase 4 — N 连接运行时 + 作用域隔离（⬜ ← **下一步**）

**关键实现思路（已验证可行）**：给每个 Agent 建一个**单 Agent 配置视图**
（`{version, ownerUser: 该 Agent 的 Owner, agents: {只有它}, groups: 只有它的群, security}`），
然后 `createApp(view, deps, state)` 每个 Agent 一个实例。

这样 `app.ts` 几乎不用改——它现在处理的就是「一个 config + 按群路由」，而单 Agent 视图
正好是那个形状。两个附带红利：

1. `processDirect` 里写死的 `Object.entries(config.agents)[0]` **由构造保证正确**，不用改
2. `serial` / `groupTails` / `controllers` 都在 `createApp` 闭包里，**天然按 Agent 隔离**，
   D6 里一半的串扰问题自动消失

- [x] `agentView` / `refreshAgentView`：单 Agent 配置视图，热更新时就地刷新；
      Agent 被删掉则视图清空，该 app 随即拒绝所有消息
- [x] `start()` 遍历有凭据的 agents，各起一条连接 + 一个 app 实例；无凭据的**逐个报出来**再跳过
- [x] 每个 app 的 deps 用该 Agent 的 `wecomRunner`
- [x] 入站路由是**结构性**的：回调闭包直接捕获自己的 app，不需要查表
- [x] 崩溃恢复按群所属 Agent 分流（补发 + replay 都用对应机器人）
- [x] 优雅关闭：断开全部连接、等全部 app 收尾
- [x] `threadferry start --agents a,b` 选择性启动；`--agents` 走参数传递而非读 `process.argv`
      （否则自动更新重启后会读错）
- [x] 未配置的 Agent 名给出准确报错（原先误报「没有凭据」）
- [ ] **实测两条真实连接并发**（唯一未验证项，必须做，不许用 mock 顶替）
- [x] 测试：跨 Agent 群隔离、Owner 隔离、私聊必定用本视图 Workspace、视图刷新与 Agent 删除、
      CLI 启动跳过报告与 `--agents` 三条路径

**D6 复盘 —— 一半问题自动消失**：`serial` / `groupTails` / `controllers` 都在 `createApp`
闭包里，每个 Agent 一个 app 实例后天然隔离，不需要给键加 agentId 前缀。
`state.session(groupId, scope)` 的 scope 本来就含 agentId。**剩余一处未处理**：
`state.clearSession(groupId)` 仍只按 groupId，两个机器人同在一个群时会清掉对方的 session。
已挪到 Phase 6。

**验证**：需要**两个真实企业微信机器人**。只有一个时先用 mock 覆盖逻辑，
并在本表标记「待真机验证」，**不要标 ✅**。

### Phase 5 — Owner 与授权按 agent（✅ 完成）

**没有写一行新的授权代码**——单 Agent 视图让原有逻辑自动变成按 Agent。
遗留的命令语义清理见 Phase 6：1:1 之后 `bind <群> <Agent>` / `use <群> <Agent>` 的 Agent
参数已无意义（你在跟哪个机器人说话就是哪个 Agent），应简化为 `bind <群>` 并删除 `use`。

- [x] `authorize()` 只看视图里的群，跨 Agent 的群天然 `unauthorized_group`
- [x] `handleDirect()` 的 owner 判断读 `view.ownerUser`，即该 Agent 自己的 Owner
- [x] `processDirect` 里写死的 `Object.entries(config.agents)[0]` **由构造保证正确**，未改一字
- [x] `confirmOwnerIdentity()` 逐 agent 核对
- [x] 测试覆盖跨 Agent 越权被拒（群与 Owner 两侧）

**验证**：这是安全边界，测试必须覆盖跨 agent 越权被拒。

### Phase 6 — 管理台、文档、发版（⬜）

- [x] **管理台 `listGroups` 改为按 Agent 查询**。原先聚合所有机器人可见的群，会允许把群绑给
      一台不在该群的机器人——结果是静默失效。现在绑定下拉只列出机器人确实在该群的 Agent，
      服务端也按目标 Agent 自己的机器人二次校验
- [x] Agent 卡片显示机器人授权状态 / Bot ID / 该 Agent 自己的 Owner；未授权给出 `agent login` 提示
- [x] 移除管理台「切换群 Agent」路由与私聊 `use` 命令；群卡片改为只读显示所属 Agent
- [x] 「不能移除 Owner」的判断改用**该群所属 Agent** 的 Owner
- [x] `bind <群>` 去掉 Agent 参数；新增 `resolveUnboundGroup`，机器人看不见该群时明确说明
- [x] `state.clearSession(groupId, scope?)` 支持按 Agent 作用域（D6 剩余项）；
      `sessionScope()` 抽成共享函数，`app.ts` 与重置路径共用一处构造避免漂移
- [x] 顶层 `config.ownerUser` 已从 `admin.ts` 完全清除（仅 `config.ts` 内部保留为派生字段）
- [x] 两份 README 正文按 1:1 重写（模型描述、快速开始、管理命令、管理 Agent、常用命令、
      安全边界、排查问题）；横幅改为「已完成但待双机器人实测」
- [x] `threadferry.example.yaml` 重写为 v6，并实测可被 `loadConfig` 加载
- [x] `POC.md` 第 3 节按多机器人重写：第 29-33 项覆盖双机器人授权、N 连接启动、
      跨 Agent 隔离、管理台按 Agent；第 35 项验证配置与环境变量里都没有 Bot Secret
- [x] 版本升到 **0.16.0**，`CHANGELOG.md` 整理出发布章节（破坏性变更置顶），
      `release-notes.mjs 0.16.0` 抽取正常
- [ ] 提交并发版 ← **需要用户明确授权（AGENTS.md）**
- [ ] Phase 1c 已主动放弃，见上方说明
- [ ] 概览页按 agent 分组
- [ ] `README.md` / `README.zh-CN.md`：**删掉顶部横幅**，正文按 1:1 重写
      （快速开始、管理群和用户、管理 Agent、常用命令都要改）
- [ ] `threadferry.example.yaml` 改成 v6 示例；`CHANGELOG.md` 撰写发布章节
- [ ] `POC.md`：按 1:1 重写验收清单，去掉状态横幅
- [ ] 版本 → 0.16.0（v5 自动升级，但 agent 名约束收紧，CHANGELOG 要显著说明）
- [ ] 发版按 `AGENTS.md`：新 `codex/` 分支 → PR → 合 main → Build → tag → Release 核验

---

## 与 853006 的关系

企业微信 `chat` 服务（会话消息读取）对本企业未开通，errcode 853006。据反馈可能是官方侧问题，
等他们 ready。

**本改造与之正交，不要等**：

- **私聊完全不依赖群历史**（`processDirect` 传空历史）。多机器人的第一大收益
  ——每个 agent 一个机器人、私聊直达——**853006 没解决也能立刻上线**。
- 群聊部分等 `chat` 能力开通后自动生效，不需要再改代码。
- 长期拿不到的话另有待决策项：群聊做**无历史降级**（只喂当前 @ 消息）。用户尚未拍板，
  不在本计划范围内。

---

## 接手指南

如果你是接手的 agent，按这个顺序：

1. **读 `AGENTS.md`**（本机文件，未提交）。硬性规则：
   - commit 用 Gitmoji 规范（见 `CONTRIBUTING.md`）
   - **禁止任何 Claude 署名**（commit trailer、author、tag）——见全局 `~/.claude/CLAUDE.md`
   - 每次改代码同步升版本（`package.json` / `package-lock.json` / `src/cli.ts` 三处一致）
     + 更新 `CHANGELOG.md`
   - **未经用户明确授权不得提交或推送**
2. **读「进度」表**，找第一个非 ✅ 的阶段。
3. **读「设计修正记录」**——不要把设计退回 N:1。
4. **读「已验证的事实」**，别重复那些实验（尤其 `WECOM_CLI_CONFIG_DIR` 那个）。
5. `git status`。工作树里有**未提交且不单独发版**的 0.15.0 内容（换企业 Owner 修复），
   已并入 `CHANGELOG.md` 的 `Unreleased`。不要为它单独发版。
6. 开工前跑基线：
   ```bash
   npm run typecheck && npm test
   ```
7. 每完成一个阶段：更新「进度」表 + 勾选任务 + 把新发现补进「已验证的事实」。

### 关键约束（别踩）

- **不要把 Secret 写进配置文件或日志**。这是产品的核心安全承诺。
- **不要把失败原因发到群里**。群回复只给错误编号；原因只进本机控制台
  （0.14.1 建立的边界，有测试守着）。
- **不要向非 Owner 回显配置里的 Owner**（信息泄露，有测试守着）。
- 群历史是**不可信输入**，永远不当指令。
- agent 名会拼进文件路径，**必须**校验，挡路径穿越。
- 每个阶段结束时 `npm test` 必须全绿，不许留红。
