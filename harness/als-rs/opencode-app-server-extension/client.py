from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from pathlib import Path
from typing import Dict, List, Optional, Protocol, Tuple, cast

from .transport import (
    SESSION_NOT_FOUND_CODE,
    OpenCodeAppServerRpcError,
    OpenCodeAppServerTransport,
    ShellManager,
)

MetaFns = Dict[str, Callable[..., object]]

_transport: Optional[OpenCodeAppServerTransport] = None
_broadcast_fn: Optional[Callable[[Dict[str, object]], Awaitable[None]]] = None
_transcript_fn: Optional[Callable[[str, Dict[str, object]], Awaitable[None]]] = None
_meta_fns: Optional[MetaFns] = None
_server_root: Optional[Path] = None
_registered_extension_ids: set[str] = set()
_ready_extensions: set[str] = set()
_raw_buffer: List[Dict[str, object]] = []
_RAW_BUFFER_MAX = 1000
_HISTORY_IMPORT_PAGE_SIZE = 100
_FULL_SESSION_HYDRATE: Dict[str, object] = {"mode": "full"}
_DEFAULT_APPROVAL_POLICY = "ask"
_APPROVAL_POLICY_OPTIONS: List[Dict[str, object]] = [
    {"value": "ask", "label": "Ask"},
    {"value": "auto_edit", "label": "Auto-edit"},
    {"value": "yolo", "label": "YOLO"},
]
_DEFAULT_SANDBOX_POLICY = "inherit"
_SANDBOX_POLICY_OPTIONS: List[Dict[str, object]] = [
    {"value": "inherit", "label": "Inherit"},
    {"value": "disabled", "label": "Disabled"},
    {"value": "tool", "label": "Tool sandboxing"},
]
_DEFAULT_PROVIDER_CONFIG_DIR = Path.home() / ".local" / "share" / "als-rs" / "provider-config"
_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_OPENROUTER_ENDPOINT = "/chat/completions"
_OPENROUTER_CACHE_TTL_SECONDS = 300
_OPENROUTER_MODEL_CACHE: Dict[Tuple[str, str, str], Tuple[float, List[Dict[str, object]]]] = {}
_TE2_MCP_SERVER_NAME = "te2-mcp"
_TE2_MCP_STREAMABLE_HTTP_ROUTE = "/te2_mcp_http"
_AGENT_PTY_BLOCKS_MCP_SERVER_NAME = "agent-pty-blocks"
_AGENT_PTY_BLOCKS_TIMEOUT_MS = 100_000 * 60 * 1000
_DEVINS_CONTEXT_SETTINGS_KEY = "__als_devins_context__"


class _HttpResponse(Protocol):
    def read(self) -> bytes: ...

    def close(self) -> object: ...


def _add_to_raw_buffer(direction: str, conversation_id: str, data: object) -> None:
    entry: Dict[str, object] = {
        "dir": direction,
        "conversation_id": conversation_id,
        "data": data if isinstance(data, str) else str(data),
    }
    _raw_buffer.append(entry)
    if len(_raw_buffer) > _RAW_BUFFER_MAX:
        _raw_buffer.pop(0)


def get_raw_buffer(limit: int = 50) -> List[Dict[str, object]]:
    return _raw_buffer[-limit:]


def _object_dict(value: object) -> Dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Iterable[tuple[object, object]], value.items())}


def _object_list(value: object) -> List[object]:
    return list(cast(List[object], value)) if isinstance(value, list) else []


def _load_settings_schema_template() -> Dict[str, object]:
    schema_path = Path(__file__).with_name("settings_schema.json")
    with schema_path.open("r", encoding="utf-8") as handle:
        loaded = cast(object, json.load(handle))
    return _object_dict(loaded)


def _save_meta(conversation_id: str, meta: Dict[str, object]) -> None:
    if _meta_fns and callable(_meta_fns.get("save")):
        _meta_fns["save"](conversation_id, meta)


def _load_meta(conversation_id: str) -> Dict[str, object]:
    if _meta_fns and callable(_meta_fns.get("load")):
        return _object_dict(_meta_fns["load"](conversation_id))
    return {}


def _safe_session_token(value: str, *, fallback: str = "opencode") -> str:
    token = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value).strip("_")
    return token or fallback


def _short_provider_session_token(provider_session_id: str) -> str:
    token = _safe_session_token(provider_session_id, fallback="session")
    if len(token) <= 48:
        return token
    digest = hashlib.sha256(provider_session_id.encode("utf-8")).hexdigest()[:12]
    return f"{token[:35]}-{digest}"


def _new_active_session_name(settings: Optional[Dict[str, object]]) -> str:
    del settings
    return f"slot-{uuid.uuid4().hex[:16]}"


def _provider_active_session_name(provider_session_id: str) -> str:
    if provider_session_id.startswith("opencode-"):
        return _short_provider_session_token(provider_session_id)
    return f"opencode-{_short_provider_session_token(provider_session_id)}"


def _looks_like_als_conversation_id(value: str) -> bool:
    return value.startswith("conv_")


def _active_session_name(
    meta: Dict[str, object],
    *,
    provider_session_id: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> str:
    raw = meta.get("active_session_name")
    if isinstance(raw, str) and raw.strip() and not _looks_like_als_conversation_id(raw.strip()):
        return raw.strip()
    if provider_session_id:
        return _provider_active_session_name(provider_session_id)
    return _new_active_session_name(settings)


def _cwd_from_settings(settings: Optional[Dict[str, object]], cwd: Optional[str] = None) -> str:
    if isinstance(cwd, str) and cwd.strip():
        return cwd.strip()
    if isinstance(settings, dict):
        raw = settings.get("cwd")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return str(Path.cwd())


def _model_from_settings(settings: Optional[Dict[str, object]], model: Optional[str] = None) -> Optional[str]:
    if isinstance(model, str) and model.strip():
        return model.strip()
    if isinstance(settings, dict):
        raw = settings.get("model")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        raw = settings.get("model_ref")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _provider_from_settings(settings: Optional[Dict[str, object]], provider: Optional[str] = None) -> Optional[str]:
    if isinstance(provider, str) and provider.strip():
        return provider.strip()
    if isinstance(settings, dict):
        raw = settings.get("provider")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        model = _model_from_settings(settings)
        if isinstance(model, str) and "/" in model:
            return model.split("/", 1)[0]
    return None


def _approval_policy_from_settings(settings: Optional[Dict[str, object]]) -> str:
    if isinstance(settings, dict):
        raw = settings.get("approval_policy")
        if isinstance(raw, str) and raw.strip():
            normalized = raw.strip().lower().replace("-", "_")
            if normalized == "default":
                return "ask"
            if normalized in {"ask", "auto_edit", "yolo"}:
                return normalized
    return _DEFAULT_APPROVAL_POLICY


def _sandbox_policy_from_settings(settings: Optional[Dict[str, object]]) -> str:
    if isinstance(settings, dict):
        raw = settings.get("sandbox_policy")
        if isinstance(raw, str) and raw.strip():
            normalized = raw.strip().lower().replace("-", "_")
            if normalized in {"inherit", "default"}:
                return "inherit"
            if normalized in {"disabled", "disable", "off", "none"}:
                return "disabled"
            if normalized in {"tool", "tools", "tool_sandboxing", "tool_sandbox"}:
                return "tool"
    return _DEFAULT_SANDBOX_POLICY


def _reasoning_effort_from_settings(settings: Optional[Dict[str, object]]) -> Optional[str]:
    if isinstance(settings, dict):
        raw = settings.get("model_variant")
        if not isinstance(raw, str) or not raw.strip():
            raw = settings.get("variant")
        if not isinstance(raw, str) or not raw.strip():
            raw = settings.get("reasoning_effort")
        if isinstance(raw, str) and raw.strip():
            normalized = raw.strip().lower()
            if normalized in {"none", "off", "disabled", "disable", "default"}:
                return None
            return raw.strip()
    return None


def _instruction_text_from_settings(
    settings: Optional[Dict[str, object]],
    *keys: str,
) -> Optional[str]:
    if not isinstance(settings, dict):
        return None
    for key in keys:
        raw = settings.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _instruction_entries_from_settings(
    settings: Optional[Dict[str, object]],
    source_id: str,
    *keys: str,
) -> List[Dict[str, object]]:
    text = _instruction_text_from_settings(settings, *keys)
    if not text:
        return []
    return [{"id": source_id, "text": text}]


def _devins_context_instruction(settings: Optional[Dict[str, object]]) -> List[Dict[str, object]]:
    if not isinstance(settings, dict):
        return []
    context = _object_dict(settings.get(_DEVINS_CONTEXT_SETTINGS_KEY))
    effective = _string_value(context.get("effective"))
    if not effective:
        return []
    return [{"id": "als:devins_context", "text": effective}]


def _instruction_params_from_settings(settings: Optional[Dict[str, object]]) -> Dict[str, object]:
    params: Dict[str, object] = {
        "hostPlatform": "ALS",
        "builtinInstructions": "app-server",
    }
    if isinstance(settings, dict):
        raw_builtin = settings.get("builtin_instructions")
        if not isinstance(raw_builtin, str):
            raw_builtin = settings.get("builtinInstructions")
        if isinstance(raw_builtin, str) and raw_builtin.strip().lower() == "none":
            params["builtinInstructions"] = "none"
    developer = _devins_context_instruction(settings)
    user_developer: List[Dict[str, object]] = []
    if not developer:
        developer = _instruction_entries_from_settings(
            settings,
            "als:developer_instructions",
            "developer_instructions",
            "developerInstructions",
        )
        user_developer = _instruction_entries_from_settings(
            settings,
            "als:user_developer_instructions",
            "user_developer_instructions",
            "userDeveloperInstructions",
            "user_devins",
            "userDevins",
        )
    if developer:
        params["developerInstructions"] = developer
    if user_developer:
        params["userDeveloperInstructions"] = user_developer
    return params


def _te2_mcp_streamable_http_url(base_url: str) -> str:
    if not base_url.strip():
        raise ValueError("TE2 MCP base URL is required")
    return f"{base_url.rstrip('/')}{_TE2_MCP_STREAMABLE_HTTP_ROUTE}"


def _agent_pty_blocks_script_path() -> Path:
    if _server_root is None:
        raise ValueError("ALS server root is required for agent-pty-blocks MCP")
    script_path = _server_root / "mcp_agent_pty_server.py"
    if not script_path.is_file():
        raise ValueError(f"agent-pty-blocks MCP server not found: {script_path}")
    return script_path


def _string_record(value: object) -> Optional[Dict[str, str]]:
    if not isinstance(value, Mapping):
        return None
    result: Dict[str, str] = {}
    for key, item in cast(Iterable[tuple[object, object]], value.items()):
        if not isinstance(item, str):
            return None
        result[str(key)] = item
    return result


def _string_list(value: object) -> Optional[List[str]]:
    if not isinstance(value, list):
        return None
    result: List[str] = []
    for item in cast(List[object], value):
        if not isinstance(item, str) or not item.strip():
            return None
        result.append(item)
    return result


def _normalize_mcp_remote_server(server: Dict[str, object]) -> Optional[Dict[str, object]]:
    url = _string_value(server.get("url"))
    if not url:
        return None
    normalized: Dict[str, object] = {
        "type": "remote",
        "url": url,
    }
    raw_transport = _string_value(server.get("transport"), server.get("type")).replace("_", "-")
    if raw_transport == "sse":
        normalized["transport"] = "sse"
    else:
        normalized["transport"] = "streamable-http"
    headers = _string_record(server.get("headers"))
    if server.get("headers") is not None and headers is None:
        return None
    if headers:
        normalized["headers"] = headers
    timeout = _int_value(server.get("timeout"))
    if server.get("timeout") is not None and timeout is None:
        return None
    if timeout is not None:
        normalized["timeout"] = timeout
    if isinstance(server.get("disabled"), bool):
        normalized["disabled"] = server["disabled"]
    return normalized


def _normalize_mcp_local_server(server: Dict[str, object]) -> Optional[Dict[str, object]]:
    command = _string_list(server.get("command"))
    if command is None and isinstance(server.get("command"), str):
        args = _string_list(server.get("args"))
        command = [str(server["command"]), *(args or [])]
    if command is None:
        return None
    normalized: Dict[str, object] = {
        "type": "local",
        "command": command,
    }
    environment = _string_record(server.get("environment"))
    if environment is None:
        environment = _string_record(server.get("env"))
    if (server.get("environment") is not None or server.get("env") is not None) and environment is None:
        return None
    if environment:
        normalized["environment"] = environment
    cwd = _string_value(server.get("cwd"))
    if cwd:
        normalized["cwd"] = cwd
    timeout = _int_value(server.get("timeout"))
    if server.get("timeout") is not None and timeout is None:
        return None
    if timeout is not None:
        normalized["timeout"] = timeout
    if isinstance(server.get("disabled"), bool):
        normalized["disabled"] = server["disabled"]
    return normalized


def _normalize_mcp_server(server: object) -> Optional[Dict[str, object]]:
    server_map = _object_dict(server)
    if not server_map:
        return None
    server_type = _string_value(server_map.get("type")).replace("_", "-")
    if server_type in {"remote", "http", "streamable-http", "sse"} or server_map.get("url") is not None:
        return _normalize_mcp_remote_server(server_map)
    if server_type in {"local", "stdio"} or server_map.get("command") is not None:
        return _normalize_mcp_local_server(server_map)
    return None


def _agent_pty_blocks_local_server(
    defaults: Dict[str, object],
    context: Dict[str, object],
    settings: Dict[str, object],
    conversation_id: Optional[str],
) -> Dict[str, object]:
    transport = _string_value(defaults.get("transport")).replace("_", "-")
    if transport and transport not in {"stdio", "local"}:
        raise ValueError("agent-pty-blocks MCP requires stdio transport")
    resolved_conversation_id = _string_value(conversation_id, defaults.get("conversation_id"), context.get("conversation_id"))
    if not resolved_conversation_id:
        raise ValueError("agent-pty-blocks MCP requires conversation_id")
    cwd = _string_value(defaults.get("cwd"), context.get("cwd"), settings.get("cwd"))
    environment: Dict[str, str] = {"CONVERSATION_ID": resolved_conversation_id}
    if cwd:
        environment["PWD"] = cwd
    appserver_origin = _string_value(defaults.get("appserver_origin"), context.get("appserver_origin"))
    if appserver_origin:
        environment["AGENT_LOG_SERVER_ORIGIN"] = appserver_origin
    server: Dict[str, object] = {
        "type": "local",
        "command": [sys.executable.strip() or "python3", str(_agent_pty_blocks_script_path())],
        "env": environment,
        "environment": environment,
        "timeout": _AGENT_PTY_BLOCKS_TIMEOUT_MS,
    }
    if cwd:
        server["cwd"] = cwd
    return server


def _mcp_servers_from_settings(
    settings: Optional[Dict[str, object]],
    conversation_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    if not isinstance(settings, dict):
        return None
    direct_servers = _object_dict(settings.get("mcpServers"))
    if not direct_servers:
        direct_servers = _object_dict(settings.get("mcp_servers"))
    context = _object_dict(settings.get("mcp_context"))
    integration_enabled = settings.get("te2_mcp_integration") is True
    if not direct_servers and (not context or not integration_enabled):
        return None

    servers: Dict[str, object] = {}
    requested_servers = _object_dict(context.get("requested_servers")) if integration_enabled else {}
    for name, server in {**direct_servers, **requested_servers}.items():
        normalized = _normalize_mcp_server(server)
        if normalized is None:
            raise ValueError(f"Invalid MCP server config: {name}")
        servers[str(name)] = normalized

    if not integration_enabled:
        return servers or None

    defaults = _object_dict(context.get("defaults"))
    agent_pty_defaults = _object_dict(defaults.get(_AGENT_PTY_BLOCKS_MCP_SERVER_NAME))
    if agent_pty_defaults and agent_pty_defaults.get("enabled_by_default") is not False:
        servers[_AGENT_PTY_BLOCKS_MCP_SERVER_NAME] = _agent_pty_blocks_local_server(
            agent_pty_defaults,
            context,
            settings,
            conversation_id,
        )
    te2_defaults = _object_dict(defaults.get(_TE2_MCP_SERVER_NAME))
    if te2_defaults and te2_defaults.get("enabled_by_default") is not False:
        base_url = _string_value(te2_defaults.get("base_url"), settings.get("te2_base_url"))
        if base_url:
            servers[_TE2_MCP_SERVER_NAME] = {
                "type": "remote",
                "url": _te2_mcp_streamable_http_url(base_url),
                "transport": "streamable-http",
            }
    return servers


def _app_server_sandbox_from_policy(policy: str) -> Optional[Dict[str, object]]:
    if policy == "disabled":
        return {"enabled": False, "toolSandboxing": False}
    if policy == "tool":
        return {"toolSandboxing": True}
    return None


def _bound_provider_session_id(meta: Dict[str, object]) -> Optional[str]:
    for key in ("provider_session_id", "thread_id"):
        raw = meta.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _persistent_settings(settings: Optional[Dict[str, object]]) -> Dict[str, object]:
    persisted: Dict[str, object] = {}
    if not isinstance(settings, dict):
        return persisted
    for key, value in settings.items():
        if key in {
            "session",
            "config",
            "provider_mode",
            "config_generator_mode",
            "mcp_context",
            "mcpServers",
            "mcp_servers",
            _DEVINS_CONTEXT_SETTINGS_KEY,
        }:
            continue
        if (
            key.startswith("manual_")
            or key.startswith("openrouter_")
            or key.startswith("config_generator")
        ):
            continue
        lower_key = str(key).lower()
        if (
            "api_key" in lower_key
            or "apikey" in lower_key
            or "secret" in lower_key
            or "password" in lower_key
            or lower_key.endswith("_query")
        ):
            continue
        if (
            key == "sandbox_policy"
            and _sandbox_policy_from_settings(settings) == _DEFAULT_SANDBOX_POLICY
        ):
            continue
        if value is None or value == "":
            continue
        persisted[key] = value
    return persisted


def _bind_session_meta(
    meta: Dict[str, object],
    *,
    session: Dict[str, object],
    active_session_name: str,
    settings: Optional[Dict[str, object]],
) -> Optional[str]:
    provider_session_id = session.get("providerSessionId")
    if isinstance(provider_session_id, str) and provider_session_id.strip():
        provider_session_id = provider_session_id.strip()
        existing_provider_session_id = _bound_provider_session_id(meta)
        if existing_provider_session_id and existing_provider_session_id != provider_session_id:
            raise RuntimeError(
                "conversation already bound to a different provider session"
            )
        meta["thread_id"] = provider_session_id
        meta["provider_session_id"] = provider_session_id
    else:
        provider_session_id = None
    meta["active_session_name"] = active_session_name
    meta["settings"] = _persistent_settings(settings)
    meta["status"] = "active"
    return provider_session_id


def _looks_like_session_not_loaded_error(exc: BaseException) -> bool:
    if isinstance(exc, OpenCodeAppServerRpcError) and exc.code == SESSION_NOT_FOUND_CODE:
        return True
    message = str(exc).lower()
    return (
        "session not found" in message
        or "session_not_found" in message
        or "not loaded" in message
    )


async def _ensure_bound_provider_session_loaded(
    transport: OpenCodeAppServerTransport,
    *,
    conversation_id: str,
    session_name: str,
    provider_session_id: str,
    cwd: str,
    model: Optional[str],
    provider: Optional[str],
    approval_policy: str,
    sandbox: Optional[Dict[str, object]],
    reasoning_effort: Optional[str],
    instructions: Dict[str, object],
    mcp_servers: Optional[Dict[str, object]],
) -> Dict[str, object]:
    try:
        status = await transport.session_status(
            session_name,
            cwd=cwd,
            provider_session_id=provider_session_id,
            conversation_id=conversation_id,
        )
    except Exception as exc:
        if not _looks_like_session_not_loaded_error(exc):
            raise
        status: Dict[str, object] = {"active": False}
    if status.get("active") is True:
        active_provider_id = status.get("providerSessionId")
        if (
            isinstance(active_provider_id, str)
            and active_provider_id
            and active_provider_id != provider_session_id
        ):
            transport.forget_session(session_name)
            raise RuntimeError(
                "OpenCode app-server active session slot is bound to a different provider session"
            )
        return status
    return await transport.resume_session(
        session_name=session_name,
        selector=provider_session_id,
        cwd=cwd,
        provider=provider,
        model=model,
        approval_policy=approval_policy,
        sandbox=sandbox,
        reasoning_effort=reasoning_effort,
        instructions=instructions,
        mcp_servers=mcp_servers,
        session_hydrate=dict(_FULL_SESSION_HYDRATE),
        conversation_id=conversation_id,
    )


async def _send_turn_with_lazy_resume(
    transport: OpenCodeAppServerTransport,
    *,
    conversation_id: str,
    session_name: str,
    provider_session_id: Optional[str],
    prompt: str,
    cwd: str,
    model: Optional[str],
    provider: Optional[str],
    approval_policy: str,
    sandbox: Optional[Dict[str, object]],
    reasoning_effort: Optional[str],
    instructions: Dict[str, object],
    mcp_servers: Optional[Dict[str, object]],
) -> Dict[str, object]:
    try:
        return await transport.send_turn(
            conversation_id=conversation_id,
            session_name=session_name,
            provider_session_id=provider_session_id,
            prompt=prompt,
            cwd=cwd,
            provider=provider,
            model=model,
            approval_policy=approval_policy,
            sandbox=sandbox,
            reasoning_effort=reasoning_effort,
            instructions=instructions,
            mcp_servers=mcp_servers,
        )
    except Exception as exc:
        if not provider_session_id or not _looks_like_session_not_loaded_error(exc):
            raise
        transport.forget_session(session_name)
        await transport.resume_session(
            session_name=session_name,
            selector=provider_session_id,
            cwd=cwd,
            model=model,
            provider=provider,
            approval_policy=approval_policy,
            sandbox=sandbox,
            reasoning_effort=reasoning_effort,
            instructions=instructions,
            mcp_servers=mcp_servers,
            session_hydrate=dict(_FULL_SESSION_HYDRATE),
            conversation_id=conversation_id,
        )
        return await transport.send_turn(
            conversation_id=conversation_id,
            session_name=session_name,
            provider_session_id=provider_session_id,
            prompt=prompt,
            cwd=cwd,
            provider=provider,
            model=model,
            approval_policy=approval_policy,
            sandbox=sandbox,
            reasoning_effort=reasoning_effort,
            instructions=instructions,
            mcp_servers=mcp_servers,
        )


def _ensure_transport() -> OpenCodeAppServerTransport:
    if _transport is None:
        raise RuntimeError("OpenCode app-server transport not initialized")
    return _transport


async def _ensure_transport_ready(cwd: Optional[str] = None) -> OpenCodeAppServerTransport:
    transport = _ensure_transport()
    await transport.ensure_ready(cwd=cwd)
    _ready_extensions.update(_registered_extension_ids or {"opencode-app-server"})
    return transport


def init_opencode_app_server_manager(
    extensions_dir: Path,
    server_root: Path,
    fws_getter: Callable[[], Awaitable[ShellManager]],
    broadcast_fn: Callable[[Dict[str, object]], Awaitable[None]],
    transcript_fn: Callable[[str, Dict[str, object]], Awaitable[None]],
    meta_fns: Optional[MetaFns] = None,
    registered_extension_ids: Optional[List[str]] = None,
) -> None:
    del extensions_dir
    global _transport, _broadcast_fn, _transcript_fn, _meta_fns, _server_root, _registered_extension_ids

    _server_root = server_root
    _registered_extension_ids = {
        ext_id
        for ext_id in (registered_extension_ids or [])
        if ext_id
    } or {"opencode-app-server"}
    _ready_extensions.clear()
    _broadcast_fn = broadcast_fn
    _transcript_fn = transcript_fn
    _meta_fns = meta_fns
    _transport = OpenCodeAppServerTransport(
        extension_root=Path(__file__).parent,
        fws_getter=fws_getter,
        raw_log_fn=_add_to_raw_buffer,
        broadcast_fn=broadcast_fn,
        transcript_fn=transcript_fn,
    )
    print("[OpenCodeAppServer] Extension initialized")


async def warm_up_all_extensions(timeout: float = 60.0) -> Dict[str, bool]:
    results = {ext_id: False for ext_id in sorted(_registered_extension_ids or {"opencode-app-server"})}
    try:
        transport = await _ensure_transport_ready()
        for ext_id in results:
            results[ext_id] = transport.is_ready()
    except Exception as exc:
        print(f"[OpenCodeAppServer] warm-up failed: {exc}")
    return results


def is_extension_ready(extension_id: str) -> bool:
    return extension_id in _ready_extensions and _transport is not None and _transport.is_ready()


async def wait_extension_ready(extension_id: str, timeout: float = 60.0) -> bool:
    del timeout
    try:
        transport = await _ensure_transport_ready()
    except Exception:
        return False
    if transport.is_ready():
        _ready_extensions.add(extension_id)
        return True
    return False


async def init_session(
    conversation_id: str,
    extension_id: str,
    cwd: Optional[str],
    settings: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    del extension_id
    resolved_cwd = _cwd_from_settings(settings, cwd)
    resolved_model = _model_from_settings(settings)
    meta = _load_meta(conversation_id)
    merged_settings = dict(_object_dict(meta.get("settings")))
    merged_settings.update(_object_dict(settings))
    resolved_provider = _provider_from_settings(merged_settings)
    transport = await _ensure_transport_ready(resolved_cwd)
    bound_session_id = _bound_provider_session_id(meta)
    session_name = _active_session_name(meta, provider_session_id=bound_session_id, settings=settings)
    approval_policy = _approval_policy_from_settings(merged_settings)
    sandbox = _app_server_sandbox_from_policy(_sandbox_policy_from_settings(merged_settings))
    reasoning_effort = _reasoning_effort_from_settings(merged_settings)
    instructions = _instruction_params_from_settings(merged_settings)
    mcp_servers = _mcp_servers_from_settings(merged_settings, conversation_id)
    if bound_session_id:
        session = await _ensure_bound_provider_session_loaded(
            transport,
            conversation_id=conversation_id,
            session_name=session_name,
            provider_session_id=bound_session_id,
            cwd=resolved_cwd,
            model=resolved_model,
            provider=resolved_provider,
            approval_policy=approval_policy,
            sandbox=sandbox,
            reasoning_effort=reasoning_effort,
            instructions=instructions,
            mcp_servers=mcp_servers,
        )
    else:
        session = await transport.ensure_session(
            session_name,
            resolved_cwd,
            provider=resolved_provider,
            model=resolved_model,
            approval_policy=approval_policy,
            sandbox=sandbox,
            reasoning_effort=reasoning_effort,
            instructions=instructions,
            mcp_servers=mcp_servers,
            conversation_id=conversation_id,
        )
    provider_session_id = _bind_session_meta(
        meta,
        session=session,
        active_session_name=session_name,
        settings=settings,
    )
    _save_meta(conversation_id, meta)
    return {
        "ok": True,
        "session_id": provider_session_id,
        "provider_session_id": provider_session_id,
        "thread_id": provider_session_id,
        "active_session_name": session_name,
    }


async def handle_message(
    conversation_id: str,
    text: str,
    agent_type: str,
    settings: Dict[str, object],
) -> Dict[str, object]:
    del agent_type
    if not conversation_id or not text:
        return {"ok": False, "error": "conversation_id and text required"}
    resolved_cwd = _cwd_from_settings(settings)
    resolved_model = _model_from_settings(settings)
    meta = _load_meta(conversation_id)
    merged_settings = dict(_object_dict(meta.get("settings")))
    merged_settings.update(_object_dict(settings))
    resolved_provider = _provider_from_settings(merged_settings)
    transport = await _ensure_transport_ready(resolved_cwd)
    bound_session_id = _bound_provider_session_id(meta)
    session_name = _active_session_name(meta, provider_session_id=bound_session_id, settings=settings)
    approval_policy = _approval_policy_from_settings(merged_settings)
    sandbox = _app_server_sandbox_from_policy(_sandbox_policy_from_settings(merged_settings))
    reasoning_effort = _reasoning_effort_from_settings(merged_settings)
    instructions = _instruction_params_from_settings(merged_settings)
    mcp_servers = _mcp_servers_from_settings(merged_settings, conversation_id)
    result = await _send_turn_with_lazy_resume(
        transport,
        conversation_id=conversation_id,
        session_name=session_name,
        provider_session_id=bound_session_id,
        prompt=text,
        cwd=resolved_cwd,
        model=resolved_model,
        provider=resolved_provider,
        approval_policy=approval_policy,
        sandbox=sandbox,
        reasoning_effort=reasoning_effort,
        instructions=instructions,
        mcp_servers=mcp_servers,
    )
    session = _object_dict(result.get("session"))
    provider_session_id = _bind_session_meta(
        meta,
        session=session,
        active_session_name=session_name,
        settings=settings,
    )
    _save_meta(conversation_id, meta)
    return {
        "ok": True,
        "provider_session_id": provider_session_id,
        "thread_id": provider_session_id,
        "active_session_name": session_name,
        "content": result.get("content", ""),
    }


async def list_sessions(
    cwd: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    resolved_cwd = _cwd_from_settings(settings, cwd)
    transport = await _ensure_transport_ready(resolved_cwd)
    result = await transport.rpc_request("session/list", params={"cwd": resolved_cwd}, timeout=10.0)
    sessions: List[Dict[str, object]] = []
    raw_sessions: object = result.get("sessions")
    if not isinstance(raw_sessions, list):
        raw_sessions = result.get("data")
    session_items = list(cast(List[object], raw_sessions)) if isinstance(raw_sessions, list) else []
    for item in session_items:
        item_dict = _object_dict(item)
        if not item_dict:
            continue
        session_id = (
            item_dict.get("providerSessionId")
            or item_dict.get("provider_session_id")
            or item_dict.get("sessionId")
            or item_dict.get("session_id")
            or item_dict.get("threadId")
            or item_dict.get("thread_id")
            or item_dict.get("id")
        )
        if not isinstance(session_id, str) or not session_id:
            continue
        title = item_dict.get("title")
        updated_at = item_dict.get("updatedAt")
        message_count = item_dict.get("messageCount")
        sessions.append({
            "id": session_id,
            "sessionId": session_id,
            "session_id": session_id,
            "label": title if isinstance(title, str) else session_id,
            "summary": title if isinstance(title, str) else session_id,
            "cwd": resolved_cwd,
            "updated_at": updated_at if isinstance(updated_at, str) else "",
            "created_at": updated_at if isinstance(updated_at, str) else "",
            "active": False,
            "message_count": message_count if isinstance(message_count, int) else None,
            "metadata": {
                "cwd": resolved_cwd,
                "providerSessionId": session_id,
                "index": item_dict.get("index"),
            },
        })
    return {"sessions": sessions}


async def resume_session_with_history(
    extension_id: str,
    session_id: str,
    conversation_id: str,
    cwd: Optional[str] = None,
    model: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    del extension_id
    if not session_id or not conversation_id:
        return {"ok": False, "error": "session_id and conversation_id required"}
    resolved_cwd = _cwd_from_settings(settings, cwd)
    resolved_model = _model_from_settings(settings, model)
    meta = _load_meta(conversation_id)
    merged_settings = dict(_object_dict(meta.get("settings")))
    merged_settings.update(_object_dict(settings))
    resolved_provider = _provider_from_settings(merged_settings)
    transport = await _ensure_transport_ready(resolved_cwd)
    existing_session_id = _bound_provider_session_id(meta)
    if existing_session_id and existing_session_id != session_id:
        return {"ok": False, "error": f"Conversation already bound to session {existing_session_id[:8]}"}
    session_name = _active_session_name(meta, provider_session_id=session_id, settings=settings)
    status_result = await transport.rpc_request(
        "session/status",
        params={"sessionId": session_id},
        timeout=10.0,
    )
    session = _object_dict(status_result)
    status_session_id = _string_value(
        session.get("providerSessionId"),
        session.get("sessionId"),
        session.get("threadId"),
    )
    if status_session_id != session_id:
        return {"ok": False, "error": "session/status did not confirm selected provider session"}
    merged_settings = _persistent_settings(settings)
    merged_settings["cwd"] = resolved_cwd
    if resolved_model:
        merged_settings["model"] = resolved_model
    if resolved_provider:
        merged_settings["provider"] = resolved_provider
    provider_session_id = _bind_session_meta(
        meta,
        session=session,
        active_session_name=session_name,
        settings=merged_settings,
    )
    _save_meta(conversation_id, meta)
    return {
        "ok": True,
        "session_id": provider_session_id,
        "provider_session_id": provider_session_id,
        "thread_id": provider_session_id,
        "active_session_name": session_name,
    }


def _history_timestamp(message: Dict[str, object]) -> str:
    time_info = _object_dict(message.get("time"))
    return _string_value(time_info.get("completed"), time_info.get("created"))


def _history_base_entry(
    role: str,
    *,
    conversation_id: str,
    message: Dict[str, object],
    item_id: str,
) -> Dict[str, object]:
    timestamp = _history_timestamp(message)
    entry: Dict[str, object] = {
        "role": role,
        "conversation_id": conversation_id,
        "item_id": item_id,
        "id": item_id,
        "source": "opencode-app-server",
    }
    if timestamp:
        entry["timestamp"] = timestamp
        entry["ts"] = timestamp
    return entry


def _json_text(value: object) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True)
    except TypeError:
        return str(value)


def _history_tool_content_text(value: object) -> str:
    parts: List[str] = []
    for item in _object_list(value):
        item_dict = _object_dict(item)
        text = _string_value(item_dict.get("text"))
        if text:
            parts.append(text)
    return "\n".join(parts)


def _history_tool_arguments(state: Dict[str, object]) -> Dict[str, object]:
    raw_input = state.get("input")
    input_map = _object_dict(raw_input)
    if input_map:
        return input_map
    if isinstance(raw_input, str) and raw_input:
        return {"input": raw_input}
    return {}


def _history_tool_result(state: Dict[str, object]) -> str:
    content = _history_tool_content_text(state.get("content"))
    if content:
        return content
    result = state.get("result")
    if result is not None:
        return _json_text(result)
    structured = state.get("structured")
    if structured is not None:
        return _json_text(structured)
    return ""


def _history_tool_entry(
    *,
    conversation_id: str,
    message: Dict[str, object],
    part: Dict[str, object],
) -> Optional[Dict[str, object]]:
    tool_id = _string_value(part.get("id"))
    tool_name = _string_value(part.get("name"))
    if not tool_id or not tool_name:
        return None
    state = _object_dict(part.get("state"))
    status = _string_value(state.get("status")) or "unknown"
    entry = _history_base_entry(
        "tool",
        conversation_id=conversation_id,
        message=message,
        item_id=tool_id,
    )
    entry.update({
        "tool": tool_name,
        "arguments": _history_tool_arguments(state),
        "result": _history_tool_result(state),
        "status": "failed" if status == "error" else status,
        "is_error": status == "error",
        "event": "history_tool",
    })
    error = _object_dict(state.get("error"))
    if error:
        entry["error"] = error
    return entry


def _history_assistant_entries(
    *,
    conversation_id: str,
    message: Dict[str, object],
) -> List[Dict[str, object]]:
    entries: List[Dict[str, object]] = []
    message_id = _string_value(message.get("id"))
    for index, part in enumerate(_object_list(message.get("content"))):
        part_map = _object_dict(part)
        part_type = _string_value(part_map.get("type"))
        part_id = _string_value(part_map.get("id")) or f"{message_id}:part:{index}"
        if part_type == "text":
            text = _string_value(part_map.get("text"))
            if text:
                entry = _history_base_entry(
                    "assistant",
                    conversation_id=conversation_id,
                    message=message,
                    item_id=part_id,
                )
                entry["text"] = text
                entries.append(entry)
        elif part_type == "reasoning":
            text = _string_value(part_map.get("text"))
            if text:
                entry = _history_base_entry(
                    "reasoning",
                    conversation_id=conversation_id,
                    message=message,
                    item_id=part_id,
                )
                entry["text"] = text
                entries.append(entry)
        elif part_type == "tool":
            tool_entry = _history_tool_entry(
                conversation_id=conversation_id,
                message=message,
                part=part_map,
            )
            if tool_entry is not None:
                entries.append(tool_entry)
    return entries


def _history_message_entries(
    *,
    conversation_id: str,
    message: Dict[str, object],
) -> List[Dict[str, object]]:
    message_type = _string_value(message.get("type"))
    message_id = _string_value(message.get("id"))
    if message_type == "user":
        text = _string_value(message.get("text"))
        if not text:
            return []
        entry = _history_base_entry(
            "user",
            conversation_id=conversation_id,
            message=message,
            item_id=message_id,
        )
        entry["text"] = text
        return [entry]
    if message_type == "assistant":
        return _history_assistant_entries(
            conversation_id=conversation_id,
            message=message,
        )
    if message_type == "shell":
        command = _string_value(message.get("command"))
        output = _string_value(message.get("output"))
        if not command and not output:
            return []
        entry = _history_base_entry(
            "command",
            conversation_id=conversation_id,
            message=message,
            item_id=message_id,
        )
        entry.update({
            "command": command,
            "output": output,
            "exit_code": 0,
            "status": "completed",
            "event": "history_shell",
        })
        return [entry]
    return []


async def _broadcast_history_import_activity(
    *,
    conversation_id: str,
    label: str,
    active: bool,
    message_count: int,
    entry_count: int,
    page: int,
) -> None:
    if _broadcast_fn is None:
        return
    await _broadcast_fn({
        "type": "activity",
        "conversation_id": conversation_id,
        "label": label,
        "active": active,
        "source": "opencode-app-server",
        "phase": "history_import",
        "message_count": message_count,
        "entry_count": entry_count,
        "page": page,
    })


async def hydrate_transcript(
    session_id: str,
    conversation_id: str,
    cwd: Optional[str] = None,
    model: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> List[Dict[str, object]]:
    del model
    resolved_cwd = _cwd_from_settings(settings, cwd)
    transport = await _ensure_transport_ready(resolved_cwd)
    entries: List[Dict[str, object]] = []
    cursor: Optional[Dict[str, object]] = None
    imported_raw_messages: List[object] = []
    imported_messages = 0
    page = 0
    await _broadcast_history_import_activity(
        conversation_id=conversation_id,
        label="importing history",
        active=True,
        message_count=0,
        entry_count=0,
        page=0,
    )
    failed = False
    try:
        while True:
            page += 1
            params: Dict[str, object] = {
                "sessionId": session_id,
                "limit": _HISTORY_IMPORT_PAGE_SIZE,
                "order": "desc",
            }
            if cursor is not None:
                params["cursor"] = cursor
            result = await transport.rpc_request(
                "session/messages",
                params=params,
                timeout=None,
            )
            raw_messages_value: object = result.get("messages")
            if not isinstance(raw_messages_value, list):
                raw_messages_value = result.get("data")
            message_items: List[object] = (
                list(cast(List[object], raw_messages_value))
                if isinstance(raw_messages_value, list)
                else []
            )
            if not message_items:
                break
            imported_raw_messages.extend(message_items)
            imported_messages += len(message_items)
            await _broadcast_history_import_activity(
                conversation_id=conversation_id,
                label=f"importing history ({imported_messages} messages)",
                active=True,
                message_count=imported_messages,
                entry_count=0,
                page=page,
            )
            result_cursor = _object_dict(result.get("cursor"))
            next_cursor = _string_value(result_cursor.get("id"), result.get("nextCursor"))
            if len(message_items) < _HISTORY_IMPORT_PAGE_SIZE or not next_cursor:
                break
            cursor = {"id": next_cursor, "direction": "previous"}
        for raw_message in reversed(imported_raw_messages):
            message = _object_dict(raw_message)
            if message:
                entries.extend(_history_message_entries(
                    conversation_id=conversation_id,
                    message=message,
                ))
    except Exception:
        failed = True
        raise
    finally:
        await _broadcast_history_import_activity(
            conversation_id=conversation_id,
            label="history import failed" if failed else "history imported",
            active=False,
            message_count=imported_messages,
            entry_count=len(entries),
            page=page,
        )
    _add_to_raw_buffer(
        "out",
        conversation_id,
        f"hydrate_transcript imported={len(entries)} messages={imported_messages} session={session_id[:8]}",
    )
    return entries


async def resolve_approval(request_id: str, resolution: object) -> bool:
    transport = _transport
    if transport is None:
        return False
    return await transport.resolve_approval(request_id, resolution)


async def abort_session(conversation_id: str) -> bool:
    if not conversation_id:
        return False
    transport = _transport
    if transport is None:
        return False
    try:
        result = await transport.cancel_turn_for_conversation(conversation_id)
    except Exception as exc:
        _add_to_raw_buffer("err", conversation_id, f"interrupt_failed {exc}")
        return False
    if result.get("ok") is True:
        turn_id = _string_value(result.get("turn_id"), result.get("turnId"))
        _add_to_raw_buffer("out", conversation_id, f"turn_cancel turn={turn_id[:8]}")
        return True
    error = _string_value(result.get("error")) or "interrupt not accepted"
    _add_to_raw_buffer("err", conversation_id, f"interrupt_failed {error}")
    return False


def validate_pending_approval(
    conversation_id: str,
    request_id: str,
    descriptor: Dict[str, object],
) -> bool:
    transport = _transport
    if transport is None:
        return False
    if descriptor.get("conversation_id") and descriptor.get("conversation_id") != conversation_id:
        return False
    return transport.has_pending_approval(request_id)


async def get_runtime_options(
    extension_id: str,
    conversation_id: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    merged_settings = dict(settings or {})
    if conversation_id:
        meta = _load_meta(conversation_id)
        persisted = _object_dict(meta.get("settings"))
        persisted.update(merged_settings)
        merged_settings = persisted
    approval_policy = _approval_policy_from_settings(merged_settings)
    sandbox_policy = _sandbox_policy_from_settings(merged_settings)
    approval_descriptor: Dict[str, object] = {
        "settingKey": "approval_policy",
        "runtimeKey": "approval",
        "label": "Approval Policy",
        "options": list(_APPROVAL_POLICY_OPTIONS),
        "current": approval_policy,
        "default": _DEFAULT_APPROVAL_POLICY,
        "footer": True,
    }
    sandbox_descriptor: Dict[str, object] = {
        "settingKey": "sandbox_policy",
        "runtimeKey": "sandbox",
        "label": "Sandbox Policy",
        "options": list(_SANDBOX_POLICY_OPTIONS),
        "current": sandbox_policy,
        "default": _DEFAULT_SANDBOX_POLICY,
    }
    return {
        "agent": extension_id,
        "approval": dict(approval_descriptor),
        "sandbox": dict(sandbox_descriptor),
        "fields": {
            "approval_policy": dict(approval_descriptor),
            "sandbox_policy": dict(sandbox_descriptor),
        },
        "quickControls": ["approval"],
    }


def _string_value(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return ""


def _bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _int_value(value: object) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip():
        try:
            parsed = int(value.strip())
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def _lookup_named(
    params: Dict[str, object],
    inputs: Dict[str, object],
    values: Dict[str, object],
    *keys: str,
) -> object:
    for source in (params, inputs, values):
        for key in keys:
            if key in source:
                return source[key]
    return None


def _safe_provider_config_token(value: str, *, fallback: str = "provider") -> str:
    token = "".join(
        ch.lower() if ch.isalnum() else "-"
        for ch in value.strip()
    ).strip("-")
    while "--" in token:
        token = token.replace("--", "-")
    if not token:
        token = fallback
    if len(token) <= 60:
        return token
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
    return f"{token[:49]}-{digest}"


def _provider_id_for_config(kind: str, base_url: str, model_id: str, requested: str = "") -> str:
    if requested.strip():
        return _safe_provider_config_token(requested, fallback=f"{kind}-provider")
    digest = hashlib.sha256(f"{kind}\n{base_url}\n{model_id}".encode("utf-8")).hexdigest()[:10]
    model_token = _safe_provider_config_token(model_id, fallback="model")
    return f"{kind}-{model_token[:40]}-{digest}"


def _write_provider_config(
    *,
    provider_id: str,
    name: str,
    base_url: str,
    endpoint: str,
    api_key: str,
    model_id: str,
    max_input_tokens: Optional[int],
    max_output_tokens: Optional[int],
    reasoning: Optional[object] = None,
    metadata: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    if not api_key.strip():
        raise ValueError("API key is required to save a provider config.")
    if not base_url.strip():
        raise ValueError("Base URL is required to save a provider config.")
    if not model_id.strip():
        raise ValueError("Model id is required to save a provider config.")

    provider_id = _safe_provider_config_token(provider_id, fallback="provider")
    payload: Dict[str, object] = {
        "id": provider_id,
        "name": name.strip() or provider_id,
        "baseURL": base_url.rstrip("/"),
        "endpoint": endpoint.strip() or "/chat/completions",
        "headers": {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key.strip()}",
        },
        "format": "openai",
        "streaming": True,
        "defaultModel": model_id.strip(),
    }
    if max_input_tokens:
        payload["maxInputTokens"] = max_input_tokens
    if max_output_tokens:
        payload["maxOutputTokens"] = max_output_tokens
    if reasoning:
        payload["reasoning"] = reasoning
    if metadata:
        payload["metadata"] = metadata

    _DEFAULT_PROVIDER_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    target = _DEFAULT_PROVIDER_CONFIG_DIR / f"{provider_id}.json"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
    finally:
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass

    return {
        "provider": provider_id,
        "model": model_id.strip(),
        "config_path": str(target),
        "name": payload["name"],
    }


def _schema_config_item(saved: Dict[str, object], source: str) -> Dict[str, object]:
    provider = str(saved.get("provider") or "")
    model = str(saved.get("model") or "")
    name = str(saved.get("name") or provider)
    return {
        "id": provider,
        "value": provider,
        "name": name,
        "label": name,
        "description": f"{model} via {provider}",
        "detail": f"Provider config saved at {saved.get('config_path', '')}",
        "config": provider,
        "provider": provider,
        "model": model,
        "source": source,
        "config_path": saved.get("config_path", ""),
    }


def _schema_config_success_response(config: Dict[str, object], message: str) -> Dict[str, object]:
    return {
        "ok": True,
        "kind": "info",
        "message": message,
        "config": config,
        "items": [config],
        "actions": [
            {
                "type": "upsert_option",
                "field": "config",
                "item_path": "config",
            },
            {
                "type": "select_option",
                "field": "config",
                "value_path": "config.id",
                "apply_write_back": True,
            },
            {
                "type": "collapse",
                "field": "config_generator",
            },
            {
                "type": "mark_dirty",
            },
        ],
    }


async def _schema_current_provider_list(
    params: Dict[str, object],
) -> Dict[str, object]:
    cwd = _string_value(params.get("cwd")) or None
    transport = await _ensure_transport_ready(cwd)
    result = await transport.rpc_request(
        "provider/list",
        params={"cwd": cwd} if cwd else {},
        timeout=10.0,
    )
    items: List[Dict[str, object]] = []
    for raw in _object_list(result.get("data")):
        item = _object_dict(raw)
        provider_id = _string_value(item.get("id"))
        if not provider_id:
            continue
        capabilities = _object_dict(item.get("capabilities"))
        if provider_id != "opencode" and item.get("configured") is not True and capabilities.get("configured") is not True:
            continue
        default_model = _string_value(item.get("defaultModel"))
        name = _string_value(item.get("displayName"), item.get("name"), provider_id)
        items.append({
            "id": provider_id,
            "name": name,
            "label": name,
            "description": f"Default model: {default_model}" if default_model else "",
            "config": provider_id,
            "provider": provider_id,
            "model": default_model,
            "source": "provider_list",
            "raw": item,
        })
    return {
        "ok": True,
        "kind": "list",
        "items": items,
        "default": result.get("default", ""),
    }


def _openrouter_cache_key(params: Dict[str, object]) -> Tuple[str, str, str]:
    supported = _string_value(params.get("supported_parameters"))
    modality = _string_value(params.get("output_modalities")) or "all"
    category = _string_value(params.get("category"))
    return supported, modality, category


def _fetch_openrouter_catalog_sync(
    *,
    api_key: str,
    supported_parameters: str,
    output_modalities: str,
    category: str,
) -> List[Dict[str, object]]:
    query: Dict[str, str] = {}
    if supported_parameters:
        query["supported_parameters"] = supported_parameters
    if output_modalities:
        query["output_modalities"] = output_modalities
    if category:
        query["category"] = category
    url = _OPENROUTER_MODELS_URL
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    response = cast(_HttpResponse, urllib.request.urlopen(request, timeout=20))
    try:
        parsed = cast(object, json.loads(response.read().decode("utf-8")))
    finally:
        response.close()
    data = _object_dict(parsed).get("data")
    return [_object_dict(item) for item in _object_list(data)]


async def _fetch_openrouter_catalog(
    *,
    api_key: str,
    params: Dict[str, object],
) -> List[Dict[str, object]]:
    key = _openrouter_cache_key(params)
    cached = _OPENROUTER_MODEL_CACHE.get(key)
    now = time.time()
    if cached and now - cached[0] < _OPENROUTER_CACHE_TTL_SECONDS:
        return list(cached[1])
    models = await asyncio.to_thread(
        _fetch_openrouter_catalog_sync,
        api_key=api_key,
        supported_parameters=key[0],
        output_modalities=key[1],
        category=key[2],
    )
    _OPENROUTER_MODEL_CACHE[key] = (now, models)
    return models


def _normalize_openrouter_model(item: Dict[str, object]) -> Dict[str, object]:
    model_id = _string_value(item.get("id"), item.get("canonical_slug"))
    name = _string_value(item.get("name"), model_id)
    description = _string_value(item.get("description"))
    architecture = _object_dict(item.get("architecture"))
    top_provider = _object_dict(item.get("top_provider"))
    pricing = _object_dict(item.get("pricing"))
    supported = [
        str(value)
        for value in _object_list(item.get("supported_parameters"))
        if isinstance(value, str)
    ]
    context_window = _int_value(top_provider.get("context_length")) or _int_value(item.get("context_length"))
    max_output = _int_value(top_provider.get("max_completion_tokens"))
    capabilities = {
        "supports_tools": "tools" in supported,
        "supports_tool_choice": "tool_choice" in supported,
        "supports_reasoning": "reasoning" in supported or "include_reasoning" in supported,
        "supports_reasoning_visibility": "include_reasoning" in supported,
        "supports_structured_outputs": "structured_outputs" in supported or "response_format" in supported,
        "supports_json_mode": "response_format" in supported,
        "input_modalities": _object_list(architecture.get("input_modalities")),
        "output_modalities": _object_list(architecture.get("output_modalities")),
        "supported_parameters": supported,
    }
    return {
        "id": model_id,
        "name": name,
        "label": f"{name} ({model_id})" if model_id and model_id != name else name,
        "description": description,
        "provider": "",
        "model": model_id,
        "provider_mode": "openrouter_api",
        "context_window": context_window,
        "max_output_tokens": max_output,
        "pricing_prompt": pricing.get("prompt"),
        "pricing_completion": pricing.get("completion"),
        "capabilities": capabilities,
        "raw": item,
    }


async def _schema_openrouter_search(
    params: Dict[str, object],
    inputs: Dict[str, object],
    values: Dict[str, object],
) -> Dict[str, object]:
    query = _string_value(_lookup_named(params, inputs, values, "query", "openrouter_query")).lower()
    api_key = _string_value(_lookup_named(params, inputs, values, "api_key", "openrouter_api_key"))
    supported: List[str] = []
    if _bool_value(_lookup_named(params, inputs, values, "requires_tools", "openrouter_requires_tools")):
        supported.append("tools")
    if _bool_value(_lookup_named(params, inputs, values, "requires_reasoning", "openrouter_requires_reasoning")):
        supported.append("reasoning")
    if _bool_value(_lookup_named(params, inputs, values, "requires_structured_outputs", "openrouter_requires_structured_outputs")):
        supported.append("structured_outputs")
    fetch_params: Dict[str, object] = {
        "supported_parameters": ",".join(supported),
        "output_modalities": _string_value(_lookup_named(params, inputs, values, "output_modalities")) or "all",
        "category": _string_value(_lookup_named(params, inputs, values, "category")),
    }
    raw_models = await _fetch_openrouter_catalog(api_key=api_key, params=fetch_params)
    normalized = [_normalize_openrouter_model(item) for item in raw_models]
    if query:
        normalized = [
            item
            for item in normalized
            if query in _string_value(item.get("id")).lower()
            or query in _string_value(item.get("name")).lower()
            or query in _string_value(item.get("description")).lower()
        ]
    normalized.sort(key=lambda item: (_string_value(item.get("name")).lower(), _string_value(item.get("id")).lower()))
    return {
        "ok": True,
        "kind": "list",
        "items": normalized[:50],
        "count": len(normalized),
    }


def _schema_save_raw_provider(
    params: Dict[str, object],
    inputs: Dict[str, object],
    values: Dict[str, object],
) -> Dict[str, object]:
    base_url = _string_value(_lookup_named(params, inputs, values, "base_url", "provider_base_url"))
    endpoint = _string_value(_lookup_named(params, inputs, values, "endpoint", "provider_endpoint")) or _OPENROUTER_ENDPOINT
    api_key = _string_value(_lookup_named(params, inputs, values, "api_key", "provider_api_key"))
    model_id = _string_value(_lookup_named(params, inputs, values, "model_id", "provider_model_id", "model"))
    name = _string_value(_lookup_named(params, inputs, values, "name", "provider_name")) or f"API: {model_id}"
    requested_provider = _string_value(_lookup_named(params, inputs, values, "provider", "provider_id", "config_id", "config"))
    provider_id = _provider_id_for_config("api", base_url, model_id, requested_provider)
    saved = _write_provider_config(
        provider_id=provider_id,
        name=name,
        base_url=base_url,
        endpoint=endpoint,
        api_key=api_key,
        model_id=model_id,
        max_input_tokens=_int_value(_lookup_named(params, inputs, values, "context_window", "max_input_tokens")),
        max_output_tokens=_int_value(_lookup_named(params, inputs, values, "max_output_tokens")),
        metadata={"source": "als_schema_api"},
    )
    return _schema_config_success_response(
        _schema_config_item(saved, "manual_api"),
        "Config saved and selected.",
    )


def _schema_save_openrouter_provider(
    params: Dict[str, object],
    inputs: Dict[str, object],
    values: Dict[str, object],
) -> Dict[str, object]:
    api_key = _string_value(_lookup_named(params, inputs, values, "api_key", "openrouter_api_key"))
    model_id = _string_value(_lookup_named(params, inputs, values, "model_id", "openrouter_model_id", "model"))
    name = (
        _string_value(_lookup_named(params, inputs, values, "name", "openrouter_config_name"))
        or _string_value(_lookup_named(params, inputs, values, "fallback_name", "openrouter_model_name"))
        or f"OpenRouter {model_id}"
    )
    provider_id = _provider_id_for_config("openrouter", _OPENROUTER_BASE_URL, model_id)
    requires_reasoning = _bool_value(
        _lookup_named(params, inputs, values, "requires_reasoning", "openrouter_requires_reasoning")
    )
    saved = _write_provider_config(
        provider_id=provider_id,
        name=name,
        base_url=_OPENROUTER_BASE_URL,
        endpoint=_OPENROUTER_ENDPOINT,
        api_key=api_key,
        model_id=model_id,
        max_input_tokens=_int_value(_lookup_named(params, inputs, values, "context_window", "openrouter_context_window")),
        max_output_tokens=_int_value(_lookup_named(params, inputs, values, "max_output_tokens", "openrouter_max_output_tokens")),
        reasoning=True if requires_reasoning else None,
        metadata={"source": "als_schema_openrouter"},
    )
    return _schema_config_success_response(
        _schema_config_item(saved, "openrouter_api"),
        "OpenRouter config saved and selected.",
    )


async def run_schema_interaction(
    extension_id: str,
    interaction_id: str,
    action: Optional[str] = None,
    inputs: Optional[Dict[str, object]] = None,
    values: Optional[Dict[str, object]] = None,
    params: Optional[Dict[str, object]] = None,
    conversation_id: Optional[str] = None,
    settings: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    del extension_id, conversation_id, settings
    action_name = (action or interaction_id or "").strip()
    safe_inputs = dict(inputs or {})
    safe_values = dict(values or {})
    safe_params = dict(params or {})
    try:
        if action_name == "provider.current.list":
            return await _schema_current_provider_list(safe_params)
        if action_name == "model.variants.list":
            return await _schema_model_variants_list(safe_params)
        if action_name == "openrouter.models.search":
            return await _schema_openrouter_search(safe_params, safe_inputs, safe_values)
        if action_name == "provider.raw.save":
            return _schema_save_raw_provider(safe_params, safe_inputs, safe_values)
        if action_name == "openrouter.provider.save":
            return _schema_save_openrouter_provider(safe_params, safe_inputs, safe_values)
    except (ValueError, urllib.error.URLError, TimeoutError) as exc:
        return {
            "ok": False,
            "supported": True,
            "interaction_id": interaction_id,
            "error": str(exc),
        }
    return {
        "ok": False,
        "supported": False,
        "interaction_id": interaction_id,
        "error": f"Unsupported schema interaction: {action_name}",
    }


async def list_providers() -> Dict[str, object]:
    transport = await _ensure_transport_ready()
    result = await transport.rpc_request("provider/list", params={}, timeout=15.0)
    providers: List[Dict[str, object]] = []
    for item in _object_list(result.get("data")):
        provider = _object_dict(item)
        provider_id = _string_value(provider.get("id"))
        if not provider_id:
            continue
        display_name = _string_value(provider.get("displayName"), provider.get("name"), provider_id)
        default_model = _string_value(provider.get("defaultModel"))
        description = f"Default model: {default_model}" if default_model else provider_id
        providers.append({
            "id": provider_id,
            "value": provider_id,
            "name": display_name,
            "label": display_name,
            "description": description,
            "detail": description,
            "provider": provider_id,
            "defaultModel": default_model,
            "raw": provider,
        })
    default = result.get("default")
    return {
        "providers": providers,
        "items": providers,
        "default": default if isinstance(default, str) else "",
    }


def _normalize_reasoning_efforts(raw_efforts: object) -> List[Dict[str, object]]:
    efforts: List[Dict[str, object]] = []
    for raw_effort in _object_list(raw_efforts):
        effort = _object_dict(raw_effort)
        value = _string_value(effort.get("value"), effort.get("id"), effort.get("variant"))
        if not value:
            continue
        label = _string_value(effort.get("label"), value)
        normalized_effort = dict(effort)
        normalized_effort.update({
            "id": value,
            "value": value,
            "label": label,
            "variant": _string_value(effort.get("variant"), value),
            "reasoningEffort": _string_value(effort.get("reasoningEffort"), value),
        })
        if "request" not in normalized_effort:
            request = {
                "headers": _object_dict(effort.get("headers")),
                "body": _object_dict(effort.get("body")),
                "generation": _object_dict(effort.get("generation")),
                "options": _object_dict(effort.get("options")),
            }
            if any(request.values()):
                normalized_effort["request"] = request
        if "raw" not in normalized_effort:
            normalized_effort["raw"] = effort
        efforts.append(normalized_effort)
    return efforts


async def _schema_model_variants_list(params: Dict[str, object]) -> Dict[str, object]:
    provider = _string_value(params.get("provider"), params.get("providerID"))
    model = _string_value(params.get("model"), params.get("modelID"))
    cwd = _string_value(params.get("cwd"))
    rpc_params: Dict[str, object] = {}
    if provider:
        rpc_params["provider"] = provider
    if model:
        rpc_params["model"] = model
    if cwd:
        rpc_params["cwd"] = cwd
    transport = await _ensure_transport_ready(cwd or None)
    result = await transport.rpc_request("model/variant/list", params=rpc_params, timeout=15.0)
    efforts = _normalize_reasoning_efforts(result.get("data"))
    default = _string_value(result.get("default"))
    return {
        "ok": True,
        "kind": "list",
        "items": efforts,
        "variants": efforts,
        "default": default,
        "count": len(efforts),
    }


async def list_models(**params: object) -> Dict[str, object]:
    provider_filter = _string_value(params.get("provider"))
    cwd = _string_value(params.get("cwd"))
    rpc_params: Dict[str, object] = {}
    if provider_filter:
        rpc_params["provider"] = provider_filter
    if cwd:
        rpc_params["cwd"] = cwd
    transport = await _ensure_transport_ready(cwd or None)
    result = await transport.rpc_request("model/list", params=rpc_params, timeout=15.0)
    items = _object_list(result.get("data"))
    models: List[Dict[str, object]] = []
    for item in items:
        model = _object_dict(item)
        model_id = _string_value(model.get("id"), model.get("value"))
        if not model_id:
            continue
        provider_id = _string_value(model.get("provider"), model.get("providerID"))
        model_leaf = _string_value(model.get("model"), model.get("modelID"))
        display_name = _string_value(model.get("displayName"), model.get("name"), model_id)
        description = f"{model_leaf or model_id} via {provider_id}" if provider_id else model_id
        efforts = _normalize_reasoning_efforts(
            model.get("supported_reasoning_efforts")
            or model.get("supportedReasoningEfforts")
        )
        default_effort = _string_value(
            model.get("default_reasoning_effort"),
            model.get("defaultReasoningEffort"),
        )
        models.append({
            "id": model_id,
            "value": model_id,
            "name": display_name,
            "label": display_name,
            "description": description,
            "detail": description,
            "provider": provider_id,
            "providerID": provider_id,
            "model": model_leaf,
            "modelID": model_leaf,
            "supported_reasoning_efforts": efforts,
            "supportedReasoningEfforts": efforts,
            "default_reasoning_effort": default_effort,
            "defaultReasoningEffort": default_effort,
            "capabilities": model.get("capabilities"),
            "raw": model,
        })
    default = result.get("default")
    return {"models": models, "items": models, "default": default if isinstance(default, str) else ""}


async def get_settings_schema(extension_id: str) -> Dict[str, object]:
    del extension_id
    schema = _load_settings_schema_template()
    schema["cache"] = "none"
    return schema


async def shutdown_client() -> None:
    if _transport is not None:
        await _transport.stop()
    _ready_extensions.clear()
