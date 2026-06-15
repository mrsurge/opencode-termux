# OpenCode ALS Transcript Card Mapping Tracker

## Purpose

Track the extension-local mapping between OpenCode stdio app-server tool
notifications and ALS-RS generic transcript card contracts.

Source contract:

- `/data/data/com.termux/files/home/test-projects/als_rs/TRANSCRIPT_CARD_CONTRACTS.md`

This tracker is adapter-scoped. OpenCode core should continue emitting provider
runtime events; the ALS extension owns the conversion into ALS `view`,
`command`, `diff`, `search`, and generic `tool` rows.

## Audit Source

Initial live app-server log audited:

- `/data/data/com.termux/files/home/.cache/framework_shells/runtimes/b4f2d44683b344a8/0a37fcbc242ec454/logs/fs_1780858173_3f8ab9a4.stdout.log`

Follow-up live app-server log audited:

- `/data/data/com.termux/files/home/.cache/framework_shells/runtimes/b4f2d44683b344a8/0a37fcbc242ec454/logs/fs_1780871923_b8227534.stdout.log`

ALS conversation audited:

- `conv_1780796383514_29380`

OpenCode turn audited:

- `3e7a33aa0cbd4a89bde7ae2d7f7e649d`

Audit result:

- Upstream emitted enough structure for specialized cards.
- ALS transcript recorded 30 tool completions as generic `role: "tool"`.
- ALS transcript recorded zero `role: "view"`, zero `role: "diff"`, and zero
  `role: "command"` rows for the audited turn.

## Mapping Checklist

- [x] Map successful `read` completions with `structured.type: "text"` and
  `structured.content` to ALS `view` live/transcript rows.
- [x] Keep existing `read` support for `structured.type: "text-page"`.
- [x] Suppress the redundant generic tool card for successful read views.
- [x] Map real `bash` completions with `structured.command`,
  `structured.cwd`, `structured.exitCode`, and `structured.output` to ALS
  `command` transcript rows and shell live events.
- [x] Derive shell success/failure from `structured.exitCode` when present.
- [x] Normalize successful `edit` old-string/new-string completions to
  patch-style `tool: "apply_patch"` summary rows.
- [x] Extract fenced ```diff blocks from successful `edit` results and emit
  standalone ALS `diff` cards with file headers and the request path.
- [x] Normalize successful `apply_patch` completions to patch-style
  `tool: "apply_patch"` summary rows.
- [x] Route OpenCode V2 `apply_patch` structured output
  `applied[].patch` into standalone ALS `diff` cards.
- [x] Suppress generic `tool_begin` live cards for tools that have specialized
  ALS cards: `read`, `bash`, `grep`, `edit`, and `apply_patch`.
- [x] Keep patch-style summary cards sanitized: raw patch bodies and
  old-string/new-string payloads stay out of the visible tool card payload and
  render through standalone `diff` cards instead.
- [x] Map successful `grep` completions to ALS `search` live/transcript rows.
- [x] Add `line` to diff rows when the unified diff hunk contains a numeric
  target line.
- [x] Keep live `apply_patch` diff cards output-driven: if the tool completion
  does not include structured patch metadata, the extension emits no synthetic
  diff card.
- [x] Anchor delete hunks from the old-side hunk line and add/update hunks from
  the new-side hunk line.
- [x] Strip legacy unified diff `Index:` / separator prelude lines from ALS
  diff card text while preserving `---` / `+++` headers and hunk anchors.
- [x] Map successful OpenCode `todowrite` completions with `structured.todos`
  into ALS `plan_state`, `plan_update`, and final transcript `role: "plan"`
  rows.

## Observed OpenCode Shapes

### Read

Request:

```json
{
  "tool": "read",
  "input": { "path": "public/js/main.js" }
}
```

Completion:

```json
{
  "structured": {
    "type": "text",
    "content": "...",
    "mime": "text/javascript"
  },
  "result": {
    "type": "json",
    "value": {
      "type": "text",
      "content": "...",
      "mime": "text/javascript"
    }
  }
}
```

Target ALS contract:

- live `type: "view"`
- transcript `role: "view"`
- include `path`, `content`, optional `lines`, `view_range`, and `title`

### Bash

Request:

```json
{
  "tool": "bash",
  "input": {
    "command": "git status --short",
    "workdir": ".",
    "description": "Show dirty working tree status"
  }
}
```

Completion:

```json
{
  "structured": {
    "command": "git status --short",
    "cwd": "/data/data/com.termux/files/home/test-projects/node-3d-cube",
    "exitCode": 0,
    "output": " M package.json\n",
    "truncated": false
  }
}
```

Target ALS contract:

- live shell end event
- transcript `role: "command"`
- include `command`, `cwd`, `output`, `exit_code`, `status`, and `is_error`

### Edit

Request:

```json
{
  "tool": "edit",
  "input": {
    "path": "public/index.html",
    "oldString": "    <h1>Tesseract</h1>\n",
    "newString": "    <h1>Cube</h1>\n",
    "replaceAll": false
  }
}
```

Completion:

~~~text
Edited file successfully: public/index.html
Replacements: 1
```diff
-    <h1>Tesseract</h1>
-
+    <h1>Cube</h1>
+
```
~~~

Target ALS contract:

- generic tool summary normalized to `tool: "apply_patch"`
- standalone `diff` row containing a unified diff for visible patch rendering
- generic tool summary must not include the fenced diff body

### Apply Patch

Request:

```text
*** Begin Patch
*** Delete File: public/js/tesseract.js
*** Add File: public/js/cube.js
+...
*** Update File: public/js/main.js
...
*** End Patch
```

Completion:

```json
{
  "structured": {
    "applied": [
      {
        "type": "delete",
        "resource": "public/js/tesseract.js",
        "target": "public/js/tesseract.js",
        "patch": "@@ -1,10 +0,0 @@\n-...",
        "additions": 0,
        "deletions": 10
      }
    ],
    "diff": "@@ -1,10 +0,0 @@\n-..."
  },
  "result": {
    "type": "text",
    "value": "Applied patch sequentially:\nD public/js/tesseract.js"
  }
}
```

Target ALS contract:

- generic tool summary normalized to `tool: "apply_patch"`
- standalone `diff` rows derived from `structured.applied[].patch`
- generic tool summary must not include raw `patchText`
- if structured patch metadata is absent, emit no diff row instead of deriving
  from the request body

### Grep

Request:

```json
{
  "tool": "grep",
  "input": {
    "pattern": "cube|Cube|3D cube|tesseract|Tesseract",
    "path": "public",
    "include": "*.{js,html,css}",
    "limit": 100
  }
}
```

Completion:

```json
{
  "structured": {
    "items": [],
    "truncated": false,
    "partial": false
  },
  "result": {
    "type": "text",
    "value": "No files found"
  }
}
```

Target ALS contract:

- live `type: "search"`
- transcript `role: "search"`
- include `mode`, `path`, `pattern`, `arguments`, and `content`

### TodoWrite

Request:

```json
{
  "tool": "todowrite",
  "input": {
    "todos": [
      {
        "content": "Inspect current event bus and worker-loop wiring",
        "status": "in_progress",
        "priority": "high"
      }
    ]
  }
}
```

Completion:

```json
{
  "structured": {
    "todos": [
      {
        "content": "Inspect current event bus and worker-loop wiring",
        "status": "completed",
        "priority": "high"
      }
    ],
    "truncated": false
  }
}
```

Target ALS contract:

- live `type: "plan_state"` authoritative todo snapshot
- live `type: "plan_update"` checklist update
- final transcript `role: "plan"` row at turn completion
- extension advertises `hasTodo: true`; `hasPlan` remains false

## Validation Plan

- [x] Run `basedpyright --outputjson` from this extension directory.
- [x] Run `python -m py_compile client.py transport.py mock_app_server.py`.
- [x] Run synthetic in-process transport probes for:
  - read text -> one `view`, no generic tool card
  - bash -> one command transcript row
  - edit -> patch-style tool row plus standalone diff row
  - apply_patch structured output -> patch-style tool row plus standalone diff
    rows
- [x] Run synthetic in-process transport probe for:
  - bash -> no generic `tool_begin`, one `shell_end` / `command`
  - apply_patch -> sanitized tool summary plus structured standalone diffs
    with line anchors
  - grep -> one `search` card
- [x] Run synthetic in-process transport probe for structured `apply_patch`
  add/update/delete hunks. Result: all three diff rows anchored to line 1, with
  delete anchored from the old-side hunk.
- [x] Run synthetic in-process transport probe for missing `apply_patch`
  structured metadata. Result: no diff rows emitted.
- [x] Replay the audited `fs_1780871923_b8227534` tool notifications through
  the adapter. Initial result before the todo slice: `bash` mapped to 9
  commands, `apply_patch` mapped to 1 sanitized summary plus 7 diffs, `grep`
  mapped to 1 search card, and `todowrite` identified the remaining generic
  card gap.
- [x] Replay the audited `fs_1781405315_bb1e8852` tool notifications through
  the adapter. Result: `todowrite` maps to plan updates, apply_patch diffs
  omit legacy `Index:` prelude lines, and no raw todo tool card is emitted.
- [x] Run `git diff --check` from the OpenCode worktree root.
