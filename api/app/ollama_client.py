"""Read-only probe of the Ollama service.

Phase 1 only has to answer three questions: is Ollama reachable, is the fixed model
installed, and is it loaded. That is why this module knows exactly two endpoints,
``GET /api/tags`` and ``GET /api/ps``.

There is no pull, generate, chat, embed, copy or delete call anywhere in the
codebase, so importing or starting the API cannot download or preload a model.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

import httpx

TAGS_PATH: Final = "/api/tags"
PS_PATH: Final = "/api/ps"


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
    ) -> None:
        self._base_url = base_url
        self._timeout_seconds = timeout_seconds
        self._transport = transport

    @property
    def base_url(self) -> str:
        return self._base_url

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
