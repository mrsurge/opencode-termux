# OpenCode Stdio App-Server Plan

## Purpose

Build an OpenCode-backed stdio JSON-RPC app-server that can replace the
KaiDex/Open Gemini spike as the provider-neutral ALS-RS harness target.

The goal is not to expose OpenCode's HTTP API over stdio as a tunnel. The goal
is to bind directly to OpenCode's runtime primitives, then emit a strict
machine-typed app-server protocol over stdout.

## Direction

Use OpenCode as the runtime base because it already appears to have the pieces
we kept rebuilding in KaiDex:

- durable sessions
- model/provider catalog
- OpenRouter provider support
- event stream with text, reasoning, tool, and lifecycle events
- permission/approval requests
- per-session execution coordination
- TUI/server worker pattern that already separates runtime from UI

The stdio app-server should become another runtime surface over those same
primitives.

## Tracker

Current status: **Slice 6 ALS-RS scaffold points at real OpenCode app-server**.

The previous Slice 1 implementation was stopped before code edits because the
stock OpenCode runtime path is Bun-based and the target local runtime is Termux,
where Bun is not currently available in this environment.

Observed local runtime:

- Node is available (`node --version` reported v25.8.0).
- Bun-Termux is installed at `~/.bun/bin/bun`.
- `~/.bun/bin/bun --version` reported 1.3.14.
- npm is available.
- `node_modules` are installed in this worktree using Bun-Termux with
  `BUN_OPTIONS='--os=android'`.

Decision for the current pass:

1. Use the stock OpenCode Bun command path for the first minimal CLI spike.
2. Keep stdout JSON-RPC-only for the `app-server` command.
3. Implement `server/initialize`, `server/shutdown`, V2 catalog methods,
   native session methods, and native turn admission.
4. Keep the Node-native subset plan as a fallback if Bun-Termux fails under
   real OpenCode dependency/test load.

Active tracker items:

- [x] Write first-pass OpenCode stdio app-server plan from context.
- [x] Do source-grounding pass against OpenCode runtime/event/session code.
- [x] Identify Bun/Termux as a blocking runtime constraint for the stock CLI.
- [x] Audit whether a narrower Node-compatible subset exists.
- [x] Install and smoke-test Bun-Termux locally.
- [x] Add `opencode app-server`.
- [x] Implement `server/initialize` and `server/shutdown`.
- [x] Add subprocess smoke for initialize/shutdown.
- [x] Keep `opencode app-server` out of legacy instance bootstrap.
- [x] Implement `provider/list` through the V2 `Catalog.Service` in the
  requested location layer.
- [x] Implement `model/list` through the V2 `Catalog.Service` in the requested
  location layer.
- [x] Implement `session/create` through the public native
  `OpenCode.Service.sessions.create(...)` facade.
- [x] Implement `session/list` through the public native
  `OpenCode.Service.sessions.list(...)` facade.
- [x] Implement `session/status` through the public native
  `OpenCode.Service.sessions.get(...)` facade.
- [x] Run targeted package test.
- [x] Run package native typecheck with the locally compiled Termux `tsgo`.
- [x] Make `bun typecheck` resolve the local compiled `tsgo` instead of the
  package shim on Termux.
- [x] Implement `turn/start` against an existing OpenCode session through
  `OpenCode.Service.sessions.prompt(...)`.
- [x] Add a queued stdout writer so JSON-RPC responses and live notifications
  cannot interleave.
- [x] Subscribe to OpenCode live events through the per-location
  `EventV2.Service.listen(...)` used by the session runner.
- [x] Translate step, text, reasoning, and tool events into app-server
  turn notifications.
- [x] Expose `session/resume` through the public native
  `OpenCode.Service.sessions.resume(...)` facade.
- [x] Expose `turn/cancel` through the public native
  `OpenCode.Service.sessions.interrupt(...)` facade.
- [x] Preserve provider-neutral bind aliases for `sessionId`,
  `providerSessionId`, and `threadId` on status/resume/cancel.
- [x] Map live `permission.v2.asked` events to
  `turn/toolApprovalRequested`.
- [x] Map live `permission.v2.replied` events to
  `turn/toolApprovalResolved`.
- [x] Implement `turn/toolApproval/respond` through the location-scoped
  `PermissionV2.Service.reply(...)`.
- [x] Keep external app-server turns open across intermediate
  `finish: "tool-calls"` provider steps so permission/tool settlement and the
  continuation step remain under the same `turnId`.
- [x] Validate a real model-triggered native `write` tool approval flow through
  the subprocess app-server smoke.
- [x] Validate stale approval ids return a bounded JSON-RPC `-32040` error
  instead of hanging.
- [x] Validate `reject` approval replies resolve the permission, fail the
  rejected tool call, and still allow OpenCode's normal model continuation to
  finish the overall turn.
- [x] Validate `always` approval replies save the native OpenCode permission so
  a second matching write completes without another approval request.
- [x] Map native `session.next.interrupt.requested` events to a terminal
  app-server `turn/completed` notification with `status: "cancelled"` and
  clear the active external turn.
- [x] Validate cancellation while an approval request is pending.
- [x] Validate cancellation after a tool result while the continuation provider
  call is still pending.
- [x] Validate a new turn can be admitted and completed after cancellation.
- [x] Update the copied ALS-RS OpenCode extension scaffold so the shellspec
  launches the local live-source `opencode-spike app-server` instead of the
  mock Python app-server.
- [x] Keep `sessionName` as an ALS-local runtime slot in the extension adapter,
  while routing app-server RPC calls through the durable OpenCode `sessionId` /
  `providerSessionId` / `threadId` bind.
- [x] Make the extension adapter tolerate both the old mock session/list shapes
  and the real OpenCode app-server result shapes.
- [x] Normalize OpenCode tool and approval event fields (`tool`, `input`,
  `action`, `resources`) into the existing ALS-RS card/fan-out path.
- [x] Fan out successful OpenCode `read` tool completions with
  `structured.type: "text-page"` as ALS `view` live events and transcript
  entries, and suppress the redundant generic `tool_end` / `role: "tool"` card
  for that same successful read.
- [x] Complete ALS generic transcript card mapping for OpenCode `read`, `bash`,
  `grep`, `edit`, and `apply_patch` payloads. Extension-local tracker:
  `harness/als-rs/opencode-app-server-extension/CARD_MAPPING_TRACKER.md`.
- [x] Make V2 `apply_patch` emit structured per-file patch metadata
  (`applied[].patch`, `additions`, `deletions`, and combined `diff`) so the
  app-server can forward real line-numbered unified hunks instead of the ALS
  extension deriving diffs from request `patchText`.
- [x] Keep `provider/list` discoverable for the built-in OpenCode provider even
  when it is using public/free models without an `OPENCODE_API_KEY`; model
  listing filters to enabled models from enabled providers plus `opencode`.
- [x] Remove synthetic OpenRouter reasoning-effort fallbacks from the V2
  models-dev catalog path. Reasoning/variant options are now reported only when
  OpenCode has real configured variant metadata for that model.
- [x] Preserve nested variant request metadata (`headers`, `body`,
  `generation`, `options`, and `request`) in `model/list` /
  `model/variant/list` and through the ALS extension settings RPC instead of
  flattening variants down to bare strings.
- [x] Confirm the Python SDK / HTTP provider surface exposes the same runtime
  provider model `variants` through `/config/providers` by routing
  `ModelsDev -> Provider.fromModelsDevProvider -> ProviderTransform.variants`.
- [x] Move stdio `model/list` and `model/variant/list` to OpenCode runtime
  variant parity by merging `Provider.fromModelsDevProvider(...)` variants with
  explicit V2 catalog variants.
- [x] Point the ALS settings-schema `reasoning_effort` field at the direct
  `model.variants.list` schema interaction instead of deriving options from a
  stale model-list row.
- [x] Accept provider/model/variant runtime config on every `turn/start`.
  The stdio app-server parses `provider`, `model`, `variant`, and
  `reasoningEffort`, applies them through OpenCode's native
  `sessions.switchModel(...)` before prompt admission, and then admits the same
  prompt.
- [x] Accept the same provider/model/variant config on `session/resume` so ALS
  lazy resume can retry the same configured turn after a
  session-not-loaded error.
- [x] Update the ALS OpenCode adapter to forward `provider`, `model`,
  `variant`, and `reasoningEffort` on `turn/start`; the adapter still retries
  the exact same user prompt after explicit `session/resume`.
- [x] Add app-server session instruction overlay support. `session/create`,
  `session/resume`, and `turn/start` now accept `hostPlatform`,
  `builtinInstructions`, `developerInstructions`, and
  `userDeveloperInstructions`. The V2 runner loads these through a
  session-scoped `SystemContext` source so instruction changes become normal
  context baselines/updates instead of ordinary chat messages.
- [x] Add ALS settings fields for `developer_instructions` and
  `user_developer_instructions`. The extension normalizes those textareas into
  strict app-server instruction entries and sends `hostPlatform: "ALS"` on every
  create/resume/turn path.
- [ ] Map per-turn approval/sandbox policy to real OpenCode runtime semantics.
  Do not treat `approvalMode` / `sandbox` on `turn/start` as supported until a
  real OpenCode policy mapping exists.

Current validation:

- Latest focused run:
  `bun typecheck` from `packages/opencode` passed with the local Termux
  `tsgo`; JSON settings-schema parsing, extension `py_compile`,
  `basedpyright --outputjson`, and `git diff --check` passed. Focused
  `bun test test/cli/app-server/lifecycle.test.ts --timeout 90000 --test-name-pattern "instruction params"`
  passed and covers strict instruction payload forwarding/rejection. Focused
  `bun test test/cli/app-server/lifecycle.test.ts --timeout 150000 --test-name-pattern "initializes and shuts down"`
  passed and proves the direct subprocess session/turn path still runs with the
  location-scoped instruction overlay. The full lifecycle file still has the
  older cancellation test failure through Effect's
  `All fibers interrupted without error` path.
- Passed:
  `bun test test/session-runner-model.test.ts --timeout 30000` from
  `packages/core`. The focused resolver tests now cover OpenAI OAuth route
  metadata, route-default `systemDelivery: "instructions"`, provider-facade
  request defaults such as `store: false`, and selected variant lowering.
- Passed:
  direct source-wrapper model-list probe through
  `/data/data/com.termux/files/home/.local/bin/opencode-spike app-server`.
  Runtime variant parity now reports OpenCode's own transformed variants:
  `openrouter/google/gemini-3.5-flash` returned
  `none/minimal/low/medium/high/xhigh`,
  `openrouter/google/gemma-4-31b-it` returned `low/medium/high`, and
  `openai/gpt-5.4` returned OpenAI reasoning variants plus the explicit
  `fast` variant. The app-server preserves nested request metadata such as
  `options.reasoning.effort` and `options.serviceTier`.
- Passed:
  direct source-wrapper usage smoke with `openrouter/google/gemma-4-31b-it`.
  `turn/completed` now includes raw `tokens`, normalized `usage`, `contextWindow`
  / `context_window`, and `usage.contextPercent`; the ALS adapter maps that into
  the existing `token_count` live/transcript shape where `total` is current
  context usage for the window percentage.
- Passed:
  bounded helper probe against framework-shell log
  `fs_1780763480_9d3b26ff.stdout.log`. The first OpenCode `read` request for
  `packages/opencode/src/cli/cmd/app-server.ts` produced an ALS `view` payload
  with title `app-server.ts  Lines 1-100`, `view_range: [1, 100]`, 100
  structured line rows, `truncated: true`, and `next: 101`.
- Passed:
  adapter helper probe for a successful `read` completion emitted exactly one
  live `view` event and exactly one `role: "view"` transcript entry, with no
  generic `tool_end` / `role: "tool"` card.
- Passed:
  synthetic extension transport probe for the audited OpenCode tool payloads.
  `read` with `structured.type: "text"` emitted `view`; `bash` with
  `structured.command/cwd/exitCode/output` emitted `shell_end` live plus
  `role: "command"` transcript; `edit` emitted a patch-style
  `tool: "apply_patch"` summary plus standalone `diff`; and `apply_patch`
  structured output emitted standalone diff rows for add/update/delete file
  operations, with delete hunks anchored from the old-side hunk line.
- Passed:
  direct source-wrapper provider/model probe showed `provider/list` returning
  `openai`, `opencode`, and `openrouter` in the current environment, and
  `model/list` for `opencode` returning 20 enabled OpenCode public models.
- Passed:
  `PATH=/data/data/com.termux/files/home/.bun/bin:$PATH /data/data/com.termux/files/home/.bun/bin/bun test test/cli/app-server/lifecycle.test.ts --timeout 90000`
  from `packages/opencode`. The current smoke covers
  `server/initialize`, `provider/list`, `model/list`, `session/create`,
  `session/status`, `session/list`, `session/resume`, `turn/start`, live
  `turn/contentDelta`, live `turn/completed`, idle `turn/cancel`, and
  `server/shutdown`. It also covers a real model-triggered native `write` tool
  approval flow: `turn/toolCallRequested`, `turn/toolApprovalRequested`,
  `turn/toolApproval/respond`, `turn/toolApprovalResolved`,
  `turn/toolCallCompleted`, continuation `turn/contentDelta`, and terminal
  `turn/completed`. The approval matrix now covers stale approval ids, reject
  replies, and saved `always` permissions. Rejected tool approvals emit a failed
  `turn/toolCallCompleted`, then OpenCode may continue the model turn and emit
  an overall `turn/completed` with `status: "completed"`. The initialize and
  create receive windows are longer than the first smoke because `app-server`
  now boots the native OpenCode session runtime.
- Passed:
  the focused subprocess lifecycle test also covers cancellation during a
  pending approval and cancellation during a hung continuation provider call.
  In both paths, OpenCode publishes `session.next.interrupt.requested`, the
  app-server emits exactly one terminal `turn/completed` notification with
  `status: "cancelled"`, and a subsequent turn can be admitted and completed.
- Passed:
  `python -m py_compile harness/als-rs/opencode-app-server-extension/client.py
  harness/als-rs/opencode-app-server-extension/transport.py
  harness/als-rs/opencode-app-server-extension/mock_app_server.py` from the
  OpenCode worktree root.
- Passed:
  direct live-source stdio smoke:
  `printf ... | /data/data/com.termux/files/home/.local/bin/opencode-spike
  app-server`, validating `server/initialize` and `server/shutdown` with
  JSON-RPC-only stdout.
- Passed:
  `/data/data/com.termux/files/usr/bin/tsgo --noEmit` from
  `packages/opencode`, using the locally compiled Termux `tsgo`.
- Passed:
  `PATH=/data/data/com.termux/files/home/.bun/bin:$PATH /data/data/com.termux/files/home/.bun/bin/bun typecheck`
  from `packages/opencode` after replacing the ignored local
  `node_modules/.bin/tsgo` and `packages/opencode/node_modules/.bin/tsgo`
  symlinks with `/data/data/com.termux/files/usr/bin/tsgo`. A narrow
  `ToolResultValue` type-cycle cleanup in `packages/llm` was needed so the
  locally compiled `tsgo` can complete the package check.
- Passed:
  `opencode-spike --help` through the local Bun-backed wrapper at
  `/data/data/com.termux/files/home/.local/bin/opencode-spike`.
- Passed:
  `opencode-spike-bin --version` and `opencode-spike-bin app-server`
  initialize/shutdown smoke through the compiled snapshot at
  `/data/data/com.termux/files/home/.local/bin/opencode-spike-bin`.

## Local Termux Install

Two local launchers are available for manual testing:

- `opencode-spike`: live-source wrapper installed at
  `/data/data/com.termux/files/home/.local/share/opencode-appserver-spike/bin/opencode-spike`
  and symlinked at `/data/data/com.termux/files/home/.local/bin/opencode-spike`.
  It runs:

  ```sh
  bun run --conditions=browser \
    /data/data/com.termux/files/home/test-projects/open-gemini-cli-appserver-spike/worktrees/opencode/packages/opencode/src/index.ts "$@"
  ```

  Use this while developing app-server code because it runs the active checkout.

- `opencode-spike-bin`: compiled snapshot installed at
  `/data/data/com.termux/files/home/.local/share/opencode-appserver-spike/bin/opencode-spike-bin`
  and symlinked at `/data/data/com.termux/files/home/.local/bin/opencode-spike-bin`.
  It was built from `packages/opencode` with:

  ```sh
  bun run script/build.ts --single --skip-install --skip-embed-web-ui
  ```

  The build emits `packages/opencode/dist/opencode-linux-arm64/bin/opencode`;
  that binary was copied into the local install directory. This is the best
  snapshot for checking normal TUI behavior without depending on live source
  transpilation.

The first compile attempt failed because `@opentui/core-linux-arm64` was
missing. Running the build script without `--skip-install`, or otherwise
installing the optional native OpenTUI packages, supplies that dependency. The
final successful build used `--skip-install` after those optional packages were
present.

## Second-Pass Source Grounding

The first pass above was written from project context only. The second pass
checked the OpenCode source and confirmed the following implementation anchors:

- The TUI already separates UI from runtime. `thread.ts` starts a worker and
  either talks to a real server or uses an internal transport with
  `createWorkerFetch(client)` and `createEventSource(client)`.
  See `packages/opencode/src/cli/cmd/tui/thread.ts:30`,
  `packages/opencode/src/cli/cmd/tui/thread.ts:48`, and
  `packages/opencode/src/cli/cmd/tui/thread.ts:201`.
- The TUI worker exposes `fetch` by calling `Server.Default().app.fetch(...)`
  and forwards global events with `Rpc.emit("global.event", event)`. That is a
  useful reference seam, but the app-server should not make HTTP fetch its
  primary protocol. See `packages/opencode/src/cli/cmd/tui/worker.ts:42` and
  `packages/opencode/src/cli/cmd/tui/worker.ts:49`.
- OpenCode has an intentional public native API for embeddings:
  `OpenCode.Service` in `packages/core/src/public/opencode.ts:23`. It exposes
  session create/get/list/prompt/switchModel/interrupt/messages/context/events
  around `packages/core/src/public/opencode.ts:90`.
- `SessionV2.Service` has the deeper native surface: create/list/get, prompt,
  wait, resume, interrupt, messages/context, shell, skill, compact, and
  switchModel. See `packages/core/src/session.ts:104`.
- `sessions.events()` is not sufficient for live app-server output. It filters
  to durable session events only, so it will not carry live-only text,
  reasoning, or tool-input deltas. See `packages/core/src/session.ts:340`.
- The live SSE endpoint uses `EventV2.Service.all()` and location filtering.
  The stdio app-server subscribes through `LocationServiceMap.get(session.location)`
  so it sees the same `EventV2.Service` used by the session runner, then
  translates events directly to JSON-RPC notifications.
  See `packages/server/src/handlers/v2/event.ts:18` and
  `packages/server/src/handlers/v2/event.ts:37`.
- OpenCode already defines the live and durable events we need: step lifecycle,
  text delta/end, reasoning delta/end, tool input/call/result, and permission
  ask/reply. See `packages/core/src/session/event.ts:176`,
  `packages/core/src/session/event.ts:224`,
  `packages/core/src/session/event.ts:261`, and
  `packages/core/src/session/event.ts:300`.
- The provider stream publisher already emits text deltas, reasoning deltas,
  tool input deltas, tool calls, and tool results. The app-server should
  translate these events, not parse provider chunks itself. See
  `packages/core/src/session/runner/publish-llm-event.ts:221`.
- Multiplexing is already a native OpenCode property. The session run
  coordinator runs at most one drain per session key while allowing different
  keys to drain concurrently. See
  `packages/core/src/session/run-coordinator.ts:12`.
- OpenCode permission requests are first-class events and services:
  `permission.v2.asked`, `permission.v2.replied`, `ask`, `assert`, `reply`,
  `forSession`, and `list`. See `packages/core/src/permission.ts:74` and
  `packages/core/src/permission.ts:118`.
- OpenRouter support is already in core as a provider plugin that wires
  `@openrouter/ai-sdk-provider` and provider catalog transforms. See
  `packages/core/src/plugin/provider/openrouter.ts:5`.

## Runtime Feasibility Notes

The stock OpenCode package is Bun-first:

- Root scripts use Bun, including `dev`, `typecheck`, and `postinstall`.
- `packages/opencode/src/index.ts` is the current full CLI entrypoint and is
  normally executed with `bun run --conditions=browser`.
- The existing subprocess test harness also spawns Bun.
- TUI and run-mode paths use Bun APIs such as `Bun.stdin.text()`,
  `Bun.stringWidth`, `Bun.file`, and `bun:ffi`.
- The newer `packages/cli` preview package still has a Bun shebang and a
  daemon service that calls `Bun.spawn`.

The source does have Node-compatible seams:

- `packages/core` declares conditional imports for `#sqlite` and `#pty` with
  Node implementations.
- `packages/core/src/database/sqlite.node.ts` uses `node:sqlite`.
- `packages/server/src/routes.ts` builds v2 HTTP routes directly from
  `@opencode-ai/core` services and Node HTTP platform layers.
- `packages/server/src/handlers.ts` wires `SessionV2`, `EventV2`,
  `LocationServiceMap`, `PermissionSaved`, `SessionExecutionLocal`,
  `SessionProjector`, and `SessionStore` without depending on the Bun TUI.
- `packages/core/src/location-layer.ts` is heavy, but it is native Effect layer
  wiring and not intrinsically Bun-only aside from package installation/runtime
  concerns.

Working hypothesis:

The app-server can probably be spiked as a Node-compatible subset if it avoids
`packages/opencode/src/index.ts`, TUI, run UI, Bun build scripts, and the Bun
daemon binary path. The first validation should be a tiny Node entrypoint that
imports or builds the needed core/server layer and exits cleanly. If that fails
because package installation or runtime imports still require Bun globally, use
glibc/proot Bun as the fallback.

## Non-Goals

- Do not tunnel raw HTTP routes through stdio as the primary public protocol.
- Do not make ALS-RS semantics part of OpenCode core.
- Do not preserve KaiDex checkpoint semantics.
- Do not port KaiDex provider-loop patches into OpenCode unless a specific bug
  requires a comparable fix.
- Do not reload ALS-RS or install this extension during the initial runtime
  spike unless explicitly requested.

## External Protocol Target

Keep the app-server method family we already validated through ALS-RS:

- `server/initialize`
- `server/shutdown`
- `provider/list`
- `model/list`
- `session/create`
- `session/status`
- `session/resume`
- `session/list`
- `session/delete`
- `session/close`
- `turn/start`
- `turn/cancel`
- `turn/toolApproval/respond`

Keep notifications in the same family:

- `turn/started`
- `turn/modelInfo`
- `turn/contentDelta`
- `turn/thoughtDelta`
- `turn/toolCallRequested`
- `turn/toolApprovalRequested`
- `turn/toolApprovalResolved`
- `turn/toolCallCompleted`
- `turn/error`
- `turn/completed`

The ALS extension scaffold copied into `harness/als-rs/opencode-app-server-extension`
should remain the test adapter for this protocol.

## Proposed Runtime Architecture

```text
opencode --app-server
  stdin line reader
    JSON-RPC request validation
      app-server method handlers
        OpenCode native services
          sessions
          event stream
          permissions
          model/provider catalog
          tools
  stdout line writer
    JSON-RPC responses
    JSON-RPC notifications
  stderr
    diagnostics only
```

The app-server process must keep stdout JSON-RPC-only. All logging and runtime
diagnostics must go to stderr.

## Direct Runtime Binding

Prefer direct calls into OpenCode's native service layer:

- create/list/get sessions through `SessionV2.Service` or the public
  `OpenCode.Service.sessions` facade
- start turns through `sessions.prompt(...)`
- force or continue queued work through `sessions.resume(...)` only when that
  behavior is explicitly requested by the app-server protocol
- cancel turns through `sessions.interrupt(...)`
- read session history through `sessions.messages(...)` and
  `sessions.context(...)`
- list models/providers through the catalog service, matching the existing
  HTTP handlers that call `catalog.provider.available()` and
  `catalog.model.available()`
- answer approvals through `Permission.Service.reply(...)`
- stream runtime output through `EventV2.Service.all()` or the same global
  event bus used by the TUI worker

The HTTP/SSE server should remain useful as a reference and fallback surface,
not as the primary app-server implementation.

Important correction from the source pass: `sessions.events(...)` is durable
replay only. It is useful for replay or audit, but it must not be the only live
notification source because `Text.Delta`, `Reasoning.Delta`, and
`Tool.Input.Delta` are live-only.

## Event Translation

Translate OpenCode runtime events into app-server notifications.

Expected mapping:

- `session.next.step.started` -> `turn/started` and `turn/modelInfo`
- `session.next.text.delta` -> `turn/contentDelta`
- `session.next.text.ended` -> final assistant transcript entry if the adapter
  needs replay-safe completion text
- `session.next.reasoning.delta` -> `turn/thoughtDelta`
- `session.next.reasoning.ended` -> final reasoning transcript entry if needed
- `session.next.tool.input.started/delta/ended` -> optional streamed tool input
  state for richer cards and debugging
- `session.next.tool.called` -> `turn/toolCallRequested`
- `permission.v2.asked` -> `turn/toolApprovalRequested`
- `permission.v2.replied` -> approval resolved state, if needed
- `session.next.tool.success` / `session.next.tool.failed` ->
  `turn/toolCallCompleted`
- `session.next.step.failed` -> `turn/error` plus terminal completion if
  appropriate
- `session.next.step.ended` -> `turn/completed`, including finish, cost, and
  token counts

Durable event replay and live event fan-out must be handled carefully. The app
server should not miss live-only deltas, and it should not duplicate durable
history when a client subscribes after a turn has already started.

## Session Semantics

OpenCode session ids should become provider session ids at the app-server
boundary.

ALS-RS mapping:

- ALS `conversation_id` stays host-local.
- OpenCode session id binds as `provider_session_id`.
- `thread_id` mirrors `provider_session_id` for older ALS/Codex-compatible
  plumbing.
- Adapter-owned active slot names can exist if needed, but should not cross into
  ALS metadata as durable provider identity.

OpenCode may not need a separate active slot concept if its native session id
is already sufficient for multiplexing and lazy continuation.

Source-pass refinement:

- OpenCode native session ids are `ses_...`.
- Reusing an existing OpenCode session id should adopt that session.
- `session/create` should create a real OpenCode session and return that
  provider session id.
- `session/status` should report whether the session exists and whether there
  is active/pending work.
- `session/resume` should be explicit. It should not silently create a missing
  session. A missing session should return an error unless the method later
  grows an explicit create-on-missing option.
- There is no need to correlate the ALS conversation label with the OpenCode
  session id. The label can be display metadata only.

## Provider And Model Settings

The OpenCode ALS settings surface should stay flat for the first usable slice:

- `provider` selects an OpenCode provider id.
- `model` selects a full model ref from OpenCode `model/list`.
- `reasoning_effort` maps to the selected OpenCode model variant.
- The `model` field declares `source_params.provider` plus provider
  `depends_on` / `refresh_on`, so ALS passes the selected provider into
  `extension.models.list` without knowing OpenCode's model payload shape.

The extension can use arbitrary schema/meta settings and map them to OpenCode's
runtime params. ALS should not treat the generic `model` widget as the semantic
owner of OpenCode model identity; the extension owns the provider/model/variant
translation.

Source-pass refinement:

- Provider/model listing uses OpenCode's catalog service rather than the copied
  KaiDex config registry.
- `model/list` should include provider/model metadata and model variant options
  so ALS can render dependent reasoning-effort options without hardcoding
  provider payload shapes.
- `model/variant/list` exposes the variant list directly for a provider/model
  pair. Variants must come from real OpenCode catalog metadata/configuration;
  do not synthesize OpenRouter reasoning-effort options to make a dropdown look
  populated.
- Variant metadata must not split between an app-server listing path and a
  different core validation/runner path. The shared ModelsDev runtime-variant
  logic now lives in core so `model/variant/list`, `session/create`,
  `session/resume`, `turn/start`, `switchModel`, and `SessionRunnerModel`
  request lowering agree on the same variants.
- `session/create` must reject an unavailable selected variant before creating
  the OpenCode session; otherwise ALS can bind a provider session id to a model
  config that fails on the first turn.
- The V2 session runner treats `@openrouter/ai-sdk-provider` catalog models
  with a base URL as OpenAI-compatible chat models, so selected OpenRouter
  models are no longer rejected by `SessionRunnerModel.UnsupportedApiError`
  before the provider call.
- Provider connection/authentication is a separate modal primitive. It needs
  provider auth method lists, dynamic prompt fields, secret/transient handling,
  external URL open support, OAuth callback/status interactions, and post-auth
  refresh/write-back actions.
- Provider-auth token/env handling still needs a generalized implementation.
  The direct OpenAI OAuth/token path works, but the fix must be lifted into a
  provider-neutral auth boundary rather than left as an OpenAI-only patch.
- Provider routes that require native instruction delivery must declare that via
  route/model metadata. `SessionRunnerLLM` should keep emitting provider-neutral
  system parts; route preparation and protocol lowering own whether those parts
  become regular system messages or a native `instructions` field.
- App-server-specific instructions are now session-scoped rather than
  location-global. `packages/core/src/session-instruction-overlay.ts` stores
  the current built-in app-server prompt plus ALS developer/user-developer
  entries per OpenCode session id, and `SessionRunnerLLM` includes that source
  in the V2 `SystemContext` epoch.
- The app-server built-in prompt is neutral about launch mode: it identifies the
  host platform, explains that the session is not the OpenCode TUI/interactive
  CLI unless explicitly asked, and gives the selected provider/model/variant id
  for direct model identity questions.
- V2 model resolution must preserve provider-owned request defaults from the
  real provider facade/catalog path. Required options such as stateless request
  mode, reasoning includes, service tier, and variant metadata must come from
  that route/model metadata, not from provider checks in the app-server runner.

## Approval Mapping

OpenCode permission requests should map to ALS approval cards through the copied
extension shape:

- OpenCode permission request id -> app-server approval id
- OpenCode action/resources/metadata -> approval details
- ALS accept once -> OpenCode permission reply `once`
- ALS accept always -> OpenCode permission reply `always`
- ALS reject -> OpenCode permission reply `reject`

Keep approval policy as host/extension configuration until OpenCode-specific
permission policy mapping is understood.

## Slice Plan

### Slice 0: Node Runtime Feasibility

- Prove a Node process can load the minimum app-server dependency graph.
- Prefer `packages/core` and `packages/server` v2 layers over
  `packages/opencode/src/index.ts`.
- Avoid TUI, run UI, and Bun CLI paths entirely.
- Confirm Node conditionals select `sqlite.node.ts` and not `sqlite.bun.ts`.
- Confirm the package manager/install path can be made to work without Bun, or
  clearly document that glibc/proot Bun is required for dependency install/build.

### Slice 1: Native Entrypoint And Protocol

- Add an OpenCode app-server entrypoint.
- Add line-framed stdio JSON-RPC transport.
- Keep stdout JSON-RPC-only.
- Implement `server/initialize` and `server/shutdown`.
- Add minimal protocol schemas/tests.
- Initialize the same core layers needed by `OpenCode.Service`, `SessionV2`,
  `EventV2`, `Catalog`, and `Permission`.

### Slice 2: Session And Catalog Methods

- [x] Implement `provider/list`.
- [x] Implement `model/list`.
- [x] Implement `session/create`.
- [x] Implement `session/list`.
- [x] Implement `session/status`.
- [ ] Defer `session/close` until the V2 runtime has a native close/unload
  semantic distinct from durable delete.
- [x] Implement `session/resume` as an explicit resume/drain request for an
  existing session, not as implicit create.
- Return errors for missing sessions unless an explicit create method was used.

### Slice 3: Turn Start And Event Fan-Out

- [x] Implement `turn/start`.
- [x] Subscribe to the session location's `EventV2.Service.listen(...)`, not
  only `sessions.events(...)`.
- [x] Correlate session events to app-server `turnId`.
- [x] Emit `turn/started`, `turn/modelInfo`, `turn/contentDelta`,
  `turn/thoughtDelta`, tool notifications, errors, and `turn/completed`.
- [x] Include normalized token usage and context-window percentage on
  `turn/completed`, then fan it out through ALS's existing `token_count` event.
- [x] Implement `turn/cancel` through native session interruption.
- [x] Validate with a cheap OpenRouter model after the fake-LLM subprocess smoke
  is stable.
- [x] Watch explicit session drains after `turn/start` admission so provider or
  runner failures emit terminal `turn/error` and failed `turn/completed`
  notifications instead of silently hanging the RPC turn.

### Slice 4: Approvals

- [x] Map OpenCode `permission.v2.asked` events to
  `turn/toolApprovalRequested`.
- [x] Map OpenCode `permission.v2.replied` events to
  `turn/toolApprovalResolved`.
- [x] Implement `turn/toolApproval/respond`.
- [x] Validate accept once against a real tool-triggered permission request.
- [ ] Validate accept always, reject, and stale approval behavior against real
  tool-triggered permission requests.

### Slice 5: ALS-RS Adapter Port

- Point the copied `opencode-app-server` ALS extension at the real app-server
  entrypoint.
- Replace the copied config-generator settings surface with flat provider,
  model, and reasoning-effort controls backed by OpenCode catalog RPC.
- Validate settings schema, session binding, approvals, reasoning, tool events,
  diff cards, and terminal turn lifecycle through ALS.

### Slice 6: MCP Tool Bridge

- [x] Advertise MCP capability in `server/initialize`.
- [x] Accept strict typed `mcpServers` maps on `session/create`,
  `session/resume`, and `turn/start`.
- [x] Connect remote MCP servers through the MCP SDK streamable HTTP or SSE
  transports, connect local MCP servers through stdio, list their tools, and
  attach those tools to OpenCode's process-scoped `ApplicationTools` registry as
  Core native tools.
- [x] Synchronize attachments only when an explicit `mcpServers` payload is
  present. Sending `{}` revokes the current app-server MCP attachments; omitting
  the field leaves the existing bridge state unchanged.
- [x] Translate ALS `mcp_context.defaults["te2-mcp"]` into a typed remote server
  entry pointed at `/te2_mcp_http` when the shared `te2_mcp_integration` setting
  is enabled.
- [x] Translate ALS `mcp_context.defaults["agent-pty-blocks"]` into a typed local
  stdio MCP server using ALS's `mcp_agent_pty_server.py`, with the ALS
  conversation id, cwd, and appserver origin supplied through the local MCP
  environment.
- [x] Consume ALS `devins_context.effective` as session-scoped developer
  instructions so the TE2 template, user devins, and repo memory reach OpenCode
  through the same runtime bundle switch.
- [x] Strip `mcp_context`, `mcpServers`, `mcp_servers`, and
  `__als_devins_context__` from persisted conversation settings so MCP/devins
  state remains runtime-configured rather than leaking into `meta.settings`.
- [ ] Live-validate the `TE2 MCP Integration` checkbox through ALS after install
  and extension reload.
- [x] Install the updated ALS extension with `extension install --no-notify-server`;
  live reload/validation remains the next manual step.
- [ ] Generalize explicit provider-auth/OAuth MCP flows after TE2 streamable
  HTTP validation is stable.

Important boundary: the shared `TE2 MCP Integration` setting is an ALS runtime
bundle switch for this extension. When ALS supplies the runtime side channels,
the extension consumes the effective devins context plus the MCP defaults that
ALS provides; it does not persist those side channels into conversation meta.

### Slice 7: Schema And Debug Validation

- Export or derive a JSON Schema for the stdio protocol.
- Validate incoming JSON-RPC requests in debug/test mode.
- Optionally validate outgoing notifications in debug/test mode.
- Keep FWS shellspec validation as a development-only harness check, not an
  OpenCode runtime dependency.

### Slice 8: Release-Tag Maintenance

- Keep active feature work on the current skew when rebasing would interrupt an
  in-flight slice, but do not treat an arbitrary `dev` commit as the long-term
  base.
- Track upstream release-style tags and periodically rebase the app-server work
  to the latest major/minor release tag. Patch releases can be skipped when they
  do not affect this work, but `1.1x`-style major/minor movement should be kept
  current.
- Preferred update workflow: export the app-server/ALS diff stack, concatenate
  or pipe the diffs through quilt, dry-run/apply them onto the target tag, fix
  conflicts deliberately, then rerun the non-ALS validation ladder before live
  extension validation.
- Current note: this checkout is not exactly on a tag. At the time this note was
  written, local release tags topped out at `v1.16.2` while upstream had
  `v1.17.4`; do not rebase as part of the instruction/devin slice unless the
  user explicitly asks for that migration.

## Validation Ladder

1. Unit tests for protocol parse/validate/encode.
2. Direct stdio smoke with fake handlers.
3. Direct stdio smoke against real OpenCode session create/list.
4. Direct provider-backed turn with cheap OpenRouter model.
5. Direct approval/tool flow.
6. ALS-RS extension install without reload.
7. ALS-RS live reload and framework-shell validation.

## Risks And Unknowns

- Exact OpenCode service initialization path for an app-server entrypoint.
- Whether the app-server should run in the main CLI process or follow the TUI
  pattern and start a worker process.
- Exact Effect runtime/layer composition needed outside the HTTP server and TUI.
- How to subscribe to `EventV2.Service.all()` from the app-server entrypoint
  without accidentally binding to the wrong location/workspace.
- How OpenCode correlates step/message ids to external turn ids.
- Whether OpenCode's native session id alone is enough for multiplexed app-server
  runtime slots.
- Exact provider config format for OpenRouter/manual API saved configs.
- How approval metadata maps to ALS diff cards for file edits.
- Whether OpenCode already exposes enough schema material to generate JSON
  Schema cleanly, or whether a separate Zod/Effect-schema bridge is needed.
- Whether ALS wants a thin `sessionName` compatibility field for display only,
  even though OpenCode's real provider id is the durable `ses_...` id.

## Current Scaffold

The copied ALS extension scaffold lives at:

```text
harness/als-rs/opencode-app-server-extension
```

It currently runs a mock stdio app-server and preserves the useful ALS adapter
work from the KaiDex spike. It should be treated as a porting scaffold, not as a
finished OpenCode runtime adapter.
