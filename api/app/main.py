"""FastAPI application for the RoboRoute Nexus backend (MVP Phase 6).

Phase 6 adds the simulation clock (start, pause, speed) and the claw relocation
command on top of the Phase 4/5 scenario, fleet, order, route-plan and KPI surface. No
scenario is generated during startup.

Starting this application performs no network call, no database write and no model
download. There is no startup hook: scenario generation only happens after an
explicit request from the frontend.
"""

from __future__ import annotations

from fastapi import FastAPI, status

from .config import MODEL_NAME, SERVICE_NAME, SERVICE_VERSION, Settings
from .contracts import AiStatus, HealthResponse
from .ollama_client import OllamaProbe
from .scenario import (
    FleetGenerateRequest,
    OptimizeRequest,
    OrdersGenerateRequest,
    ScenarioCreateRequest,
    ScenarioResetResponse,
    ScenarioRevisionResponse,
    ScenarioStore,
    SimulationPauseRequest,
    SimulationStartRequest,
    VehiclePositionRequest,
)

API_TITLE = "RoboRoute Nexus API"
API_SUMMARY = (
    "Last-mile control tower backend. Phase 6 exposes deterministic scenarios, bounded "
    "route optimisation, KPIs, simulation clock control, claw relocation, reset and AI "
    "readiness."
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
    app.state.scenario_store = ScenarioStore()

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

    @app.post(
        "/api/scenarios",
        response_model=ScenarioRevisionResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["scenarios"],
    )
    async def create_scenario(request: ScenarioCreateRequest | None = None) -> ScenarioRevisionResponse:
        """Create an empty, reproducible scenario; generation remains user-triggered."""
        resolved_request = request or ScenarioCreateRequest()
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.create(resolved_request.seed)
        )

    @app.get(
        "/api/scenarios/{scenario_id}",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def get_scenario(scenario_id: str) -> ScenarioRevisionResponse:
        return ScenarioRevisionResponse.model_validate(app.state.scenario_store.get(scenario_id))

    @app.delete(
        "/api/scenarios/{scenario_id}",
        response_model=ScenarioResetResponse,
        tags=["scenarios"],
    )
    async def reset_scenario(scenario_id: str) -> ScenarioResetResponse:
        """Remove the current snapshot, routes, barriers and simulation state."""
        return app.state.scenario_store.reset(scenario_id)

    @app.post(
        "/api/scenarios/{scenario_id}/vehicles/generate",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def generate_fleet(
        scenario_id: str, request: FleetGenerateRequest
    ) -> ScenarioRevisionResponse:
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.deploy_fleet(scenario_id, request.count)
        )

    @app.post(
        "/api/scenarios/{scenario_id}/orders/generate",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def generate_orders(
        scenario_id: str, request: OrdersGenerateRequest
    ) -> ScenarioRevisionResponse:
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.generate_orders(scenario_id, request.count)
        )

    @app.post(
        "/api/scenarios/{scenario_id}/optimize",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def optimize_scenario(
        scenario_id: str, request: OptimizeRequest | None = None
    ) -> ScenarioRevisionResponse:
        """Compute bounded best routes and publish one atomic scenario revision.

        The frozen command envelope (``commandId``, ``scenarioRevision``) is honoured
        when the client sends it: a repeated ``commandId`` is replayed and does not
        mutate the scenario twice, and a stale ``scenarioRevision`` is rebased.
        """
        resolved_request = request or OptimizeRequest()
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.optimize(
                scenario_id,
                resolved_request.timeLimitSeconds,
                command_id=resolved_request.commandId,
                client_revision=resolved_request.scenarioRevision,
            )
        )

    @app.post(
        "/api/scenarios/{scenario_id}/simulation/start",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def start_simulation(
        scenario_id: str, request: SimulationStartRequest | None = None
    ) -> ScenarioRevisionResponse:
        """Start or resume the simulation, optionally at a new bounded speed.

        The clock lives in the snapshot; ticks never create a revision. A repeated
        ``commandId`` is replayed, and a stale client revision is rebased, exactly like
        every other command in the frozen envelope.
        """
        resolved_request = request or SimulationStartRequest()
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.start_simulation(
                scenario_id,
                resolved_request.speedMultiplier,
                command_id=resolved_request.commandId,
                client_revision=resolved_request.scenarioRevision,
            )
        )

    @app.post(
        "/api/scenarios/{scenario_id}/simulation/pause",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def pause_simulation(
        scenario_id: str, request: SimulationPauseRequest | None = None
    ) -> ScenarioRevisionResponse:
        """Pause the running simulation, or report ``SIMULATION_NOT_RUNNING``."""
        resolved_request = request or SimulationPauseRequest()
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.pause_simulation(
                scenario_id,
                command_id=resolved_request.commandId,
                client_revision=resolved_request.scenarioRevision,
            )
        )

    @app.patch(
        "/api/scenarios/{scenario_id}/vehicles/{vehicle_id}/position",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def relocate_vehicle(
        scenario_id: str,
        vehicle_id: str,
        request: VehiclePositionRequest,
    ) -> ScenarioRevisionResponse:
        """Drop one vehicle on the nearest road node and re-plan exactly once.

        A drop outside the claw radius answers ``422 SNAP_OUT_OF_RADIUS`` and publishes
        no revision, so an invalid gesture cannot overwrite a newer scenario revision.
        """
        return ScenarioRevisionResponse.model_validate(
            app.state.scenario_store.relocate_vehicle(
                scenario_id,
                vehicle_id,
                request.position.model_dump(),
                command_id=request.commandId,
                client_revision=request.scenarioRevision,
            )
        )

    return app


app = create_app()
