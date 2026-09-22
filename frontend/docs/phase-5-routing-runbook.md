# Phase 5 routing runbook

Phase 5 adds a bounded routing mutation to the local scenario API. The optimizer
reads the active graph and publishes one atomic snapshot containing the route plan,
unassigned orders and KPIs.

## Local flow

1. Create a scenario with `POST /api/scenarios`.
2. Deploy a fleet and generate orders using the Phase 4 controls. The fleet is
   deployed on the depot node of the active graph (`N-032` in `robot-city`).
3. Select **Optimize Routes**. The request carries the frozen command envelope
   (`commandId`, `scenarioRevision`) plus an optional `timeLimitSeconds`; the default
   is two seconds and the API accepts only one or two seconds. Repeating a
   `commandId` replays the stored revision instead of planning twice.
4. Read `routePlan` and `kpis` only when both carry the current `scenarioRevision`.
   The panel labels results as best routes found and does not claim proven optimality.

## Units and failure behavior

- Distances are metres and each leg is `ceil(length / min(road limit, vehicle speed))`
  integer seconds, so a slow robot is never planned at the road limit.
- `driveSeconds` counts driving only; `endsAtSeconds` and `plannedDurationSeconds`
  include waiting and service time.
- A route without stops is exactly the depot node with zero distance, and a route ends
  at its last stop: no return leg is charged to the plan.
- The solver objective is expressed in whole seconds plus delay and drop units, while
  economic costs are euro cents. Metres never enter the objective, and the economic
  breakdown always sums exactly to `economicCostCents`.
- The plan is published before anything is executed, so `ordersDelivered` stays zero
  and every assigned order counts as pending.
- Capacity is checked in kilograms and cubic metres before an order is assigned.
- Disconnected or capacity-infeasible orders remain visible in
  `routePlan.unassignedOrders`; the API returns a snapshot instead of blocking the
  application.
- The solver limit is always bounded to one or two seconds.

## Verification

```text
python -m unittest discover -s api/tests -t .
npm test -- --run
npm run build
```

Phase 6 owns animation and claw interaction. Phase 5 only presents route/KPI data
and leaves the Three.js scene imperative.
