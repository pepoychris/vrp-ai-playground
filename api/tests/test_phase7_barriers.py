"""Phase 7 robotic barrier, road closure and before/after comparison tests.

The phase adds one intervention that must stay honest: a barrier is bound to a stable
road edge id, it blocks that road in both directions, and placing or removing it
recomputes the plan exactly once in the same revision. The tests below cover the pure
edge-snap primitives and the REST surface.
"""

from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest import mock

from api.app import routing
from api.app import scenario as scenario_module
from api.app.barriers import (
    MAX_BARRIERS,
    SNAP_EDGE_MAX_RADIUS_M,
    barrier_id_for,
    blocked_edge_ids,
    edge_snap,
    nearest_edge,
    project_on_segment,
)
from api.app.scenario import (
    BarrierPlaceRequest,
    BarrierRemoveRequest,
    ScenarioStore,
)
from api.tests.support import (
    REPO_ROOT,
    asgi_delete,
    asgi_get,
    asgi_post,
    build_app,
    offline_handler,
)

CITY_DATASET = REPO_ROOT / "frontend" / "src" / "city" / "robot-city.json"
SCHEMAS_DIR = REPO_ROOT / "docs" / "contracts" / "schemas"
EXAMPLES_DIR = REPO_ROOT / "docs" / "contracts" / "examples"

try:  # Documented dev dependency; the schema test is skipped when it is absent.
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    HAS_JSONSCHEMA = True
except ImportError:  # pragma: no cover - minimal test environments only
    HAS_JSONSCHEMA = False


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(schema_name: str) -> Any:
    common = _load_json(SCHEMAS_DIR / "common.schema.json")
    registry = Registry().with_resources(
        [
            (common["$id"], Resource.from_contents(common)),
            ("common.schema.json", Resource.from_contents(common)),
        ]
    )
    return Draft202012Validator(_load_json(SCHEMAS_DIR / schema_name), registry=registry)


def _fixture_graph() -> dict[str, Any]:
    """Two parallel roads four metres apart, plus a bridge to a dead end."""
    return {
        "cityId": "robot-city",
        "graphVersion": 1,
        "nodes": [
            {"nodeId": "N-001", "kind": "DEPOT", "position": {"x": 0, "y": 0, "z": 0}},
            {"nodeId": "N-002", "kind": "JUNCTION", "position": {"x": 100, "y": 0, "z": 0}},
            {"nodeId": "N-003", "kind": "DELIVERY", "position": {"x": 100, "y": 0, "z": 4}},
            {"nodeId": "N-004", "kind": "DELIVERY", "position": {"x": 0, "y": 0, "z": 4}},
        ],
        "edges": [
            {
                "edgeId": "E-N001-N002",
                "fromNodeId": "N-001",
                "toNodeId": "N-002",
                "bidirectional": True,
                "lengthMeters": 100,
                "speedLimitKph": 36,
            },
            {
                "edgeId": "E-N001-N004",
                "fromNodeId": "N-001",
                "toNodeId": "N-004",
                "bidirectional": True,
                "lengthMeters": 4,
                "speedLimitKph": 36,
            },
            {
                "edgeId": "E-N002-N003",
                "fromNodeId": "N-002",
                "toNodeId": "N-003",
                "bidirectional": True,
                "lengthMeters": 4,
                "speedLimitKph": 36,
            },
            {
                "edgeId": "E-N003-N004",
                "fromNodeId": "N-003",
                "toNodeId": "N-004",
                "bidirectional": True,
                "lengthMeters": 100,
                "speedLimitKph": 36,
            },
        ],
    }


def _corner_delivery(graph: dict[str, Any]) -> tuple[str, list[str]]:
    """A delivery node reachable only through two edges, and those two edges."""
    incident: dict[str, list[str]] = {node["nodeId"]: [] for node in graph["nodes"]}
    for edge in graph["edges"]:
        incident[edge["fromNodeId"]].append(edge["edgeId"])
        incident[edge["toNodeId"]].append(edge["edgeId"])
    for node in sorted(graph["nodes"], key=lambda item: item["nodeId"]):
        if node["kind"] != "DELIVERY":
            continue
        edges = sorted(incident[node["nodeId"]])
        if len(edges) == 2:
            return node["nodeId"], edges
    raise AssertionError("the city graph has no delivery node with exactly two edges")


def _fixture_order(order_id: str, node_id: str, **overrides: Any) -> dict[str, Any]:
    order = {
        "orderId": order_id,
        "deliveryNodeId": node_id,
        "weightKilograms": 5.0,
        "volumeCubicMeters": 0.2,
        "priority": "NORMAL",
        "timeWindow": {"startSeconds": 0, "endSeconds": 10_000},
        "serviceSeconds": 60,
        "status": "PENDING",
        "assignedVehicleId": None,
        "sequenceIndex": None,
    }
    order.update(overrides)
    return order


def _route_edges(snapshot: dict[str, Any]) -> list[str]:
    plan = snapshot.get("routePlan") or {"vehicles": []}
    return [edge for route in plan["vehicles"] for edge in route["edgeSequence"]]


class Phase7EdgeSnapTests(unittest.TestCase):
    """The barrier snaps to a road edge inside the contract radius, deterministically."""

    def test_radius_matches_the_rendered_city_constant(self) -> None:
        self.assertEqual(12.0, SNAP_EDGE_MAX_RADIUS_M)
        source = (REPO_ROOT / "frontend" / "src" / "city" / "dataset.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn(f"SNAP_EDGE_MAX_RADIUS_M = {SNAP_EDGE_MAX_RADIUS_M:g}", source)

    def test_projects_a_point_on_the_nearest_segment(self) -> None:
        projected, t, distance = project_on_segment(
            {"x": 30.0, "y": 0.0, "z": 3.0},
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 100.0, "y": 0.0, "z": 0.0},
        )
        self.assertAlmostEqual(30.0, projected["x"], places=9)
        self.assertAlmostEqual(0.0, projected["z"], places=9)
        self.assertAlmostEqual(0.3, t, places=9)
        self.assertAlmostEqual(3.0, distance, places=9)

    def test_a_degenerate_segment_does_not_divide_by_zero(self) -> None:
        projected, t, distance = project_on_segment(
            {"x": 4.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 0.0, "z": 0.0},
            {"x": 0.0, "y": 0.0, "z": 0.0},
        )
        self.assertEqual({"x": 0.0, "y": 0.0, "z": 0.0}, projected)
        self.assertEqual(0.0, t)
        self.assertAlmostEqual(4.0, distance, places=9)

    def test_snaps_to_the_nearest_edge_and_reports_the_projection(self) -> None:
        graph = _fixture_graph()
        snap = nearest_edge(graph, {"x": 40.0, "y": 0.0, "z": 1.0})
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual("E-N001-N002", snap.edge_id)
        self.assertTrue(snap.bidirectional)
        self.assertAlmostEqual(40.0, snap.projected_point["x"], places=9)
        self.assertAlmostEqual(1.0, snap.distance_meters, places=9)
        self.assertAlmostEqual(90.0, snap.heading_degrees, places=9)

    def test_rejects_a_drop_outside_the_radius(self) -> None:
        graph = _fixture_graph()
        self.assertIsNone(nearest_edge(graph, {"x": 50.0, "y": 0.0, "z": 40.0}))

    def test_excluded_edges_are_skipped_before_the_distance_test(self) -> None:
        graph = _fixture_graph()
        snap = nearest_edge(
            graph, {"x": 40.0, "y": 0.0, "z": 1.0}, excluded_edge_ids=["E-N001-N002"]
        )
        assert snap is not None
        self.assertNotEqual("E-N001-N002", snap.edge_id)

    def test_exact_tie_goes_to_the_lexicographically_smaller_edge(self) -> None:
        graph = {
            "cityId": "robot-city",
            "graphVersion": 1,
            "nodes": [
                {"nodeId": "N-001", "kind": "DEPOT", "position": {"x": 0, "y": 0, "z": -10}},
                {"nodeId": "N-002", "kind": "JUNCTION", "position": {"x": 10, "y": 0, "z": -10}},
                {"nodeId": "N-003", "kind": "JUNCTION", "position": {"x": 0, "y": 0, "z": 10}},
                {"nodeId": "N-004", "kind": "JUNCTION", "position": {"x": 10, "y": 0, "z": 10}},
            ],
            "edges": [
                {
                    "edgeId": "E-N001-N002",
                    "fromNodeId": "N-001",
                    "toNodeId": "N-002",
                    "bidirectional": True,
                    "lengthMeters": 10,
                    "speedLimitKph": 30,
                },
                {
                    "edgeId": "E-N003-N004",
                    "fromNodeId": "N-003",
                    "toNodeId": "N-004",
                    "bidirectional": True,
                    "lengthMeters": 10,
                    "speedLimitKph": 30,
                },
            ],
        }
        snap = nearest_edge(graph, {"x": 4.0, "y": 0.0, "z": 0.0})
        assert snap is not None
        self.assertEqual("E-N001-N002", snap.edge_id)
        self.assertAlmostEqual(10.0, snap.distance_meters, places=9)

    def test_an_explicit_edge_is_snapped_at_its_midpoint(self) -> None:
        snap = edge_snap(_fixture_graph(), "E-N001-N002")
        assert snap is not None
        self.assertEqual({"x": 50.0, "y": 0.0, "z": 0.0}, snap.projected_point)
        self.assertEqual(0.0, snap.distance_meters)
        self.assertEqual(0.5, snap.t)
        self.assertIsNone(edge_snap(_fixture_graph(), "E-N001-N999"))

    def test_blocked_edges_derive_from_the_active_barriers(self) -> None:
        barriers = [
            {"barrierId": "B-2", "blockedEdgeId": "E-N003-N004"},
            {"barrierId": "B-1", "blockedEdgeId": "E-N001-N002"},
            {"barrierId": "B-3", "blockedEdgeId": "E-N001-N002"},
        ]
        self.assertEqual(
            ["E-N001-N002", "E-N003-N004"], blocked_edge_ids(barriers)
        )
        self.assertEqual([], blocked_edge_ids([]))

    def test_barrier_ids_are_issued_in_order_and_never_reused(self) -> None:
        self.assertEqual("B-1", barrier_id_for(1))
        self.assertEqual("B-3", barrier_id_for(MAX_BARRIERS))
        self.assertEqual("B-4", barrier_id_for(MAX_BARRIERS + 1))
        self.assertEqual(3, MAX_BARRIERS)


class Phase7RequestModelTests(unittest.TestCase):
    """The frozen command envelope plus the two barrier targets."""

    def test_a_barrier_needs_a_position_or_an_edge_id(self) -> None:
        self.assertIsNone(BarrierPlaceRequest(position={"x": 1, "z": 2}).edgeId)
        self.assertEqual("E-N001-N002", BarrierPlaceRequest(edgeId="E-N001-N002").edgeId)
        with self.assertRaises(ValueError):
            BarrierPlaceRequest()
        with self.assertRaises(ValueError):
            BarrierPlaceRequest(edgeId="N-001")
        with self.assertRaises(ValueError):
            BarrierPlaceRequest(position={"x": 1, "z": 2}, extra="field")

    def test_a_position_defaults_to_the_flat_city_plane(self) -> None:
        request = BarrierPlaceRequest(position={"x": 12.0, "z": -3.0})
        assert request.position is not None
        self.assertEqual(0.0, request.position.y)

    def test_the_removal_envelope_is_optional(self) -> None:
        self.assertIsNone(BarrierRemoveRequest().commandId)
        self.assertIsNone(BarrierRemoveRequest().scenarioRevision)


class Phase7PlacementTests(unittest.IsolatedAsyncioTestCase):
    """Placing a barrier blocks one road and recomputes the plan exactly once."""

    async def _scenario(
        self, vehicles: int = 2, orders: int = 8
    ) -> tuple[Any, str, dict[str, Any]]:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 11})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": vehicles}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": orders}
        )
        planned = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()
        return app, scenario_id, planned

    @staticmethod
    def _edge_point(snapshot: dict[str, Any], edge_id: str) -> dict[str, float]:
        """A world point one metre away from the midpoint of one road edge."""
        edge = next(item for item in snapshot["graph"]["edges"] if item["edgeId"] == edge_id)
        nodes = {node["nodeId"]: node for node in snapshot["graph"]["nodes"]}
        start = nodes[edge["fromNodeId"]]["position"]
        end = nodes[edge["toNodeId"]]["position"]
        return {
            "x": (start["x"] + end["x"]) / 2,
            "y": 0.0,
            "z": (start["z"] + end["z"]) / 2 + 1.0,
        }

    async def test_placing_a_barrier_blocks_the_edge_and_re_plans_once(self) -> None:
        app, scenario_id, planned = await self._scenario()
        edge = planned["graph"]["edges"][0]
        point = self._edge_point(planned, edge["edgeId"])
        path = f"/api/scenarios/{scenario_id}/barriers"

        with mock.patch.object(
            scenario_module, "optimize_snapshot", wraps=routing.optimize_snapshot
        ) as planner:
            response = await asgi_post(app, path, json={"position": point})

        self.assertEqual(200, response.status_code)
        closed = response.json()
        self.assertEqual(1, planner.call_count, "one barrier must plan exactly once")
        self.assertEqual(planned["scenarioRevision"] + 1, closed["scenarioRevision"])
        self.assertEqual("BARRIER_PLACED", closed["appliedCommand"]["kind"])
        self.assertEqual(
            planned["scenarioRevision"],
            closed["appliedCommand"]["appliedAgainstRevision"],
        )

        # The barrier carries a stable id and the road edge id it blocks, never a pixel.
        self.assertEqual(1, len(closed["barriers"]))
        barrier = closed["barriers"][0]
        self.assertEqual("B-1", barrier["barrierId"])
        self.assertEqual(edge["edgeId"], barrier["blockedEdgeId"])
        self.assertEqual(planned["scenarioRevision"], barrier["placedAtRevision"])
        self.assertEqual([edge["edgeId"]], closed["blockedEdgeIds"])
        # The frozen barrier example publishes the revision the placement was applied
        # against, which is exactly the previous revision of the closing snapshot.
        self.assertEqual(closed["previousRevision"], barrier["placedAtRevision"])
        # The frozen ``result`` of endpoint 9 is the barrier placement itself.
        self.assertEqual(barrier["position"], closed["result"]["projectedPoint"])
        self.assertEqual(barrier["barrierId"], closed["result"]["barrierId"])
        self.assertEqual(barrier["blockedEdgeId"], closed["result"]["blockedEdgeId"])
        self.assertTrue(closed["result"]["accepted"])
        self.assertIsNone(closed["result"]["rejectionCode"])

        # Nothing published may drive through a closed road, and the plan and KPIs belong
        # to the very same revision.
        self.assertNotIn(edge["edgeId"], _route_edges(closed))
        self.assertEqual(closed["scenarioRevision"], closed["routePlan"]["scenarioRevision"])
        self.assertEqual(closed["scenarioRevision"], closed["kpis"]["scenarioRevision"])
        impact = closed["kpis"]["lastIntervention"]
        self.assertEqual("BARRIER_PLACED", impact["kind"])
        self.assertEqual(planned["scenarioRevision"], impact["comparedToRevision"])
        self.assertEqual(
            {
                "distanceTotalMeters",
                "plannedDurationSeconds",
                "economicCostCents",
                "ordersDelayed",
                "ordersUnassigned",
            },
            set(impact["delta"]),
        )

    async def test_an_explicit_edge_id_places_the_barrier_on_that_road(self) -> None:
        app, scenario_id, planned = await self._scenario()
        edge_id = planned["graph"]["edges"][3]["edgeId"]
        closed = (
            await asgi_post(
                app, f"/api/scenarios/{scenario_id}/barriers", json={"edgeId": edge_id}
            )
        ).json()
        self.assertEqual([edge_id], closed["blockedEdgeIds"])
        self.assertEqual(0.0, closed["result"]["distanceMeters"])

    async def test_an_unknown_or_already_blocked_edge_is_rejected(self) -> None:
        app, scenario_id, planned = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/barriers"
        edge_id = planned["graph"]["edges"][0]["edgeId"]

        unknown = await asgi_post(app, path, json={"edgeId": "E-N001-N999"})
        self.assertEqual(422, unknown.status_code)
        self.assertEqual("SNAP_NO_VALID_EDGE", unknown.json()["detail"])

        await asgi_post(app, path, json={"edgeId": edge_id})
        again = await asgi_post(app, path, json={"edgeId": edge_id})
        self.assertEqual(422, again.status_code)
        self.assertEqual("SNAP_NO_VALID_EDGE", again.json()["detail"])

    async def test_a_drop_without_a_candidate_edge_is_rejected_without_a_revision(self) -> None:
        app, scenario_id, planned = await self._scenario()
        response = await asgi_post(
            app,
            f"/api/scenarios/{scenario_id}/barriers",
            json={"position": {"x": 24.0, "y": 0.0, "z": 24.0}},
        )
        self.assertEqual(422, response.status_code)
        self.assertEqual("SNAP_NO_VALID_EDGE", response.json()["detail"])
        unchanged = (await asgi_get(app, f"/api/scenarios/{scenario_id}")).json()
        self.assertEqual(planned["scenarioRevision"], unchanged["scenarioRevision"])
        self.assertEqual([], unchanged["barriers"])
        self.assertEqual([], unchanged["blockedEdgeIds"])

    async def test_the_fourth_barrier_is_a_conflict_and_consumes_no_revision(self) -> None:
        app, scenario_id, planned = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/barriers"
        edges = [edge["edgeId"] for edge in planned["graph"]["edges"][: MAX_BARRIERS + 1]]

        placed = [
            (await asgi_post(app, path, json={"edgeId": edge_id})).json()
            for edge_id in edges[:MAX_BARRIERS]
        ]
        self.assertEqual(["B-1", "B-2", "B-3"], [item["barriers"][-1]["barrierId"] for item in placed])
        self.assertEqual(MAX_BARRIERS, len(placed[-1]["barriers"]))
        revision_before = placed[-1]["scenarioRevision"]

        fourth = await asgi_post(app, path, json={"edgeId": edges[MAX_BARRIERS]})
        self.assertEqual(409, fourth.status_code)
        self.assertEqual("BARRIER_LIMIT_REACHED", fourth.json()["detail"])
        unchanged = (await asgi_get(app, f"/api/scenarios/{scenario_id}")).json()
        self.assertEqual(revision_before, unchanged["scenarioRevision"])

    async def test_a_barrier_before_the_fleet_only_advances_the_revision(self) -> None:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 5})).json()
        scenario_id = created["scenarioId"]
        edge_id = created["graph"]["edges"][0]["edgeId"]

        closed = (
            await asgi_post(
                app, f"/api/scenarios/{scenario_id}/barriers", json={"edgeId": edge_id}
            )
        ).json()

        self.assertEqual("BARRIER_PLACED", closed["appliedCommand"]["kind"])
        self.assertEqual([edge_id], closed["blockedEdgeIds"])
        self.assertIsNone(closed["routePlan"])
        self.assertIsNone(closed["kpis"])

        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": 2}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": 8}
        )
        planned = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()
        self.assertEqual([edge_id], planned["blockedEdgeIds"])
        self.assertNotIn(edge_id, _route_edges(planned))

    async def test_a_structural_barrier_resets_the_simulation_clock(self) -> None:
        app, scenario_id, planned = await self._scenario()
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/simulation/start", json={"speedMultiplier": 4}
        )
        app.state.scenario_store.advance_simulation(scenario_id, 10.0)

        closed = (
            await asgi_post(
                app,
                f"/api/scenarios/{scenario_id}/barriers",
                json={"edgeId": planned["graph"]["edges"][0]["edgeId"]},
            )
        ).json()

        self.assertFalse(closed["simulation"]["running"])
        self.assertEqual(0, closed["simulation"]["tick"])
        self.assertEqual(0, closed["simulation"]["elapsedSeconds"])
        self.assertEqual(4, closed["simulation"]["speedMultiplier"])
        self.assertEqual("READY", closed["status"])


class Phase7IsolationTests(unittest.IsolatedAsyncioTestCase):
    """A cut that isolates deliveries leaves those orders unassigned with a reason."""

    async def _isolated_scenario(self) -> tuple[Any, str, str, list[str]]:
        """A scenario with one order on a dead-end delivery node and one elsewhere."""
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 3})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": 2}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": 6}
        )
        graph = created["graph"]
        corner_node_id, corner_edges = _corner_delivery(graph)
        # The seeded generator is not guaranteed to place an order on the corner, so the
        # isolation is pinned with one order there and one on a well connected node.
        other_node_id = next(
            node["nodeId"]
            for node in sorted(graph["nodes"], key=lambda item: item["nodeId"])
            if node["kind"] == "DELIVERY" and node["nodeId"] != corner_node_id
        )
        store = app.state.scenario_store
        store.scenarios[scenario_id]["orders"] = [
            _fixture_order("O-001", corner_node_id),
            _fixture_order("O-002", other_node_id),
        ]
        return app, scenario_id, corner_node_id, corner_edges

    async def test_an_isolated_order_is_unassigned_and_the_cut_is_reversible(self) -> None:
        app, scenario_id, corner_node_id, corner_edges = await self._isolated_scenario()
        path = f"/api/scenarios/{scenario_id}/barriers"

        await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        first_cut = (await asgi_post(app, path, json={"edgeId": corner_edges[0]})).json()
        order = next(item for item in first_cut["orders"] if item["orderId"] == "O-001")
        self.assertEqual("ASSIGNED", order["status"])

        isolated = (await asgi_post(app, path, json={"edgeId": corner_edges[1]})).json()
        self.assertEqual(sorted(corner_edges), isolated["blockedEdgeIds"])
        self.assertEqual([], [edge for edge in _route_edges(isolated) if edge in corner_edges])

        order = next(item for item in isolated["orders"] if item["orderId"] == "O-001")
        self.assertEqual("UNASSIGNED", order["status"])
        self.assertIsNone(order["assignedVehicleId"])
        unassigned = {
            item["orderId"]: item["reason"] for item in isolated["routePlan"]["unassignedOrders"]
        }
        self.assertEqual("UNREACHABLE", unassigned.get("O-001"))
        self.assertEqual(1, isolated["kpis"]["ordersUnassigned"])
        impact = isolated["kpis"]["lastIntervention"]
        self.assertEqual("BARRIER_PLACED", impact["kind"])
        self.assertEqual(1, impact["delta"]["ordersUnassigned"])

        # Removing the second barrier restores the road and the order becomes deliverable.
        restored = (
            await asgi_delete(
                app, f"/api/scenarios/{scenario_id}/barriers/{isolated['barriers'][-1]['barrierId']}"
            )
        ).json()
        self.assertEqual([corner_edges[0]], restored["blockedEdgeIds"])
        self.assertEqual("BARRIER_REMOVED", restored["appliedCommand"]["kind"])
        self.assertEqual(
            isolated["scenarioRevision"], restored["kpis"]["lastIntervention"]["comparedToRevision"]
        )
        order = next(item for item in restored["orders"] if item["orderId"] == "O-001")
        self.assertEqual("ASSIGNED", order["status"])
        self.assertEqual(corner_node_id, next(
            stop["nodeId"]
            for route in restored["routePlan"]["vehicles"]
            for stop in route["stops"]
            if stop["orderId"] == "O-001"
        ))
        self.assertEqual(0, restored["kpis"]["ordersUnassigned"])

    async def test_removing_the_last_barrier_restores_the_unblocked_plan(self) -> None:
        app, scenario_id, _, corner_edges = await self._isolated_scenario()
        baseline = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()
        closed = (
            await asgi_post(
                app, f"/api/scenarios/{scenario_id}/barriers", json={"edgeId": corner_edges[0]}
            )
        ).json()
        barrier_id = closed["barriers"][0]["barrierId"]

        with mock.patch.object(
            scenario_module, "optimize_snapshot", wraps=routing.optimize_snapshot
        ) as planner:
            removed = await asgi_delete(
                app, f"/api/scenarios/{scenario_id}/barriers/{barrier_id}"
            )

        self.assertEqual(1, planner.call_count, "removing a barrier must plan exactly once")
        restored = removed.json()
        self.assertEqual([], restored["barriers"])
        self.assertEqual([], restored["blockedEdgeIds"])
        self.assertEqual(baseline["routePlan"]["vehicles"], restored["routePlan"]["vehicles"])
        self.assertEqual(baseline["kpis"]["distanceTotalMeters"], restored["kpis"]["distanceTotalMeters"])
        self.assertEqual("BARRIER_REMOVED", restored["appliedCommand"]["kind"])
        self.assertIsNone(restored["result"])

    async def test_an_unknown_barrier_is_not_found(self) -> None:
        app, scenario_id, _, _ = await self._isolated_scenario()
        response = await asgi_delete(app, f"/api/scenarios/{scenario_id}/barriers/B-9")
        self.assertEqual(404, response.status_code)
        self.assertEqual("BARRIER_NOT_FOUND", response.json()["detail"])


class Phase7CommandEnvelopeTests(unittest.IsolatedAsyncioTestCase):
    """Barrier commands share the frozen idempotent envelope of every other mutation."""

    async def _scenario(self) -> tuple[Any, str, dict[str, Any]]:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 21})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": 2}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": 8}
        )
        planned = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()
        return app, scenario_id, planned

    async def test_placing_the_same_command_twice_only_closes_one_road(self) -> None:
        app, scenario_id, planned = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/barriers"
        command = {
            "commandId": str(uuid.uuid4()),
            "scenarioRevision": planned["scenarioRevision"],
            "edgeId": planned["graph"]["edges"][0]["edgeId"],
        }
        first = (await asgi_post(app, path, json=command)).json()
        self.assertFalse(first["appliedCommand"]["replayed"])
        self.assertFalse(first["appliedCommand"]["rebased"])

        replay = (await asgi_post(app, path, json=command)).json()
        self.assertTrue(replay["appliedCommand"]["replayed"])
        self.assertEqual(first["scenarioRevision"], replay["scenarioRevision"])
        self.assertEqual(first["barriers"], replay["barriers"])
        self.assertEqual(first["kpis"], replay["kpis"])
        # A retried placement answers the same frozen `result` payload, so a client that
        # resends after a timeout learns the barrier id it already created.
        self.assertEqual(first["result"], replay["result"])
        self.assertEqual("B-1", replay["result"]["barrierId"])
        self.assertEqual(
            first["graph"]["edges"][0]["edgeId"], replay["result"]["blockedEdgeId"]
        )
        self.assertTrue(replay["result"]["accepted"])

        stale = (
            await asgi_post(
                app,
                path,
                json={
                    "commandId": str(uuid.uuid4()),
                    "scenarioRevision": 0,
                    "edgeId": planned["graph"]["edges"][1]["edgeId"],
                },
            )
        ).json()
        self.assertTrue(stale["appliedCommand"]["rebased"])
        self.assertEqual(
            first["scenarioRevision"], stale["appliedCommand"]["appliedAgainstRevision"]
        )

    async def test_removing_the_same_command_twice_replays_the_restored_revision(self) -> None:
        app, scenario_id, planned = await self._scenario()
        placed = (
            await asgi_post(
                app,
                f"/api/scenarios/{scenario_id}/barriers",
                json={"edgeId": planned["graph"]["edges"][0]["edgeId"]},
            )
        ).json()
        barrier_id = placed["barriers"][0]["barrierId"]
        path = f"/api/scenarios/{scenario_id}/barriers/{barrier_id}"
        command = {
            "commandId": str(uuid.uuid4()),
            "scenarioRevision": placed["scenarioRevision"],
        }

        first = (await asgi_delete(app, path, json=command)).json()
        self.assertFalse(first["appliedCommand"]["replayed"])
        replay = (await asgi_delete(app, path, json=command)).json()
        self.assertTrue(replay["appliedCommand"]["replayed"])
        self.assertEqual(first["scenarioRevision"], replay["scenarioRevision"])
        self.assertEqual([], replay["blockedEdgeIds"])

    async def test_a_rejected_barrier_does_not_consume_its_command_id(self) -> None:
        app, scenario_id, planned = await self._scenario()
        command_id = str(uuid.uuid4())
        path = f"/api/scenarios/{scenario_id}/barriers"

        rejected = await asgi_post(
            app, path, json={"commandId": command_id, "position": {"x": 24.0, "y": 0.0, "z": 24.0}}
        )
        self.assertEqual(422, rejected.status_code)
        accepted = (
            await asgi_post(
                app,
                path,
                json={
                    "commandId": command_id,
                    "edgeId": planned["graph"]["edges"][0]["edgeId"],
                },
            )
        ).json()
        self.assertFalse(accepted["appliedCommand"]["replayed"])
        self.assertEqual(1, len(accepted["barriers"]))

    async def test_the_store_keeps_barrier_ids_unique_across_a_removal(self) -> None:
        store = ScenarioStore()
        snapshot = store.create(4)
        scenario_id = snapshot["scenarioId"]
        edges = snapshot["graph"]["edges"]
        first = store.place_barrier(scenario_id, edge_id=edges[0]["edgeId"])[0]
        barrier_id = first["barriers"][0]["barrierId"]
        self.assertEqual("B-1", barrier_id)

        restored = store.remove_barrier(scenario_id, barrier_id)[0]
        self.assertEqual([], restored["barriers"])
        self.assertEqual([], restored["blockedEdgeIds"])

        second = store.place_barrier(scenario_id, edge_id=edges[1]["edgeId"])[0]
        self.assertEqual("B-2", second["barriers"][0]["barrierId"])
        self.assertNotEqual(barrier_id, second["barriers"][0]["barrierId"])


class Phase7ContractConformanceTests(unittest.TestCase):
    """The published barrier matches the frozen schema and the city dataset."""

    @unittest.skipUnless(HAS_JSONSCHEMA, "jsonschema is a documented dev dependency")
    def test_the_frozen_barrier_example_still_validates(self) -> None:
        _validator("barrier.schema.json").validate(
            _load_json(EXAMPLES_DIR / "barrier.example.json")
        )

    def test_the_city_graph_has_a_dead_end_delivery_node(self) -> None:
        store = ScenarioStore()
        snapshot = store.create(1)
        node_id, edges = _corner_delivery(snapshot["graph"])
        self.assertEqual(2, len(edges))
        self.assertTrue(node_id.startswith("N-"))

    def test_the_isolating_fixture_graph_answers_unreachable(self) -> None:
        graph = _fixture_graph()
        blocked = {"E-N001-N004", "E-N002-N003"}
        plan, kpis = routing.optimize_snapshot(
            {
                "scenarioId": "00000000-0000-4000-8000-000000000002",
                "scenarioRevision": 2,
                "previousRevision": 1,
                "status": "READY",
                "seed": 1,
                "graph": graph,
                "vehicles": [
                    {
                        "vehicleId": "R-01",
                        "capacityKilograms": 100.0,
                        "capacityCubicMeters": 100.0,
                        "loadKilograms": 0,
                        "loadCubicMeters": 0,
                        "speedKilometersPerHour": 36.0,
                        "costPerKilometerCents": 50,
                        "costPerMinuteCents": 20,
                        "fixedCostCents": 500,
                        "currentNodeId": "N-001",
                        "status": "AVAILABLE",
                        "assignedOrderIds": [],
                    }
                ],
                "orders": [_fixture_order("O-001", "N-004")],
                "barriers": [
                    {"barrierId": "B-1", "blockedEdgeId": "E-N002-N003", "position": {}, "placedAtRevision": 1},
                    {"barrierId": "B-2", "blockedEdgeId": "E-N001-N004", "position": {}, "placedAtRevision": 1},
                ],
                "blockedEdgeIds": sorted(blocked),
                "routePlan": None,
                "kpis": None,
                "simulation": {"running": False, "speedMultiplier": 1, "tick": 0, "elapsedSeconds": 0},
                "appliedCommand": None,
                "emittedAt": "2026-09-22T09:00:00.000Z",
            },
            1,
        )
        self.assertEqual(
            [{"orderId": "O-001", "reason": "UNREACHABLE"}], plan["unassignedOrders"]
        )
        self.assertEqual(1, kpis["ordersUnassigned"])
        self.assertEqual([], _route_edges({"routePlan": plan}))


if __name__ == "__main__":
    unittest.main()
