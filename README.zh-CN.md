# ThreadFerry

[English](./README.md)

ThreadFerry 把企业微信群里的 `@机器人` 请求和近期讨论一起交给本机 AI Agent，在指定 Workspace 中完成只读分析，再把结果回复到原群。

```text
10:00 张三：这个接口有问题
10:01 李四：可能是 Redis
10:02 王五：线上出现三次
10:05 用户：@机器人 帮忙分析
```

当前支持企业微信内部群、Codex 和 Pi。每个群可以绑定不同 Agent、模型和 Workspace。
机器人只在收到 `@` 后补拉最近 6 小时、最多 80 条群消息，普通消息不会实时回调。

[查看更新日志](./CHANGELOG.md)

## 快速开始

### 1. 准备依赖

- macOS 或 Linux
- Node.js 22+
- 企业微信官方 `wecom-cli 1.1.0+`（安装器会自动检测并补装）
- Codex CLI `0.138.0+`，或 Pi CLI `0.84.2+`
- 已加入目标内部群的企业微信智能机器人

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

1. 检查并安装官方 `wecom-cli`。
2. `wecom-cli` 未授权时，通过扫码或手动输入 Bot ID/Secret 完成官方初始化。
3. 设置 Agent 名、Runtime、模型和 Workspace。Agent 名支持中文和空格；Workspace 默认使用运行向导时的当前目录。
4. 检测 `wecom-cli` 已保存的凭据，并询问是否直接读取复用；拒绝复用或读取失败时，可以手动输入 Bot ID 和隐藏显示的 Bot Secret。
5. 在目标群发送一次性配对命令。
6. 检查依赖并启动 ThreadFerry。

第一次配对者会成为 Owner，后续可以私聊机器人管理群、Agent 和可使用成员。新增群绑定时，以本机生成的一次性配对码作为授权凭证，不再要求发送者的回调 userid 与已保存的 Owner userid 严格相等；配对不会修改现有 Owner。

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

启动后保持终端运行。浏览器访问 [http://127.0.0.1:17638](http://127.0.0.1:17638) 可以使用本机管理台。

`threadferry start` 会在启动前检查 GitHub Latest Release，运行期间每 6 小时再检查一次。发现新版本后会自动安装，等待当前任务结束，再使用新版本重启；检查或安装失败时会告警并继续运行当前版本。也可以随时手动执行：

```sh
threadferry update
```

回到已配置群，通过企业微信的 `@` 选择器选中机器人：

```text
@机器人 帮忙分析刚才讨论的问题
```

## 管理群和用户

Owner 可以直接私聊机器人：

| 命令 | 用途 |
| --- | --- |
| `threadferry groups` | 查看机器人所在群和当前 Agent |
| `threadferry agents` | 查看已配置 Agent |
| `threadferry use <群名> <Agent名>` | 切换群使用的 Agent |
| `threadferry users <群名>` | 查看可使用成员 |
| `threadferry add <群名> <姓名>` | 按通讯录姓名授权 |
| `threadferry remove <群名> <姓名>` | 移除授权 |
| `threadferry invite <群名>` | 生成一次性邀请码 |
| `threadferry whoami` | 查看自己的回调 userid |

同名群或同名成员会返回候选 ID，按提示使用 `id:<userid>` 或群 ID 重试。管理命令只能在 Owner 私聊中执行。

目标用户拿到邀请码后，可以私聊机器人：

```text
threadferry join <邀请码>
```

也可以在对应群发送：

```text
@机器人 threadferry join <邀请码>
```

## 管理 Agent

管理台可以新增 Agent、绑定群和管理用户，修改立即生效。

也可以使用 CLI：

```sh
threadferry agent add \
  --name reviewer \
  --runtime pi \
  --workspace /absolute/path/to/project \
  --model provider/model

threadferry agent list
```

`--model` 可以省略。不同 Agent 的 Workspace 和 Runtime Session 相互隔离。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `threadferry doctor` | 检查配置、依赖和授权 |
| `threadferry start` | 启动服务和管理台 |
| `threadferry status` | 查看队列、Session 和最近失败 |
| `threadferry update` | 立即检查并安装最新版本 |
| `threadferry setup --workspace <绝对路径>` | 配对其他群 |
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

正常使用不需要手工配置环境变量。`wecom-cli auth init` 按官方机制加密保存自身凭据；经用户确认后，`threadferry onboard` 和 `threadferry start` 可以在内存中解密并复用这份本地凭据。无法读取或拒绝复用时，ThreadFerry 会引导输入 Bot ID，并隐藏输入 Bot Secret。ThreadFerry 不会把凭据写入配置、日志或状态文件。

## 安全边界

- 只有当前 `@机器人` 的消息是用户指令；历史消息、引用和附件元数据都是不可信背景。
- 未配置群、未授权用户和未 `@机器人` 的消息不会启动 Runtime。
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

- `unauthorized_user`：让 Owner 私聊机器人执行 `threadferry add <群名> <姓名>`。
- `unauthorized_group`：通过管理台绑定群，或重新运行 `threadferry setup`。
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
