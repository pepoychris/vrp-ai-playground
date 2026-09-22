"""``GET /api/ai/status`` honours the frozen ``aiStatus`` contract."""

from __future__ import annotations

import json
import unittest
from typing import Any

from api.app.config import MODEL_NAME
from api.tests.support import (
    CONTRACTS_DIR,
    asgi_get,
    build_app,
    handler_with_paths,
    models_payload,
    offline_handler,
)

EXPECTED_KEYS = {"serviceAvailable", "modelInstalled", "modelLoaded", "modelName", "installJob"}


def contract_validator() -> Any | None:
    """Validator for ``envelopes.schema.json#/$defs/aiStatus``.

    ``jsonschema`` is a development dependency, so a missing install skips the
    contract test instead of failing the suite. Building it here (outside any
    coroutine) keeps the async test itself cheap.
    """
    try:
        import jsonschema
    except ImportError:  # pragma: no cover - dev dependency
        return None
    envelopes = json.loads(
        (CONTRACTS_DIR / "schemas" / "envelopes.schema.json").read_text(encoding="utf-8")
    )
    # Root-level $ref, so the internal "#/$defs/..." references of aiStatus resolve.
    return jsonschema.Draft202012Validator({"$ref": "#/$defs/aiStatus", **envelopes})


class AiStatusTests(unittest.IsolatedAsyncioTestCase):
    validator: Any | None = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.validator = contract_validator()

    async def test_reports_reachable_service_with_installed_and_loaded_model(self) -> None:
        app, _ = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload(MODEL_NAME))
        )
        payload = (await asgi_get(app, "/api/ai/status")).json()

        self.assertEqual(
            {
                "serviceAvailable": True,
                "modelInstalled": True,
                "modelLoaded": True,
                "modelName": MODEL_NAME,
                "installJob": None,
            },
            payload,
        )

    async def test_service_up_without_the_model_reports_not_installed(self) -> None:
        app, _ = build_app(
            handler_with_paths(models_payload("llama3:8b"), models_payload())
        )
        payload = (await asgi_get(app, "/api/ai/status")).json()

        self.assertTrue(payload["serviceAvailable"])
        self.assertFalse(payload["modelInstalled"])
        self.assertFalse(payload["modelLoaded"])
        self.assertEqual(MODEL_NAME, payload["modelName"])

    async def test_loaded_model_without_tags_still_counts_as_installed_false(self) -> None:
        app, _ = build_app(
            handler_with_paths({"models": "not-an-array"}, models_payload(MODEL_NAME))
        )
        payload = (await asgi_get(app, "/api/ai/status")).json()

        self.assertTrue(payload["serviceAvailable"])
        self.assertFalse(payload["modelInstalled"])
        self.assertTrue(payload["modelLoaded"])

    async def test_unreachable_service_is_reported_instead_of_raising(self) -> None:
        app, transport = build_app(offline_handler)
        response = await asgi_get(app, "/api/ai/status")

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "serviceAvailable": False,
                "modelInstalled": False,
                "modelLoaded": False,
                "modelName": MODEL_NAME,
                "installJob": None,
            },
            response.json(),
        )
        self.assertEqual(["/api/ps", "/api/tags"], sorted(transport.requested_paths))

    async def test_request_cannot_override_the_model(self) -> None:
        app, transport = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload())
        )
        response = await asgi_get(
            app,
            "/api/ai/status",
            params={"model": "llama3:8b", "think": "true", "num_ctx": "4096"},
            headers={"x-model-override": "llama3:8b"},
        )

        self.assertEqual(MODEL_NAME, response.json()["modelName"])
        for request in transport.requests:
            self.assertNotIn("model", request.url.params)
            self.assertNotIn("x-model-override", request.headers)

    async def test_response_matches_the_frozen_json_schema(self) -> None:
        app, _ = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload())
        )
        payload = (await asgi_get(app, "/api/ai/status")).json()

        self.assertEqual(EXPECTED_KEYS, set(payload))
        if self.validator is None:
            self.skipTest("jsonschema is not installed; install api/requirements-dev.txt")
        self.assertEqual(
            [],
            list(self.validator.iter_errors(payload)),
            "response must satisfy envelopes.schema.json#/$defs/aiStatus",
        )


if __name__ == "__main__":
    unittest.main()
