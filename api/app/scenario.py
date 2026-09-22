"""Seeded scenario generation, command handling and revision publication.

Phase 4 added the seeded generator; Phase 5 added the bounded optimisation command and
the route/KPI revision it publishes; Phase 6 added the simulation clock and the claw
relocation command; Phase 7 adds the robotic barrier, its road-edge block and the
before/after comparison of the cut. The store deliberately keeps the scenario in
memory: starting the service still has no business side effects, while reset can remove
the current scenario atomically.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Final, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException, status
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from .barriers import (
    MAX_BARRIERS,
    barrier_id_for,
    blocked_edge_ids,
    edge_snap,
    nearest_edge,
)
from .routing import (
    DEFAULT_TIME_LIMIT_SECONDS,
    MAX_TIME_LIMIT_SECONDS,
    MIN_TIME_LIMIT_SECONDS,
    depot_node_id,
    optimize_snapshot,
)
from .simulation import (
    DEFAULT_SPEED_MULTIPLIER,
    MAX_SPEED_MULTIPLIER,
    advance_clock,
    bounded_tick_delta,
    clamp_speed_multiplier,
    nearest_node,
    simulation_state,
)

MIN_VEHICLES: Final = 1
MAX_VEHICLES: Final = 6
MIN_ORDERS: Final = 6
MAX_ORDERS: Final = 24
DEFAULT_SEED: Final = 20260922
MAX_SEED: Final = 2**32 - 1

EDGE_ID_PATTERN: Final = r"^E-N[0-9]{3}-N[0-9]{3}$"

VehicleStatus = Literal["AVAILABLE", "EN_ROUTE", "DELAYED", "BLOCKED", "FINISHED"]
OrderStatus = Literal["PENDING", "ASSIGNED", "DELIVERED", "DELAYED", "UNASSIGNED"]
Priority = Literal["LOW", "NORMAL", "URGENT"]

# Command kinds that own the simulation clock. Every other kind is a structural change,
# so it invalidates the tick timeline instead of inheriting it.
SIMULATION_KINDS: Final = ("SIMULATION_START", "SIMULATION_PAUSE")

# Phase 8: the only actions the copilot may suggest. Each one the user confirms becomes a
# single ``PROPOSAL_CONFIRMED`` revision, exactly like any other mutation.
AI_PROPOSAL_KINDS: Final = (
    "SET_VEHICLE_UNAVAILABLE",
    "DELAY_VEHICLE",
    "REQUEST_REOPTIMIZATION",
)
# Kinds that take one robot out of the plan, and the status they leave behind.
PROPOSAL_VEHICLE_STATUS: Final = {
    "SET_VEHICLE_UNAVAILABLE": "BLOCKED",
    "DELAY_VEHICLE": "DELAYED",
}
# A robot in one of these states is not part of the planning fleet.
UNAVAILABLE_VEHICLE_STATUSES: Final = ("BLOCKED", "DELAYED")


def _require_uuid4(value: str) -> str:
    try:
        parsed = UUID(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("commandId must be a UUID v4") from exc
    if parsed.version != 4:
        raise ValueError("commandId must be a UUID v4")
    return value


def _optional_uuid4(value: str | None) -> str | None:
    """The envelope stays optional on the endpoints that allow a reduced body."""
    return None if value is None else _require_uuid4(value)


CommandId = Annotated[str | None, AfterValidator(_optional_uuid4)]
# Required form, used by the Phase 8 AI commands: a human command always carries an id.
RequiredCommandId = Annotated[str, AfterValidator(_require_uuid4)]


class SeededPrng:
    """Small deterministic xorshift generator; all scenario randomness goes here."""

    def __init__(self, seed: int) -> None:
        self._state = (seed & 0xFFFFFFFF) or 0x6D2B79F5

    def next_uint(self) -> int:
        value = self._state
        value ^= (value << 13) & 0xFFFFFFFF
        value ^= value >> 17
        value ^= (value << 5) & 0xFFFFFFFF
        self._state = value & 0xFFFFFFFF
        return self._state

    def fraction(self) -> float:
        return self.next_uint() / 0x100000000

    def int_between(self, minimum: int, maximum: int) -> int:
        if minimum > maximum:
            raise ValueError("minimum must not exceed maximum")
        return minimum + int(self.fraction() * (maximum - minimum + 1))

    def choice(self, values: tuple[str, ...]) -> str:
        return values[self.int_between(0, len(values) - 1)]


class ScenarioCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    commandId: str
    kind: str
    appliedAgainstRevision: int
    rebased: bool = False
    replayed: bool = False


class ScenarioCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seed: int = Field(default=DEFAULT_SEED, ge=0, le=MAX_SEED)


class FleetGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    count: int = Field(ge=MIN_VEHICLES, le=MAX_VEHICLES)


class OrdersGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    count: int = Field(ge=MIN_ORDERS, le=MAX_ORDERS)


class ScenarioCommandRequest(BaseModel):
    """Frozen command envelope shared by every state-mutating command.

    ``commandId`` and ``scenarioRevision`` are optional so the reduced bodies used by
    the Phase 4 controls keep working. When they are present the frozen semantics
    apply: repeating a ``commandId`` never mutates the scenario twice, and a client
    revision that no longer matches is reported as ``rebased`` instead of rejected.
    """

    model_config = ConfigDict(extra="forbid")

    commandId: CommandId = None
    scenarioRevision: int | None = Field(default=None, ge=0)


class OptimizeRequest(ScenarioCommandRequest):
    """Bounded route search limit on top of the command envelope."""

    timeLimitSeconds: int = Field(
        default=DEFAULT_TIME_LIMIT_SECONDS, ge=MIN_TIME_LIMIT_SECONDS, le=MAX_TIME_LIMIT_SECONDS
    )


class SimulationStartRequest(ScenarioCommandRequest):
    """Start or resume the simulation, optionally changing its speed."""

    speedMultiplier: float = Field(
        default=DEFAULT_SPEED_MULTIPLIER, gt=0, le=MAX_SPEED_MULTIPLIER
    )


class SimulationPauseRequest(ScenarioCommandRequest):
    """Pause a running simulation. Pausing an idle simulation is a conflict."""


class Point3D(BaseModel):
    """Local Three.js world point in metres; the MVP city is flat, so ``y`` is zero."""

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float = 0.0
    z: float


class VehiclePositionRequest(ScenarioCommandRequest):
    """Claw drop position for one vehicle."""

    position: Point3D


class BarrierPlaceRequest(ScenarioCommandRequest):
    """Place one barrier on a road edge.

    The frozen contract accepts either a world point, which the server snaps to the
    nearest road edge, or an explicit ``edgeId``, which is validated against the graph.
    Sending both is not ambiguous: the explicit identifier wins and no snap is done.
    """

    position: Point3D | None = None
    edgeId: str | None = Field(default=None, pattern=EDGE_ID_PATTERN)

    @model_validator(mode="after")
    def _require_a_target(self) -> "BarrierPlaceRequest":
        if self.position is None and self.edgeId is None:
            raise ValueError("a barrier needs either a position or an edgeId")
        return self


class BarrierRemoveRequest(ScenarioCommandRequest):
    """Optional command envelope for removing one barrier.

    ``DELETE`` is a resource operation, so the frozen contract does not demand a body.
    When the client does send ``commandId`` and ``scenarioRevision`` the extra fields are
    rejected and the idempotent replay semantics of every other command apply.
    """


class ScenarioRevisionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    scenarioId: str
    scenarioRevision: int
    previousRevision: int | None
    status: Literal["IDLE", "READY", "OPTIMIZING", "RUNNING", "PAUSED"]
    seed: int
    graph: dict[str, Any]
    vehicles: list[dict[str, Any]]
    orders: list[dict[str, Any]]
    barriers: list[dict[str, Any]]
    blockedEdgeIds: list[str]
    routePlan: dict[str, Any] | None
    kpis: dict[str, Any] | None
    simulation: dict[str, Any]
    appliedCommand: dict[str, Any] | None
    emittedAt: str
    # Endpoint-specific result of the command that produced this revision, when the
    # frozen contract declares one (``result.barrierPlacement``). It is never stored in
    # the scenario itself, so ``GET`` keeps returning a plain ``ScenarioRevision``.
    result: dict[str, Any] | None = None


class ScenarioResetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenarioId: str
    status: Literal["RESET"]
    scenarioRevision: int


def _graph() -> dict[str, Any]:
    """The deterministic Phase 3 robot-city road graph.

    The API keeps the graph local and self-contained so the container does not need
    to read frontend source files.  The grid dimensions, node ids and road speeds
    mirror ``frontend/src/city/robot-city.json``; routing therefore uses the same
    node and edge identifiers that the renderer consumes.
    """
    grid_x = (-200, -144, -96, -48, 0, 48, 96, 144, 200)
    grid_z = (-168, -112, -58, 0, 58, 112, 168)
    depot_column, depot_row = 4, 3

    def node_id(column: int, row: int) -> str:
        return f"N-{row * len(grid_x) + column + 1:03d}"

    delivery_keys = set()
    last_column, last_row = len(grid_x) - 1, len(grid_z) - 1
    for row in range(last_row + 1):
        for column in range(last_column + 1):
            on_ring = row in (0, last_row) or column in (0, last_column)
            if on_ring and (row + column) % 2 == 0:
                delivery_keys.add((column, row))
    delivery_keys.update(((2, 2), (6, 2), (2, 4), (6, 4)))
    delivery_keys.discard((depot_column, depot_row))

    nodes: list[dict[str, Any]] = []
    for row, z in enumerate(grid_z):
        for column, x in enumerate(grid_x):
            is_depot = column == depot_column and row == depot_row
            kind = "DEPOT" if is_depot else ("DELIVERY" if (column, row) in delivery_keys else "JUNCTION")
            node: dict[str, Any] = {"nodeId": node_id(column, row), "kind": kind,
                                    "position": {"x": x, "y": 0, "z": z}}
            if is_depot:
                node["label"] = "Central depot"
            nodes.append(node)

    def horizontal_speed(row: int) -> int:
        return 50 if row == depot_row else (40 if row in (0, last_row) else 30)

    def vertical_speed(column: int) -> int:
        return 50 if column == depot_column else (40 if column in (0, last_column) else 30)

    positions = {node["nodeId"]: node["position"] for node in nodes}
    edges: list[dict[str, Any]] = []

    def add_edge(first: str, second: str, speed: int) -> None:
        low, high = sorted((first, second))
        start, end = positions[low], positions[high]
        length = ((end["x"] - start["x"]) ** 2 + (end["z"] - start["z"]) ** 2) ** 0.5
        edges.append({"edgeId": f"E-{low.replace('-', '')}-{high.replace('-', '')}",
                      "fromNodeId": low, "toNodeId": high, "bidirectional": True,
                      "lengthMeters": length, "speedLimitKph": speed,
                      "visualSplineControlPoints": [start, end]})

    for row in range(len(grid_z)):
        for column in range(last_column):
            add_edge(node_id(column, row), node_id(column + 1, row), horizontal_speed(row))
    for column in range(len(grid_x)):
        for row in range(last_row):
            add_edge(node_id(column, row), node_id(column, row + 1), vertical_speed(column))
    return {"cityId": "robot-city", "graphVersion": 1, "nodes": nodes, "edges": edges}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _command(
    scenario_id: str,
    revision: int,
    kind: str,
    *,
    command_id: str | None = None,
    client_revision: int | None = None,
) -> dict[str, Any]:
    """Build the applied-command record for one atomic revision.

    ``appliedAgainstRevision`` is the revision the command really ran against. When
    the client sent an older ``scenarioRevision`` the command is rebased instead of
    rejected, which is the frozen contract behaviour.
    """
    resolved_id = command_id or str(uuid5(NAMESPACE_URL, f"{scenario_id}:{revision}:{kind}"))
    applied_against = revision - 1
    return {
        "commandId": resolved_id,
        "kind": kind,
        "appliedAgainstRevision": applied_against,
        "rebased": client_revision is not None and client_revision != applied_against,
        "replayed": False,
    }


def _base_snapshot(seed: int, scenario_id: str) -> dict[str, Any]:
    return {"scenarioId": scenario_id, "scenarioRevision": 1, "previousRevision": None,
            "status": "READY", "seed": seed, "graph": _graph(), "vehicles": [], "orders": [],
            "barriers": [], "blockedEdgeIds": [], "routePlan": None, "kpis": None,
            "simulation": simulation_state(running=False),
            "appliedCommand": None, "emittedAt": _utc_now()}


def _vehicle(vehicle_index: int, prng: SeededPrng, depot: str) -> dict[str, Any]:
    capacity = float(prng.int_between(30, 60))
    volume = round(capacity / 20, 2)
    return {"vehicleId": f"R-{vehicle_index:02d}", "capacityKilograms": capacity,
            "capacityCubicMeters": volume, "loadKilograms": 0, "loadCubicMeters": 0,
            "batteryPercent": float(prng.int_between(70, 100)),
            "speedKilometersPerHour": float(prng.int_between(24, 42)),
            "costPerKilometerCents": prng.int_between(20, 80),
            "costPerMinuteCents": prng.int_between(10, 40),
            "fixedCostCents": prng.int_between(300, 700), "currentNodeId": depot,
            "status": "AVAILABLE", "assignedOrderIds": []}


def _order(order_index: int, prng: SeededPrng, delivery_nodes: tuple[str, ...]) -> dict[str, Any]:
    start = prng.int_between(0, 900)
    return {"orderId": f"O-{order_index:03d}", "deliveryNodeId": delivery_nodes[prng.int_between(0, len(delivery_nodes) - 1)],
            "weightKilograms": round(prng.int_between(1, 20) + prng.fraction(), 2),
            "volumeCubicMeters": round(0.1 + prng.fraction() * 1.5, 2),
            "priority": prng.choice(("LOW", "NORMAL", "URGENT")),
            "timeWindow": {"startSeconds": start, "endSeconds": start + prng.int_between(300, 1800)},
            "serviceSeconds": prng.int_between(60, 180), "status": "PENDING",
            "assignedVehicleId": None, "sequenceIndex": None}


def _mutate(
    snapshot: dict[str, Any],
    kind: str,
    *,
    command_id: str | None = None,
    client_revision: int | None = None,
) -> None:
    """Advance one scenario revision.

    A structural command resets the simulation clock: the published plan a tick was
    computed against no longer exists, so the old tick timeline is discarded instead of
    being replayed onto the new revision. The speed setting the user chose survives.
    """
    if kind not in SIMULATION_KINDS:
        reset_simulation(snapshot)
        snapshot["status"] = "READY"
    previous = snapshot["scenarioRevision"]
    snapshot["scenarioRevision"] = previous + 1
    snapshot["previousRevision"] = previous
    snapshot["appliedCommand"] = _command(
        snapshot["scenarioId"],
        previous + 1,
        kind,
        command_id=command_id,
        client_revision=client_revision,
    )
    snapshot["emittedAt"] = _utc_now()


def reset_simulation(snapshot: dict[str, Any]) -> None:
    """Return the simulation clock to its idle baseline, keeping the chosen speed."""
    previous = snapshot.get("simulation") or {}
    snapshot["simulation"] = simulation_state(
        running=False,
        speed_multiplier=float(previous.get("speedMultiplier", DEFAULT_SPEED_MULTIPLIER)),
        tick=0,
    )


def _idle_route(vehicle: dict[str, Any]) -> dict[str, Any]:
    """The route of a robot that takes no part in this revision's plan.

    A vehicle pulled out of service still owns an entry in ``routePlan.vehicles``: the plan
    is read per vehicle everywhere else, so the unavailable robot is published with an
    empty route instead of disappearing from the plan.
    """
    current = vehicle.get("currentNodeId")
    return {
        "vehicleId": vehicle["vehicleId"],
        "nodeSequence": [current] if current else [],
        "edgeSequence": [],
        "stops": [],
        "distanceMeters": 0,
        "driveSeconds": 0,
        "loadUtilizationPercent": 0,
        "endsAtSeconds": 0,
    }


def available_vehicle_ids(snapshot: dict[str, Any]) -> list[str]:
    """Robots that can still take stops in the current revision."""
    return [
        vehicle["vehicleId"]
        for vehicle in snapshot["vehicles"]
        if vehicle.get("status") not in UNAVAILABLE_VEHICLE_STATUSES
    ]


@dataclass(slots=True)
class ScenarioStore:
    scenarios: dict[str, dict[str, Any]]
    command_results: dict[str, dict[str, Any]]
    command_payloads: dict[str, dict[str, Any]]
    barrier_sequences: dict[str, int]

    def __init__(self) -> None:
        self.scenarios = {}
        # Frozen contract semantics: repeating a commandId returns the stored result
        # instead of mutating the scenario again. The window is the scenario lifetime.
        self.command_results = {}
        # The endpoint-specific ``result`` payload of a stored command, kept beside the
        # stored snapshot so a replay can answer exactly what the original response did.
        self.command_payloads = {}
        # Barrier ids are never reused inside a scenario, so the placement sequence is
        # kept next to the scenario instead of being derived from the active barriers.
        self.barrier_sequences = {}

    def create(self, seed: int) -> dict[str, Any]:
        scenario_id = str(uuid5(NAMESPACE_URL, f"roboroute-nexus:{seed}"))
        snapshot = _base_snapshot(seed, scenario_id)
        self.scenarios[scenario_id] = snapshot
        return snapshot

    def get(self, scenario_id: str) -> dict[str, Any]:
        try:
            UUID(scenario_id)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SCENARIO_NOT_FOUND") from exc
        if scenario_id not in self.scenarios:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SCENARIO_NOT_FOUND")
        return self.scenarios[scenario_id]

    def deploy_fleet(self, scenario_id: str, count: int) -> dict[str, Any]:
        snapshot = self.get(scenario_id)
        prng = SeededPrng(snapshot["seed"] ^ 0xF1EE7)
        depot = depot_node_id(snapshot["graph"])
        snapshot["vehicles"] = [
            _vehicle(index, prng, depot) for index in range(1, count + 1)
        ]
        _mutate(snapshot, "FLEET_DEPLOYED")
        return snapshot

    def generate_orders(self, scenario_id: str, count: int) -> dict[str, Any]:
        snapshot = self.get(scenario_id)
        delivery_nodes = tuple(node["nodeId"] for node in snapshot["graph"]["nodes"] if node["kind"] == "DELIVERY")
        prng = SeededPrng(snapshot["seed"] ^ 0x0D3E)
        snapshot["orders"] = [_order(index, prng, delivery_nodes) for index in range(1, count + 1)]
        _mutate(snapshot, "ORDERS_FABRICATED")
        return snapshot

    def optimize(
        self,
        scenario_id: str,
        time_limit_seconds: int = DEFAULT_TIME_LIMIT_SECONDS,
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Compute and publish one complete route/KPI snapshot atomically.

        A repeated ``command_id`` returns the stored revision with
        ``appliedCommand.replayed`` set, exactly like every other mutation in the
        frozen contract, so a retried request never plans twice.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed
        if not snapshot["vehicles"]:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="NO_FLEET_DEPLOYED")
        if not snapshot["orders"]:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="NO_ORDERS_AVAILABLE")

        working = deepcopy(snapshot)
        working["status"] = "OPTIMIZING"
        self._publish_routes(
            working,
            snapshot,
            time_limit_seconds=time_limit_seconds,
            kind="OPTIMIZE",
            command_id=command_id,
            client_revision=client_revision,
        )
        self._publish(scenario_id, working, command_id=command_id)
        return working

    def start_simulation(
        self,
        scenario_id: str,
        speed_multiplier: float = DEFAULT_SPEED_MULTIPLIER,
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Start or resume the simulation, optionally at a new speed.

        The clock is never rewound here: resuming from PAUSED, and changing the speed of
        a running simulation, both keep the ticks already simulated. Only a structural
        command resets the timeline.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed
        try:
            multiplier = clamp_speed_multiplier(speed_multiplier)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="VALIDATION_ERROR",
            ) from exc

        working = deepcopy(snapshot)
        current = working.get("simulation") or {}
        working["simulation"] = simulation_state(
            running=True,
            speed_multiplier=multiplier,
            tick=int(current.get("tick", 0)),
        )
        _mutate(
            working,
            "SIMULATION_START",
            command_id=command_id,
            client_revision=client_revision,
        )
        working["status"] = "RUNNING"
        self._publish(scenario_id, working, command_id=command_id)
        return working

    def pause_simulation(
        self,
        scenario_id: str,
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Pause a running simulation, keeping the ticks already simulated."""
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed
        current = snapshot.get("simulation") or {}
        if not current.get("running"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="SIMULATION_NOT_RUNNING",
            )

        working = deepcopy(snapshot)
        working["simulation"] = simulation_state(
            running=False,
            speed_multiplier=float(
                current.get("speedMultiplier", DEFAULT_SPEED_MULTIPLIER)
            ),
            tick=int(current.get("tick", 0)),
        )
        _mutate(
            working,
            "SIMULATION_PAUSE",
            command_id=command_id,
            client_revision=client_revision,
        )
        working["status"] = "PAUSED"
        self._publish(scenario_id, working, command_id=command_id)
        return working

    def relocate_vehicle(
        self,
        scenario_id: str,
        vehicle_id: str,
        position: dict[str, float],
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Drop one vehicle on the nearest road node and re-plan exactly once.

        A drop outside the claw radius is rejected with ``SNAP_OUT_OF_RADIUS`` and
        publishes nothing, so an invalid gesture cannot consume a revision. A valid drop
        relocates the vehicle, resets the tick timeline and recomputes the route plan and
        the KPIs in the same atomic revision.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed
        vehicle = next(
            (item for item in snapshot["vehicles"] if item["vehicleId"] == vehicle_id),
            None,
        )
        if vehicle is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="VEHICLE_NOT_FOUND"
            )
        snap = nearest_node(snapshot["graph"], position)
        if snap is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="SNAP_OUT_OF_RADIUS",
            )

        working = deepcopy(snapshot)
        target = next(
            item for item in working["vehicles"] if item["vehicleId"] == vehicle_id
        )
        target["currentNodeId"] = snap.node_id
        if working["orders"]:
            self._publish_routes(
                working,
                snapshot,
                time_limit_seconds=DEFAULT_TIME_LIMIT_SECONDS,
                kind="VEHICLE_RELOCATED",
                command_id=command_id,
                client_revision=client_revision,
            )
        else:
            _mutate(
                working,
                "VEHICLE_RELOCATED",
                command_id=command_id,
                client_revision=client_revision,
            )
        self._publish(scenario_id, working, command_id=command_id)
        return working

    def place_barrier(
        self,
        scenario_id: str,
        *,
        position: dict[str, float] | None = None,
        edge_id: str | None = None,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Place exactly one barrier on one road edge and publish it atomically.

        The frozen contract accepts a world point (snapped to the nearest road edge, with
        already blocked edges excluded from the candidates) or an explicit ``edgeId`` that
        must exist in the immutable graph. A drop without a candidate edge answers
        ``422 SNAP_NO_VALID_EDGE`` and a fourth barrier answers ``409 BARRIER_LIMIT_REACHED``;
        neither failure consumes a revision.

        A successful placement recomputes routes and KPIs in the *same* revision, so the
        cut, the plan and the before/after delta are always published together.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            # A replayed command answers with the placement it produced the first time, so
            # a retried drop is indistinguishable from the original response.
            return replayed, self._replayed_payload(scenario_id, command_id)
        if len(snapshot["barriers"]) >= MAX_BARRIERS:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="BARRIER_LIMIT_REACHED"
            )

        if edge_id is not None:
            # An already blocked edge is not a valid candidate either: one barrier owns
            # one road, and the block is a set, not a counter.
            snap = (
                None
                if edge_id in set(snapshot.get("blockedEdgeIds") or [])
                else edge_snap(snapshot["graph"], edge_id)
            )
        else:
            snap = nearest_edge(
                snapshot["graph"],
                position or {"x": 0.0, "y": 0.0, "z": 0.0},
                excluded_edge_ids=snapshot.get("blockedEdgeIds") or [],
            )
        if snap is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="SNAP_NO_VALID_EDGE",
            )

        sequence = self.barrier_sequences.get(scenario_id, 0) + 1
        barrier = {
            "barrierId": barrier_id_for(sequence),
            "blockedEdgeId": snap.edge_id,
            "position": snap.projected_point,
            # The revision this placement was applied against, which is what the frozen
            # barrier example publishes: the barrier appears in the next revision.
            "placedAtRevision": snapshot["scenarioRevision"],
        }

        working = deepcopy(snapshot)
        working["barriers"] = [*working["barriers"], barrier]
        working["blockedEdgeIds"] = blocked_edge_ids(working["barriers"])
        self.barrier_sequences[scenario_id] = sequence
        result = {
            "barrierId": barrier["barrierId"],
            "blockedEdgeId": snap.edge_id,
            "projectedPoint": snap.projected_point,
            "distanceMeters": round(snap.distance_meters, 6),
            "accepted": True,
            "rejectionCode": None,
        }
        self._recompute_or_mutate(
            working,
            snapshot,
            kind="BARRIER_PLACED",
            command_id=command_id,
            client_revision=client_revision,
        )
        self._publish(scenario_id, working, command_id=command_id, payload=result)
        return working, result

    def remove_barrier(
        self,
        scenario_id: str,
        barrier_id: str,
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Remove one barrier, restore its edge and recompute the plan once.

        The removed road edge disappears from ``blockedEdgeIds`` in the same revision, so
        the next plan is computed against the restored graph. An unknown ``barrierId``
        answers ``404 BARRIER_NOT_FOUND`` and publishes nothing.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed, None
        barrier = next(
            (item for item in snapshot["barriers"] if item["barrierId"] == barrier_id),
            None,
        )
        if barrier is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="BARRIER_NOT_FOUND"
            )

        working = deepcopy(snapshot)
        working["barriers"] = [
            item for item in working["barriers"] if item["barrierId"] != barrier_id
        ]
        working["blockedEdgeIds"] = blocked_edge_ids(working["barriers"])
        self._recompute_or_mutate(
            working,
            snapshot,
            kind="BARRIER_REMOVED",
            command_id=command_id,
            client_revision=client_revision,
        )
        self._publish(scenario_id, working, command_id=command_id)
        return working, None

    def advance_simulation(
        self,
        scenario_id: str,
        real_seconds: float,
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        """Advance the running simulation clock by a bounded number of ticks.

        This is telemetry, not a command: it never bumps ``scenarioRevision`` and never
        touches ``emittedAt``, exactly like the frozen ``scenario.simulation`` stream.
        A tick that was computed for an older revision is discarded instead of being
        applied to the current one, so a slow tick can never overwrite a newer revision.
        The REST surface of the frozen contract has no tick endpoint: the event stream of
        a later phase drives this method, and Phase 6 tests it directly.
        """
        snapshot = self.get(scenario_id)
        current = snapshot.get("simulation") or {}
        if expected_revision is not None and int(expected_revision) != snapshot["scenarioRevision"]:
            return deepcopy(snapshot)
        if not current.get("running"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="SIMULATION_NOT_RUNNING",
            )
        ticks = bounded_tick_delta(
            real_seconds, float(current.get("speedMultiplier", DEFAULT_SPEED_MULTIPLIER))
        )
        snapshot["simulation"] = advance_clock(current, ticks)
        return deepcopy(snapshot)

    def _replay(self, scenario_id: str, command_id: str | None) -> dict[str, Any] | None:
        """Stored result of an already-applied command, or ``None`` for a fresh one."""
        if command_id is None:
            return None
        stored = self.command_results.get(f"{scenario_id}:{command_id}")
        if stored is None:
            return None
        replayed = deepcopy(stored)
        applied = dict(replayed.get("appliedCommand") or {})
        applied["replayed"] = True
        replayed["appliedCommand"] = applied
        return replayed

    def replay(self, scenario_id: str, command_id: str | None) -> dict[str, Any] | None:
        """Public read of the frozen idempotency window of one scenario.

        The AI proposal endpoints consult it *before* judging the proposal, because a
        retried confirmation must answer the revision it already produced — a resolved
        proposal is not an error when the same human command is being replayed.
        """
        return self._replay(scenario_id, command_id)

    def _publish(
        self,
        scenario_id: str,
        working: dict[str, Any],
        *,
        command_id: str | None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.scenarios[scenario_id] = working
        if command_id is not None:
            key = f"{scenario_id}:{command_id}"
            self.command_results[key] = deepcopy(working)
            if payload is not None:
                self.command_payloads[key] = deepcopy(payload)

    def _replayed_payload(
        self, scenario_id: str, command_id: str | None
    ) -> dict[str, Any] | None:
        """The stored endpoint ``result`` of a replayed command, or ``None``.

        Commands whose frozen response carries no ``result`` (removal, simulation, claw)
        answer ``None``, which is exactly what a fresh call would have answered.
        """
        if command_id is None:
            return None
        stored = self.command_payloads.get(f"{scenario_id}:{command_id}")
        return deepcopy(stored) if stored is not None else None

    def _publish_routes(
        self,
        working: dict[str, Any],
        previous: dict[str, Any],
        *,
        time_limit_seconds: int,
        kind: str,
        command_id: str | None,
        client_revision: int | None,
        unavailable_vehicle_ids: frozenset[str] = frozenset(),
    ) -> None:
        """Run the planner once and stamp the plan on the next revision.

        Shared by the optimize command and the claw relocation so a relocation is
        exactly one recomputation, never a plan followed by a second pass.

        ``unavailable_vehicle_ids`` is the Phase 8 hook the AI proposal path uses to take
        one robot out of the plan. It defaults to the empty set, so every Phase 5-7 caller
        plans exactly the fleet it always planned.
        """
        if unavailable_vehicle_ids:
            full_fleet = working["vehicles"]
            working["vehicles"] = [
                vehicle
                for vehicle in full_fleet
                if vehicle["vehicleId"] not in unavailable_vehicle_ids
            ]
            try:
                route_plan, kpis = optimize_snapshot(working, time_limit_seconds)
            finally:
                working["vehicles"] = full_fleet
            # Re-attach an idle route for every robot that sat this revision out, and
            # restore the fleet order so the plan stays indexed like the vehicle list.
            routes_by_vehicle = {
                route["vehicleId"]: route for route in route_plan["vehicles"]
            }
            for vehicle in full_fleet:
                if vehicle["vehicleId"] in unavailable_vehicle_ids:
                    routes_by_vehicle[vehicle["vehicleId"]] = _idle_route(vehicle)
            route_plan["vehicles"] = [
                routes_by_vehicle[vehicle["vehicleId"]] for vehicle in full_fleet
            ]
        else:
            route_plan, kpis = optimize_snapshot(working, time_limit_seconds)
        _mutate(working, kind, command_id=command_id, client_revision=client_revision)
        route_plan["scenarioRevision"] = working["scenarioRevision"]
        route_plan["generatedAt"] = working["emittedAt"]
        kpis["scenarioRevision"] = working["scenarioRevision"]
        kpis["computedAt"] = working["emittedAt"]
        kpis["lastIntervention"] = _intervention_impact(previous.get("kpis"), kpis, kind=kind)
        working["routePlan"] = route_plan
        working["kpis"] = kpis
        working["status"] = "READY"

        assigned_by_order = {
            stop["orderId"]: route["vehicleId"]
            for route in route_plan["vehicles"]
            for stop in route["stops"]
        }
        unassigned = {item["orderId"]: item["reason"] for item in route_plan["unassignedOrders"]}
        for order in working["orders"]:
            if order["orderId"] in assigned_by_order:
                order["status"] = "DELAYED" if any(
                    stop["orderId"] == order["orderId"] and stop["delaySeconds"] > 0
                    for route in route_plan["vehicles"] for stop in route["stops"]
                ) else "ASSIGNED"
                order["assignedVehicleId"] = assigned_by_order[order["orderId"]]
                order["sequenceIndex"] = next(
                    index for index, stop in enumerate(
                        next(route for route in route_plan["vehicles"] if route["vehicleId"] == assigned_by_order[order["orderId"]])["stops"]
                    ) if stop["orderId"] == order["orderId"]
                )
            else:
                order["status"] = "UNASSIGNED"
                order["assignedVehicleId"] = None
                order["sequenceIndex"] = None
        for vehicle in working["vehicles"]:
            if vehicle["vehicleId"] in unavailable_vehicle_ids:
                # The robot is out of service: it keeps its own status and takes no stop.
                vehicle["assignedOrderIds"] = []
                continue
            route = next(route for route in route_plan["vehicles"] if route["vehicleId"] == vehicle["vehicleId"])
            vehicle["assignedOrderIds"] = [stop["orderId"] for stop in route["stops"]]
            vehicle["status"] = "EN_ROUTE" if route["stops"] else "AVAILABLE"

    def _recompute_or_mutate(
        self,
        working: dict[str, Any],
        previous: dict[str, Any],
        *,
        kind: str,
        command_id: str | None,
        client_revision: int | None,
    ) -> None:
        """Publish the plan of a barrier command in the same revision, when there is one.

        A barrier placed before a fleet or orders exist cannot change a plan, so it only
        advances the revision. As soon as both exist the cut recomputes the routes and the
        KPIs exactly once, which is the single recomputation the phase requires.
        """
        if working["vehicles"] and working["orders"]:
            self._publish_routes(
                working,
                previous,
                time_limit_seconds=DEFAULT_TIME_LIMIT_SECONDS,
                kind=kind,
                command_id=command_id,
                client_revision=client_revision,
            )
        else:
            _mutate(
                working,
                kind,
                command_id=command_id,
                client_revision=client_revision,
            )

    def reset(self, scenario_id: str) -> ScenarioResetResponse:
        snapshot = self.get(scenario_id)
        self.scenarios.pop(scenario_id, None)
        self.barrier_sequences.pop(scenario_id, None)
        prefix = f"{scenario_id}:"
        for key in [key for key in self.command_results if key.startswith(prefix)]:
            self.command_results.pop(key, None)
        for key in [key for key in self.command_payloads if key.startswith(prefix)]:
            self.command_payloads.pop(key, None)
        return ScenarioResetResponse(scenarioId=scenario_id, status="RESET", scenarioRevision=snapshot["scenarioRevision"] + 1)

    def apply_ai_proposal(
        self,
        scenario_id: str,
        kind: str,
        payload: dict[str, Any],
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Apply one human-confirmed copilot proposal as a single coherent revision.

        This is the *only* place a proposal becomes an action. The HTTP layer never calls
        it before the user confirms, and the revision it publishes carries
        ``PROPOSAL_CONFIRMED`` plus a plan recomputed against the mutated fleet, so the
        routes, the KPIs and the before/after comparison always describe the same revision.
        A repeated ``commandId`` is replayed instead of mutating twice.
        """
        if kind not in AI_PROPOSAL_KINDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="VALIDATION_ERROR"
            )
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed

        working = deepcopy(snapshot)
        unavailable: set[str] = set()
        target_status = PROPOSAL_VEHICLE_STATUS.get(kind)
        if target_status is not None:
            vehicle_id = payload.get("vehicleId")
            vehicle = next(
                (
                    item
                    for item in working["vehicles"]
                    if item["vehicleId"] == vehicle_id
                ),
                None,
            )
            if vehicle is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="VEHICLE_NOT_FOUND"
                )
            # The demo always keeps one robot on the road: taking the last available robot
            # out of service would leave a scenario nobody could plan or explain.
            if vehicle.get("status") not in UNAVAILABLE_VEHICLE_STATUSES:
                remaining = [
                    item["vehicleId"]
                    for item in working["vehicles"]
                    if item["vehicleId"] != vehicle_id
                    and item.get("status") not in UNAVAILABLE_VEHICLE_STATUSES
                ]
                if not remaining:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="VALIDATION_ERROR",
                    )
            vehicle["status"] = target_status
            unavailable.add(vehicle["vehicleId"])

        if working["vehicles"] and working["orders"]:
            self._publish_routes(
                working,
                snapshot,
                time_limit_seconds=DEFAULT_TIME_LIMIT_SECONDS,
                kind="PROPOSAL_CONFIRMED",
                command_id=command_id,
                client_revision=client_revision,
                unavailable_vehicle_ids=frozenset(unavailable),
            )
        else:
            _mutate(
                working,
                "PROPOSAL_CONFIRMED",
                command_id=command_id,
                client_revision=client_revision,
            )
        self._publish(scenario_id, working, command_id=command_id)
        return working

    def reject_ai_proposal(
        self,
        scenario_id: str,
        *,
        command_id: str | None = None,
        client_revision: int | None = None,
    ) -> dict[str, Any]:
        """Publish the rejection of one proposal as its own revision.

        The frozen contract catalogues ``PROPOSAL_REJECTED`` as an intervention kind and
        marks the endpoint as revision-bumping, so a rejection is a real revision *of the
        decision*, not of the scenario: no vehicle, order, route or closure is touched.
        """
        snapshot = self.get(scenario_id)
        replayed = self._replay(scenario_id, command_id)
        if replayed is not None:
            return replayed
        working = deepcopy(snapshot)
        _mutate(
            working,
            "PROPOSAL_REJECTED",
            command_id=command_id,
            client_revision=client_revision,
        )
        self._publish(scenario_id, working, command_id=command_id)
        return working


def _intervention_impact(
    previous_kpis: dict[str, Any] | None,
    current_kpis: dict[str, Any],
    *,
    kind: str = "OPTIMIZE",
) -> dict[str, Any] | None:
    """Signed KPI delta of the plan that was just published.

    ``None`` when the revision being compared has no plan yet: there is nothing to
    compare against, and the frozen KPI schema allows a null ``lastIntervention``.
    """
    if not previous_kpis:
        return None
    return {
        "kind": kind,
        "comparedToRevision": int(previous_kpis["scenarioRevision"]),
        "delta": {
            "distanceTotalMeters": round(
                float(current_kpis["distanceTotalMeters"])
                - float(previous_kpis["distanceTotalMeters"]),
                6,
            ),
            "plannedDurationSeconds": int(current_kpis["plannedDurationSeconds"])
            - int(previous_kpis["plannedDurationSeconds"]),
            "economicCostCents": int(current_kpis["economicCostCents"])
            - int(previous_kpis["economicCostCents"]),
            "ordersDelayed": int(current_kpis["ordersDelayed"])
            - int(previous_kpis["ordersDelayed"]),
            "ordersUnassigned": int(current_kpis["ordersUnassigned"])
            - int(previous_kpis["ordersUnassigned"]),
        },
    }
