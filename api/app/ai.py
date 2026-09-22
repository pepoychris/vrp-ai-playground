"""Phase 8 local copilot: install job, grounded chat, shift reports and proposals.

Three rules shape this module.

First, the model is fixed by the backend. ``qwen3:4b``, ``think=False``, ``num_ctx=8192``
and the frozen temperatures are arguments of the backend's own calls, so nothing a browser
sends can change them.

Second, the model never sees a raw scenario and never invents a number. Every prompt is
built from a compact projection of the *validated* snapshot, and every field the answer
cites has to exist in that projection: a reference to a path the model was not given is
dropped before the response leaves the API.

Third, the model cannot act. It can suggest one of three catalogued proposals, and the
proposal stays inert until a human confirms it against the current scenario revision.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
from typing import Any, Final, Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import (
    ACTIVATE_KEEP_ALIVE,
    AI_MAX_MESSAGES,
    AI_MAX_MESSAGE_CHARS,
    AI_REPORT_SCHEMA_VERSION,
    CHAT_KEEP_ALIVE,
    CHAT_TEMPERATURE,
    MODEL_NAME,
    NUM_CTX,
    REPORT_TEMPERATURE,
    SERVICE_NAME,
    THINK,
    Settings,
)
from .contracts import (
    AiChatResponse,
    AiInstallEvent,
    AiInstallEventPayload,
    AiProposal,
    AiReportResponse,
    AiStatus,
    AiStatusEvent,
    InstallJob,
    InstallJobState,
    ProposalKind,
)
from .ollama_client import (
    PULL_STATE_COMPLETED,
    PULL_STATE_DOWNLOADING,
    PULL_STATE_FAILED,
    PULL_STATE_IDLE,
    PULL_STATE_VERIFYING,
    OllamaProbe,
    PullProgress,
)
from .scenario import (
    AI_PROPOSAL_KINDS,
    PROPOSAL_VEHICLE_STATUS,
    RequiredCommandId,
    UNAVAILABLE_VEHICLE_STATUSES,
    ScenarioStore,
)

# Inference overrides the frozen contract forbids on every AI request.
FORBIDDEN_INFERENCE_KEYS: Final = ("model", "think", "options", "keep_alive")

TERMINAL_INSTALL_STATES: Final = (PULL_STATE_COMPLETED, PULL_STATE_FAILED)

# Proposal ids follow the frozen example shape: ``prop-2026-09-22-0001``.
PROPOSAL_ID_PREFIX: Final = "prop"


# --------------------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------------------


class AiError(Exception):
    """A failure the AI surface answers with the frozen ``errorResponse`` envelope."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
        scenario_revision: int | None = None,
        command_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or None
        self.scenario_revision = scenario_revision
        self.command_id = command_id

    def envelope(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details is not None:
            body["details"] = self.details
        if self.scenario_revision is not None:
            body["scenarioRevision"] = self.scenario_revision
        if self.command_id is not None:
            body["commandId"] = self.command_id
        return {"error": body}


def service_unavailable(detail: str | None = None) -> AiError:
    return AiError(
        503,
        "AI_SERVICE_UNAVAILABLE",
        detail
        or "The local AI service (Ollama) is not reachable from the backend network.",
        retryable=True,
    )


def load_snapshot(store: ScenarioStore, scenario_id: str) -> dict[str, Any]:
    """Read one scenario, translating the store's 404 into the AI error envelope."""
    try:
        return store.get(scenario_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise AiError(404, "SCENARIO_NOT_FOUND", "The scenario does not exist.") from exc
        raise


async def read_json_body(request: Any) -> Any:
    """Read a JSON body, treating an empty body as ``{}``."""
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise AiError(400, "VALIDATION_ERROR", "The request body must be valid JSON.") from exc


def validate_payload(payload: Any, model: type[BaseModel]) -> Any:
    """Validate one AI request body, in the frozen error order.

    Inference overrides are checked first and answered with ``MODEL_OVERRIDE_FORBIDDEN``,
    which is the code the contract names for an attempt at choosing the model. Anything
    else that does not fit the schema is a ``VALIDATION_ERROR``.
    """
    if not isinstance(payload, Mapping):
        raise AiError(400, "VALIDATION_ERROR", "A JSON object body is required.")
    overrides = sorted(key for key in FORBIDDEN_INFERENCE_KEYS if key in payload)
    if overrides:
        raise AiError(
            400,
            "MODEL_OVERRIDE_FORBIDDEN",
            "The backend fixes the model and its inference options; the browser cannot set them.",
            details={"fields": overrides, "model": MODEL_NAME},
        )
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise AiError(
            400,
            "VALIDATION_ERROR",
            _validation_summary(exc),
            details={"fields": sorted({str(item["loc"][0]) for item in exc.errors() if item["loc"]})},
        ) from exc


def _validation_summary(exc: ValidationError) -> str:
    first = exc.errors()[0] if exc.errors() else None
    if first is None:
        return "The request body is not valid."
    location = ".".join(str(part) for part in first["loc"]) or "body"
    return f"{location}: {first['msg']}"


# --------------------------------------------------------------------------------------
# Request bodies
# --------------------------------------------------------------------------------------


class AiEmptyRequest(BaseModel):
    """``POST /api/ai/model/install`` and ``POST /api/ai/activate`` take no fields."""

    model_config = ConfigDict(extra="forbid")


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=AI_MAX_MESSAGE_CHARS)


class AiChatRequest(BaseModel):
    """Chat body. ``scenarioId`` is required so the answer can be grounded and 404-able."""

    model_config = ConfigDict(extra="forbid")

    scenarioId: str = Field(min_length=1)
    messages: list[ChatMessage] = Field(min_length=1, max_length=AI_MAX_MESSAGES)

    # The frozen command envelope. Chat does not mutate, but it is still a command.
    commandId: RequiredCommandId
    scenarioRevision: int = Field(ge=0)


class AiReportRequest(BaseModel):
    """Shift-report body: the command envelope plus the scenario to report on."""

    model_config = ConfigDict(extra="forbid")

    scenarioId: str = Field(min_length=1)
    commandId: RequiredCommandId
    scenarioRevision: int = Field(ge=0)


class AiProposalCommandRequest(BaseModel):
    """Confirm/reject body: the human command envelope, and nothing else."""

    model_config = ConfigDict(extra="forbid")

    commandId: RequiredCommandId
    scenarioRevision: int = Field(ge=0)


# --------------------------------------------------------------------------------------
# Install job
# --------------------------------------------------------------------------------------


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(slots=True)
class InstallJobRecord:
    """In-memory install job.

    Job state is not persisted: the downloaded weights are (the Ollama volume owns them),
    and a job that is gone is rebuildable from ``/api/tags``. What the contract does demand
    is that a client can recover the *progress* after a failure, which the stream provides
    by replaying the current state on every (re)connection.
    """

    jobId: str
    state: InstallJobState
    modelName: str
    startedAt: str
    finishedAt: str | None = None
    percent: float | None = None
    statusText: str = ""
    error: str | None = None

    def job_payload(self) -> InstallJob:
        """The frozen ``installJob`` object, without the progress the stream carries."""
        return InstallJob(
            jobId=self.jobId,
            state=self.state,
            modelName=MODEL_NAME,
            startedAt=self.startedAt,
            finishedAt=self.finishedAt,
        )

    def event_payload(self) -> AiInstallEventPayload:
        return AiInstallEventPayload(
            state=self.state,
            modelName=MODEL_NAME,
            percent=self.percent,
            statusText=self.statusText,
            error=self.error,
        )


def idle_install_payload() -> AiInstallEventPayload:
    """The ``ai.install`` payload before any download was ever requested."""
    return AiInstallEventPayload(
        state=PULL_STATE_IDLE,
        modelName=MODEL_NAME,
        percent=None,
        statusText="not started",
        error=None,
    )


class AiInstallManager:
    """Owns the single model download of the process.

    Idempotency lives here: an installed model answers ``COMPLETED``, a download already in
    flight answers the running job, and only a genuinely new request starts a ``pull``. The
    manager never starts two pulls, and it never starts one by itself.
    """

    def __init__(self, probe: OllamaProbe, settings: Settings) -> None:
        self._probe = probe
        self._settings = settings
        self._record: InstallJobRecord | None = None
        self._task: asyncio.Task[None] | None = None
        self._changed = asyncio.Event()
        self._version = 0
        self._sequence = 0
        # Every published progress payload of the current job, in order. A stream drains
        # this log, so a frame is never lost when the download advances faster than the
        # client polls. It is reset with each new job, which bounds its size to one pull.
        self._events: list[tuple[int, AiInstallEventPayload]] = []

    # -- state -------------------------------------------------------------------------

    @property
    def record(self) -> InstallJobRecord | None:
        return self._record

    def _publish(self, record: InstallJobRecord, **changes: Any) -> None:
        for key, value in changes.items():
            setattr(record, key, value)
        self._version += 1
        self._events.append((self._version, record.event_payload()))
        self._changed.set()

    def _next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    async def wait_idle(self) -> None:
        """Await the running download, if any. Used by tests and by the stream."""
        task = self._task
        if task is not None and not task.done():
            await asyncio.shield(task)

    # -- commands ----------------------------------------------------------------------

    async def start(self) -> tuple[InstallJobRecord, int]:
        """Answer (job, http status) for one install request.

        ``200`` means the request was already satisfied — the model is installed, or a
        download is already running — and ``202`` means this request started the download.
        """
        status = await self._probe.fetch_status()
        if not status.service_available:
            raise service_unavailable()
        if status.has_installed(MODEL_NAME):
            return self._completed_record(now=utc_now()), 200
        if self._task is not None and not self._task.done() and self._record is not None:
            return self._record, 200

        record = InstallJobRecord(
            jobId=str(uuid4()),
            state=PULL_STATE_DOWNLOADING,
            modelName=MODEL_NAME,
            startedAt=utc_now(),
            percent=0.0,
            statusText="starting download",
        )
        self._record = record
        self._events = []
        self._version += 1
        self._events.append((self._version, record.event_payload()))
        self._changed.set()
        self._task = asyncio.create_task(self._run_pull(record))
        return record, 202

    def _completed_record(self, *, now: str) -> InstallJobRecord:
        existing = self._record
        if existing is not None and existing.state == PULL_STATE_COMPLETED:
            return existing
        record = InstallJobRecord(
            jobId=str(uuid4()),
            state=PULL_STATE_COMPLETED,
            modelName=MODEL_NAME,
            startedAt=now,
            finishedAt=now,
            percent=100.0,
            statusText="already installed",
        )
        self._record = record
        self._events = []
        self._version += 1
        self._events.append((self._version, record.event_payload()))
        return record

    async def _run_pull(self, record: InstallJobRecord) -> None:
        try:
            async for progress in self._probe.pull(MODEL_NAME):
                if progress.state == PULL_STATE_FAILED:
                    self._publish(
                        record,
                        state=PULL_STATE_FAILED,
                        percent=None,
                        statusText=progress.status_text,
                        error=progress.error or "the download failed",
                        finishedAt=utc_now(),
                    )
                    return
                self._publish(
                    record,
                    state=_coerce_install_state(progress.state),
                    percent=progress.percent,
                    statusText=progress.status_text,
                    error=None,
                )
            await self._verify(record)
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            raise
        except Exception as exc:  # noqa: BLE001 - any transport failure is a failed job
            self._publish(
                record,
                state=PULL_STATE_FAILED,
                percent=None,
                statusText="download failed",
                error=str(exc) or exc.__class__.__name__,
                finishedAt=utc_now(),
            )

    async def _verify(self, record: InstallJobRecord) -> None:
        """Confirm the weights really landed before reporting success."""
        self._publish(record, state=PULL_STATE_VERIFYING, statusText="verifying install")
        try:
            status = await self._probe.fetch_status()
        except Exception as exc:  # noqa: BLE001 - an unreachable service is a failed job
            self._publish(
                record,
                state=PULL_STATE_FAILED,
                percent=None,
                statusText="verification failed",
                error=str(exc) or exc.__class__.__name__,
                finishedAt=utc_now(),
            )
            return
        if status.has_installed(MODEL_NAME):
            self._publish(
                record,
                state=PULL_STATE_COMPLETED,
                percent=100.0,
                statusText="installed",
                error=None,
                finishedAt=utc_now(),
            )
        else:
            self._publish(
                record,
                state=PULL_STATE_FAILED,
                percent=None,
                statusText="model missing after download",
                error=f"{MODEL_NAME} is still absent from /api/tags",
                finishedAt=utc_now(),
            )

    # -- streaming ---------------------------------------------------------------------

    async def stream(self) -> AsyncIterator[str]:
        """Yield normalized SSE frames, then close on the terminal state.

        Reconnecting always replays the current state first, so a client that lost the
        stream mid-download — or after a failure — recovers the progress without asking the
        backend to remember anything about that connection.
        """
        current = (
            self._record.event_payload()
            if self._record is not None
            else idle_install_payload()
        )
        delivered = self._version
        sequence = self._next_sequence()
        yield self._install_frame(sequence, current)
        yield await self._status_frame(sequence)
        if current.state in TERMINAL_INSTALL_STATES:
            return

        while True:
            pending = [item for item in self._events if item[0] > delivered]
            if pending:
                for version, payload in pending:
                    delivered = version
                    sequence = self._next_sequence()
                    yield self._install_frame(sequence, payload)
                    yield await self._status_frame(sequence)
                    # Terminality is decided by the frame that was just sent, never by the
                    # live record: the download can advance while the frame is in flight.
                    if payload.state in TERMINAL_INSTALL_STATES:
                        return
                continue
            if not await self._wait_for_change():
                yield HEARTBEAT_FRAME

    async def _wait_for_change(self) -> bool:
        self._changed.clear()
        try:
            await asyncio.wait_for(
                self._changed.wait(), timeout=self._settings.ai_stream_heartbeat_seconds
            )
        except TimeoutError:
            return False
        return True

    def _install_frame(
        self, sequence: int, payload: AiInstallEventPayload
    ) -> str:
        return _sse_frame("ai.install", self._install_event(sequence, payload))

    async def _status_frame(self, sequence: int) -> str:
        return _sse_frame("ai.status", await self._status_event(sequence))

    def _install_event(
        self, sequence: int, payload: AiInstallEventPayload
    ) -> AiInstallEvent:
        return AiInstallEvent(
            eventId=f"0:{sequence}",
            eventSeq=sequence,
            type="ai.install",
            scenarioRevision=None,
            emittedAt=utc_now(),
            commandId=None,
            payload=payload,
        )

    async def _status_event(self, sequence: int) -> AiStatusEvent:
        status = await self._probe.fetch_status()
        return AiStatusEvent(
            eventId=f"0:{sequence}",
            eventSeq=sequence,
            type="ai.status",
            scenarioRevision=None,
            emittedAt=utc_now(),
            commandId=None,
            payload=build_ai_status(status, self._record),
        )


def _coerce_install_state(state: str) -> InstallJobState:
    allowed = (
        PULL_STATE_IDLE,
        PULL_STATE_DOWNLOADING,
        PULL_STATE_VERIFYING,
        PULL_STATE_COMPLETED,
        PULL_STATE_FAILED,
    )
    return state if state in allowed else PULL_STATE_DOWNLOADING  # type: ignore[return-value]


HEARTBEAT_FRAME: Final = ": ping\n\n"


def _sse_frame(event: str, payload: BaseModel, *, event_id: str | None = None) -> str:
    body = payload.model_dump(mode="json")
    identifier = event_id or str(body.get("eventId", ""))
    return f"event: {event}\nid: {identifier}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n"


# --------------------------------------------------------------------------------------
# Status projection
# --------------------------------------------------------------------------------------


def build_ai_status(status: Any, record: InstallJobRecord | None) -> AiStatus:
    """Project a raw probe plus the install job onto the frozen ``aiStatus``."""
    return AiStatus(
        serviceAvailable=status.service_available,
        modelInstalled=status.has_installed(MODEL_NAME),
        modelLoaded=status.has_loaded(MODEL_NAME),
        modelName=MODEL_NAME,
        installJob=record.job_payload() if record is not None else None,
    )


# --------------------------------------------------------------------------------------
# Grounded snapshot context
# --------------------------------------------------------------------------------------


def build_snapshot_context(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Compact, deterministic projection of one validated scenario.

    The road graph is deliberately left out: it is large, immutable and irrelevant to the
    questions the copilot answers, and dropping it also removes any chance of the model
    citing a node or an edge that the answer does not need.
    """
    plan = snapshot.get("routePlan")
    kpis = snapshot.get("kpis")
    context: dict[str, Any] = {
        "scenarioRevision": snapshot["scenarioRevision"],
        "status": snapshot["status"],
        "seed": snapshot["seed"],
        "vehicleCount": len(snapshot["vehicles"]),
        "orderCount": len(snapshot["orders"]),
        "vehicles": [
            {
                "vehicleId": vehicle["vehicleId"],
                "status": vehicle["status"],
                "currentNodeId": vehicle.get("currentNodeId"),
                "batteryPercent": vehicle["batteryPercent"],
                "loadKilograms": vehicle["loadKilograms"],
                "capacityKilograms": vehicle["capacityKilograms"],
                "assignedOrderIds": list(vehicle.get("assignedOrderIds") or []),
            }
            for vehicle in snapshot["vehicles"]
        ],
        "orders": [
            {
                "orderId": order["orderId"],
                "status": order["status"],
                "priority": order["priority"],
                "deliveryNodeId": order["deliveryNodeId"],
                "assignedVehicleId": order.get("assignedVehicleId"),
                "weightKilograms": order["weightKilograms"],
            }
            for order in snapshot["orders"]
        ],
        "barriers": [
            {
                "barrierId": barrier["barrierId"],
                "blockedEdgeId": barrier["blockedEdgeId"],
                "placedAtRevision": barrier["placedAtRevision"],
            }
            for barrier in snapshot["barriers"]
        ],
        "blockedEdgeIds": list(snapshot.get("blockedEdgeIds") or []),
        "simulation": dict(snapshot["simulation"]),
        "routePlan": None,
        "kpis": None,
    }
    if plan is not None:
        context["routePlan"] = {
            "timeLimitSeconds": plan["timeLimitSeconds"],
            "solverOutcome": plan["solverOutcome"],
            "objectiveIsProvenOptimal": plan["objectiveIsProvenOptimal"],
            "vehicles": [
                {
                    "vehicleId": route["vehicleId"],
                    "distanceMeters": route["distanceMeters"],
                    "driveSeconds": route["driveSeconds"],
                    "loadUtilizationPercent": route["loadUtilizationPercent"],
                    "stops": [
                        {
                            "orderId": stop["orderId"],
                            "nodeId": stop["nodeId"],
                            "delaySeconds": stop["delaySeconds"],
                        }
                        for stop in route["stops"]
                    ],
                }
                for route in plan["vehicles"]
            ],
            "unassignedOrders": [
                {"orderId": item["orderId"], "reason": item["reason"]}
                for item in plan["unassignedOrders"]
            ],
        }
    if kpis is not None:
        context["kpis"] = {
            "scenarioRevision": kpis["scenarioRevision"],
            "distanceTotalMeters": kpis["distanceTotalMeters"],
            "plannedDurationSeconds": kpis["plannedDurationSeconds"],
            "economicCostCents": kpis["economicCostCents"],
            "ordersDelivered": kpis["ordersDelivered"],
            "ordersPending": kpis["ordersPending"],
            "ordersDelayed": kpis["ordersDelayed"],
            "ordersUnassigned": kpis["ordersUnassigned"],
            "activeVehicles": kpis["activeVehicles"],
            "capacityUtilizationPercentByVehicle": dict(
                kpis["capacityUtilizationPercentByVehicle"]
            ),
            "lastIntervention": kpis.get("lastIntervention"),
        }
    return context


def reference_paths(context: Mapping[str, Any]) -> set[str]:
    """Every field path the model is allowed to cite, derived from the context itself."""
    paths: set[str] = set()
    _walk_paths(context, "", paths)
    return paths


def _walk_paths(value: Any, prefix: str, paths: set[str]) -> None:
    if isinstance(value, Mapping):
        if prefix:
            paths.add(prefix)
        for key, item in value.items():
            _walk_paths(item, f"{prefix}.{key}" if prefix else str(key), paths)
    elif isinstance(value, (list, tuple)):
        if prefix:
            paths.add(prefix)
        for index, item in enumerate(value):
            _walk_paths(item, f"{prefix}[{index}]", paths)
    elif prefix:
        paths.add(prefix)


def grounded_references(candidates: list[str], context: Mapping[str, Any]) -> list[str]:
    """Keep the cited paths that really exist in the context that was sent."""
    allowed = reference_paths(context)
    grounded: list[str] = []
    for candidate in candidates:
        path = candidate.strip()
        if not path or path in grounded:
            continue
        if path in allowed:
            grounded.append(path)
    return grounded


# --------------------------------------------------------------------------------------
# Prompting
# --------------------------------------------------------------------------------------


SYSTEM_PROMPT: Final = (
    "Eres el copiloto de RoboRoute Nexus, una torre de control de reparto de ultima milla "
    "en una ciudad robotica ficticia.\n"
    "Respondes SIEMPRE en espanol y SOLO con los datos del JSON de escenario que se te "
    "entrega.\n"
    "Reglas obligatorias:\n"
    "- No inventes cifras, identificadores ni causas. Si un dato no aparece en el JSON, "
    "di que no consta.\n"
    "- Cita en \"references\" las rutas de campo exactas del JSON que sustentan tu "
    "respuesta (por ejemplo kpis.economicCostCents).\n"
    "- No expliques tu razonamiento interno ni muestres tus pasos intermedios.\n"
    "- Solo puedes proponer acciones de estos tipos: SET_VEHICLE_UNAVAILABLE "
    "(payload: {vehicleId}), DELAY_VEHICLE (payload: {vehicleId, delaySeconds}) o "
    "REQUEST_REOPTIMIZATION (payload: {reason}).\n"
    "- Una propuesta es solo una sugerencia: nunca afirmes que ya se ha aplicado, porque "
    "requiere confirmacion humana.\n"
    "- Si no hay ninguna accion util que proponer, omite el campo \"proposal\"."
)

CHAT_FORMAT_SCHEMA: Final = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "references": {"type": "array", "items": {"type": "string"}},
        "proposal": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(AI_PROPOSAL_KINDS)},
                "summary": {"type": "string"},
                "payload": {"type": "object"},
            },
            "required": ["kind", "summary", "payload"],
        },
    },
    "required": ["answer", "references"],
}

REPORT_FORMAT_SCHEMA: Final = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "highlights": {"type": "array", "items": {"type": "string"}},
        "risks": {"type": "array", "items": {"type": "string"}},
        "recommendations": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "highlights", "risks", "recommendations"],
}


def scenario_context_message(context: Mapping[str, Any]) -> str:
    return (
        "Escenario validado por el backend. Es la unica fuente de datos permitida:\n"
        + json.dumps(context, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


# --------------------------------------------------------------------------------------
# Model output validation
# --------------------------------------------------------------------------------------


class ChatProposalOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ProposalKind
    summary: str = Field(min_length=1)
    payload: dict[str, Any]


class ChatOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str = Field(min_length=1)
    references: list[str] = Field(default_factory=list)
    proposal: ChatProposalOutput | None = None


class ReportNarrative(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1)
    highlights: list[str]
    risks: list[str]
    recommendations: list[str]


def parse_model_json(content: str) -> Any:
    """Parse the assistant text as JSON, or fail with the contract's 502."""
    try:
        return json.loads(content)
    except ValueError as exc:
        raise AiError(
            502,
            "AI_OUTPUT_INVALID",
            "The model did not return valid JSON.",
            retryable=True,
        ) from exc


def validate_chat_output(content: str, context: Mapping[str, Any]) -> ChatOutput:
    """Validate the raw assistant text against the chat contract."""
    payload = parse_model_json(content)
    try:
        output = ChatOutput.model_validate(payload)
    except ValidationError as exc:
        raise AiError(
            502,
            "AI_OUTPUT_INVALID",
            _validation_summary(exc),
            retryable=True,
        ) from exc
    return ChatOutput(
        answer=output.answer,
        references=grounded_references(output.references, context),
        proposal=output.proposal,
    )


def validate_report_narrative(content: str) -> ReportNarrative:
    payload = parse_model_json(content)
    try:
        return ReportNarrative.model_validate(payload)
    except ValidationError as exc:
        raise AiError(
            502,
            "AI_OUTPUT_INVALID",
            _validation_summary(exc),
            retryable=True,
        ) from exc


# --------------------------------------------------------------------------------------
# Deterministic shift report
# --------------------------------------------------------------------------------------


def build_report_skeleton(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """The deterministic part of a shift report: every number comes from the snapshot.

    The language model only writes the narrative. Distances, costs, counts and the A/B
    comparison against the previous plan are computed here, so an ungrounded metric cannot
    reach the report even if the model tries to introduce one.
    """
    kpis = snapshot.get("kpis")
    return {
        "schemaVersion": AI_REPORT_SCHEMA_VERSION,
        "scenarioRevision": snapshot["scenarioRevision"],
        "generatedAt": utc_now(),
        "status": snapshot["status"],
        "seed": snapshot["seed"],
        "planAvailable": kpis is not None,
        "metrics": {
            "vehicleCount": len(snapshot["vehicles"]),
            "orderCount": len(snapshot["orders"]),
            "activeClosures": len(snapshot.get("barriers") or []),
            "activeVehicles": kpis["activeVehicles"] if kpis else None,
            "distanceTotalMeters": kpis["distanceTotalMeters"] if kpis else None,
            "plannedDurationSeconds": kpis["plannedDurationSeconds"] if kpis else None,
            "economicCostCents": kpis["economicCostCents"] if kpis else None,
            "ordersDelivered": kpis["ordersDelivered"] if kpis else None,
            "ordersPending": kpis["ordersPending"] if kpis else None,
            "ordersDelayed": kpis["ordersDelayed"] if kpis else None,
            "ordersUnassigned": kpis["ordersUnassigned"] if kpis else None,
        },
        "comparison": kpis.get("lastIntervention") if kpis else None,
        "unassignedOrders": [
            {"orderId": item["orderId"], "reason": item["reason"]}
            for item in (snapshot.get("routePlan") or {}).get("unassignedOrders", [])
        ],
        "closures": [
            {"barrierId": barrier["barrierId"], "blockedEdgeId": barrier["blockedEdgeId"]}
            for barrier in snapshot.get("barriers") or []
        ],
    }


def apply_report_narrative(
    skeleton: dict[str, Any], narrative: ReportNarrative
) -> dict[str, Any]:
    report = dict(skeleton)
    report["narrative"] = {
        "summary": narrative.summary,
        "highlights": list(narrative.highlights),
        "risks": list(narrative.risks),
        "recommendations": list(narrative.recommendations),
    }
    return report


def report_markdown(report: Mapping[str, Any]) -> str:
    """Render the structured report as the Markdown the user downloads."""
    metrics = report.get("metrics") or {}
    narrative = report.get("narrative") or {}
    revision = report["scenarioRevision"]
    lines: list[str] = [
        f"# Informe de turno - revision {revision}",
        "",
        f"Generado: {report['generatedAt']} · Estado: {report['status']} · Semilla: {report['seed']}",
        "",
    ]

    lines.append("## Resumen")
    lines.append("")
    lines.append(str(narrative.get("summary", "Sin resumen.")))
    lines.append("")

    lines.append("## Metricas del plan")
    lines.append("")
    if report.get("planAvailable"):
        lines.extend(
            [
                "| Metrica | Valor |",
                "| --- | --- |",
                f"| Distancia planificada | {metrics['distanceTotalMeters']} m |",
                f"| Duracion planificada | {metrics['plannedDurationSeconds']} s |",
                f"| Coste economico | {metrics['economicCostCents']} centimos |",
                f"| Vehiculos activos | {metrics['activeVehicles']} |",
                f"| Pedidos pendientes | {metrics['ordersPending']} |",
                f"| Pedidos retrasados | {metrics['ordersDelayed']} |",
                f"| Pedidos sin asignar | {metrics['ordersUnassigned']} |",
            ]
        )
    else:
        lines.append("No hay plan calculado en esta revision.")
    lines.extend(
        [
            "",
            f"Flota desplegada: {metrics['vehicleCount']} · Pedidos: {metrics['orderCount']} · "
            f"Cierres activos: {metrics['activeClosures']}",
            "",
        ]
    )

    comparison = report.get("comparison")
    lines.append("## Comparacion A/B de la ultima intervencion")
    lines.append("")
    if comparison:
        delta = comparison["delta"]
        lines.extend(
            [
                f"Intervencion: {comparison['kind']} frente a la revision {comparison['comparedToRevision']}",
                "",
                "| Metrica | Delta |",
                "| --- | --- |",
                f"| Distancia | {delta['distanceTotalMeters']} m |",
                f"| Duracion | {delta['plannedDurationSeconds']} s |",
                f"| Coste economico | {delta['economicCostCents']} centimos |",
                f"| Pedidos retrasados | {delta['ordersDelayed']} |",
                f"| Pedidos sin asignar | {delta['ordersUnassigned']} |",
            ]
        )
    else:
        lines.append("No hay una intervencion previa con la que comparar.")
    lines.append("")

    for key, title in (
        ("highlights", "Puntos clave"),
        ("risks", "Riesgos"),
        ("recommendations", "Recomendaciones"),
    ):
        entries = list(narrative.get(key) or [])
        lines.append(f"## {title}")
        lines.append("")
        if entries:
            lines.extend(f"- {entry}" for entry in entries)
        else:
            lines.append("Sin entradas.")
        lines.append("")

    unassigned = list(report.get("unassignedOrders") or [])
    closures = list(report.get("closures") or [])
    if unassigned or closures:
        lines.append("## Incidencias")
        lines.append("")
        lines.extend(
            f"- {item['orderId']} sin asignar: {item['reason']}" for item in unassigned
        )
        lines.extend(
            f"- Cierre {item['barrierId']} sobre {item['blockedEdgeId']}" for item in closures
        )
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"Informe generado por {SERVICE_NAME} con el modelo local {MODEL_NAME}.")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# Proposal store
# --------------------------------------------------------------------------------------


@dataclass(slots=True)
class StoredProposal:
    proposalId: str
    scenarioId: str
    kind: str
    summary: str
    payload: dict[str, Any]
    revisionToApply: int
    status: str = "PENDING"

    def as_contract(self) -> AiProposal:
        return AiProposal(
            proposalId=self.proposalId,
            kind=self.kind,  # type: ignore[arg-type]
            summary=self.summary,
            payload=dict(self.payload),
            status=self.status,  # type: ignore[arg-type]
            revisionToApply=self.revisionToApply,
        )


class ProposalStore:
    """Proposals the copilot produced, keyed by id and scoped to their scenario."""

    def __init__(self) -> None:
        self._proposals: dict[str, StoredProposal] = {}
        self._sequence = 0

    def register(
        self,
        *,
        scenario_id: str,
        kind: str,
        summary: str,
        payload: dict[str, Any],
        revision: int,
    ) -> StoredProposal:
        self._sequence += 1
        proposal = StoredProposal(
            proposalId=f"{PROPOSAL_ID_PREFIX}-{date.today().isoformat()}-{self._sequence:04d}",
            scenarioId=scenario_id,
            kind=kind,
            summary=summary,
            payload=dict(payload),
            revisionToApply=revision,
        )
        self._proposals[proposal.proposalId] = proposal
        return proposal

    def resolve(self, proposal_id: str, scenario_id: str) -> StoredProposal:
        """Return a pending proposal of the current revision, or the frozen 404.

        An unknown id, a proposal that was already resolved and a proposal whose revision
        is no longer the current one all answer ``PROPOSAL_NOT_FOUND``: the catalogue
        describes that code as "propuesta caducada o ya resuelta".
        """
        proposal = self._proposals.get(proposal_id)
        if proposal is None or proposal.scenarioId != scenario_id:
            raise AiError(404, "PROPOSAL_NOT_FOUND", "The proposal does not exist.")
        if proposal.status != "PENDING":
            raise AiError(
                404, "PROPOSAL_NOT_FOUND", "The proposal was already resolved."
            )
        return proposal

    def peek(self, proposal_id: str) -> StoredProposal | None:
        """Look up a proposal without judging its state."""
        return self._proposals.get(proposal_id)

    def clear_scenario(self, scenario_id: str) -> None:
        for key in [
            key
            for key, proposal in self._proposals.items()
            if proposal.scenarioId == scenario_id
        ]:
            self._proposals.pop(key, None)


# --------------------------------------------------------------------------------------
# Proposal grounding
# --------------------------------------------------------------------------------------


def ground_proposal(
    *,
    copilot: "AiCopilot",
    snapshot: Mapping[str, Any],
    output: ChatProposalOutput,
) -> StoredProposal | None:
    """Turn a model suggestion into a stored, inert proposal — or drop it.

    A syntactically valid proposal that points at a robot the scenario does not have, or
    that would take the last available robot out of service, is discarded. The answer
    survives; only the ungrounded suggestion disappears.
    """
    kind = output.kind
    if kind not in AI_PROPOSAL_KINDS:  # pragma: no cover - the schema already enumerates
        return None
    payload = dict(output.payload)
    if kind in PROPOSAL_VEHICLE_STATUS:
        vehicle_id = payload.get("vehicleId")
        vehicle = next(
            (
                item
                for item in snapshot["vehicles"]
                if item["vehicleId"] == vehicle_id
            ),
            None,
        )
        if vehicle is None:
            return None
        if vehicle.get("status") not in UNAVAILABLE_VEHICLE_STATUSES:
            remaining = [
                item["vehicleId"]
                for item in snapshot["vehicles"]
                if item["vehicleId"] != vehicle_id
                and item.get("status") not in UNAVAILABLE_VEHICLE_STATUSES
            ]
            if not remaining:
                return None
    return copilot.proposals.register(
        scenario_id=snapshot["scenarioId"],
        kind=kind,
        summary=output.summary,
        payload=payload,
        revision=snapshot["scenarioRevision"],
    )


# --------------------------------------------------------------------------------------
# Copilot
# --------------------------------------------------------------------------------------


@dataclass(slots=True)
class AiCopilot:
    """The Phase 8 AI surface: one probe, one scenario store, one install job."""

    probe: OllamaProbe
    store: ScenarioStore
    settings: Settings
    install: AiInstallManager
    proposals: ProposalStore

    @classmethod
    def create(
        cls, probe: OllamaProbe, store: ScenarioStore, settings: Settings
    ) -> "AiCopilot":
        return cls(
            probe=probe,
            store=store,
            settings=settings,
            install=AiInstallManager(probe, settings),
            proposals=ProposalStore(),
        )

    # -- readiness ---------------------------------------------------------------------

    async def status(self) -> AiStatus:
        return build_ai_status(await self.probe.fetch_status(), self.install.record)

    async def service_status(self) -> Any:
        """Probe Ollama once, raising the frozen 503 when it is unreachable."""
        status = await self.probe.fetch_status()
        if not status.service_available:
            raise service_unavailable()
        return status

    async def require_loaded_model(self) -> Any:
        """The chat/report precondition: the fixed model must be resident."""
        status = await self.service_status()
        if not status.has_loaded(MODEL_NAME):
            if not status.has_installed(MODEL_NAME):
                raise AiError(
                    409,
                    "AI_MODEL_NOT_INSTALLED",
                    f"{MODEL_NAME} is not installed yet. Install the AI core first.",
                )
            raise AiError(
                409,
                "AI_MODEL_NOT_LOADED",
                "The AI core is not loaded. Activate it before asking.",
            )
        return status

    # -- activation --------------------------------------------------------------------

    async def activate(self) -> AiStatus:
        """Preload the fixed model with the frozen options and report the new status."""
        status = await self.service_status()
        if not status.has_installed(MODEL_NAME):
            raise AiError(
                409,
                "AI_MODEL_NOT_INSTALLED",
                f"{MODEL_NAME} is not installed yet. Install the AI core first.",
            )
        try:
            await self.probe.preload(
                MODEL_NAME, keep_alive=ACTIVATE_KEEP_ALIVE, think=THINK
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure is a 503
            raise service_unavailable(
                f"The local AI service could not preload {MODEL_NAME}."
            ) from exc
        return await self.status()

    # -- chat --------------------------------------------------------------------------

    async def chat(self, request: AiChatRequest) -> AiChatResponse:
        await self.require_loaded_model()
        snapshot = load_snapshot(self.store, request.scenarioId)
        context = build_snapshot_context(snapshot)

        messages: list[dict[str, str]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": scenario_context_message(context)},
            *(
                {"role": message.role, "content": message.content}
                for message in request.messages
            ),
        ]
        try:
            result = await self.probe.chat(
                MODEL_NAME,
                messages,
                temperature=CHAT_TEMPERATURE,
                num_ctx=NUM_CTX,
                keep_alive=CHAT_KEEP_ALIVE,
                format_schema=CHAT_FORMAT_SCHEMA,
                think=THINK,
                timeout_seconds=self.settings.ai_chat_timeout_seconds,
            )
        except AiError:
            raise
        except Exception as exc:  # noqa: BLE001 - any transport failure is a 503
            raise service_unavailable("The local AI service did not answer the question.") from exc

        output = validate_chat_output(result.content, context)
        proposal = None
        if output.proposal is not None:
            stored = ground_proposal(copilot=self, snapshot=snapshot, output=output.proposal)
            proposal = stored.as_contract() if stored is not None else None
        return AiChatResponse(
            answer=output.answer,
            usedRevision=snapshot["scenarioRevision"],
            references=output.references,
            proposal=proposal,
            timingsMs=result.timings_ms,
        )

    # -- report ------------------------------------------------------------------------

    async def shift_report(self, request: AiReportRequest) -> AiReportResponse:
        await self.require_loaded_model()
        snapshot = load_snapshot(self.store, request.scenarioId)
        context = build_snapshot_context(snapshot)
        skeleton = build_report_skeleton(snapshot)

        messages: list[dict[str, str]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": scenario_context_message(context)},
            {
                "role": "user",
                "content": (
                    "Redacta el informe de turno en espanol con los campos summary, "
                    "highlights, risks y recommendations. Usa solo las cifras del JSON."
                ),
            },
        ]
        try:
            result = await self.probe.chat(
                MODEL_NAME,
                messages,
                temperature=REPORT_TEMPERATURE,
                num_ctx=NUM_CTX,
                keep_alive=CHAT_KEEP_ALIVE,
                format_schema=REPORT_FORMAT_SCHEMA,
                think=THINK,
                timeout_seconds=self.settings.ai_report_timeout_seconds,
            )
        except AiError:
            raise
        except Exception as exc:  # noqa: BLE001 - any transport failure is a 503
            raise service_unavailable("The local AI service did not answer the request.") from exc

        narrative = validate_report_narrative(result.content)
        report = apply_report_narrative(skeleton, narrative)
        return AiReportResponse(
            scenarioRevision=report["scenarioRevision"],
            generatedAt=report["generatedAt"],
            markdown=report_markdown(report),
            report=report,
            schemaVersion=AI_REPORT_SCHEMA_VERSION,
        )

    # -- proposals ---------------------------------------------------------------------

    def confirm_proposal(
        self, proposal_id: str, request: AiProposalCommandRequest
    ) -> dict[str, Any]:
        """Apply one confirmed proposal, exactly once, against the current revision."""
        snapshot = load_snapshot(self.store, self._scenario_for(proposal_id))
        # A retried confirmation answers the revision it already produced. This is checked
        # before the proposal state, because a confirmed proposal is not "not found" when
        # the very same human command is being replayed.
        replayed = self.store.replay(snapshot["scenarioId"], request.commandId)
        if replayed is not None:
            return replayed
        proposal = self._pending_proposal(proposal_id, snapshot["scenarioId"])
        self._require_current_revision(proposal, snapshot)
        result = self._apply(proposal, request)
        proposal.status = "CONFIRMED"
        return result

    def reject_proposal(
        self, proposal_id: str, request: AiProposalCommandRequest
    ) -> dict[str, Any]:
        snapshot = load_snapshot(self.store, self._scenario_for(proposal_id))
        replayed = self.store.replay(snapshot["scenarioId"], request.commandId)
        if replayed is not None:
            return replayed
        proposal = self._pending_proposal(proposal_id, snapshot["scenarioId"])
        self._require_current_revision(proposal, snapshot)
        result = self._reject(proposal, request)
        proposal.status = "REJECTED"
        return result

    def _scenario_for(self, proposal_id: str) -> str:
        proposal = self.proposals.peek(proposal_id)
        if proposal is None:
            raise AiError(404, "PROPOSAL_NOT_FOUND", "The proposal does not exist.")
        return proposal.scenarioId

    def _pending_proposal(self, proposal_id: str, scenario_id: str) -> StoredProposal:
        return self.proposals.resolve(proposal_id, scenario_id)

    @staticmethod
    def _require_current_revision(
        proposal: StoredProposal, snapshot: Mapping[str, Any]
    ) -> None:
        if proposal.revisionToApply != snapshot["scenarioRevision"]:
            raise AiError(
                404,
                "PROPOSAL_NOT_FOUND",
                "The proposal was computed against an older scenario revision.",
            )

    def _apply(
        self, proposal: StoredProposal, request: AiProposalCommandRequest
    ) -> dict[str, Any]:
        try:
            return self.store.apply_ai_proposal(
                proposal.scenarioId,
                proposal.kind,
                dict(proposal.payload),
                command_id=request.commandId,
                client_revision=request.scenarioRevision,
            )
        except HTTPException as exc:
            raise _translate_store_error(exc, request) from exc

    def _reject(
        self, proposal: StoredProposal, request: AiProposalCommandRequest
    ) -> dict[str, Any]:
        try:
            return self.store.reject_ai_proposal(
                proposal.scenarioId,
                command_id=request.commandId,
                client_revision=request.scenarioRevision,
            )
        except HTTPException as exc:
            raise _translate_store_error(exc, request) from exc


def _translate_store_error(
    exc: HTTPException, request: AiProposalCommandRequest
) -> AiError:
    code = exc.detail if isinstance(exc.detail, str) else "INTERNAL_ERROR"
    messages = {
        "VALIDATION_ERROR": "The proposal cannot be applied to the current scenario.",
        "SCENARIO_NOT_FOUND": "The scenario does not exist.",
        "VEHICLE_NOT_FOUND": "The proposal targets a robot that is not in the scenario.",
    }
    return AiError(
        exc.status_code,
        code,
        messages.get(code, "The proposal could not be applied."),
        command_id=request.commandId,
        scenario_revision=request.scenarioRevision,
    )
