"""Ida y vuelta mundo/grafo y geometria XZ (reglas de world-graph-rules.md)."""

from __future__ import annotations

import unittest

from spike.fase0.world.coords import (
    EPSILON_M,
    SNAP_EDGE_MAX_RADIUS_M,
    SNAP_NODE_MAX_RADIUS_M,
    GraphPoint,
    distance_xz,
    graph_to_world,
    point_from_mapping,
    point_to_mapping,
    project_onto_segment_xz,
    travel_seconds,
    world_to_graph,
)


class CoordinateConversionTests(unittest.TestCase):
    def test_graph_to_world_does_not_swap_axes(self) -> None:
        point = GraphPoint(x=3.0, z=7.0, y=2.0)
        self.assertEqual(graph_to_world(point), (3.0, 2.0, 7.0))

    def test_world_to_graph_does_not_swap_axes(self) -> None:
        point = world_to_graph(3.0, 2.0, 7.0)
        self.assertEqual((point.x, point.y, point.z), (3.0, 2.0, 7.0))

    def test_round_trip_graph_world_graph(self) -> None:
        samples = [
            GraphPoint(x=0.0, z=0.0),
            GraphPoint(x=240.0, z=-120.5),
            GraphPoint(x=-33.25, z=18.75, y=0.0),
            GraphPoint(x=1234.5, z=987.25),
        ]
        for sample in samples:
            x, y, z = graph_to_world(sample)
            restored = world_to_graph(x, y, z)
            self.assertLessEqual(abs(restored.x - sample.x), EPSILON_M)
            self.assertLessEqual(abs(restored.y - sample.y), EPSILON_M)
            self.assertLessEqual(abs(restored.z - sample.z), EPSILON_M)

    def test_round_trip_world_graph_world(self) -> None:
        for world in [(1.5, 2.5, -3.5), (0.0, 0.0, 0.0), (-999.125, 0.0, 42.0)]:
            point = world_to_graph(*world)
            self.assertEqual(graph_to_world(point), world)

    def test_mapping_round_trip(self) -> None:
        payload = {"x": 120, "y": 0, "z": 240}
        self.assertEqual(point_to_mapping(point_from_mapping(payload)), payload)

    def test_distance_xz_ignores_elevation(self) -> None:
        flat = GraphPoint(x=0.0, z=0.0)
        same_plan_different_y = GraphPoint(x=3.0, z=4.0, y=99.0)
        self.assertAlmostEqual(distance_xz(flat, same_plan_different_y), 5.0, places=9)

    def test_snap_radii_match_the_documented_values(self) -> None:
        self.assertEqual(SNAP_NODE_MAX_RADIUS_M, 12.0)
        self.assertEqual(SNAP_EDGE_MAX_RADIUS_M, 12.0)


class SegmentProjectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.start = GraphPoint(x=0.0, z=0.0)
        self.end = GraphPoint(x=0.0, z=240.0)

    def test_midpoint_projection(self) -> None:
        projection = project_onto_segment_xz(GraphPoint(x=10.0, z=120.0), self.start, self.end)
        self.assertAlmostEqual(projection.t, 0.5, places=9)
        self.assertAlmostEqual(projection.point.z, 120.0, places=9)
        self.assertAlmostEqual(projection.distance_meters, 10.0, places=9)

    def test_projection_clamps_before_start(self) -> None:
        projection = project_onto_segment_xz(GraphPoint(x=0.0, z=-50.0), self.start, self.end)
        self.assertAlmostEqual(projection.t, 0.0, places=9)
        self.assertAlmostEqual(projection.point.z, 0.0, places=9)
        self.assertAlmostEqual(projection.distance_meters, 50.0, places=9)

    def test_projection_clamps_after_end(self) -> None:
        projection = project_onto_segment_xz(GraphPoint(x=0.0, z=300.0), self.start, self.end)
        self.assertAlmostEqual(projection.t, 1.0, places=9)
        self.assertAlmostEqual(projection.point.z, 240.0, places=9)
        self.assertAlmostEqual(projection.distance_meters, 60.0, places=9)

    def test_degenerate_segment_returns_start(self) -> None:
        degenerate = GraphPoint(x=0.0, z=0.0)
        projection = project_onto_segment_xz(GraphPoint(x=3.0, z=4.0), degenerate, degenerate)
        self.assertAlmostEqual(projection.t, 0.0, places=9)
        self.assertAlmostEqual(projection.distance_meters, 5.0, places=9)

    def test_projection_interpolates_elevation(self) -> None:
        start = GraphPoint(x=0.0, z=0.0, y=0.0)
        end = GraphPoint(x=0.0, z=100.0, y=10.0)
        projection = project_onto_segment_xz(GraphPoint(x=0.0, z=50.0), start, end)
        self.assertAlmostEqual(projection.point.y, 5.0, places=9)


class TravelTimeTests(unittest.TestCase):
    def test_travel_seconds_matches_the_golden_example(self) -> None:
        # 840 m a 36 km/h son 84 s; es el driveSeconds del ejemplo dorado.
        self.assertAlmostEqual(travel_seconds(840.0, 36.0), 84.0, places=6)

    def test_travel_seconds_rejects_zero_speed(self) -> None:
        with self.assertRaises(ValueError):
            travel_seconds(100.0, 0.0)
