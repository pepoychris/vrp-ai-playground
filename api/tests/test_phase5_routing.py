"""Phase 5 shortest paths, bounded optimisation, command envelope and KPI tests.

The contract examples in ``docs/contracts/examples`` are the frozen reference for
route and KPI semantics: ``driveSeconds`` counts driving only, ``endsAtSeconds`` ends
with the last service, a route without stops is exactly the depot, and the objective
never mixes metres with seconds.
"""

from __future__ import annotations

import copy
import json
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest import mock

from api.app import routing
from api.app.routing import (
    DEFAULT_TIME_LIMIT_SECONDS,
    MAX_TIME_LIMIT_SECONDS,
    UNASSIGNED_PENALTY_CENTS,
    build_distance_time_matrices,
    depot_node_id,
    optimize_snapshot,
    shortest_path,
    travel_seconds,
)
from api.app.scenario import OptimizeRequest
from api.tests.support import REPO_ROOT, asgi_post, build_app, offline_handler

try:  # Documented dev dependency; the schema test is skipped when it is absent.
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    HAS_JSONSCHEMA = True
except ImportError:  # pragma: no cover - minimal test environments only
    HAS_JSONSCHEMA = False

SCHEMAS_DIR = REPO_ROOT / "docs" / "contracts" / "schemas"
EXAMPLES_DIR = REPO_ROOT / "docs" / "contracts" / "examples"
CITY_DATASET = REPO_ROOT / "frontend" / "src" / "city" / "robot-city.json"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(schema_name: str) -> Any:
    """Build a validator that resolves the relative ``common.schema.json`` refs."""
    common = _load_json(SCHEMAS_DIR / "common.schema.json")
    registry = Registry().with_resources(
        [
            (common["$id"], Resource.from_contents(common)),
            ("common.schema.json", Resource.from_contents(common)),
        ]
    )
    return Draft202012Validator(_load_json(SCHEMAS_DIR / schema_name), registry=registry)


def _fixture_graph(road_speed_kph: float = 36.0) -> dict[str, Any]:
    """Three collinear nodes: depot, a delivery node and a further delivery node."""
    return {
        "cityId": "robot-city",
        "graphVersion": 1,
        "nodes": [
            {"nodeId": "N-001", "kind": "DEPOT", "position": {"x": 0, "y": 0, "z": 0}},
            {"nodeId": "N-002", "kind": "DELIVERY", "position": {"x": 1000, "y": 0, "z": 0}},
            {"nodeId": "N-003", "kind": "DELIVERY", "position": {"x": 2000, "y": 0, "z": 0}},
        ],
        "edges": [
            {
                "edgeId": "E-N001-N002",
                "fromNodeId": "N-001",
                "toNodeId": "N-002",
                "bidirectional": True,
                "lengthMeters": 1000,
                "speedLimitKph": road_speed_kph,
            },
            {
                "edgeId": "E-N002-N003",
                "fromNodeId": "N-002",
                "toNodeId": "N-003",
                "bidirectional": True,
                "lengthMeters": 1000,
                "speedLimitKph": road_speed_kph,
            },
        ],
    }


def _fixture_vehicle(
    vehicle_id: str = "R-01", speed_kph: float = 36.0, **overrides: Any
) -> dict[str, Any]:
    vehicle = {
        "vehicleId": vehicle_id,
        "capacityKilograms": 100.0,
        "capacityCubicMeters": 100.0,
        "loadKilograms": 0,
        "loadCubicMeters": 0,
        "speedKilometersPerHour": speed_kph,
        "costPerKilometerCents": 50,
        "costPerMinuteCents": 20,
        "fixedCostCents": 500,
        "currentNodeId": "N-001",
        "status": "AVAILABLE",
        "assignedOrderIds": [],
    }
    vehicle.update(overrides)
    return vehicle


def _fixture_order(
    order_id: str = "O-001",
    node_id: str = "N-002",
    window: tuple[int, int] = (0, 10_000),
    service_seconds: int = 60,
    priority: str = "NORMAL",
    **overrides: Any,
) -> dict[str, Any]:
    order = {
        "orderId": order_id,
        "deliveryNodeId": node_id,
        "weightKilograms": 10.0,
        "volumeCubicMeters": 0.2,
        "priority": priority,
        "timeWindow": {"startSeconds": window[0], "endSeconds": window[1]},
        "serviceSeconds": service_seconds,
        "status": "PENDING",
        "assignedVehicleId": None,
        "sequenceIndex": None,
    }
    order.update(overrides)
    return order


def _fixture_snapshot(
    vehicles: list[dict[str, Any]] | None = None,
    orders: list[dict[str, Any]] | None = None,
    road_speed_kph: float = 36.0,
    blocked: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "scenarioId": "00000000-0000-4000-8000-000000000001",
        "scenarioRevision": 3,
        "previousRevision": 2,
        "status": "READY",
        "seed": 42,
        "graph": _fixture_graph(road_speed_kph),
        "vehicles": vehicles if vehicles is not None else [_fixture_vehicle()],
        "orders": orders if orders is not None else [_fixture_order()],
        "barriers": [],
        "blockedEdgeIds": blocked or [],
        "routePlan": None,
        "kpis": None,
        "simulation": {"running": False, "speedMultiplier": 1, "tick": 0, "elapsedSeconds": 0},
        "appliedCommand": None,
        "emittedAt": "2026-09-22T09:00:00.000Z",
    }


class Phase5TravelTimeTests(unittest.TestCase):
    """F1: travel time, delay and cost units follow the frozen examples."""

    def test_leg_time_uses_the_slower_of_road_limit_and_vehicle_speed(self) -> None:
        self.assertEqual(100, travel_seconds(1000, 36, None))
        self.assertEqual(100, travel_seconds(1000, 36, 42))
        self.assertEqual(150, travel_seconds(1000, 50, 24))
        self.assertEqual(120, travel_seconds(1000, 30, 42))

    def test_route_drive_seconds_exclude_service_and_wait_time(self) -> None:
        snapshot = _fixture_snapshot()
        plan, kpis = optimize_snapshot(snapshot, 1)
        route = plan["vehicles"][0]
        stop = route["stops"][0]
        self.assertEqual(100, stop["arrivalSeconds"])
        self.assertEqual(100, route["driveSeconds"])
        self.assertEqual(160, stop["serviceEndSeconds"])
        self.assertEqual(160, route["endsAtSeconds"])
        self.assertEqual(160, kpis["plannedDurationSeconds"])
        self.assertEqual(0, plan["objectiveCostBreakdown"]["dropPenaltyUnits"])
        # The objective is expressed in seconds/units only: 100 s of driving.
        self.assertEqual(100, plan["objectiveCost"])
        self.assertEqual(1000.0, plan["objectiveCostBreakdown"]["distanceMeters"])

    def test_economic_cost_is_euro_cents_and_matches_the_frozen_example_scale(self) -> None:
        plan, kpis = optimize_snapshot(_fixture_snapshot(), 1)
        breakdown = kpis["economicCostBreakdown"]
        self.assertEqual(500, breakdown["activeVehicleFixedCostCents"])
        self.assertEqual(50, breakdown["distanceCostCents"])
        # 100 s of driving = 1.67 min at 20 c/min, not the 160 s of elapsed time.
        self.assertEqual(33, breakdown["driveTimeCostCents"])
        self.assertEqual(0, breakdown["delayPenaltyCents"])
        self.assertEqual(583, kpis["economicCostCents"])
        self.assertEqual(
            kpis["economicCostCents"], sum(breakdown.values())
        )
        self.assertEqual(1000.0, kpis["distanceTotalMeters"])

    def test_waiting_is_not_delay_and_delay_is_reported(self) -> None:
        waiting = _fixture_snapshot(orders=[_fixture_order(window=(500, 900))])
        _, waiting_kpis = optimize_snapshot(waiting, 1)
        self.assertEqual(0, waiting_kpis["ordersDelayed"])
        self.assertEqual(0, waiting_kpis["economicCostBreakdown"]["delayPenaltyCents"])

        delayed = _fixture_snapshot(orders=[_fixture_order(window=(0, 50))])
        delayed_plan, delayed_kpis = optimize_snapshot(delayed, 1)
        stop = delayed_plan["vehicles"][0]["stops"][0]
        self.assertEqual(50, stop["delaySeconds"])
        self.assertEqual(1, delayed_kpis["ordersDelayed"])
        self.assertEqual(100, delayed_kpis["economicCostBreakdown"]["delayPenaltyCents"])
        self.assertEqual(600, delayed_plan["objectiveCost"])


class Phase5KpiCountingTests(unittest.TestCase):
    """F2: planning-time KPI counters and their invariant."""

    def test_pending_counts_assigned_orders_and_delivered_stays_zero(self) -> None:
        orders = [
            _fixture_order("O-001", "N-002"),
            _fixture_order("O-002", "N-003", priority="URGENT"),
            _fixture_order("O-003", "N-999"),  # unknown node: unreachable
        ]
        plan, kpis = optimize_snapshot(_fixture_snapshot(orders=orders), 1)
        assigned = {stop["orderId"] for route in plan["vehicles"] for stop in route["stops"]}
        self.assertEqual(0, kpis["ordersDelivered"])
        self.assertEqual(len(assigned), kpis["ordersPending"])
        self.assertEqual(1, kpis["ordersUnassigned"])
        self.assertEqual(
            len(orders),
            kpis["ordersDelivered"] + kpis["ordersPending"] + kpis["ordersUnassigned"],
        )
        self.assertLessEqual(kpis["ordersDelayed"], kpis["ordersPending"])
        self.assertEqual(
            ["O-003"], [item["orderId"] for item in plan["unassignedOrders"]]
        )
        self.assertEqual("UNREACHABLE", plan["unassignedOrders"][0]["reason"])

    def test_delayed_orders_stay_pending_and_are_counted_once(self) -> None:
        orders = [_fixture_order("O-001", "N-002", window=(0, 50))]
        _, kpis = optimize_snapshot(_fixture_snapshot(orders=orders), 1)
        self.assertEqual(1, kpis["ordersPending"])
        self.assertEqual(1, kpis["ordersDelayed"])
        self.assertEqual(0, kpis["ordersDelivered"])
        self.assertEqual(0, kpis["ordersUnassigned"])

    def test_unassigned_penalty_uses_the_cents_scale_not_objective_units(self) -> None:
        heavy = _fixture_order("O-001", "N-002", weightKilograms=500.0)
        plan, kpis = optimize_snapshot(_fixture_snapshot(orders=[heavy]), 1)
        self.assertEqual("NO_CAPACITY", plan["unassignedOrders"][0]["reason"])
        self.assertEqual(1000, plan["objectiveCostBreakdown"]["dropPenaltyUnits"])
        self.assertEqual(
            UNASSIGNED_PENALTY_CENTS["NORMAL"],
            kpis["economicCostBreakdown"]["unassignedOrderPenaltyCents"],
        )


class Phase5DepotTests(unittest.IsolatedAsyncioTestCase):
    """F3: the fleet lives at the depot and idle routes never invent distance."""

    def test_idle_route_is_exactly_the_depot_with_zero_cost(self) -> None:
        vehicles = [_fixture_vehicle("R-01"), _fixture_vehicle("R-02")]
        snapshot = _fixture_snapshot(vehicles=vehicles, orders=[_fixture_order()])
        plan, kpis = optimize_snapshot(snapshot, 1)
        idle = next(route for route in plan["vehicles"] if not route["stops"])
        active = next(route for route in plan["vehicles"] if route["stops"])
        self.assertEqual(1, len(active["stops"]))
        self.assertEqual(["N-001"], idle["nodeSequence"])
        self.assertEqual([], idle["edgeSequence"])
        self.assertEqual([], idle["stops"])
        self.assertEqual(0.0, idle["distanceMeters"])
        self.assertEqual(0, idle["driveSeconds"])
        self.assertEqual(0, idle["endsAtSeconds"])
        self.assertEqual(1, kpis["activeVehicles"])
        self.assertEqual({"R-01", "R-02"}, set(kpis["capacityUtilizationPercentByVehicle"]))
        self.assertEqual(
            0, kpis["capacityUtilizationPercentByVehicle"][idle["vehicleId"]]
        )

    async def test_api_deploys_the_fleet_at_the_depot_and_routes_start_there(self) -> None:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 42})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": 3}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": 12}
        )
        snapshot = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()
        depots = [node["nodeId"] for node in snapshot["graph"]["nodes"] if node["kind"] == "DEPOT"]
        self.assertEqual(["N-032"], depots)
        self.assertTrue(
            all(vehicle["currentNodeId"] == "N-032" for vehicle in snapshot["vehicles"])
        )
        for route in snapshot["routePlan"]["vehicles"]:
            self.assertEqual("N-032", route["nodeSequence"][0])
        active = [route for route in snapshot["routePlan"]["vehicles"] if route["stops"]]
        self.assertTrue(active)
        for route in active:
            self.assertGreater(route["distanceMeters"], 0)


class Phase5CommandEnvelopeTests(unittest.IsolatedAsyncioTestCase):
    """F4 and F5: frozen command envelope and the bounded search default."""

    async def _ready_scenario(self, vehicles: int = 2, orders: int = 8) -> tuple[Any, str]:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 42})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": vehicles}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": orders}
        )
        return app, scenario_id

    def test_time_limit_defaults_to_the_frozen_two_seconds(self) -> None:
        self.assertEqual(2, DEFAULT_TIME_LIMIT_SECONDS)
        self.assertEqual(2, MAX_TIME_LIMIT_SECONDS)
        self.assertEqual(2, OptimizeRequest().timeLimitSeconds)
        self.assertEqual(1, OptimizeRequest(timeLimitSeconds=1).timeLimitSeconds)
        self.assertEqual(2, OptimizeRequest(commandId=str(uuid.uuid4())).timeLimitSeconds)

    async def test_endpoint_defaults_and_bounds(self) -> None:
        app, scenario_id = await self._ready_scenario()
        path = f"/api/scenarios/{scenario_id}/optimize"
        default = await asgi_post(app, path, json={})
        self.assertEqual(200, default.status_code)
        self.assertEqual(2, default.json()["routePlan"]["timeLimitSeconds"])
        one = await asgi_post(app, path, json={"timeLimitSeconds": 1})
        self.assertEqual(1, one.json()["routePlan"]["timeLimitSeconds"])
        self.assertEqual(422, (await asgi_post(app, path, json={"timeLimitSeconds": 3})).status_code)
        self.assertEqual(422, (await asgi_post(app, path, json={"timeLimitSeconds": 0})).status_code)

    async def test_repeating_a_command_id_replays_without_mutating(self) -> None:
        app, scenario_id = await self._ready_scenario()
        path = f"/api/scenarios/{scenario_id}/optimize"
        current = (await asgi_post(app, path, json={})).json()
        command = {
            "commandId": str(uuid.uuid4()),
            "scenarioRevision": current["scenarioRevision"],
            "timeLimitSeconds": 1,
        }
        first = (await asgi_post(app, path, json=command)).json()
        self.assertEqual(command["commandId"], first["appliedCommand"]["commandId"])
        self.assertEqual(current["scenarioRevision"], first["appliedCommand"]["appliedAgainstRevision"])
        self.assertFalse(first["appliedCommand"]["rebased"])
        self.assertFalse(first["appliedCommand"]["replayed"])

        replay = (await asgi_post(app, path, json=command)).json()
        self.assertEqual(first["scenarioRevision"], replay["scenarioRevision"])
        self.assertTrue(replay["appliedCommand"]["replayed"])
        self.assertEqual(first["routePlan"], replay["routePlan"])

    async def test_stale_client_revision_is_rebased_and_invalid_envelope_rejected(self) -> None:
        app, scenario_id = await self._ready_scenario()
        path = f"/api/scenarios/{scenario_id}/optimize"
        before = (await asgi_post(app, path, json={})).json()
        stale = (
            await asgi_post(
                app,
                path,
                json={"commandId": str(uuid.uuid4()), "scenarioRevision": 0},
            )
        ).json()
        self.assertTrue(stale["appliedCommand"]["rebased"])
        self.assertEqual(before["scenarioRevision"], stale["appliedCommand"]["appliedAgainstRevision"])
        self.assertEqual(before["scenarioRevision"] + 1, stale["scenarioRevision"])
        invalid = await asgi_post(app, path, json={"commandId": "not-a-uuid"})
        self.assertEqual(422, invalid.status_code)

    async def test_last_intervention_tracks_the_previous_plan(self) -> None:
        app, scenario_id = await self._ready_scenario()
        path = f"/api/scenarios/{scenario_id}/optimize"
        first = (await asgi_post(app, path, json={})).json()
        self.assertIsNone(first["kpis"]["lastIntervention"])
        second = (await asgi_post(app, path, json={})).json()
        impact = second["kpis"]["lastIntervention"]
        self.assertEqual("OPTIMIZE", impact["kind"])
        self.assertEqual(first["scenarioRevision"], impact["comparedToRevision"])
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
        self.assertEqual(0, impact["delta"]["distanceTotalMeters"])
        self.assertEqual(0, impact["delta"]["economicCostCents"])


class Phase5UnreachableTests(unittest.TestCase):
    """F6: impossible paths are explicit and never charged as free travel."""

    def test_unreachable_pairs_stay_none_in_the_matrices(self) -> None:
        graph = _fixture_graph()
        blocked = {"E-N002-N003"}
        matrix = build_distance_time_matrices(graph, ["N-001", "N-003"], blocked)
        self.assertIsNone(matrix["N-001"]["N-003"])
        self.assertIsNone(shortest_path(graph, "N-001", "N-003", blocked))
        self.assertIsNone(shortest_path(graph, "N-001", "N-999"))

    def test_blocked_edge_is_reported_as_unassigned_instead_of_crashing(self) -> None:
        orders = [_fixture_order("O-001", "N-002"), _fixture_order("O-002", "N-003")]
        snapshot = _fixture_snapshot(orders=orders, blocked=["E-N002-N003"])
        plan, kpis = optimize_snapshot(snapshot, 1)
        reasons = {item["orderId"]: item["reason"] for item in plan["unassignedOrders"]}
        self.assertEqual({"O-002": "UNREACHABLE"}, reasons)
        self.assertEqual(1, kpis["ordersUnassigned"])
        active = [route for route in plan["vehicles"] if route["stops"]]
        self.assertEqual(1, len(active))
        self.assertEqual(1000.0, active[0]["distanceMeters"])
        self.assertNotIn("N-003", active[0]["nodeSequence"])

    def test_solver_path_handles_an_unreachable_order_without_raising(self) -> None:
        orders = [_fixture_order("O-001", "N-002"), _fixture_order("O-002", "N-999")]
        plan, _ = optimize_snapshot(_fixture_snapshot(orders=orders), 1)
        self.assertEqual(
            "UNREACHABLE", plan["unassignedOrders"][0]["reason"]
        )
        for route in plan["vehicles"]:
            for node_id in route["nodeSequence"]:
                self.assertNotEqual("N-999", node_id)


class Phase5SolverAndDeterminismTests(unittest.TestCase):
    """F7: honest solver reporting and reproducible published plans."""

    def test_solver_outcome_fields_are_consistent(self) -> None:
        plan, _ = optimize_snapshot(_fixture_snapshot(), 1)
        self.assertIn(
            plan["solverOutcome"],
            {"OPTIMAL", "FEASIBLE", "TIME_LIMIT_REACHED", "INFEASIBLE", "NO_SOLUTION"},
        )
        self.assertEqual(
            plan["solverOutcome"] == "OPTIMAL", plan["objectiveIsProvenOptimal"]
        )
        self.assertIsInstance(plan["objectiveIsProvenOptimal"], bool)

    def test_published_plan_is_reproducible(self) -> None:
        base = _fixture_snapshot(
            vehicles=[_fixture_vehicle("R-01"), _fixture_vehicle("R-02", speed_kph=30.0)],
            orders=[
                _fixture_order("O-001", "N-002", priority="URGENT"),
                _fixture_order("O-002", "N-003"),
                _fixture_order("O-003", "N-002", window=(0, 400)),
            ],
        )
        signatures = []
        for _ in range(3):
            plan, kpis = optimize_snapshot(copy.deepcopy(base), 1)
            signatures.append(
                (
                    plan["objectiveCost"],
                    plan["solverOutcome"],
                    tuple(
                        (route["vehicleId"], tuple(route["nodeSequence"]), route["driveSeconds"])
                        for route in plan["vehicles"]
                    ),
                    kpis["plannedDurationSeconds"],
                    kpis["economicCostCents"],
                )
            )
        self.assertEqual(1, len(set(signatures)))

    def test_constructive_fallback_is_deterministic_and_capacity_safe(self) -> None:
        base = _fixture_snapshot(
            vehicles=[_fixture_vehicle("R-01")],
            orders=[
                _fixture_order("O-001", "N-002"),
                _fixture_order("O-002", "N-003", priority="URGENT"),
            ],
        )
        with mock.patch.object(routing, "pywrapcp", None), mock.patch.object(
            routing, "routing_enums_pb2", None
        ):
            first_plan, first_kpis = optimize_snapshot(copy.deepcopy(base), 1)
            second_plan, second_kpis = optimize_snapshot(copy.deepcopy(base), 1)
        self.assertEqual(first_plan, second_plan)
        self.assertEqual(first_kpis, second_kpis)
        self.assertEqual("FEASIBLE", first_plan["solverOutcome"])
        self.assertFalse(first_plan["objectiveIsProvenOptimal"])
        self.assertEqual([], first_plan["unassignedOrders"])
        self.assertEqual(
            {"O-001", "O-002"},
            {
                stop["orderId"]
                for route in first_plan["vehicles"]
                for stop in route["stops"]
            },
        )
        self.assertEqual(2, first_kpis["ordersPending"])


class Phase5ContractConformanceTests(unittest.TestCase):
    """F8: the published artefacts match the frozen contracts and the city dataset."""

    @unittest.skipUnless(HAS_JSONSCHEMA, "jsonschema is a documented dev dependency")
    def test_frozen_examples_still_validate(self) -> None:
        route_validator = _validator("route-plan.schema.json")
        kpi_validator = _validator("kpi-snapshot.schema.json")
        route_validator.validate(_load_json(EXAMPLES_DIR / "route-plan.example.json"))
        kpi_validator.validate(_load_json(EXAMPLES_DIR / "kpi-snapshot.example.json"))

    @unittest.skipUnless(HAS_JSONSCHEMA, "jsonschema is a documented dev dependency")
    def test_published_plan_and_kpis_match_the_frozen_schemas(self) -> None:
        plan, kpis = optimize_snapshot(_fixture_snapshot(), 1)
        _validator("route-plan.schema.json").validate(plan)
        _validator("kpi-snapshot.schema.json").validate(kpis)

    def test_api_graph_matches_the_phase3_city_dataset(self) -> None:
        from api.app.scenario import _graph

        api_graph = _graph()
        dataset = _load_json(CITY_DATASET)
        api_nodes = {node["nodeId"]: node for node in api_graph["nodes"]}
        data_nodes = {node["nodeId"]: node for node in dataset["nodes"]}
        self.assertEqual(set(data_nodes), set(api_nodes))
        for node_id, node in api_nodes.items():
            self.assertEqual(data_nodes[node_id]["kind"], node["kind"], node_id)
            self.assertEqual(data_nodes[node_id]["position"], node["position"], node_id)
            self.assertEqual(data_nodes[node_id].get("label"), node.get("label"), node_id)
        self.assertEqual(
            sum(1 for node in api_nodes.values() if node["kind"] == "DEPOT"), 1
        )

        api_edges = {edge["edgeId"]: edge for edge in api_graph["edges"]}
        data_edges = {edge["edgeId"]: edge for edge in dataset["edges"]}
        self.assertEqual(set(data_edges), set(api_edges))
        for edge_id, edge in api_edges.items():
            reference = data_edges[edge_id]
            for field in (
                "fromNodeId",
                "toNodeId",
                "bidirectional",
                "lengthMeters",
                "speedLimitKph",
            ):
                self.assertEqual(reference[field], edge[field], f"{edge_id}.{field}")
            self.assertTrue(edge["bidirectional"], edge_id)
            spline = edge["visualSplineControlPoints"]
            self.assertGreaterEqual(len(spline), 2, edge_id)
            self.assertEqual(api_nodes[edge["fromNodeId"]]["position"], spline[0], edge_id)
            self.assertEqual(api_nodes[edge["toNodeId"]]["position"], spline[-1], edge_id)

    def test_depot_helper_and_dijkstra_stay_available(self) -> None:
        graph = _fixture_graph()
        self.assertEqual("N-001", depot_node_id(graph))
        path = shortest_path(graph, "N-001", "N-002")
        self.assertIsNotNone(path)
        self.assertEqual(1000, path.distance_meters)
        self.assertEqual(100, path.drive_seconds)


if __name__ == "__main__":
    unittest.main()
