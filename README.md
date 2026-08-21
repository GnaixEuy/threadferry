<p align="center">
  <img src="./docs/assets/threadferry-hero-v2.png" alt="ThreadFerry connects Codex, Pi, Claude, and Grok to WeCom" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#use">Use</a> ·
  <a href="#security">Security</a> · <a href="#development">Development</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

ThreadFerry connects WeCom to read-only local AI agents. Each agent has its own bot, Owner,
credentials, groups, workspace, runtime, and sessions — strictly 1:1 and isolated.

<p align="center">
  <img src="./docs/assets/threadferry-poster.png" alt="ThreadFerry supports WeCom group and direct chat with Codex, Pi, Claude, and Grok" width="560">
</p>

## Install

Requirements: macOS or Linux, Node.js 22+, a WeCom AI bot, and one runtime: Codex CLI `0.138.0+`,
Pi CLI `0.84.2+`, Claude Code `2.1.233+`, or Grok Build `1.0.5+`. The installer adds the official
`wecom-cli 1.1.0+` when needed.

```sh
curl -fsSL https://raw.githubusercontent.com/GnaixEuy/threadferry/main/install.sh | bash
```

The onboarding wizard authorizes the bot, confirms its Owner, selects a runtime and workspace,
runs diagnostics, and starts ThreadFerry. Run it again at any time:

```sh
threadferry onboard
```

## Use

Start all authorized agents:

```sh
threadferry start
```

The local admin console opens at [http://127.0.0.1:17638](http://127.0.0.1:17638). It manages bots,
workspaces, groups, users, sessions, reminders, collaboration tasks, and recent activity.

The Owner can message a bot directly:

```text
Investigate why login requests started timing out.
```

In a configured group, mention the bot:

```text
@Bot Summarize the discussion and inspect the relevant code.
```

ThreadFerry adds up to 80 messages from the preceding 6 hours as untrusted context. Regular group
messages do not invoke the runtime.

### Bots and groups

One bot maps to one agent and one workspace. Add another from the admin console or terminal:

```sh
threadferry agent add --name reviewer --runtime pi --workspace /absolute/path/to/project
threadferry agent login reviewer
```

Native Claude Code and Grok Build runtimes reuse the local CLI login and model selection:

```sh
claude auth login
threadferry agent add --name claude-reviewer --runtime claude --workspace /absolute/path/to/project

grok login
threadferry agent add --name grok-reviewer --runtime grok --workspace /absolute/path/to/project
```

Send management commands in a direct chat with the bot they should affect:

| Command | Purpose |
| --- | --- |
| `threadferry groups` | List visible and configured groups |
| `threadferry bind <group>` | Bind a group to this bot |
| `threadferry users <group>` | List authorized users |
| `threadferry add <group> <name>` | Authorize a user |
| `threadferry remove <group> <name>` | Remove a user |
| `threadferry open <group>` | Allow all group members |
| `threadferry close <group>` | Return to the allowlist |

Group discovery covers groups with messages in the last seven days. Send a message in a new group,
refresh the list, then bind it.

### Enterprise actions

Agents can query approved calendars, meetings, todos, mail, documents, storage, and sheets. They can
also create controlled reminders and same-Owner work handoffs. Every action passes ThreadFerry's
identity, conversation, resource, intent, and confirmation checks before it reaches `wecom-cli`.

Personal enterprise data is limited to Owner direct chat. Destructive actions and mail sending always
require a fresh confirmation code.

## Security

- Direct-agent requests are accepted only from that bot's Owner.
- Unconfigured groups, unauthorized users, and messages without `@Bot` do not start a runtime.
- Agents never share credentials, sessions, group history, or workspace access.
- Codex runs without network or file writes; Pi exposes only path-guarded `read` and `ls`; Claude Code
  uses Safe Mode and read-only tools; Grok Build uses a strict sandbox and read-only tools with web,
  subagents, and memory disabled.
- Runtimes cannot commit, push, deploy, delete files, or invoke arbitrary enterprise actions.
- Bot credentials stay in each agent's official `wecom-cli` encrypted store. ThreadFerry does not
  persist Bot Secrets in configuration, logs, state, URLs, or environment variables.
- History, quoted messages, attachments, and enterprise content are always untrusted input.

## Operations

```sh
threadferry doctor
threadferry status
threadferry agent list
threadferry update
```

Start selected agents with `threadferry start --agents frontend,reviewer`. Reset a group session with
`threadferry session reset --group <group-id>`.

Local files:

- Configuration: `~/.threadferry/threadferry.yaml`
- State: `~/.threadferry/state-v3.json`
- Example: [threadferry.example.yaml](./threadferry.example.yaml)

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

See [POC.md](./POC.md) for live WeCom acceptance and [CONTRIBUTING.md](./CONTRIBUTING.md) for the
Gitmoji commit convention. Licensed under [MIT](./LICENSE).
