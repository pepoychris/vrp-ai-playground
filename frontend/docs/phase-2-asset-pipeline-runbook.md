# Phase 2 asset pipeline runbook

Phase 2 gives the control tower its visual identity and its first local 3D pipeline:
five deterministic fixture assets, a real LoadingManager-driven readiness surface, an
animation vocabulary, and measurable renderer and resource budgets.

## What exists after Phase 2

| Asset | File | Root node | Authored clips | Triangles | Draw calls | Bytes |
|---|---|---|---|---|---|---|
| Robot vehicle | `robot-vehicle.glb` | `RobotVehicle` | `idle`, `move` | 72 | 1 | 5840 |
| Robotic claw | `robot-claw.glb` | `RobotClaw` | `grab` | 48 | 3 | 5668 |
| Barrier | `barrier.glb` | `Barrier` | `deploy` | 36 | 2 | 4036 |
| Depot landmark | `depot-landmark.glb` | `DepotLandmark` | none (idle placeholder) | 84 | 1 | 5568 |
| Building fixture | `building-fixture.glb` | `BuildingFixture` | none (idle placeholder) | 48 | 1 | 3612 |

Those are the numbers the benchmark prints; it fails if any of them leaves the
documented budget.

## No Blender toolchain: procedural fixtures

The MVP text says to model the assets in Blender. This machine has no Blender
installation, so Phase 2 does not pretend otherwise: the fixtures are written straight
to valid glTF 2.0 binary from data by
[`frontend/tools/build_fixture_assets.py`](../tools/build_fixture_assets.py), using only
the Python standard library.

**These fixtures are stand-ins, not final art.** They exist to lock the contract
(names, hierarchy, materials, clips, budgets) so authored art can replace them file by
file without touching the runtime. A later phase may adopt Blender output as long as it
keeps the same asset ids, root node names, clip names and budgets.

## Regenerating the fixtures

```bash
cd frontend
npm run fixture:assets          # rewrite every GLB from the contract
npm run fixture:assets:check    # fail if a committed GLB differs from the contract
```

The generator is deterministic: the same contract and palette always produce the same
bytes, so `--check` is a safe gate. Regenerate and commit only when
`asset-contract.json` or `visual-tokens.json` changes.

## Contract files

| File | Read by | Contents |
|---|---|---|
| `src/scene/asset-contract.json` | generator, frontend, benchmark | Asset ids, file names, root nodes, node hierarchy, materials, clips, placeholder states |
| `src/scene/visual-tokens.json` | generator, frontend, benchmark | Palette and visual tokens (see `docs/visual-identity.md`) |
| `src/scene/render-budget.json` | frontend, benchmark | Per-asset and stage limits, target frame rate, memory proxy constant |
| `src/scene/scene-plan.json` | frontend, benchmark | Camera, ground radius and the deterministic stage placements |

## Loading surface

`loadSceneAssets()` ([`src/scene/load-assets.ts`](../src/scene/load-assets.ts)) loads
every fixture with the pinned `GLTFLoader` and one shared `LoadingManager`:

* progress is the manager's own ratio, clamped so it can never move backwards;
* every URL is same-origin (`/assets/models/*.glb`); there is no external fetch;
* a failed fixture is recorded as a failure and the remaining fixtures still load, so
  the state becomes `degraded` instead of losing the whole library;
* when every fixture fails the state becomes `failed` and the panel offers a reload;
* authored clips come from the GLB, while missing or declared-placeholder states get a
  deterministic procedural clip flagged as not authored.

`GLTFLoader` registers one extra tracked item per file (the parse pass), which is why
the reported progress comes from the manager ratio rather than from raw item counts.

The status screen shows the readiness panel and the stage preview. Three.js is loaded
through a dynamic import, so the first paint of the control tower never waits for the
3D bundle.

## Budgets and the deterministic benchmark

```bash
cd frontend
npm run benchmark:assets
```

The benchmark reads the committed GLB files, validates the container, parses them with
`GLTFLoader.parse`, and prints pass/fail for:

* triangles, draw calls, texture count and texture bytes per asset;
* file bytes per asset;
* the staged plan (11 placements, 14 mesh instances, 8 unique geometries, 5 unique
  materials);
* memory proxy bytes, a documented CPU-side estimate rather than a GPU measurement;
* rebuild determinism and disposal accounting.

What is **not** measured, and is never reported as measured:

| Value | Why | Where it is stated |
|---|---|---|
| Frames per second | A headless run has no WebGL context | `render-budget.json` (`targetFps`, `minimumAcceptableFps`) |
| GPU memory | Driver and host specific | `render-budget.json` (`measurementNotes`) |

The frame-rate objective is therefore a budget, not an observation. If a browser run
ever records it, that number belongs to that machine and must be labelled as such.

## Reuse and disposal rules

* Stage instances are clones that share geometry, materials and textures with the
  loaded fixture; six robot instances reference one geometry and one material.
* `ResourceRegistry` collects every unique resource once and disposes each of them
  exactly once, whatever the instance count.
* `ResourceRegistry.dispose()` is final: a scene shell whose registry has been disposed
  must be recreated instead of reused.
* `SceneShell.dispose()` stops the animation director, releases the registry, clears
  the scene and disposes the renderer when one exists.

## WebGL boundary

The shell builds, measures and disposes its scene graph with or without a renderer.
When the browser cannot create a WebGL context, `createSceneShell()` still returns a
usable shell with `renderer === null` and a human readable `rendererError`, and the
stage panel explains that the preview is unavailable. No headless check claims to have
rendered a frame.

## Verification commands

```bash
# Frontend: types, production build, unit tests, benchmark, fixture contract
cd frontend
npm run build
npm test
npm run benchmark:assets
npm run fixture:assets:check
```

```bash
# Phase 0 regression, backend tests and contract validation (repository root)
.\.venv\Scripts\python.exe -m unittest discover -s spike/fase0/tests -t .
.\.venv\Scripts\python.exe -m unittest discover -s api/tests -t .
.\.venv\Scripts\python.exe spike/fase0/tools/validate_contracts.py
docker compose config
```

## Phase boundary

Implemented here: the visual tokens, the fixture assets and their contract, the asset
loading surface, the animation vocabulary and director, the deterministic budgets and
the disposal rules.

Not implemented here, by design: the city and the road graph, `nearestRoadNode()` and
`nearestRoadEdge()`, routes and vehicles as business entities, barriers as graph
blocks, simulation, post-processing and the local AI copilot. Those belong to later
phases.
