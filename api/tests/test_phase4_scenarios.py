"""Phase 4 scenario generation API tests."""

from __future__ import annotations

import unittest

from api.tests.support import asgi_delete, asgi_get, asgi_post, build_app, offline_handler


class Phase4ScenarioTests(unittest.IsolatedAsyncioTestCase):
    async def test_seed_reproduces_fleet_and_orders(self) -> None:
        app, _ = build_app(offline_handler)
        first = (await asgi_post(app, "/api/scenarios", json={"seed": 42})).json()
        fleet = (await asgi_post(app, f"/api/scenarios/{first['scenarioId']}/vehicles/generate", json={"count": 3})).json()
        orders = (await asgi_post(app, f"/api/scenarios/{first['scenarioId']}/orders/generate", json={"count": 8})).json()
        second_app, _ = build_app(offline_handler)
        second = (await asgi_post(second_app, "/api/scenarios", json={"seed": 42})).json()
        fleet_two = (await asgi_post(second_app, f"/api/scenarios/{second['scenarioId']}/vehicles/generate", json={"count": 3})).json()
        orders_two = (await asgi_post(second_app, f"/api/scenarios/{second['scenarioId']}/orders/generate", json={"count": 8})).json()
        self.assertEqual(fleet["vehicles"], fleet_two["vehicles"])
        self.assertEqual(orders["orders"], orders_two["orders"])

    async def test_bounds_are_validated_by_the_backend(self) -> None:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 1})).json()
        scenario_id = created["scenarioId"]
        self.assertEqual(422, (await asgi_post(app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": 7})).status_code)
        self.assertEqual(422, (await asgi_post(app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": 5})).status_code)

    async def test_orders_only_use_reachable_delivery_nodes(self) -> None:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 7})).json()
        result = (await asgi_post(app, f"/api/scenarios/{created['scenarioId']}/orders/generate", json={"count": 24})).json()
        delivery_nodes = {node["nodeId"] for node in result["graph"]["nodes"] if node["kind"] == "DELIVERY"}
        self.assertTrue(all(order["deliveryNodeId"] in delivery_nodes for order in result["orders"]))
        self.assertTrue(all(order["weightKilograms"] > 0 and order["volumeCubicMeters"] > 0 for order in result["orders"]))

    async def test_reset_removes_routes_barriers_and_persisted_snapshot(self) -> None:
        app, _ = build_app(offline_handler)
        created = (await asgi_post(app, "/api/scenarios", json={"seed": 7})).json()
        scenario_id = created["scenarioId"]
        reset = await asgi_delete(app, f"/api/scenarios/{scenario_id}")
        self.assertEqual(200, reset.status_code)
        self.assertEqual("RESET", reset.json()["status"])
        self.assertEqual(404, (await asgi_get(app, f"/api/scenarios/{scenario_id}")).status_code)


if __name__ == "__main__":
    unittest.main()
