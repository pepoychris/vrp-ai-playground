# Phase 3 city and shared road graph runbook

Phase 3 gives the control tower its city: one generated dataset that is both the road
graph and the scene description, a procedural isometric view of it, and the two
coordinate helpers the MVP names. Nothing here routes, optimises, simulates or moves.

## What exists after Phase 3

| Artifact | File | Contents |
|---|---|---|
| City dataset | `src/city/robot-city.json` | 63 nodes, 110 edges, 48 blocks, 137 buildings, 1 landmark |
| Dataset generator | `tools/build_city_dataset.mjs` | Deterministic writer and `--check` gate for the dataset |
| Dataset contract | `src/city/dataset.ts` | Types, validation, reachability and the map-service guard |
| Selection | `src/city/selection.ts` | `nearestRoadNode()`, `nearestRoadEdge()`, edge direction metadata |
| Road and route surfaces | `src/city/road-visuals.ts` | Merged road mesh with per-edge ranges, exact route ribbons |
| City stage | `src/city/city-stage.ts` | Ground, roads, blocks, instanced buildings, landmarks, route layer |
| Camera | `src/city/city-camera.ts` | Isometric orthographic camera, zoom, pan, resize, selection helpers |
| City shell | `src/city/city-shell.ts` | Scene, lighting, renderer, registry, selection and disposal |

The city replaces the Phase 2 fixture stage in the running app; the fixture stage itself
is untouched in `src/scene/scene-shell.ts`, still covered by its own tests, and remains
the asset-pipeline stage.

## The dataset is the single source

`robot-city.json` is one document: `nodes`, `edges`, `blocks`, `landmarks` and a
`presentation` block with the road widths, surface heights and building asset id. The
renderer, the selection helpers and any later consumer read the same file, so there is
no second description of the city to drift out of sync.

The generator is deterministic: it uses a seeded PRNG (never `Math.random()`), fixed
arithmetic and a stable key order, so the same seed always produces the same bytes.

```bash
cd frontend
npm run fixture:city          # rewrite src/city/robot-city.json
npm run fixture:city:check    # fail if the committed file differs from the generator
```

`npm test` also runs the byte-for-byte comparison, so a hand edit to the JSON that the
generator would not produce fails the suite.

### Layout

The city is a nine by seven road grid, roughly 400 m by 340 m, with the depot on the
crossing of the two central avenues at the origin. Delivery nodes sit on the outer ring
and on four inner points; everything else is a junction.

| Element | Rule |
|---|---|
| Node id | `N-###`, assigned in generation order, never reused |
| Edge id | `E-N###-N###`, canonical pair, lexicographically smaller node first |
| `lengthMeters` | XZ distance between the endpoints, never rounded for calculation |
| `speedLimitKph` | 50 on the central avenues, 40 on the ring roads, 30 on the rest |
| Road width | Derived from the speed limit through `presentation.roadWidthMetersBySpeedKph` |
| `bidirectional` | `true` for every edge, as the MVP fixes |

Every delivery node is reachable from the depot on the unblocked graph, and
`reachableNodeIds()` is the function that proves it; it is the same walk a later phase
uses to report `UNREACHABLE` orders.

## Decorative spline versus logical route

The two polylines stay apart, on purpose:

- `visualSplineControlPoints` is presentation. It starts and ends exactly on the node
  positions, so a junction never shows a gap, and bows laterally in the middle so the
  road surface is not a perfect lattice. The validator rejects a control point that
  wanders more than 5% of the edge length away from the logical line, which stops a
  cosmetic edit from silently becoming a geometry change.
- A route follows the node positions of the ordered edge sequence and nothing else.
  `routePolyline()` copies the node positions, and `createRouteVisual()` builds a ribbon
  whose centreline lands on them.

The tests state this as a property: a smoothed route would move a point by metres,
while the ribbon centreline matches the logical point to within single precision noise
(a tenth of a millimetre).

## Road surface and route surface

The whole road network is one merged `BufferGeometry`, in canonical edge order, so the
city costs one draw call instead of one per street. Each segment still carries its
identity:

- every vertex has a `aRoadEdgeIndex` attribute;
- `mesh.userData.roadEdgeIds` lists the edge ids in instance order;
- `mesh.userData.roadEdgeRanges` gives the vertex and triangle range of each edge.

The route layer (`RouteLayer`) is created empty: producing routes is Phase 5 work, and
Phase 3 only provides the primitive plus the per-vehicle colours from
`visual-tokens.json` (`city.routeColors`, one per vehicle slot).

## Isometric camera and selection

`createCityControls()` returns an `OrthographicCamera` on the true isometric diagonal
(azimuth 45°, elevation 35.264°), framed from the dataset bounds, with:

- `zoomIn()` / `zoomOut()` / `zoomBy()`, clamped to the supported range;
- `panByPixels(dx, dy)`, which slides the camera along the ground so the ground follows
  the pointer by exactly that many pixels;
- `resize(width, height)`, which keeps the aspect ratio;
- `focusOn()` and `reset()`.

Selection is deliberately contract-shaped: `groundPointFromNdc()` intersects a pointer
coordinate with the ground plane in the local x/z space, and `nearestRoadNode()` /
`nearestRoadEdge()` answer from the dataset with the shared radii
(`SNAP_NODE_MAX_RADIUS_M = 12`, `SNAP_EDGE_MAX_RADIUS_M = 12`). A point with nothing
inside the radius reports `null` rather than snapping to something far away, which is
what a later phase turns into `422 SNAP_OUT_OF_RADIUS` and `422 SNAP_NO_VALID_EDGE`.

`CityShell.selectAtPixel()` and `selectAtNdc()` return the ground point plus the node and
the edge under the pointer, and the tests prove the mapping survives zoom, pan and
resize.

## Deterministic budgets

```bash
cd frontend
npm run benchmark:city
```

The benchmark reads the committed dataset, builds the real city stage with the real
fixture GLBs, measures it and prints the result. Measured on this checkout:

```
city stage: PASS
  nodes=63 edges=110 blocks=48 buildings=137 landmarks=1
  PASS triangles 7678 / 40000
  PASS drawCalls 5 / 24
  PASS textureCount 0 / 8
  PASS textureBytes 0 / 1048576
  PASS memoryProxyBytes 224380 / 50331648
  PASS instanceCount 188 / 400
  fpsMeasurement: not-measured (a headless benchmark has no WebGL context)
  gpuMemoryMeasurement: not-measured (memoryProxyBytes is a CPU-side proxy)
```

The city limits live in `src/scene/render-budget.json` under `city`, next to the
untouched Phase 2 `perAsset` and `stage` limits. Frames per second and GPU memory remain
host specific: they are budget targets, never reported as measured here.

## Degraded startup

The city does not depend on the fixture library to exist:

- with the `buildingFixture` asset loaded, the instanced buildings reuse its geometry and
  material;
- without it, a deterministic fallback box keeps the stage buildable and the guard
  records that the asset was not used;
- the depot landmark is placed only when `depotLandmark` loaded; otherwise it is
  reported in `missingAssetIds` instead of failing the stage.

The status screen, the readiness panel and the asset loading behaviour are the Phase 1
and Phase 2 surfaces, unchanged.

## WebGL boundary

The shell builds, measures and disposes its scene graph with or without a renderer.
When the browser cannot create a WebGL context, `createCityShell()` still returns a
usable shell with `renderer === null` and a readable `rendererError`, and the stage panel
explains that the preview is unavailable. No headless check in this phase claims to have
rendered a frame.

## Verification commands

```bash
# Frontend: types, production build, unit tests, city and asset gates
cd frontend
npm run build
npm test
npm run benchmark:city
npm run benchmark:assets
npm run fixture:city:check
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

Implemented here: the dataset and its generator, dataset validation with reachability,
the procedural city stage, instanced buildings, the singular depot landmark, the merged
road surface with stable per-edge identity, the route visual primitive, the isometric
camera with pan and zoom, the two selection helpers and the deterministic city budget.

Not implemented here, by design: vehicles and orders, OR-Tools routing, simulation,
barrier placement and graph cuts, the claw interaction, drag interactions, SSE and any AI
behaviour. Those belong to later phases.
