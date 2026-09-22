"""Phase 8 model install: idempotency, recoverable progress and activation."""

from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

from api.app.config import ACTIVATE_KEEP_ALIVE, MODEL_NAME, NUM_CTX, THINK
from api.tests.support import (
    FakeOllama,
    asgi_get,
    asgi_post,
    build_ai_app,
    build_app,
    handler_with_paths,
    models_payload,
    offline_handler,
    request_json,
    run_lifespan,
    schema_validator,
)


def sse_frames(text: str) -> list[dict[str, Any]]:
    """Parse an SSE body into ``{"event": ..., "data": ...}`` records."""
    frames: list[dict[str, Any]] = []
    for block in text.split("\n\n"):
        lines = [line for line in block.splitlines() if line and not line.startswith(":")]
        name = next((line[len("event: ") :] for line in lines if line.startswith("event: ")), None)
        data = next((line[len("data: ") :] for line in lines if line.startswith("data: ")), None)
        if name is None or data is None:
            continue
        frames.append({"event": name, "data": json.loads(data)})
    return frames


def event_schema_validator() -> Any | None:
    return schema_validator("events.schema.json", "#/$defs/aiInstallEvent")


class InstallIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_and_import_download_nothing(self) -> None:
        fake = FakeOllama()
        app, transport = build_ai_app(fake)

        messages = await run_lifespan(app)

        self.assertEqual(
            ["lifespan.startup.complete", "lifespan.shutdown.complete"],
            [message["type"] for message in messages],
        )
        self.assertEqual([], transport.requests)
        self.assertEqual([], fake.pull_bodies)

    async def test_a_new_install_starts_one_background_pull(self) -> None:
        fake = FakeOllama()
        app, transport = build_ai_app(fake)

        response = await asgi_post(app, "/api/ai/model/install", json={})

        self.assertEqual(202, response.status_code)
        payload = response.json()
        self.assertEqual("DOWNLOADING", payload["state"])
        self.assertEqual(MODEL_NAME, payload["modelName"])
        self.assertIsNone(payload["finishedAt"])
        self.assertTrue(payload["jobId"])

        await app.state.ai.install.wait_idle()

        # The frozen model is the only one the transport was asked to pull.
        self.assertEqual(
            {"model": MODEL_NAME, "stream": True}, request_json(transport, "/api/pull")
        )
        self.assertEqual([MODEL_NAME], sorted(fake.installed))

    async def test_an_installed_model_answers_completed_and_pulls_nothing(self) -> None:
        fake = FakeOllama(installed=[MODEL_NAME])
        app, _ = build_ai_app(fake)

        response = await asgi_post(app, "/api/ai/model/install", json={})

        self.assertEqual(200, response.status_code)
        self.assertEqual("COMPLETED", response.json()["state"])
        self.assertEqual([], fake.pull_bodies)

    async def test_a_second_request_while_downloading_answers_the_running_job(self) -> None:
        gate = asyncio.Event()
        fake = FakeOllama(pull_gate=gate)
        app, transport = build_ai_app(fake)

        first = await asgi_post(app, "/api/ai/model/install", json={})
        second = await asgi_post(app, "/api/ai/model/install", json={})

        self.assertEqual(202, first.status_code)
        self.assertEqual(200, second.status_code, "an in-flight download is not a new one")
        self.assertEqual(first.json()["jobId"], second.json()["jobId"])
        self.assertEqual("DOWNLOADING", second.json()["state"])
        self.assertEqual(
            1, len(fake.pull_bodies), "the backend must never run two pulls at once"
        )
        self.assertEqual(["/api/pull"], [r.url.path for r in transport.requests if r.method == "POST"])

        gate.set()
        await app.state.ai.install.wait_idle()
        self.assertIn(MODEL_NAME, fake.installed)

    async def test_unreachable_service_answers_the_frozen_503(self) -> None:
        app, _ = build_app(offline_handler)

        response = await asgi_post(app, "/api/ai/model/install", json={})

        self.assertEqual(503, response.status_code)
        body = response.json()
        self.assertEqual("AI_SERVICE_UNAVAILABLE", body["error"]["code"])
        self.assertTrue(body["error"]["retryable"])

    async def test_the_install_body_cannot_choose_a_model(self) -> None:
        fake = FakeOllama()
        app, _ = build_ai_app(fake)

        for body, code in (
            ({"model": "llama3:8b"}, "MODEL_OVERRIDE_FORBIDDEN"),
            ({"keep_alive": "1h"}, "MODEL_OVERRIDE_FORBIDDEN"),
            ({"think": True}, "MODEL_OVERRIDE_FORBIDDEN"),
            ({"options": {"num_ctx": 4096}}, "MODEL_OVERRIDE_FORBIDDEN"),
        ):
            with self.subTest(body=body):
                response = await asgi_post(app, "/api/ai/model/install", json=body)
                self.assertEqual(400, response.status_code)
                self.assertEqual(code, response.json()["error"]["code"])
        self.assertEqual([], fake.pull_bodies)

    async def test_an_unknown_field_is_a_validation_error(self) -> None:
        fake = FakeOllama()
        app, _ = build_ai_app(fake)

        response = await asgi_post(app, "/api/ai/model/install", json={"gpu": True})

        self.assertEqual(400, response.status_code)
        self.assertEqual("VALIDATION_ERROR", response.json()["error"]["code"])


class InstallProgressStreamTests(unittest.IsolatedAsyncioTestCase):
    validator: Any | None = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.validator = event_schema_validator()

    async def test_progress_streams_normalized_frames_and_closes(self) -> None:
        gate = asyncio.Event()
        fake = FakeOllama(pull_gate=gate)
        app, _ = build_ai_app(fake)
        started = await asgi_post(app, "/api/ai/model/install", json={})
        self.assertEqual(202, started.status_code)

        # Connect while the download is still running, then let it finish.
        streaming = asyncio.ensure_future(asgi_get(app, "/api/ai/model/install/events"))
        await asyncio.sleep(0.05)
        gate.set()
        response = await asyncio.wait_for(streaming, timeout=10)

        self.assertEqual(200, response.status_code)
        self.assertEqual("text/event-stream", response.headers["content-type"].split(";")[0])
        frames = sse_frames(response.text)
        installs = [frame["data"] for frame in frames if frame["event"] == "ai.install"]

        states = [frame["payload"]["state"] for frame in installs]
        self.assertEqual("DOWNLOADING", states[0])
        self.assertIn("VERIFYING", states)
        self.assertEqual("COMPLETED", states[-1])

        # The example pins the wire shape of a mid-download frame: a normalized percent and
        # the raw Ollama status text, never Ollama's own key names.
        downloading = next(
            frame for frame in installs if frame["payload"]["percent"] == 42.5
        )
        self.assertEqual(MODEL_NAME, downloading["payload"]["modelName"])
        self.assertEqual("pulling 3e4cb1417446", downloading["payload"]["statusText"])
        self.assertIsNone(downloading["payload"]["error"])
        self.assertIsNone(downloading["scenarioRevision"])
        self.assertIsNone(downloading["commandId"])

        sequences = [frame["data"]["eventSeq"] for frame in frames]
        self.assertEqual(sorted(sequences), sequences, "eventSeq must be monotonic")
        self.assertTrue(all(frame["event"] == "ai.status" for frame in frames if frame["event"] != "ai.install"))

        if self.validator is None:
            self.skipTest("jsonschema is not installed; install api/requirements-dev.txt")
        for frame in installs:
            self.assertEqual([], list(self.validator.iter_errors(frame)))

    async def test_a_failed_download_is_reported_and_can_be_retried(self) -> None:
        fake = FakeOllama(pull_error=RuntimeError("connection reset"), pull_installs=False)
        app, _ = build_ai_app(fake)
        await asgi_post(app, "/api/ai/model/install", json={})
        await app.state.ai.install.wait_idle()

        # Reconnecting after the failure replays it: the client recovers the reason.
        failed = sse_frames((await asgi_get(app, "/api/ai/model/install/events")).text)
        terminal = [frame["data"] for frame in failed if frame["event"] == "ai.install"][-1]
        self.assertEqual("FAILED", terminal["payload"]["state"])
        self.assertIn("connection reset", terminal["payload"]["error"])

        # A retry is a new job, and this time the pull succeeds.
        fake.pull_error = None
        fake.pull_installs = True
        retry = await asgi_post(app, "/api/ai/model/install", json={})
        self.assertEqual(202, retry.status_code)
        await app.state.ai.install.wait_idle()
        recovered = sse_frames((await asgi_get(app, "/api/ai/model/install/events")).text)
        states = [
            frame["data"]["payload"]["state"]
            for frame in recovered
            if frame["event"] == "ai.install"
        ]
        self.assertEqual("COMPLETED", states[-1])
        self.assertEqual(2, len(fake.pull_bodies))

    async def test_nothing_requested_and_service_down_is_a_503(self) -> None:
        app, _ = build_app(offline_handler)

        response = await asgi_get(app, "/api/ai/model/install/events")

        self.assertEqual(503, response.status_code)
        self.assertEqual("AI_SERVICE_UNAVAILABLE", response.json()["error"]["code"])

    async def test_an_idle_stream_reports_idle_without_starting_a_download(self) -> None:
        fake = FakeOllama()
        app, _ = build_ai_app(fake)

        streaming = asyncio.ensure_future(asgi_get(app, "/api/ai/model/install/events"))
        await asyncio.sleep(0.05)
        # Nothing asked for a download, so the pull is still unrequested.
        self.assertEqual([], fake.pull_bodies)
        streaming.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await streaming


class ActivationTests(unittest.IsolatedAsyncioTestCase):
    async def test_activate_preloads_the_fixed_model_with_the_frozen_options(self) -> None:
        fake = FakeOllama(installed=[MODEL_NAME])
        app, transport = build_ai_app(fake)

        response = await asgi_post(app, "/api/ai/activate", json={})

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            {
                "serviceAvailable": True,
                "modelInstalled": True,
                "modelLoaded": True,
                "modelName": MODEL_NAME,
                "installJob": None,
            },
            response.json(),
        )
        body = request_json(transport, "/api/generate")
        self.assertEqual(MODEL_NAME, body["model"])
        self.assertEqual(ACTIVATE_KEEP_ALIVE, body["keep_alive"])
        self.assertEqual(THINK, body["think"])
        self.assertEqual("", body["prompt"])
        self.assertFalse(body["stream"])

    async def test_activate_without_the_model_is_a_conflict(self) -> None:
        fake = FakeOllama(installed=["llama3:8b"])
        app, _ = build_ai_app(fake)

        response = await asgi_post(app, "/api/ai/activate", json={})

        self.assertEqual(409, response.status_code)
        self.assertEqual("AI_MODEL_NOT_INSTALLED", response.json()["error"]["code"])
        self.assertEqual([], fake.generate_bodies)

    async def test_activate_rejects_inference_overrides(self) -> None:
        fake = FakeOllama(installed=[MODEL_NAME])
        app, _ = build_ai_app(fake)

        response = await asgi_post(
            app, "/api/ai/activate", json={"options": {"num_ctx": NUM_CTX * 4}}
        )

        self.assertEqual(400, response.status_code)
        self.assertEqual("MODEL_OVERRIDE_FORBIDDEN", response.json()["error"]["code"])
        self.assertEqual([], fake.generate_bodies)

    async def test_unreachable_service_is_a_503(self) -> None:
        app, _ = build_app(offline_handler)

        response = await asgi_post(app, "/api/ai/activate", json={})

        self.assertEqual(503, response.status_code)
        self.assertEqual("AI_SERVICE_UNAVAILABLE", response.json()["error"]["code"])

    async def test_status_reports_the_install_job_once_one_exists(self) -> None:
        fake = FakeOllama(installed=[MODEL_NAME])
        app, _ = build_ai_app(fake)
        await asgi_post(app, "/api/ai/model/install", json={})

        payload = (await asgi_get(app, "/api/ai/status")).json()

        self.assertEqual("COMPLETED", payload["installJob"]["state"])
        self.assertEqual(MODEL_NAME, payload["installJob"]["modelName"])


class StatusContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_phase_1_status_behaviour_is_unchanged(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
