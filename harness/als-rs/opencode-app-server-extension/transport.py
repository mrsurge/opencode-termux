from __future__ import annotations

import asyncio
import contextlib
import difflib
import importlib
import json
import os
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Protocol, TypeGuard, cast

from extensions.message_card_contracts import (
    build_assistant_delta_event,
    build_assistant_finalize_event,
    build_message_transcript_entry,
    build_reasoning_delta_event,
    build_reasoning_finalize_event,
    build_reasoning_transcript_entry,
)
from extensions.tool_card_contracts import build_tool_card_request, build_tool_card_response

JSONRPC_VERSION = "2.0"
TRANSPORT_LABEL = "app-server:opencode-extension"
SHELLSPEC_ID = "opencode_app_server_observed"
DEFAULT_TURN_TIMEOUT_SECONDS = 1800.0
SESSION_NOT_FOUND_CODE = -32010
FILE_CHANGE_TOOLS = {"write_file", "replace_smart", "replace_exact", "apply_patch", "edit"}
PATCH_STYLE_TOOLS = {"write_file", "replace_smart", "replace_exact", "apply_patch", "edit"}
READ_VIEW_TOOLS = {"read", "read_file"}
COMMAND_TOOLS = {"bash"}
SEARCH_TOOLS = {"grep"}
USER_INPUT_TOOLS = {"question"}
USER_INPUT_REQUEST_METHOD = "turn/userInputRequested"
SPECIALIZED_TOOL_CARDS = PATCH_STYLE_TOOLS | READ_VIEW_TOOLS | COMMAND_TOOLS | SEARCH_TOOLS | USER_INPUT_TOOLS


class OpenCodeAppServerRpcError(RuntimeError):
    def __init__(self, message: str, *, code: Optional[int] = None, data: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class _PipeWriter(Protocol):
    def write(self, data: bytes) -> object: ...

    async def drain(self) -> object: ...


class _OutputSubscription(Protocol):
    async def get(self) -> bytes | None: ...


class _PipeProcess(Protocol):
    stdin: _PipeWriter | None
    returncode: int | None


class _PipeState(Protocol):
    process: _PipeProcess


class _ShellRecord(Protocol):
    id: str
    status: str
    label: str | None
    spec_id: str | None


class ShellManager(Protocol):
    async def get_shell(self, shell_id: str) -> _ShellRecord | None: ...

    async def list_shells(self) -> list[_ShellRecord]: ...

    async def terminate_shell(self, shell_id: str, force: bool = False) -> object: ...

    def get_pipe_state(self, shell_id: str) -> _PipeState | None: ...

    async def subscribe_output_bytes(self, shell_id: str) -> _OutputSubscription: ...

    async def unsubscribe_output_bytes(self, shell_id: str, subscription: _OutputSubscription) -> object: ...

    async def write_to_pipe(self, shell_id: str, data: str) -> object: ...


class _ShellStarterRecord(Protocol):
    id: str


class _Orchestrator(Protocol):
    async def start_from_ref(
        self,
        ref: str,
        *,
        base_dir: Path,
        ctx: Dict[str, str],
        label: str,
        wait_ready: bool,
    ) -> _ShellStarterRecord: ...


class _OrchestratorFactory(Protocol):
    def __call__(self, mgr: ShellManager) -> _Orchestrator: ...


def _is_object_dict(value: object) -> TypeGuard[Dict[str, object]]:
    return isinstance(value, dict)


def _object_dict(value: object) -> Dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Iterable[tuple[object, object]], value.items())}


def _optional_int(value: object) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _optional_number(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _optional_str(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _provider_session_id(value: Mapping[str, object] | None) -> str:
    if not value:
        return ""
    return (
        _optional_str(value.get("providerSessionId"))
        or _optional_str(value.get("provider_session_id"))
        or _optional_str(value.get("sessionId"))
        or _optional_str(value.get("session_id"))
        or _optional_str(value.get("threadId"))
        or _optional_str(value.get("thread_id"))
        or _optional_str(value.get("id"))
        or ""
    )


def _safe_id_fragment(value: str) -> str:
    text = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value).strip("_")
    return text or "default"


def _message_stream_key(turn_id: str, text_id: object) -> str:
    if isinstance(text_id, str) and text_id:
        return f"{turn_id}:{_safe_id_fragment(text_id)}"
    return f"{turn_id}:default"


def _reasoning_segment_key(turn_id: str, index: int) -> str:
    return f"{turn_id}:reasoning:{index}"


def _utc_ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _turn_status(status: object) -> str:
    normalized = str(status or "").strip().lower().replace("-", "_")
    if normalized in {"completed", "complete", "success", "succeeded", "ok"}:
        return "success"
    if normalized in {"cancelled", "canceled", "interrupted", "aborted"}:
        return "interrupted"
    if normalized in {"failed", "failure", "error"}:
        return "failed"
    return normalized or "success"


def _status_dot(status: str) -> str:
    if status == "failed":
        return "error"
    if status == "interrupted":
        return "warning"
    return "success"


def _first_number(*values: object) -> Optional[float]:
    for value in values:
        number = _optional_number(value)
        if number is not None:
            return number
    return None


def _sum_numbers(*values: object) -> Optional[float]:
    numbers = [_optional_number(value) for value in values]
    present = [value for value in numbers if value is not None]
    if not present:
        return None
    return float(sum(present))


def _turn_usage(params: Dict[str, object]) -> Dict[str, object]:
    usage = _object_dict(params.get("usage"))
    tokens = _object_dict(params.get("tokens"))
    cache = _object_dict(tokens.get("cache"))
    input_tokens = _first_number(usage.get("input"), usage.get("inputTokens"), usage.get("input_tokens"), tokens.get("input"))
    output_tokens = _first_number(usage.get("output"), usage.get("outputTokens"), usage.get("output_tokens"), tokens.get("output"))
    reasoning_tokens = _first_number(
        usage.get("reasoning"),
        usage.get("reasoningTokens"),
        usage.get("reasoning_tokens"),
        tokens.get("reasoning"),
    )
    cache_read = _first_number(
        usage.get("cacheRead"),
        usage.get("cache_read"),
        usage.get("cachedInputTokens"),
        cache.get("read"),
    )
    cache_write = _first_number(usage.get("cacheWrite"), usage.get("cache_write"), cache.get("write"))
    context_window = _first_number(
        usage.get("contextWindow"),
        usage.get("context_window"),
        params.get("contextWindow"),
        params.get("context_window"),
    )
    context_used = _first_number(
        usage.get("contextUsed"),
        usage.get("context_used"),
        _sum_numbers(input_tokens, cache_read, cache_write),
    )
    total = _first_number(usage.get("total"), tokens.get("total"), _sum_numbers(input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write))
    if context_used is None and total is None:
        return {}

    result: Dict[str, object] = {"total": int(context_used if context_used is not None else total or 0)}
    if input_tokens is not None:
        result["input_tokens"] = int(input_tokens)
    if output_tokens is not None:
        result["output_tokens"] = int(output_tokens)
    if reasoning_tokens is not None:
        result["reasoning_tokens"] = int(reasoning_tokens)
    if cache_read is not None:
        result["cached_input_tokens"] = int(cache_read)
    if cache_write is not None:
        result["cache_write_tokens"] = int(cache_write)
    if context_window is not None:
        result["context_window"] = int(context_window)
    if total is not None:
        result["token_total"] = int(total)
    if context_used is not None:
        result["context_used"] = int(context_used)
    if context_used is not None and context_window and context_window > 0:
        result["context_percent"] = context_used / context_window
    return result


def _result_value(result: object) -> object:
    if isinstance(result, str):
        return result
    return _object_dict(result).get("value")


def _result_text(result: object) -> str:
    value = _result_value(result)
    if isinstance(value, str):
        return value
    return ""


def _normalize_diff_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("/")


def _diff_git_path(path: str, *, prefix: str) -> str:
    normalized = _normalize_diff_path(path)
    if not normalized:
        return "/dev/null"
    return f"{prefix}/{normalized}"


def _diff_with_headers(
    *,
    diff: str,
    path: str,
    new_path: str = "",
    new_file: bool = False,
    deleted_file: bool = False,
) -> str:
    diff_text = diff.strip("\n")
    if not diff_text:
        return ""
    if diff_text.startswith("diff --git ") or diff_text.startswith("Index: "):
        return f"{diff_text}\n"
    target_path = new_path or path
    old_header = "/dev/null" if new_file else _diff_git_path(path, prefix="a")
    new_header = "/dev/null" if deleted_file else _diff_git_path(target_path, prefix="b")
    mode = "new file mode 100644\n" if new_file else "deleted file mode 100644\n" if deleted_file else ""
    return (
        f"diff --git {_diff_git_path(path, prefix='a')} {_diff_git_path(target_path, prefix='b')}\n"
        f"{mode}"
        f"--- {old_header}\n"
        f"+++ {new_header}\n"
        f"{diff_text}\n"
    )


def _unified_diff_from_strings(*, path: str, old: str, new: str) -> str:
    diff_lines = difflib.unified_diff(
        old.splitlines(),
        new.splitlines(),
        fromfile=_diff_git_path(path, prefix="a"),
        tofile=_diff_git_path(path, prefix="b"),
        lineterm="",
    )
    return "\n".join(diff_lines).strip("\n") + "\n"


def _extract_fenced_diff(text: str) -> str:
    match = re.search(r"```diff\s*\n(.*?)```", text, flags=re.DOTALL)
    if not match:
        return ""
    return match.group(1)


def _strip_fenced_diff(text: str) -> str:
    return re.sub(r"\n?```diff\s*\n.*?```", "", text, flags=re.DOTALL).strip()


def _diff_first_hunk_line(diff: str, *, deleted_file: bool = False) -> Optional[int]:
    for line in diff.splitlines():
        if not line.startswith("@@"):
            continue
        match = re.search(r"-(\d+)", line) if deleted_file else re.search(r"\+(\d+)", line)
        if match:
            return int(match.group(1))
    return None


def _file_change_operation(file_change: Mapping[str, object]) -> str:
    operation = _optional_str(file_change.get("operation"))
    if operation:
        return operation
    if file_change.get("new_file") is True:
        return "add"
    diff = str(file_change.get("text") or "")
    if "\ndeleted file mode " in diff:
        return "delete"
    if "\nnew file mode " in diff:
        return "add"
    return "modify"


def _file_change_summary(file_change: Mapping[str, object]) -> Dict[str, object]:
    summary: Dict[str, object] = {
        "path": str(file_change.get("path") or ""),
        "operation": _file_change_operation(file_change),
    }
    target = _optional_str(file_change.get("target"))
    if target:
        summary["target"] = target
    line = _optional_int(file_change.get("line"))
    if line is not None:
        summary["line"] = line
    if file_change.get("new_file") is True:
        summary["new_file"] = True
    return summary


def _patch_summary_text(result: object, file_changes: List[Dict[str, object]]) -> str:
    text = _strip_fenced_diff(_result_text(result))
    if text:
        return text
    return "\n".join(
        f"{str(_file_change_operation(file_change)).upper()} {str(file_change.get('path') or '')}".rstrip()
        for file_change in file_changes
    )


def _tool_display_arguments(
    *,
    tool_name: str,
    arguments: Dict[str, object],
    file_changes: List[Dict[str, object]],
) -> Dict[str, object]:
    normalized_tool = tool_name.strip().lower()
    if normalized_tool not in PATCH_STYLE_TOOLS:
        return dict(arguments)
    files = [_file_change_summary(file_change) for file_change in file_changes]
    display: Dict[str, object] = {
        "source_tool": tool_name,
        "files": files,
    }
    path = (
        _optional_str(arguments.get("path"))
        or _optional_str(arguments.get("filePath"))
        or _optional_str(arguments.get("file_path"))
        or _optional_str(arguments.get("absolute_path"))
        or (str(files[0].get("path") or "") if files else "")
    )
    if path:
        display["path"] = path
    replace_all = arguments.get("replaceAll")
    if isinstance(replace_all, bool):
        display["replaceAll"] = replace_all
    return display


def _tool_display_result(
    *,
    tool_name: str,
    result: object,
    file_changes: List[Dict[str, object]],
) -> object:
    if tool_name.strip().lower() not in PATCH_STYLE_TOOLS:
        return result
    return {
        "type": "text",
        "value": _patch_summary_text(result, file_changes),
    }


def _file_change_payload(
    *,
    tool_call_id: str,
    turn_id: str,
    index: int,
    diff: str,
    path: str,
    tool: str,
    source_tool: str,
    new_file: bool = False,
    operation: str = "",
    target: str = "",
) -> Dict[str, object]:
    diff_id = (
        f"{tool_call_id}:diff"
        if tool_call_id and index == 0
        else f"{tool_call_id}:diff:{index + 1}" if tool_call_id else f"{turn_id}:diff:{uuid.uuid4().hex}"
    )
    payload: Dict[str, object] = {
        "id": diff_id,
        "text": diff,
        "path": path,
        "tool": tool,
        "source_tool": source_tool,
        "tool_call_id": tool_call_id,
        "new_file": new_file,
    }
    if operation:
        payload["operation"] = operation
    if target:
        payload["target"] = target
    line = _diff_first_hunk_line(diff, deleted_file=operation == "delete")
    if line is not None:
        payload["line"] = line
    return payload


def _tool_file_changes(
    *,
    tool_name: str,
    tool_call_id: str,
    turn_id: str,
    arguments: Dict[str, object],
    result: object,
    structured: object,
) -> List[Dict[str, object]]:
    normalized_tool = tool_name.strip().lower()
    if normalized_tool == "edit":
        return _edit_file_changes(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            arguments=arguments,
            result=result,
            structured=structured,
        )
    if normalized_tool == "apply_patch":
        return _apply_patch_structured_file_changes(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            structured=structured,
        )
    result_dict = _object_dict(result)
    diff = _optional_str(result_dict.get("fileDiff")) or _optional_str(result_dict.get("diff"))
    if not diff:
        return []
    if normalized_tool not in FILE_CHANGE_TOOLS and not result_dict.get("fileName"):
        return []
    path = (
        _optional_str(result_dict.get("filePath"))
        or _optional_str(result_dict.get("path"))
        or _optional_str(arguments.get("file_path"))
        or _optional_str(arguments.get("absolute_path"))
        or _optional_str(arguments.get("path"))
        or _optional_str(result_dict.get("fileName"))
        or ""
    )
    original_content = result_dict.get("originalContent")
    new_file = normalized_tool == "write_file" and original_content == ""
    display_tool = "apply_patch" if normalized_tool in PATCH_STYLE_TOOLS else tool_name
    return [
        _file_change_payload(
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            index=0,
            diff=_diff_with_headers(diff=diff, path=path, new_file=new_file),
            path=path,
            tool=display_tool,
            source_tool=tool_name,
            new_file=new_file,
        )
    ]


def _edit_file_changes(
    *,
    tool_name: str,
    tool_call_id: str,
    turn_id: str,
    arguments: Dict[str, object],
    result: object,
    structured: object,
) -> List[Dict[str, object]]:
    structured_dict = _object_dict(structured)
    path = (
        _optional_str(arguments.get("path"))
        or _optional_str(arguments.get("file_path"))
        or _optional_str(structured_dict.get("resource"))
        or _optional_str(structured_dict.get("target"))
        or ""
    )
    old_string = _optional_str(arguments.get("oldString")) or _optional_str(arguments.get("old_string"))
    new_string = _optional_str(arguments.get("newString")) or _optional_str(arguments.get("new_string"))
    diff = _unified_diff_from_strings(path=path, old=old_string, new=new_string) if old_string is not None and new_string is not None else ""
    if not diff:
        fenced_diff = _extract_fenced_diff(_result_text(result))
        diff = _diff_with_headers(diff=fenced_diff, path=path) if fenced_diff else ""
    if not diff:
        return []
    return [
        _file_change_payload(
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            index=0,
            diff=diff,
            path=path,
            tool="apply_patch",
            source_tool=tool_name,
        )
    ]


def _apply_patch_structured_file_changes(
    *,
    tool_name: str,
    tool_call_id: str,
    turn_id: str,
    structured: object,
) -> List[Dict[str, object]]:
    structured_dict = _object_dict(structured)
    applied = structured_dict.get("applied")
    files = structured_dict.get("files")
    if isinstance(applied, list):
        entries = list(cast(List[object], applied))
    elif isinstance(files, list):
        entries = list(cast(List[object], files))
    else:
        return []
    changes: List[Dict[str, object]] = []
    for item in entries:
        entry = _object_dict(item)
        diff = _optional_str(entry.get("patch")) or _optional_str(entry.get("diff"))
        if not diff:
            continue
        operation = _optional_str(entry.get("type")) or ""
        path = (
            _optional_str(entry.get("filePath"))
            or _optional_str(entry.get("relativePath"))
            or _optional_str(entry.get("resource"))
            or _optional_str(entry.get("target"))
            or ""
        )
        target = _optional_str(entry.get("target")) or ""
        new_file = operation == "add"
        changes.append(_file_change_payload(
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            index=len(changes),
            diff=_diff_with_headers(
                diff=diff,
                path=path,
                new_file=new_file,
                deleted_file=operation == "delete",
            ),
            path=path,
            tool="apply_patch",
            source_tool=tool_name,
            new_file=new_file,
            operation=operation,
            target=target,
        ))
    return changes


def _tool_command_result(
    *,
    tool_name: str,
    tool_call_id: str,
    arguments: Dict[str, object],
    result: object,
    structured: object,
) -> Optional[Dict[str, object]]:
    normalized_tool = tool_name.strip().lower()
    if normalized_tool not in COMMAND_TOOLS:
        return None
    structured_dict = _object_dict(structured)
    command = _optional_str(structured_dict.get("command")) or _optional_str(arguments.get("command"))
    if not command:
        return None
    output = _optional_str(structured_dict.get("output")) or _result_text(result)
    exit_code = _optional_int(structured_dict.get("exitCode"))
    if exit_code is None:
        exit_code = _optional_int(structured_dict.get("exit_code"))
    is_error = exit_code is not None and exit_code != 0
    return {
        "id": tool_call_id,
        "command": command,
        "cwd": _optional_str(structured_dict.get("cwd")) or _optional_str(arguments.get("workdir")) or "",
        "output": output,
        "exit_code": exit_code if exit_code is not None else 0,
        "status": "failed" if is_error else "completed",
        "is_error": is_error,
        "tool": normalized_tool,
        "description": _optional_str(arguments.get("description")) or "",
        "truncated": structured_dict.get("truncated") is True,
        "warnings": structured_dict.get("warnings") if isinstance(structured_dict.get("warnings"), list) else [],
    }


def _search_items_content(items: List[object]) -> str:
    lines: List[str] = []
    for item in items:
        item_dict = _object_dict(item)
        if not item_dict:
            continue
        path = (
            _optional_str(item_dict.get("path"))
            or _optional_str(item_dict.get("resource"))
            or _optional_str(item_dict.get("file"))
            or _optional_str(item_dict.get("filePath"))
            or _optional_str(item_dict.get("target"))
            or _optional_str(item_dict.get("canonical"))
            or ""
        )
        line = (
            _optional_int(item_dict.get("line"))
            or _optional_int(item_dict.get("line_no"))
            or _optional_int(item_dict.get("lineNumber"))
        )
        preview = (
            _optional_str(item_dict.get("text"))
            or _optional_str(item_dict.get("content"))
            or _optional_str(item_dict.get("preview"))
            or _optional_str(item_dict.get("lines"))
            or _optional_str(item_dict.get("lineText"))
            or _optional_str(item_dict.get("line_text"))
            or _optional_str(item_dict.get("match"))
            or ""
        )
        preview_lines = preview.rstrip("\n").splitlines() if preview else []
        if path and line is not None and preview_lines:
            lines.extend(f"{path}:{line + index}:{preview_line}" for index, preview_line in enumerate(preview_lines))
            continue
        if path and preview_lines:
            lines.extend(f"{path}:{preview_line}" for preview_line in preview_lines)
            continue
        if path:
            lines.append(path)
            continue
        lines.extend(preview_lines)
    return "\n".join(lines)


def _normalize_search_output(text: str) -> str:
    path = ""
    lines: List[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Found "):
            continue
        if not line.startswith((" ", "\t")) and stripped.endswith(":"):
            path = stripped[:-1]
            continue
        match = re.match(r"\s*Line\s+(\d+):\s?(.*)", line)
        if path and match:
            lines.append(f"{path}:{match.group(1)}:{match.group(2)}")
            continue
        if ":" in stripped:
            lines.append(stripped)
    return "\n".join(lines) if lines else text


def _tool_search_result(
    *,
    tool_name: str,
    tool_call_id: str,
    arguments: Dict[str, object],
    result: object,
    structured: object,
) -> Optional[Dict[str, object]]:
    normalized_tool = tool_name.strip().lower()
    if normalized_tool not in SEARCH_TOOLS:
        return None
    structured_dict = _object_dict(structured)
    pattern = _optional_str(arguments.get("pattern")) or ""
    path = _optional_str(arguments.get("path")) or ""
    raw_items = cast(object, structured_dict.get("items"))
    items_value = list(cast(List[object], raw_items)) if isinstance(raw_items, list) else []
    item_count = len(items_value) if isinstance(raw_items, list) else None
    content = _search_items_content(items_value) or _normalize_search_output(_result_text(result))
    return {
        "id": tool_call_id,
        "title": f"{normalized_tool}: {pattern}" if pattern else normalized_tool,
        "mode": normalized_tool,
        "path": path,
        "pattern": pattern,
        "arguments": dict(arguments),
        "content": content,
        "result": result,
        "truncated": structured_dict.get("truncated") is True,
        "partial": structured_dict.get("partial") is True,
        "item_count": item_count,
    }


def _tool_read_view(
    *,
    tool_name: str,
    tool_call_id: str,
    turn_id: str,
    arguments: Dict[str, object],
    result: object,
    structured: object,
) -> Optional[Dict[str, object]]:
    normalized_tool = tool_name.strip().lower()
    if normalized_tool not in READ_VIEW_TOOLS:
        return None
    structured_dict = _object_dict(structured)
    display = _object_dict(structured_dict.get("display"))
    page = display if display.get("type") == "file" else structured_dict
    if not page:
        page = _object_dict(_object_dict(result).get("value"))
    page_type = str(page.get("type") or "")
    if page_type not in {"text-page", "text", "file"}:
        return None
    content = page.get("content") if page_type != "file" else page.get("text")
    if not isinstance(content, str):
        return None
    path = (
        _optional_str(arguments.get("path"))
        or _optional_str(arguments.get("filePath"))
        or _optional_str(arguments.get("file_path"))
        or _optional_str(arguments.get("absolute_path"))
        or _optional_str(page.get("path"))
        or ""
    )
    offset = _optional_int(page.get("offset")) or _optional_int(page.get("lineStart")) or _optional_int(arguments.get("offset"))
    if offset is None and page_type == "text":
        offset = 1
    lines = [
        {
            "line_no": offset + index,
            "content": line,
        }
        for index, line in enumerate(content.splitlines())
    ] if offset is not None else None
    line_end = _optional_int(page.get("lineEnd"))
    view_range = [offset, line_end] if offset is not None and line_end is not None else _read_view_range(
        offset=offset,
        line_count=len(lines) if lines is not None else len(content.splitlines()),
    )
    view_id = f"{tool_call_id}:view" if tool_call_id else f"{turn_id}:view:{uuid.uuid4().hex}"
    truncated = page.get("truncated") is True or structured_dict.get("truncated") is True
    return {
        "id": view_id,
        "title": _read_view_title(path, view_range),
        "path": path,
        "content": content,
        "view_range": view_range,
        "lines": lines,
        "tool": normalized_tool,
        "source_tool": tool_name,
        "tool_call_id": tool_call_id,
        "truncated": truncated,
        "next": _optional_int(page.get("next")) or (line_end + 1 if truncated and line_end is not None else None),
    }


def _read_view_range(*, offset: Optional[int], line_count: int) -> Optional[List[int]]:
    if offset is None:
        return None
    if line_count <= 0:
        return [offset]
    return [offset, offset + line_count - 1]


def _read_view_title(path: str, view_range: Optional[List[int]]) -> str:
    short_path = os.path.basename(path) if path else "view"
    if view_range and len(view_range) >= 2:
        return f"{short_path}  Lines {view_range[0]}-{view_range[1]}"
    if view_range:
        return f"{short_path}  Line {view_range[0]}+"
    return short_path


def _approval_kind(details: Dict[str, object]) -> str:
    detail_type = str(details.get("type") or "").strip().lower()
    if detail_type in {"exec", "sandbox_expansion"}:
        return "command"
    if detail_type == "edit":
        return "diff"
    if detail_type == "mcp":
        return "mcp"
    if detail_type == "ask_user":
        return "input"
    if detail_type == "exit_plan_mode":
        return "plan"
    if detail_type == "info":
        return "info"
    return "tool"


def _approval_response_outcome(resolution: object) -> str:
    resolution_dict = _object_dict(resolution)
    raw_decision = resolution_dict.get("decision")
    raw_action = resolution_dict.get("action")
    raw_outcome = resolution_dict.get("outcome")
    token = str(raw_outcome or raw_action or raw_decision or "").strip().lower()
    token = token.replace("-", "_")
    if token in {"proceed_once", "once", "approve_once", "accept_once"}:
        return "proceed_once"
    if token in {
        "accept",
        "accepted",
        "approve",
        "approved",
        "allow",
        "allowed",
        "proceed",
        "yes",
    }:
        return "proceed_once"
    if token in {
        "proceed_always",
        "accept_for_session",
        "approve_for_session",
        "always",
        "allow_always",
    }:
        return "proceed_always"
    if token in {
        "proceed_always_and_save",
        "accept_always",
        "approve_always",
        "save",
        "save_always",
    }:
        return "proceed_always_and_save"
    if token in {"proceed_always_server", "accept_for_server", "approve_for_server"}:
        return "proceed_always_server"
    if token in {"proceed_always_tool", "accept_for_tool", "approve_for_tool"}:
        return "proceed_always_tool"
    if token in {"modify_with_editor", "modify", "edit"}:
        return "modify_with_editor"
    return "cancel"


def _app_server_approval_reply(outcome: str) -> str:
    normalized = outcome.strip().lower().replace("-", "_")
    if normalized in {
        "proceed_always",
        "proceed_always_and_save",
        "proceed_always_server",
        "proceed_always_tool",
    }:
        return "always"
    if normalized in {"proceed_once", "accept", "accepted", "allow", "allowed"}:
        return "once"
    return "reject"


def _approval_response_payload(resolution: object) -> Optional[Dict[str, object]]:
    resolution_dict = _object_dict(resolution)
    explicit_payload = resolution_dict.get("payload")
    if isinstance(explicit_payload, Mapping):
        return _object_dict(cast(object, explicit_payload))
    result = resolution_dict.get("result")
    result_dict = _object_dict(result)
    source = result_dict or resolution_dict
    if isinstance(source.get("newContent"), str):
        return {"newContent": source["newContent"]}
    if isinstance(source.get("content"), str) and _approval_response_outcome(source) == "modify_with_editor":
        return {"newContent": source["content"]}
    answers = source.get("answers")
    answers_dict = _object_dict(answers)
    if answers_dict:
        return {"answers": {str(key): str(value) for key, value in answers_dict.items()}}
    approved = source.get("approved")
    if isinstance(approved, bool):
        payload: Dict[str, object] = {"approved": approved}
        approval_mode = source.get("approvalMode")
        if isinstance(approval_mode, str) and approval_mode:
            payload["approvalMode"] = approval_mode
        feedback = source.get("feedback")
        if isinstance(feedback, str) and feedback:
            payload["feedback"] = feedback
        return payload
    return None


def _string_answer_list(value: object) -> Optional[List[str]]:
    if not isinstance(value, list):
        return None
    result: List[str] = []
    for item in cast(List[object], value):
        if not isinstance(item, str):
            return None
        result.append(item)
    return result


def _user_input_answers(resolution: object) -> Optional[List[List[str]]]:
    source = resolution
    resolution_dict = _object_dict(resolution)
    nested_result = resolution_dict.get("result")
    if isinstance(nested_result, Mapping):
        source = cast(object, nested_result)
    nested_payload = _object_dict(source).get("payload")
    if isinstance(nested_payload, Mapping):
        source = cast(object, nested_payload)

    source_dict = _object_dict(source)
    answers = source_dict.get("answers")
    if not isinstance(answers, list):
        return None
    result: List[List[str]] = []
    for answer in cast(List[object], answers):
        normalized = _string_answer_list(answer)
        if normalized is None:
            return None
        result.append(normalized)
    return result


def _approval_payload(params: Dict[str, object]) -> Dict[str, object]:
    arguments = _object_dict(params.get("arguments"))
    if not arguments:
        arguments = _object_dict(params.get("input"))
    details = _object_dict(params.get("details"))
    action = str(params.get("action") or params.get("permission") or "").strip()
    resources = params.get("resources")
    payload: Dict[str, object] = {
        "approvalId": str(params.get("approvalId") or ""),
        "toolCallId": str(params.get("toolCallId") or ""),
        "toolName": str(params.get("toolName") or params.get("tool") or action or ""),
        "sessionName": str(params.get("sessionName") or ""),
        "arguments": arguments,
    }
    if action:
        payload["action"] = action
        payload["permission"] = action
    if isinstance(resources, list):
        payload["resources"] = resources
    if details:
        payload["details"] = details
        detail_type = str(details.get("type") or "").strip().lower()
        title = details.get("title")
        if isinstance(title, str) and title:
            payload["title"] = title
        system_message = details.get("systemMessage")
        if isinstance(system_message, str) and system_message:
            payload["systemMessage"] = system_message
        if detail_type in {"exec", "sandbox_expansion"}:
            command = details.get("command")
            if isinstance(command, str):
                payload["command"] = command
            root_command = details.get("rootCommand")
            if isinstance(root_command, str):
                payload["rootCommand"] = root_command
        elif detail_type == "edit":
            for key in ("fileName", "filePath", "fileDiff", "newContent", "originalContent"):
                if key in details:
                    payload[key] = details[key]
        elif detail_type == "mcp":
            for key in ("serverName", "toolDisplayName", "toolDescription", "toolArgs"):
                if key in details:
                    payload[key] = details[key]
        elif detail_type == "ask_user":
            questions = details.get("questions")
            if isinstance(questions, list):
                payload["questions"] = questions
        elif detail_type == "info":
            prompt = details.get("prompt")
            if isinstance(prompt, str):
                payload["prompt"] = prompt
    return payload


def _auto_approval_resolution(policy: str, kind: str) -> Optional[Dict[str, object]]:
    normalized_policy = policy.strip().lower()
    normalized_kind = kind.strip().lower()
    if normalized_policy == "yolo":
        return {"decision": "accept"}
    if normalized_policy == "auto_edit" and normalized_kind == "diff":
        return {"decision": "accept"}
    return None


def _app_server_approval_mode(policy: str) -> str:
    normalized_policy = policy.strip().lower().replace("-", "_")
    if normalized_policy == "auto_edit":
        return "autoEdit"
    if normalized_policy == "yolo":
        return "yolo"
    return "default"


def _load_orchestrator_factory() -> _OrchestratorFactory:
    module = importlib.import_module("framework_shells.orchestrator")
    orchestrator = getattr(module, "Orchestrator", None)
    if orchestrator is None:
        raise RuntimeError("framework_shells.orchestrator.Orchestrator unavailable")
    return cast(_OrchestratorFactory, orchestrator)


def _shell_record_subgroups(record: object) -> set[str]:
    raw_subgroups = getattr(record, "subgroups", None)
    if not isinstance(raw_subgroups, (list, tuple, set)):
        return set()
    return {
        subgroup.strip()
        for subgroup in cast(Iterable[object], raw_subgroups)
        if isinstance(subgroup, str) and subgroup.strip()
    }


def _shell_record_matches_current_app(record: object) -> bool:
    expected_app_id = os.environ.get("TE_APP_ID")
    expected = expected_app_id.strip() if isinstance(expected_app_id, str) else ""
    if not expected:
        return True
    record_app_id = getattr(record, "app_id", None)
    return record_app_id == expected or expected in _shell_record_subgroups(record)


class OpenCodeAppServerTransport:
    def __init__(
        self,
        *,
        extension_root: Path,
        fws_getter: Callable[[], Awaitable[ShellManager]],
        raw_log_fn: Callable[[str, str, object], None],
        broadcast_fn: Callable[[Dict[str, object]], Awaitable[None]],
        transcript_fn: Callable[[str, Dict[str, object]], Awaitable[None]],
    ) -> None:
        self._extension_root = extension_root
        self._fws_getter = fws_getter
        self._raw_log_fn = raw_log_fn
        self._broadcast_fn = broadcast_fn
        self._transcript_fn = transcript_fn

        self._lock = asyncio.Lock()
        self._shell_id: Optional[str] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._stdout_subscription: Optional[_OutputSubscription] = None
        self._initialized = False
        self._capabilities: Dict[str, object] = {}
        self._request_counter = int(time.time() * 1000)
        self._rpc_waiters: Dict[str, asyncio.Future[Dict[str, object]]] = {}
        self._turn_waiters: Dict[str, asyncio.Future[Dict[str, object]]] = {}
        self._turn_conversations: Dict[str, str] = {}
        self._turn_session_names: Dict[str, str] = {}
        self._turn_approval_policies: Dict[str, str] = {}
        self._session_conversations: Dict[str, str] = {}
        self._detached_turns: set[str] = set()
        self._turn_buffers: Dict[str, List[str]] = {}
        self._turn_message_buffers: Dict[str, Dict[str, List[str]]] = {}
        self._turn_message_ids: Dict[str, str] = {}
        self._turn_active_message_keys: Dict[str, str] = {}
        self._turn_finalized_message_keys: set[str] = set()
        self._turn_reasoning_buffers: Dict[str, Dict[str, List[str]]] = {}
        self._turn_reasoning_ids: Dict[str, str] = {}
        self._turn_active_reasoning_keys: Dict[str, str] = {}
        self._turn_reasoning_next_indexes: Dict[str, int] = {}
        self._turn_finalized_reasoning_keys: set[str] = set()
        self._turn_tool_requests: Dict[str, Dict[str, object]] = {}
        self._pending_approval_requests: Dict[str, Dict[str, object]] = {}
        self._active_sessions: Dict[str, Dict[str, object]] = {}

    def is_ready(self) -> bool:
        return bool(
            self._shell_id
            and self._initialized
            and self._reader_task
            and not self._reader_task.done()
        )

    def has_session(self, session_name: str) -> bool:
        return session_name in self._active_sessions

    def forget_session(self, session_name: str) -> None:
        self._active_sessions.pop(session_name, None)
        self._session_conversations.pop(session_name, None)
        for approval_id, pending in list(self._pending_approval_requests.items()):
            if pending.get("session_name") == session_name:
                self._pending_approval_requests.pop(approval_id, None)

    def has_pending_approval(self, request_id: str) -> bool:
        request_id_text = str(request_id or "").strip()
        return bool(request_id_text and request_id_text in self._pending_approval_requests)

    async def resolve_approval(self, request_id: str, resolution: object) -> bool:
        request_id_text = str(request_id or "").strip()
        if not request_id_text:
            return False
        pending = self._pending_approval_requests.get(request_id_text)
        if not pending:
            return False
        outcome = _approval_response_outcome(resolution)
        provider_session_id = str(pending.get("provider_session_id") or "")
        conversation_id = pending.get("conversation_id")
        if str(pending.get("kind") or "") == "user_input":
            if outcome == "cancel":
                try:
                    await self.rpc_request(
                        "turn/userInput/reject",
                        params={
                            "sessionName": str(pending.get("session_name") or ""),
                            "sessionId": provider_session_id,
                            "providerSessionId": provider_session_id,
                            "turnId": str(pending.get("turn_id") or ""),
                            "requestId": str(pending.get("approval_id") or request_id_text),
                        },
                        timeout=30.0,
                        conversation_id=conversation_id if isinstance(conversation_id, str) else None,
                    )
                except Exception:
                    return False
                self._pending_approval_requests.pop(request_id_text, None)
                return True
            answers = _user_input_answers(resolution)
            if answers is None:
                return False
            try:
                await self.rpc_request(
                    "turn/userInput/respond",
                    params={
                        "sessionName": str(pending.get("session_name") or ""),
                        "sessionId": provider_session_id,
                        "providerSessionId": provider_session_id,
                        "turnId": str(pending.get("turn_id") or ""),
                        "requestId": str(pending.get("approval_id") or request_id_text),
                        "answers": answers,
                    },
                    timeout=30.0,
                    conversation_id=conversation_id if isinstance(conversation_id, str) else None,
                )
            except Exception:
                return False
            self._pending_approval_requests.pop(request_id_text, None)
            return True
        params: Dict[str, object] = {
            "sessionName": str(pending.get("session_name") or ""),
            "sessionId": provider_session_id,
            "providerSessionId": provider_session_id,
            "turnId": str(pending.get("turn_id") or ""),
            "approvalId": str(pending.get("approval_id") or request_id_text),
            "requestId": str(pending.get("approval_id") or request_id_text),
            "decision": _app_server_approval_reply(outcome),
            "reply": _app_server_approval_reply(outcome),
            "outcome": outcome,
        }
        payload = _approval_response_payload(resolution)
        if payload:
            params["payload"] = payload
        try:
            await self.rpc_request(
                "turn/toolApproval/respond",
                params=params,
                timeout=30.0,
                conversation_id=conversation_id if isinstance(conversation_id, str) else None,
            )
        except Exception:
            return False
        self._pending_approval_requests.pop(request_id_text, None)
        return True

    async def ensure_ready(self, cwd: Optional[str] = None) -> None:
        async with self._lock:
            shell_id = await self._get_or_start_shell(cwd=cwd)
            if not await self._pipe_available(shell_id):
                shell_id = await self._restart_shell(shell_id, cwd=cwd)
            await self._ensure_reader(shell_id)
            await self._ensure_initialized()

    async def stop(self) -> None:
        async with self._lock:
            await self._terminate_reader()
            shell_id = self._shell_id
            self._shell_id = None
            self._initialized = False
            self._capabilities = {}
            self._active_sessions.clear()
            self._session_conversations.clear()
            self._pending_approval_requests.clear()
            self._fail_waiters("transport stopped")
            if shell_id:
                mgr = await self._fws_getter()
                with contextlib.suppress(Exception):
                    await mgr.terminate_shell(shell_id, force=True)

    async def ensure_session(
        self,
        session_name: str,
        cwd: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        approval_policy: str = "ask",
        sandbox: Optional[Dict[str, object]] = None,
        reasoning_effort: Optional[str] = None,
        instructions: Optional[Dict[str, object]] = None,
        mcp_servers: Optional[Dict[str, object]] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, object]:
        await self.ensure_ready(cwd=cwd)
        cached = self._active_sessions.get(session_name)
        if cached:
            if conversation_id:
                self._session_conversations[session_name] = conversation_id
            return dict(cached)
        params: Dict[str, object] = {"sessionName": session_name, "cwd": cwd}
        if provider:
            params["provider"] = provider
        if model:
            params["model"] = model
        if reasoning_effort:
            params["reasoningEffort"] = reasoning_effort
        if instructions:
            params.update(instructions)
        params["approvalMode"] = _app_server_approval_mode(approval_policy)
        if sandbox is not None:
            params["sandbox"] = sandbox
        self._add_mcp_servers_param(params, mcp_servers)
        result = await self.rpc_request(
            "session/create",
            params=params,
            timeout=10.0,
        )
        self._active_sessions[session_name] = dict(result)
        if conversation_id:
            self._session_conversations[session_name] = conversation_id
        return result

    async def resume_session(
        self,
        *,
        session_name: str,
        selector: str,
        cwd: str,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        approval_policy: str = "ask",
        sandbox: Optional[Dict[str, object]] = None,
        reasoning_effort: Optional[str] = None,
        instructions: Optional[Dict[str, object]] = None,
        mcp_servers: Optional[Dict[str, object]] = None,
        session_hydrate: Optional[Dict[str, object]] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, object]:
        await self.ensure_ready(cwd=cwd)
        cached = self._active_sessions.get(session_name)
        if cached:
            if conversation_id:
                self._session_conversations[session_name] = conversation_id
            return dict(cached)
        params: Dict[str, object] = {
            "sessionName": session_name,
            "sessionId": selector,
            "providerSessionId": selector,
            "selector": selector,
            "cwd": cwd,
        }
        if provider:
            params["provider"] = provider
        if model:
            params["model"] = model
        if reasoning_effort:
            params["reasoningEffort"] = reasoning_effort
        if instructions:
            params.update(instructions)
        params["approvalMode"] = _app_server_approval_mode(approval_policy)
        if sandbox is not None:
            params["sandbox"] = sandbox
        self._add_mcp_servers_param(params, mcp_servers)
        if session_hydrate:
            params["sessionHydrate"] = session_hydrate
        result = await self.rpc_request("session/resume", params=params, timeout=20.0)
        self._active_sessions[session_name] = dict(result)
        if conversation_id:
            self._session_conversations[session_name] = conversation_id
        return result

    async def session_status(
        self,
        session_name: str,
        *,
        cwd: str,
        provider_session_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, object]:
        await self.ensure_ready(cwd=cwd)
        cached = self._active_sessions.get(session_name)
        remote_session_id = provider_session_id or _provider_session_id(cached) or session_name
        result = await self.rpc_request(
            "session/status",
            params={
                "sessionName": session_name,
                "sessionId": remote_session_id,
                "providerSessionId": remote_session_id,
            },
            timeout=5.0,
            conversation_id=conversation_id,
        )
        if result.get("active") is True:
            self._active_sessions[session_name] = dict(result)
            if conversation_id:
                self._session_conversations[session_name] = conversation_id
        else:
            self.forget_session(session_name)
        return result

    async def send_turn(
        self,
        *,
        conversation_id: str,
        session_name: str,
        prompt: str,
        cwd: str,
        provider_session_id: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        approval_policy: str = "ask",
        sandbox: Optional[Dict[str, object]] = None,
        reasoning_effort: Optional[str] = None,
        instructions: Optional[Dict[str, object]] = None,
        mcp_servers: Optional[Dict[str, object]] = None,
        timeout: float = DEFAULT_TURN_TIMEOUT_SECONDS,
        wait_for_completion: bool = False,
    ) -> Dict[str, object]:
        if provider_session_id:
            await self.ensure_ready(cwd=cwd)
            cached = self._active_sessions.get(session_name)
            cached_session = _object_dict(cached)
            session: Dict[str, object] = (
                dict(cached_session)
                if _provider_session_id(cached_session) == provider_session_id
                else {
                    "sessionId": provider_session_id,
                    "providerSessionId": provider_session_id,
                    "threadId": provider_session_id,
                    "cwd": cwd,
                }
            )
            self._session_conversations[session_name] = conversation_id
        else:
            session = await self.ensure_session(
                session_name,
                cwd,
                provider=provider,
                model=model,
                approval_policy=approval_policy,
                sandbox=sandbox,
                reasoning_effort=reasoning_effort,
                instructions=instructions,
                mcp_servers=mcp_servers,
                conversation_id=conversation_id,
            )
        turn_id = uuid.uuid4().hex
        future: Optional[asyncio.Future[Dict[str, object]]] = None
        if wait_for_completion:
            future = asyncio.get_running_loop().create_future()
            self._turn_waiters[turn_id] = future
        self._turn_conversations[turn_id] = conversation_id
        self._turn_session_names[turn_id] = session_name
        self._turn_approval_policies[turn_id] = approval_policy
        self._session_conversations[session_name] = conversation_id
        self._turn_buffers[turn_id] = []
        self._turn_message_buffers[turn_id] = {}
        self._turn_reasoning_buffers[turn_id] = {}
        self._turn_active_reasoning_keys.pop(turn_id, None)
        self._turn_reasoning_next_indexes[turn_id] = 0
        keep_turn_state = False
        try:
            provider_session_id = _provider_session_id(session)
            if not provider_session_id:
                raise RuntimeError("app-server session did not return a provider session id")
            params: Dict[str, object] = {
                "sessionName": session_name,
                "sessionId": provider_session_id,
                "providerSessionId": provider_session_id,
                "turnId": turn_id,
                "prompt": prompt,
                "cwd": cwd,
            }
            if model:
                params["model"] = model
            if provider:
                params["provider"] = provider
            if reasoning_effort:
                params["variant"] = reasoning_effort
                params["reasoningEffort"] = reasoning_effort
            if instructions:
                params.update(instructions)
            self._add_mcp_servers_param(params, mcp_servers)
            accepted = await self.rpc_request(
                "turn/start",
                params=params,
                timeout=10.0,
                conversation_id=conversation_id,
            )
            if not wait_for_completion:
                self._detached_turns.add(turn_id)
                keep_turn_state = True
                return {
                    "ok": True,
                    "session": session,
                    "turn": accepted,
                    "completed": None,
                    "content": "",
                }
            if future is None:
                raise RuntimeError("turn completion waiter was not initialized")
            completed = await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
            content = "".join(self._turn_buffers.get(turn_id, []))
            return {
                "ok": True,
                "session": session,
                "turn": accepted,
                "completed": completed,
                "content": content,
            }
        except asyncio.TimeoutError as exc:
            self._detached_turns.add(turn_id)
            raise RuntimeError("turn timed out while app-server is still streaming") from exc
        finally:
            if not keep_turn_state and turn_id not in self._detached_turns:
                self._cleanup_turn_state(turn_id)

    async def rpc_request(
        self,
        method: str,
        *,
        params: Optional[Dict[str, object]] = None,
        timeout: Optional[float] = 10.0,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, object]:
        req_id = self._next_request_id()
        future: asyncio.Future[Dict[str, object]] = asyncio.get_running_loop().create_future()
        self._rpc_waiters[req_id] = future
        payload: Dict[str, object] = {"jsonrpc": JSONRPC_VERSION, "id": int(req_id), "method": method}
        if params is not None:
            payload["params"] = params
        await self._write_payload(payload, conversation_id=conversation_id)
        try:
            response = await future if timeout is None else await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._rpc_waiters.pop(req_id, None)
        if response.get("error"):
            error = response.get("error")
            if _is_object_dict(error):
                message = error.get("message")
                code = _optional_int(error.get("code"))
                data = error.get("data")
                suffix = f" ({code})" if code is not None else ""
                raise OpenCodeAppServerRpcError(
                    str(message or f"rpc error{suffix}"),
                    code=code,
                    data=data,
                )
            raise OpenCodeAppServerRpcError(str(error))
        result = response.get("result")
        if not _is_object_dict(result):
            raise RuntimeError("invalid RPC result")
        return _object_dict(result)

    async def _get_or_start_shell(self, *, cwd: Optional[str]) -> str:
        mgr = await self._fws_getter()
        if self._shell_id:
            shell = await mgr.get_shell(self._shell_id)
            if (
                shell
                and shell.status == "running"
                and getattr(shell, "spec_id", "") == SHELLSPEC_ID
                and _shell_record_matches_current_app(shell)
            ):
                return self._shell_id
            self._shell_id = None

        adopted = await self._adopt_existing_shell(mgr)
        if adopted:
            self._shell_id = adopted
            return adopted

        shell_id = await self._start_new_shell(mgr, cwd=cwd)
        self._shell_id = shell_id
        return shell_id

    async def _adopt_existing_shell(self, mgr: ShellManager) -> Optional[str]:
        with contextlib.suppress(Exception):
            records = await mgr.list_shells()
            for rec in records:
                if rec.status != "running":
                    continue
                if (rec.label or "") != TRANSPORT_LABEL:
                    continue
                if getattr(rec, "spec_id", "") != SHELLSPEC_ID:
                    continue
                if not _shell_record_matches_current_app(rec):
                    continue
                return rec.id
        return None

    async def _start_new_shell(self, mgr: ShellManager, *, cwd: Optional[str]) -> str:
        spec_path = self._extension_root / "shellspec" / "opencode_app_server.yaml"
        orch = _load_orchestrator_factory()(mgr)
        shell = await orch.start_from_ref(
            f"{spec_path}#{SHELLSPEC_ID}",
            base_dir=spec_path.parent,
            ctx={
                "CWD": cwd or os.getcwd(),
                "EXTENSION_ROOT": os.fspath(self._extension_root),
                "PYTHON": sys.executable,
            },
            label=TRANSPORT_LABEL,
            wait_ready=False,
        )
        return shell.id

    async def _restart_shell(self, shell_id: str, *, cwd: Optional[str]) -> str:
        mgr = await self._fws_getter()
        await self._terminate_reader()
        self._initialized = False
        self._active_sessions.clear()
        self._session_conversations.clear()
        self._pending_approval_requests.clear()
        self._fail_waiters("transport restarted")
        with contextlib.suppress(Exception):
            await mgr.terminate_shell(shell_id, force=True)
        new_shell_id = await self._start_new_shell(mgr, cwd=cwd)
        self._shell_id = new_shell_id
        return new_shell_id

    async def _pipe_available(self, shell_id: str) -> bool:
        mgr = await self._fws_getter()
        state = mgr.get_pipe_state(shell_id)
        return bool(state and state.process.stdin)

    async def _ensure_reader(self, shell_id: str) -> None:
        if self._reader_task and not self._reader_task.done():
            return
        mgr = await self._fws_getter()
        state = mgr.get_pipe_state(shell_id)
        if not state or not state.process.stdin:
            raise RuntimeError("opencode app-server pipe not available")
        subscription = await mgr.subscribe_output_bytes(shell_id)
        self._stdout_subscription = subscription
        self._reader_task = asyncio.create_task(
            self._reader_loop(shell_id, subscription),
            name="opencode-app-server-reader",
        )

    async def _terminate_reader(self) -> None:
        task = self._reader_task
        self._reader_task = None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        subscription = self._stdout_subscription
        shell_id = self._shell_id
        if subscription is not None and shell_id:
            mgr = await self._fws_getter()
            with contextlib.suppress(Exception):
                await mgr.unsubscribe_output_bytes(shell_id, subscription)
        self._stdout_subscription = None

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        result = await self.rpc_request(
            "server/initialize",
            params={"clientName": "als-rs-opencode-extension", "clientVersion": "0.1.0"},
            timeout=10.0,
        )
        self._capabilities = _object_dict(result.get("capabilities"))
        self._initialized = True

    def _add_mcp_servers_param(
        self,
        params: Dict[str, object],
        mcp_servers: Optional[Dict[str, object]],
    ) -> None:
        if mcp_servers is None:
            return
        if self._capabilities.get("mcp") is not True:
            raise RuntimeError("OpenCode app-server does not advertise MCP support")
        params["mcpServers"] = mcp_servers

    async def _write_payload(
        self,
        payload: Dict[str, object],
        *,
        conversation_id: Optional[str] = None,
    ) -> None:
        shell_id = self._shell_id
        if not shell_id:
            raise RuntimeError("opencode app-server transport not running")
        mgr = await self._fws_getter()
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self._raw_log_fn("out", conversation_id or "__opencode_transport__", line)
        await mgr.write_to_pipe(shell_id, line + "\n")

    async def _reader_loop(self, shell_id: str, subscription: _OutputSubscription) -> None:
        buffer = b""
        mgr = await self._fws_getter()
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(subscription.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    state = mgr.get_pipe_state(shell_id)
                    if not state or state.process.returncode is not None:
                        break
                    continue
                if not chunk:
                    state = mgr.get_pipe_state(shell_id)
                    if not state or state.process.returncode is not None:
                        break
                    continue
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    await self._process_line(raw.decode("utf-8", errors="replace"))
            if buffer:
                await self._process_line(buffer.decode("utf-8", errors="replace"))
        finally:
            with contextlib.suppress(Exception):
                await mgr.unsubscribe_output_bytes(shell_id, subscription)
            if self._stdout_subscription is subscription:
                self._stdout_subscription = None
            self._initialized = False
            self._fail_waiters("reader stopped")
            if self._shell_id == shell_id:
                self._shell_id = None
            self._reader_task = None

    async def _process_line(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        try:
            parsed_value = cast(object, json.loads(text))
        except Exception:
            self._raw_log_fn("in", "__opencode_transport__", text)
            return
        parsed = _object_dict(parsed_value)
        method = parsed.get("method")
        if "id" in parsed and ("result" in parsed or "error" in parsed) and not method:
            req_id = str(parsed.get("id"))
            self._raw_log_fn("in", "__opencode_transport__", text)
            waiter = self._rpc_waiters.get(req_id)
            if waiter and not waiter.done():
                waiter.set_result(parsed)
            return
        if isinstance(method, str):
            params = _object_dict(parsed.get("params"))
            self._raw_log_fn("in", self._conversation_for_event(params), text)
            await self._handle_notification(method, params)

    async def _handle_notification(self, method: str, params: Dict[str, object]) -> None:
        turn_id = str(params.get("turnId") or "")
        conversation_id = self._conversation_for_event(params)
        if conversation_id == "__opencode_transport__":
            conversation_id = ""
        if method == "turn/started" and turn_id:
            if conversation_id:
                await self._fanout_turn_started(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            return
        if method == "turn/contentDelta" and turn_id:
            delta = params.get("delta")
            if conversation_id and isinstance(delta, str) and delta:
                await self._fanout_agent_message(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    text_id=params.get("textId") or params.get("messageId"),
                    delta=delta,
                    final=False,
                )
            return
        if method == "turn/thoughtDelta" and turn_id:
            delta = params.get("delta")
            subject = params.get("subject")
            if conversation_id and isinstance(delta, str) and delta:
                await self._fanout_reasoning(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    delta=delta,
                    subject=subject if isinstance(subject, str) else "",
                    final=False,
                )
            return
        if method == "turn/toolCallRequested" and turn_id:
            if conversation_id:
                await self._finalize_reasoning_if_open(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                )
                await self._finalize_active_agent_message(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                )
                await self._fanout_tool_requested(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            return
        if method == "turn/toolApprovalRequested" and turn_id:
            if conversation_id:
                await self._fanout_tool_approval_requested(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            return
        if method == USER_INPUT_REQUEST_METHOD and turn_id:
            if conversation_id:
                await self._finalize_reasoning_if_open(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                )
                await self._finalize_active_agent_message(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                )
                await self._fanout_user_input_requested(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            return
        if method == "turn/userInputResolved" and turn_id:
            request_id = str(params.get("requestId") or params.get("questionId") or "")
            if request_id:
                self._pending_approval_requests.pop(request_id, None)
            return
        if method == "turn/toolCallCompleted" and turn_id:
            if conversation_id:
                await self._fanout_tool_completed(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            return
        if method == "turn/completed" and turn_id:
            if conversation_id:
                await self._fanout_reasoning(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    final=True,
                )
                content = params.get("content")
                has_streamed_content = bool(self._turn_buffers.get(turn_id))
                if has_streamed_content:
                    await self._finalize_all_agent_messages(
                        conversation_id=conversation_id,
                        turn_id=turn_id,
                    )
                elif isinstance(content, str) and content:
                    await self._fanout_agent_message(
                        conversation_id=conversation_id,
                        turn_id=turn_id,
                        text=content,
                        final=True,
                    )
                await self._fanout_turn_completed(
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    params=params,
                )
            waiter = self._turn_waiters.get(turn_id)
            if waiter and not waiter.done():
                waiter.set_result(dict(params))
            if turn_id in self._detached_turns:
                self._cleanup_turn_state(turn_id)
                self._detached_turns.discard(turn_id)
            return
        if method == "turn/error" and turn_id:
            # `turn/error` is diagnostic; `turn/completed` is the terminal
            # lifecycle event that finalizes buffered content and clears state.
            return

    async def _fanout_turn_started(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        session_name = str(params.get("sessionName") or self._turn_session_names.get(turn_id) or "")
        provider_session_id = (
            _optional_str(params.get("providerSessionId"))
            or _optional_str(self._active_sessions.get(session_name, {}).get("providerSessionId"))
            or ""
        )
        event: Dict[str, object] = {
            "type": "turn_started",
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "source": "opencode-app-server",
        }
        if session_name:
            event["session_name"] = session_name
        if provider_session_id:
            event["provider_session_id"] = provider_session_id
            event["thread_id"] = provider_session_id
        await self._broadcast_fn(event)
        await self._broadcast_fn({
            "type": "activity",
            "conversation_id": conversation_id,
            "label": "thinking",
            "active": True,
            "turn_id": turn_id,
        })

    async def _fanout_turn_completed(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        raw_status = str(params.get("status") or "completed")
        status = _turn_status(raw_status)
        ribbon_status = _status_dot(status)
        usage = _turn_usage(params)
        event: Dict[str, object] = {
            "type": "turn_completed",
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "status": status,
            "turn_status": raw_status,
            "source": "opencode-app-server",
        }
        error = params.get("error")
        if error:
            event["error"] = error
        if usage:
            event["usage"] = usage
        await self._broadcast_fn(event)
        if usage:
            await self._fanout_token_count(
                conversation_id=conversation_id,
                turn_id=turn_id,
                usage=usage,
            )
        await self._broadcast_fn({
            "type": "status",
            "conversation_id": conversation_id,
            "status": ribbon_status,
            "turn_status": status,
            "turn_id": turn_id,
        })
        await self._broadcast_fn({
            "type": "activity",
            "conversation_id": conversation_id,
            "label": "idle",
            "active": False,
            "turn_id": turn_id,
        })
        transcript_entry: Dict[str, object] = {
            "role": "status",
            "status": ribbon_status,
            "turn_status": status,
            "turn_id": turn_id,
            "event": "turn/completed",
            "timestamp": _utc_ts(),
            "conversation_id": conversation_id,
        }
        if error:
            transcript_entry["error"] = error
        if usage:
            transcript_entry["usage"] = usage
        await self._transcript_fn(conversation_id, transcript_entry)

    async def _fanout_token_count(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        usage: Dict[str, object],
    ) -> None:
        event = {
            "type": "token_count",
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            **usage,
        }
        transcript_entry = {
            "role": "token_usage",
            "event": "token_count",
            "timestamp": _utc_ts(),
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            **usage,
        }
        await self._broadcast_fn(event)
        await self._transcript_fn(conversation_id, transcript_entry)

    async def _fanout_agent_message(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        final: bool,
        text_id: object = None,
        delta: str = "",
        text: str = "",
    ) -> None:
        """Emit agent message live events and transcript records from one path.

        ALS replay correctness depends on live-visible assistant messages and
        transcript entries sharing the same stable ids and turn metadata.
        """
        if final:
            await self._finalize_agent_message_key(
                conversation_id=conversation_id,
                turn_id=turn_id,
                message_key=_message_stream_key(turn_id, text_id),
                text=text,
            )
            return

        if not delta:
            return
        message_key = _message_stream_key(turn_id, text_id)
        active_key = self._turn_active_message_keys.get(turn_id)
        if active_key and active_key != message_key:
            await self._finalize_agent_message_key(
                conversation_id=conversation_id,
                turn_id=turn_id,
                message_key=active_key,
            )
        entry_id = self._turn_message_ids.setdefault(
            message_key,
            f"opencode-msg-{_safe_id_fragment(message_key)}",
        )
        self._turn_buffers.setdefault(turn_id, []).append(delta)
        self._turn_message_buffers.setdefault(turn_id, {}).setdefault(message_key, []).append(delta)
        self._turn_active_message_keys[turn_id] = message_key
        await self._broadcast_fn(
            build_assistant_delta_event(
                entry_id=entry_id,
                delta=delta,
                conversation_id=conversation_id,
                turn_id=turn_id,
            )
        )

    async def _finalize_active_agent_message(
        self,
        *,
        conversation_id: str,
        turn_id: str,
    ) -> None:
        message_key = self._turn_active_message_keys.get(turn_id)
        if not message_key:
            return
        await self._finalize_agent_message_key(
            conversation_id=conversation_id,
            turn_id=turn_id,
            message_key=message_key,
        )
        self._turn_active_message_keys.pop(turn_id, None)

    async def _finalize_all_agent_messages(
        self,
        *,
        conversation_id: str,
        turn_id: str,
    ) -> None:
        for message_key in list(self._turn_message_buffers.get(turn_id, {})):
            await self._finalize_agent_message_key(
                conversation_id=conversation_id,
                turn_id=turn_id,
                message_key=message_key,
            )
        self._turn_active_message_keys.pop(turn_id, None)

    async def _finalize_agent_message_key(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        message_key: str,
        text: str = "",
    ) -> None:
        if message_key in self._turn_finalized_message_keys:
            return
        message_text = text or "".join(self._turn_message_buffers.get(turn_id, {}).get(message_key, []))
        if not message_text:
            return
        entry_id = self._turn_message_ids.setdefault(
            message_key,
            f"opencode-msg-{_safe_id_fragment(message_key)}",
        )
        live_event = build_assistant_finalize_event(
            entry_id=entry_id,
            text=message_text,
            conversation_id=conversation_id,
            turn_id=turn_id,
        )
        transcript_entry = build_message_transcript_entry(
            role="assistant",
            text=message_text,
            timestamp=_utc_ts(),
            entry_id=entry_id,
            turn_id=turn_id,
            event="assistant_finalize",
        )
        transcript_entry["conversation_id"] = conversation_id
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)
        self._turn_finalized_message_keys.add(message_key)

    async def _fanout_reasoning(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        final: bool,
        delta: str = "",
        subject: str = "",
    ) -> None:
        if final:
            await self._finalize_all_reasoning(
                conversation_id=conversation_id,
                turn_id=turn_id,
            )
            return

        if not delta:
            return
        reasoning_key = self._active_reasoning_key(turn_id)
        segment_buffer = self._turn_reasoning_buffers.setdefault(turn_id, {}).setdefault(
            reasoning_key,
            [],
        )
        entry_id = self._turn_reasoning_ids.setdefault(
            reasoning_key,
            f"opencode-reasoning-{_safe_id_fragment(reasoning_key)}",
        )
        reasoning_delta = delta
        if subject and not segment_buffer:
            reasoning_delta = f"{subject}\n{delta}"
        segment_buffer.append(reasoning_delta)
        await self._broadcast_fn(
            build_reasoning_delta_event(
                entry_id=entry_id,
                delta=reasoning_delta,
                conversation_id=conversation_id,
                turn_id=turn_id,
            )
        )

    def _active_reasoning_key(self, turn_id: str) -> str:
        active_key = self._turn_active_reasoning_keys.get(turn_id)
        if active_key:
            return active_key
        index = self._turn_reasoning_next_indexes.get(turn_id, 0)
        reasoning_key = _reasoning_segment_key(turn_id, index)
        self._turn_reasoning_next_indexes[turn_id] = index + 1
        self._turn_active_reasoning_keys[turn_id] = reasoning_key
        self._turn_reasoning_buffers.setdefault(turn_id, {}).setdefault(reasoning_key, [])
        return reasoning_key

    async def _finalize_reasoning_if_open(
        self,
        *,
        conversation_id: str,
        turn_id: str,
    ) -> None:
        reasoning_key = self._turn_active_reasoning_keys.get(turn_id)
        if not reasoning_key:
            return
        if self._turn_reasoning_buffers.get(turn_id, {}).get(reasoning_key):
            await self._finalize_reasoning_key(
                conversation_id=conversation_id,
                turn_id=turn_id,
                reasoning_key=reasoning_key,
            )
        self._turn_active_reasoning_keys.pop(turn_id, None)

    async def _finalize_all_reasoning(
        self,
        *,
        conversation_id: str,
        turn_id: str,
    ) -> None:
        for reasoning_key in list(self._turn_reasoning_buffers.get(turn_id, {})):
            await self._finalize_reasoning_key(
                conversation_id=conversation_id,
                turn_id=turn_id,
                reasoning_key=reasoning_key,
            )
        self._turn_active_reasoning_keys.pop(turn_id, None)

    async def _finalize_reasoning_key(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        reasoning_key: str,
    ) -> None:
        if reasoning_key in self._turn_finalized_reasoning_keys:
            return
        text = "".join(self._turn_reasoning_buffers.get(turn_id, {}).get(reasoning_key, []))
        if not text:
            return
        entry_id = self._turn_reasoning_ids.setdefault(
            reasoning_key,
            f"opencode-reasoning-{_safe_id_fragment(reasoning_key)}",
        )
        live_event = build_reasoning_finalize_event(
            entry_id=entry_id,
            text=text,
            conversation_id=conversation_id,
            turn_id=turn_id,
        )
        transcript_entry = build_reasoning_transcript_entry(
            text=text,
            timestamp=_utc_ts(),
            entry_id=entry_id,
            turn_id=turn_id,
            event="reasoning_finalize",
        )
        transcript_entry["conversation_id"] = conversation_id
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)
        self._turn_finalized_reasoning_keys.add(reasoning_key)

    async def _fanout_tool_requested(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        tool_call_id = str(params.get("toolCallId") or "")
        if not tool_call_id:
            return
        tool_name = str(params.get("toolName") or params.get("tool") or "tool")
        arguments = _object_dict(params.get("arguments"))
        if not arguments:
            arguments = _object_dict(params.get("input"))
        request_payload = build_tool_card_request("", tool_name, arguments)
        self._turn_tool_requests[tool_call_id] = {
            "turn_id": turn_id,
            "tool": tool_name,
            "raw_arguments": dict(arguments),
            "arguments": dict(arguments),
            "request": request_payload,
        }
        if tool_name.strip().lower() in SPECIALIZED_TOOL_CARDS:
            return
        await self._broadcast_fn({
            "type": "tool_begin",
            "conversation_id": conversation_id,
            "id": tool_call_id,
            "turn_id": turn_id,
            "tool": tool_name,
            "arguments": dict(arguments),
            "request": request_payload,
        })

    async def _fanout_tool_approval_requested(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        approval_id = str(params.get("approvalId") or "")
        if not approval_id:
            return
        session_name = str(params.get("sessionName") or self._turn_session_names.get(turn_id) or "")
        tool_call_id = str(params.get("toolCallId") or "")
        tool_name = str(params.get("toolName") or params.get("tool") or params.get("action") or "tool")
        details: Dict[str, object] = _object_dict(params.get("details"))
        if not details:
            resources = params.get("resources")
            fallback_details: Dict[str, object] = {
                "type": "edit" if params.get("action") == "edit" else "tool",
                "title": f"Confirm {tool_name}",
                "resources": list(cast(List[object], resources)) if isinstance(resources, list) else [],
            }
            details = fallback_details
        request_payload = _approval_payload(params)
        kind = _approval_kind(details)
        created_at = _utc_ts()
        provider_session_id = (
            _optional_str(params.get("providerSessionId"))
            or _optional_str(params.get("sessionId"))
            or _provider_session_id(self._active_sessions.get(session_name))
        )
        self._pending_approval_requests[approval_id] = {
            "conversation_id": conversation_id,
            "session_name": session_name,
            "provider_session_id": provider_session_id,
            "turn_id": turn_id,
            "approval_id": approval_id,
            "tool_call_id": tool_call_id,
            "tool": tool_name,
            "kind": kind,
        }
        event: Dict[str, object] = {
            "type": "approval",
            "conversation_id": conversation_id,
            "id": approval_id,
            "request_id": approval_id,
            "kind": kind,
            "request_method": "turn/toolApprovalRequested",
            "request_params": dict(params),
            "payload": request_payload,
            "turn_id": turn_id,
            "created_at": created_at,
            "agent": "opencode-app-server",
            "extension_id": "opencode-app-server",
        }
        if tool_call_id:
            event["tool_call_id"] = tool_call_id
        if provider_session_id:
            event["provider_session_id"] = provider_session_id
            event["thread_id"] = provider_session_id
        file_path = _optional_str(details.get("filePath"))
        if file_path:
            event["path"] = file_path
        file_diff = _optional_str(details.get("fileDiff"))
        if file_diff:
            event["diff"] = file_diff
        approval_policy = self._turn_approval_policies.get(turn_id, "ask")
        auto_resolution = _auto_approval_resolution(approval_policy, kind)
        if auto_resolution is not None:
            asyncio.create_task(
                self._auto_resolve_or_broadcast_approval(
                    approval_id=approval_id,
                    resolution=auto_resolution,
                    event=event,
                ),
                name=f"opencode-auto-approval-{approval_id}",
            )
            return
        await self._broadcast_fn(event)

    async def _auto_resolve_or_broadcast_approval(
        self,
        *,
        approval_id: str,
        resolution: Dict[str, object],
        event: Dict[str, object],
    ) -> None:
        try:
            resolved = await self.resolve_approval(approval_id, resolution)
        except Exception:
            resolved = False
        if not resolved and self.has_pending_approval(approval_id):
            await self._broadcast_fn(event)

    async def _fanout_user_input_requested(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        request_id = str(params.get("requestId") or params.get("questionId") or "")
        if not request_id:
            return
        session_name = str(params.get("sessionName") or self._turn_session_names.get(turn_id) or "")
        provider_session_id = (
            _optional_str(params.get("providerSessionId"))
            or _optional_str(params.get("sessionId"))
            or _provider_session_id(self._active_sessions.get(session_name))
        )
        questions = params.get("questions")
        question_list = list(cast(List[object], questions)) if isinstance(questions, list) else []
        first_question = _object_dict(question_list[0]) if question_list else {}
        first_options = first_question.get("options")
        first_choices: List[str] = []
        if isinstance(first_options, list):
            for option in cast(List[object], first_options):
                option_dict = _object_dict(option)
                label = _optional_str(option_dict.get("label"))
                if label:
                    first_choices.append(label)
        request_params: Dict[str, object] = {
            "requestId": request_id,
            "questions": question_list,
        }
        first_question_text = _optional_str(first_question.get("question"))
        if first_question_text:
            request_params["question"] = first_question_text
        if first_choices:
            request_params["choices"] = first_choices
        if first_question.get("custom") is not None:
            request_params["allowFreeform"] = first_question.get("custom") is not False

        payload: Dict[str, object] = {
            "kind": "user_input",
            "requestId": request_id,
            "questions": question_list,
            "message": first_question_text or "OpenCode is waiting for user input",
        }
        if first_question_text:
            payload["question"] = first_question_text
        if first_choices:
            payload["choices"] = first_choices
        if first_question.get("custom") is not None:
            payload["allowFreeform"] = first_question.get("custom") is not False

        tool_call_id = _optional_str(params.get("toolCallId"))
        if tool_call_id:
            payload["tool_call_id"] = tool_call_id

        self._pending_approval_requests[request_id] = {
            "conversation_id": conversation_id,
            "session_name": session_name,
            "provider_session_id": provider_session_id,
            "turn_id": turn_id,
            "approval_id": request_id,
            "tool_call_id": tool_call_id or "",
            "tool": "question",
            "kind": "user_input",
        }
        created_at = _utc_ts()
        event: Dict[str, object] = {
            "type": "approval",
            "conversation_id": conversation_id,
            "id": request_id,
            "request_id": request_id,
            "kind": "user_input",
            "request_method": USER_INPUT_REQUEST_METHOD,
            "request_params": request_params,
            "payload": payload,
            "turn_id": turn_id,
            "created_at": created_at,
            "agent": "opencode-app-server",
            "extension_id": "opencode-app-server",
        }
        if tool_call_id:
            event["tool_call_id"] = tool_call_id
            event["card_id"] = tool_call_id
        if provider_session_id:
            event["provider_session_id"] = provider_session_id
            event["thread_id"] = provider_session_id
        await self._broadcast_fn(event)

    async def _fanout_tool_completed(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        params: Dict[str, object],
    ) -> None:
        tool_call_id = str(params.get("toolCallId") or "")
        if not tool_call_id:
            return
        prior = _object_dict(self._turn_tool_requests.pop(tool_call_id, {}))
        tool_name = str(params.get("toolName") or params.get("tool") or prior.get("tool") or "tool")
        raw_arguments = _object_dict(prior.get("raw_arguments"))
        if not raw_arguments:
            raw_arguments = _object_dict(prior.get("arguments"))
        arguments = _object_dict(prior.get("arguments")) or dict(raw_arguments)
        request_payload = prior.get("request")
        if request_payload is None:
            request_payload = build_tool_card_request("", tool_name, arguments)
        result = params.get("result")
        error = params.get("error")
        status = str(params.get("status") or "completed")
        is_error = bool(error) or status not in {"completed", "success", "ok"}
        command_result = _tool_command_result(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            arguments=raw_arguments,
            result=result,
            structured=params.get("structured"),
        )
        if command_result:
            await self._fanout_command_completed(
                conversation_id=conversation_id,
                turn_id=turn_id,
                command_result=command_result,
            )
            return
        file_changes = [] if is_error else _tool_file_changes(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            arguments=raw_arguments,
            result=result,
            structured=params.get("structured"),
        )
        read_view = None if is_error else _tool_read_view(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            turn_id=turn_id,
            arguments=raw_arguments,
            result=result,
            structured=params.get("structured"),
        )
        if read_view:
            await self._fanout_read_view(
                conversation_id=conversation_id,
                turn_id=turn_id,
                read_view=read_view,
            )
            return
        search_result = None if is_error else _tool_search_result(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            arguments=raw_arguments,
            result=result,
            structured=params.get("structured"),
        )
        if search_result:
            await self._fanout_search_completed(
                conversation_id=conversation_id,
                turn_id=turn_id,
                search_result=search_result,
            )
            return
        first_file_change = file_changes[0] if file_changes else {}
        card_tool_name = str(first_file_change.get("tool") or tool_name)
        arguments = _tool_display_arguments(
            tool_name=tool_name,
            arguments=raw_arguments,
            file_changes=file_changes,
        )
        request_payload = build_tool_card_request("", card_tool_name, arguments)
        display_result = error if is_error and error else _tool_display_result(
            tool_name=tool_name,
            result=result,
            file_changes=file_changes,
        )
        response_payload = build_tool_card_response("", card_tool_name, display_result)
        event: Dict[str, object] = {
            "type": "tool_end",
            "conversation_id": conversation_id,
            "id": tool_call_id,
            "turn_id": turn_id,
            "tool": card_tool_name,
            "arguments": arguments,
            "request": request_payload,
            "result": display_result,
            "response": response_payload,
            "status": status,
            "is_error": is_error,
        }
        if first_file_change:
            event["path"] = first_file_change.get("path", "")
            event["source_tool"] = first_file_change["source_tool"]
            event["new_file"] = first_file_change["new_file"]
        if error:
            event["error"] = error
        transcript_entry: Dict[str, object] = {
            "role": "tool",
            "id": tool_call_id,
            "item_id": tool_call_id,
            "turn_id": turn_id,
            "tool": card_tool_name,
            "arguments": arguments,
            "request": request_payload,
            "result": display_result,
            "response": response_payload,
            "status": status,
            "is_error": is_error,
            "timestamp": _utc_ts(),
            "event": "tool_completed",
            "conversation_id": conversation_id,
        }
        if first_file_change:
            transcript_entry["path"] = first_file_change.get("path", "")
            transcript_entry["source_tool"] = first_file_change["source_tool"]
            transcript_entry["new_file"] = first_file_change["new_file"]
        if error:
            transcript_entry["error"] = error
        await self._broadcast_fn(event)
        await self._transcript_fn(conversation_id, transcript_entry)
        for file_change in file_changes:
            await self._fanout_file_change_diff(
                conversation_id=conversation_id,
                turn_id=turn_id,
                file_change=file_change,
            )

    async def _fanout_command_completed(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        command_result: Dict[str, object],
    ) -> None:
        command_id = str(command_result.get("id") or f"{turn_id}:command:{uuid.uuid4().hex}")
        command = str(command_result.get("command") or "")
        output = str(command_result.get("output") or "")
        exit_code = _optional_int(command_result.get("exit_code"))
        if exit_code is None:
            exit_code = 0
        status = str(command_result.get("status") or ("failed" if exit_code != 0 else "completed"))
        is_error = command_result.get("is_error") is True
        cwd = str(command_result.get("cwd") or "")
        live_event: Dict[str, object] = {
            "type": "shell_end",
            "conversation_id": conversation_id,
            "id": command_id,
            "item_id": command_id,
            "turn_id": turn_id,
            "command": command,
            "cwd": cwd,
            "stdout": output,
            "stderr": "",
            "exitCode": exit_code,
            "output": output,
            "status": status,
            "is_error": is_error,
            "source": "opencode-app-server",
            "details": {
                "tool": str(command_result.get("tool") or "bash"),
                "description": str(command_result.get("description") or ""),
                "truncated": command_result.get("truncated") is True,
                "warnings": command_result.get("warnings") if isinstance(command_result.get("warnings"), list) else [],
            },
        }
        transcript_entry: Dict[str, object] = {
            "role": "command",
            "id": command_id,
            "item_id": command_id,
            "turn_id": turn_id,
            "command": command,
            "cwd": cwd,
            "output": output,
            "exit_code": exit_code,
            "status": status,
            "is_error": is_error,
            "source": "opencode-app-server",
            "details": dict(_object_dict(live_event.get("details"))),
            "timestamp": _utc_ts(),
            "event": "tool_command_completed",
            "conversation_id": conversation_id,
        }
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)

    async def _fanout_file_change_diff(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        file_change: Dict[str, object],
    ) -> None:
        diff_id = str(file_change.get("id") or f"{turn_id}:diff:{uuid.uuid4().hex}")
        diff_text = str(file_change.get("text") or "")
        if not diff_text:
            return
        path = str(file_change.get("path") or "")
        source_tool = str(file_change.get("source_tool") or "")
        tool_name = str(file_change.get("tool") or source_tool or "tool")
        live_event: Dict[str, object] = {
            "type": "diff",
            "conversation_id": conversation_id,
            "id": diff_id,
            "item_id": diff_id,
            "turn_id": turn_id,
            "text": diff_text,
            "diff": diff_text,
            "path": path,
            "tool": tool_name,
            "source": "opencode-app-server",
            "details": {
                "source_tool": source_tool,
                "tool_call_id": str(file_change.get("tool_call_id") or ""),
                "operation": _file_change_operation(file_change),
                "target": str(file_change.get("target") or ""),
            },
        }
        if file_change.get("new_file") is True:
            live_event["new_file"] = True
        line = _optional_int(file_change.get("line"))
        if line is not None:
            live_event["line"] = line
        transcript_entry: Dict[str, object] = {
            "role": "diff",
            "id": diff_id,
            "item_id": diff_id,
            "turn_id": turn_id,
            "text": diff_text,
            "diff": diff_text,
            "path": path,
            "tool": tool_name,
            "source": "opencode-app-server",
            "details": dict(_object_dict(live_event.get("details"))),
            "timestamp": _utc_ts(),
            "event": "tool_file_change_diff",
            "conversation_id": conversation_id,
        }
        if file_change.get("new_file") is True:
            transcript_entry["new_file"] = True
        if line is not None:
            transcript_entry["line"] = line
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)

    async def _fanout_search_completed(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        search_result: Dict[str, object],
    ) -> None:
        search_id = str(search_result.get("id") or f"{turn_id}:search:{uuid.uuid4().hex}")
        title = str(search_result.get("title") or "search")
        mode = str(search_result.get("mode") or "search")
        path = str(search_result.get("path") or "")
        pattern = str(search_result.get("pattern") or "")
        arguments = _object_dict(search_result.get("arguments"))
        content = str(search_result.get("content") or "")
        details: Dict[str, object] = {
            "tool_call_id": search_id,
            "truncated": search_result.get("truncated") is True,
            "partial": search_result.get("partial") is True,
        }
        item_count = _optional_int(search_result.get("item_count"))
        if item_count is not None:
            details["item_count"] = item_count
        live_event: Dict[str, object] = {
            "type": "search",
            "conversation_id": conversation_id,
            "id": search_id,
            "item_id": search_id,
            "turn_id": turn_id,
            "title": title,
            "mode": mode,
            "path": path,
            "pattern": pattern,
            "arguments": arguments,
            "content": content,
            "result": search_result.get("result"),
            "source": "opencode-app-server",
            "details": details,
        }
        transcript_entry: Dict[str, object] = {
            "role": "search",
            "id": search_id,
            "item_id": search_id,
            "turn_id": turn_id,
            "title": title,
            "mode": mode,
            "path": path,
            "pattern": pattern,
            "arguments": arguments,
            "content": content,
            "result": search_result.get("result"),
            "source": "opencode-app-server",
            "details": dict(details),
            "timestamp": _utc_ts(),
            "event": "tool_search_completed",
            "conversation_id": conversation_id,
        }
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)

    async def _fanout_read_view(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        read_view: Dict[str, object],
    ) -> None:
        view_id = str(read_view.get("id") or f"{turn_id}:view:{uuid.uuid4().hex}")
        title = str(read_view.get("title") or "view")
        path = str(read_view.get("path") or "")
        content = str(read_view.get("content") or "")
        view_range = read_view.get("view_range")
        lines = read_view.get("lines")
        details: Dict[str, object] = {
            "source_tool": str(read_view.get("source_tool") or read_view.get("tool") or "read"),
            "tool_call_id": str(read_view.get("tool_call_id") or ""),
            "truncated": read_view.get("truncated") is True,
        }
        next_line = _optional_int(read_view.get("next"))
        if next_line is not None:
            details["next"] = next_line
        live_event: Dict[str, object] = {
            "type": "view",
            "conversation_id": conversation_id,
            "id": view_id,
            "item_id": view_id,
            "turn_id": turn_id,
            "title": title,
            "path": path,
            "content": content,
            "view_range": view_range,
            "source": "opencode-app-server",
            "tool": str(read_view.get("tool") or "read"),
            "details": details,
        }
        if isinstance(lines, list):
            live_event["lines"] = lines
        transcript_entry: Dict[str, object] = {
            "role": "view",
            "id": view_id,
            "item_id": view_id,
            "turn_id": turn_id,
            "title": title,
            "path": path,
            "content": content,
            "view_range": view_range,
            "source": "opencode-app-server",
            "tool": str(read_view.get("tool") or "read"),
            "details": dict(details),
            "timestamp": _utc_ts(),
            "event": "tool_read_view",
            "conversation_id": conversation_id,
        }
        if isinstance(lines, list):
            transcript_entry["lines"] = lines
        await self._broadcast_fn(live_event)
        await self._transcript_fn(conversation_id, transcript_entry)

    def _conversation_for_event(self, params: Dict[str, object]) -> str:
        turn_id = params.get("turnId")
        if isinstance(turn_id, str) and turn_id in self._turn_conversations:
            return self._turn_conversations[turn_id]
        session_name = params.get("sessionName")
        if isinstance(session_name, str):
            conversation_id = self._session_conversations.get(session_name)
            if conversation_id:
                return conversation_id
        return "__opencode_transport__"

    def _cleanup_turn_state(self, turn_id: str) -> None:
        self._turn_waiters.pop(turn_id, None)
        self._turn_conversations.pop(turn_id, None)
        self._turn_session_names.pop(turn_id, None)
        self._turn_approval_policies.pop(turn_id, None)
        self._turn_buffers.pop(turn_id, None)
        message_keys = set(self._turn_message_buffers.pop(turn_id, {}))
        for message_key in message_keys:
            self._turn_message_ids.pop(message_key, None)
            self._turn_finalized_message_keys.discard(message_key)
        self._turn_message_ids.pop(turn_id, None)
        self._turn_active_message_keys.pop(turn_id, None)
        reasoning_keys = set(self._turn_reasoning_buffers.pop(turn_id, {}))
        for reasoning_key in reasoning_keys:
            self._turn_reasoning_ids.pop(reasoning_key, None)
            self._turn_finalized_reasoning_keys.discard(reasoning_key)
        self._turn_active_reasoning_keys.pop(turn_id, None)
        self._turn_reasoning_next_indexes.pop(turn_id, None)
        self._detached_turns.discard(turn_id)
        for tool_call_id, request in list(self._turn_tool_requests.items()):
            if request.get("turn_id") == turn_id:
                self._turn_tool_requests.pop(tool_call_id, None)
        for approval_id, pending in list(self._pending_approval_requests.items()):
            if pending.get("turn_id") == turn_id:
                self._pending_approval_requests.pop(approval_id, None)

    def _next_request_id(self) -> str:
        self._request_counter += 1
        return str(self._request_counter)

    def _fail_waiters(self, message: str) -> None:
        error: Dict[str, object] = {"error": {"code": -32603, "message": message}}
        for waiter in list(self._rpc_waiters.values()):
            if not waiter.done():
                waiter.set_result(error)
        for waiter in list(self._turn_waiters.values()):
            if not waiter.done():
                waiter.set_exception(RuntimeError(message))
        self._rpc_waiters.clear()
        self._turn_waiters.clear()
        self._turn_conversations.clear()
        self._turn_session_names.clear()
        self._turn_approval_policies.clear()
        self._detached_turns.clear()
        self._turn_buffers.clear()
        self._turn_message_buffers.clear()
        self._turn_message_ids.clear()
        self._turn_active_message_keys.clear()
        self._turn_finalized_message_keys.clear()
        self._turn_reasoning_buffers.clear()
        self._turn_reasoning_ids.clear()
        self._turn_active_reasoning_keys.clear()
        self._turn_reasoning_next_indexes.clear()
        self._turn_finalized_reasoning_keys.clear()
        self._turn_tool_requests.clear()
        self._pending_approval_requests.clear()
