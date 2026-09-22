"""Seeded scenario generation, command handling and revision publication.

Phase 4 added the seeded generator; Phase 5 adds the bounded optimisation command and
the route/KPI revision it publishes. The store deliberately keeps the scenario in
memory: starting the service still has no business side effects, while reset can
remove the current scenario atomically.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Final, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .routing import (
    DEFAULT_TIME_LIMIT_SECONDS,
    MAX_TIME_LIMIT_SECONDS,
    MIN_TIME_LIMIT_SECONDS,
    depot_node_id,
    optimize_snapshot,
)

MIN_VEHICLES: Final = 1
MAX_VEHICLES: Final = 6
MIN_ORDERS: Final = 6
MAX_ORDERS: Final = 24
DEFAULT_SEED: Final = 20260922
MAX_SEED: Final = 2**32 - 1

VehicleStatus = Literal["AVAILABLE", "EN_ROUTE", "DELAYED", "BLOCKED", "FINISHED"]
OrderStatus = Literal["PENDING", "ASSIGNED", "DELIVERED", "DELAYED", "UNASSIGNED"]
Priority = Literal["LOW", "NORMAL", "URGENT"]


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


class OptimizeRequest(BaseModel):
    """Frozen command envelope plus the bounded search limit.

    ``commandId`` and ``scenarioRevision`` are optional so the reduced body used by
    the Phase 4 controls keeps working. When they are present the frozen semantics
    apply: repeating a ``commandId`` never mutates the scenario twice, and a client
    revision that no longer matches is reported as ``rebased`` instead of rejected.
    """

    model_config = ConfigDict(extra="forbid")

    commandId: str | None = None
    scenarioRevision: int | None = Field(default=None, ge=0)
    timeLimitSeconds: int = Field(
        default=DEFAULT_TIME_LIMIT_SECONDS, ge=MIN_TIME_LIMIT_SECONDS, le=MAX_TIME_LIMIT_SECONDS
    )

    @field_validator("commandId")
    @classmethod
    def _validate_command_id(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            parsed = UUID(value)
        except ValueError as exc:
            raise ValueError("commandId must be a UUID v4") from exc
        if parsed.version != 4:
            raise ValueError("commandId must be a UUID v4")
        return value


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
            "simulation": {"running": False, "speedMultiplier": 1, "tick": 0, "elapsedSeconds": 0},
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


@dataclass(slots=True)
class ScenarioStore:
    scenarios: dict[str, dict[str, Any]]
    command_results: dict[str, dict[str, Any]]

    def __init__(self) -> None:
        self.scenarios = {}
        # Frozen contract semantics: repeating a commandId returns the stored result
        # instead of mutating the scenario again. The window is the scenario lifetime.
        self.command_results = {}

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
        if command_id is not None:
            stored = self.command_results.get(f"{scenario_id}:{command_id}")
            if stored is not None:
                replayed = deepcopy(stored)
                applied = dict(replayed.get("appliedCommand") or {})
                applied["replayed"] = True
                replayed["appliedCommand"] = applied
                return replayed
        if not snapshot["vehicles"]:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="NO_FLEET_DEPLOYED")
        if not snapshot["orders"]:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="NO_ORDERS_AVAILABLE")

        working = deepcopy(snapshot)
        working["status"] = "OPTIMIZING"
        route_plan, kpis = optimize_snapshot(working, time_limit_seconds)
        _mutate(working, "OPTIMIZE", command_id=command_id, client_revision=client_revision)
        route_plan["scenarioRevision"] = working["scenarioRevision"]
        route_plan["generatedAt"] = working["emittedAt"]
        kpis["scenarioRevision"] = working["scenarioRevision"]
        kpis["computedAt"] = working["emittedAt"]
        kpis["lastIntervention"] = _intervention_impact(snapshot.get("kpis"), kpis)
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
            route = next(route for route in route_plan["vehicles"] if route["vehicleId"] == vehicle["vehicleId"])
            vehicle["assignedOrderIds"] = [stop["orderId"] for stop in route["stops"]]
            vehicle["status"] = "EN_ROUTE" if route["stops"] else "AVAILABLE"
        self.scenarios[scenario_id] = working
        if command_id is not None:
            self.command_results[f"{scenario_id}:{command_id}"] = deepcopy(working)
        return working

    def reset(self, scenario_id: str) -> ScenarioResetResponse:
        snapshot = self.get(scenario_id)
        self.scenarios.pop(scenario_id, None)
        for key in [key for key in self.command_results if key.startswith(f"{scenario_id}:")]:
            self.command_results.pop(key, None)
        return ScenarioResetResponse(scenarioId=scenario_id, status="RESET", scenarioRevision=snapshot["scenarioRevision"] + 1)


def _intervention_impact(
    previous_kpis: dict[str, Any] | None, current_kpis: dict[str, Any]
) -> dict[str, Any] | None:
    """Signed KPI delta of the plan that was just published.

    ``None`` when the revision being compared has no plan yet: there is nothing to
    compare against, and the frozen KPI schema allows a null ``lastIntervention``.
    """
    if not previous_kpis:
        return None
    return {
        "kind": "OPTIMIZE",
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
