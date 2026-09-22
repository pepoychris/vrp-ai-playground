"""Ollama transport used by the backend.

Phase 1 asked three questions: is Ollama reachable, is the fixed model installed, and
is it loaded. Phase 8 adds the two user-triggered operations the local copilot needs —
a streaming pull and a chat completion — plus the preload that activates the model.

Every call here is made on an explicit user request. Importing or starting the API
still performs no network call, no download and no preload, because nothing in this
module runs at import time and the application has no startup hook.

The model name is not a caller decision: :func:`fixed_model_name` rejects anything but
the frozen ``qwen3:4b``, so a request cannot smuggle a different model into the
transport even if a higher layer forgot to validate it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
import json
from typing import Any, Final

import httpx

from .config import MODEL_NAME

TAGS_PATH: Final = "/api/tags"
PS_PATH: Final = "/api/ps"
PULL_PATH: Final = "/api/pull"
GENERATE_PATH: Final = "/api/generate"
CHAT_PATH: Final = "/api/chat"

# Ollama reports request timings in nanoseconds; the frozen contract uses milliseconds.
NANOSECONDS_PER_MILLISECOND: Final = 1_000_000

# Ollama's own vocabulary is translated into the frozen install states here, so a change
# in the pull stream cannot leak into the frontend contract.
PULL_STATE_IDLE: Final = "IDLE"
PULL_STATE_DOWNLOADING: Final = "DOWNLOADING"
PULL_STATE_VERIFYING: Final = "VERIFYING"
PULL_STATE_COMPLETED: Final = "COMPLETED"
PULL_STATE_FAILED: Final = "FAILED"

_VERIFYING_MARKERS: Final = ("verifying", "writing manifest", "removing any unused layers")


@dataclass(frozen=True, slots=True)
class OllamaStatus:
    """Raw result of a probe. Interpretation belongs to the endpoint."""

    service_available: bool
    installed_models: tuple[str, ...]
    loaded_models: tuple[str, ...]

    def has_installed(self, model_name: str) -> bool:
        return model_name in self.installed_models

    def has_loaded(self, model_name: str) -> bool:
        return model_name in self.loaded_models


@dataclass(frozen=True, slots=True)
class PullProgress:
    """One normalized step of a model download, in the frozen install vocabulary."""

    state: str
    percent: float | None
    status_text: str
    error: str | None = None
    done: bool = False


@dataclass(frozen=True, slots=True)
class ChatResult:
    """A non-streaming completion: the raw assistant text and its timings."""

    content: str
    timings_ms: dict[str, int]


def fixed_model_name(model_name: str) -> str:
    """Return the frozen model name, or refuse to talk to any other model."""
    if model_name != MODEL_NAME:
        raise ValueError(f"the backend only talks to {MODEL_NAME}")
    return model_name


def normalize_pull_event(payload: Mapping[str, Any]) -> PullProgress:
    """Translate one Ollama pull progress line into the frozen install vocabulary.

    The contract deliberately does not freeze Ollama's internal keys: everything the
    browser sees goes through this function, so a pull stream that gains a field does not
    change the ``ai.install`` event.
    """
    error = payload.get("error")
    if isinstance(error, str) and error.strip():
        return PullProgress(
            state=PULL_STATE_FAILED,
            percent=None,
            status_text=error.strip(),
            error=error.strip(),
            done=True,
        )

    status = payload.get("status")
    status_text = status.strip() if isinstance(status, str) and status.strip() else ""
    completed = _non_negative_number(payload.get("completed"))
    total = _non_negative_number(payload.get("total"))
    percent = (
        round(min(100.0, completed / total * 100.0), 2)
        if completed is not None and total is not None and total > 0
        else None
    )

    lowered = status_text.lower()
    if lowered.startswith("success"):
        return PullProgress(
            state=PULL_STATE_COMPLETED,
            percent=100.0,
            status_text=status_text or "success",
            done=True,
        )
    if any(marker in lowered for marker in _VERIFYING_MARKERS):
        return PullProgress(
            state=PULL_STATE_VERIFYING, percent=percent, status_text=status_text
        )
    if percent is not None:
        return PullProgress(
            state=PULL_STATE_DOWNLOADING, percent=percent, status_text=status_text
        )
    return PullProgress(
        state=PULL_STATE_DOWNLOADING,
        percent=None,
        status_text=status_text or "downloading",
    )


def _non_negative_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0:
        return None
    return float(value)


def _milliseconds(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, int(value // NANOSECONDS_PER_MILLISECOND))


def chat_timings_ms(payload: Mapping[str, Any]) -> dict[str, int]:
    """Map Ollama's nanosecond timings onto the frozen ``timingsMs`` object."""
    mapping = (
        ("total", "total_duration"),
        ("load", "load_duration"),
        ("promptEval", "prompt_eval_duration"),
        ("eval", "eval_duration"),
    )
    timings: dict[str, int] = {"total": 0}
    for field, source_key in mapping:
        milliseconds = _milliseconds(payload.get(source_key))
        if milliseconds is None:
            continue
        timings[field] = milliseconds
    return timings


class OllamaProbe:
    """Probes Ollama through the internal stack network.

    An HTTP client is opened per probe and closed immediately afterwards, so
    constructing the application creates no connection and no background task.
    """

    def __init__(
        self,
        base_url: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
        *,
        long_timeout_seconds: float | None = None,
    ) -> None:
        self._base_url = base_url
        self._timeout_seconds = timeout_seconds
        self._transport = transport
        # Downloads and completions take longer than a readiness probe, so they get their
        # own read budget while the connect budget stays the probe one.
        self._long_timeout_seconds = (
            long_timeout_seconds
            if long_timeout_seconds is not None and long_timeout_seconds > 0
            else timeout_seconds
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def long_timeout_seconds(self) -> float:
        return self._long_timeout_seconds

    async def fetch_status(self) -> OllamaStatus:
        """Read tags and ps concurrently. Never raises: a failure is reported."""
        async with httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout_seconds,
            transport=self._transport,
        ) as client:
            installed, loaded = await asyncio.gather(
                self._list_models(client, TAGS_PATH),
                self._list_models(client, PS_PATH),
            )
        return OllamaStatus(
            service_available=installed is not None or loaded is not None,
            installed_models=installed or (),
            loaded_models=loaded or (),
        )

    @staticmethod
    async def _list_models(client: httpx.AsyncClient, path: str) -> tuple[str, ...] | None:
        try:
            response = await client.get(path, headers={"accept": "application/json"})
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            # Unreachable, timed out, non-2xx or non-JSON: report the probe as failed.
            return None
        if not isinstance(payload, Mapping):
            return None
        return model_names(payload.get("models"))

    async def pull(self, model_name: str, *, keep_alive: str | None = None):
        """Stream one ``POST /api/pull`` as normalized :class:`PullProgress` steps.

        The caller drives the iteration, so the download only ever runs because a user
        pressed *Install Qwen Core*. Lines that are not JSON objects are skipped instead
        of aborting a download that is already in flight.
        """
        fixed_model_name(model_name)
        body: dict[str, Any] = {"model": model_name, "stream": True}
        if keep_alive:
            body["keep_alive"] = keep_alive
        timeout = httpx.Timeout(self._long_timeout_seconds, connect=self._timeout_seconds)
        async with httpx.AsyncClient(
            base_url=self._base_url, timeout=timeout, transport=self._transport
        ) as client:
            async with client.stream("POST", PULL_PATH, json=body) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        payload = json.loads(stripped)
                    except ValueError:
                        continue
                    if isinstance(payload, Mapping):
                        yield normalize_pull_event(payload)

    async def preload(
        self,
        model_name: str,
        *,
        keep_alive: str,
        think: bool = False,
    ) -> None:
        """Preload the fixed model with ``keep_alive`` and no prompt.

        An empty generate request is Ollama's preload: it loads the weights and returns,
        and ``keep_alive`` decides how long they stay resident. Nothing is downloaded
        here, so an uninstalled model fails instead of pulling implicitly.
        """
        fixed_model_name(model_name)
        body: dict[str, Any] = {
            "model": model_name,
            "prompt": "",
            "stream": False,
            "think": think,
            "keep_alive": keep_alive,
        }
        async with httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._long_timeout_seconds,
            transport=self._transport,
        ) as client:
            response = await client.post(
                GENERATE_PATH, json=body, headers={"accept": "application/json"}
            )
            response.raise_for_status()

    async def chat(
        self,
        model_name: str,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        num_ctx: int,
        keep_alive: str,
        format_schema: Mapping[str, Any] | None = None,
        think: bool = False,
        timeout_seconds: float | None = None,
    ) -> ChatResult:
        """Run one non-streaming completion and return the assistant text.

        The inference options are arguments of this function and never of the HTTP
        request, so the browser cannot pick a model, a temperature, a context window or a
        ``keep_alive`` window. ``think=False`` keeps the model's reasoning out of the
        response: the API never stores or forwards it.
        """
        fixed_model_name(model_name)
        body: dict[str, Any] = {
            "model": model_name,
            "messages": messages,
            "stream": False,
            "think": think,
            "keep_alive": keep_alive,
            "options": {"temperature": temperature, "num_ctx": num_ctx},
        }
        if format_schema is not None:
            body["format"] = dict(format_schema)
        async with httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout_seconds or self._long_timeout_seconds,
            transport=self._transport,
        ) as client:
            response = await client.post(
                CHAT_PATH, json=body, headers={"accept": "application/json"}
            )
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, Mapping):
            raise ValueError("ollama returned a non-object chat response")
        message = payload.get("message")
        content = message.get("content") if isinstance(message, Mapping) else None
        if not isinstance(content, str):
            raise ValueError("ollama returned a chat response without assistant content")
        return ChatResult(content=content, timings_ms=chat_timings_ms(payload))


def model_names(raw_models: Any) -> tuple[str, ...]:
    """Extract model identifiers from an Ollama ``models`` array."""
    if not isinstance(raw_models, Iterable) or isinstance(raw_models, (str, bytes)):
        return ()
    names: list[str] = []
    for entry in raw_models:
        if not isinstance(entry, Mapping):
            continue
        candidate = entry.get("name") or entry.get("model")
        if isinstance(candidate, str) and candidate.strip():
            names.append(candidate.strip())
    return tuple(names)
