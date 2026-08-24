<p align="center">
  <img src="./docs/assets/threadferry-hero-v2.png" alt="ThreadFerry connects Codex, Pi, Claude, and Grok to WeCom" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#first-run">First run</a> ·
  <a href="#chat">Chat</a> · <a href="#security">Security</a> ·
  <a href="#operations">Operations</a> · <a href="./CHANGELOG.md">Changelog</a>
</p>

ThreadFerry connects WeCom to isolated local AI agents. One agent maps to one WeCom AI bot, with its
own Owner, credentials, groups, workspace, runtime, and sessions. Owners can work in direct chat;
authorized members can invoke the bot by mentioning it in configured groups.

<p align="center">
  <img src="./docs/assets/threadferry-poster.png" alt="ThreadFerry supports WeCom group and direct chat with Codex, Pi, Claude, and Grok" width="560">
</p>

## Capabilities

- Run Codex, Pi, Claude Code, or Grok Build against a fixed local workspace.
- Analyze direct messages and controlled group context without granting the runtime file writes or
  arbitrary shell access.
- Read images and UTF-8 text attachments, including quoted and recent chat resources.
- Use official `wecomcli-*` Skills for calendars, meetings, todos, mail, documents, storage, sheets,
  and smart sheets through a validated `wecom-cli` broker.
- Create reminders and hand work to another agent owned by the same person.
- Recover sessions, queued work, and undelivered replies after restart.

## Install

Requirements:

- macOS, Linux, or Windows
- Node.js 22+
- A WeCom AI bot
- One runtime: Codex CLI `0.138.0+`, Pi CLI `0.84.2+`, Claude Code `2.1.233+`, or Grok Build `1.0.5+`
- Official `wecom-cli 1.1.0+` (the installer adds it when needed)

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.ps1 | iex
```

After installing the CLI and completing first-time setup, download the desktop app for everyday use
from [GitHub Releases](https://github.com/GnaixEuy/threadferry/releases/latest): the arm64 DMG for
Apple Silicon Macs, the x64 DMG for Intel Macs, the NSIS installer on Windows, or AppImage/DEB on
Linux. The desktop app adds the tray entry; the runtime and official `wecom-cli` continue to use the
local installation and login above.

## First run

Run the onboarding wizard in an interactive terminal:

```sh
threadferry onboard
```

The wizard installs the official WeCom Skills, authorizes the bot, identifies its Owner, selects a
runtime and workspace, runs diagnostics, and starts ThreadFerry.

After that, open the ThreadFerry desktop app. It starts configured agents automatically. Its menu-bar
or notification-area icon opens the admin console, restarts or stops the service, reveals the log, and
quits cleanly. Closing the admin window only returns it to the tray.
The lower-left console utilities include trace logs and Preferences. Trace logs locate sanitized records by
error ID, agent, action, or resource and can be hidden in Preferences. Preferences also controls the theme,
launch at login, automatic service startup, opening the console after startup, and the optional macOS Dock
entry. On first open, the console shows a state-driven getting-started checklist and a three-step interface
tour. The checklist collapses after bot authorization and the first Owner direct message; group setup remains
optional, and the tour can be skipped or restarted from Preferences. The overview also visualizes sanitized
runtime state with a seven-day processing trend and task-status distribution. Desktop preferences stay on the device.

For terminal operation, configured agents can still be started with:

```sh
threadferry start
```

The local admin console is available at
[http://127.0.0.1:17638](http://127.0.0.1:17638). It manages agents, bot authorization,
workspaces, groups, users, sessions, reminders, work items, and recent activity.

## Chat

The Owner can send an ordinary direct message:

```text
Investigate why login requests started timing out.
```

An authorized member can mention the bot in a configured group:

```text
@Bot Summarize the discussion and inspect the relevant code.
```

Group requests include up to 80 messages from the preceding 6 hours as untrusted context. Direct
requests include up to 80 messages from the preceding 7 days. Ordinary group messages do not start a
runtime.

### Enterprise data and actions

Ask for an enterprise task in natural language, for example:

```text
List my meetings this afternoon.
Create a 30-minute review meeting tomorrow at 10:00.
Append these rows to the project smart sheet.
```

The agent follows the matching official WeCom Skill to select the capability, clarify missing input,
build the current CLI command, and interpret the result. ThreadFerry validates the Skill-to-command
mapping, command shape, identity, conversation boundary, requested effect, and confirmation policy,
then runs the command with that agent's own `wecom-cli` credentials. Results return to the same agent.

Queries run only in Owner direct chat. Every write receives a local `--dry-run` validation first.
Destructive operations, overwrites, completing todos, sending messages, and sending mail require a
fresh Owner confirmation code.

### Images and files

Send an image or file in Owner direct chat, or attach or quote it while mentioning the bot in a
configured group. UTF-8 text is available to every runtime; images use each runtime's native visual
input. Unsupported binary formats are reported as received but unavailable for parsing.

One resource is limited to 20 MB and one turn to 50 MB. Each agent retains up to 7 days, 1,000
messages, and 200 MB of authorized chat history under `~/.threadferry/history/<agent>/`. Agent and chat
partitions remain separate. Runtime copies are removed after the turn, and stored history never
contains resource URLs, AES keys, media IDs, or temporary paths.

Grok Build accepts encoded image requests up to 700 KB. Use Codex, Pi, or Claude for larger images.

### Agents and groups

Add and authorize another agent from the admin console or terminal:

```sh
threadferry agent add --name reviewer --runtime pi --workspace /absolute/path/to/project
threadferry agent login reviewer
threadferry agent list
```

Claude Code and Grok Build use their local CLI login and model configuration:

```sh
claude auth login
threadferry agent add --name claude-reviewer --runtime claude --workspace /absolute/path/to/project

grok login
threadferry agent add --name grok-reviewer --runtime grok --workspace /absolute/path/to/project
```

The Owner manages a bot's groups by sending commands in direct chat with that bot:

| Command | Purpose |
| --- | --- |
| `threadferry groups` | List visible groups and their availability state |
| `threadferry users <group>` | List authorized users |
| `threadferry invite <group>` | Create a one-time invitation code |
| `threadferry add <group> <name>` | Authorize a user |
| `threadferry remove <group> <name>` | Remove a user |
| `threadferry open <group>` | Allow every group member to invoke the bot |
| `threadferry close <group>` | Restore the authorized-user list |
| `threadferry whoami` | Show the caller's ThreadFerry userid |

Add the bot to an internal group and mention it once. ThreadFerry enables that bot for the group on
the first callback, with only its Owner authorized by default. The admin console group detail page
controls whether the bot is available and which members may use it; no separate binding step is
required. Group discovery covers groups with messages in the last seven days.

## Security

- Direct-agent requests are accepted only from that bot's Owner.
- Stopped groups, unauthorized users, and messages without a bot mention do not start a runtime.
- Agents do not share credentials, Owners, sessions, chat history, or workspace access.
- Codex runs without network or file writes. Pi exposes path-guarded `read` and `ls`. Claude Code uses
  Safe Mode and read-only tools. Grok Build uses a strict sandbox with web, subagents, and memory disabled.
- Runtimes cannot commit, push, deploy, delete files, invoke arbitrary shell commands, or call
  `wecom-cli` directly.
- Bot credentials remain in each agent's encrypted `wecom-cli` store. ThreadFerry does not persist Bot
  Secrets in configuration, state, logs, URLs, fixtures, or environment variables.
- Chat history, quoted messages, attachments, and enterprise content are always untrusted input.

## Operations

```sh
threadferry doctor
threadferry skills install
threadferry status
threadferry agent list
threadferry update
```

Start selected agents with `threadferry start --agents frontend,reviewer`. Reset a group session with
`threadferry session reset --group <group-id>`.

Local files:

- Configuration: `~/.threadferry/threadferry.yaml`
- State: `~/.threadferry/state-v3.json`
- Per-agent credentials: `~/.threadferry/wecom/<agent>/`
- Example configuration: [threadferry.example.yaml](./threadferry.example.yaml)

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run desktop:pack
```

Use [POC.md](./POC.md) for acceptance testing and [CONTRIBUTING.md](./CONTRIBUTING.md) for the Gitmoji
commit convention. Licensed under [MIT](./LICENSE).
