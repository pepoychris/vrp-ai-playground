"""FastAPI application for the RoboRoute Nexus backend (MVP Phase 1).

Phase 1 scope: the infrastructure probe ``GET /health`` and the read-only AI
readiness report ``GET /api/ai/status``.

Starting this application performs no network call, no database write and no model
download. There is no startup hook: the scenario, fleet, orders, routes, simulation
and model-install endpoints belong to later phases and do not exist yet.
"""

from __future__ import annotations

from fastapi import FastAPI

from .config import MODEL_NAME, SERVICE_NAME, SERVICE_VERSION, Settings
from .contracts import AiStatus, HealthResponse
from .ollama_client import OllamaProbe

API_TITLE = "RoboRoute Nexus API"
API_SUMMARY = (
    "Last-mile control tower backend. Phase 1 exposes the infrastructure probe and "
    "the AI readiness report only."
)


def create_app(
    settings: Settings | None = None,
    ollama_probe: OllamaProbe | None = None,
) -> FastAPI:
    """Build the application.

    ``settings`` and ``ollama_probe`` are injectable so tests can run without a
    Docker network and without contacting a real Ollama instance.
    """
    resolved_settings = settings or Settings.from_env()
    probe = ollama_probe or OllamaProbe(
        resolved_settings.ollama_base_url,
        resolved_settings.ollama_timeout_seconds,
    )

    app = FastAPI(title=API_TITLE, summary=API_SUMMARY, version=SERVICE_VERSION)
    app.state.settings = resolved_settings
    app.state.ollama_probe = probe

    @app.get("/health", response_model=HealthResponse, tags=["infrastructure"])
    async def health() -> HealthResponse:
        """Liveness probe. It touches no external service."""
        return HealthResponse(status="ok", service=SERVICE_NAME, version=SERVICE_VERSION)

    @app.get("/api/ai/status", response_model=AiStatus, tags=["ai"])
    async def ai_status() -> AiStatus:
        """Read-only AI readiness: service reachable, model installed, model loaded.

        The response is always 200, even when Ollama is unreachable, because the
        endpoint reports state instead of failing. It never installs or loads the
        model: the model name is fixed here, not in the request.
        """
        status = await probe.fetch_status()
        return AiStatus(
            serviceAvailable=status.service_available,
            modelInstalled=status.has_installed(MODEL_NAME),
            modelLoaded=status.has_loaded(MODEL_NAME),
            modelName=MODEL_NAME,
            installJob=None,
        )

    return app


app = create_app()
