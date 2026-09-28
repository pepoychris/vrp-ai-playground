"""Reference implementation of the stale-result discard rules.

Specification: `docs/contracts/rest-sse.md`, section 4. The Phase 6 frontend reimplements
these rules in TypeScript; here they serve as an executable reference and as proof that
the rule can be applied with the frozen contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


@dataclass
class RevisionGuard:
    """Track the last applied revision and the last applied tick."""

    max_applied_revision: int = -1
    max_applied_tick: int = -1
    pending_command_id: str | None = None
    resync_required: bool = field(default=False)
    discarded: int = field(default=0)
    applied: int = field(default=0)

    def begin_command(self, command_id: str) -> None:
        """Mark the in-flight command; only its response is accepted as direct."""
        self.pending_command_id = command_id

    def accept_command_response(self, response: Mapping[str, object]) -> bool:
        """Accept the response only when it belongs to the pending command."""
        command_id = response.get("commandId")
        if self.pending_command_id is not None and command_id != self.pending_command_id:
            self.discarded += 1
            return False
        self.pending_command_id = None
        revision = response.get("scenarioRevision")
        if isinstance(revision, int):
            self._apply_revision(revision)
        return True

    def accept_snapshot(self, scenario_revision: int) -> bool:
        """Accept a snapshot only when it is not older than what was already applied."""
        if scenario_revision < self.max_applied_revision:
            self.discarded += 1
            return False
        self._apply_revision(scenario_revision)
        return True

    def accept_telemetry(self, scenario_revision: int, tick: int) -> bool:
        """Discard telemetry from an old revision or with a repeated tick."""
        if scenario_revision < self.max_applied_revision:
            self.discarded += 1
            return False
        if scenario_revision == self.max_applied_revision and tick <= self.max_applied_tick:
            self.discarded += 1
            return False
        if scenario_revision > self.max_applied_revision:
            # Telemetry does not create revisions: it reports an already applied revision.
            self.discarded += 1
            return False
        self.max_applied_tick = tick
        self.applied += 1
        return True

    def accept_event(self, event: Mapping[str, object]) -> bool:
        """Apply the rule that matches the SSE event type."""
        event_type = event.get("type")
        if event_type == "scenario.resync":
            self.resync_required = True
            self.discarded += 1
            return False
        revision = event.get("scenarioRevision")
        payload = event.get("payload")
        if event_type == "scenario.snapshot" and isinstance(revision, int):
            return self.accept_snapshot(revision)
        if event_type == "scenario.simulation" and isinstance(revision, int):
            tick = payload.get("tick") if isinstance(payload, Mapping) else None
            if not isinstance(tick, int):
                self.discarded += 1
                return False
            return self.accept_telemetry(revision, tick)
        # Stateless notices (optimizer, errors, AI) do not change the applied revision.
        self.applied += 1
        return True

    def complete_resync(self, scenario_revision: int) -> None:
        """Close a resync with the snapshot obtained through GET."""
        self.resync_required = False
        self.max_applied_tick = -1
        self._apply_revision(scenario_revision)

    def _apply_revision(self, scenario_revision: int) -> None:
        if scenario_revision > self.max_applied_revision:
            self.max_applied_revision = scenario_revision
            self.max_applied_tick = -1
        self.applied += 1
