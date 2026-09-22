"""Grafo vial local: snap, bloqueo de aristas y caminos minimos.

Especificacion: `docs/contracts/world-graph-rules.md`.

Reglas que este modulo hace cumplir:

- `blockedEdgeIds` es la unica fuente de verdad del bloqueo y se aplica en ambos
  sentidos;
- el snap es determinista: gana la distancia minima y, en empate, el identificador
  lexicograficamente menor;
- un par de nodos sin camino devuelve `None`, nunca coste cero.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from .coords import (
    EPSILON_M,
    SNAP_EDGE_MAX_RADIUS_M,
    SNAP_NODE_MAX_RADIUS_M,
    GraphPoint,
    distance_xz,
    point_from_mapping,
    project_onto_segment_xz,
)


@dataclass(frozen=True)
class RoadNode:
    node_id: str
    kind: str
    position: GraphPoint


@dataclass(frozen=True)
class RoadEdge:
    edge_id: str
    from_node_id: str
    to_node_id: str
    length_meters: float
    speed_limit_kph: float
    bidirectional: bool = True


@dataclass(frozen=True)
class SnapResult:
    identifier: str
    position: GraphPoint
    distance_meters: float
    t: float | None = None


@dataclass(frozen=True)
class PathResult:
    node_ids: tuple[str, ...]
    edge_ids: tuple[str, ...]
    distance_meters: float


class RoadGraph:
    """Grafo inmutable con bloqueo dinamico de aristas."""

    def __init__(self, nodes: Mapping[str, RoadNode], edges: Mapping[str, RoadEdge]) -> None:
        self._nodes = dict(nodes)
        self._edges = dict(edges)
        self._adjacency: dict[str, list[tuple[str, str, float]]] = {
            node_id: [] for node_id in self._nodes
        }
        for edge in self._edges.values():
            self._adjacency[edge.from_node_id].append(
                (edge.edge_id, edge.to_node_id, edge.length_meters)
            )
            if edge.bidirectional:
                self._adjacency[edge.to_node_id].append(
                    (edge.edge_id, edge.from_node_id, edge.length_meters)
                )
        for node_id, neighbours in self._adjacency.items():
            neighbours.sort(key=lambda item: (item[2], item[0], item[1]))

    @classmethod
    def from_scenario(cls, scenario: Mapping[str, object]) -> "RoadGraph":
        graph = scenario["graph"]  # type: ignore[index]
        nodes = {
            node["nodeId"]: RoadNode(
                node_id=node["nodeId"],
                kind=node["kind"],
                position=point_from_mapping(node["position"]),
            )
            for node in graph["nodes"]  # type: ignore[index]
        }
        edges = {
            edge["edgeId"]: RoadEdge(
                edge_id=edge["edgeId"],
                from_node_id=edge["fromNodeId"],
                to_node_id=edge["toNodeId"],
                length_meters=edge["lengthMeters"],
                speed_limit_kph=edge["speedLimitKph"],
                bidirectional=edge["bidirectional"],
            )
            for edge in graph["edges"]  # type: ignore[index]
        }
        return cls(nodes, edges)

    @property
    def nodes(self) -> Mapping[str, RoadNode]:
        return self._nodes

    @property
    def edges(self) -> Mapping[str, RoadEdge]:
        return self._edges

    def depot_node_id(self) -> str:
        depots = [node_id for node_id, node in self._nodes.items() if node.kind == "DEPOT"]
        if len(depots) != 1:
            raise ValueError(f"se esperaba exactamente un DEPOT, hay {len(depots)}")
        return depots[0]

    def delivery_node_ids(self) -> tuple[str, ...]:
        return tuple(
            sorted(node_id for node_id, node in self._nodes.items() if node.kind == "DELIVERY")
        )

    @staticmethod
    def blocked_edge_ids(barriers: Iterable[Mapping[str, object]]) -> frozenset[str]:
        return frozenset(barrier["blockedEdgeId"] for barrier in barriers)  # type: ignore[index]

    def neighbours(
        self, node_id: str, blocked_edge_ids: frozenset[str] | set[str] = frozenset()
    ) -> list[tuple[str, str, float]]:
        return [
            entry
            for entry in self._adjacency.get(node_id, [])
            if entry[0] not in blocked_edge_ids
        ]

    def nearest_node(
        self, point: GraphPoint, max_radius: float = SNAP_NODE_MAX_RADIUS_M
    ) -> SnapResult | None:
        best: SnapResult | None = None
        for node_id in sorted(self._nodes):
            distance = distance_xz(point, self._nodes[node_id].position)
            if distance > max_radius + EPSILON_M:
                continue
            if best is None or distance < best.distance_meters - EPSILON_M:
                best = SnapResult(
                    identifier=node_id,
                    position=self._nodes[node_id].position,
                    distance_meters=distance,
                )
        return best

    def nearest_edge(
        self,
        point: GraphPoint,
        max_radius: float = SNAP_EDGE_MAX_RADIUS_M,
        excluded_edge_ids: frozenset[str] | set[str] = frozenset(),
    ) -> SnapResult | None:
        best: SnapResult | None = None
        for edge_id in sorted(self._edges):
            if edge_id in excluded_edge_ids:
                continue
            edge = self._edges[edge_id]
            projection = project_onto_segment_xz(
                point,
                self._nodes[edge.from_node_id].position,
                self._nodes[edge.to_node_id].position,
            )
            if projection.distance_meters > max_radius + EPSILON_M:
                continue
            if best is None or projection.distance_meters < best.distance_meters - EPSILON_M:
                best = SnapResult(
                    identifier=edge_id,
                    position=projection.point,
                    distance_meters=projection.distance_meters,
                    t=projection.t,
                )
        return best

    def shortest_path(
        self,
        start_node_id: str,
        goal_node_id: str,
        blocked_edge_ids: frozenset[str] | set[str] = frozenset(),
    ) -> PathResult | None:
        if start_node_id not in self._nodes or goal_node_id not in self._nodes:
            return None
        blocked = set(blocked_edge_ids)
        distances: dict[str, float] = {start_node_id: 0.0}
        previous: dict[str, tuple[str, str]] = {}
        settled: set[str] = set()
        queue: list[tuple[float, str]] = [(0.0, start_node_id)]
        while queue:
            distance, node_id = heapq.heappop(queue)
            if node_id in settled:
                continue
            settled.add(node_id)
            if node_id == goal_node_id:
                break
            for edge_id, neighbour, length in self.neighbours(node_id, blocked):
                candidate = distance + length
                current = distances.get(neighbour)
                best_previous = previous.get(neighbour)
                is_better = (
                    current is None
                    or candidate < current - EPSILON_M
                    or (
                        abs(candidate - current) <= EPSILON_M
                        and best_previous is not None
                        and edge_id < best_previous[1]
                    )
                )
                if is_better:
                    distances[neighbour] = candidate
                    previous[neighbour] = (node_id, edge_id)
                    heapq.heappush(queue, (candidate, neighbour))
        if goal_node_id not in distances:
            return None
        node_ids = [goal_node_id]
        edge_ids: list[str] = []
        cursor = goal_node_id
        while cursor != start_node_id:
            predecessor, edge_id = previous[cursor]
            edge_ids.append(edge_id)
            node_ids.append(predecessor)
            cursor = predecessor
        node_ids.reverse()
        edge_ids.reverse()
        return PathResult(
            node_ids=tuple(node_ids),
            edge_ids=tuple(edge_ids),
            distance_meters=distances[goal_node_id],
        )

    def reachable_node_ids(
        self, start_node_id: str, blocked_edge_ids: frozenset[str] | set[str] = frozenset()
    ) -> frozenset[str]:
        blocked = set(blocked_edge_ids)
        seen = {start_node_id}
        stack = [start_node_id]
        while stack:
            node_id = stack.pop()
            for _edge_id, neighbour, _length in self.neighbours(node_id, blocked):
                if neighbour not in seen:
                    seen.add(neighbour)
                    stack.append(neighbour)
        return frozenset(seen)

    def distance_matrix(
        self,
        sources: Sequence[str],
        targets: Sequence[str],
        blocked_edge_ids: frozenset[str] | set[str] = frozenset(),
    ) -> dict[tuple[str, str], float | None]:
        matrix: dict[tuple[str, str], float | None] = {}
        for source in sources:
            for target in targets:
                if source == target:
                    matrix[(source, target)] = 0.0
                    continue
                path = self.shortest_path(source, target, blocked_edge_ids)
                matrix[(source, target)] = None if path is None else path.distance_meters
        return matrix
