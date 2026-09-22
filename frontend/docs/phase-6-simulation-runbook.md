# Phase 6 simulation and robotic claw runbook

Phase 6 adds a simulation clock, the claw relocation gesture and the animation of the
fleet along the routes Phase 5 published. The scenario stays authoritative: the browser
never reconstructs state, and only a command creates a new revision.

## Local flow

1. Deploy a fleet, generate orders and select **Optimize Routes** (Phase 4/5).
2. Choose a simulation speed, then select **Start Simulation**. The command is
   `POST /api/scenarios/{id}/simulation/start` with the frozen envelope
   (`commandId`, `scenarioRevision`) plus `speedMultiplier`; the API answers with the
   whole snapshot, now `status: RUNNING` and `simulation.running: true`.
3. Watch the robots drive their `edgeSequence`. **Pause Simulation** publishes
   `PAUSED`; starting again resumes from the same tick. Changing the speed while running
   is the same start command with a new multiplier, and it never rewinds the clock.
4. Right-click a robot in the city view to grab it. The claw appears, the robot lifts,
   the camera stops responding to the pointer, and the note under the canvas reports the
   drop preview. Release on a road node to drop it; press `Escape` to cancel.

## API surface

| Command | Body | Success | Errors |
|---|---|---|---|
| `POST /api/scenarios/{id}/simulation/start` | `{commandId, scenarioRevision, speedMultiplier?}` | 200 snapshot (`RUNNING`) | 400, 404, 422 |
| `POST /api/scenarios/{id}/simulation/pause` | `{commandId, scenarioRevision}` | 200 snapshot (`PAUSED`) | 400, 404, 409 `SIMULATION_NOT_RUNNING` |
| `PATCH /api/scenarios/{id}/vehicles/{vehicleId}/position` | `{commandId, scenarioRevision, position}` | 200 snapshot | 400, 404 `VEHICLE_NOT_FOUND`, 422 `SNAP_OUT_OF_RADIUS` |

A repeated `commandId` is replayed and a stale `scenarioRevision` is rebased, exactly
like every other command. The claw radius is 12 m and mirrors `SNAP_NODE_MAX_RADIUS_M`
in `src/city/dataset.ts`; an exact tie between two nodes goes to the lexicographically
smaller id, so the same drop always resolves to the same node.

## Deterministic clock

- The clock advances in whole ticks of `0.5 s`; `elapsedSeconds` is always derived from
  `tick`, so the two fields cannot disagree.
- One advance is bounded by `MAX_TICKS_PER_ADVANCE` (240 ticks, 120 simulated seconds),
  so a backgrounded tab cannot jump the animation when it resumes.
- Ticks are telemetry, not commands: they never bump `scenarioRevision` and never touch
  `emittedAt`. Only `start`, `pause`, `optimize`, fleet/order generation and the claw
  relocation create revisions.
- Any structural command — including a claw relocation — resets the tick timeline,
  because the plan a tick was computed against no longer exists. The chosen speed
  survives the reset.
- A tick computed for an older revision is discarded instead of being applied to the
  current one (`advance_simulation(scenarioId, seconds, expected_revision=...)`), which
  is the frozen rule "a tick never overwrites a newer scenario revision". The same rule
  is implemented for the browser in `src/scenario/revision-guard.ts`, together with the
  higher-revision-wins and pending-`commandId` rules.

## Gesture rules

- The right button is reserved for the claw, and `contextmenu` is cancelled on the
  canvas, so no browser menu opens over the city.
- The pointer is captured, so the gesture survives leaving the canvas; the camera is
  disabled for the duration of the drag and re-enabled on release or cancel.
- The logical vehicle root moves, never the selected child mesh, and the claw is a child
  of that root.
- A pointer move only re-resolves the nearest node: it never plans a route. A release
  inside the radius triggers exactly one command, and therefore exactly one
  recomputation. A release outside the radius publishes nothing and the robot returns to
  its node.
- A release on the node the robot already occupies is accepted as a no-op and sends no
  command.

## Verification

```text
python -m unittest discover -s api/tests -t .
cd frontend && npm test && npm run build
```

Phase 7 owns the barrier tool, edge blocking and the before/after comparison; the
`blockedEdgeIds` semantics are untouched here.
