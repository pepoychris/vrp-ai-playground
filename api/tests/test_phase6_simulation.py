"""Phase 6 simulation clock, claw snap and relocation command tests.

The phase adds two things that have to stay deterministic: a bounded simulation clock
that never creates a revision, and a claw relocation that snaps to a road node and
re-plans exactly once. The tests below cover the pure primitives and the REST surface.
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
from api.app import scenario as scenario_module
from api.app.scenario import (
    SIMULATION_KINDS,
    ScenarioStore,
    SimulationPauseRequest,
    SimulationStartRequest,
    VehiclePositionRequest,
)
from api.app.simulation import (
    DEFAULT_SPEED_MULTIPLIER,
    MAX_SPEED_MULTIPLIER,
    MAX_TICKS_PER_ADVANCE,
    SNAP_NODE_MAX_RADIUS_M,
    TICK_SECONDS,
    advance_clock,
    bounded_tick_delta,
    clamp_speed_multiplier,
    nearest_node,
    route_legs,
    simulation_state,
    vehicle_samples,
)
from api.tests.support import (
    REPO_ROOT,
    asgi_get,
    asgi_post,
    asgi_request,
    build_app,
    offline_handler,
)

CITY_DATASET = REPO_ROOT / "frontend" / "src" / "city" / "robot-city.json"


def _dataset() -> dict[str, Any]:
    return json.loads(CITY_DATASET.read_text(encoding="utf-8"))


def _graph_from_dataset() -> dict[str, Any]:
    dataset = _dataset()
    return {
        "cityId": dataset["cityId"],
        "graphVersion": dataset["graphVersion"],
        "nodes": dataset["nodes"],
        "edges": dataset["edges"],
    }


def _fixture_graph() -> dict[str, Any]:
    """Three collinear nodes two hundred metres apart."""
    return {
        "cityId": "robot-city",
        "graphVersion": 1,
        "nodes": [
            {"nodeId": "N-001", "kind": "DEPOT", "position": {"x": 0, "y": 0, "z": 0}},
            {"nodeId": "N-002", "kind": "DELIVERY", "position": {"x": 200, "y": 0, "z": 0}},
            {"nodeId": "N-003", "kind": "DELIVERY", "position": {"x": 400, "y": 0, "z": 0}},
        ],
        "edges": [
            {
                "edgeId": "E-N001-N002",
                "fromNodeId": "N-001",
                "toNodeId": "N-002",
                "bidirectional": True,
                "lengthMeters": 200,
                "speedLimitKph": 36,
            },
            {
                "edgeId": "E-N002-N003",
                "fromNodeId": "N-002",
                "toNodeId": "N-003",
                "bidirectional": True,
                "lengthMeters": 200,
                "speedLimitKph": 36,
            },
        ],
    }


class Phase6ClockTests(unittest.TestCase):
    """The clock is whole ticks: bounded, monotone and free of the wall clock."""

    def test_elapsed_seconds_are_derived_from_the_tick_counter(self) -> None:
        state = simulation_state(running=True, speed_multiplier=2, tick=7)
        self.assertEqual(
            {"running": True, "speedMultiplier": 2, "tick": 7},
            {key: state[key] for key in ("running", "speedMultiplier", "tick")},
        )
        self.assertEqual(round(7 * TICK_SECONDS, 3), state["elapsedSeconds"])
        self.assertFalse(simulation_state(running=False)["running"])

    def test_advance_is_monotone_non_negative_and_bounded(self) -> None:
        base = simulation_state(running=True, speed_multiplier=1, tick=4)
        self.assertEqual(4, advance_clock(base, 0)["tick"])
        self.assertEqual(4, advance_clock(base, -12)["tick"])
        self.assertEqual(6, advance_clock(base, 2)["tick"])
        bounded = advance_clock(base, MAX_TICKS_PER_ADVANCE * 10)["tick"]
        self.assertEqual(4 + MAX_TICKS_PER_ADVANCE, bounded)

    def test_real_time_becomes_bounded_ticks_that_scale_with_speed(self) -> None:
        window = 2 * TICK_SECONDS
        self.assertEqual(0, bounded_tick_delta(0, 1))
        self.assertEqual(0, bounded_tick_delta(-1, 8))
        self.assertEqual(2, bounded_tick_delta(window, 1))
        self.assertEqual(4, bounded_tick_delta(window, 2))
        self.assertEqual(8, bounded_tick_delta(window, 4))
        self.assertEqual(0, bounded_tick_delta(window, 0))
        self.assertEqual(
            MAX_TICKS_PER_ADVANCE, bounded_tick_delta(10_000, MAX_SPEED_MULTIPLIER)
        )

    def test_speed_multiplier_bounds_are_rejected_not_clamped(self) -> None:
        self.assertEqual(0.5, clamp_speed_multiplier(0.5))
        self.assertEqual(MAX_SPEED_MULTIPLIER, clamp_speed_multiplier(MAX_SPEED_MULTIPLIER))
        self.assertEqual(DEFAULT_SPEED_MULTIPLIER, SimulationStartRequest().speedMultiplier)
        for bad in (0, -1, MAX_SPEED_MULTIPLIER + 0.001):
            with self.assertRaises(ValueError):
                clamp_speed_multiplier(bad)


class Phase6SnapTests(unittest.TestCase):
    """The claw snaps to a road node inside the contract radius, deterministically."""

    def test_snap_radius_matches_the_rendered_city_constant(self) -> None:
        self.assertEqual(12.0, SNAP_NODE_MAX_RADIUS_M)
        source = (
            REPO_ROOT / "frontend" / "src" / "city" / "dataset.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(f"SNAP_NODE_MAX_RADIUS_M = {SNAP_NODE_MAX_RADIUS_M:g}", source)

    def test_snaps_to_the_nearest_node_inside_the_radius(self) -> None:
        graph = _graph_from_dataset()
        depot = next(node for node in graph["nodes"] if node["kind"] == "DEPOT")
        snap = nearest_node(
            graph, {"x": depot["position"]["x"] + 3, "y": 0, "z": depot["position"]["z"] - 4}
        )
        self.assertIsNotNone(snap)
        assert snap is not None
        self.assertEqual(depot["nodeId"], snap.node_id)
        self.assertEqual(5.0, snap.distance_meters)
        self.assertEqual(depot["position"], snap.position)

    def test_rejects_a_drop_outside_the_radius(self) -> None:
        graph = _graph_from_dataset()
        self.assertIsNone(nearest_node(graph, {"x": 24, "y": 0, "z": 24}))
        self.assertIsNone(
            nearest_node(graph, {"x": 1_000, "y": 0, "z": -1_000})
        )

    def test_exact_tie_goes_to_the_lexicographically_smaller_node(self) -> None:
        graph = {
            "cityId": "robot-city",
            "graphVersion": 1,
            "nodes": [
                {"nodeId": "N-005", "kind": "JUNCTION", "position": {"x": 10, "y": 0, "z": 0}},
                {"nodeId": "N-002", "kind": "JUNCTION", "position": {"x": -10, "y": 0, "z": 0}},
            ],
            "edges": [],
        }
        snap = nearest_node(graph, {"x": 0, "y": 0, "z": 0})
        assert snap is not None
        self.assertEqual("N-002", snap.node_id)


class Phase6MovementTests(unittest.TestCase):
    """Movement is a pure function of the published route and the tick clock."""

    def test_legs_use_whole_seconds_capped_by_the_slower_of_road_and_robot(self) -> None:
        legs = route_legs(
            _fixture_graph(), ["N-001", "N-002", "N-003"], ["E-N001-N002", "E-N002-N003"]
        )
        self.assertEqual(20, legs[0].seconds)
        self.assertEqual("E-N001-N002", legs[0].edge_id)
        slow = route_legs(
            _fixture_graph(),
            ["N-001", "N-002"],
            ["E-N001-N002"],
            vehicle_speed_kph=18,
        )
        self.assertEqual(40, slow[0].seconds)

    def test_a_disconnected_sequence_stops_instead_of_inventing_a_shortcut(self) -> None:
        legs = route_legs(_fixture_graph(), ["N-001"], ["E-N002-N003"])
        self.assertEqual([], legs)

    def test_samples_advance_along_the_route_and_clamp_at_the_end(self) -> None:
        graph = _fixture_graph()
        route_plan = {
            "vehicles": [
                {
                    "vehicleId": "R-01",
                    "nodeSequence": ["N-001", "N-002", "N-003"],
                    "edgeSequence": ["E-N001-N002", "E-N002-N003"],
                    "stops": [{"orderId": "O-001", "nodeId": "N-003"}],
                }
            ]
        }
        vehicles = [{"vehicleId": "R-01", "currentNodeId": "N-001", "speedKilometersPerHour": 36.0}]

        start = vehicle_samples(graph, route_plan, vehicles, 0)[0]
        self.assertEqual("N-001", start.node_id)
        self.assertEqual("E-N001-N002", start.edge_id)
        self.assertEqual(0.0, start.progress)
        self.assertFalse(start.arrived)

        middle = vehicle_samples(graph, route_plan, vehicles, 10)[0]
        self.assertEqual("E-N001-N002", middle.edge_id)
        self.assertAlmostEqual(0.5, middle.progress, places=6)
        self.assertAlmostEqual(100.0, middle.position["x"], places=6)
        self.assertAlmostEqual(90.0, middle.heading_degrees, places=6)

        second_leg = vehicle_samples(graph, route_plan, vehicles, 20)[0]
        self.assertEqual("E-N002-N003", second_leg.edge_id)
        self.assertAlmostEqual(0.0, second_leg.progress, places=6)

        arrived = vehicle_samples(graph, route_plan, vehicles, 1_000)[0]
        self.assertTrue(arrived.arrived)
        self.assertIsNone(arrived.edge_id)
        self.assertEqual("N-003", arrived.node_id)
        self.assertAlmostEqual(400.0, arrived.position["x"], places=6)

    def test_samples_are_reproducible_and_a_vehicle_without_stops_stays_put(self) -> None:
        graph = _fixture_graph()
        route_plan = {
            "vehicles": [
                {
                    "vehicleId": "R-01",
                    "nodeSequence": ["N-001", "N-002"],
                    "edgeSequence": ["E-N001-N002"],
                    "stops": [{"orderId": "O-001", "nodeId": "N-002"}],
                },
                {
                    "vehicleId": "R-02",
                    "nodeSequence": ["N-001"],
                    "edgeSequence": [],
                    "stops": [],
                },
            ]
        }
        vehicles = [
            {"vehicleId": "R-01", "currentNodeId": "N-001", "speedKilometersPerHour": 36.0},
            {"vehicleId": "R-02", "currentNodeId": "N-001", "speedKilometersPerHour": 30.0},
        ]
        first = vehicle_samples(graph, route_plan, vehicles, 7)
        second = vehicle_samples(graph, copy.deepcopy(route_plan), copy.deepcopy(vehicles), 7)
        self.assertEqual(first, second)
        self.assertEqual(["R-01", "R-02"], [sample.vehicle_id for sample in first])
        self.assertEqual("N-001", first[1].node_id)
        self.assertTrue(first[1].arrived)
        self.assertIsNone(first[1].edge_id)


class Phase6SimulationCommandTests(unittest.IsolatedAsyncioTestCase):
    """Frozen command envelope on top of the simulation clock."""

    async def _scenario(self, vehicles: int = 2, orders: int = 6) -> tuple[Any, str, dict[str, Any]]:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 42})).json()
        scenario_id = created["scenarioId"]
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": vehicles}
        )
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": orders}
        )
        ready = (await asgi_get(app, f"/api/scenarios/{scenario_id}")).json()
        return app, scenario_id, ready

    async def test_start_and_pause_publish_the_clock_and_the_status(self) -> None:
        app, scenario_id, ready = await self._scenario()
        before = ready["scenarioRevision"]

        started = (
            await asgi_post(
                app,
                f"/api/scenarios/{scenario_id}/simulation/start",
                json={"speedMultiplier": 2},
            )
        ).json()
        self.assertEqual("RUNNING", started["status"])
        self.assertTrue(started["simulation"]["running"])
        self.assertEqual(2, started["simulation"]["speedMultiplier"])
        self.assertEqual(0, started["simulation"]["tick"])
        self.assertEqual(before + 1, started["scenarioRevision"])
        self.assertEqual("SIMULATION_START", started["appliedCommand"]["kind"])

        paused = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/simulation/pause", json={})
        ).json()
        self.assertEqual("PAUSED", paused["status"])
        self.assertFalse(paused["simulation"]["running"])
        self.assertEqual(2, paused["simulation"]["speedMultiplier"])
        self.assertEqual("SIMULATION_PAUSE", paused["appliedCommand"]["kind"])

    async def test_pausing_an_idle_simulation_is_a_conflict(self) -> None:
        app, scenario_id, _ = await self._scenario()
        response = await asgi_post(
            app, f"/api/scenarios/{scenario_id}/simulation/pause", json={}
        )
        self.assertEqual(409, response.status_code)
        self.assertEqual("SIMULATION_NOT_RUNNING", response.json()["detail"])

    async def test_resuming_and_changing_speed_never_rewinds_the_clock(self) -> None:
        app, scenario_id, _ = await self._scenario()
        await asgi_post(app, f"/api/scenarios/{scenario_id}/simulation/start", json={})
        advanced = app.state.scenario_store.advance_simulation(scenario_id, 30.0)
        self.assertGreater(advanced["simulation"]["tick"], 0)
        revision_after_ticks = advanced["scenarioRevision"]

        await asgi_post(app, f"/api/scenarios/{scenario_id}/simulation/pause", json={})
        resumed = (
            await asgi_post(
                app,
                f"/api/scenarios/{scenario_id}/simulation/start",
                json={"speedMultiplier": 4},
            )
        ).json()
        self.assertEqual(advanced["simulation"]["tick"], resumed["simulation"]["tick"])
        self.assertEqual(4, resumed["simulation"]["speedMultiplier"])
        self.assertGreater(resumed["scenarioRevision"], revision_after_ticks)

    async def test_ticks_never_create_a_revision_and_stale_ticks_are_discarded(self) -> None:
        app, scenario_id, _ = await self._scenario()
        started = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/simulation/start", json={})
        ).json()
        revision = started["scenarioRevision"]

        advanced = app.state.scenario_store.advance_simulation(scenario_id, 5.0)
        self.assertGreater(advanced["simulation"]["tick"], 0)
        self.assertEqual(revision, advanced["scenarioRevision"])
        fetched = (await asgi_get(app, f"/api/scenarios/{scenario_id}")).json()
        self.assertEqual(revision, fetched["scenarioRevision"])
        self.assertEqual(advanced["simulation"]["tick"], fetched["simulation"]["tick"])

        # A tick computed against an older revision is discarded, never applied.
        stale = app.state.scenario_store.advance_simulation(
            scenario_id, 5.0, expected_revision=revision - 1
        )
        self.assertEqual(fetched["simulation"]["tick"], stale["simulation"]["tick"])
        self.assertEqual(revision, stale["scenarioRevision"])

        # Ticks only exist while the simulation runs.
        app.state.scenario_store.pause_simulation(scenario_id)
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            app.state.scenario_store.advance_simulation(scenario_id, 5.0)

    async def test_start_command_envelope_is_replayed_and_rebased(self) -> None:
        app, scenario_id, ready = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/simulation/start"
        command = {
            "commandId": str(uuid.uuid4()),
            "scenarioRevision": ready["scenarioRevision"],
            "speedMultiplier": 2,
        }
        first = (await asgi_post(app, path, json=command)).json()
        self.assertFalse(first["appliedCommand"]["replayed"])
        self.assertFalse(first["appliedCommand"]["rebased"])

        replay = (await asgi_post(app, path, json=command)).json()
        self.assertTrue(replay["appliedCommand"]["replayed"])
        self.assertEqual(first["scenarioRevision"], replay["scenarioRevision"])

        stale = (
            await asgi_post(
                app,
                path,
                json={"commandId": str(uuid.uuid4()), "scenarioRevision": 0, "speedMultiplier": 1},
            )
        ).json()
        self.assertTrue(stale["appliedCommand"]["rebased"])
        self.assertEqual(first["scenarioRevision"], stale["appliedCommand"]["appliedAgainstRevision"])

    async def test_speed_and_command_id_validation(self) -> None:
        app, scenario_id, _ = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/simulation/start"
        self.assertEqual(422, (await asgi_post(app, path, json={"speedMultiplier": 0})).status_code)
        self.assertEqual(422, (await asgi_post(app, path, json={"speedMultiplier": 9})).status_code)
        self.assertEqual(
            422, (await asgi_post(app, path, json={"commandId": "not-a-uuid"})).status_code
        )
        self.assertEqual(
            422,
            (
                await asgi_post(
                    app, f"/api/scenarios/{scenario_id}/simulation/pause", json={"speedMultiplier": 2}
                )
            ).status_code,
        )

    async def test_request_models_forbid_extra_fields(self) -> None:
        self.assertEqual(1.0, SimulationStartRequest().speedMultiplier)
        self.assertIsNone(SimulationPauseRequest().commandId)
        self.assertEqual(0.0, VehiclePositionRequest(position={"x": 1, "z": 2}).position.y)
        self.assertEqual(("SIMULATION_START", "SIMULATION_PAUSE"), SIMULATION_KINDS)


class Phase6RelocationTests(unittest.IsolatedAsyncioTestCase):
    """A claw drop relocates one vehicle and re-plans exactly once."""

    async def _scenario(self) -> tuple[Any, str, dict[str, Any]]:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 7})).json()
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

    async def test_a_valid_drop_snaps_re_plans_once_and_publishes_one_revision(self) -> None:
        app, scenario_id, planned = await self._scenario()
        graph = planned["graph"]
        delivery = next(node for node in graph["nodes"] if node["kind"] == "DELIVERY")
        target = {key: float(value) for key, value in delivery["position"].items()}
        near = {"x": target["x"] + 2.0, "y": 0.0, "z": target["z"] - 2.0}
        path = f"/api/scenarios/{scenario_id}/vehicles/R-01/position"

        with mock.patch.object(
            scenario_module, "optimize_snapshot", wraps=routing.optimize_snapshot
        ) as planner:
            response = await asgi_request(app, "PATCH", path, json={"position": near})

        self.assertEqual(200, response.status_code)
        relocated = response.json()
        self.assertEqual(1, planner.call_count, "a claw drop must plan exactly once")
        self.assertEqual(planned["scenarioRevision"] + 1, relocated["scenarioRevision"])
        self.assertEqual("VEHICLE_RELOCATED", relocated["appliedCommand"]["kind"])

        vehicle = next(item for item in relocated["vehicles"] if item["vehicleId"] == "R-01")
        self.assertEqual(delivery["nodeId"], vehicle["currentNodeId"])
        self.assertEqual(relocated["scenarioRevision"], relocated["routePlan"]["scenarioRevision"])
        self.assertEqual(relocated["scenarioRevision"], relocated["kpis"]["scenarioRevision"])
        self.assertFalse(relocated["simulation"]["running"])
        self.assertEqual(0, relocated["simulation"]["tick"])
        self.assertEqual(
            "VEHICLE_RELOCATED", relocated["kpis"]["lastIntervention"]["kind"]
        )
        self.assertEqual(
            planned["scenarioRevision"],
            relocated["kpis"]["lastIntervention"]["comparedToRevision"],
        )

    async def test_the_route_starts_at_the_new_node_after_a_drop(self) -> None:
        app, scenario_id, planned = await self._scenario()
        delivery = next(
            node for node in planned["graph"]["nodes"] if node["kind"] == "DELIVERY"
        )
        target = {key: float(value) for key, value in delivery["position"].items()}
        relocated = (
            await asgi_request(
                app,
                "PATCH",
                f"/api/scenarios/{scenario_id}/vehicles/R-01/position",
                json={"position": target},
            )
        ).json()
        route = next(
            item for item in relocated["routePlan"]["vehicles"] if item["vehicleId"] == "R-01"
        )
        self.assertEqual(delivery["nodeId"], route["nodeSequence"][0])

    async def test_an_invalid_drop_is_rejected_without_consuming_a_revision(self) -> None:
        app, scenario_id, planned = await self._scenario()
        path = f"/api/scenarios/{scenario_id}/vehicles/R-01/position"

        response = await asgi_request(
            app, "PATCH", path, json={"position": {"x": 24, "y": 0, "z": 24}}
        )

        self.assertEqual(422, response.status_code)
        self.assertEqual("SNAP_OUT_OF_RADIUS", response.json()["detail"])
        unchanged = (await asgi_get(app, f"/api/scenarios/{scenario_id}")).json()
        self.assertEqual(planned["scenarioRevision"], unchanged["scenarioRevision"])
        depot = next(
            node for node in planned["graph"]["nodes"] if node["kind"] == "DEPOT"
        )
        vehicle = next(item for item in unchanged["vehicles"] if item["vehicleId"] == "R-01")
        self.assertEqual(depot["nodeId"], vehicle["currentNodeId"])

    async def test_an_unknown_vehicle_is_reported_as_not_found(self) -> None:
        app, scenario_id, _ = await self._scenario()
        response = await asgi_request(
            app,
            "PATCH",
            f"/api/scenarios/{scenario_id}/vehicles/R-06/position",
            json={"position": {"x": 0, "y": 0, "z": 0}},
        )
        self.assertEqual(404, response.status_code)
        self.assertEqual("VEHICLE_NOT_FOUND", response.json()["detail"])

    async def test_a_repeated_relocation_command_is_replayed(self) -> None:
        app, scenario_id, planned = await self._scenario()
        delivery = next(
            node for node in planned["graph"]["nodes"] if node["kind"] == "DELIVERY"
        )
        target = {key: float(value) for key, value in delivery["position"].items()}
        command = {
            "commandId": str(uuid.uuid4()),
            "scenarioRevision": planned["scenarioRevision"],
            "position": target,
        }
        path = f"/api/scenarios/{scenario_id}/vehicles/R-02/position"
        first = (await asgi_request(app, "PATCH", path, json=command)).json()
        replay = (await asgi_request(app, "PATCH", path, json=command)).json()
        self.assertTrue(replay["appliedCommand"]["replayed"])
        self.assertEqual(first["scenarioRevision"], replay["scenarioRevision"])
        self.assertEqual(first["vehicles"], replay["vehicles"])
        self.assertEqual(first["kpis"], replay["kpis"])

    async def test_a_structural_command_resets_the_simulation_clock(self) -> None:
        app, scenario_id, planned = await self._scenario()
        await asgi_post(
            app, f"/api/scenarios/{scenario_id}/simulation/start", json={"speedMultiplier": 4}
        )
        app.state.scenario_store.advance_simulation(scenario_id, 10.0)

        optimized = (
            await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
        ).json()

        self.assertFalse(optimized["simulation"]["running"])
        self.assertEqual(0, optimized["simulation"]["tick"])
        self.assertEqual(0, optimized["simulation"]["elapsedSeconds"])
        self.assertEqual(4, optimized["simulation"]["speedMultiplier"])
        self.assertEqual("READY", optimized["status"])
        self.assertEqual(planned["scenarioId"], optimized["scenarioId"])

    async def test_the_store_mirrors_the_frontend_snap_constant(self) -> None:
        store = ScenarioStore()
        snapshot = store.create(3)
        self.assertEqual(12.0, SNAP_NODE_MAX_RADIUS_M)
        self.assertEqual(1, snapshot["scenarioRevision"])
        self.assertEqual(
            {"running": False, "speedMultiplier": 1.0, "tick": 0, "elapsedSeconds": 0.0},
            snapshot["simulation"],
        )


if __name__ == "__main__":
    unittest.main()
