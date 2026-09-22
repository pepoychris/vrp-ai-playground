"""Starting the API must not download, load or generate anything."""

from __future__ import annotations

import unittest

from api.app.config import MODEL_NAME
from api.tests.support import (
    asgi_get,
    build_app,
    forbidden_operations,
    handler_with_paths,
    models_payload,
    run_lifespan,
)


class StartupSideEffectTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_startup_performs_no_outbound_request(self) -> None:
        app, transport = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload(MODEL_NAME))
        )
        messages = await run_lifespan(app)

        self.assertEqual(
            ["lifespan.startup.complete", "lifespan.shutdown.complete"],
            [message["type"] for message in messages],
        )
        self.assertEqual([], transport.requests)

    async def test_only_read_endpoints_are_called(self) -> None:
        app, transport = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload(MODEL_NAME))
        )
        await asgi_get(app, "/health")
        await asgi_get(app, "/api/ai/status")
        await asgi_get(app, "/api/ai/status")

        self.assertTrue(transport.requests, "the status endpoint must probe Ollama")
        self.assertEqual({"/api/tags", "/api/ps"}, set(transport.requested_paths))
        self.assertEqual({"GET"}, set(transport.requested_methods))

    async def test_no_download_or_inference_route_is_ever_requested(self) -> None:
        app, transport = build_app(
            handler_with_paths(models_payload(MODEL_NAME), models_payload())
        )
        await asgi_get(app, "/api/ai/status")

        for request in transport.requests:
            for operation in forbidden_operations():
                self.assertNotIn(operation, request.url.path)


if __name__ == "__main__":
    unittest.main()
