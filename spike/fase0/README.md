# Phase 0 technical spike

Verification material, not product. This is the minimal implementation that proves the
contracts in `docs/contracts/` can be satisfied with the MVP technologies. Phase 3 and
Phase 5 reimplement these pieces inside the backend; this directory can be dropped
after that.

## Contents

| Path | What it proves |
|---|---|
| `world/coords.py` | Three.js world ↔ graph conversion, XZ distances and drive time. |
| `world/graph.py` | Node and edge snap, bidirectional edge blocking, Dijkstra and distance matrices. |
| `revision_guard.py` | Discarding stale results by `scenarioRevision`, `tick` and `commandId`. |
| `vrp_min.py` | Minimal OR-Tools VRP over the contract graph: capacity, penalised abandonment and solver status. |
| `tools/validate_contracts.py` | Validates schemas, examples, golden-example coherence and REST contract coverage. |
| `glb/` | Fixture GLB, browser spike and headless verification with `GLTFLoader` and `Raycaster`. |
| `tests/` | 41 `unittest` tests for coordinates, graph, discarding stale results and the contract. |

## Dependencies

```bash
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r spike/fase0/requirements-phase0.txt
```

Pinned versions and hashes: `docs/contracts/versions.md`. The resolved set was frozen in
`requirements-phase0.lock.txt`.

For the GLB spike:

```bash
cd spike/fase0/glb
npm install
```

It installs only `three` 0.186.0 (pinned version, no ranges).

## Verification commands

From the repository root:

```bash
# 1. tests for the world/graph rules and for discarding stale results
.\.venv\Scripts\python.exe -m unittest discover -s spike/fase0/tests -t .

# 2. validates schemas, examples, composition and REST coverage
.\.venv\Scripts\python.exe spike/fase0/tools/validate_contracts.py

# 3. minimal VRP with OR-Tools
.\.venv\Scripts\python.exe spike/fase0/vrp_min.py

# 4. GLB: load and selection without a browser
cd spike/fase0/glb
npm run verify
```

Regenerate the fixture GLB (deterministic, no dependencies):

```bash
python spike/fase0/glb/tools/make_fixture_glb.py
```

Manual browser verification (optional):

```bash
cd spike/fase0/glb
npm run serve      # python -m http.server 4173 --directory .
# open http://localhost:4173/web/ and click the cube
```

The page exposes `window.__spikeStatus` with `glbLoaded`, `meshCount`, `vertexCount`,
`selected` and `objectName` so it can be checked from the console.

## Measured results (2026-09-22)

- `unittest`: 41 tests, all passing.
- `validate_contracts.py`: 190 checks, no failures (`RESULT: OK`).
- `vrp_min.py`: `ROUTING_SUCCESS` → `FEASIBLE`, O-003 (40 kg) abandoned because of
  capacity, 1200 m of travel returning to the depot. The summary reports
  `objectiveIsProvenOptimal: false`.
- `npm run verify`: valid GLB, 24 vertices and 36 indices, a 2×2×2 box at the origin and
  `Raycaster` selecting `SpikeCube`.

## Assumptions and deviations

1. **Closed cycle in the spike VRP.** `vrp_min.py` models a classic CVRP that returns to
   the depot, so its distance (1200 m) does not match the golden plan example (840 m),
   which ends at the last stop. Whether the `RoutePlan` includes the return trip is
   decided in Phase 5.
2. **Objective scale.** The spike uses meters as the arc cost; the final scale of the
   model is decided in Phase 5. What is already frozen is that `objectiveCost` is not
   money and does not imply optimality.
3. **No automated browser check.** `playwright` is not installed in this environment
   (it needs browser binaries to be downloaded). The headless verification covers the
   GLB load and the `Raycaster` selection using the same three.js `GLTFLoader`; the
   browser spike stays documented for manual checking, and Phase 9 decides whether it
   is automated.
4. **No Docker in this phase.** The base images are pinned in
   `docs/contracts/versions.md`, but no container is started: that is Phase 1.
5. **`ortools` exposes no Python constants** for `routing.status()` in 9.15.6755; the
   names are read from the `RoutingSearchStatus.Value` enum descriptor, without writing
   identifiers by hand.

## Out of scope

Final screens, simulation, production backend, Docker Compose, real Ollama,
authentication, external maps and production data. None of that has been touched.
