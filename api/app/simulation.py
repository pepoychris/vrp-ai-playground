"""Deterministic Phase 6 simulation clock, claw snapping and movement samples.

Nothing in this module reads the wall clock. The simulation clock is a whole number of
bounded ticks, and a vehicle position is a pure function of the published route plan
plus that clock. A tick never carries a scenario revision, so advancing the clock can
never overwrite a newer revision: the revision only changes when a command mutates the
scenario, and a tick that was computed for an older revision is simply discarded by the
client.

Units stay explicit: the clock is seconds, positions are metres in the local Three.js
XZ plane, and headings are compass-style degrees (0 points to +z, 90 points to +x).
"""

from __future__ import annotations

from dataclasses import dataclass
from math import atan2, degrees, hypot
from typing import Any, Final

from .routing import travel_seconds

# One bounded simulation tick. The clock advances in whole ticks, so two clients that
# apply the same number of ticks always publish the same elapsed time and the same
# vehicle positions.
TICK_SECONDS: Final = 0.5
# Hard bound on a single clock advance: a backgrounded tab cannot jump the animation
# past the bounded window when it resumes.
MAX_TICKS_PER_ADVANCE: Final = 240

# Bounds for `simulation.speedMultiplier`, matching the frozen scenario schema.
MIN_SPEED_MULTIPLIER: Final = 0.25
MAX_SPEED_MULTIPLIER: Final = 8.0
DEFAULT_SPEED_MULTIPLIER: Final = 1.0

# Claw snap radius; mirrors `SNAP_NODE_MAX_RADIUS_M` in `frontend/src/city/dataset.ts`.
SNAP_NODE_MAX_RADIUS_M: Final = 12.0
EPSILON_M: Final = 1e-9


@dataclass(frozen=True, slots=True)
class NodeSnap:
    """Closest road node inside the claw radius."""

    node_id: str
    kind: str
    position: dict[str, float]
    distance_meters: float


@dataclass(frozen=True, slots=True)
class RouteLeg:
    """One driveable edge of a vehicle route, with its whole-second travel time."""

    edge_id: str
    from_node_id: str
    to_node_id: str
    length_meters: float
    seconds: int


@dataclass(frozen=True, slots=True)
class VehicleSample:
    """Where one vehicle is after a whole number of ticks."""

    vehicle_id: str
    node_id: str
    edge_id: str | None
    progress: float
    position: dict[str, float]
    heading_degrees: float
    travelled_seconds: float
    arrived: bool


def clamp_speed_multiplier(value: float) -> float:
    """Validate and round one simulation speed multiplier.

    The frozen schema allows any positive multiplier up to eight. Values outside the
    range are rejected instead of clamped, so a bad request never looks accepted.
    """
    multiplier = float(value)
    if multiplier <= 0 or multiplier > MAX_SPEED_MULTIPLIER:
        raise ValueError(
            f"speedMultiplier must be greater than 0 and at most {MAX_SPEED_MULTIPLIER:g}"
        )
    return round(multiplier, 3)


def simulation_state(
    *, running: bool, speed_multiplier: float = DEFAULT_SPEED_MULTIPLIER, tick: int = 0
) -> dict[str, Any]:
    """Build the frozen ``simulation`` block for one revision.

    ``elapsedSeconds`` is derived from ``tick``, so the two fields can never disagree.
    """
    bounded_tick = max(0, int(tick))
    return {
        "running": bool(running),
        "speedMultiplier": round(float(speed_multiplier), 3),
        "tick": bounded_tick,
        "elapsedSeconds": round(bounded_tick * TICK_SECONDS, 3),
    }


def bounded_tick_delta(real_seconds: float, speed_multiplier: float) -> int:
    """Whole ticks earned by ``real_seconds`` of real time at the current speed.

    The result is bounded by ``MAX_TICKS_PER_ADVANCE`` and never negative, so a stalled
    or resumed tab produces a bounded, deterministic step instead of a jump.
    """
    if real_seconds <= 0:
        return 0
    multiplier = float(speed_multiplier)
    if multiplier <= 0:
        return 0
    return min(MAX_TICKS_PER_ADVANCE, int(real_seconds * multiplier / TICK_SECONDS))


def advance_clock(simulation: dict[str, Any], ticks: int) -> dict[str, Any]:
    """Advance one simulation block by a bounded, non-negative number of ticks."""
    bounded_ticks = max(0, min(int(ticks), MAX_TICKS_PER_ADVANCE))
    return simulation_state(
        running=bool(simulation.get("running", False)),
        speed_multiplier=float(simulation.get("speedMultiplier", DEFAULT_SPEED_MULTIPLIER)),
        tick=int(simulation.get("tick", 0)) + bounded_ticks,
    )


def nearest_node(
    graph: dict[str, Any],
    point: dict[str, float],
    max_radius: float = SNAP_NODE_MAX_RADIUS_M,
) -> NodeSnap | None:
    """Closest road node inside ``max_radius``, or ``None`` outside it.

    An exact tie (within ``EPSILON_M``) always goes to the lexicographically smaller
    node id, so the same drop resolves to the same node on every run.
    """
    best: NodeSnap | None = None
    for node in graph["nodes"]:
        position = node["position"]
        distance = hypot(float(point["x"]) - position["x"], float(point["z"]) - position["z"])
        if distance > max_radius + EPSILON_M:
            continue
        if best is None or distance < best.distance_meters - EPSILON_M:
            best = NodeSnap(node["nodeId"], node["kind"], position, distance)
            continue
        is_tie = abs(distance - best.distance_meters) <= EPSILON_M
        if is_tie and node["nodeId"] < best.node_id:
            best = NodeSnap(node["nodeId"], node["kind"], position, distance)
    return best


def heading_degrees(from_position: dict[str, float], to_position: dict[str, float]) -> float:
    """Compass-style heading of a direction: 0 points to +z, 90 points to +x."""
    dx = to_position["x"] - from_position["x"]
    dz = to_position["z"] - from_position["z"]
    return (degrees(atan2(dx, dz)) + 360) % 360


def route_legs(
    graph: dict[str, Any],
    node_sequence: list[str],
    edge_sequence: list[str],
    vehicle_speed_kph: float | None = None,
) -> list[RouteLeg]:
    """Ordered, driveable legs of a published route.

    A sequence that is not connected stops there instead of inventing a shortcut, and a
    leg's travel time is ``ceil(length / min(road limit, vehicle speed))`` exactly like
    the Phase 5 planner, so the animation cannot outrun the plan it renders.
    """
    if not edge_sequence:
        return []
    nodes = {node["nodeId"]: node for node in graph["nodes"]}
    edges = {edge["edgeId"]: edge for edge in graph["edges"]}
    legs: list[RouteLeg] = []
    cursor = node_sequence[0] if node_sequence else None
    for edge_id in edge_sequence:
        edge = edges.get(edge_id)
        if edge is None or cursor is None:
            break
        if edge["fromNodeId"] == cursor:
            origin, destination = edge["fromNodeId"], edge["toNodeId"]
        elif edge["toNodeId"] == cursor:
            origin, destination = edge["toNodeId"], edge["fromNodeId"]
        else:
            break
        length = float(edge["lengthMeters"])
        legs.append(
            RouteLeg(
                edge_id=edge_id,
                from_node_id=origin,
                to_node_id=destination,
                length_meters=length,
                seconds=travel_seconds(length, float(edge["speedLimitKph"]), vehicle_speed_kph),
            )
        )
        cursor = destination
    return legs


def _sample_legs(
    graph: dict[str, Any],
    legs: list[RouteLeg],
    elapsed_seconds: float,
    start_node_id: str,
) -> VehicleSample:
    """Interpolate one position along the route at ``elapsed_seconds``.

    The sample is clamped to the end of the route: a route that has ended stays at its
    last stop instead of wrapping around.
    """
    positions = {node["nodeId"]: node["position"] for node in graph["nodes"]}
    start_position = positions[start_node_id]
    if not legs:
        return VehicleSample(
            vehicle_id="",
            node_id=start_node_id,
            edge_id=None,
            progress=0.0,
            position={"x": start_position["x"], "y": start_position["y"], "z": start_position["z"]},
            heading_degrees=0.0,
            travelled_seconds=0.0,
            arrived=True,
        )

    total = sum(leg.seconds for leg in legs)
    clamped = max(0.0, float(elapsed_seconds))
    remaining = clamped
    for index, leg in enumerate(legs):
        is_last = index == len(legs) - 1
        if remaining < leg.seconds or is_last:
            progress = 1.0 if leg.seconds <= 0 else min(1.0, max(0.0, remaining / leg.seconds))
            from_position = positions[leg.from_node_id]
            to_position = positions[leg.to_node_id]
            position = {
                "x": from_position["x"] + (to_position["x"] - from_position["x"]) * progress,
                "y": from_position["y"] + (to_position["y"] - from_position["y"]) * progress,
                "z": from_position["z"] + (to_position["z"] - from_position["z"]) * progress,
            }
            arrived = clamped >= total
            if arrived:
                progress = 1.0
                position = {
                    "x": to_position["x"],
                    "y": to_position["y"],
                    "z": to_position["z"],
                }
            return VehicleSample(
                vehicle_id="",
                # Mid-edge the vehicle still occupies the node it departed; once it has
                # arrived it occupies the node it reached.
                node_id=leg.to_node_id if arrived else leg.from_node_id,
                edge_id=None if arrived else leg.edge_id,
                progress=progress,
                position=position,
                heading_degrees=heading_degrees(from_position, to_position),
                travelled_seconds=min(clamped, float(total)),
                arrived=arrived,
            )
        remaining -= leg.seconds

    final_leg = legs[-1]
    final_position = positions[final_leg.to_node_id]
    return VehicleSample(
        vehicle_id="",
        node_id=final_leg.to_node_id,
        edge_id=None,
        progress=1.0,
        position={"x": final_position["x"], "y": final_position["y"], "z": final_position["z"]},
        heading_degrees=heading_degrees(positions[final_leg.from_node_id], final_position),
        travelled_seconds=float(total),
        arrived=True,
    )


def vehicle_samples(
    graph: dict[str, Any],
    route_plan: dict[str, Any] | None,
    vehicles: list[dict[str, Any]],
    elapsed_seconds: float,
) -> list[VehicleSample]:
    """Deterministic sample for every vehicle at ``elapsed_seconds``.

    A vehicle without a published route, or with a route without stops, stays on its
    current node. Samples are ordered by vehicle id so the result is stable.
    """
    routes = {
        route["vehicleId"]: route
        for route in (route_plan or {}).get("vehicles", [])
    }
    samples: list[VehicleSample] = []
    for vehicle in sorted(vehicles, key=lambda item: item["vehicleId"]):
        vehicle_id = vehicle["vehicleId"]
        route = routes.get(vehicle_id)
        start_node = vehicle.get("currentNodeId") or ""
        speed = float(vehicle.get("speedKilometersPerHour", 0)) or None
        legs = (
            route_legs(
                graph,
                route.get("nodeSequence", []),
                route.get("edgeSequence", []),
                speed,
            )
            if route and route.get("stops")
            else []
        )
        sample = _sample_legs(
            graph,
            legs,
            elapsed_seconds,
            start_node,
        )
        samples.append(
            VehicleSample(
                vehicle_id=vehicle_id,
                node_id=sample.node_id,
                edge_id=sample.edge_id,
                progress=sample.progress,
                position=sample.position,
                heading_degrees=sample.heading_degrees,
                travelled_seconds=sample.travelled_seconds,
                arrived=sample.arrived,
            )
        )
    return samples
