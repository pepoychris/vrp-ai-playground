# Phase 7 robotic barriers and road closures runbook

Phase 7 adds one intervention to the last-mile sandbox: a robotic barrier closes a road.
The closure is bound to a stable `blockedEdgeId`, never to a pixel position, and the
scenario stays authoritative. Placing or removing a barrier recomputes the plan, the
KPIs and the before/after comparison **once**, in the same revision that publishes the
barrier itself.

## Tool interaction

1. Deploy a fleet, generate orders and select **Optimize Routes** (Phase 4/5). A barrier
   can also be placed on a bare scenario; it then only advances the revision until a
   fleet and orders exist.
2. Select **Arm closure tool** in the *Robotic barriers* section. The button reports the
   armed state through `aria-pressed` and a highlighted border.
3. Drag on the city with the left button. The preview reports the candidate road live:
   green barrier and a road-width marker on the nearest edge, red barrier with no marker
   when no road is within the snap radius.
4. Release on a green preview to close that road. Release on a red preview, or press
   `Escape`, cancels the drag and sends no command.
5. The pointer is captured, so the drag survives leaving the canvas. The camera is
   disabled for the duration of the drag and re-enabled on release or cancel. While the
   tool is armed the left button belongs to the closure tool, so canvas panning moves to
   the arrow keys and the wheel zoom; disarm the tool to pan with the pointer again.
6. Click a placed barrier to select it (or drag-select nothing). Press `Delete` or
   `Backspace`, or select **Reopen road** in the tray, to remove it.

## One closure, both directions, one recomputation

A closure blocks its road in **both directions**, because every MVP road is
bidirectional. The block is applied by putting the edge id in `blockedEdgeIds`, which is
derived from the active barriers on every command, so a barrier list and the blocked set
can never disagree.

```
barriers: [{ barrierId: "B-1", blockedEdgeId: "E-N002-N007", position, placedAtRevision }]
blockedEdgeIds: ["E-N002-N007"]
```

The router already honours `blockedEdgeIds` (Phase 5), so the same field drives the
distance matrices, the published `routePlan` and the KPI snapshot. An order whose only
path is cut is published as `UNASSIGNED` with the plan's own reason (`UNREACHABLE`), and
the tray lists it next to the affected vehicles the city view highlights.

## Barrier limit

The MVP keeps at most **three** simultaneous barriers (`MAX_BARRIERS = 3`, mirrored in
`api/app/barriers.py` and `src/scenario/scenario.ts`). A fourth placement answers
`409 BARRIER_LIMIT_REACHED` and consumes no revision. Barrier ids are issued in
increasing order and never reused inside a scenario, so a removed closure cannot come
back as a different road.

## API surface

| Command | Body | Success | Errors |
|---|---|---|---|
| `POST /api/scenarios/{id}/barriers` | `{commandId, scenarioRevision, position}` or `{..., edgeId}` | 200 snapshot + `result` | 400, 404, 409 `BARRIER_LIMIT_REACHED`, 422 `SNAP_NO_VALID_EDGE` |
| `DELETE /api/scenarios/{id}/barriers/{barrierId}` | optional `{commandId, scenarioRevision}` | 200 snapshot | 404 `SCENARIO_NOT_FOUND`, 404 `BARRIER_NOT_FOUND` |

`result` is the frozen `barrierPlacementResult`: `barrierId`, `blockedEdgeId`,
`projectedPoint`, `distanceMeters`, `accepted`, `rejectionCode`. A repeated `commandId`
is replayed and answers the stored payload with `appliedCommand.replayed: true`, so a
client that resends after a timeout learns the barrier id it already created. A stale
`scenarioRevision` is rebased on the current one instead of overwriting it.

## Verification

```text
.\.venv\Scripts\python.exe -m unittest discover -s api/tests -v
cd frontend; npm test
cd frontend; npm run build
```

Focused suites:

```text
.\.venv\Scripts\python.exe -m unittest api.tests.test_phase7_barriers -v
cd frontend; npx vitest run src/scenario/barriers.test.ts src/api/client.test.ts
```

Phase 8 owns the AI assistant; maps, authentication, physics, touch controls and
decorative-only barriers stay out of scope.
