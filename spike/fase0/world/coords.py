"""Three.js world <-> local graph coordinates.

Specification: `docs/contracts/world-graph-rules.md`.

- The world is local, flat on XZ, Y up, in meters.
- The conversion swaps no axes and applies no scale.
- Logical distances are measured on XZ.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Mapping

EPSILON_M = 1e-9
SNAP_NODE_MAX_RADIUS_M = 12.0
SNAP_EDGE_MAX_RADIUS_M = 12.0


@dataclass(frozen=True)
class GraphPoint:
    """Graph-space point: x/z on the ground, y is the elevation."""

    x: float
    z: float
    y: float = 0.0

    def as_world(self) -> tuple[float, float, float]:
        return graph_to_world(self)


@dataclass(frozen=True)
class SegmentProjection:
    """Projection of a point onto a segment in the XZ plane."""

    point: GraphPoint
    t: float
    distance_meters: float


def graph_to_world(point: GraphPoint) -> tuple[float, float, float]:
    """Return the (x, y, z) tuple Three.js expects for `Vector3`."""
    return (point.x, point.y, point.z)


def world_to_graph(x: float, y: float, z: float) -> GraphPoint:
    """Convert a Three.js world point into a graph point."""
    return GraphPoint(x=x, y=y, z=z)


def point_from_mapping(payload: Mapping[str, float]) -> GraphPoint:
    """Build a `GraphPoint` from a contract `{x, y, z}` object."""
    return GraphPoint(x=float(payload["x"]), y=float(payload["y"]), z=float(payload["z"]))


def point_to_mapping(point: GraphPoint) -> dict[str, float]:
    """Serialise a `GraphPoint` into the contract `{x, y, z}` shape."""
    return {"x": point.x, "y": point.y, "z": point.z}


def distance_xz(a: GraphPoint, b: GraphPoint) -> float:
    """Distance in the XZ plane, in meters. It ignores the elevation `y`."""
    return hypot(a.x - b.x, a.z - b.z)


def project_onto_segment_xz(point: GraphPoint, start: GraphPoint, end: GraphPoint) -> SegmentProjection:
    """Project `point` onto the `start`-`end` segment with `t` clamped to [0, 1]."""
    dx = end.x - start.x
    dz = end.z - start.z
    length_squared = dx * dx + dz * dz
    if length_squared <= EPSILON_M:
        projected = GraphPoint(x=start.x, y=start.y, z=start.z)
        return SegmentProjection(
            point=projected, t=0.0, distance_meters=distance_xz(point, projected)
        )
    t = ((point.x - start.x) * dx + (point.z - start.z) * dz) / length_squared
    t = min(1.0, max(0.0, t))
    projected = GraphPoint(
        x=start.x + t * dx,
        y=start.y + t * (end.y - start.y),
        z=start.z + t * dz,
    )
    return SegmentProjection(
        point=projected, t=t, distance_meters=distance_xz(point, projected)
    )


def travel_seconds(distance_meters: float, speed_kph: float) -> float:
    """Drive time in seconds from meters and km/h."""
    if speed_kph <= 0:
        raise ValueError("speed_kph must be strictly positive")
    return distance_meters / (speed_kph / 3.6)
