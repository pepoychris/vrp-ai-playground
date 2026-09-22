"""Phase 8 copilot: grounded chat, validated reports and the human proposal gate."""

from __future__ import annotations

import json
import unittest
from typing import Any
from uuid import uuid4

from api.app.ai import (
    build_snapshot_context,
    grounded_references,
    report_markdown,
)
from api.app.ollama_client import normalize_pull_event as normalize_pull_event_of
from api.app.config import (
    AI_REPORT_SCHEMA_VERSION,
    CHAT_KEEP_ALIVE,
    CHAT_TEMPERATURE,
    MODEL_NAME,
    NUM_CTX,
    REPORT_TEMPERATURE,
    THINK,
)
from api.tests.support import (
    FakeOllama,
    asgi_get,
    asgi_post,
    build_ai_app,
    build_app,
    offline_handler,
    request_json,
    schema_validator,
)

GROUNDED_ANSWER = json.dumps(
    {
        "answer": (
            "La ruta de R-01 se recalculo tras la intervencion. El coste economico del "
            "plan vigente es el que aparece en kpis.economicCostCents."
        ),
        "references": [
            "kpis.economicCostCents",
            "routePlan.vehicles[0].distanceMeters",
            "kpis.metricaInventada",
            "vehiculos[7].estado",
        ],
    }
)


def command_id() -> str:
    return str(uuid4())


async def ready_scenario(app: Any, *, vehicles: int = 2, orders: int = 6) -> dict[str, Any]:
    """Create, populate and optimise one scenario through the public API."""
    created = await asgi_post(app, "/api/scenarios", json={"seed": 20260922})
    scenario_id = created.json()["scenarioId"]
    await asgi_post(
        app, f"/api/scenarios/{scenario_id}/vehicles/generate", json={"count": vehicles}
    )
    await asgi_post(
        app, f"/api/scenarios/{scenario_id}/orders/generate", json={"count": orders}
    )
    optimized = await asgi_post(app, f"/api/scenarios/{scenario_id}/optimize", json={})
    return optimized.json()


def loaded_fake(**kwargs: Any) -> FakeOllama:
    return FakeOllama(installed=[MODEL_NAME], loaded=[MODEL_NAME], **kwargs)


class ChatTests(unittest.IsolatedAsyncioTestCase):
    validator: Any | None = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.validator = schema_validator("envelopes.schema.json", "#/$defs/aiChatResponse")

    async def test_answers_from_the_snapshot_and_cites_only_grounded_fields(self) -> None:
        fake = loaded_fake(chat_replies=[GROUNDED_ANSWER])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "¿por que cambio la ruta de R-01?"}],
            },
        )

        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual(snapshot["scenarioRevision"], payload["usedRevision"])
        self.assertEqual(
            ["kpis.economicCostCents", "routePlan.vehicles[0].distanceMeters"],
            payload["references"],
            "a citation to a field that was never sent must be dropped",
        )
        self.assertIsNone(payload["proposal"])
        # Ollama's nanosecond timings land in the contract as milliseconds.
        self.assertEqual(
            {"total": 2841, "load": 120, "promptEval": 610, "eval": 2100},
            payload["timingsMs"],
        )
        if self.validator is None:
            self.skipTest("jsonschema is not installed; install api/requirements-dev.txt")
        self.assertEqual([], list(self.validator.iter_errors(payload)))

    async def test_sends_only_the_fixed_model_options_and_grounded_context(self) -> None:
        fake = loaded_fake(chat_replies=[GROUNDED_ANSWER])
        app, transport = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "resume el plan"}],
            },
        )

        body = request_json(transport, "/api/chat")
        self.assertEqual(MODEL_NAME, body["model"])
        self.assertFalse(body["think"])
        self.assertFalse(body["stream"])
        self.assertEqual(CHAT_KEEP_ALIVE, body["keep_alive"])
        self.assertEqual(
            {"temperature": CHAT_TEMPERATURE, "num_ctx": NUM_CTX}, body["options"]
        )
        self.assertIn("format", body, "structured output keeps the answer parseable")

        context_message = body["messages"][1]["content"]
        self.assertIn("scenarioRevision", context_message)
        # The immutable road graph is never sent: it is large and irrelevant here.
        self.assertNotIn("robot-city", context_message)
        self.assertNotIn("edgeSequence", context_message)

    async def test_inference_overrides_are_refused_before_any_model_call(self) -> None:
        fake = loaded_fake(chat_replies=[GROUNDED_ANSWER])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)
        base: dict[str, Any] = {
            "scenarioId": snapshot["scenarioId"],
            "commandId": command_id(),
            "scenarioRevision": snapshot["scenarioRevision"],
            "messages": [{"role": "user", "content": "hola"}],
        }

        for override in (
            {"model": "llama3:8b"},
            {"think": True},
            {"options": {"num_ctx": 4096}},
            {"keep_alive": "1h"},
        ):
            with self.subTest(override=override):
                response = await asgi_post(app, "/api/ai/chat", json={**base, **override})
                self.assertEqual(400, response.status_code)
                self.assertEqual(
                    "MODEL_OVERRIDE_FORBIDDEN", response.json()["error"]["code"]
                )
        self.assertEqual([], fake.chat_bodies, "the model must not be called at all")

    async def test_the_envelope_is_validated(self) -> None:
        fake = loaded_fake(chat_replies=[GROUNDED_ANSWER])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)
        body = {
            "scenarioId": snapshot["scenarioId"],
            "scenarioRevision": snapshot["scenarioRevision"],
            "messages": [{"role": "user", "content": "hola"}],
        }

        for broken in (
            {**body},
            {**body, "commandId": "not-a-uuid"},
            # A v1 UUID: the version nibble is the character after the second dash.
            {**body, "commandId": f"{str(uuid4())[:14]}1{str(uuid4())[15:]}"},
            {**body, "commandId": command_id(), "messages": []},
            {**body, "commandId": command_id(), "messages": [{"role": "robot", "content": "x"}]},
        ):
            with self.subTest(broken=broken):
                response = await asgi_post(app, "/api/ai/chat", json=broken)
                self.assertEqual(400, response.status_code)
                self.assertEqual("VALIDATION_ERROR", response.json()["error"]["code"])
        self.assertEqual([], fake.chat_bodies)

    async def test_the_model_must_be_installed_and_loaded_first(self) -> None:
        app, _ = build_ai_app(FakeOllama(installed=[MODEL_NAME]))
        snapshot = await ready_scenario(app)
        body = {
            "scenarioId": snapshot["scenarioId"],
            "commandId": command_id(),
            "scenarioRevision": snapshot["scenarioRevision"],
            "messages": [{"role": "user", "content": "hola"}],
        }

        response = await asgi_post(app, "/api/ai/chat", json=body)
        self.assertEqual(409, response.status_code)
        self.assertEqual("AI_MODEL_NOT_LOADED", response.json()["error"]["code"])

        missing, _ = build_ai_app(FakeOllama())
        missing_snapshot = await ready_scenario(missing)
        response = await asgi_post(
            missing,
            "/api/ai/chat",
            json={**body, "scenarioId": missing_snapshot["scenarioId"]},
        )
        self.assertEqual(409, response.status_code)
        self.assertEqual("AI_MODEL_NOT_INSTALLED", response.json()["error"]["code"])

    async def test_an_unknown_scenario_is_a_404(self) -> None:
        fake = loaded_fake(chat_replies=[GROUNDED_ANSWER])
        app, _ = build_ai_app(fake)

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": str(uuid4()),
                "commandId": command_id(),
                "scenarioRevision": 1,
                "messages": [{"role": "user", "content": "hola"}],
            },
        )

        self.assertEqual(404, response.status_code)
        self.assertEqual("SCENARIO_NOT_FOUND", response.json()["error"]["code"])

    async def test_unreachable_service_is_a_503(self) -> None:
        app, _ = build_app(offline_handler)

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": str(uuid4()),
                "commandId": command_id(),
                "scenarioRevision": 1,
                "messages": [{"role": "user", "content": "hola"}],
            },
        )

        self.assertEqual(503, response.status_code)
        self.assertEqual("AI_SERVICE_UNAVAILABLE", response.json()["error"]["code"])

    async def test_malformed_model_output_is_a_502(self) -> None:
        app, _ = build_ai_app(loaded_fake(chat_replies=["no soy json"]))
        snapshot = await ready_scenario(app)
        body = {
            "scenarioId": snapshot["scenarioId"],
            "commandId": command_id(),
            "scenarioRevision": snapshot["scenarioRevision"],
            "messages": [{"role": "user", "content": "hola"}],
        }

        response = await asgi_post(app, "/api/ai/chat", json=body)
        self.assertEqual(502, response.status_code)
        self.assertEqual("AI_OUTPUT_INVALID", response.json()["error"]["code"])

        broken, _ = build_ai_app(
            loaded_fake(chat_replies=[json.dumps({"answer": "", "references": []})])
        )
        broken_snapshot = await ready_scenario(broken)
        response = await asgi_post(
            broken,
            "/api/ai/chat",
            json={**body, "scenarioId": broken_snapshot["scenarioId"]},
        )
        self.assertEqual(502, response.status_code)
        self.assertEqual("AI_OUTPUT_INVALID", response.json()["error"]["code"])

    async def test_hidden_reasoning_is_never_returned(self) -> None:
        fake = loaded_fake(
            chat_replies=[GROUNDED_ANSWER],
            chat_thinking="primero cuento las barreras y luego divido entre dos",
        )
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "hola"}],
            },
        )

        self.assertNotIn("thinking", response.text)
        self.assertNotIn("primero cuento", response.text)
        self.assertEqual(
            {"answer", "usedRevision", "references", "proposal", "timingsMs"},
            set(response.json()),
        )

    async def test_the_frozen_example_keeps_every_citation_grounded(self) -> None:
        from api.tests.support import CONTRACTS_DIR

        example = json.loads(
            (CONTRACTS_DIR / "examples" / "ai-chat-response.example.json").read_text(
                encoding="utf-8"
            )
        )
        # The fixture is a full response; the model only ever produces the answer, the
        # citations and the proposal fields, so feed exactly that back through the API.
        model_reply = json.dumps(
            {
                "answer": example["answer"],
                "references": example["references"],
                "proposal": {
                    "kind": example["proposal"]["kind"],
                    "summary": example["proposal"]["summary"],
                    "payload": example["proposal"]["payload"],
                },
            }
        )
        fake = loaded_fake(chat_replies=[model_reply])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)
        # The fixture cites the KPI delta of the *last intervention*, so the scenario needs
        # one: a closure re-plans and publishes the before/after comparison.
        closed = await asgi_post(
            app,
            f"/api/scenarios/{snapshot['scenarioId']}/barriers",
            json={
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "edgeId": "E-N001-N002",
            },
        )
        self.assertEqual(200, closed.status_code)
        snapshot = closed.json()

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "¿por que cambio la ruta de R-01?"}],
            },
        )

        payload = response.json()
        self.assertEqual(200, response.status_code)
        # `routePlan.vehicles[0]` exists after an optimisation, `blockedEdgeIds` always
        # does, and the KPI paths exist once a plan and an intervention have happened.
        self.assertEqual(
            [
                "routePlan.vehicles[0].distanceMeters",
                "blockedEdgeIds",
                "kpis.lastIntervention.delta.distanceTotalMeters",
                "kpis.economicCostCents",
            ],
            payload["references"],
        )
        self.assertEqual("PENDING", payload["proposal"]["status"])
        self.assertEqual("REQUEST_REOPTIMIZATION", payload["proposal"]["kind"])
        self.assertEqual(snapshot["scenarioRevision"], payload["proposal"]["revisionToApply"])


class ProposalGateTests(unittest.IsolatedAsyncioTestCase):
    async def scenario_with_proposal(self, proposal: dict[str, Any]) -> tuple[Any, Any, dict[str, Any]]:
        fake = loaded_fake(
            chat_replies=[
                json.dumps(
                    {
                        "answer": "Propongo retirar un robot del plan.",
                        "references": ["kpis.economicCostCents"],
                        "proposal": proposal,
                    }
                )
            ]
        )
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)
        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "¿que hago con R-01?"}],
            },
        )
        return app, snapshot, response.json()

    async def test_nothing_is_applied_before_a_human_confirms(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "SET_VEHICLE_UNAVAILABLE",
                "summary": "Retirar R-01 del plan por bateria baja.",
                "payload": {"vehicleId": "R-01"},
            }
        )
        proposal = chat["proposal"]
        self.assertEqual("PENDING", proposal["status"])

        after_chat = (await asgi_get(app, f"/api/scenarios/{snapshot['scenarioId']}")).json()
        self.assertEqual(
            snapshot["scenarioRevision"],
            after_chat["scenarioRevision"],
            "asking the copilot must never mutate the scenario",
        )
        self.assertEqual(
            snapshot["vehicles"][0]["status"], after_chat["vehicles"][0]["status"]
        )

        confirmed = await asgi_post(
            app,
            f"/api/ai/proposals/{proposal['proposalId']}/confirm",
            json={"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]},
        )

        self.assertEqual(200, confirmed.status_code)
        result = confirmed.json()
        self.assertEqual(snapshot["scenarioRevision"] + 1, result["scenarioRevision"])
        self.assertEqual("PROPOSAL_CONFIRMED", result["appliedCommand"]["kind"])
        self.assertFalse(result["appliedCommand"]["replayed"])
        vehicle = next(item for item in result["vehicles"] if item["vehicleId"] == "R-01")
        self.assertEqual("BLOCKED", vehicle["status"])
        self.assertEqual([], vehicle["assignedOrderIds"])
        route = next(
            item for item in result["routePlan"]["vehicles"] if item["vehicleId"] == "R-01"
        )
        self.assertEqual([], route["stops"], "an unavailable robot takes no stop")
        # The plan keeps the fleet order, so an index always means the same robot.
        self.assertEqual(
            ["R-01", "R-02"], [item["vehicleId"] for item in result["routePlan"]["vehicles"]]
        )
        # One revision, and the plan in it describes the mutated fleet.
        self.assertEqual(result["routePlan"]["scenarioRevision"], result["scenarioRevision"])
        self.assertEqual(result["kpis"]["scenarioRevision"], result["scenarioRevision"])
        self.assertEqual(
            "PROPOSAL_CONFIRMED", result["kpis"]["lastIntervention"]["kind"]
        )

    async def test_confirmation_is_idempotent_and_single_revision(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "DELAY_VEHICLE",
                "summary": "Retrasar R-02.",
                "payload": {"vehicleId": "R-02", "delaySeconds": 120},
            }
        )
        proposal_id = chat["proposal"]["proposalId"]
        envelope = {"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]}

        first = await asgi_post(app, f"/api/ai/proposals/{proposal_id}/confirm", json=envelope)
        second = await asgi_post(app, f"/api/ai/proposals/{proposal_id}/confirm", json=envelope)

        self.assertEqual(200, first.status_code)
        self.assertEqual(200, second.status_code)
        self.assertEqual(
            first.json()["scenarioRevision"], second.json()["scenarioRevision"]
        )
        self.assertTrue(second.json()["appliedCommand"]["replayed"])
        self.assertEqual("DELAYED", first.json()["vehicles"][1]["status"])

    async def test_a_stale_proposal_can_no_longer_be_confirmed(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "SET_VEHICLE_UNAVAILABLE",
                "summary": "Retirar R-01.",
                "payload": {"vehicleId": "R-01"},
            }
        )
        scenario_id = snapshot["scenarioId"]
        proposal_id = chat["proposal"]["proposalId"]
        # The scenario moves on: the proposal was computed against the old revision.
        await asgi_post(
            app,
            f"/api/scenarios/{scenario_id}/simulation/start",
            json={"speedMultiplier": 1},
        )

        response = await asgi_post(
            app,
            f"/api/ai/proposals/{proposal_id}/confirm",
            json={"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]},
        )

        self.assertEqual(404, response.status_code)
        self.assertEqual("PROPOSAL_NOT_FOUND", response.json()["error"]["code"])

    async def test_unknown_and_already_resolved_proposals_are_rejected(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "REQUEST_REOPTIMIZATION",
                "summary": "Recalcular la mision.",
                "payload": {"reason": "capacidad justa"},
            }
        )
        proposal_id = chat["proposal"]["proposalId"]
        missing = await asgi_post(
            app,
            "/api/ai/proposals/prop-2026-01-01-9999/confirm",
            json={"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]},
        )
        self.assertEqual(404, missing.status_code)
        self.assertEqual("PROPOSAL_NOT_FOUND", missing.json()["error"]["code"])

        rejected = await asgi_post(
            app,
            f"/api/ai/proposals/{proposal_id}/reject",
            json={"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]},
        )
        self.assertEqual(200, rejected.status_code)

        replayed = await asgi_post(
            app,
            f"/api/ai/proposals/{proposal_id}/confirm",
            json={"commandId": command_id(), "scenarioRevision": rejected.json()["scenarioRevision"]},
        )
        self.assertEqual(404, replayed.status_code)
        self.assertEqual("PROPOSAL_NOT_FOUND", replayed.json()["error"]["code"])

    async def test_rejecting_records_the_decision_without_executing_it(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "SET_VEHICLE_UNAVAILABLE",
                "summary": "Retirar R-01.",
                "payload": {"vehicleId": "R-01"},
            }
        )
        scenario_id = snapshot["scenarioId"]

        rejected = await asgi_post(
            app,
            f"/api/ai/proposals/{chat['proposal']['proposalId']}/reject",
            json={"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"]},
        )

        self.assertEqual(200, rejected.status_code)
        result = rejected.json()
        self.assertEqual(snapshot["scenarioRevision"] + 1, result["scenarioRevision"])
        self.assertEqual("PROPOSAL_REJECTED", result["appliedCommand"]["kind"])
        # No action ran: the fleet, the orders and the plan are untouched.
        self.assertEqual(
            [item["status"] for item in snapshot["vehicles"]],
            [item["status"] for item in result["vehicles"]],
        )
        self.assertEqual(
            snapshot["routePlan"]["vehicles"][0]["stops"],
            result["routePlan"]["vehicles"][0]["stops"],
        )
        self.assertEqual(snapshot["kpis"]["economicCostCents"], result["kpis"]["economicCostCents"])

    async def test_the_confirm_body_must_be_a_human_command(self) -> None:
        app, snapshot, chat = await self.scenario_with_proposal(
            {
                "kind": "REQUEST_REOPTIMIZATION",
                "summary": "Recalcular.",
                "payload": {"reason": "capacidad"},
            }
        )
        path = f"/api/ai/proposals/{chat['proposal']['proposalId']}/confirm"

        for body, code in (
            ({"scenarioRevision": snapshot["scenarioRevision"]}, "VALIDATION_ERROR"),
            ({"commandId": "nope", "scenarioRevision": 0}, "VALIDATION_ERROR"),
            (
                {"commandId": command_id(), "scenarioRevision": snapshot["scenarioRevision"], "model": "x"},
                "MODEL_OVERRIDE_FORBIDDEN",
            ),
        ):
            with self.subTest(body=body):
                response = await asgi_post(app, path, json=body)
                self.assertEqual(400, response.status_code)
                self.assertEqual(code, response.json()["error"]["code"])

    async def test_a_proposal_for_an_unknown_robot_is_dropped(self) -> None:
        app, _, chat = await self.scenario_with_proposal(
            {
                "kind": "SET_VEHICLE_UNAVAILABLE",
                "summary": "Retirar R-99.",
                "payload": {"vehicleId": "R-99"},
            }
        )

        self.assertEqual("Propongo retirar un robot del plan.", chat["answer"])
        self.assertIsNone(chat["proposal"], "an ungrounded suggestion must not survive")

    async def test_taking_the_last_available_robot_out_of_service_is_dropped(self) -> None:
        fake = loaded_fake(
            chat_replies=[
                json.dumps(
                    {
                        "answer": "Retiro el unico robot.",
                        "references": [],
                        "proposal": {
                            "kind": "SET_VEHICLE_UNAVAILABLE",
                            "summary": "Retirar R-01.",
                            "payload": {"vehicleId": "R-01"},
                        },
                    }
                )
            ]
        )
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app, vehicles=1, orders=6)

        response = await asgi_post(
            app,
            "/api/ai/chat",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
                "messages": [{"role": "user", "content": "retira R-01"}],
            },
        )

        self.assertIsNone(response.json()["proposal"])


class ReportTests(unittest.IsolatedAsyncioTestCase):
    validator: Any | None = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.validator = schema_validator("envelopes.schema.json", "#/$defs/aiReportResponse")

    async def test_the_report_metrics_come_from_the_snapshot(self) -> None:
        fake = loaded_fake(
            chat_replies=[
                json.dumps(
                    {
                        "summary": "Turno estable con el plan vigente.",
                        "highlights": ["La flota cubre los pedidos alcanzables."],
                        "risks": [],
                        "recommendations": ["Revisar los pedidos sin asignar."],
                    }
                )
            ]
        )
        app, transport = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        response = await asgi_post(
            app,
            "/api/ai/reports/shift",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
            },
        )

        self.assertEqual(200, response.status_code)
        payload = response.json()
        self.assertEqual(AI_REPORT_SCHEMA_VERSION, payload["schemaVersion"])
        self.assertEqual(snapshot["scenarioRevision"], payload["scenarioRevision"])
        metrics = payload["report"]["metrics"]
        self.assertEqual(snapshot["kpis"]["economicCostCents"], metrics["economicCostCents"])
        self.assertEqual(snapshot["kpis"]["distanceTotalMeters"], metrics["distanceTotalMeters"])
        self.assertEqual(snapshot["kpis"]["ordersUnassigned"], metrics["ordersUnassigned"])
        self.assertEqual(len(snapshot["vehicles"]), metrics["vehicleCount"])
        self.assertEqual("Turno estable con el plan vigente.", payload["report"]["narrative"]["summary"])
        self.assertIn(f"# Informe de turno - revision {snapshot['scenarioRevision']}", payload["markdown"])
        self.assertIn("Coste economico", payload["markdown"])
        self.assertIn(MODEL_NAME, payload["markdown"])
        if self.validator is None:
            self.skipTest("jsonschema is not installed; install api/requirements-dev.txt")
        self.assertEqual([], list(self.validator.iter_errors(payload)))

    async def test_the_report_uses_the_frozen_report_options(self) -> None:
        fake = loaded_fake(chat_replies=[json.dumps(
            {"summary": "ok", "highlights": [], "risks": [], "recommendations": []}
        )])
        app, transport = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        await asgi_post(
            app,
            "/api/ai/reports/shift",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
            },
        )

        body = request_json(transport, "/api/chat")
        self.assertEqual(MODEL_NAME, body["model"])
        self.assertEqual(
            {"temperature": REPORT_TEMPERATURE, "num_ctx": NUM_CTX}, body["options"]
        )
        self.assertEqual(THINK, body["think"])

    async def test_a_malformed_report_is_a_502(self) -> None:
        fake = loaded_fake(chat_replies=['{"summary": "solo el resumen"}'])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)

        response = await asgi_post(
            app,
            "/api/ai/reports/shift",
            json={
                "scenarioId": snapshot["scenarioId"],
                "commandId": command_id(),
                "scenarioRevision": snapshot["scenarioRevision"],
            },
        )

        self.assertEqual(502, response.status_code)
        self.assertEqual("AI_OUTPUT_INVALID", response.json()["error"]["code"])

    async def test_the_report_needs_the_loaded_model_and_no_override(self) -> None:
        fake = FakeOllama(installed=[MODEL_NAME])
        app, _ = build_ai_app(fake)
        snapshot = await ready_scenario(app)
        base = {
            "scenarioId": snapshot["scenarioId"],
            "commandId": command_id(),
            "scenarioRevision": snapshot["scenarioRevision"],
        }

        response = await asgi_post(app, "/api/ai/reports/shift", json=base)
        self.assertEqual(409, response.status_code)
        self.assertEqual("AI_MODEL_NOT_LOADED", response.json()["error"]["code"])

        override = await asgi_post(app, "/api/ai/reports/shift", json={**base, "model": "x"})
        self.assertEqual(400, override.status_code)
        self.assertEqual("MODEL_OVERRIDE_FORBIDDEN", override.json()["error"]["code"])
        self.assertEqual([], fake.chat_bodies)

    async def test_unreachable_service_is_a_clear_error_and_never_a_fabricated_report(self) -> None:
        app, _ = build_app(offline_handler)

        response = await asgi_post(
            app,
            "/api/ai/reports/shift",
            json={"scenarioId": str(uuid4()), "commandId": command_id(), "scenarioRevision": 1},
        )

        self.assertEqual(503, response.status_code)
        self.assertEqual("AI_SERVICE_UNAVAILABLE", response.json()["error"]["code"])


class PureHelperTests(unittest.TestCase):
    """The grounding helpers, exercised without any HTTP round trip."""

    def test_pull_events_are_normalized_from_ollama_vocabulary(self) -> None:
        self.assertEqual("DOWNLOADING", normalize_pull_event_of({"status": "pulling manifest"}).state)
        self.assertIsNone(normalize_pull_event_of({"status": "pulling x"}).percent)
        progress = normalize_pull_event_of(
            {"status": "pulling 3e4cb1417446", "total": 1000, "completed": 425}
        )
        self.assertEqual(42.5, progress.percent)
        self.assertEqual("pulling 3e4cb1417446", progress.status_text)
        self.assertFalse(progress.done)
        self.assertEqual("VERIFYING", normalize_pull_event_of({"status": "verifying sha256 digest"}).state)
        success = normalize_pull_event_of({"status": "success"})
        self.assertEqual("COMPLETED", success.state)
        self.assertTrue(success.done)
        failure = normalize_pull_event_of({"status": "pulling", "error": "no space left"})
        self.assertEqual("FAILED", failure.state)
        self.assertEqual("no space left", failure.error)
        self.assertTrue(failure.done)
        # A malformed percentage is dropped rather than published as a wrong number.
        self.assertIsNone(
            normalize_pull_event_of({"status": "pulling", "total": 0, "completed": 5}).percent
        )

    def test_the_context_never_carries_the_road_graph(self) -> None:
        snapshot = {
            "scenarioId": "s",
            "scenarioRevision": 4,
            "status": "READY",
            "seed": 1,
            "vehicles": [
                {
                    "vehicleId": "R-01",
                    "status": "EN_ROUTE",
                    "currentNodeId": "N-001",
                    "batteryPercent": 90.0,
                    "loadKilograms": 12.0,
                    "capacityKilograms": 40.0,
                    "assignedOrderIds": ["O-001"],
                }
            ],
            "orders": [
                {
                    "orderId": "O-001",
                    "status": "ASSIGNED",
                    "priority": "NORMAL",
                    "deliveryNodeId": "N-006",
                    "assignedVehicleId": "R-01",
                    "weightKilograms": 12.0,
                }
            ],
            "barriers": [],
            "blockedEdgeIds": [],
            "simulation": {"running": False, "speedMultiplier": 1.0, "tick": 0, "elapsedSeconds": 0},
            "routePlan": None,
            "kpis": None,
            "graph": {"cityId": "robot-city", "nodes": [], "edges": []},
        }

        context = build_snapshot_context(snapshot)

        self.assertNotIn("graph", context)
        self.assertEqual(4, context["scenarioRevision"])
        self.assertEqual(1, context["vehicleCount"])
        self.assertIsNone(context["routePlan"])
        self.assertIsNone(context["kpis"])

    def test_only_paths_that_exist_in_the_context_survive(self) -> None:
        context = {"kpis": {"economicCostCents": 100}, "blockedEdgeIds": ["E-N001-N002"]}

        self.assertEqual(
            ["kpis.economicCostCents", "blockedEdgeIds"],
            grounded_references(
                ["kpis.economicCostCents", "kpis.noExiste", "", "blockedEdgeIds"], context
            ),
        )

    def test_markdown_reports_the_ab_comparison_of_the_previous_intervention(self) -> None:
        report = {
            "schemaVersion": AI_REPORT_SCHEMA_VERSION,
            "scenarioRevision": 5,
            "generatedAt": "2026-09-22T09:12:30.100Z",
            "status": "READY",
            "seed": 1,
            "planAvailable": True,
            "metrics": {
                "vehicleCount": 2,
                "orderCount": 6,
                "activeClosures": 1,
                "activeVehicles": 1,
                "distanceTotalMeters": 840.0,
                "plannedDurationSeconds": 294,
                "economicCostCents": 1500,
                "ordersDelivered": 0,
                "ordersPending": 5,
                "ordersDelayed": 0,
                "ordersUnassigned": 1,
            },
            "comparison": {
                "kind": "BARRIER_PLACED",
                "comparedToRevision": 4,
                "delta": {
                    "distanceTotalMeters": 240.0,
                    "plannedDurationSeconds": 24,
                    "economicCostCents": 20,
                    "ordersDelayed": 0,
                    "ordersUnassigned": 1,
                },
            },
            "unassignedOrders": [{"orderId": "O-003", "reason": "UNREACHABLE"}],
            "closures": [{"barrierId": "B-1", "blockedEdgeId": "E-N002-N007"}],
            "narrative": {
                "summary": "El cierre encarecio el plan.",
                "highlights": ["d"],
                "risks": [],
                "recommendations": ["e"],
            },
        }

        markdown = report_markdown(report)

        self.assertIn("Comparacion A/B", markdown)
        self.assertIn("BARRIER_PLACED frente a la revision 4", markdown)
        self.assertIn("240.0 m", markdown)
        self.assertIn("O-003 sin asignar: UNREACHABLE", markdown)
        self.assertIn("Cierre B-1 sobre E-N002-N007", markdown)


if __name__ == "__main__":
    unittest.main()
