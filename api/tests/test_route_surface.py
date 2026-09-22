"""The HTTP surface must match the frozen contract, no more and no less."""

from __future__ import annotations

import json
import unittest
from dataclasses import fields
from typing import get_args

from api.app import main as main_module
from api.app.config import (
    ACTIVATE_KEEP_ALIVE,
    CHAT_KEEP_ALIVE,
    CHAT_TEMPERATURE,
    MODEL_NAME,
    NUM_CTX,
    REPORT_TEMPERATURE,
    THINK,
    ModelName,
    Settings,
)
from api.tests.support import (
    CONTRACTS_DIR,
    asgi_get,
    asgi_post,
    build_app,
    handler_with_paths,
    models_payload,
)

DOC_ROUTE_PATHS = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
# ``GET /health`` is an infrastructure probe the frozen contract does not describe; its
# shape is documented in the repository README.
INFRASTRUCTURE_PATHS = {"/health"}
# Endpoint 12 is declared but deliberately unimplemented: scenario telemetry streaming is a
# later phase's work, and Phase 8 does not add it.
KNOWN_UNIMPLEMENTED = {"/api/scenarios/{scenario_id}/events"}

PATH_PARAMETER_NAMES = {
    "{scenarioId}": "{scenario_id}",
    "{vehicleId}": "{vehicle_id}",
    "{barrierId}": "{barrier_id}",
    "{proposalId}": "{proposal_id}",
}

# AI routes whose absence is the point: no tool calling, no RAG, no model picker.
UNDECLARED_AI_PATHS = (
    "/api/ai/models",
    "/api/ai/tools",
    "/api/ai/embed",
    "/api/ai/pull",
    "/api/ai/generate",
    "/api/ai/model/delete",
    "/api/ai/model/install/status",
)


def declared_endpoints() -> list[dict[str, object]]:
    document = json.loads((CONTRACTS_DIR / "endpoints.json").read_text(encoding="utf-8"))
    return list(document["endpoints"])


def fastapi_path(contract_path: str) -> str:
    resolved = contract_path
    for contract_name, fastapi_name in PATH_PARAMETER_NAMES.items():
        resolved = resolved.replace(contract_name, fastapi_name)
    return resolved


class RouteSurfaceTests(unittest.IsolatedAsyncioTestCase):
    def test_exposes_exactly_the_declared_product_routes(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        paths = {route.path for route in app.routes}

        self.assertTrue(DOC_ROUTE_PATHS <= paths, "FastAPI documentation routes are expected")
        declared = {fastapi_path(str(entry["path"])) for entry in declared_endpoints()}
        self.assertEqual(
            declared - KNOWN_UNIMPLEMENTED,
            paths - DOC_ROUTE_PATHS - INFRASTRUCTURE_PATHS,
        )

    def test_every_mutation_is_declared_in_the_contract(self) -> None:
        """No endpoint may mutate state without being declared in endpoints.json."""
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        declared = {
            (str(entry["method"]), fastapi_path(str(entry["path"])))
            for entry in declared_endpoints()
        }

        mutating = [
            route
            for route in app.routes
            if (getattr(route, "methods", None) or set()) & {"POST", "PUT", "PATCH", "DELETE"}
        ]
        self.assertTrue(mutating, "the product has mutating endpoints")
        for route in mutating:
            for method in route.methods & {"POST", "PUT", "PATCH", "DELETE"}:
                with self.subTest(method=method, path=route.path):
                    self.assertIn((method, route.path), declared)

    def test_read_only_routes_are_declared_too(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        declared = {fastapi_path(str(entry["path"])) for entry in declared_endpoints()}

        for route in app.routes:
            methods = getattr(route, "methods", None) or set()
            if methods & {"POST", "PUT", "PATCH", "DELETE"}:
                continue
            if route.path in DOC_ROUTE_PATHS | INFRASTRUCTURE_PATHS:
                continue
            self.assertIn(route.path, declared)

    async def test_undeclared_ai_paths_are_not_routable(self) -> None:
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))
        for path in UNDECLARED_AI_PATHS:
            self.assertEqual(404, (await asgi_get(app, path)).status_code, path)
            self.assertEqual(404, (await asgi_post(app, path, json={})).status_code, path)

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
        # Phase 8 pins the preload windows as well: they are backend decisions, never
        # request parameters.
        self.assertEqual("30m", ACTIVATE_KEEP_ALIVE)
        self.assertEqual("10m", CHAT_KEEP_ALIVE)

    def test_default_module_application_serves_the_same_surface(self) -> None:
        paths = {route.path for route in main_module.app.routes}
        app, _ = build_app(handler_with_paths(models_payload(), models_payload()))

        self.assertEqual(
            {route.path for route in app.routes} - DOC_ROUTE_PATHS,
            paths - DOC_ROUTE_PATHS,
        )
        self.assertEqual(
            Settings.from_env({}).ollama_base_url,
            main_module.app.state.ollama_probe.base_url,
        )


if __name__ == "__main__":
    unittest.main()
