# pi-permission-notify

> Bridge [pi](https://pi.mariozechner.at/) permission prompts to Telegram — approve or deny commands from your phone.

A pi extension that connects [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) (permission gates) with [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) (Telegram bridge) so that when pi needs permission to run a command, you get a Telegram message — and in remote-approval mode, you can **approve or deny by tapping inline buttons**.

## Features

- **📱 Telegram notifications** — get notified whenever pi is waiting on a permission decision
- **✅ Remote approval** — approve or deny bash commands directly from Telegram inline buttons (opt-in)
- **🔒 Fail-closed** — 2-minute timeout denies the command if you don't respond
- **⚙️ Slash command** — `/permission-notify on|off|status` to toggle modes at runtime
- **🔌 Zero hard dependencies** — resolves `@llblab/pi-telegram` at runtime from pi's global node_modules

## Two modes

| Mode | `remoteApproval` | Behavior |
|---|---|---|
| **Notify-only** (default) | `false` | Sends a text notification to Telegram. You approve/deny in the pi TUI. |
| **Remote-approval** | `true` | Sends a Telegram message with ✅ Approve / ❌ Deny inline buttons. Tap to decide. |

### Notify-only (default)

Listens to the `permissions:ui_prompt` event from pi-permission-system and forwards a formatted notification to Telegram. You still make the decision in the pi TUI. Good for staying informed while at your computer.

### Remote-approval (opt-in)

Hooks pi's `tool_call` event for `bash` commands. When the agent runs a shell command, the extension sends a Telegram message with inline keyboard buttons:

```
⏳ Approve command?
```
```bash
echo "hello world"
```
[✅ Approve]  [❌ Deny]

- **Tap ✅ Approve** → message edits to "✅ Approved", command runs
- **Tap ❌ Deny** → message edits to "❌ Denied", command blocked with reason "Denied via Telegram"
- **No tap for 2 minutes** → message edits to "⏱️ Timed out — denied", command blocked (fail-closed)

## Requirements

- [pi](https://pi.mariozechner.at/) coding agent (v0.84+)
- [`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram) installed and paired with a Telegram bot
- [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages) installed (for notify-only mode; optional for remote-approval mode)

```bash
pi install npm:@llblab/pi-telegram
pi install npm:@gotgenes/pi-permission-system
```

## Install

Install from this repository as a local path:

```bash
pi install /path/to/pi-permission-notify
# or
pi install ./pi-permission-notify
```

Or clone and install:

```bash
git clone https://github.com/<your-username>/pi-permission-notify.git
pi install ./pi-permission-notify
```

## Configuration

The config file lives at `~/.pi/agent/extensions/pi-permission-notify/config.json`:

```json
{
  "remoteApproval": false
}
```

- `remoteApproval: false` — notify-only mode (default)
- `remoteApproval: true` — remote-approval mode (Telegram buttons)

The config is read at extension load time. **Restart pi** (or run `/reload`) after changing it.

### Toggling at runtime

Use the built-in slash command (no restart needed to save the config, but a restart is needed to apply the mode change):

```
/permission-notify            # show current mode
/permission-notify status     # same as above
/permission-notify on         # enable remote-approval mode
/permission-notify off        # disable (notify-only mode)
```

### Avoiding double-prompting

When `remoteApproval: true`, the extension gates bash via Telegram. If you also have `@gotgenes/pi-permission-system` configured to `ask` for bash, you'll get **both** a TUI dialog and a Telegram prompt. To use the extension as the sole gate, set the permission system's bash rules to `allow`:

```jsonc
// ~/.pi/agent/extensions/pi-permission-system/config.json
{
  "permission": {
    "bash": { "*": "allow" }
  }
}
```

## How it works

### Remote-approval flow

```
Agent calls bash tool
  ↓
pi fires tool_call event
  ↓
pi-permission-notify intercepts (tool_call handler)
  ↓
Sends Telegram message via sendTelegramView() with inline keyboard
  - callback_data: "pipermissionnotify:approve:<id>"
  - callback_data: "pipermissionnotify:deny:<id>"
  ↓
Awaits a Promise (stored in pending registry with a 2-min timeout)
  ↓
You tap a button on Telegram
  ↓
pi-telegram's polling loop receives callback_query
  ↓
registerTelegramUpdateHandler callback fires
  - matches namespace "pipermissionnotify"
  - resolves the pending Promise
  - edits message to "✅ Approved" / "❌ Denied"
  - returns "consume" (suppresses default routing)
  ↓
tool_call handler resolves
  - approve → returns undefined (tool proceeds)
  - deny → returns { block: true, reason: "Denied via Telegram" }
```

### Key technical details

- **Callback namespace**: `pipermissionnotify:<action>:<id>` (≤64 bytes, per pi-telegram's [callback namespace standard](https://github.com/llblab/pi-telegram/blob/main/docs/callback-namespaces.md))
- **Update handler**: registered via `registerTelegramUpdateHandler()` from `@llblab/pi-telegram/updates` — the [raw update handler registry](https://github.com/llblab/pi-telegram/blob/main/docs/updates.md) that lets layered extensions react to Telegram updates before pi-telegram's default routing
- **Module resolution**: uses `createRequire` rooted at `~/.pi/agent/npm/node_modules` to find `@llblab/pi-telegram` since path-installed extensions can't resolve sibling npm packages via normal `import`
- **Delivery scope**: `{ kind: "instance" }` — sends to the paired bot chat regardless of active turns

## Known limitations

- **No `answerCallbackQuery`**: pi-telegram doesn't export `answerCallbackQuery` publicly (it's internal to the Sections API). The button loading spinner times out after a few seconds, but the message edit provides immediate visual feedback.
- **All bash commands gated**: In remote-approval mode, every bash command triggers a Telegram prompt — even harmless ones like `ls`. No read-only shortcut.
- **Extension load order**: `tool_call` handlers run in extension load order. If pi-permission-system loads first and blocks on a TUI `ask` dialog, this extension's handler may not run until the TUI dialog resolves. For commands that hit the permission system's `ask` rules, you may see both a TUI prompt and a Telegram prompt.
- **Config read at load only**: The `remoteApproval` setting is read once at extension load. Use `/permission-notify` to change the config file, then restart to apply.

## Architecture

```
pi-permission-notify/
├── index.ts        # Extension entry — all logic in one file
├── package.json    # Pi package manifest (pi-package keyword, pi.extensions)
├── config.json     # Default config (remoteApproval: false)
├── README.md       # This file
└── LICENSE         # MIT
```

The extension is a single-file TypeScript module that:
1. Loads config from `~/.pi/agent/extensions/pi-permission-notify/config.json`
2. Lazily loads `@llblab/pi-telegram/delivery` and `/updates` modules
3. Registers a `/permission-notify` slash command
4. In notify-only mode: subscribes to `permissions:ui_prompt` on the raw event bus
5. In remote-approval mode: registers a Telegram update handler + hooks `tool_call` for bash

## License

MIT
