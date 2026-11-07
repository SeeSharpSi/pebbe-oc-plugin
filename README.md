# OpenCode for Pebble

Unofficial Pebble integration for sending messages to an authenticated OpenCode V2 server; not an official OpenCode release. It exposes reusable phone-side sources and one send action; it includes no watch binary or standalone watch UI. A successful send returns a queued receipt, not the generated reply.

## Phone plugin interface

Sources match the structure and refresh behavior of the [official Claude plugin manifest](https://raw.githubusercontent.com/coredevices/pebble-apps/main/claude/package.json):

| Source | Items and properties | Multiple | Refresh |
| --- | --- | --- | ---: |
| `agent/chats` | `name: shortText`, `title: shortText`, `url: longText` | Yes | 900 sec |
| `agent/configured` | `name: shortText`, `configured: boolean, shortText` | No | 60 sec |

The only action is `send_to_agent`, targeting `agent/chats`. It requires `message` (1–16000 characters) and accepts optional nullable `chat_id`. Omit `chat_id` to use the configured default or new-session mode. Use reserved value `new` to start a new session in the configured directory. Existing sessions can be targeted by ID, nickname, or title. Set distinct nicknames in settings; ambiguous titles fail.

Manifest sets `destructive: false` and `requiresConfirmation: false`, matching Claude's UI metadata. These flags do not make actions read-only: prompts may run commands or modify files under OpenCode's configured permissions. This plugin provides no permission bypass and requests no caller permissions. Do not automatically retry uncertain delivery or conflicts.

## Server setup and security

Requires OpenCode V2 and its direct Basic-auth JSON API; OpenCode V1 is unsupported. Configure one server URL and password in plugin settings. Password is stored in `secureStorage`; status never reveals credentials. Use the actual shared OpenCode service when you want its existing TUI sessions. Check its address with `opencode service status`.

OpenCode V2 uses `OPENCODE_PASSWORD` for server authentication; Basic-auth username is always `opencode`. To run a separate server, for example:

```sh
OPENCODE_PASSWORD='<strong-password>' opencode serve --hostname 0.0.0.0 --port 4096
```

This binds every network interface. OpenCode's raw HTTP Basic authentication is readable by anyone who can observe unencrypted traffic. For any non-trusted LAN, HTTPS or an encrypted private network is required. Never expose an unauthenticated service. A separate `opencode serve` process is not the shared service; sessions active elsewhere may not share execution with it.

References: [OpenCode V2 web/server documentation](https://opencode.ai/v2/docs/cli/web), [Claude plugin manifest](https://raw.githubusercontent.com/coredevices/pebble-apps/main/claude/package.json), [official Pebble plugin packer format](https://raw.githubusercontent.com/coredevices/pebble-apps/main/scripts/pack-plugin-pbw.py).

## Build and install

Plugin-only packaging requires Python 3.9 or newer. Tests use Node.js built-in test runner. No npm dependencies or Pebble SDK required:

```sh
npm test
npm run build
# or: python3 scripts/build.py
```

Build writes `build/pebble-opencode.pbw`. Install:

1. Sideload PBW in Pebble mobile app; enable plugins if required and grant network permissions.
2. Open plugin settings; enter phone-reachable server URL and password.
3. Select the default session, or set an absolute server directory and choose new-session mode.
4. Use Index to send.

## Limits and verification

No reply display, background listener, or permission-approval controls. Transport uncertainty is not retried automatically.

Checked against isolated OpenCode 2.2.1 server. Queue tests used `resume: false` to prevent agent execution. Settings tested in a browser with a simulated Pebble bridge. Physical phone/watch testing remains outstanding.
