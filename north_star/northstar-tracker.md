# OpenCode Stdio App-Server North Star

## Current Status

- Target: expose OpenCode's existing in-process HTTP/DTO route stack as typed JSON-RPC over stdio.
- Do not reimplement the app-server by directly calling V2/native session services as the primary runtime path.
- Do not spawn per-session CLI processes or parse CLI output.
- Do not open a TCP listener for normal stdio mode.
- Keep stdout reserved for line-framed JSON-RPC.
- Keep events as a bus: one long-lived app-server process emits route/native events with session/location keys, and the outer harness routes lanes.

## Source Facts

Yes — and after checking the source, this is actually **more viable than I first realized**, because OpenCode already has the pattern you need.

The important source fact: `opencode web` itself is thin. It imports `Server`, calls `Server.listen(opts)`, prints/open URLs, then waits forever.  

But the server stack already exposes an **in-process fetch app**:

```ts id="z6f6ph"
Server.Default().app.fetch(request)
```

The source builds that from `HttpApiApp.webHandler().handler`, no TCP listener required. 

Even better: `opencode run` already uses this exact trick. In non-attach local mode, it creates a `fetchFn` that calls `Server.Default().app.fetch(...)`, then creates an SDK client with:

```ts id="7v6eri"
createOpencodeClient({
  baseUrl: "http://opencode.internal",
  fetch: fetchFn,
  directory,
})
```



So yes: **you can strip the HTTP transport down to in-process request dispatch and wrap it with stdio JSON-RPC.** You probably do **not** need to reinvent the HTTP handlers.

The clean shape is:

```txt id="5ak74x"
stdio JSON-RPC process
  stdin/stdout JSON-RPC
      |
      v
  adapter methods
      |
      v
  @opencode-ai/sdk/v2 client
      |
      v
  custom fetch()
      |
      v
  Server.Default().app.fetch()
      |
      v
  existing OpenCode HTTP API handlers
```

That gives you the typed surface and avoids opening a port.

I would not literally make it “web but printing stdio events” internally. I would make it a sibling transport mode that reuses the same server app:

```txt id="nz0bqa"
opencode web
  -> Server.listen()
  -> browser/server transport

opencode stdio / opencode rpc / opencode web --stdio
  -> Server.Default().app.fetch()
  -> JSON-RPC stdin/stdout transport
```

Using `opencode web --stdio` is okay for convenience, but architecturally it is not “web.” It is **server API over stdio**.

The JSON-RPC wrapper methods could be thin:

```txt id="gvz4tm"
initialize
session.list
session.get
session.create
session.prompt
session.promptAsync
session.command
session.abort
session.messages
session.subscribe
permission.reply
file.read
file.list/tree
provider.list
config.get
```

For events, you have two choices.

The simple way:

```txt id="p0nw49"
start one internal event subscription
forward every event as JSON-RPC notification
include sessionID in payload
let your outer harness route/multiplex
```

Example:

```json id="m7w5ea"
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "message.part.updated",
    "sessionID": "ses_...",
    "data": {}
  }
}
```

That is the best fit for your host because **your host already understands session lanes**.

The other way is per-session subscriptions:

```txt id="f6bitj"
session.subscribe({ sessionID })
  -> only forward events matching that session
```

But I would avoid that as the core transport. OpenCode events already carry session IDs in the paths the CLI filters. `opencode run` subscribes to the event stream and filters `message.updated`, `message.part.updated`, `session.error`, `session.status`, and permissions by a single selected `sessionID`.  

For your multiplexer, do the opposite: **do not filter in the child**. Forward the events and let your outer harness map them to lanes.

The big win over CLI-process mode:

```txt id="m87jio"
CLI run:
  one process invocation chooses one sessionID
  subscribes
  prompts
  exits on idle

stdio RPC:
  one long-lived process
  many sessionIDs
  many prompts
  one event bus
  host-side multiplexing
```

So the answer is: **yes, this is the route.**

I’d implement it as a transport adapter, not as a fork of business logic:

```ts id="ozi3nb"
const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
  const { Server } = await import("@/server/server")
  const request = new Request(input, init)
  return Server.Default().app.fetch(request)
}

const sdk = createOpencodeClient({
  baseUrl: "http://opencode.internal",
  fetch: fetchFn,
  directory,
})
```

Then JSON-RPC method handlers just call SDK methods.

The stdio process becomes:

```txt id="p0kme9"
read JSON-RPC request
  -> validate method params
  -> call SDK/client
  -> return JSON-RPC result/error

internal event stream
  -> emit JSON-RPC notifications
```

That avoids the worst option:

```txt id="aqevxk"
spawn opencode run per session
parse CLI output
try to reconstruct state
```

You would still be using the same OpenCode API stack, but without TCP, browser UI, or stdout formatting noise.

The caution: `opencode run` imports `createOpencodeClient` from `@opencode-ai/sdk/v2`, but the generated client includes both legacy-compatible route classes and newer `/api/...` V2 route classes. The stdio app-server must use the legacy-compatible HTTP session surface (`/session`, `/permission`, `/question`, `/event`) for CLI session parity, not the `/api/session` V2 surface.

Transport-wise: **in-process HTTP app + generated route DTOs + JSON-RPC stdio is the cleanest bridge.**




For real multiplexing, the stdio process should be a **bus**, not a session-scoped client.

The current HTTP event endpoint is already close, but not perfect:

```txt id="z2gaxd"
GET /event
  subscribes to EventV2Bridge
  receives raw events
  filters by instance directory / workspace
  maps to { id, type, properties }
  sends SSE
```

Source: the handler listens to `events.listen(...)`, queues events, filters by `event.location?.directory === instance.directory` and workspace, then maps each event to `{ id, type, properties: event.data }`. 

So it is **not session-filtered at the HTTP event endpoint**. The session filtering happens in `opencode run`: it subscribes once, then ignores events whose `sessionID` does not match the selected session. 

That means for stdio multiplexing, you do **not** want to copy `opencode run`’s event loop. You want to copy the lower-level event subscription idea, but change the output envelope.

Current CLI behavior:

```txt id="6uw0yc"
subscribe event stream
  -> filter to one sessionID
  -> print stdout/UI
  -> exit when that session goes idle
```

Desired stdio behavior:

```txt id="tt307q"
subscribe event bus
  -> do not filter by sessionID
  -> preserve sessionID/location if present
  -> emit JSON-RPC notification
  -> client routes by sessionID
```

Envelope should be something like:

```json id="njs32v"
{
  "jsonrpc": "2.0",
  "method": "opencode/event",
  "params": {
    "id": "evt_...",
    "type": "message.part.updated",
    "sessionID": "ses_...",
    "directory": "/repo",
    "workspaceID": "ws_...",
    "properties": {}
  }
}
```

The subtle point: the existing HTTP SSE mapper currently drops `event.location` and only emits `properties: event.data`.  For a stdio multiplexer, I would **not drop location**. Keep it in the envelope because not every event is necessarily session-scoped.

So I’d design stdio as:

```txt id="i2rsfe"
event source:
  EventV2Bridge.Service.listen

filter:
  maybe directory/workspace, depending on launch mode
  never sessionID by default

output:
  JSON-RPC notifications keyed by:
    sessionID when available
    directory/workspace when available
    event type otherwise
```

There are two levels of “every event”:

```txt id="zrh849"
Every event for one OpenCode instance/directory:
  reuse /event semantics or EventV2Bridge with same location filter

Every event across all directories/workspaces:
  bypass the HTTP /event handler’s instance filter
  listen lower, before Stream.filter(...)
```

The existing `/event` route is instance-routed via `WorkspaceRoutingQuery` and middleware.  That is fine for “one directory server lane,” but if your stdio process is meant to supervise many directories, you probably want a **global stdio event tap** below that route.

So the right transport split is:

```txt id="syzyf7"
HTTP/SSE client behavior:
  route-scoped event stream
  useful for web/TUI

stdio JSON-RPC behavior:
  process-wide event bus
  emits all events with keys
  client owns routing/multiplexing
```

And method calls should stay independently session-addressed:

```json id="436s13"
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "session.prompt",
  "params": {
    "sessionID": "ses_a",
    "parts": [{ "type": "text", "text": "continue" }]
  }
}
```

Then events come back async:

```json id="ak2rcf"
{
  "jsonrpc": "2.0",
  "method": "opencode/event",
  "params": {
    "type": "message.part.updated",
    "sessionID": "ses_a",
    "properties": {}
  }
}
```

That is real multiplexing. The server does not decide which active session the client cares about. The server emits the bus; your harness routes lanes.

## Implementation Tracker

- [x] Confirm current repo cwd is `/data/data/com.termux/files/home/test-projects/opencode`.
- [x] Confirm `Server.Default().app.fetch(request)` exists and is already used by `opencode run`.
- [x] Confirm generated SDK has legacy-compatible route classes for `/session`, `/permission`, `/question`, and `/event`.
- [x] Confirm generated SDK also has `/api/session` V2 classes and those must not become the app-server primary session path.
- [x] Replace the current stdio app-server internals with a route-backed client/dispatch layer over `Server.Default().app.fetch`.
- [x] Keep provider/model catalog methods route-backed where possible. Current catalog methods use the generated route client for both `/provider` and `/config/providers`, then merge those real route DTO sources so configured providers override matching public/provider records without inventing synthetic entries.
- [x] Map JSON-RPC session methods to legacy-compatible HTTP DTOs:
  - `session/create` -> `POST /session`
  - `session/list` -> `GET /session`
  - `session/status` -> `GET /session/:sessionID`
  - `session/resume` -> `GET /session/:sessionID` bind/validation only
  - `session/messages` -> `GET /session/:sessionID/message`
  - `turn/start` -> `POST /session/:sessionID/prompt_async`
  - `turn/cancel` -> `POST /session/:sessionID/abort`
  - `turn/toolApproval/respond` -> `POST /permission/:requestID/reply`
  - `turn/userInput/respond` -> `POST /question/:requestID/reply`
  - `turn/userInput/reject` -> `POST /question/:requestID/reject`
- [x] Use `prompt_async` for `turn/start`, not the synchronous message route. The synchronous route waits for execution to settle and can deadlock approvals because ALS cannot answer `turn/toolApprovalRequested` until `turn/start` returns.
- [x] Emit the route event bus over JSON-RPC notifications without child-side session filtering.
- [x] Translate route event names into existing ALS app-server notifications for current turn lifecycle coverage: start/model info, content deltas, reasoning deltas, tool calls, approvals, user input, usage, failures, idle completion, and cancellation.
- [x] Translate raw `message.part.delta` route events directly into `turn/contentDelta` and `turn/thoughtDelta`. Final `message.part.updated` snapshots are now only a backstop for missed text, not the primary streaming path.
- [x] Accept a second `turn/start` while a session has active provider work by holding only the user prompt/message identity in the stdio app-server queue and admitting it through `prompt_async` only after the current route-backed turn completes. Queued `turn/start` requests deliberately do not re-apply incoming MCP/model/instruction params; active session config remains the source for the queued prompt. This preserves one ALS turn per user prompt instead of letting OpenCode's route runner coalesce the interjection into the active prompt loop.
- [x] Strengthen user-interjection validation so the queued turn must not emit `turn/started` while the held active turn is still running, must start only after the first turn completes, and must keep working even when the queued request carries valid-shaped but unusable MCP/model params that would fail if applied immediately.
- [x] Fix route-backed interruption semantics for queued turns: cancelling a queued-but-not-yet-admitted app-server turn removes it locally and emits a cancelled terminal turn notification; cancelling the admitted active turn still goes through `POST /session/:sessionID/abort`.
- [x] Wire ALS conversation interrupt into the OpenCode extension. The adapter now exposes Codex-style `abort_session(conversation_id)`, tracks active/queued external turn ids per ALS conversation, and sends route-backed `turn/cancel` with the bound `provider_session_id` and selected `turnId`.
- [x] Correct context-window token percentage math for route-backed OpenCode usage. Raw token totals still include output/reasoning/cache fields, while `contextUsed` / `context_used` and the ALS `token_count.total` path use non-cached input plus cached prompt input because both occupy the active context window.
- [x] Suppress visible `turn/toolCallRequested` notifications for empty `pending` tool states and emit the request when the route reports `running` with real input. This prevents duplicate/empty tool cards before the usable request payload exists.
- [x] Normalize current route-backed OpenCode tool completion payloads into ALS card contracts: `read` display-file payloads become `view` rows, grouped `grep` output becomes `path:line:text` search content, and `apply_patch` `structured.files[]` metadata becomes patch-summary tool rows plus standalone anchored `diff` rows.
- [x] Normalize route-backed unified diffs so ALS diff cards do not show redundant `Index: ...` / separator prelude lines in the visible diff body.
- [x] Trim emitted ALS diff payloads with `rstrip("\n")` semantics so diff cards do not include a trailing blank line that can confuse strict revert/patch consumers.
- [x] Map OpenCode `todowrite` completions into the ALS extension planning/todo contract using router heuristics, similar to read/search/shell specialization.
- [x] Re-introduce MCP/devins integration through the route-backed workflow: the TE2 MCP integration checkbox supplies the effective ALS devins context through instruction params and explicit `mcpServers` config through OpenCode's existing route-backed `/mcp` methods.
- [x] Preserve ALS conversation identity for `agent-pty-blocks` MCP config by passing the active conversation id into MCP server construction and using it for the local server `CONVERSATION_ID` environment value. The extension emits both `env` and OpenCode-native `environment` fields, and sets the local server timeout to `6000000000` ms (100,000 minutes). This keeps MCP `ask_user` routed to the correct ALS conversation and avoids the default short MCP timeout.
- [x] Align the OpenCode extension manifest's TE2/agent-pty tool render policy with the Codex extension: agent-log and KB request/response fields render as markdown, and `te2_console_eval` renders JavaScript request code plus JSON response values through highlighted fields.
- [x] Normalize OpenCode composite MCP tool names such as `te2-mcp_te2_console_eval` and `agent-pty-blocks_agent_log_post` into separate `server` and `tool` fields before ALS card fanout so the Codex/Copilot-style render policy rules actually match.
- [x] Fan out route-backed standalone `turn/usage` notifications as ALS `token_count` events instead of waiting for `turn/completed` to carry usage.
- [x] Preserve OpenCode's route-backed context-overflow compaction handoff. Route-backed `ContextOverflowError` / provider `context_length_exceeded` errors now emit a nonterminal `turn/warning`, start the real `/session/:sessionID/summarize` path through the generated route client, gate the immediate post-overflow `idle` event so it cannot complete the turn as success, expose manual `session/compact` through the same route, suppress summary assistant messages as normal assistant output, and map compaction completion to ALS `context_compacted` live/replay rows.
- [x] Replace the stale Termux `opencode-spike` live-source wrapper with a primary `opencode` wrapper at `/data/data/com.termux/files/home/.local/bin/opencode` targeting this repo. `opencode-spike` remains only as a compatibility symlink to the same current-repo wrapper.
- [x] Harden OpenCode compaction handoffs against stale-marker loops. Compaction/subtask tasks now execute against the user message that owns the task part instead of the newest normal user prompt, stale compaction markers summarize only history before their marker, repeated core compactions anchor to the latest previous summary, and the prompt wording treats prior summaries as an update baseline rather than text to preserve wholesale.
- [x] Validate route-backed provider/model/variant listing, session create/list/status/resume/messages, prompt admission, approvals, user input, token usage, error completion, and cancellation through `packages/opencode/test/cli/app-server/lifecycle.test.ts`.
- [x] Validate current route-backed slice with `bun test test/cli/app-server/lifecycle.test.ts --timeout 150000`, `bun typecheck`, and `git diff --check`.
- [x] Validate the current route delta/card slice against `fs_1781402570_4376c813.stdout.log`; the probe mapped read to a view range, grep to normalized search rows, and apply_patch to a line-anchored diff.
- [x] Live-validated the installed route delta/card slice against `fs_1781405315_bb1e8852.stdout.log`: the RPC stream parsed with zero JSON errors, emitted fine-grained content/reasoning deltas, produced no empty tool requests, carried the question request/resolution pair, and mapped specialized completions to 19 view cards, 3 search cards, and 1 anchored diff.
- [x] Replay-validated the todo/diff cleanup slice against `fs_1781405315_bb1e8852.stdout.log`: `todowrite` emitted 4 `plan_update` events and 1 final plan transcript row, no generic `todowrite` tool card leaked through, and no diff transcript row started with the legacy `Index:` prelude.
- [x] Restrict settings schema provider responses to configured providers plus the built-in `opencode` provider. The route-backed app-server now exposes configured provider identity from `/config/providers`, and the ALS schema adapter filters unconfigured catalog providers instead of showing every discoverable provider.
- [x] Reconcile history import with the legacy-compatible message route cursor shape. The route supports `before`/descending semantics, so `session/messages` returns `X-Next-Cursor` as a JSON-RPC cursor with `direction: "previous"` and the ALS extension imports desc pages before reversing the full collected message list into chronological transcript entries.
- [ ] Live-validate CLI-created session listing, message history import, prompt continuation, approval reply, question reply, and cancellation against the same session database used by the local CLI.
- [x] Re-introduce MCP only through a route-compatible design. Current route-backed `server/initialize` advertises `mcp: true`; `mcpServers` params are applied through OpenCode's existing `/mcp` route. Enabled servers must report `connected`, disabled servers may report `disabled`, omitted `mcpServers` leaves existing route state alone, and `{}` disconnects app-server-managed names for the directory.
- [ ] Map per-turn approval/sandbox policy to real OpenCode route/runtime semantics. Do not present `approvalMode` or sandbox params as working until the route-backed mapping is real.
