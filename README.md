# ThreadFerry

[简体中文](./README.zh-CN.md)

ThreadFerry sends `@bot` requests from WeCom group chats, together with recent discussion, to a local AI agent for read-only analysis in a specified workspace, then replies with the result in the original group.

```text
10:00 Zhang: There is a problem with this API
10:01 Li: It may be Redis
10:02 Wang: It happened three times in production
10:05 User: @Bot Please investigate
```

ThreadFerry currently supports internal WeCom group chats, Codex, and Pi. Each group can use a different agent, model, and workspace.
The bot fetches up to 80 messages from the preceding 6 hours only after it is mentioned with `@`; regular messages do not trigger real-time callbacks.

[View the changelog](./CHANGELOG.md)

## Quick Start

### 1. Prerequisites

- macOS or Linux
- Node.js 22+
- Official WeCom `wecom-cli 1.1.0+` (the installer detects and installs it when needed)
- Codex CLI `0.138.0+`, or Pi CLI `0.84.2+`
- A WeCom AI bot that has joined the target internal group

If you use Codex, sign in first:

```sh
codex login
```

If you use Pi, also complete model authorization as required by Pi.

### 2. Install and Configure

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

The installer checks the operating system, Node.js, npm, and `wecom-cli 1.1.0+`. If `wecom-cli` is missing or outdated, it runs the official `npm install --global @wecom/cli` command. Other missing dependencies produce an actionable message. ThreadFerry uses the compiled and tested package from [GitHub Releases](https://github.com/GnaixEuy/threadferry/releases/latest); it does not clone the source code, install development dependencies, or compile TypeScript on your machine.

The setup wizard starts automatically in an interactive terminal. You can also run it manually:

```sh
threadferry onboard
```

The wizard guides you through:

1. Checking and installing the official `wecom-cli`.
2. Initializing `wecom-cli` by QR code or manual Bot ID/Secret entry when it is not authorized.
3. Setting the agent name, runtime, model, and workspace. Agent names may contain Chinese characters and spaces. The workspace defaults to the directory where you run the wizard.
4. Detecting saved `wecom-cli` credentials and asking whether to reuse them. If you decline or the credentials cannot be read, you can enter the Bot ID and masked Bot Secret manually.
5. Sending a one-time pairing command in the target group.
6. Checking dependencies and starting ThreadFerry.

The first person to pair becomes the Owner. The Owner can then manage groups, agents, and authorized members through direct messages with the bot. For additional groups, the locally generated one-time pairing code is the authorization credential, so the sender's callback userid does not need to match the stored Owner userid. Pairing keeps the existing Owner unchanged.

To install without starting the wizard, or to inspect the installation actions:

```sh
./install.sh
./install.sh --dry-run
./install.sh --no-onboard
```

### 3. Start

```sh
threadferry start
```

Keep the terminal running. Open [http://127.0.0.1:17638](http://127.0.0.1:17638) in a browser to use the local admin console.

`threadferry start` checks the GitHub Latest Release before startup and every six hours while running. When a new version is available, ThreadFerry installs it, waits for current work to finish, and restarts with the new version. If the check or installation fails, it logs a warning and keeps the current version running. You can also update manually at any time:

```sh
threadferry update
```

In a configured group, select the bot with WeCom's `@` picker:

```text
@Bot Please investigate the issue discussed above
```

## Manage Groups and Users

The Owner can send these commands directly to the bot:

| Command | Purpose |
| --- | --- |
| `threadferry groups` | List the bot's groups and each group's current agent |
| `threadferry agents` | List configured agents |
| `threadferry use <group-name> <agent-name>` | Switch the agent used by a group |
| `threadferry users <group-name>` | List authorized members |
| `threadferry add <group-name> <name>` | Authorize a member by directory name |
| `threadferry remove <group-name> <name>` | Remove authorization |
| `threadferry invite <group-name>` | Generate a one-time invitation code |
| `threadferry whoami` | Show your callback userid |

If multiple groups or members have the same name, ThreadFerry returns candidate IDs. Retry with `id:<userid>` or the group ID as instructed. Management commands only work in direct messages from the Owner.

After receiving an invitation code, a user can send this command directly to the bot:

```text
threadferry join <invitation-code>
```

Or send it in the relevant group:

```text
@Bot threadferry join <invitation-code>
```

## Manage Agents

Use the admin console to add agents, bind groups, and manage users. Changes take effect immediately.

You can also use the CLI:

```sh
threadferry agent add \
  --name reviewer \
  --runtime pi \
  --workspace /absolute/path/to/project \
  --model provider/model

threadferry agent list
```

`--model` is optional. Each agent has an isolated workspace and runtime session.

## Common Commands

| Command | Purpose |
| --- | --- |
| `threadferry doctor` | Check configuration, dependencies, and authorization |
| `threadferry start` | Start the service and admin console |
| `threadferry status` | Show the queue, sessions, and recent failures |
| `threadferry update` | Check for and install the latest version now |
| `threadferry setup --workspace <absolute-path>` | Pair another group |
| `threadferry session reset --group <group-id>` | Reset a group's runtime session |
| `threadferry start --mock` | Run the mock flow without real credentials |

The admin console listens on `127.0.0.1:17638` by default. To change the port:

```sh
threadferry start --admin-port 18080
```

## Local Data

- Configuration: `~/.threadferry/threadferry.yaml`
- State: `~/.threadferry/state-v3.json`
- Configuration example: [threadferry.example.yaml](./threadferry.example.yaml)

Normal use does not require manually configuring environment variables. `wecom-cli auth init` stores its credentials using the official encrypted mechanism. With your confirmation, `threadferry onboard` and `threadferry start` can decrypt and reuse those local credentials in memory. If reuse is unavailable or declined, ThreadFerry prompts for the Bot ID and masks the Bot Secret as you type. ThreadFerry never writes the credentials to configuration, logs, or state files.

## Security Boundaries

- Only the current message that mentions `@bot` is treated as a user instruction. Message history, quoted messages, and attachment metadata are untrusted context.
- Messages from unconfigured groups or unauthorized users, and messages that do not mention `@bot`, do not start a runtime.
- The runtime is confined to the agent's workspace and cannot read files outside it.
- Codex has network and file writes disabled. Pi exposes only path-guarded `read` and `ls` operations.
- Agent runtimes cannot commit, push, delete, deploy, or perform other write operations. Automatic updates only replace the globally installed ThreadFerry package from the official GitHub Release.
- ThreadFerry uses attachment metadata only. It does not download attachment content or perform OCR.

## Troubleshooting

Start with:

```sh
threadferry status
threadferry doctor
```

- `unauthorized_user`: Ask the Owner to send `threadferry add <group-name> <name>` directly to the bot.
- `unauthorized_group`: Bind the group in the admin console, or run `threadferry setup` again.
- Missing or outdated `wecom-cli`: Run the installer again, or run `npm install --global @wecom/cli`.
- Expired `wecom-cli` authorization: Run `wecom-cli auth init` again, then restart ThreadFerry.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

After you push a `v*.*.*` tag that matches the version in `package.json`, GitHub Actions runs the checks, generates a precompiled package and SHA-256 checksum file, and creates a GitHub Release.

See [POC.md](./POC.md) for real WeCom acceptance steps and [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.
