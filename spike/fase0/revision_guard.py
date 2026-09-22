"""Implementacion de referencia de las reglas de descarte de resultados obsoletos.

Especificacion: `docs/contracts/rest-sse.md`, seccion 4. El frontend de la Fase 6
reimplementara estas reglas en TypeScript; aqui sirven como referencia ejecutable y
como prueba de que la regla se puede aplicar con el contrato congelado.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


@dataclass
class RevisionGuard:
    """Lleva la ultima revision y el ultimo tick aplicados."""

    max_applied_revision: int = -1
    max_applied_tick: int = -1
    pending_command_id: str | None = None
    resync_required: bool = field(default=False)
    discarded: int = field(default=0)
    applied: int = field(default=0)

    def begin_command(self, command_id: str) -> None:
        """Marca el comando en vuelo; solo su respuesta se aceptara como directa."""
        self.pending_command_id = command_id

    def accept_command_response(self, response: Mapping[str, object]) -> bool:
        """Acepta la respuesta solo si pertenece al comando pendiente."""
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
        """Acepta un snapshot solo si no es mas antiguo que lo ya aplicado."""
        if scenario_revision < self.max_applied_revision:
            self.discarded += 1
            return False
        self._apply_revision(scenario_revision)
        return True

    def accept_telemetry(self, scenario_revision: int, tick: int) -> bool:
        """Descarta telemetria de una revision vieja o con tick repetido."""
        if scenario_revision < self.max_applied_revision:
            self.discarded += 1
            return False
        if scenario_revision == self.max_applied_revision and tick <= self.max_applied_tick:
            self.discarded += 1
            return False
        if scenario_revision > self.max_applied_revision:
            # La telemetria no crea revisiones: informa de una revision ya aplicada.
            self.discarded += 1
            return False
        self.max_applied_tick = tick
        self.applied += 1
        return True

    def accept_event(self, event: Mapping[str, object]) -> bool:
        """Aplica la regla que corresponde al tipo de evento SSE."""
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
        # Avisos sin estado (optimizador, errores, IA) no cambian la revision aplicada.
        self.applied += 1
        return True

    def complete_resync(self, scenario_revision: int) -> None:
        """Cierra un resync con el snapshot obtenido por GET."""
        self.resync_required = False
        self.max_applied_tick = -1
        self._apply_revision(scenario_revision)

    def _apply_revision(self, scenario_revision: int) -> None:
        if scenario_revision > self.max_applied_revision:
            self.max_applied_revision = scenario_revision
            self.max_applied_tick = -1
        self.applied += 1
