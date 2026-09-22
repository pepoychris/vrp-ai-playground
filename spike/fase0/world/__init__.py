"""Implementacion de referencia de las reglas mundo/grafo de la Fase 0.

Es material de prueba tecnica, no codigo de produccion: la Fase 3 y la Fase 5
reimplementan estas funciones dentro del backend. La especificacion normativa vive en
`docs/contracts/world-graph-rules.md`.
"""

from .coords import (
    EPSILON_M,
    SNAP_EDGE_MAX_RADIUS_M,
    SNAP_NODE_MAX_RADIUS_M,
    GraphPoint,
    SegmentProjection,
    distance_xz,
    graph_to_world,
    project_onto_segment_xz,
    travel_seconds,
    world_to_graph,
)
from .graph import (
    PathResult,
    RoadEdge,
    RoadGraph,
    RoadNode,
    SnapResult,
)

__all__ = [
    "EPSILON_M",
    "SNAP_EDGE_MAX_RADIUS_M",
    "SNAP_NODE_MAX_RADIUS_M",
    "GraphPoint",
    "SegmentProjection",
    "PathResult",
    "RoadEdge",
    "RoadGraph",
    "RoadNode",
    "SnapResult",
    "distance_xz",
    "graph_to_world",
    "project_onto_segment_xz",
    "travel_seconds",
    "world_to_graph",
]
