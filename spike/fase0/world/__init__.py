"""Reference implementation of the Phase 0 world/graph rules.

It is technical spike material, not production code: Phase 3 and Phase 5 reimplement
these functions inside the backend. The normative specification lives in
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
