# ThreadFerry

[简体中文](./README.zh-CN.md)

ThreadFerry lets a locally confirmed WeCom user chat directly with a local AI agent, and can also send `@bot` requests from group chats together with recent discussion for read-only analysis in a specified workspace.

```text
10:00 Zhang: There is a problem with this API
10:01 Li: It may be Redis
10:02 Wang: It happened three times in production
10:05 User: @Bot Please investigate
```

**One agent per WeCom bot, strictly 1:1.** Every agent independently owns its bot credentials,
Owner, groups and allowlists, workspace, runtime, model, and sessions — to reach a given
workspace, you chat with that workspace's bot. All agents' connections run concurrently inside a
single ThreadFerry process without affecting one another.

ThreadFerry currently supports WeCom direct chats and internal group chats, Codex, and Pi.
The bot fetches up to 80 messages from the preceding 6 hours only after it is mentioned with `@`; regular messages do not trigger real-time callbacks.

[View the changelog](./CHANGELOG.md)

> **Under active development; not formally released yet.** Multi-bot support is complete but has
> not yet been exercised with two live bots. See [MULTI_BOT_PLAN.md](./MULTI_BOT_PLAN.md).

## Quick Start

### 1. Prerequisites

- macOS or Linux
- Node.js 22+
- Official WeCom `wecom-cli 1.1.0+` (the installer detects and installs it when needed)
- Codex CLI `0.138.0+`, or Pi CLI `0.84.2+`
- A WeCom AI bot; add it to an internal group only when group chat is needed

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

1. Explaining the "one agent = one bot" model. With an existing config you can either **add a new
   agent** or **re-pair an existing agent's Owner**.
2. Authorizing the WeCom bot for that agent: it explains that a browser is about to open, then runs
   `wecom-cli auth init` for QR-code authorization. The agent name is taken directly from the bot's
   name (auto-suffixed on collision), so you only confirm the runtime, model, and workspace (defaults
   to the current directory). Credentials stay encrypted in wecom-cli's own directory; ThreadFerry
   never handles the secret.
3. Claiming the Owner: the person who scanned the QR code is the bot creator, so its identity is read
   directly and you are asked whether to set it as this agent's Owner (defaults to yes). Decline if you
   want a different person to be the Owner, and fall back to phone pairing instead.
4. Running the environment diagnostics.
5. Starting ThreadFerry.

The locally approved authorized user becomes the Owner and can immediately chat with that agent.
Pairing and direct Agent use rely on the callback userid supplied by the bot event, so they do not
require WeCom directory permission. Re-running `threadferry onboard` can add an agent or re-claim an
existing agent's Owner; `threadferry setup` also re-claims on its own (with an existing config the
`--workspace` flag is optional and the agent's configured workspace is reused). Groups are optional.

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

The Owner can send a normal direct message to the bot without an `@` mention:

```text
Please investigate the login failure
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
| `threadferry bind <group-name-or-id>` | Bind that group to **the agent you are talking to** |
| `threadferry users <group-name>` | List authorized members |
| `threadferry add <group-name> <name>` | Authorize a member by directory name |
| `threadferry remove <group-name> <name>` | Remove authorization |
| `threadferry invite <group-name>` | Generate a one-time invitation code |
| `threadferry open <group-name>` | Let every member of the group use the bot |
| `threadferry close <group-name>` | Go back to authorized members only |
| `threadferry whoami` | Show your callback userid |

`bind` takes no agent argument — whichever bot you are talking to is the agent you bind to.

**One group can run several bots at once**: add the bots to the group, then tick several of them on
the group's pending card in the admin console and press "绑定所选" (or send
`threadferry bind <group-name>` to each bot in a direct chat). Whichever bot gets @-mentioned
answers, using its own workspace; each bot keeps its own allowlist, all-member switch, and session.
Unbinding one leaves the others untouched.

One message may mention several bots at once (`@叶翔 @悦翔 你们好`) and each answers separately.
WeCom delivers such a message only to the **first** bot mentioned, so ThreadFerry hands it to the
others in-process — which means bots mentioned together must be hosted by the same
`threadferry start` process (the default).

If multiple groups or members have the same name, ThreadFerry returns candidate IDs. Retry with `id:<userid>` or the group ID as instructed. Management commands and direct Agent messages only work for **that agent's own Owner**: agent A's Owner cannot manage agent B's groups. Directory permission is only needed for resolving member names in `add` and `remove`; pairing, direct Agent use, and group binding do not use it.

### All-member Access Switch

After `threadferry open <group-name>`, every member of that group can @ the bot without being authorized one by one. `threadferry close <group-name>` restores authorized-members-only access immediately, and the `allow_users` list stays untouched while the switch is on. The same toggle sits on each configured group card in the admin console's groups page. Both write `allow_all` to the config file and take effect on the next @ message.

The switch only widens who may use the bot; nothing else changes. The bot still only answers messages that mention it, still only reads history from bound groups, and agents still run read-only.

After receiving an invitation code, a user can send this command directly to the bot:

```text
threadferry join <invitation-code>
```

Or send it in the relevant group:

```text
@Bot threadferry join <invitation-code>
```

## Manage Agents

Adding an agent means adding a bot — two steps: `threadferry agent add ...` then
`threadferry agent login <name>`. The login step runs `wecom-cli auth init` inside that agent's own
credential directory (`~/.threadferry/wecom/<agent>` by default). **ThreadFerry never handles the
Bot Secret** — credentials stay encrypted in wecom-cli's own store and are only read when opening
a connection. Agent names double as directory names, so they may contain Chinese characters and
spaces (up to 128 characters) but cannot contain path separators or control characters.

Each agent card shows the **top-level department of its Owner** in the address book (for a small
enterprise that is the company name), plus the Owner's display name rather than only the encrypted
userid — useful when bots from several enterprises sit side by side. WeCom exposes no "which
enterprise does this bot belong to" query, so that department is derived from the Owner name in
`identity whoami` looked up in the address book.

These labels are decoration only: **a bot without address-book permission simply loses the
department badge**, everything else still shows, and pages do not get slower — the console only
reads a cache refreshed in the background, never waiting on these lookups.

Authorized-user lists on the groups page show display names too, with the encrypted userid kept
underneath in small type. WeCom cannot look a userid up in the address book, so names are collected
opportunistically from three places: the direct-chat session list, group history messages, and the
moment a user is added by name. Anyone not covered keeps showing their id.

The admin console has three pages: an overview with runtime status and pending actions, an agent
workspaces page showing each agent's bot authorization state, Owner, workspace, and bound groups,
and a groups page for binding or unbinding groups, toggling all-member access, managing authorized
users, and resetting group sessions. Changes take effect immediately.

**How groups are discovered**: WeCom offers no "which groups is this bot in" query, so ThreadFerry
lists groups that have messages in the last 7 days. After adding the bot to a new group, post
anything there (or @ the bot once) before it shows up as bindable. Agents marked "机器人已在群" in
the bind dropdown have a confirmed bot session; unmarked ones can still be bound — @ the bot once
afterwards, and silence means that bot is not in the group yet. Failed lookups (for example, an
enterprise that has not enabled conversation data access) are listed with their reason instead of
being passed off as an empty, complete list.

Adding things happens in a dialog: "＋ Add agent workspace" on the agents page and "＋ Add
authorized user" on each group card. Both dialogs have a picker attached to the input itself —
click the Workspace field to walk local directories (type to filter, arrow keys and Enter to move,
"use this directory" to confirm), or the user field to search the address book and pick a person.
If the form is rejected, the dialog reopens with what you typed and the reason shown inside it.

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
| `threadferry setup [--workspace <absolute-path>]` | Pair or replace the Owner through a locally confirmed direct message (`--workspace` is optional when the config already has the agent) |
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

Normal use does not require manually configuring environment variables. `wecom-cli auth init` stores its credentials using the official encrypted mechanism. ThreadFerry only reads them when opening a connection; it never writes credentials to configuration, logs, or state files, and it never prompts you to type a Bot ID or Secret.

## Security Boundaries

- In direct chat, only messages from **that agent's own Owner** start a Runtime. In groups, only the current message that mentions `@bot` is treated as a user instruction. Message history, quoted messages, and attachment metadata are untrusted context.
- **Agents are isolated from each other**: agent A's bot rejects messages from agent B's groups, and A's Owner cannot chat with agent B.
- Messages from unconfigured groups or unauthorized users, and messages that do not mention `@bot`, do not start a runtime. A group with all-member access (`allow_all`) widens "unauthorized users" to every member of that group; every other limit stays in place.
- **ThreadFerry never handles the Bot Secret**: it never prompts for one, never writes it to the config file, and never puts it in an environment variable. The official `wecom-cli` keeps credentials encrypted in each agent's own directory; ThreadFerry only reads them when opening a connection.
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

- Direct chat answers "only the bot creator (ThreadFerry Owner) may ...": you most likely switched enterprises or recreated the bot, which changes your callback userid. Restart `threadferry start` and accept the Owner update for that agent, or send `threadferry whoami` and then run `threadferry setup`.
- Startup logs "skipping agent X: no bot credentials": run `threadferry agent login X`.
- `unauthorized_user`: Ask the Owner to send `threadferry add <group-name> <name>` directly to the bot.
- `unauthorized_group`: Ask the Owner to send `threadferry bind <group-name-or-id> <agent-name>` directly to the bot, or bind it in the admin console.
- Missing or outdated `wecom-cli`: Run the installer again, or run `npm install --global @wecom/cli`.
- Expired `wecom-cli` authorization: Run `wecom-cli auth init` again, then restart ThreadFerry.
- `errcode 853006`: Ask the enterprise administrator to approve the bot data-access permission required for group message history.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

After you push a `v*.*.*` tag that matches the version in `package.json`, GitHub Actions runs the checks, generates a precompiled package and SHA-256 checksum file, and creates a GitHub Release.

See [POC.md](./POC.md) for real WeCom acceptance steps and [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.
