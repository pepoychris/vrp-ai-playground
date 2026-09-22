# RoboRoute Nexus

3D last-mile control tower with local AI. The product scope, technical decisions and
phase boundaries live in [`MVP_ROBOROUTE_ULTIMA_MILLA.md`](MVP_ROBOROUTE_ULTIMA_MILLA.md);
the frozen REST/SSE and data contracts live in [`docs/contracts/`](docs/contracts/README.md).

Phase 0 delivered the contracts and the technical spikes under `spike/fase0/`.
**Phase 1 delivers the reproducible project skeleton and the inactive startup
screen**: the Docker Compose stack, a minimal FastAPI backend and a minimal React
frontend that report readiness without creating a scenario, deploying a fleet or
downloading a model.

**Phase 2 delivers the visual identity and the local 3D asset pipeline**: the design
tokens, five deterministic fixture GLB assets served from this origin, a
LoadingManager-driven asset readiness surface, the animation vocabulary
(`idle`, `move`, `grab`, `deploy`) and the renderer/resource budgets with a
deterministic benchmark.

## Stack

| Service | Image / base | Host port | Networks | Purpose |
|---|---|---|---|---|
| `frontend` | `node:24.21.0-bookworm-slim` (build + runtime) | `${FRONTEND_PORT:-8080}` | `edge` | Serves the Vite build and proxies `/health` and `/api/*` to the API |
| `api` | `python:3.14.7-slim-bookworm` | `${API_PORT:-8000}` | `edge`, `backend` | FastAPI backend; the only component allowed to call Ollama |
| `ollama` | `ollama/ollama:0.34.2` | none | `backend` | Local inference runtime; never published to the browser |

Base images are pinned in [`docs/contracts/versions.md`](docs/contracts/versions.md).
There is no `latest` tag anywhere in the stack.

Persistent volumes: `roboroute-ollama-models` mounted at `/root/.ollama`, and
`roboroute-sqlite-data` mounted at `/data` (configured, not written to yet).

`backend` is deliberately not marked `internal: true`: the API reaches Ollama
through it, and Phase 8 needs outbound Internet access once, on user request, to
download the model.

The frontend container is a small Node static server that also proxies `/health` and
`/api/*` to the API on the same origin. That proxy buffers upstream responses, which
is fine for the JSON endpoints of this phase; the Phase 8 SSE endpoints
(`/api/ai/model/install/events` and the scenario event stream) must not be routed
through it and need a dedicated streaming path.

## Quickstart

```bash
docker compose up --build
```

Then open <http://localhost:8080>. The API also answers directly at
<http://localhost:8000/health>.

Every value has a safe default in `compose.yaml`. Copy `.env.example` to `.env` only
to override a port, the Ollama probe timeout or the SQLite path.

Expected after a cold start: the frontend reports the API as available, the scenario
as `IDLE` with no vehicles and no orders, and the AI as not installed and not loaded.
No model is downloaded and none is preloaded.

## Implemented in Phase 1

| Endpoint | Response |
|---|---|
| `GET /health` | `{"status":"ok","service":"roboroute-api","version":"0.1.0"}` |
| `GET /api/ai/status` | `aiStatus` from `docs/contracts/schemas/envelopes.schema.json` |

`GET /health` is a Phase 1 infrastructure probe for Compose and the status screen;
the frozen contract does not describe it, so its shape is fixed here.

`GET /api/ai/status` separates the three states the UI must show independently:

| Field | Meaning |
|---|---|
| `serviceAvailable` | Ollama answered through the internal network |
| `modelInstalled` | `qwen3:4b` appears in `GET /api/tags` |
| `modelLoaded` | `qwen3:4b` appears in `GET /api/ps` |
| `modelName` | Constant `qwen3:4b`; never taken from the request |
| `installJob` | Always `null` in Phase 1; Phase 8 owns model installation |

The backend also resolves `ROBOROUTE_DB_PATH` and mounts the SQLite volume, but
Phase 1 writes nothing to it and creates no scenario at startup.

## Implemented in Phase 2

The control tower now loads a local fixture library and previews it, without any city,
road graph or scenario behaviour.

| Piece | Where |
|---|---|
| Visual tokens (palette, typography, status colours, spacing, lighting, icons, motion) | [`frontend/src/scene/visual-tokens.json`](frontend/src/scene/visual-tokens.json), documented in [`frontend/docs/visual-identity.md`](frontend/docs/visual-identity.md) |
| Fixture assets and their contract | [`frontend/public/assets/models/`](frontend/public/assets/models), [`frontend/src/scene/asset-contract.json`](frontend/src/scene/asset-contract.json) |
| Deterministic generator (no Blender required) | [`frontend/tools/build_fixture_assets.py`](frontend/tools/build_fixture_assets.py) |
| Loader with real progress and recoverable failures | [`frontend/src/scene/load-assets.ts`](frontend/src/scene/load-assets.ts) |
| Scene shell, lighting rig and animation director | [`frontend/src/scene/scene-shell.ts`](frontend/src/scene/scene-shell.ts), [`frontend/src/scene/animation-clips.ts`](frontend/src/scene/animation-clips.ts) |
| Budgets and the deterministic benchmark | [`frontend/src/scene/render-budget.json`](frontend/src/scene/render-budget.json), [`frontend/tools/benchmark-assets.mjs`](frontend/tools/benchmark-assets.mjs) |

Operational detail, budgets and the headless measurement boundary live in
[`frontend/docs/phase-2-asset-pipeline-runbook.md`](frontend/docs/phase-2-asset-pipeline-runbook.md).

The five fixtures are procedural stand-ins because this machine has no Blender
toolchain; the runbook states that limitation and the contract that authored art must
keep. Frame rate and GPU memory are budgets, never reported as measured: the benchmark
is headless and has no WebGL context.

The status screen keeps the Phase 1 readiness behaviour and adds two panels: the
fixture library state (with real progress and a reload action) and the scene preview.
Three.js is imported dynamically, so the first paint never waits for the 3D bundle.

## Approved inference settings

Fixed in `api/app/config.py` and in the `ollama` service environment:

| Setting | Value | Where |
|---|---|---|
| Model | `qwen3:4b` | Backend constant, never sent by the browser |
| Context | 8192 tokens | `api/app/config.py` (`NUM_CTX`); applied per request in Phase 8 |
| Thinking | disabled | `api/app/config.py` (`THINK`); sent as `think: false` in Phase 8 |
| Query temperature | 0.2 | `api/app/config.py` (`CHAT_TEMPERATURE`) |
| Report temperature | 0 | `api/app/config.py` (`REPORT_TEMPERATURE`) |
| Parallelism | 1 | `OLLAMA_NUM_PARALLEL=1` in `compose.yaml` |
| Loaded models at once | 1 | `OLLAMA_MAX_LOADED_MODELS=1` in `compose.yaml` |
| No cloud features | enabled | `OLLAMA_NO_CLOUD=1` in `compose.yaml` |

The frontend cannot influence any of them: its HTTP surface is an allowlist of two
GET paths, and no helper that sends a body or a model name exists.

## Local development without Docker

Backend:

```bash
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r api/requirements-dev.txt
.\.venv\Scripts\python.exe -m uvicorn api.app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173, proxying /health and /api to :8000
```

## Verification

```bash
# Backend: health, AI status, contract shape, startup side effects, compose guard
.\.venv\Scripts\python.exe -m unittest discover -s api/tests -t .

# Frontend: type check, production build, unit tests
cd frontend
npm run build
npm test

# Frontend: deterministic asset benchmark and fixture contract check
npm run benchmark:assets
npm run fixture:assets:check

# Regenerate the fixture assets after editing the asset contract or the palette
npm run fixture:assets

# Compose: schema, services, volumes and networks
docker compose config

# Full stack (requires a running Docker daemon)
docker compose up --build
```

## Reproducible dependency resolution

`frontend/package-lock.json` is committed and the Dockerfile installs with
`npm ci`. The API ships `api/requirements.txt` (direct dependencies) and
`api/requirements.lock.txt` (the whole resolved set, exact pins only), which is what
the API image installs.

Direct frontend dependencies, read from the npm registry on 2026-09-22 (exact pins,
no ranges; `integrity` hashes are recorded in `package-lock.json`):

| Package | Version |
|---|---|
| `react`, `react-dom` | 19.3.0 |
| `three` | 0.186.0 |
| `typescript` | 7.0.2 |
| `vite` | 8.3.0 |
| `@vitejs/plugin-react` | 6.1.1 |
| `vitest` | 5.0.1 |
| `@types/react`, `@types/react-dom` | 19.3.0 |
| `@types/three` | 0.186.0 |
| `@types/node` | 24.13.6 |

`docs/contracts/versions.md` remains the Phase 0 record of the approved versions.
Phase 1 adds only development-only type packages to that set; the runtime
dependencies (`react`, `react-dom`, `typescript`, `vite`, `@vitejs/plugin-react`,
`vitest`, `fastapi`, `uvicorn`, `pydantic`, `httpx`, `jsonschema`) all keep the
versions frozen in Phase 0.

Phase 2 promotes `three` 0.186.0 and `@types/three` 0.186.0 from the Phase 0 approved
list to direct frontend dependencies. No version changes: the pinned versions, the
GLTFLoader import path and the GLB fixture pattern are the ones Phase 0 fixed in
`spike/fase0/glb`.

Regenerate the Python lock after changing `api/requirements.txt`:

```bash
python -m pip install --dry-run --ignore-installed \
  --report "$env:TEMP/roboroute-lock.json" -r api/requirements.txt
```

Keep the resolved `name==version` entries in `api/requirements.lock.txt` in sync.
`pydantic-core` is distributed as a per-platform wheel, so the version is pinned and
pip chooses the wheel that matches the build platform.

## Phase boundaries

Implemented now: the Compose stack, the persistent volumes, the two read endpoints,
the global `IDLE` state, the inactive status screen, the visual tokens, the local
fixture asset library with its deterministic generator, the asset readiness surface,
the animation vocabulary and the renderer/resource budgets with their benchmark.

Not implemented here, and owned by later phases: the Three.js city and its road graph,
`nearestRoadNode()`/`nearestRoadEdge()`, scenario/fleet/order/route/simulation
endpoints and SSE, OR-Tools optimisation, SQLite scenario persistence, model
installation, preloading, chat, reports and authentication. The fixture assets are
stand-ins, not final art; replacing them is allowed as long as the asset contract and
the budgets in `frontend/src/scene/render-budget.json` stay green.
