# Phase 9 integration, verification and portfolio runbook

Phase 9 adds no product feature. It makes the six previous phases demonstrable: the model
install stream reaches the browser frame by frame, the AI panel mirrors the backend instead
of its own default, the city is the primary surface of the control tower, and the whole
flow is documented, measurable and reproducible from a clean volume.

Two production defects reported from the deployed stack are part of this phase:

| Reported symptom | Root cause | Fix |
|---|---|---|
| The install bar filled in one step, only at the end | `frontend/server/static-server.mjs` buffered every upstream body, including `text/event-stream` | Event streams are now forwarded frame by frame; JSON stays buffered |
| The panel showed *Service Unavailable / Model Not installed* while `GET /api/ai/status` answered `serviceAvailable: true, modelInstalled: true` | The panel only updated from stream frames it had happened to receive, never from the status endpoint | The panel reads the authoritative status on mount, after an install and after an activation |

## What Phase 9 changed

| Area | Where |
|---|---|
| Streaming proxy path (SSE forwarded, JSON buffered) | `frontend/server/static-server.mjs`, `frontend/server/static-server.test.mjs` |
| Authoritative AI status read (`loadAiStatus`, `AiStatusProbe`) | `frontend/src/state/readiness.ts` |
| Status merge, terminal install seeding, activation gate | `frontend/src/state/ai-copilot.ts` |
| Panel lifecycle: mount probe, install/activate re-probe, slow poll while downloading, retry copy | `frontend/src/state/use-ai-copilot.ts`, `frontend/src/components/AiCopilotPanel.tsx` |
| City as the primary desktop surface, visible claw/barrier instructions, WebGL fallback | `frontend/src/App.tsx`, `frontend/src/components/SceneStage.tsx`, `frontend/src/index.css` |
| Renderer telemetry (`renderer.info`, FPS window) | `frontend/src/scene/renderer-stats.ts` |

## Guided demo (3–5 minutes)

Start from a cold stack and keep the seed visible: the demo is repeatable because every
scenario is a function of that seed.

```powershell
docker compose up --build
```

Then open <http://localhost:8080>.

| Time | Action | What the audience should see |
|---|---|---|
| 0:00–0:20 | Cold start | API `Online`; simulation `Stopped`; AI service `Available` or `Unavailable`; model `Not installed`; core `Not loaded`. Nothing has been downloaded, generated or deployed. |
| 0:20–0:50 | Colony controls: 2 vehicles, 6 orders, seed `20260922` → **Deploy Fleet**, **Generate Orders** | The city view draws the road graph, the depot, the blocks and two robots. The revision counter advances once per command. |
| 0:50–1:30 | **Optimize Routes** | Routes appear, the KPI cards fill in (economic cost, planned distance, unassigned orders), and the renderer badge next to *City view* shows this machine's draw calls and triangles. Hover the badge for the full reading. |
| 1:30–2:10 | **Start Simulation**, switch speed, **Pause Simulation**, then right-drag one robot onto another road node | The clock advances while running; the frame-rate part of the badge appears only while animating. The claw drop publishes a new revision and the plan recomputes once. |
| 2:10–2:50 | **Arm closure tool**, left-drag across a road, then **Reopen road** | The preview turns green on a valid edge and red when no road is close enough. The closure blocks both directions, the affected vehicles and orders are listed, and the KPI delta is visible in the same revision. |
| 2:50–3:40 | AI copilot: **Install Qwen Core** (first run only), **Activate AI core**, ask a question, decide the proposal, **Build shift report** → **Download report (Markdown)** | The progress bar advances *while* the download runs and reports Ollama's own status text. After completion the panel shows `Model Installed`, the activation button becomes enabled, and the answer states the revision it is grounded on plus the measured latency. |
| 3:40–4:30 | **Reset Colony**, then deploy the same seed again | The same scenario comes back: same vehicles, same orders, same plan. The copilot proposals of the discarded scenario are no longer confirmable. |

If the model is already in the volume, skip the download in the 2:50 step: the panel
reports `Installed` as soon as the page loads, and **Activate AI core** is enabled without
downloading anything.

## Architecture and runtime notes

```text
browser ──► frontend :8080 ──► api :8000 ──► ollama :11434
            (static +         (FastAPI:      (internal network only,
             same-origin       contracts,     never published, never
             proxy)            scenario,     called by the browser)
                               AI gateway)
```

- **One command.** `docker compose up --build` starts all three services. There is no
  startup hook anywhere: no scenario is created, no model is downloaded and no model is
  preloaded until a user asks for it.
- **Same origin only.** The browser talks to `:8080`. `/health` and `/api/*` are proxied
  to the API, so no CORS configuration exists and the Ollama port is unreachable from the
  browser. `api` is the only component that knows where Ollama lives.
- **Streaming path.** The proxy buffers JSON (so `content-length` stays correct) and
  forwards `text/event-stream` bodies as they arrive, with no `content-length`, no caching
  and `x-accel-buffering: no`. The media type decides, not the path: a future stream is
  forwarded correctly without touching the server again.
- **AI status is authoritative.** The panel reads `GET /api/ai/status` on mount, after an
  install completes and after an activation, and merges every observation with the rule
  that an installed model stays installed and an activated core stays loaded while the
  service is up. A status read that fails is a recoverable error with a retry, never a
  permanent "unavailable" claim.
- **Three.js stays lazy.** The city shell is a dynamic import, so the initial chunk does
  not contain Three.js.
- **Frozen contracts.** Phase 9 changed no endpoint, no request body and no response
  shape. The APIs below are the Phase 8 ones.

## Verification: clean volume and persisted model

The MVP requires the demo to work twice: once with nothing downloaded, and once with the
weights already in the volume. Deleting a volume is destructive, so both commands are
listed explicitly and neither runs by itself.

**Run A — clean volume (the model is downloaded during the demo):**

```powershell
docker compose down
docker volume rm roboroute-ollama-models
docker compose up --build
# in the UI: AI copilot shows "Model Not installed"; press Install Qwen Core and watch the
# progress bar advance before completion.
docker compose exec ollama ollama list
```

`docker compose down -v` is the one-line equivalent of the first two steps. It deletes
`roboroute-ollama-models` and `roboroute-sqlite-data`, and it is the only step in this
runbook that destroys data.

Expected in Run A: `ollama list` is empty before the install, the install bar advances
through `DOWNLOADING` and `VERIFYING`, and it ends at `Installed` with
`GET /api/ai/status` reporting `modelInstalled: true` and `modelLoaded: false`.

**Run B — persisted model (nothing is downloaded again):**

```powershell
docker compose down
docker compose up --build
docker compose exec ollama ollama list   # qwen3:4b is still listed
```

Expected in Run B: the AI panel shows `Model Installed` on first paint, before any stream
frame arrives, and **Activate AI core** is enabled. Pressing it reports `Core Loaded`
without downloading anything.

Check the API's own answer at any point:

```powershell
curl http://localhost:8000/api/ai/status
curl -N http://localhost:8080/api/ai/model/install/events
```

The second command arrives on the frontend origin: with the streaming proxy in place the
frames appear as they are produced, and a terminal job replays its state and closes.

## Renderer, FPS and latency measurement

Every number the UI shows is read from the renderer or from the backend. Nothing is
estimated, and a measurement that is unavailable is omitted instead of being printed as a
zero.

| Reading | Source | Where it appears |
|---|---|---|
| Draw calls, triangles | Three.js `renderer.info.render` after the last rendered frame | Badge next to *City view* |
| Geometries, textures, shader programs | `renderer.info.memory`, `renderer.info.programs` | Badge tooltip |
| Frame rate | Frames actually rendered by the animation loop over a 500 ms window | Badge, only while the simulation animates |
| Device pixel ratio and driver string | `renderer.getPixelRatio()`, `WEBGL_debug_renderer_info` | Badge and tooltip |
| Answer latency | The backend's own `timingsMs.total` | Copilot answer heading |

What is deliberately **not** claimed anywhere in this repository:

- A frame rate, a draw-call count or a memory figure for "the demo machine". Those depend
  on the GPU, the driver and the window size, so the runbook reports the hook and the
  audience reads its own numbers from the badge.
- GPU memory. `renderer.info` exposes geometry and texture counts, not bytes, and this
  project does not convert them into a fabricated megabyte figure.
- Optimisation timing. The bounded OR-Tools limit is a configured budget
  (`timeLimitSeconds`, 1–2 s), not a measurement of any particular plan.

## Observed in this repository

Measured during the Phase 9 implementation pass, on Node 24.21.0 and the committed
dependency pins. These are build and test facts, not GPU performance claims.

```text
frontend: npm test           → 30 test files, 329 tests passed
frontend: npm run build      → tsc --noEmit clean, vite build clean
frontend: dist/index.html                      0.45 kB │ gzip:  0.29 kB
frontend: dist/assets/index-*.css              8.58 kB │ gzip:  2.31 kB
frontend: dist/assets/load-assets-*.js        47.06 kB │ gzip: 14.29 kB
frontend: dist/assets/animation-clips-*.js   216.48 kB │ gzip: 57.49 kB
frontend: dist/assets/index-*.js             326.82 kB │ gzip: 96.85 kB
frontend: dist/assets/city-shell-*.js        373.69 kB │ gzip: 91.95 kB
api:      unittest discover                 → 154 tests passed
```

The city chunk is the only one that carries Three.js; the initial `index` chunk does not
contain it. The streaming proxy test asserts that the first `ai.install` frame reaches the
client while the upstream response is still open, which is the behaviour the buffered proxy
could not provide.

## Hardware and runtime caveats

- **WebGL2 is required for the city.** Without a context the stage shows a titled fallback
  that names the reason and the recovery, keeps the scenario controls working, and reports
  what the renderer said. It never leaves a blank canvas.
- **Ollama runs on the CPU unless the host provides a GPU.** `qwen3:4b` is roughly a
  multi-gigabyte download and needs to be resident in RAM while it answers; the first
  answer after activation is the slowest one because the weights are being loaded.
- **The download needs outbound Internet once**, on user request. `backend` is therefore
  not marked `internal: true`.
- **Disk:** the weights live in the named volume `roboroute-ollama-models`, mounted at
  `/root/.ollama`. They survive `docker compose down`; only deleting the volume removes
  them.
- **Ports:** `${FRONTEND_PORT:-8080}` and `${API_PORT:-8000}`. Ollama publishes none.
- **Docker Desktop on Windows** must have enough memory assigned to the WSL backend for
  the model to load; a container that is killed during inference is usually an out-of-memory
  condition, not an application bug.
- **The first paint never waits for 3D or for the model.** The city chunk is loaded
  dynamically and the install stream only opens when the operator asks for it.

## Verification commands

The full gate, in the order the phase workflow expects:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s api/tests -v
cd frontend
npm test
npm run build
```

Focused suites for this phase:

```powershell
cd frontend
npx vitest run server/static-server.test.mjs `
  src/state/ai-copilot.test.ts `
  src/state/readiness.test.ts `
  src/components/AiCopilotPanel.test.tsx `
  src/scene/renderer-stats.test.ts
```

The proxy suite starts a real upstream server and drives a real stream through the real
handler on an ephemeral port: it does not mock the behaviour it is asserting.

## Out of scope

No new endpoint, no new product feature, no authentication, no real maps, no mobile
application, no paid service, no browser-to-Ollama call, no RAG, and no fabricated
benchmark. Deleting a volume is documented but never performed automatically.
