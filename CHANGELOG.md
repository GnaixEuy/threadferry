# 更新日志

ThreadFerry 的每个 GitHub Release 都使用这里对应版本的内容，不再依赖自动生成的空白发布说明。

## Unreleased

### 主要变化

- Agent 名支持中文、空格和常见符号，不再要求使用纯英文标识符。
- `threadferry onboard` 的 Workspace 默认值改为运行命令时的当前目录，不再沿用已有配置中的路径。
- `threadferry start` 会在启动前和运行期间主动检查 GitHub Latest Release，自动安装新版本并在当前任务结束后重启。
- 新增 `threadferry update` 手动更新命令；自动检查或安装失败时保留当前服务并输出告警。
- 安装器会检测 `wecom-cli 1.1.0+`，缺失或版本过低时自动执行官方 npm 安装命令，并在未授权时进入官方初始化流程。
- `wecom-cli` 已配置时，ThreadFerry 会询问是否直接读取并复用其加密凭据；读取失败或用户拒绝时仍可手动输入。
- 新增群绑定改为由本机生成的一次性配对码授权，不再因同一用户的企业微信回调 ID 形式不同而误判为非 Owner；现有 Owner 保持不变。
- Release Notes 改为从本文件提取经过整理的中文说明；缺少对应版本内容时发布流程会直接失败。

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
