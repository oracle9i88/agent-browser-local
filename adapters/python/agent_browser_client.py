"""Fixed-principal HTTP adapter for NovaGe and NovaDe.

This module intentionally exposes no generic HTTP, selector, script, publish,
delete, or confirmation escape hatch. The daemon remains the authority for
capabilities and action policy.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


_PRINCIPALS = {"novage", "novade"}
_ACTIONS = {
    "status": ("GET", "/v1/status"),
    "navigate": ("POST", "/v1/navigate"),
    "snapshot": ("POST", "/v1/snapshot"),
    "click": ("POST", "/v1/actions/click"),
    "fill": ("POST", "/v1/actions/fill"),
    "upload": ("POST", "/v1/actions/upload"),
    "screenshot": ("POST", "/v1/screenshot"),
    "visual_click": ("POST", "/v1/actions/visual-click"),
    "handoff": ("POST", "/v1/handoff"),
}


def _runtime_dir() -> Path:
    return Path(
        os.environ.get(
            "ABL_RUNTIME_DIR",
            str(Path.home() / ".agent-browser-local"),
        )
    ).resolve()


def _server_url() -> str:
    value = os.environ.get("ABL_SERVER_URL", "http://127.0.0.1:3767").rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Agent Browser server must be loopback HTTP")
    return value


def _fixed_token(principal: str) -> str:
    if principal not in _PRINCIPALS:
        raise RuntimeError("Unknown fixed Agent Browser principal")
    key = f"ABL_{principal.upper()}_TOKEN"
    token_file = _runtime_dir() / "tokens.env"
    try:
        lines = token_file.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise RuntimeError(f"Cannot read Agent Browser token file: {token_file}") from exc
    for line in lines:
        name, separator, value = line.partition("=")
        if separator and name == key and value:
            return value
    raise RuntimeError(f"Missing fixed token for {principal}")


def _workspace_file(workspace: Path, value: str) -> str:
    root = Path(workspace).resolve()
    candidate = Path(value)
    candidate = (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise RuntimeError("Nova Agent uploads must come from its workspace") from exc
    if not candidate.is_file():
        raise RuntimeError(f"Upload file does not exist: {candidate.name}")
    return str(candidate)


def _payload(action: str, workspace: Path, values: dict) -> dict:
    if action == "navigate":
        return {"url": values.get("url", "")}
    if action == "click":
        return {"ref": values.get("ref", "")}
    if action == "fill":
        return {"ref": values.get("ref", ""), "value": values.get("value", "")}
    if action == "upload":
        files = values.get("files") or []
        return {
            "ref": values.get("ref", ""),
            "files": [_workspace_file(Path(workspace), item) for item in files],
        }
    if action == "visual_click":
        return {
            "screenshotId": values.get("screenshot_id", ""),
            "x": values.get("x"),
            "y": values.get("y"),
        }
    if action == "handoff":
        return {"reason": values.get("reason", "")}
    return {}


def _request(principal: str, action: str, payload: dict) -> dict:
    if action not in _ACTIONS:
        raise RuntimeError("Unsupported Agent Browser action")
    method, pathname = _ACTIONS[action]
    body = None if method == "GET" else json.dumps(payload).encode("utf-8")
    request = Request(
        f"{_server_url()}{pathname}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {_fixed_token(principal)}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", {})
        except Exception:
            detail = {}
        raise RuntimeError(
            f"{detail.get('code', 'http_error')}: {detail.get('message', 'Request rejected')}"
        ) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("Agent Browser daemon is unavailable") from exc
    if not result.get("ok"):
        detail = result.get("error", {})
        raise RuntimeError(
            f"{detail.get('code', 'request_failed')}: {detail.get('message', 'Request failed')}"
        )
    return result.get("result", {})


def _store_screenshot(workspace: Path, result: dict) -> dict:
    encoded = result.pop("dataBase64", "")
    if not encoded:
        return result
    root = Path(workspace).resolve()
    output_dir = root / ".agent-browser" / "screenshots"
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshot_id = str(result.get("screenshotId", "unknown"))
    output_path = output_dir / f"{screenshot_id}.png"
    output_path.write_bytes(base64.b64decode(encoded, validate=True))
    result["localPath"] = str(output_path)
    return result


def call_agent_browser(
    principal: str,
    workspace: Path,
    action: str,
    **values,
) -> str:
    """Call one contribution-only browser action with a fixed local principal."""
    if principal not in _PRINCIPALS:
        raise RuntimeError("Unknown fixed Agent Browser principal")
    if action not in _ACTIONS:
        raise RuntimeError("Unsupported Agent Browser action")
    result = _request(principal, action, _payload(action, Path(workspace), values))
    if action == "screenshot":
        result = _store_screenshot(Path(workspace), dict(result))
    return json.dumps(result, ensure_ascii=False, indent=2)
