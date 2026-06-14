# OpenCode App-Server ALS-RS Extension Scaffold

This is a copied and renamed ALS-RS extension scaffold for an OpenCode-backed
stdio JSON-RPC app-server.

The package intentionally preserves the useful host-adapter pieces from the
Gemini/KaiDex spike:

- manifest and framework-shells pipe launch shape
- strict JSON-RPC client transport
- ALS conversation/provider-session binding semantics
- live/transcript fan-out helpers
- reasoning, assistant, tool, diff, and lifecycle event mapping
- approval request-card module and approval response routing
- flat provider/model/reasoning settings schema

The current shellspec launches this checkout's route-backed source runtime
directly:

```text
/data/data/com.termux/files/home/.bun/bin/bun run --conditions=browser /data/data/com.termux/files/home/test-projects/opencode/packages/opencode/src/index.ts app-server
```

The shellspec pins `OPENCODE_DB=opencode-dev.db` to preserve current local CLI
database parity.

`mock_app_server.py` remains in this scaffold only as a small protocol fixture
and reference implementation.

## Boundary

- OpenCode should own the runtime: sessions, provider config, event stream,
  permissions, tool execution, and model/provider catalog.
- This extension should own ALS-RS adapter concerns: manifest, shellspec,
  request routing, provider-session binding, transcript/live fan-out, approval
  card shape, and settings schema.
- ALS-RS conversation ids must stay host-local. The durable provider bind is
  `provider_session_id`, mirrored to `thread_id` only for compatibility.

## Install

From the ALS-RS repo:

```bash
python -c 'from agent_log_server_rs.bootstrap import main; raise SystemExit(main(["extension", "install", "--path", "/data/data/com.termux/files/home/test-projects/opencode/harness/als-rs/opencode-app-server-extension", "--no-notify-server"]))'
```

Do not reload the extension adapter unless the current validation plan calls for
it.

## Runtime Shape

- manifest id: `opencode-app-server`
- extension type: `opencode_app_server`
- framework-shells backend: `pipe`
- shellspec id: `opencode_app_server_observed`
- transport label: `app-server:opencode-extension`
- inspect hints: `json`, `jsonrpc`

The OpenCode app-server process must write only JSON-RPC objects to stdout.
Diagnostics must go to stderr.

## Porting Notes

The extension still speaks the inherited app-server protocol names:

- `server/initialize`
- `provider/list`
- `session/create`
- `session/status`
- `session/resume`
- `session/list`
- `session/delete`
- `session/close`
- `turn/start`
- `turn/cancel`
- `turn/toolApproval/respond`

The preferred OpenCode runtime implementation is route-backed without opening a
TCP listener: strict stdio JSON-RPC dispatches through OpenCode's generated
route client and `Server.Default().app.fetch(...)`, then translates route events
into the same host-facing app-server notifications expected by this extension.

The adapter treats `sessionName` as an ALS-local runtime slot only. The durable
provider bind is the OpenCode `ses_...` id returned as `sessionId`,
`providerSessionId`, or `threadId` by the app-server.

## Settings

The active settings schema is intentionally flat:

- `provider` selects an OpenCode provider id.
- `model` selects a full OpenCode model ref from `model/list`, filtered by the
  selected provider through ALS `source_params`.
- `reasoning_effort` derives its options from the selected model's OpenCode
  variants.

Provider connection/authentication is a separate schema-modal primitive. The
extension may still keep compatibility helpers for older config-generator
interactions, but runtime settings should map directly to OpenCode provider,
model, and variant params.
