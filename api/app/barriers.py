"""Deterministic Phase 7 barrier placement and road-edge blocking.

A barrier is not decoration: it is bound to one stable road edge id and blocks that
edge in both directions, so the router, the distance matrices and the published plan
all treat the cut the same way. ``blockedEdgeIds`` stays the single source of truth and
is always derived from the active barriers, so a barrier and the set of blocked edges
can never disagree.

Units stay explicit: points are metres in the local Three.js XZ plane, distances are
metres and headings are compass-style degrees (0 points to +z, 90 points to +x), exactly
like the claw snap of Phase 6 that this module mirrors.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Any, Final, Iterable

from .simulation import EPSILON_M, heading_degrees

# Barrier snap radius; mirrors `SNAP_EDGE_MAX_RADIUS_M` in `frontend/src/city/dataset.ts`.
SNAP_EDGE_MAX_RADIUS_M: Final = 12.0
# Frozen MVP limit: three simultaneous active barriers.
MAX_BARRIERS: Final = 3


@dataclass(frozen=True, slots=True)
class EdgeSnap:
    """Closest road edge inside the barrier radius."""

    edge_id: str
    from_node_id: str
    to_node_id: str
    bidirectional: bool
    projected_point: dict[str, float]
    t: float
    distance_meters: float
    heading_degrees: float


def project_on_segment(
    point: dict[str, float], start: dict[str, float], end: dict[str, float]
) -> tuple[dict[str, float], float, float]:
    """Project ``point`` on the XZ segment ``start``-``end``, with ``t`` clamped.

    A degenerate segment (both endpoints on the same XZ point) resolves to ``t = 0``
    instead of dividing by zero.
    """
    dx = end["x"] - start["x"]
    dz = end["z"] - start["z"]
    length_squared = dx * dx + dz * dz
    if length_squared <= EPSILON_M:
        return (
            {"x": start["x"], "y": start["y"], "z": start["z"]},
            0.0,
            hypot(point["x"] - start["x"], point["z"] - start["z"]),
        )
    raw_t = ((point["x"] - start["x"]) * dx + (point["z"] - start["z"]) * dz) / length_squared
    t = min(1.0, max(0.0, raw_t))
    projected_point = {
        "x": start["x"] + t * dx,
        "y": start["y"] + t * (end["y"] - start["y"]),
        "z": start["z"] + t * dz,
    }
    distance = hypot(point["x"] - projected_point["x"], point["z"] - projected_point["z"])
    return projected_point, t, distance


def _edges(graph: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(graph["edges"], key=lambda edge: edge["edgeId"])


def _nodes(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {node["nodeId"]: node for node in graph["nodes"]}


def edge_snap(graph: dict[str, Any], edge_id: str) -> EdgeSnap | None:
    """Snap of an explicit edge id, at its midpoint, or ``None`` when it is unknown.

    The caller asked for the whole edge, not for a point on it, so the reported point is
    the edge midpoint and the distance is zero: the barrier really is on the road.
    """
    edge = next((item for item in graph["edges"] if item["edgeId"] == edge_id), None)
    if edge is None:
        return None
    nodes = _nodes(graph)
    start = nodes.get(edge["fromNodeId"])
    end = nodes.get(edge["toNodeId"])
    if start is None or end is None:
        return None
    start_position, end_position = start["position"], end["position"]
    midpoint = {
        "x": (start_position["x"] + end_position["x"]) / 2,
        "y": (start_position["y"] + end_position["y"]) / 2,
        "z": (start_position["z"] + end_position["z"]) / 2,
    }
    return EdgeSnap(
        edge_id=edge["edgeId"],
        from_node_id=edge["fromNodeId"],
        to_node_id=edge["toNodeId"],
        bidirectional=bool(edge.get("bidirectional", False)),
        projected_point=midpoint,
        t=0.5,
        distance_meters=0.0,
        heading_degrees=heading_degrees(start_position, end_position),
    )


def nearest_edge(
    graph: dict[str, Any],
    point: dict[str, float],
    max_radius: float = SNAP_EDGE_MAX_RADIUS_M,
    excluded_edge_ids: Iterable[str] = (),
) -> EdgeSnap | None:
    """Closest road edge inside ``max_radius``, or ``None`` outside it.

    Already blocked edges are excluded before the distance test, which is what stops a
    barrier from being placed twice on the same road. An exact tie (within ``EPSILON_M``)
    always goes to the lexicographically smaller edge id, so the same drop resolves to
    the same road on every run.
    """
    excluded = set(excluded_edge_ids)
    nodes = _nodes(graph)
    best: EdgeSnap | None = None
    for edge in _edges(graph):
        if edge["edgeId"] in excluded:
            continue
        start = nodes.get(edge["fromNodeId"])
        end = nodes.get(edge["toNodeId"])
        if start is None or end is None:
            continue
        projected_point, t, distance = project_on_segment(
            point, start["position"], end["position"]
        )
        if distance > max_radius + EPSILON_M:
            continue
        if best is None or distance < best.distance_meters - EPSILON_M:
            best = EdgeSnap(
                edge_id=edge["edgeId"],
                from_node_id=edge["fromNodeId"],
                to_node_id=edge["toNodeId"],
                bidirectional=bool(edge.get("bidirectional", False)),
                projected_point=projected_point,
                t=t,
                distance_meters=distance,
                heading_degrees=heading_degrees(start["position"], end["position"]),
            )
            continue
        is_tie = abs(distance - best.distance_meters) <= EPSILON_M
        if is_tie and edge["edgeId"] < best.edge_id:
            best = EdgeSnap(
                edge_id=edge["edgeId"],
                from_node_id=edge["fromNodeId"],
                to_node_id=edge["toNodeId"],
                bidirectional=bool(edge.get("bidirectional", False)),
                projected_point=projected_point,
                t=t,
                distance_meters=distance,
                heading_degrees=heading_degrees(start["position"], end["position"]),
            )
    return best


def blocked_edge_ids(barriers: Iterable[dict[str, Any]]) -> list[str]:
    """Derive ``blockedEdgeIds`` from the active barriers, in a stable order."""
    return sorted({barrier["blockedEdgeId"] for barrier in barriers})


def barrier_id_for(sequence: int) -> str:
    """Barrier id for one placement sequence number, e.g. ``B-2``.

    Ids are handed out in increasing order and never reused inside a scenario, so a
    removed barrier can never come back as a different road closure.
    """
    return f"B-{int(sequence)}"
