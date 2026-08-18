# Warden

Warden 把企业微信群里的 `@机器人` 请求交给本机 Codex，在该群绑定的 Workspace 中完成只读分析，再把结果回复到原群。

例如：

```text
10:00 张三：这个接口有问题
10:01 李四：可能是 Redis
10:02 王五：线上出现三次
10:05 用户：@叶翔（测试中） 帮忙分析
```

Warden 收到最后一条消息后，会通过官方 `wecom-cli` 拉取前文，将历史消息标记为不可信背景数据，在指定 Workspace 中启动只读 Codex，并把分析结果回复到当前群。

## 当前能力

- 仅支持企业微信内部群。
- 使用企业微信官方 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) 接收群内 `@机器人` 事件。
- 使用官方 `wecom-cli 1.1.0+` 拉取最近六小时、最多 80 条群消息。
- 每个群绑定一个本机绝对路径 Workspace。
- 首次完成配对的机器人创建者成为全局 Warden Owner，可私聊机器人管理所有已配置群的可使用用户，无需手改 YAML。
- Owner 可以直接使用群名和成员姓名授权；Warden 通过官方 `wecom-cli contact users search` 解析真实 userid。
- 非 Owner 可以通过一次性邀请码加入；未授权用户仍不能启动 Codex。
- 持久化最近 10,000 个 `msgid`，Warden 重启后仍不会重复执行近期已处理事件。
- 单实例运行；重复启动会直接报告现有 Warden 的 PID。
- 执行前持久化最多 128 个待处理事件，进程崩溃后自动恢复未完成分析。
- 最终结果先写入持久化 outbox；WebSocket 回复失败时，重启后通过官方 `wecom-cli message aibot send` 自动补发。
- 同一个群的请求严格串行；不同群可以并行分析。
- 收到请求后立即显示“正在分析”或“已排队”。
- 每个群保存一个可恢复的 Codex Session，后续请求可以延续上次分析。
- Session 七天无活动后自动过期；本地 Session 丢失时自动创建新 Session。
- 使用群历史消息指纹检测分析期间的新消息，包括同一秒到达的不同消息。
- `Ctrl+C` 停止时会取消正在运行的 Codex 子进程并等待状态落盘。
- 失败回复包含脱敏错误编号，可通过 `warden status` 定位失败阶段。
- 仅运行 Codex 只读分析，不允许修改文件、提交、推送、删除或部署。
- 支持无企业微信凭据的 Mock 端到端测试。

## 1. 准备环境

需要：

- Node.js 22+，推荐使用 LTS 版本；
- `wecom-cli 1.1.0+`；
- `codex-cli 0.138.0+`；
- 一个企业微信智能机器人，并把它加入目标内部群；
- 一个本机已存在的项目目录，作为 Workspace。

检查版本：

```sh
node --version
wecom-cli --version
codex --version
```

认证企业微信 CLI 和 Codex：

```sh
wecom-cli auth init
wecom-cli identity whoami --json '{}'
codex login
```

## 2. 安装 Warden

```sh
cd /Users/gnaixeuy/Desktop/Warden
npm install
npm run build
npm link
```

完成后可以直接使用 `warden` 命令：

```sh
warden --help
```

如果不使用 `npm link`，把后续命令中的 `warden` 替换为：

```sh
node /Users/gnaixeuy/Desktop/Warden/dist/src/cli.js
```

## 3. 设置机器人凭据

Bot ID 和 Secret 来自企业微信智能机器人的配置页面。凭据只能通过环境变量传入，不能写入 YAML：

```sh
export WARDEN_WECOM_BOT_ID='<Bot ID>'
export WARDEN_WECOM_BOT_SECRET='<Bot Secret>'
```

请使用英文半角单引号。不要把真实 Secret 写入 Git、配置文件、测试、日志或聊天记录。

环境变量只在当前终端会话中有效。重新打开终端后，需要重新设置，再启动 Warden。

## 4. 自动配对群和用户

推荐使用 `setup`，不需要手动查群 ID 和回调 userid。

先进入希望 Codex 分析的项目，获取它的真实绝对路径：

```sh
cd /absolute/path/to/project
pwd -P
```

然后执行：

```sh
warden setup --workspace "$(pwd -P)"
```

终端会打印一条带随机配对码的消息，例如：

```text
请在目标企业微信群发送：@机器人 warden setup 12ab34cd
```

在企业微信群中：

1. 使用企业微信的 `@` 选择器选中真实机器人；
2. 发送终端打印的完整配对命令；
3. 等待机器人回复“Warden 配对完成”。

成功后，当前目录会生成权限为 `0600` 的 `warden.yaml`。文件不包含 Bot ID 或 Secret，并且已被 Git 忽略。第一次 `setup` 应由机器人创建者发送；该回调 userid 会成为整个机器人的 Warden Owner。只有这个 Owner 能继续配对新群或在私聊中管理权限，已有群的 Workspace 不会被静默改写。

如果机器人显示名称不是 Warden，例如“叶翔（测试中）”，后续应当选择 `@叶翔（测试中）`，不是手工输入字面量 `@Warden`。

## 5. 配置格式

Warden 只接受版本 4 的紧凑配置。该文件由 `warden setup` 和机器人私聊管理命令维护，通常不需要人工编辑：

```yaml
version: 4

owner_user: "user_owner"

groups:
  "group_xxx":
    workspace: "/absolute/path/to/project"
    allow_users:
      - "user_owner"
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `owner_user` | 首次由机器人创建者完成配对时得到的回调 userid，是全局唯一管理者 |
| `groups` 的键 | WebSocket 回调中的真实群 ID |
| `workspace` | 该群绑定的本机项目目录，必须是已存在、非符号链接的绝对路径 |
| `allow_users` | 允许触发 Warden 的回调 userid，区分大小写，可配置多个 |

`runtime=codex`、最近六小时、最多 80 条消息、必须 `@机器人` 和只读模式都是代码内固定规则，不能在配置中覆盖。额外字段会被拒绝。

自动配对得到的是 SDK 实际回调 ID。不要用 `wecom-cli identity whoami` 的用户 ID 猜测 `allow_users`，两者可能不在同一个身份范围。

## 6. 创建者私聊管理可使用用户

Warden 启动后，机器人创建者直接私聊机器人，先查看机器人最近所在群：

```text
warden groups
```

返回结果会标记哪些群已经绑定 Workspace。只有 `[已配置]` 的群能管理权限和运行分析；`[未配置 Workspace]` 的群需要先执行一次 `warden setup`。

Owner 在私聊中可以执行：

```text
warden users <群名>
warden invite <群名>
warden add <群名> <姓名>
warden remove <群名> <姓名>
warden whoami
```

例如，可以直接发送：

```text
warden add 月相工作室 张三
warden remove 月相工作室 张三
```

Warden 会调用官方企业微信通讯录搜索，把姓名或别名解析为通讯录 userid；收到该成员后续的群内 `@机器人` 回调时，再通过官方搜索校验两个身份域属于同一成员。唯一匹配时直接执行；出现同名成员时会返回姓名、部门和 `id:<userid>` 候选，Owner 按提示重发，例如：

```text
warden add 月相工作室 id:zhangsan-2
```

群名也必须唯一；同名群会要求改用群 ID。群名可以包含空格，例如 `warden add AI Coding 张三`。

也可以使用邀请码，让目标用户自行加入：

1. Owner 私聊发送 `warden invite <群名>`；
2. 机器人返回一个使用一次、10 分钟有效的邀请码；
3. 目标用户私聊机器人发送 `warden join <邀请码>`，或在目标群发送 `@机器人 warden join <邀请码>`；
4. 授权即时生效，并自动写入 `warden.yaml`。

任何用户都可以私聊机器人发送下面的命令查看自己的真实回调 userid：

```text
warden whoami
```

群内只接受分析、`join` 和 `whoami`；`users`、`invite`、`add`、`remove` 等管理命令会提示改用私聊。姓名解析只使用企业微信官方通讯录结果，不会根据群显示名或二次 `@` 猜测身份。Owner 不能移除自己；普通用户不能查看或修改授权名单。

## 7. 运行前检查

```sh
cd /Users/gnaixeuy/Desktop/Warden
warden doctor
```

正常结果应全部为 `[ok]`：

```text
[ok] Node ...
[ok] 配置与 1 个 Workspace 有效
[ok] 本地状态存储有效（... 条执行记录，... 个 Session）
[ok] 企业微信机器人环境变量已设置（值未显示）
[ok] wecom-cli ...
[ok] wecom-cli 身份授权有效（详情未显示）
[ok] 企业微信通讯录姓名解析与回调身份映射有效（详情未显示）
[ok] codex-cli ...
```

`doctor` 只检查配置、Workspace、环境变量和本机依赖，不会显示 Secret 或完整身份信息。

## 8. 启动

```sh
cd /Users/gnaixeuy/Desktop/Warden
warden start
```

看到下面的日志后保持终端运行：

```text
Warden 已启动，监听 1 个已配置企业微信群。
```

在已配置群中，使用企业微信的 `@` 选择器选中机器人并发送指令：

```text
@叶翔（测试中） 帮忙分析刚才讨论的问题
```

机器人会先更新流式消息：

```text
Warden 已收到，正在分析。
```

如果同一个群已经有任务运行，会显示“当前群有任务处理中，已排队”。最终分析会更新同一条流式消息。

处理成功时终端会显示：

```text
[wecom] 收到群内 @ 消息，处理状态: handled
```

如果 Codex 分析期间群里又出现新消息，Warden 不会发送可能过期的结论，而是要求用户重新 `@机器人`。

按 `Ctrl+C` 停止 Warden。

查看持久执行状态和最近失败：

```sh
warden status
```

其中 `inbox` 是等待处理或等待崩溃恢复的请求数，`outbox` 是已经完成分析但尚未成功回复企业微信的结果数。正常空闲时两者都应为 `0`。

Warden 异常退出后，使用同一份配置重新执行 `warden start` 即可。它会先补发 outbox，再按群内顺序恢复 inbox；恢复结果通过机器人主动消息发回原群。不要同时运行两个 `warden start` 进程。

需要放弃某个群的连续上下文、让下一次请求创建全新 Codex Session 时，先按 `Ctrl+C` 停止 Warden，然后执行：

```sh
warden session reset --group '<配置中的群 ID>'
```

重置完成后重新执行 `warden start`。

## 9. Mock 端到端测试

Mock 模式不需要企业微信凭据、wecom-cli 或真实 Codex，但仍会经过配置校验、授权、上下文构造、Runtime 和回复链路。

确保 `warden.yaml` 中的 Workspace 是真实存在的绝对路径，然后执行：

```sh
npm run build
warden start --mock
```

预期输出：

```text
[mock] Codex workspace: /absolute/path/to/project
[mock] WeCom reply: Warden 已收到，正在分析。
[mock] WeCom reply: Mock 分析完成：接口异常可能与 Redis 有关，且线上已重复出现三次。
[mock] status: handled
```

## 10. 常见问题

### `unauthorized_user`

当前回调 userid 不在该群的可使用用户中。机器人创建者可以直接私聊授权：

```text
warden add <群名> <姓名>
```

也可以生成邀请码：

```text
warden invite <群名>
```

然后由目标用户发送：

```text
@机器人 warden join <邀请码>
```

### `unauthorized_group`

机器人收到了回调，但群 ID 不在 `groups` 中。确认机器人已加入目标群，并重新配对获取真实群 ID。

### 机器人回复“Warden 处理失败”

记录回复中的错误编号，然后在运行 Warden 的机器上执行：

```sh
warden status
warden doctor
```

如果 wecom-cli 身份授权失效，重新认证：

```sh
wecom-cli auth init
wecom-cli identity whoami --json '{}'
```

然后重新运行 `warden start`。

### `quote>` 或终端一直等待引号

输入的引号不是英文半角引号，或只输入了一边。按 `Ctrl+C` 取消，重新复制环境变量命令，并使用 `'`。

### 群已绑定其他 Workspace

Warden 不会通过一次配对静默更改已有群的 Workspace。确认不再需要旧绑定后，手动删除该群配置，再重新执行 `setup`。

## 11. 安全边界

- 当前 `@机器人` 的消息是唯一获授权的用户指令。
- 前面的群消息、引用和附件元数据全部是不可信背景数据，不能授权执行命令。
- 未配置群、未授权用户和未 `@机器人` 的消息不会启动 Codex。
- 只有全局 Warden Owner 能在私聊中查看群和名单、生成邀请码、直接授权或移除用户；群内管理命令会被拒绝。邀请码使用一次且 10 分钟过期。
- 姓名授权只有在官方通讯录返回唯一成员时才执行；同名时必须显式选择 ID，回调身份映射失败时按未授权处理。
- Codex 的 `cwd` 固定为该群绑定的 Workspace。
- Codex 使用严格只读权限，不继承企业微信凭据，不允许网络、写文件、提交、推送、删除或部署。
- Warden 自身只在 Workspace 外的 `~/.warden/state-v3.json` 保存运行状态；目录权限为 `0700`、文件权限为 `0600`。
- 为支持崩溃恢复，未完成请求会临时保存当前 `@` 指令、发送者和群 ID；投递成功后立即删除正文和原始 ID，只保留哈希执行记录。
- 回复失败时，最终回复会临时保存在 outbox，成功补发后立即删除。inbox 和 outbox 各自最多 128 条。
- 状态文件和日志不保存 Bot Secret、环境变量、Workspace 文件内容或历史群消息正文。
- 回复最大 12 KB，超出部分会被截断。
- V0.5 只读取附件元数据，不下载或分析附件内容。

## 12. 开发验证

```sh
npm run typecheck
npm test
npm run build
```

更完整的 Mock 和真实企业微信验收步骤见 [POC.md](./POC.md)。

Warden 的配对、目标状态和结果新鲜度设计参考了 [Larkin](https://github.com/eddiearc/larkin) 的思路；未复制其源代码。
