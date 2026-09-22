"""Coordenadas mundo Three.js <-> grafo local.

Especificacion: `docs/contracts/world-graph-rules.md`.

- El mundo es local, plano XZ, Y hacia arriba, en metros.
- La conversion no intercambia ejes ni escala.
- Las distancias logicas se miden en XZ.
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
    """Punto en coordenadas del grafo: x/z sobre el suelo, y es la cota."""

    x: float
    z: float
    y: float = 0.0

    def as_world(self) -> tuple[float, float, float]:
        return graph_to_world(self)


@dataclass(frozen=True)
class SegmentProjection:
    """Proyeccion de un punto sobre un segmento en el plano XZ."""

    point: GraphPoint
    t: float
    distance_meters: float


def graph_to_world(point: GraphPoint) -> tuple[float, float, float]:
    """Devuelve la tupla (x, y, z) que Three.js espera para `Vector3`."""
    return (point.x, point.y, point.z)


def world_to_graph(x: float, y: float, z: float) -> GraphPoint:
    """Convierte un punto de mundo Three.js en punto de grafo."""
    return GraphPoint(x=x, y=y, z=z)


def point_from_mapping(payload: Mapping[str, float]) -> GraphPoint:
    """Construye un `GraphPoint` desde un objeto `{x, y, z}` del contrato."""
    return GraphPoint(x=float(payload["x"]), y=float(payload["y"]), z=float(payload["z"]))


def point_to_mapping(point: GraphPoint) -> dict[str, float]:
    """Serializa un `GraphPoint` al formato `{x, y, z}` del contrato."""
    return {"x": point.x, "y": point.y, "z": point.z}


def distance_xz(a: GraphPoint, b: GraphPoint) -> float:
    """Distancia en el plano XZ, en metros. Ignora la cota `y`."""
    return hypot(a.x - b.x, a.z - b.z)


def project_onto_segment_xz(point: GraphPoint, start: GraphPoint, end: GraphPoint) -> SegmentProjection:
    """Proyecta `point` sobre el segmento `start`-`end` con `t` acotado a [0, 1]."""
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
    """Tiempo de conduccion en segundos a partir de metros y km/h."""
    if speed_kph <= 0:
        raise ValueError("speed_kph debe ser estrictamente positivo")
    return distance_meters / (speed_kph / 3.6)
