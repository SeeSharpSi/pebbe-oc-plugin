# OpenCode for Pebble

Unofficial Pebble integration for an authenticated OpenCode V2 server; not an official OpenCode release. It exposes reusable phone-side sources and actions; it includes no watch binary or standalone watch UI. A successful send returns a receipt for the requested delivery mode, not the generated reply.

## Phone plugin interface

Sources match the structure and refresh behavior of the [official Claude plugin manifest](https://raw.githubusercontent.com/coredevices/pebble-apps/main/claude/package.json):

| Source | Items and properties | Multiple | Refresh |
| --- | --- | --- | ---: |
| `agent/chats` | `name: shortText`, `title: shortText`, `url: longText` | Yes | 900 sec |
| `agent/configured` | `name: shortText`, `configured: boolean, shortText` | No | 60 sec |

When server credentials are saved and a valid creation directory is configured, `agent/chats` also includes one virtual target: `instanceId: new`, `name: New`, `title: New session`, with no URL. Real chat entries remain root, unarchived chats. The settings recent-session list contains real sessions only. Reading or polling the source never creates a session.

OpenCode sources expose activity, replies, chat attention, permissions, questions, and jobs:

| Source | Items and properties | Multiple | Refresh |
| --- | --- | --- | ---: |
| `opencode/active_session` | `name: shortText, longText`; `title: longText`; `status: shortText, longText`; `directory: longText`; `agent: longText`; `model: longText`; `updated: timestamp`; `url: longText`; `is_subagent: boolean`; metrics below | Yes | 20 sec |
| `opencode/activity` | `name: shortText, longText`; `active_count: numericValue, shortText`; `attention_count: numericValue, shortText`; `summary: shortText, longText`; `connected: boolean`; `checked_at: timestamp` | No | 20 sec |
| `opencode/reply` | `name: shortText, longText`; `session_id: longText`; `message_id: longText`; `text: shortText, longText`; `updated: timestamp`; `complete: boolean`; `status: shortText, longText`; `url: longText`; metrics below | No | 20 sec |
| `opencode/replies` | `name: shortText, longText`; `title: longText`; `session_id: longText`; `message_id: longText`; `text: shortText, longText`; `updated: timestamp`; `complete: boolean`; `status: shortText, longText`; `is_default: boolean`; `url: longText`; metrics below | Yes | 60 sec |
| `opencode/chat_status` | `name: shortText, longText`; `title: longText`; `session_id: longText`; `message_id: longText`; `needs_action: boolean`; `reason: shortText, longText`; `permission_count: numericValue, shortText`; `question_count: numericValue, shortText`; `unread: boolean`; `updated: timestamp`; `is_default: boolean`; `is_subagent: boolean`; `url: longText`; metrics below | Yes | 20 sec |
| `opencode/permission` | `name: shortText, longText`; `title: longText`; `session_id: longText`; `request_id: longText`; `action: shortText, longText`; `resources: longText`; `message: longText`; `url: longText` | Yes | 20 sec |
| `opencode/question` | `name: shortText, longText`; `session_id: longText`; `form_id: longText`; `question: longText`; `fields: longText`; `answerable: boolean`; `url: longText` | Yes | 20 sec |
| `opencode/job` | `name: shortText, longText`; `job_id: longText`; `session_id: longText`; `kind: shortText`; `status: shortText, longText`; `started: timestamp`; `url: longText`; `child_session_id: longText` | Yes | 20 sec |
| `opencode/execution` | `name: shortText, longText`; `session_id: longText`; `status: shortText, longText`; `detail: longText`; `tool: longText`; `retry_at: timestamp`; `updated: timestamp`; `url: longText` | No | 20 sec |
| `opencode/queue` | `name: shortText, longText`; `session_id: longText`; `inbox_id: longText`; `kind: shortText`; `text: shortText, longText`; `delivery: shortText`; `queued_at: timestamp`; `url: longText` | Yes | 20 sec |
| `opencode/shell` | `name: shortText, longText`; `shell_id: longText`; `command: longText`; `directory: longText`; `cwd: longText`; `status: shortText, longText`; `started: timestamp`; `completed: timestamp`; `duration: numericValue, shortText` seconds; `exit: numericValue` | Yes | 20 sec |
| `opencode/command` | `name: shortText, longText`; `command: longText`; `description: longText`; `directory: longText`; `session_id: longText` (optional) | Yes | 300 sec |
| `opencode/usage` | `name: shortText, longText`; `workspace_id: longText`; `usage_url: longText`; `go_rolling_percent: numericValue, shortText`; `go_weekly_percent: numericValue, shortText`; `go_monthly_percent: numericValue, shortText`; `go_rolling_resets: timestamp`; `go_weekly_resets: timestamp`; `go_monthly_resets: timestamp`; `limited: boolean, shortText`; `status: shortText, longText`; `summary: shortText, longText`; `checked_at: timestamp` | No | 60 sec |

The four session/reply sources also declare optional `outcome: shortText, longText`, `cost: numericValue, shortText` (USD), `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, and `tokens_cache_write` (`numericValue` only), plus `agent` and `model` (`longText`). Runtime omits unavailable or invalid metrics; token and cost values come only from fetched session metadata. Cost is server-reported model cost, not provider subscription spend. These fields do not trigger separate metrics requests.

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

Snapshots and active-map validation cache for 5 seconds. Completed-readable replies cache for 60 seconds, keyed by unchanged `Session.Info.time.updated`; active or incomplete replies bypass this cache. The private cache in Pebble `secureStorage` is bounded to 64 entries and 256 KiB serialized, evicts expired entries, and falls back to live reads on cache failure or corruption. Within each source request, cache reads share a validated envelope. Assistant-message fetching uses 5-message pages up to 20 total, with cursor pagination only after the first page. Source snapshots can retain bounded short staleness. Mutating preflights never use source caches, and mutation attempts invalidate caches. Reads never rewrite credential state; separate private cache metadata supports previously saved settings without requiring reconnect. Targeted refreshes follow settings changes and actions instead of invalidating every source. Limits are 100 active IDs, 200 metadata lookups, 32 parent hops, and 4 concurrent HTTP requests. Limit or cycle failures produce unavailable data, not truncated results. Activity sources use read-only GETs and need only saved server credentials; no default messaging session is required.

Actions and relevant settings changes refresh only affected sources. No background listener or server-side daemon is used.

`opencode/reply` reads the configured default session, or falls back to the last successfully sent session in existing mode. New-session mode reads its last sent session. The last session ID is securely persisted and reset when the server URL or username changes. With no focus, source is empty. It fetches assistant messages in 5-message pages, up to 20 total, extracts text parts only (not reasoning or tool payloads), and selects newest text-bearing message, including streaming or errored messages. Text is limited to 4096 Unicode characters. OpenCode millisecond timestamps become Pebble epoch-second timestamps. `status` reflects completion state; this is polling, not SSE. `opencode/execution` uses the same focus (configured default, otherwise last sent; empty when neither exists) and reports at most the 5 newest timeline entries, independently of the last reply. Active state is refreshed rather than hidden by snapshots, including current retry and compaction state. It never exposes raw reasoning, tool payloads, native payloads, or provider response bodies; optional safe error detail is bounded.

`opencode/replies` returns one instance per monitored session. The default session comes first, the last successfully sent session second, then recent root unarchived chats newest-first; duplicates are removed. The count comes from settings, default 10 and maximum 20. Reply metadata uses 5-message pages up to 20 total and the 60-second unchanged-update cache; active/incomplete messages bypass it. Requests are bounded to 4 concurrent operations. The `instanceId` is the session ID. When text exists, fields match `opencode/reply`. Without text, `message_id`, `text`, `updated`, and `complete` are omitted and `status` reads `Idle` or `No reply`. `is_default` is a boolean. This is not a truly arbitrary session list: older or capped sessions are absent, and source parameters are unsupported. The existing `opencode/reply` remains the single 20 sec focused source.

`opencode/chat_status` returns one instance per monitored chat. It covers the configured default, last sent session, recent chats up to the Recent replies count, and sessions with pending permissions or questions. It is capped at 50 chats. `reason` uses precedence Permission, then Question, then Unread, then None. `message_id` is the latest reply ID for use with `mark_chat_read`, and is omitted when no reply exists. `unread` is watch-local: it is true when the latest text-bearing assistant reply differs from the stored last-seen message. Reading on desktop does not clear it. Use `mark_chat_read` to clear it, passing the message ID that was seen or omitting it to mark the latest reply read. `is_subagent` shows whether the instance is a child session.

`opencode/permission` lists up to 50 pending permission requests with session ID, request ID, action, and resource JSON. Use `approve_permission` to approve once or reject; permanent approval is not offered. The action checks the live request before replying and does not retry uncertain responses. This is separate from answering an agent question.

`opencode/question` scans at most 100 active IDs plus the focused session, with at most 4 concurrent form requests. It returns at most 200 forms total, with at most 50 fields per form and 16000 schema characters. Idle forms in unfocused sessions are excluded. `fields` contains schema JSON and original form/field IDs are preserved. External questions are exposed as unanswerable. Polling never answers or POSTs. Sources may expose model reply text, question titles, queued prompt text, shell command lines, command descriptions, and execution error details; even safe error details may contain sensitive content. Shell output is not exposed, but command lines may themselves contain secrets. Choose source subscriptions with this exposure in mind.

`answer_question` takes an explicit `session_id`, `form_id`, and typed `answer` record. Required fields need explicit values even when they have defaults; defaults are UI hints, not server answers. Conditions use only explicitly supplied answers, without merging defaults. Do not autofill defaults or hidden fields; supplied hidden or inactive fields are rejected. Forms containing required hidden fields are desktop-only and exposed as unanswerable, even when conditional. The plugin validates field IDs, required fields, conditions, types, bounds, and options; the server performs final format/pattern validation. Answers accept strings, numbers, booleans, or arrays of strings; nested objects and null are not accepted. For example, `{ "confirmed": true }` answers a boolean field; `{ "choice": "option-id" }` selects a choice by its option key. Forms are not assumed to be binary. This action submits only explicit choices and is not permission approval.

`opencode/usage` reports OpenCode Go subscription usage only. It does not report Claude, OpenAI, or other provider subscription usage. It reads the experimental OpenCode Go usage endpoint and returns no instance when the server location is not signed in to an OpenCode Console workspace or when the workspace has no Go meters. Otherwise it exposes rolling 5-hour, weekly, and monthly percentages, their reset timestamps, `limited`, and a summary. Go usage is percentage-based; the source does not invent remaining dollar amounts. Console budgets are not exposed by this source. Endpoint 404/405 is reported as unsupported, not as zero usage.

`opencode/queue` monitors at most two mode-aware sessions: configured default first, then distinct last-sent; it does not monitor recent chats. Entries preserve each session's native FIFO order, with no cross-session clock sorting. At most 200 entries are returned; exceeding the bound errors rather than truncates. User, synthetic, compaction, and move entries have safe labels and bounded text. Duplicate composite IDs error. `instanceId` is `sessionID:inboxID`. `cancel_queued_message` removes a selected pending item; `set_queued_delivery` switches it between `queue` and `steer`. Both require confirmation, validate fresh live pending state and session ownership, and never retry; steering wakes execution.

`opencode/shell` lists running shells only, with a 200-item bound. Scope requires an explicit directory: focused live session location, falling back to configured absolute creation directory; without either, it does not assume server cwd. It reports owning directory separately from actual `cwd`, and never returns raw output/history. Optional display text is limited to 4096 Unicode characters. `stop_shell` requires exact shell ID and absolute server directory, fresh running-state validation, and confirmation; stopping terminates the process and deletes retained output. It never retries.

`opencode/command` exposes discovered command shortcuts in the same explicit directory scope as shells, bounded to 200 unique names. The exact command name is the instance ID. Optional display text is limited to 4096 Unicode characters. `run_command` requires an explicit live, unarchived session, rediscovers the exact command at its location, and submits only that registered command with optional bounded text and queue/steer delivery. OpenCode's command endpoint executes the slash-command callback immediately: delivery mode is passed to the server but does not mean the callback waits in the queue. HTTP 204 acknowledges the request only, not command completion, a generated reply, or guaranteed queued execution. The action does not expose arbitrary shell invocation, but a registered command may itself use tools or run shell commands under OpenCode's configured permissions. Confirmation is required; uncertain POSTs are not retried.

These sources and added metric fields are available to phone-side consumers that subscribe to them; this plugin change does not add watch-app UI or subscriptions.

`opencode/job` reports the experimental jobs endpoint: `running`, `completed`, `error`, or `cancelled`. It represents native active and unconsumed jobs, not permanent history. More than 200 jobs fails the source rather than returning a false zero. Endpoint 404/405 is an unsupported-source error, not an empty list. The plugin exposes no job cancellation or result/command payload. Source errors do not fabricate empty or zero data.

`send_to_agent` targets `agent/chats`. It requires `message` (1–16000 characters) and accepts optional nullable `chat_id` plus an optional `delivery` value of `queue` or `steer`. Omit `delivery` to use the plugin's Message delivery setting, which defaults to `queue`; an explicit value overrides it. `queue` waits for the current run to finish and delivers messages in FIFO order. `steer` injects the message at the next safe turn in the active run. Steering changes the active run, so use it deliberately; queue is the safer default. The receipt verifies the requested delivery mode, and a mismatch fails without retry. Omit `chat_id` to follow configured mode: use the default session in existing mode or create a session in new mode. Use reserved `chat_id: "new"` to explicitly create a session in the configured directory, including when existing mode is selected. Creation starts a fresh session and sends the first message; follow-up messages target its real session ID. Each `new` send creates another session. An explicit `chat_id` overrides omitted-ID default-mode routing. Existing sessions can be targeted by ID, nickname, or title. Set distinct nicknames in settings; ambiguous titles fail.

`approve_permission` requires confirmation, explicit session and request IDs, and a decision of `once` or `reject`. It defaults to `once`. It does not offer permanent approval and does not retry uncertain responses.

`mark_chat_read` clears only the watch-local unread marker for the identified chat. It does not mark the session read on desktop.

`interrupt_session` requires confirmation and an explicit session ID; it stops foreground execution only. `resume: false` prevents automatic resume. An `interrupted: false` response means the session was already idle. It does not cancel detached jobs, and the virtual `new` target is invalid. `answer_question` also requires confirmation; caller permissions remain empty for all actions. Queue cancellation/delivery changes, shell stops, and command execution are destructive and require confirmation. No action automatically retries uncertain outcomes. Provider spend must not be inferred from reported token/cost metadata.

New-session mode requires saved server credentials and an absolute server directory, but no existing default session. Its settings hide the recent-session list and default editor; switching to existing mode restores them. A Recent replies card sets how many sessions `opencode/replies` monitors, from 1 to 20, default 10; it works without an active server connection. A Message delivery card selects **Queue after current run** or **Steer active run** for sends that omit `delivery`; it defaults to queue and works without an active server connection. The message hint reflects the saved directory, not unsaved text in the directory field. To choose a default, switch to existing mode, select a real session, then choose **Use as default**. A saved directory also makes the virtual `New` target available in existing mode.

Manifest confirmation flags distinguish actions: sending and marking a chat read are non-destructive and do not require confirmation; interrupt, permission approval, queue changes, shell stop, and command execution are destructive and require confirmation; answering a question is non-destructive but requires confirmation. These flags do not make actions read-only: prompts and discovered commands may run commands or modify files under OpenCode's configured permissions. This plugin provides no permission bypass and requests no caller permissions. Do not automatically retry uncertain delivery or conflicts.

## Server setup and security

Requires OpenCode V2 and its direct Basic-auth JSON API; OpenCode V1 is unsupported. Plugin settings offer two connection methods:

- **Password.** Enter the phone-reachable server URL, username, and password.
- **Pairing link.** Run `opencode pair` on the server, copy the printed `/auth/connect/<code>` link, and paste it into settings. Do not open the link in a browser first. The link is single-use and expires after 5 minutes. The plugin exchanges it for a session token and stores that token in `secureStorage`; it then uses the token as the Basic-auth password with username `opencode`.

Pairing tokens last 30 days. Changing the server password signs paired sessions out. The server URL must be reachable from the phone; use `opencode pair --remote` or a LAN address instead of a desktop localhost URL. The settings page shows whether the active connection uses Password or Pairing link. Status never reveals the password or pairing token. Use the actual shared OpenCode service when you want its existing TUI sessions. Check its address with `opencode service status`.

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
2. Open plugin settings and connect with either a phone-reachable server URL and password, or a pasted `opencode pair` link.
3. Choose existing-session mode and select a default, or save an absolute server directory and choose new-session mode.
4. Use Index to send.

## Limits and verification

Sources refresh by polling; there is no background listener or SSE. Permission approval is limited to one-time approval or rejection; permanent approval is not offered. Transport uncertainty is not retried automatically.

Automated unit and fixture tests cover local contracts and behavior. GET-only smoke checks do not mutate OpenCode state. No new live mutation checks or physical-device tests were performed for the execution, queue, shell, command, or metric additions. Earlier isolated OpenCode 2.2.1 checks covered question answers, idle interruption, and the native empty-message envelope; the jobs endpoint returned 404. Those checks did not invoke provider/model prompt execution.
