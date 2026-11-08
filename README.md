# OpenCode for Pebble

Unofficial Pebble integration for sending messages to an authenticated OpenCode V2 server; not an official OpenCode release. It exposes reusable phone-side sources and one send action; it includes no watch binary or standalone watch UI. A successful send returns a queued receipt, not the generated reply.

## Phone plugin interface

Sources match the structure and refresh behavior of the [official Claude plugin manifest](https://raw.githubusercontent.com/coredevices/pebble-apps/main/claude/package.json):

| Source | Items and properties | Multiple | Refresh |
| --- | --- | --- | ---: |
| `agent/chats` | `name: shortText`, `title: shortText`, `url: longText` | Yes | 900 sec |
| `agent/configured` | `name: shortText`, `configured: boolean, shortText` | No | 60 sec |

When server credentials are saved and a valid creation directory is configured, `agent/chats` also includes one virtual target: `instanceId: new`, `name: New`, `title: New session`, with no URL. Real chat entries remain root, unarchived chats. The settings recent-session list contains real sessions only. Reading or polling the source never creates a session.

Two OpenCode sources expose live activity:

| Source | Items and properties | Multiple | Refresh |
| --- | --- | --- | ---: |
| `opencode/active_session` | `name: shortText, longText`; `title: longText`; `status: shortText, longText`; `directory: longText`; `agent: longText`; `model: longText`; `updated: timestamp`; `url: longText`; `is_subagent: boolean` | Yes | 20 sec |
| `opencode/activity` | `name: shortText, longText`; `active_count: numericValue, shortText`; `attention_count: numericValue, shortText`; `summary: shortText, longText`; `connected: boolean`; `checked_at: timestamp` | No | 20 sec |

Phone-side PebbleKitJS watchface or app consumers can subscribe to a plugin source with `Pebble.subscribeToSource`. Its single options object includes plugin UUID, category, item, and callbacks. The numeric count may be absent when a scan is incomplete:

```js
Pebble.subscribeToSource({
  plugin: '4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173',
  category: 'opencode',
  item: 'activity',
  onData: ({ instances }) => {
    const properties = instances[0]?.properties;
    const count = properties?.active_count?.numericValue?.value;
    console.log(typeof count === 'number' ? `${count} active` : properties?.summary?.longText?.text || 'Activity unavailable');
  },
  onError: error => console.log(error.code, error.message),
});
```

`active_session` yields each active session, including subagents. A session's `name` is its nickname or title; its actual session ID remains targetable with `send_to_agent`. `agent`, `model`, and `updated` may be absent. Status precedence is `Waiting for approval` when any permission request exists, then `Waiting for input` when forms exist, otherwise `Running`. `updated` and `checked_at` are Pebble timestamps in epoch seconds, converted from OpenCode milliseconds.

Active sessions represent foreground execution owned by the configured OpenCode process. They are not recent chats, background jobs, or activity in separate processes. Sessions are grouped by full root lineage in deterministic ancestry-ID order, parent before descendants. Inactive ancestors may be fetched for grouping but are not emitted as active sessions. `activity` counts root groups, not child-inclusive session instances. `attention_count` counts each root group once if any active member needs permission or input; a group with multiple requests still counts once.

A successful empty lookup returns `active_session: []` and one `activity` instance with `connected: true`, both counts `0`, and summary `No active sessions`. Missing configuration, or a failed or invalid active-map lookup, returns `connected: false` with both counts omitted. If the active map validates but follow-up detail, permission/form data, or grouping fails, `connected` remains `true`, summary is `unavailable`, and both counts are omitted. Neither failure case reports zero. `checked_at` records the latest attempt. Consumers must check that counts exist even when connected. An incomplete active-session lookup rejects the `active_session` source rather than returning a fake empty list.

Each subscription poll performs a fresh bounded scan; there is no persistent cache or background daemon. Limits are 100 active IDs, 200 metadata lookups, 32 parent hops, and 4 concurrent HTTP requests. Limit or cycle failures produce unavailable data, not truncated results. Activity sources use read-only GETs and need only saved server credentials; no default messaging session is required. No approval controls or additional actions are provided.

The only action is `send_to_agent`, targeting `agent/chats`. It requires `message` (1–16000 characters) and accepts optional nullable `chat_id`. Omit `chat_id` to follow configured mode: use the default session in existing mode or create a session in new mode. Use reserved `chat_id: "new"` to explicitly create a session in the configured directory, including when existing mode is selected. Creation starts a fresh session and sends the first message; follow-up messages target its real session ID. Each `new` send creates another session. An explicit `chat_id` overrides omitted-ID default-mode routing. Existing sessions can be targeted by ID, nickname, or title. Set distinct nicknames in settings; ambiguous titles fail.

New-session mode requires saved server credentials and an absolute server directory, but no existing default session. Its settings hide the recent-session list and default editor; switching to existing mode restores them. The message hint reflects the saved directory, not unsaved text in the directory field. To choose a default, switch to existing mode, select a real session, then choose **Use as default**. A saved directory also makes the virtual `New` target available in existing mode.

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
3. Choose existing-session mode and select a default, or save an absolute server directory and choose new-session mode.
4. Use Index to send.

## Limits and verification

No reply display, background listener, or permission-approval controls. Transport uncertainty is not retried automatically.

Checked against isolated OpenCode 2.2.1 server. Queue tests used `resume: false` to prevent agent execution. Settings tested in a browser with a simulated Pebble bridge. Physical phone/watch testing remains outstanding.
