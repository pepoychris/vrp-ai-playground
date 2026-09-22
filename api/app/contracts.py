"""Response bodies implemented in Phase 1.

Field names and enums mirror the frozen Phase 0 contracts:
``docs/contracts/schemas/envelopes.schema.json`` (``$defs.aiStatus``) for
``GET /api/ai/status``. ``GET /health`` is an infrastructure probe that the frozen
contract does not describe; its shape is documented in the repository README.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .config import ModelName

InstallJobState = Literal["IDLE", "DOWNLOADING", "VERIFYING", "COMPLETED", "FAILED"]


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


class HealthResponse(BaseModel):
    """Infrastructure probe used by Docker Compose and the status screen."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    service: str
    version: str
