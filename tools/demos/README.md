# Demo pipeline

Everything the project site publishes under `assets/` is produced here. The scripts capture
the **running** product with Playwright, so the GIFs, the landing hero and the screenshots
are real renders, and the pipeline can be re-run whenever the UI changes.

## Prerequisites

1. The stack is up and the local model is installed, because the copilot capture asks it a
   real question:

   ```powershell
   docker compose up --build
   ```

2. The current frontend is built and served on the same origin as an API that can reach
   Ollama. A `vite preview` next to the running API does that:

   ```powershell
   cd frontend
   npm run build
   $env:VITE_DEV_API_PROXY = 'http://127.0.0.1:8000'
   npx vite preview --port 4180 --strictPort --host 127.0.0.1
   ```

   `VITE_DEV_API_PROXY` has to point at the API backed by the Compose Ollama container. The
   default `http://127.0.0.1:8000` is that container when `compose.yaml` publishes the API
   there.

## Capture

Both scripts read `ROBOROUTE_CAPTURE_BASE` (the origin to drive) and write into
`tools/demos/.frames/`, which is transient and ignored by git.

```powershell
$env:ROBOROUTE_CAPTURE_BASE = 'http://127.0.0.1:4180'

# Control deck: landing, fleet, optimization, the running clock, a road closure, a reopen.
node tools/demos/capture_execution.mjs

# Copilot: activation, a grounded question, the validated answer, the report and its download.
node tools/demos/capture_copilot.mjs
```

`capture_execution.mjs` also captures the city canvas at 2x, which becomes the landing hero.
`capture_copilot.mjs` saves the downloaded Markdown next to the frames and records the answer
and its latency in `.frames/copilot.json` for the captions.

Nothing is captured until the real answer arrives; if the model cannot be reached the script
fails instead of inventing a conversation.

## Build the published assets

```powershell
.\.venv\Scripts\python.exe tools\demos\build_gifs.py
```

This writes:

| Output | Source |
| --- | --- |
| `assets/demos/roboroute-execution.gif` | the deck frames, captioned chapter by chapter |
| `assets/demos/roboroute-ai-report.gif` | the copilot frames, ending on the opened report |
| `assets/screenshots/hero-city.png` | the 2x city canvas, trimmed for the landing hero |

When the live frames are absent the script still runs: the execution demo falls back to the
committed state stills, and the AI demo falls back to a storyboard that is labelled
`fixture replay` in every caption. The live path is the one used for the published GIFs.

After the build, delete `tools/demos/.frames/` so the transient captures never reach a commit.

## Verify the landing

```powershell
# from frontend/, with a static server over the repository root
python -m http.server 4174          # or any static server rooted at the repository
node ..\tools\demos\verify_pages.mjs http://127.0.0.1:4174/ [screenshotDir]
```

The check asserts the title, the favicon, the absence of horizontal overflow and console
errors, that both GIFs load at 960x600, and that every navigation anchor lands its section
below the sticky header. Passing `screenshotDir` also writes review screenshots.

`check_local_refs.py` is the cheap guard for the same surface:

```powershell
.\.venv\Scripts\python.exe tools\demos\check_local_refs.py
```
