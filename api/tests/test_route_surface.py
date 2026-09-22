"""Phase 7 exposes readiness, scenario generation, optimisation, simulation and barriers."""

from __future__ import annotations

import unittest
from dataclasses import fields
from typing import get_args

from api.app import main as main_module
from api.app.config import (
    CHAT_TEMPERATURE,
    MODEL_NAME,
    NUM_CTX,
    REPORT_TEMPERATURE,
    THINK,
    ModelName,
    Settings,
)
from api.tests.support import asgi_get, asgi_post, build_app, handler_with_paths, models_payload

EXPECTED_PRODUCT_ROUTES = {
    "/health",
    "/api/ai/status",
    "/api/scenarios",
    "/api/scenarios/{scenario_id}",
    "/api/scenarios/{scenario_id}/vehicles/generate",
    "/api/scenarios/{scenario_id}/orders/generate",
    "/api/scenarios/{scenario_id}/optimize",
    "/api/scenarios/{scenario_id}/simulation/start",
    "/api/scenarios/{scenario_id}/simulation/pause",
    "/api/scenarios/{scenario_id}/vehicles/{vehicle_id}/position",
    "/api/scenarios/{scenario_id}/barriers",
    "/api/scenarios/{scenario_id}/barriers/{barrier_id}",
}
DOC_ROUTE_PATHS = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
FORBIDDEN_PATH_FRAGMENTS = (
    "/api/ai/model/install",
    "/api/ai/activate",
    "/api/ai/chat",
    "/api/ai/reports",
    "/api/ai/proposals",
)


class RouteSurfaceTests(unittest.IsolatedAsyncioTestCase):
    def test_exposes_exactly_the_phase_7_product_routes(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        paths = {route.path for route in app.routes}

        self.assertTrue(DOC_ROUTE_PATHS <= paths, "FastAPI documentation routes are expected")
        self.assertEqual(EXPECTED_PRODUCT_ROUTES, paths - DOC_ROUTE_PATHS)
        for path in paths - DOC_ROUTE_PATHS:
            for fragment in FORBIDDEN_PATH_FRAGMENTS:
                self.assertNotIn(fragment, path)

    def test_phase7_exposes_only_declared_mutations(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))

        for route in app.routes:
            methods = getattr(route, "methods", None) or set()
            if methods & {"POST", "DELETE", "PATCH"}:
                self.assertTrue(route.path.startswith("/api/scenarios"), route.path)
            else:
                self.assertFalse({"POST", "PUT", "PATCH", "DELETE"} & methods, route.path)

    async def test_business_paths_are_not_routable(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        for fragment in FORBIDDEN_PATH_FRAGMENTS:
            self.assertEqual(404, (await asgi_get(app, fragment)).status_code)
            self.assertEqual(404, (await asgi_post(app, fragment, json={})).status_code)

    def test_model_name_is_a_literal_constant(self) -> None:
        self.assertEqual((MODEL_NAME,), get_args(ModelName))
        self.assertEqual("qwen3:4b", MODEL_NAME)

    async def test_environment_cannot_change_the_model(self) -> None:
        settings = Settings.from_env(
            {
                "ROBOROUTE_MODEL_NAME": "llama3:8b",
                "ROBOROUTE_OLLAMA_MODEL": "llama3:8b",
                "OLLAMA_MODEL": "llama3:8b",
            }
        )
        self.assertNotIn("model", {field.name for field in fields(settings)})

        app, _ = build_app(handler_with_paths(models_payload("llama3:8b"), models_payload()))
        payload = (await asgi_get(app, "/api/ai/status")).json()
        self.assertEqual("qwen3:4b", payload["modelName"])

    def test_approved_inference_defaults_are_frozen_in_code(self) -> None:
        self.assertEqual(8192, NUM_CTX)
        self.assertFalse(THINK)
        self.assertEqual(0.2, CHAT_TEMPERATURE)
        self.assertEqual(0.0, REPORT_TEMPERATURE)

    def test_default_module_application_serves_the_phase_1_surface(self) -> None:
        paths = {route.path for route in main_module.app.routes}
        self.assertEqual(EXPECTED_PRODUCT_ROUTES, paths - DOC_ROUTE_PATHS)
        self.assertEqual(
            Settings.from_env({}).ollama_base_url,
            main_module.app.state.ollama_probe.base_url,
        )


if __name__ == "__main__":
    unittest.main()
