"""Reglas de descarte de resultados obsoletos (rest-sse.md, seccion 4)."""

from __future__ import annotations

import unittest

from spike.fase0.revision_guard import RevisionGuard


class RevisionGuardTests(unittest.TestCase):
    def test_snapshot_older_than_applied_is_discarded(self) -> None:
        guard = RevisionGuard()
        self.assertTrue(guard.accept_snapshot(5))
        self.assertFalse(guard.accept_snapshot(4))
        self.assertEqual(guard.max_applied_revision, 5)
        self.assertEqual(guard.discarded, 1)

    def test_snapshot_with_the_same_revision_is_accepted(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertTrue(guard.accept_snapshot(5))

    def test_telemetry_with_repeated_tick_is_discarded(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertTrue(guard.accept_telemetry(5, 1))
        self.assertFalse(guard.accept_telemetry(5, 1))
        self.assertFalse(guard.accept_telemetry(5, 0))
        self.assertTrue(guard.accept_telemetry(5, 2))

    def test_telemetry_from_an_older_revision_is_discarded(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertFalse(guard.accept_telemetry(4, 99))

    def test_telemetry_cannot_announce_a_newer_revision(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertFalse(guard.accept_telemetry(6, 1))
        self.assertEqual(guard.max_applied_revision, 5)

    def test_tick_resets_when_the_revision_advances(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        guard.accept_telemetry(5, 7)
        guard.accept_snapshot(6)
        self.assertEqual(guard.max_applied_tick, -1)
        self.assertTrue(guard.accept_telemetry(6, 1))

    def test_response_from_another_command_is_discarded(self) -> None:
        guard = RevisionGuard()
        guard.begin_command("cmd-a")
        self.assertFalse(
            guard.accept_command_response({"commandId": "cmd-b", "scenarioRevision": 7})
        )
        self.assertEqual(guard.max_applied_revision, -1)
        self.assertTrue(
            guard.accept_command_response({"commandId": "cmd-a", "scenarioRevision": 7})
        )
        self.assertEqual(guard.max_applied_revision, 7)

    def test_rebased_response_is_accepted_and_advances_the_revision(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(4)
        guard.begin_command("cmd-a")
        self.assertTrue(
            guard.accept_command_response({"commandId": "cmd-a", "scenarioRevision": 6})
        )
        self.assertEqual(guard.max_applied_revision, 6)

    def test_resync_event_requires_a_get_and_discards_the_payload(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        accepted = guard.accept_event(
            {
                "type": "scenario.resync",
                "scenarioRevision": 5,
                "payload": {"reason": "BUFFER_EXPIRED", "currentRevision": 9},
            }
        )
        self.assertFalse(accepted)
        self.assertTrue(guard.resync_required)
        guard.complete_resync(9)
        self.assertFalse(guard.resync_required)
        self.assertEqual(guard.max_applied_revision, 9)

    def test_optimizer_and_error_events_do_not_change_the_revision(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertTrue(
            guard.accept_event(
                {
                    "type": "scenario.optimizer",
                    "scenarioRevision": 5,
                    "payload": {"phase": "STARTED", "scenarioRevision": 5},
                }
            )
        )
        self.assertEqual(guard.max_applied_revision, 5)

    def test_simulation_event_with_invalid_payload_is_discarded(self) -> None:
        guard = RevisionGuard()
        guard.accept_snapshot(5)
        self.assertFalse(
            guard.accept_event({"type": "scenario.simulation", "scenarioRevision": 5, "payload": {}})
        )


if __name__ == "__main__":
    unittest.main()
