"""FastAPI application for the RoboRoute Nexus backend (MVP Phase 8).

Phase 6 added the simulation clock (start, pause, speed) and the claw relocation
command; Phase 7 added the robotic barrier; Phase 8 adds the local Qwen copilot: an
explicit model install with recoverable progress, an explicit activation, grounded chat
and shift reports, and human-confirmed action proposals.

Starting this application performs no network call, no database write and no model
download. There is no startup hook: scenario generation, model installation and model
preloading all happen only after an explicit request from the frontend.
"""

from __future__ import annotations

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from .config import SERVICE_NAME, SERVICE_VERSION, Settings
from .ai import (
    AiChatRequest,
    AiCopilot,
    AiEmptyRequest,
    AiError,
    AiProposalCommandRequest,
    AiReportRequest,
    read_json_body,
    validate_payload,
)
from .contracts import (
    AiChatResponse,
    AiReportResponse,
    AiStatus,
    HealthResponse,
    InstallJob,
)
from .ollama_client import OllamaProbe
from .scenario import (
    BarrierPlaceRequest,
    BarrierRemoveRequest,
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
    "Last-mile control tower backend. Phase 8 exposes deterministic scenarios, bounded "
    "route optimisation, KPIs, simulation clock control, claw relocation, robotic "
    "barriers and road closures, reset, and the local Qwen copilot: install, activation, "
    "grounded chat, shift reports and human-confirmed proposals."
)

# Server-sent events must not be buffered by the proxying frontend.
SSE_HEADERS = {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
}


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
        long_timeout_seconds=max(
            resolved_settings.ai_chat_timeout_seconds,
            resolved_settings.ai_report_timeout_seconds,
            resolved_settings.ai_install_timeout_seconds,
        ),
    )

    app = FastAPI(title=API_TITLE, summary=API_SUMMARY, version=SERVICE_VERSION)
    scenario_store = ScenarioStore()
    app.state.settings = resolved_settings
    app.state.ollama_probe = probe
    app.state.scenario_store = scenario_store
    app.state.ai = AiCopilot.create(probe, scenario_store, resolved_settings)

    @app.exception_handler(AiError)
    async def ai_error_handler(_: Request, exc: AiError) -> JSONResponse:
        """Answer every AI failure with the frozen ``errorResponse`` envelope."""
        return JSONResponse(status_code=exc.status_code, content=exc.envelope())

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
        return await app.state.ai.status()

    @app.post(
        "/api/ai/model/install",
        response_model=InstallJob,
        status_code=status.HTTP_202_ACCEPTED,
        tags=["ai"],
    )
    async def install_model(request: Request, response: Response) -> InstallJob:
        """Start the one model download of the process, idempotently.

        ``202`` means this request started a download. ``200`` means there was nothing to
        start — the model is already installed, or the same download is still running — and
        the current job is returned either way. Nothing here runs at startup.
        """
        validate_payload(await read_json_body(request), AiEmptyRequest)
        record, http_status = await app.state.ai.install.start()
        response.status_code = http_status
        return record.job_payload()

    @app.get("/api/ai/model/install/events", tags=["ai"])
    async def install_events() -> StreamingResponse:
        """Stream normalized install progress, then close on the terminal state.

        Reconnecting replays the current state first, so a client recovers the progress
        after a dropped connection — or after a failed download — without the backend
        having to remember that client.
        """
        copilot: AiCopilot = app.state.ai
        if copilot.install.record is None:
            # With nothing to report, an unreachable service is the honest answer.
            await copilot.service_status()
        return StreamingResponse(
            copilot.install.stream(),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    @app.post("/api/ai/activate", response_model=AiStatus, tags=["ai"])
    async def activate_model(request: Request) -> AiStatus:
        """Preload the fixed model with ``keep_alive`` and report the new status."""
        validate_payload(await read_json_body(request), AiEmptyRequest)
        return await app.state.ai.activate()

    @app.post("/api/ai/chat", response_model=AiChatResponse, tags=["ai"])
    async def ai_chat(request: Request) -> AiChatResponse:
        """Answer one question from the validated snapshot, and never from anywhere else."""
        payload = await read_json_body(request)
        parsed: AiChatRequest = validate_payload(payload, AiChatRequest)
        return await app.state.ai.chat(parsed)

    @app.post(
        "/api/ai/reports/shift", response_model=AiReportResponse, tags=["ai"]
    )
    async def ai_shift_report(request: Request) -> AiReportResponse:
        """Build the shift report: deterministic metrics, model-written narrative."""
        payload = await read_json_body(request)
        parsed: AiReportRequest = validate_payload(payload, AiReportRequest)
        return await app.state.ai.shift_report(parsed)

    @app.post(
        "/api/ai/proposals/{proposal_id}/confirm",
        response_model=ScenarioRevisionResponse,
        tags=["ai"],
    )
    async def confirm_proposal(
        proposal_id: str, request: Request
    ) -> ScenarioRevisionResponse:
        """Apply a proposal the human just confirmed, as one coherent revision."""
        payload = await read_json_body(request)
        parsed: AiProposalCommandRequest = validate_payload(
            payload, AiProposalCommandRequest
        )
        return ScenarioRevisionResponse.model_validate(
            app.state.ai.confirm_proposal(proposal_id, parsed)
        )

    @app.post(
        "/api/ai/proposals/{proposal_id}/reject",
        response_model=ScenarioRevisionResponse,
        tags=["ai"],
    )
    async def reject_proposal(
        proposal_id: str, request: Request
    ) -> ScenarioRevisionResponse:
        """Record the rejection of a proposal. No scenario action is executed."""
        payload = await read_json_body(request)
        parsed: AiProposalCommandRequest = validate_payload(
            payload, AiProposalCommandRequest
        )
        return ScenarioRevisionResponse.model_validate(
            app.state.ai.reject_proposal(proposal_id, parsed)
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
        """Remove the current snapshot, routes, barriers and simulation state.

        Resetting a scenario also retires its copilot proposals: a proposal computed
        against a scenario that no longer exists must never be confirmable.
        """
        result = app.state.scenario_store.reset(scenario_id)
        app.state.ai.proposals.clear_scenario(scenario_id)
        return result

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

    @app.post(
        "/api/scenarios/{scenario_id}/barriers",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def place_barrier(
        scenario_id: str, request: BarrierPlaceRequest
    ) -> ScenarioRevisionResponse:
        """Place one robotic barrier on a road edge and publish the closed revision.

        ``position`` is snapped to the nearest road edge, skipping the roads that are
        already blocked; ``edgeId`` places the barrier on a named edge instead. Either way
        the barrier blocks the edge in both directions and the plan is recomputed once in
        the same revision, which also carries the before/after KPI comparison.
        """
        snapshot, result = app.state.scenario_store.place_barrier(
            scenario_id,
            position=request.position.model_dump() if request.position else None,
            edge_id=request.edgeId,
            command_id=request.commandId,
            client_revision=request.scenarioRevision,
        )
        return ScenarioRevisionResponse.model_validate({**snapshot, "result": result})

    @app.delete(
        "/api/scenarios/{scenario_id}/barriers/{barrier_id}",
        response_model=ScenarioRevisionResponse,
        tags=["scenarios"],
    )
    async def remove_barrier(
        scenario_id: str,
        barrier_id: str,
        request: BarrierRemoveRequest | None = None,
    ) -> ScenarioRevisionResponse:
        """Remove one barrier, restore its road edge and recompute the plan once.

        ``DELETE`` is a resource operation, so the body stays optional; when the client
        sends the frozen envelope the command is idempotent like every other mutation.
        """
        resolved_request = request or BarrierRemoveRequest()
        snapshot, result = app.state.scenario_store.remove_barrier(
            scenario_id,
            barrier_id,
            command_id=resolved_request.commandId,
            client_revision=resolved_request.scenarioRevision,
        )
        return ScenarioRevisionResponse.model_validate({**snapshot, "result": result})

    return app


app = create_app()
