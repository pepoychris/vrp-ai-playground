"""Snap, bloqueo de aristas y caminos minimos sobre el ejemplo dorado del contrato."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from spike.fase0.world.coords import GraphPoint
from spike.fase0.world.graph import RoadGraph

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_SCENARIO = REPO_ROOT / "docs" / "contracts" / "examples" / "scenario-revision.example.json"


def load_golden_scenario() -> dict:
    with GOLDEN_SCENARIO.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class RoadGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scenario = load_golden_scenario()
        self.graph = RoadGraph.from_scenario(self.scenario)
        self.blocked = RoadGraph.blocked_edge_ids(self.scenario["barriers"])

    def test_loads_the_contract_example(self) -> None:
        self.assertEqual(len(self.graph.nodes), 7)
        self.assertEqual(len(self.graph.edges), 8)
        self.assertEqual(self.graph.depot_node_id(), "N-001")
        self.assertEqual(self.graph.delivery_node_ids(), ("N-006", "N-007"))

    def test_blocked_edges_match_the_scenario_field(self) -> None:
        self.assertEqual(self.blocked, frozenset(self.scenario["blockedEdgeIds"]))

    def test_nearest_node_snaps_to_the_closest_node(self) -> None:
        snap = self.graph.nearest_node(GraphPoint(x=355.0, z=5.0))
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual(snap.identifier, "N-007")
        self.assertAlmostEqual(snap.distance_meters, 50**0.5, places=6)

    def test_nearest_node_out_of_radius_returns_none(self) -> None:
        self.assertIsNone(self.graph.nearest_node(GraphPoint(x=600.0, z=600.0)))

    def test_nearest_node_tie_break_is_deterministic(self) -> None:
        from spike.fase0.world.graph import RoadNode

        twin = RoadGraph(
            nodes={
                "N-002": RoadNode(node_id="N-002", kind="JUNCTION", position=GraphPoint(10.0, 0.0)),
                "N-001": RoadNode(node_id="N-001", kind="JUNCTION", position=GraphPoint(-10.0, 0.0)),
            },
            edges={},
        )
        snap = twin.nearest_node(GraphPoint(x=0.0, z=0.0))
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual(snap.identifier, "N-001")

    def test_nearest_edge_projects_on_the_segment(self) -> None:
        snap = self.graph.nearest_edge(GraphPoint(x=300.0, z=5.0))
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual(snap.identifier, "E-N002-N007")
        self.assertAlmostEqual(snap.t or 0.0, 0.5, places=6)
        self.assertAlmostEqual(snap.distance_meters, 5.0, places=6)

    def test_nearest_edge_excludes_blocked_candidates(self) -> None:
        # Empate a 60 m entre tres aristas: gana el edgeId lexicograficamente menor.
        snap = self.graph.nearest_edge(
            GraphPoint(x=300.0, z=0.0), max_radius=100.0, excluded_edge_ids=self.blocked
        )
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertNotIn(snap.identifier, self.blocked)
        self.assertEqual(snap.identifier, "E-N001-N002")

        # Sin empate: el candidato mas cercano no bloqueado es el que gana.
        closest = self.graph.nearest_edge(
            GraphPoint(x=310.0, z=0.0), max_radius=100.0, excluded_edge_ids=self.blocked
        )
        self.assertIsNotNone(closest)
        assert closest is not None
        self.assertEqual(closest.identifier, "E-N006-N007")
        self.assertAlmostEqual(closest.distance_meters, 50.0, places=6)

    def test_nearest_edge_out_of_radius_returns_none(self) -> None:
        self.assertIsNone(self.graph.nearest_edge(GraphPoint(x=300.0, z=200.0)))

    def test_shortest_path_without_blocking_uses_the_direct_edge(self) -> None:
        path = self.graph.shortest_path("N-001", "N-007")
        self.assertIsNotNone(path)
        assert path is not None
        self.assertEqual(path.node_ids, ("N-001", "N-002", "N-007"))
        self.assertEqual(path.edge_ids, ("E-N001-N002", "E-N002-N007"))
        self.assertAlmostEqual(path.distance_meters, 360.0, places=6)

    def test_blocking_forces_the_detour_and_matches_the_golden_route(self) -> None:
        path = self.graph.shortest_path("N-001", "N-007", self.blocked)
        self.assertIsNotNone(path)
        assert path is not None
        self.assertEqual(path.node_ids, ("N-001", "N-002", "N-005", "N-006", "N-007"))
        self.assertAlmostEqual(
            path.distance_meters,
            self.scenario["routePlan"]["vehicles"][0]["distanceMeters"],
            places=6,
        )

    def test_blocking_applies_to_both_directions(self) -> None:
        forward = self.graph.shortest_path("N-001", "N-007", self.blocked)
        backward = self.graph.shortest_path("N-007", "N-001", self.blocked)
        self.assertIsNotNone(forward)
        self.assertIsNotNone(backward)
        assert forward is not None and backward is not None
        self.assertAlmostEqual(forward.distance_meters, backward.distance_meters, places=6)
        self.assertNotIn("E-N002-N007", backward.edge_ids)

    def test_removing_the_block_restores_the_short_path(self) -> None:
        restored = self.graph.shortest_path("N-001", "N-007", frozenset())
        self.assertIsNotNone(restored)
        assert restored is not None
        self.assertIn("E-N002-N007", restored.edge_ids)
        self.assertLess(restored.distance_meters, 840.0)

    def test_isolated_node_has_no_path(self) -> None:
        blocked = frozenset({"E-N001-N003", "E-N003-N004"})
        self.assertIsNone(self.graph.shortest_path("N-001", "N-003", blocked))
        self.assertNotIn("N-003", self.graph.reachable_node_ids("N-001", blocked))

    def test_delivery_nodes_are_reachable_from_the_depot_in_the_golden_scenario(self) -> None:
        reachable = self.graph.reachable_node_ids("N-001", self.blocked)
        for node_id in self.graph.delivery_node_ids():
            self.assertIn(node_id, reachable)

    def test_distance_matrix_reports_unreachable_as_none(self) -> None:
        blocked = frozenset({"E-N001-N003", "E-N003-N004"})
        matrix = self.graph.distance_matrix(
            ["N-001"], ["N-003", "N-007"], blocked
        )
        self.assertIsNone(matrix[("N-001", "N-003")])
        self.assertAlmostEqual(matrix[("N-001", "N-007")] or 0.0, 360.0, places=6)

        blocked_matrix = self.graph.distance_matrix(["N-001"], ["N-007"], self.blocked)
        self.assertAlmostEqual(blocked_matrix[("N-001", "N-007")] or 0.0, 840.0, places=6)

    def test_shortest_path_is_zero_for_the_same_node(self) -> None:
        matrix = self.graph.distance_matrix(["N-001"], ["N-001"], self.blocked)
        self.assertEqual(matrix[("N-001", "N-001")], 0.0)


if __name__ == "__main__":
    unittest.main()
