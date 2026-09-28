# Phase 4 scenario runbook

Phase 4 keeps scenario generation explicit and fresh. Starting Docker or loading
the page never creates a fleet or orders.

## Controls

- **Vehicles** accepts `1..6` and **Orders** accepts `6..24`.
- **Deploy Fleet** creates or replaces the requested robot cards.
- **Generate Orders** creates orders only on reachable `DELIVERY` nodes.
- **Reset Colony** deletes the active snapshot, clears routes, barriers and
  simulation state, and removes the browser's persisted current scenario.

The frontend validates bounds before sending a command. FastAPI validates the
same bounds at the API boundary, so a crafted request cannot bypass the limits.
Every execution is generated from an internal seed the backend draws for it, so
two runs with the same counts differ. The generator is centralized in
`api/app/scenario.py`; product components never call `Math.random()`.

## API flow

1. `POST /api/scenarios` with an empty body `{}` creates one empty, fresh execution.
   A legacy `{ "seed": ... }` body is rejected with `422`.
2. `POST /api/scenarios/{scenarioId}/vehicles/generate` with `{ "count": 1..6 }` deploys robots.
3. `POST /api/scenarios/{scenarioId}/orders/generate` with `{ "count": 6..24 }` fabricates orders.
4. `DELETE /api/scenarios/{scenarioId}` removes the active snapshot.

Phase 4 intentionally does not calculate routes or animate vehicles; those belong
to later MVP phases.
