"""Shared helpers for the Phase 1 backend tests.

The tests never touch a real Ollama instance. They inject a recording transport so
every outbound request can be asserted, which is how the "no automatic install or
preload" guarantee is verified.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
import re
from typing import Any

import httpx
from fastapi import FastAPI

from api.app.config import Settings
from api.app.main import create_app
from api.app.ollama_client import OllamaProbe

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = REPO_ROOT / "docs" / "contracts"
COMPOSE_FILE = REPO_ROOT / "compose.yaml"

OLLAMA_BASE_URL = "http://ollama:11434"
BASE_URL = "http://api.internal"
TEST_SETTINGS = Settings(
    ollama_base_url=OLLAMA_BASE_URL,
    ollama_timeout_seconds=1.0,
    database_path=":memory:",
)

RequestHandler = Callable[[httpx.Request], httpx.Response]


class RecordingTransport(httpx.AsyncBaseTransport):
    """Async transport that records every request before answering it."""

    def __init__(self, handler: RequestHandler) -> None:
        self._handler = handler
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)

    @property
    def requested_paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    @property
    def requested_methods(self) -> list[str]:
        return [request.method for request in self.requests]


def build_app(handler: RequestHandler) -> tuple[FastAPI, RecordingTransport]:
    """Create the application wired to a recording transport."""
    transport = RecordingTransport(handler)
    probe = OllamaProbe(OLLAMA_BASE_URL, 1.0, transport=transport)
    return create_app(settings=TEST_SETTINGS, ollama_probe=probe), transport


def json_handler(payloads: Mapping[str, object], status_code: int = 200) -> RequestHandler:
    """Answer the mapped paths with JSON and everything else with 404."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path not in payloads:
            return httpx.Response(404, json={"error": "unmapped path"}, request=request)
        return httpx.Response(status_code, json=payloads[path], request=request)

    return handler


def offline_handler(request: httpx.Request) -> httpx.Response:
    """Simulate an Ollama container that is not running."""
    raise httpx.ConnectError("connection refused", request=request)


def models_payload(*names: str) -> dict[str, object]:
    return {"models": [{"name": name, "model": name, "size": 2_497_280_480} for name in names]}


def handler_with_paths(
    tags: Mapping[str, object],
    loaded: Mapping[str, object],
) -> RequestHandler:
    return json_handler({"/api/tags": tags, "/api/ps": loaded})


def forbidden_operations() -> Sequence[str]:
    """Ollama routes that download, load or generate: Phase 1 must never call them."""
    return ("pull", "push", "generate", "chat", "embed", "copy", "create", "delete", "blobs")


def service_blocks(compose_text: str) -> dict[str, str]:
    """Map each Compose service name to its raw YAML block.

    Deliberately dependency-free: the repository pins no YAML parser, and the phase
    only needs to read the indentation of a file it owns.
    """
    blocks: dict[str, str] = {}
    in_services = False
    current_name: str | None = None
    current_lines: list[str] = []

    def flush() -> None:
        if current_name is not None:
            blocks[current_name] = "\n".join(current_lines)

    for line in compose_text.splitlines():
        if not in_services:
            if line.startswith("services:"):
                in_services = True
            continue
        if line and not line.startswith(" ") and not line.lstrip().startswith("#"):
            break  # left the services section
        if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
            flush()
            current_name = line.strip()[:-1]
            current_lines = []
            continue
        current_lines.append(line)

    flush()
    return blocks


def published_host_ports(service_block: str) -> list[str]:
    """Read the `ports:` entries of one service block, resolving `${VAR:-default}`."""
    ports: list[str] = []
    in_ports = False
    for line in service_block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "ports:":
            in_ports = True
            continue
        if in_ports:
            if stripped.startswith("- "):
                ports.append(_resolve_default(stripped[2:].strip().strip('"').strip("'")))
            else:
                in_ports = False
    return ports


def _resolve_default(value: str) -> str:
    """Replace every ``${VAR:-default}`` with its declared default."""
    return re.sub(r"\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}", r"\1", value)


async def asgi_request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    """Call the application in-process without the deprecated TestClient wrapper."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as client:
        return await client.request(method, path, **kwargs)


async def asgi_get(app: FastAPI, path: str, **kwargs: Any) -> httpx.Response:
    return await asgi_request(app, "GET", path, **kwargs)


async def asgi_post(app: FastAPI, path: str, **kwargs: Any) -> httpx.Response:
    return await asgi_request(app, "POST", path, **kwargs)


async def asgi_delete(app: FastAPI, path: str, **kwargs: Any) -> httpx.Response:
    return await asgi_request(app, "DELETE", path, **kwargs)


async def run_lifespan(app: FastAPI) -> list[dict[str, object]]:
    """Drive the ASGI lifespan protocol, so any startup hook would run here.

    Phase 1 has no lifespan hook. This helper exists to prove it: the recording
    transport must stay empty after startup and shutdown complete.
    """
    incoming: list[dict[str, object]] = [
        {"type": "lifespan.startup"},
        {"type": "lifespan.shutdown"},
    ]
    sent: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        return incoming.pop(0)

    async def send(message: dict[str, object]) -> None:
        sent.append(message)

    await app({"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}}, receive, send)
    return sent
