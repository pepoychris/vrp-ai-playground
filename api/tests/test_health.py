"""``GET /health`` stays a pure local probe."""

from __future__ import annotations

import unittest

from api.app.config import SERVICE_NAME, SERVICE_VERSION
from api.tests.support import asgi_get, build_app, offline_handler


class HealthEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_service_identity(self) -> None:
        app, _ = build_app(offline_handler)
        response = await asgi_get(app, "/health")

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {"status": "ok", "service": SERVICE_NAME, "version": SERVICE_VERSION},
            response.json(),
        )
        self.assertTrue(response.headers["content-type"].startswith("application/json"))

    async def test_does_not_touch_ollama(self) -> None:
        app, transport = build_app(offline_handler)
        await asgi_get(app, "/health")
        await asgi_get(app, "/health")

        self.assertEqual([], transport.requested_paths)


if __name__ == "__main__":
    unittest.main()
