# Phase 7 robotic barriers and road closures runbook

Phase 7 adds one intervention to the last-mile sandbox: a robotic barrier closes a road.
The closure is bound to a stable `blockedEdgeId`, never to a pixel position, and the
scenario stays authoritative. Placing or removing a barrier recomputes the plan, the
KPIs and the before/after comparison **once**, in the same revision that publishes the
barrier itself.

## Tool interaction

The closure tool is part of the dashboard: the **Road Closures** dock sits beside the map,
above *Optimization Control*, so an operator never has to open *Fleet* to arm it.

1. Deploy a fleet, generate orders and select **Optimize Routes** (Phase 4/5). A barrier
   can also be placed on a bare scenario; it then only advances the revision until a
   fleet and orders exist.
2. Select **Arm closure tool** in the *Road Closures* dock. The button reports the armed
   state through `aria-pressed` and a highlighted border, and the dock restates the drag
   instruction while it is armed.
3. Drag on the city with the left button. The preview reports the candidate road live:
   green barrier and a road-width marker on the nearest edge, red barrier with no marker
   when no road is within the snap radius.
4. Release on a green preview to close that road. The road is then drawn with a coral
   block under the barrier plus a tall warning beacon, so a closed edge is never mistaken
   for an open one. Release on a red preview, or press `Escape`, cancels the drag and
   sends no command.
5. The pointer is captured, so the drag survives leaving the canvas. The camera is
   disabled for the duration of the drag and re-enabled on release or cancel. While the
   tool is armed the left button belongs to the closure tool, so canvas panning moves to
   the arrow keys and the wheel zoom; disarm the tool to pan with the pointer again.
6. Click a placed barrier to select it (or drag-select nothing). Press `Delete` or
   `Backspace`, or select **Reopen road** in the dock, to remove it. Reopening frees one
   slot and removes the coral block in the same revision.
7. The tool disarms itself after every outcome - a published closure, a rejected drop, a
   cancelled drag or a failed command - so a stray second drag cannot close another road
   by accident. Arm it again for the next closure.

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

The product keeps at most **two** simultaneous barriers (`MAX_BARRIERS = 2`, mirrored in
`api/app/barriers.py` and `src/scenario/scenario.ts`). The dock always reports the
capacity as `0/2`, `1/2` or `2/2` with the slots still free, so the limit is visible
before a third drop. A placement beyond the limit answers `409 BARRIER_LIMIT_REACHED`
and consumes no revision; the dashboard turns that response into a plain sentence
(`Both closure slots are in use...`) instead of showing the API path. Barrier ids are
issued in increasing order and never reused inside a scenario, so a removed closure
cannot come back as a different road.

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
