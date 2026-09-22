"""Frozen runtime configuration for the RoboRoute Nexus API.

Phase 0 fixed the model, the inference settings and the base images in
``docs/contracts/versions.md``. Phase 1 wires those decisions into the service
without implementing any AI call yet.

The chat model is a module constant on purpose: the browser must never be able to
choose it, so there is no environment variable that changes it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final, Literal, Mapping

SERVICE_NAME: Final = "roboroute-api"
SERVICE_VERSION: Final = "0.1.0"

# Fixed by docs/contracts/versions.md. Not configurable by environment or request.
ModelName = Literal["qwen3:4b"]
MODEL_NAME: Final[ModelName] = "qwen3:4b"

# Inference defaults approved in Phase 0. The backend applies them when Phase 8
# talks to Ollama; the browser never sends `model`, `think`, `options` or
# `keep_alive`.
NUM_CTX: Final = 8192
THINK: Final = False
CHAT_TEMPERATURE: Final = 0.2
REPORT_TEMPERATURE: Final = 0.0

# Ollama-side settings. Values mirror the container environment in compose.yaml.
OLLAMA_NO_CLOUD: Final = "1"
OLLAMA_NUM_PARALLEL: Final = "1"
OLLAMA_MAX_LOADED_MODELS: Final = "1"

DEFAULT_OLLAMA_BASE_URL: Final = "http://ollama:11434"
DEFAULT_OLLAMA_TIMEOUT_SECONDS: Final = 2.0
DEFAULT_DATABASE_PATH: Final = "/data/roboroute.db"

ENV_OLLAMA_BASE_URL: Final = "ROBOROUTE_OLLAMA_BASE_URL"
ENV_OLLAMA_TIMEOUT_SECONDS: Final = "ROBOROUTE_OLLAMA_TIMEOUT_SECONDS"
ENV_DATABASE_PATH: Final = "ROBOROUTE_DB_PATH"


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings.

    Deliberately small: everything that Phase 1 can configure lives here, and the
    model name is not part of it because the model is not configurable.
    """

    ollama_base_url: str = DEFAULT_OLLAMA_BASE_URL
    ollama_timeout_seconds: float = DEFAULT_OLLAMA_TIMEOUT_SECONDS
    database_path: str = DEFAULT_DATABASE_PATH

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        source = os.environ if environ is None else environ
        base_url = source.get(ENV_OLLAMA_BASE_URL, "").strip() or DEFAULT_OLLAMA_BASE_URL
        database_path = source.get(ENV_DATABASE_PATH, "").strip() or DEFAULT_DATABASE_PATH
        return cls(
            ollama_base_url=base_url,
            ollama_timeout_seconds=_positive_float(
                source.get(ENV_OLLAMA_TIMEOUT_SECONDS), DEFAULT_OLLAMA_TIMEOUT_SECONDS
            ),
            database_path=database_path,
        )


def _positive_float(raw_value: str | None, fallback: float) -> float:
    if raw_value is None:
        return fallback
    try:
        value = float(raw_value)
    except ValueError:
        return fallback
    return value if value > 0 else fallback
