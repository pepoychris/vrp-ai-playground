"""Response bodies of the API, validated before they reach the wire.

Field names and enums mirror the frozen Phase 0 contracts:
``docs/contracts/schemas/envelopes.schema.json`` for the AI envelopes and
``docs/contracts/schemas/events.schema.json`` for the install stream. ``GET /health`` is
an infrastructure probe that the frozen contract does not describe; its shape is
documented in the repository README.

Every Phase 8 model is ``extra="forbid"`` on purpose: model output is validated through
these types, so an unexpected field from the language model is a validation error and
never a surprise on the wire.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import ModelName

InstallJobState = Literal["IDLE", "DOWNLOADING", "VERIFYING", "COMPLETED", "FAILED"]
ProposalKind = Literal["SET_VEHICLE_UNAVAILABLE", "DELAY_VEHICLE", "REQUEST_REOPTIMIZATION"]
ProposalStatus = Literal["PENDING", "CONFIRMED", "REJECTED"]

# Frozen error catalogue of ``envelopes.schema.json#/$defs/errorCode``.
ErrorCode = Literal[
    "VALIDATION_ERROR",
    "MODEL_OVERRIDE_FORBIDDEN",
    "SCENARIO_NOT_FOUND",
    "VEHICLE_NOT_FOUND",
    "ORDER_NOT_FOUND",
    "BARRIER_NOT_FOUND",
    "PROPOSAL_NOT_FOUND",
    "BARRIER_LIMIT_REACHED",
    "NO_FLEET_DEPLOYED",
    "NO_ORDERS_AVAILABLE",
    "SIMULATION_NOT_RUNNING",
    "SNAP_OUT_OF_RADIUS",
    "SNAP_NO_VALID_EDGE",
    "AI_SERVICE_UNAVAILABLE",
    "AI_MODEL_NOT_INSTALLED",
    "AI_MODEL_NOT_LOADED",
    "AI_INSTALL_IN_PROGRESS",
    "AI_OUTPUT_INVALID",
    "INTERNAL_ERROR",
]


class InstallJob(BaseModel):
    """Model-install job.

    Phase 1 always reports ``installJob: null``: downloading a model is Phase 8
    work. The type exists so the response stays inside the frozen contract.
    """

    model_config = ConfigDict(extra="forbid")

    jobId: str
    state: InstallJobState
    modelName: ModelName
    startedAt: str
    finishedAt: str | None = None


class AiStatus(BaseModel):
    """``aiStatus`` from ``envelopes.schema.json`` (contract v1)."""

    model_config = ConfigDict(extra="forbid")

    serviceAvailable: bool
    modelInstalled: bool
    modelLoaded: bool
    modelName: ModelName
    installJob: InstallJob | None = None


class AiProposal(BaseModel):
    """``aiProposal``: an action the copilot suggests and a human has to confirm.

    The proposal is inert data. It carries the revision it was computed against, so the
    server can refuse a confirmation that arrives after the scenario moved on.
    """

    model_config = ConfigDict(extra="forbid")

    proposalId: str = Field(min_length=1)
    kind: ProposalKind
    summary: str = Field(min_length=1)
    payload: dict[str, Any]
    status: ProposalStatus
    revisionToApply: int | None = Field(default=None, ge=0)


class AiChatResponse(BaseModel):
    """``aiChatResponse``: grounded answer, cited fields, timings and an optional proposal."""

    model_config = ConfigDict(extra="forbid")

    answer: str = Field(min_length=1)
    usedRevision: int = Field(ge=0)
    references: list[str]
    proposal: AiProposal | None
    timingsMs: dict[str, int]


class AiReportResponse(BaseModel):
    """``aiReportResponse``: the same shift report in Markdown and in structured JSON."""

    model_config = ConfigDict(extra="forbid")

    scenarioRevision: int = Field(ge=0)
    generatedAt: str
    markdown: str = Field(min_length=1)
    report: dict[str, Any]
    schemaVersion: str = Field(min_length=1)


class AiInstallEventPayload(BaseModel):
    """``ai.install`` payload: normalized download progress."""

    model_config = ConfigDict(extra="forbid")

    state: InstallJobState
    modelName: ModelName
    percent: float | None = Field(default=None, ge=0, le=100)
    statusText: str
    error: str | None = None


class AiInstallEvent(BaseModel):
    """``ai.install`` SSE event of ``events.schema.json``."""

    model_config = ConfigDict(extra="forbid")

    eventId: str = Field(pattern=r"^[0-9]+:[0-9]+$")
    eventSeq: int = Field(ge=0)
    type: Literal["ai.install"]
    scenarioRevision: int | None = None
    emittedAt: str
    commandId: str | None = None
    payload: AiInstallEventPayload


class AiStatusEvent(BaseModel):
    """``ai.status`` SSE event of ``events.schema.json``."""

    model_config = ConfigDict(extra="forbid")

    eventId: str = Field(pattern=r"^[0-9]+:[0-9]+$")
    eventSeq: int = Field(ge=0)
    type: Literal["ai.status"]
    scenarioRevision: int | None = None
    emittedAt: str
    commandId: str | None = None
    payload: AiStatus


class AiErrorBody(BaseModel):
    """``errorResponse.error`` of the frozen catalogue."""

    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = None
    scenarioRevision: int | None = None
    commandId: str | None = None
    retryable: bool


class AiErrorResponse(BaseModel):
    """``errorResponse``: the envelope every AI endpoint answers a failure with."""

    model_config = ConfigDict(extra="forbid")

    error: AiErrorBody


class HealthResponse(BaseModel):
    """Infrastructure probe used by Docker Compose and the status screen."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    service: str
    version: str
