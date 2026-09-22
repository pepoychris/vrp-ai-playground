# Phase 8 local Qwen copilot runbook

Phase 8 adds the local AI copilot: the operator can download the fixed model, activate
it, ask grounded questions about the revision on screen, download a validated shift
report, and confirm or reject one proposed action. Every AI call is owned by the
backend. The browser never chooses the model and never reaches Ollama.

## The two halves of the phase

| Half | Owner | What it does |
|---|---|---|
| Model lifecycle | `POST /api/ai/model/install`, `GET /api/ai/model/install/events`, `POST /api/ai/activate` | Downloads `qwen3:4b` on user request and preloads it |
| Grounded reasoning | `POST /api/ai/chat`, `POST /api/ai/reports/shift`, `POST /api/ai/proposals/{id}/confirm`, `POST /api/ai/proposals/{id}/reject` | Answers from the validated snapshot, writes reports, applies only human-confirmed actions |

## Fixed model and inference settings

The model is a module constant (`MODEL_NAME = "qwen3:4b"` in `api/app/config.py`), not
an environment variable and not a request field. The backend applies `think: false`,
`num_ctx: 8192`, the approved temperatures and `keep_alive`; the browser sends only
`scenarioId`, `scenarioRevision`, `messages` and the command envelope. A body carrying
`model`, `think`, `options` or `keep_alive` is refused with `400
MODEL_OVERRIDE_FORBIDDEN` before any model call happens.

## Install, progress and recovery

1. Press **Install Qwen Core**. The button is offered only while `modelInstalled` is
   false; it is disabled again as soon as the model is installed.
2. `POST /api/ai/model/install` is idempotent: an installed model answers `200` with the
   job in `COMPLETED`, a download already running answers `200` with the job in progress,
   and only a genuinely new download answers `202`. Two `pull` calls never run at once,
   and nothing is downloaded at startup or at import time.
3. The panel subscribes to `GET /api/ai/model/install/events`. Frames are
   `ai.install` (`state`, `modelName`, `percent`, `statusText`, `error`) and `ai.status`.
4. The reducer orders frames by `eventSeq`, so a replayed or reordered frame never moves
   the progress bar backwards. Reconnecting replays the current state first, which is
   the recovery path after a dropped connection or a failed download.
5. On `COMPLETED` or `FAILED` the stream closes; the panel re-reads `/api/ai/status`.
   A failed download shows **Retry Qwen Core install** and Ollama's own error text.
   The downloaded weights live in the existing `ollama-models` volume, so a retry
   resumes instead of starting from zero.

## Activate

**Activate AI core** is enabled only when the model is installed and not yet loaded. It
calls `POST /api/ai/activate`, which preloads `qwen3:4b` with the frozen `keep_alive` and
answers `200` with an `aiStatus` whose `modelLoaded` is `true`. Activating never
downloads anything.

## Grounded chat

1. Create a scenario, deploy a fleet and generate orders (Phase 4/5).
2. Type a question and press **Ask the copilot**.
3. The request carries `scenarioId`, `scenarioRevision` and the message list. The
   backend builds the prompt from a **read-only snapshot context** — the current
   revision's vehicles, orders, barriers, route plan and KPIs. The immutable road graph
   is not sent: it is large and irrelevant to the question.
4. The answer is Spanish text plus `usedRevision`, `references` (only paths that exist
   in the context survive) and `timingsMs`. The hidden reasoning of the model is never
   returned or displayed.
5. If the model returns something that is not the expected JSON, the backend answers
   `502 AI_OUTPUT_INVALID` and the panel explains it instead of rendering garbage.
6. An answer whose `usedRevision` is older than the revision on screen is dropped with a
   notice, exactly like a stale snapshot: a stale AI response never overwrites a newer
   scenario revision.

## Shift report and A/B comparison

**Build shift report** calls `POST /api/ai/reports/shift` with the visible revision. The
backend computes the deterministic metrics from the snapshot, has the model write only
the narrative, validates the result against JSON Schema and answers
`schemaVersion`, `markdown`, `report`, `scenarioRevision` and `generatedAt`. The report
contains the A/B comparison of the last intervention. **Download report (Markdown)**
saves it as `roboroute-shift-report-r{revision}.md`. A malformed model output is a `502`,
and an unreachable service is a clear `503`: the backend never fabricates metrics.

## Proposal human gate

1. A chat answer may carry one `proposal` with a `proposalId`, a `kind`
   (`SET_VEHICLE_UNAVAILABLE`, `DELAY_VEHICLE`, `REQUEST_REOPTIMIZATION`), a summary, a
   payload and a `PENDING` status.
2. The panel renders **Confirm and apply** and **Reject proposal**. No action runs
   before that click.
3. Both calls send the frozen command envelope (`commandId`, `scenarioRevision`).
   Confirmation applies exactly the confirmed action against the current revision and
   publishes **one** coherent `ScenarioRevisionResponse`; rejection records the decision
   and changes nothing.
4. A stale or unknown proposal answers `404 PROPOSAL_NOT_FOUND`. Repeating the same
   `commandId` is replayed rather than applied twice. The confirmed snapshot travels
   through the same revision guard as every other command, so a stale response cannot
   overwrite a newer one.

## What the operator never sees

The panel shows service availability, installed state and loaded state. It never shows
the Ollama URL, the port, the model list or a model picker: there is no `<select>` and no
model name in the copilot UI.

## Verification

```text
.\.venv\Scripts\python.exe -m unittest discover -s api/tests -v
cd frontend; npm test
cd frontend; npm run build
```

Focused suites:

```text
.\.venv\Scripts\python.exe -m unittest api.tests.test_phase8_model_install api.tests.test_phase8_copilot -v
cd frontend; npx vitest run src/state/ai-copilot.test.ts src/components/AiCopilotPanel.test.tsx src/api/client.test.ts src/scenario/revision-guard.test.ts
```

Every AI test injects a fake Ollama transport through `api/tests/support.py`; a real
Ollama service is never required, and the fake records the exact body the backend sent so
the fixed model, options and `keep_alive` are asserted instead of assumed.

## Out of scope

No browser-to-Ollama call, no user-selected model, no RAG or vector store, no external AI
service, no authentication, no chain-of-thought display and no endpoint beyond the frozen
Phase 8 routes.
