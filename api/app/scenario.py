"""Phase 4 scenario generation and validation.

This module owns the seeded generator used by the API.  It deliberately keeps the
scenario store in memory for this phase: starting the service still has no business
side effects, while reset can remove the current scenario atomically.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Final, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

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
    """The Phase 0 contract graph: every delivery node is reachable from N-001."""
    nodes = [
        {"nodeId": "N-001", "kind": "DEPOT", "position": {"x": 0, "y": 0, "z": 0}, "label": "Central depot"},
        {"nodeId": "N-002", "kind": "JUNCTION", "position": {"x": 240, "y": 0, "z": 0}},
        {"nodeId": "N-003", "kind": "JUNCTION", "position": {"x": 0, "y": 0, "z": 120}},
        {"nodeId": "N-004", "kind": "JUNCTION", "position": {"x": 0, "y": 0, "z": 240}},
        {"nodeId": "N-005", "kind": "JUNCTION", "position": {"x": 240, "y": 0, "z": 240}},
        {"nodeId": "N-006", "kind": "DELIVERY", "position": {"x": 360, "y": 0, "z": 240}, "label": "North dock"},
        {"nodeId": "N-007", "kind": "DELIVERY", "position": {"x": 360, "y": 0, "z": 0}, "label": "South dock"},
    ]
    pairs = [("N-001", "N-002", 240), ("N-001", "N-003", 120), ("N-002", "N-005", 240),
             ("N-002", "N-007", 120), ("N-003", "N-004", 120), ("N-004", "N-005", 240),
             ("N-005", "N-006", 120), ("N-006", "N-007", 240)]
    edges = []
    positions = {node["nodeId"]: node["position"] for node in nodes}
    for first, second, length in pairs:
        edge_id = f"E-{first.replace('-', '')}-{second.replace('-', '')}"
        edges.append({"edgeId": edge_id, "fromNodeId": first, "toNodeId": second,
                      "bidirectional": True, "lengthMeters": length, "speedLimitKph": 40,
                      "visualSplineControlPoints": [positions[first], positions[second]]})
    return {"cityId": "robot-city", "graphVersion": 1, "nodes": nodes, "edges": edges}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _command(scenario_id: str, revision: int, kind: str) -> dict[str, Any]:
    command_id = str(uuid5(NAMESPACE_URL, f"{scenario_id}:{revision}:{kind}"))
    return {"commandId": command_id, "kind": kind, "appliedAgainstRevision": revision - 1,
            "rebased": False, "replayed": False}


def _base_snapshot(seed: int, scenario_id: str) -> dict[str, Any]:
    return {"scenarioId": scenario_id, "scenarioRevision": 1, "previousRevision": None,
            "status": "READY", "seed": seed, "graph": _graph(), "vehicles": [], "orders": [],
            "barriers": [], "blockedEdgeIds": [], "routePlan": None, "kpis": None,
            "simulation": {"running": False, "speedMultiplier": 1, "tick": 0, "elapsedSeconds": 0},
            "appliedCommand": None, "emittedAt": _utc_now()}


def _vehicle(vehicle_index: int, prng: SeededPrng) -> dict[str, Any]:
    capacity = float(prng.int_between(30, 60))
    volume = round(capacity / 20, 2)
    return {"vehicleId": f"R-{vehicle_index:02d}", "capacityKilograms": capacity,
            "capacityCubicMeters": volume, "loadKilograms": 0, "loadCubicMeters": 0,
            "batteryPercent": float(prng.int_between(70, 100)),
            "speedKilometersPerHour": float(prng.int_between(24, 42)),
            "costPerKilometerCents": prng.int_between(20, 80),
            "costPerMinuteCents": prng.int_between(10, 40),
            "fixedCostCents": prng.int_between(300, 700), "currentNodeId": "N-001",
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


def _mutate(snapshot: dict[str, Any], kind: str) -> None:
    previous = snapshot["scenarioRevision"]
    snapshot["scenarioRevision"] = previous + 1
    snapshot["previousRevision"] = previous
    snapshot["appliedCommand"] = _command(snapshot["scenarioId"], previous + 1, kind)
    snapshot["emittedAt"] = _utc_now()


@dataclass(slots=True)
class ScenarioStore:
    scenarios: dict[str, dict[str, Any]]

    def __init__(self) -> None:
        self.scenarios = {}

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
        snapshot["vehicles"] = [_vehicle(index, prng) for index in range(1, count + 1)]
        _mutate(snapshot, "FLEET_DEPLOYED")
        return snapshot

    def generate_orders(self, scenario_id: str, count: int) -> dict[str, Any]:
        snapshot = self.get(scenario_id)
        delivery_nodes = tuple(node["nodeId"] for node in snapshot["graph"]["nodes"] if node["kind"] == "DELIVERY")
        prng = SeededPrng(snapshot["seed"] ^ 0x0D3E)
        snapshot["orders"] = [_order(index, prng, delivery_nodes) for index in range(1, count + 1)]
        _mutate(snapshot, "ORDERS_FABRICATED")
        return snapshot

    def reset(self, scenario_id: str) -> ScenarioResetResponse:
        snapshot = self.get(scenario_id)
        self.scenarios.pop(scenario_id, None)
        return ScenarioResetResponse(scenarioId=scenario_id, status="RESET", scenarioRevision=snapshot["scenarioRevision"] + 1)
