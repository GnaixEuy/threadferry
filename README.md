# ThreadFerry

ThreadFerry 让企业微信群可以调用本机 Codex 或 Pi 做只读分析。一个 ThreadFerry 可以配置多个 Agent，每个 Agent 独立选择 Runtime、模型和 Workspace，再按群绑定。

群里有人讨论问题时，不需要复制聊天记录。最后一个人 `@机器人` 提问，ThreadFerry 会补齐最近的群消息，交给该群绑定的 Agent 分析，再把结果发回原群。

```text
10:00 张三：这个接口有问题
10:01 李四：可能是 Redis
10:02 王五：线上出现三次
10:05 用户：@叶翔（测试中） 帮忙分析
```

当前版本只支持企业微信内部群，Runtime 支持 Codex 和 Pi，均运行在严格只读模式下。

## 它怎么工作

1. 企业微信智能机器人通过 WebSocket 收到群内 `@机器人` 消息。
2. ThreadFerry 使用官方 `wecom-cli` 拉取该群最近六小时的消息，最多 80 条。
3. 群历史、引用和附件元数据被标记为不可信背景，只有当前 `@机器人` 的消息是用户指令。
4. 当前群绑定的 Agent 在自己的 Workspace 中完成只读分析。
5. ThreadFerry 把结果回复到原群。

普通群消息不会实时回调给机器人。ThreadFerry 在收到 `@机器人` 后才补拉前文。

## 环境要求

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`
- Codex CLI `0.138.0+`，或 Pi CLI `0.84.2+`
- 一个企业微信智能机器人
- 一个或多个本机项目目录，作为 Agent Workspace

先完成要使用的官方 CLI 登录：

```sh
wecom-cli auth init
codex login
# 使用 Pi Runtime 时，另按 Pi 的方式完成模型授权
```

## 一行安装

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

脚本会检查 Node.js、安装 `threadferry` 命令，并在终端可交互时打开配置向导。它不会使用 `sudo`，也不会代替你安装或登录企业微信、Codex、Pi。

从源码目录安装时直接运行：

```sh
./install.sh
```

只安装不打开向导，或先查看将执行的命令：

```sh
./install.sh --no-onboard
./install.sh --dry-run
```

## 配置向导

安装脚本会自动进入向导，也可以随时手动运行：

```sh
threadferry onboard
```

向导会依次完成：

1. 选择 Agent 名、Codex/Pi Runtime、模型和绝对路径 Workspace。
2. 安全读取 Bot ID 与 Bot Secret，并检查 `wecom-cli` 和 Runtime 是否就绪。
3. 显示一次性群配对命令，等待机器人创建者在目标群发送。
4. 运行 `threadferry doctor`，通过后询问是否立即启动。

Bot Secret 输入时不会回显，只保留在当前 ThreadFerry 进程中，不写入 YAML、日志或状态文件。默认配置保存在 `~/.threadferry/threadferry.yaml`，权限为 `0600`；已有其他位置的配置继续使用 `--config <path>` 指定。非交互式启动仍必须通过环境变量传入凭据：

```sh
export THREADFERRY_WECOM_BOT_ID='<Bot ID>'
export THREADFERRY_WECOM_BOT_SECRET='<Bot Secret>'
```

向导显示配对命令后，回到目标企业微信群，用企业微信的 `@` 选择器选中机器人并发送完整命令。不要手工输入字面量 `@ThreadFerry`；机器人叫什么，就选择什么。

第一次配对应由机器人创建者完成。ThreadFerry 会把第一次配对者记录为 Owner，后续群绑定和用户管理都由这个 Owner 操作。

## 启动和管理台

向导没有立即启动时，运行：

```sh
threadferry start
```

交互式启动缺少凭据时会安全提示输入。看到下面的日志后保持终端运行：

```text
ThreadFerry 管理台: http://127.0.0.1:17638
ThreadFerry 已启动，监听 1 个已配置企业微信群。
```

浏览器打开 [http://127.0.0.1:17638](http://127.0.0.1:17638) 即可使用本机管理台：

- 新增 Codex / Pi Agent
- 查看和切换群绑定的 Agent
- 将机器人最近所在的群绑定到 Agent
- 按姓名、别名或 userid 添加用户
- 查看和移除已授权用户

修改会写回配置并立即生效，不需要重启。管理台只监听本机回环地址，不对局域网或公网开放。需要修改端口时：

```sh
threadferry start --admin-port 18080
```

现在可以在群里提问：

```text
@叶翔（测试中） 帮忙分析刚才讨论的问题
```

ThreadFerry 会先回复“正在分析”。同一个群已有任务时，新请求会排队。

按 `Ctrl+C` 停止。

## 配置多个 Agent

首次配对会同时创建 `default` Agent。继续添加 Agent：

```sh
threadferry agent add \
  --name reviewer \
  --runtime pi \
  --workspace /absolute/path/to/another-project \
  --model provider/model

threadferry agent list
```

`--model` 可省略，省略时使用对应 CLI 的默认模型。Agent 名只能使用字母、数字、下划线和连字符。

## 创建者私聊管理

Owner 不需要手改 YAML。直接私聊机器人：

```text
threadferry groups
```

该命令会列出机器人最近所在的群，并显示每个群当前绑定的 Agent。

查看 Agent，并切换某个群：

```text
threadferry agents
threadferry use 月相工作室 reviewer
```

切换从下一条 `@机器人` 消息生效；不同 Agent 的 Runtime Session 相互隔离。

查看某个群当前可以使用 ThreadFerry 的成员：

```text
threadferry users 月相工作室
```

按姓名添加或移除成员：

```text
threadferry add 月相工作室 张三
threadferry remove 月相工作室 张三
```

ThreadFerry 使用企业微信官方通讯录解析姓名和别名。只有唯一匹配时才会修改权限。同名成员会列出部门和候选 ID，例如：

```text
threadferry add 月相工作室 id:zhangsan-2
```

群名可以包含空格：

```text
threadferry add AI Coding 张三
```

同名群需要改用群 ID。

### 邀请码

Owner 也可以生成一次性邀请码：

```text
threadferry invite 月相工作室
```

目标用户在十分钟内私聊机器人：

```text
threadferry join <邀请码>
```

也可以在对应群发送：

```text
@机器人 threadferry join <邀请码>
```

邀请码只能使用一次。任何用户都可以私聊发送 `threadferry whoami` 查看自己的回调 userid。

群内不接受 `users`、`invite`、`add` 或 `remove`。管理命令只能在 Owner 与机器人的私聊中执行。

## 配置文件

默认配置位于 `~/.threadferry/threadferry.yaml`，通常由 `threadferry onboard`、管理台和私聊管理命令维护：

```yaml
version: 5

owner_user: "user_owner"

agents:
  default:
    runtime: "codex"
    workspace: "/absolute/path/to/project"
  reviewer:
    runtime: "pi"
    workspace: "/absolute/path/to/another-project"
    model: "provider/model"

groups:
  "group_xxx":
    agent: "default"
    allow_users:
      - "user_owner"
```

- `owner_user`：第一次配对者的 WebSocket 回调 userid。
- `agents`：命名 Agent；每个 Agent 配置 `runtime`、绝对 `workspace` 和可选 `model`。
- `groups` 的键：真实群 ID；`agent` 引用已配置的 Agent 名。
- `allow_users`：允许触发 Runtime 的成员身份列表。

六小时上下文、80 条消息上限、必须 `@机器人` 和只读模式都是固定规则。当前版本不接受额外配置字段，也不兼容旧版配置。

## 常用命令

```sh
# 检查依赖和授权
threadferry doctor

# 启动服务
threadferry start --admin-port 17638

# 查看执行状态和最近失败
threadferry status

# 清除某个群保存的所有 Runtime Session
threadferry session reset --group '<群 ID>'

# 运行不依赖企业微信和真实 Runtime 的 Mock 链路
threadferry start --mock
```

ThreadFerry 异常退出后，使用同一份配置重新启动即可。未完成任务和待发送回复会从本地状态中恢复。不要同时运行两个 `threadferry start` 进程。

## 常见问题

### `unauthorized_user`

当前成员还没有该群的使用权限。让 Owner 私聊机器人添加姓名：

```text
threadferry add <群名> <姓名>
```

### `unauthorized_group`

机器人所在群还没有绑定 Agent。为该群重新运行 `threadferry setup`，并发送新的配对命令。

### 机器人回复“ThreadFerry 处理失败”

先查看状态和环境：

```sh
threadferry status
threadferry doctor
```

如果 `wecom-cli` 登录失效：

```sh
wecom-cli auth init
wecom-cli identity whoami --json '{}'
```

然后重启 ThreadFerry。

### 终端出现 `quote>`

通常是复制环境变量时用了弯引号，或者漏了结束引号。按 `Ctrl+C` 取消，重新输入英文半角单引号 `'`。

### 群已绑定其他 Agent

Owner 私聊机器人发送 `threadferry use <群名> <Agent名>` 切换。新的本机 Agent 先用 `threadferry agent add` 添加。

## 安全边界

- 只有当前 `@机器人` 的消息是用户指令。历史消息、引用和附件元数据都是不可信背景。
- 未配置群、未授权成员和没有 `@机器人` 的消息不会启动 Runtime。
- Runtime 的工作目录固定为 Agent Workspace，不允许访问 Workspace 外文件。
- Codex 禁用网络和文件写入；Pi 只启用受路径守卫保护的 `read`、`ls`。两者都不能提交、推送、删除或部署，也不继承企业微信凭据。
- 姓名授权只接受官方通讯录的唯一匹配；身份映射失败时按未授权处理。
- Bot Secret、环境变量、Workspace 文件内容和完整历史消息不会写入日志或状态文件。
- 管理台固定监听 `127.0.0.1`，校验 Host 和 CSRF；能够访问本机用户会话的人视为本机管理员。
- 回复最多 12 KB。附件只读取元数据，不下载内容，也不做 OCR。

本地运行状态保存在 `~/.threadferry/state-v3.json`，目录权限为 `0700`，文件权限为 `0600`。未完成请求和待发送回复会短暂保留，处理完成后删除正文，只留下哈希执行记录。

## 开发

```sh
npm run typecheck
npm test
npm run build
```

Mock 和真实企业微信验收步骤见 [POC.md](./POC.md)。提交代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

ThreadFerry 的配对、Session 和消息新鲜度设计参考了 [Larkin](https://github.com/eddiearc/larkin)，没有复制其源代码。
