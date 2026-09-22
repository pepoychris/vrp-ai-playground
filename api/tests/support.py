"""Shared helpers for the Phase 1 backend tests.

The tests never touch a real Ollama instance. They inject a recording transport so
every outbound request can be asserted, which is how the "no automatic install or
preload" guarantee is verified.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
import json
from pathlib import Path
import re
from typing import Any

import httpx
from fastapi import FastAPI

from api.app.config import MODEL_NAME, Settings
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
    # Keep the install stream responsive in tests: a heartbeat is a comment frame, so a
    # short window costs nothing and stops a gated download from stalling the suite.
    ai_stream_heartbeat_seconds=0.05,
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


class ChunkStream(httpx.AsyncByteStream):
    """Body stream built from an async generator of byte chunks.

    The recording transport answers with fully buffered responses, which is enough for a
    probe but not for a download: the install tests need bytes to arrive one line at a
    time so live progress can be observed.
    """

    def __init__(self, source: Any) -> None:
        self._source = source

    async def __aiter__(self):  # type: ignore[override]
        async for chunk in self._source():
            yield chunk


class FakeOllama:
    """In-memory Ollama double covering tags, ps, pull, generate and chat.

    It records every JSON body it receives, so a test can assert exactly which model,
    inference options and ``keep_alive`` window the backend asked for. No test needs a
    real Ollama service.
    """

    def __init__(
        self,
        *,
        installed: Sequence[str] = (),
        loaded: Sequence[str] = (),
        pull_lines: Sequence[Mapping[str, Any]] | None = None,
        pull_gate: asyncio.Event | None = None,
        pull_installs: bool = True,
        pull_error: Exception | None = None,
        chat_replies: Sequence[str] | None = None,
        chat_error: Exception | None = None,
        chat_thinking: str | None = None,
        generate_installs: bool = True,
    ) -> None:
        self.installed = set(installed)
        self.loaded = set(loaded)
        self.pull_lines = list(
            pull_lines
            if pull_lines is not None
            else (
                {"status": "pulling manifest"},
                {"status": "pulling 3e4cb1417446", "total": 1000, "completed": 425},
                {"status": "verifying sha256 digest"},
                {"status": "success"},
            )
        )
        self.pull_gate = pull_gate
        self.pull_installs = pull_installs
        self.pull_error = pull_error
        self.chat_replies = list(chat_replies or [])
        self.chat_error = chat_error
        self.chat_thinking = chat_thinking
        self.generate_installs = generate_installs
        self.pull_bodies: list[dict[str, Any]] = []
        self.generate_bodies: list[dict[str, Any]] = []
        self.chat_bodies: list[dict[str, Any]] = []

    # -- transport ---------------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path == "/api/tags":
            return httpx.Response(200, json=models_payload(*sorted(self.installed)), request=request)
        if request.method == "GET" and path == "/api/ps":
            return httpx.Response(200, json=models_payload(*sorted(self.loaded)), request=request)
        if request.method == "POST" and path == "/api/pull":
            self.pull_bodies.append(_json_body(request))
            return httpx.Response(
                200, stream=ChunkStream(self._pull_chunks), request=request,
                headers={"content-type": "application/x-ndjson"},
            )
        if request.method == "POST" and path == "/api/generate":
            body = _json_body(request)
            self.generate_bodies.append(body)
            if self.generate_installs:
                self.loaded.add(str(body.get("model", "")))
            return httpx.Response(200, json={"done": True}, request=request)
        if request.method == "POST" and path == "/api/chat":
            self.chat_bodies.append(_json_body(request))
            if self.chat_error is not None:
                raise self.chat_error
            content = self.chat_replies.pop(0) if self.chat_replies else "{}"
            message: dict[str, Any] = {"role": "assistant", "content": content}
            if self.chat_thinking is not None:
                message["thinking"] = self.chat_thinking
            return httpx.Response(
                200,
                json={
                    "model": MODEL_NAME,
                    "message": message,
                    "total_duration": 2_841_000_000,
                    "load_duration": 120_000_000,
                    "prompt_eval_duration": 610_000_000,
                    "eval_duration": 2_100_000_000,
                },
                request=request,
            )
        return httpx.Response(404, json={"error": "unmapped path"}, request=request)

    async def _pull_chunks(self):
        for index, line in enumerate(self.pull_lines):
            if index and self.pull_gate is not None:
                await self.pull_gate.wait()
            yield (json.dumps(line) + "\n").encode("utf-8")
        if self.pull_error is not None:
            raise self.pull_error
        if self.pull_installs:
            self.installed.add(MODEL_NAME)


def _json_body(request: httpx.Request) -> dict[str, Any]:
    try:
        payload = json.loads(request.content.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):  # pragma: no cover - defensive
        return {}
    return payload if isinstance(payload, dict) else {}


def build_ai_app(fake: FakeOllama) -> tuple[FastAPI, RecordingTransport]:
    """Create the application wired to the in-memory Ollama double."""
    return build_app(fake.handler)


def request_json(transport: RecordingTransport, path: str, method: str = "POST") -> dict[str, Any]:
    """The most recent JSON body the backend sent to one Ollama path."""
    for request in reversed(transport.requests):
        if request.url.path == path and request.method == method:
            return _json_body(request)
    raise AssertionError(f"no {method} {path} request was recorded")


def contract_registry() -> Any | None:
    """Registry of the frozen schemas, so their cross-file ``$ref``s resolve.

    The Phase 8 events reference ``common.schema.json`` and ``envelopes.schema.json`` by
    relative URI, which needs a registry rather than a bare validator. Returns ``None``
    when the development dependency is absent so a contract test can skip instead of
    failing.
    """
    try:
        import jsonschema  # noqa: F401
        from referencing import Registry, Resource
    except ImportError:  # pragma: no cover - dev dependency
        return None
    resources = []
    for path in sorted((CONTRACTS_DIR / "schemas").glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        resources.append((document["$id"], Resource.from_contents(document)))
    return Registry().with_resources(resources)


def schema_validator(schema_file: str, pointer: str) -> Any | None:
    """An entry-point validator for one ``$defs`` member of a frozen schema."""
    registry = contract_registry()
    if registry is None:
        return None
    try:
        import jsonschema
    except ImportError:  # pragma: no cover - dev dependency
        return None
    schema = json.loads(
        (CONTRACTS_DIR / "schemas" / schema_file).read_text(encoding="utf-8")
    )
    return jsonschema.Draft202012Validator(
        {"$ref": pointer, **schema}, registry=registry
    )


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
