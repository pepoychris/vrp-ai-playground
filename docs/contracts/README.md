# RoboRoute Nexus contracts

This directory freezes the minimum needed to start building without renegotiating
names, units or revisions halfway through a phase. It is the normative reference for the
contract frozen in Phase 0, and it remains the source of truth while the product
evolves.

## Contents

| File | Contents |
|---|---|
| `versions.md` | Log of approved versions, official sources and pinning policy. |
| `world-graph-rules.md` | World/graph coordinate rules, stable identifiers and edge blocking. |
| `rest-sse.md` | Normative REST/SSE contract: endpoints, command/revision/error envelopes and states. |
| `endpoints.json` | Frozen machine-readable list of the endpoints (the source of truth used by the coverage tests). |
| `schemas/*.schema.json` | JSON Schema 2020-12 for each entity, envelope and event. |
| `examples/*.json` | One valid example per schema or per envelope/event variant. |

## Contract status

- Version: **contract v1**, frozen on **2026-09-22**.
- Later changes to field names, units or revision semantics require bumping
  `contractVersion` in `endpoints.json`, updating the corresponding schema and example,
  and recording the decision. A contract change is never made implicitly inside an
  implementation phase.
- The schemas do not describe screens, styles or React state: they describe data.

## How they are validated

```bash
python spike/fase0/tools/validate_contracts.py
```

The validator:

1. loads every schema and checks that they are valid JSON Schema 2020-12;
2. resolves the cross-schema references by `$id`;
3. resolves the `$exampleRef` composition key (see below);
4. validates every example against the schema declared in its mapping table;
5. checks that the frozen list in `endpoints.json` has no duplicates and that every
   declared endpoint appears in `rest-sse.md`.

Without `jsonschema` installed, the validator only checks valid JSON and internal refs.
Installing the dependency is documented in `spike/fase0/README.md`.

## Example composition convention (`$exampleRef`)

Some envelopes and events embed a complete `ScenarioRevision`. To avoid duplicating
that object across several files, an example may write:

```json
{ "$exampleRef": "scenario-revision.example.json" }
```

The validator replaces that object with the contents of the referenced example
(recursively, with cycle detection) before validating. The validated output is always
the already materialised object, so the composition does not relax validation. This key
is a Phase 0 convention and is not part of the REST contract: it is never sent over
HTTP.

## Units and precision (summary)

The complete rule is in `world-graph-rules.md`; the operational summary is:

| Quantity | Unit and type | Example field |
|---|---|---|
| Distance | meters, number | `distanceMeters` |
| Time | seconds, integer | `driveSeconds` |
| Money | euro cents, integer | `economicCostCents` |
| Weight | kilograms, number | `weightKilograms` |
| Volume | cubic meters, number | `volumeCubicMeters` |
| Speed | km/h, number | `speedLimitKph` |
| Ratio | percentage 0–100, number | `loadUtilizationPercent` |
| Solver objective | unitless integer units, integer | `objectiveCost` |

`objectiveCost` is **never** presented as euros: it reflects the internal scale of the
optimizer. The economic cost is computed separately and is the only one shown to the
user.

## Deterministic economic cost

The contract separates two quantities that are never mixed:

- **solver objective**: the sum of arc costs and penalties in internal integer units
  (`objectiveCost`). It is not money and is never shown as euros.
- **economic cost**: it depends only on the already computed solution and is expressed
  in whole euro cents (`economicCostCents`).

```text
economicCostCents =
    fixed costs of active vehicles
  + distance × cost/km of each vehicle
  + driving time × cost/minute of each vehicle
  + delay × penalty/minute
  + unassigned orders × penalty per order
```

Computation rules:

1. Every addend is rounded to whole cents before adding; the total is the sum of the
   rounded addends, not the rounding of the sum.
2. An "active vehicle" is one with at least one stop in the current plan. A deployed
   vehicle with no stops adds no fixed cost.
3. Reference values used by the golden example and by the Phase 0 validator:
   `DELAY_PENALTY_CENTS_PER_MINUTE = 25` and
   `UNASSIGNED_ORDER_PENALTY_CENTS = 1500`. Phase 5 may adjust them, but any change
   forces the golden example and the validator to be updated in the same change.

## Reference implementation

`spike/fase0/` contains the minimal implementation that satisfies these contracts and
the tests that back it: world/graph conversion, snap, edge blocking, shortest paths,
discarding stale results, a minimal VRP with OR-Tools and a GLB load. It is not the
product: Phase 3 and Phase 5 reimplement it inside the backend.

## Out of scope for these contracts

Authentication, multi-user, external maps, latitude/longitude, data generation,
concrete SQLite persistence, choice of React state library and final GLB models.
Phase 0 implements no screens and no production backend.
