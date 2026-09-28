# Approved version log

Captured on **2026-09-22** (Europe/Madrid). Every version in this table was read from
the official source of the corresponding registry, not from memory or from estimates.
The hashes let you check that the downloaded artefact is the one approved in Phase 0.

## Pinning policy

1. **No dependency is declared with `latest`, `^`, `~` or open ranges.** The exact
   version is pinned in `package.json` / `requirements*.txt` and in the Docker image
   tags.
2. Every pinned version carries its official source and, when the registry publishes
   it, its hash (`integrity` on npm, `sha256` on PyPI, digest in the model registry).
3. **Official references** (API documentation) are cited separately and are not treated
   as versions: they exist so that methods and parameters are not invented.
4. Transitive dependencies are frozen with a lockfile in Phase 1
   (`package-lock.json`, `requirements.lock.txt`). This document pins the direct ones.
5. Updating a version requires: checking the official source, updating this document,
   updating the lockfile in the same phase and recording the reason.

## Verified local environment

Commands run on the development machine on 2026-09-22:

| Tool | Observed version |
|---|---|
| Node.js | 24.21.0 |
| npm | 12.0.2 |
| Python | 3.14.7 |
| Docker | 29.8.0 |
| git | 2.51.2 (windows.1) |

These versions belong to the environment where the Phase 0 tests run. They are not yet
the delivery versions: the delivery versions are the pinned Docker images further
below.

## Frontend

Source: npm registry (`https://registry.npmjs.org/<package>/<version>`).

| Package | Pinned version | `integrity` (sha512) |
|---|---|---|
| `react` | 19.3.0 | `sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog==` |
| `react-dom` | 19.3.0 | `sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q==` |
| `typescript` | 7.0.2 | `sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==` |
| `vite` | 8.3.0 | `sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==` |
| `@vitejs/plugin-react` | 6.1.1 | `sha512-yxLaQV9gkhS8ezJqCM6+ndU7mDY6gqAg75NQ+0IjwEI8IYOmQCgkRwHKVSfWXW076DsqMo0Dk+0FK1U+M5RgFw==` |
| `three` | 0.186.0 | `sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==` |
| `@types/three` | 0.186.0 | `sha512-mxYSBpDC+D0pLfSP6sW4WZTcT+nrtmZcimMqnVmy36Hte3XpeYSrvgg4TRdaM1GemGog1AWzI5qL2VoIfMXbJQ==` |
| `vitest` | 5.0.1 | `sha512-iA95lQbKEkvrtTkdAgnWbXfbipWiiWe/hDl2P5tMi6WFwD76G0NxXAGp/M9EOcYupeGJRr6wppMc7CoA41TQjg==` |
| `@playwright/test` | 1.63.0 | `sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==` |

Risk notes to resolve in Phase 1, not in Phase 0:

- `typescript` 7.x is the native generation of the compiler. Phase 1 must check that
  `vite` 8.3.0 + `@vitejs/plugin-react` 6.1.1 + `typescript` 7.0.2 compile the skeleton
  without errors and, if they do not, record the deviation with the closest version in
  this same document.
- The Playwright browser versions are not pinned here. Phase 9 decides whether the
  binary is pinned; today only the test package version is pinned.

## Backend

Source: PyPI (`https://pypi.org/pypi/<package>/<version>/json`).

| Package | Pinned version | Checked artefact | sha256 |
|---|---|---|---|
| `fastapi` | 0.141.1 | `fastapi-0.141.1-py3-none-any.whl` | `bfb91aa2d334c61cb35ba9a116fc123b3d3df31640b801cf57a7a78ec3f603b3` |
| `uvicorn` | 0.53.0 | `uvicorn-0.53.0-py3-none-any.whl` | `e8dca71ec86dce5f04e333f0d56cdedf942446e6643b9cea1af0d6d3a02cb03e` |
| `pydantic` | 2.13.5 | `pydantic-2.13.5-py3-none-any.whl` | `346a034f080da3755d8e9cb5e00e8b07de1d39e4f6e2c87d8ab7cafa0b269a73` |
| `ortools` | 9.15.6755 | `ortools-9.15.6755-cp314-cp314-win_amd64.whl` | `afabb869e5fabeb704bd8147b22bf8139dee042e55fabd0d447a996428009e0c` |
| `jsonschema` | 4.26.0 | `jsonschema-4.26.0-py3-none-any.whl` | `d489f15263b8d200f8387e64b4c3a75f06629559fb73deb8fdfb525f2dab50ce` |
| `httpx` | 0.28.1 | `httpx-0.28.1-py3-none-any.whl` | `d909fcccc110f8c7faf814ca82a9a4d816bc5a6dbfea25d6591d6985b8ba59ad` |

`ortools` 9.15.6755 publishes wheels for CPython 3.9 to 3.14 on `win_amd64`, including
`cp314`, which is the one the local Python 3.14.7 needs. The installation was verified
in Phase 0: `ortools` pulls in `numpy`, `pandas`, `protobuf` and `absl-py`, and they
also ship a `cp314` wheel. The resolved set is frozen in
`spike/fase0/requirements-phase0.lock.txt`.

## Infrastructure (base images)

| Image | Pinned tag | Source |
|---|---|---|
| Node (frontend build) | `node:24.21.0-bookworm-slim` | Docker Hub, verified tag |
| Python (API) | `python:3.14.7-slim-bookworm` | Docker Hub, verified tag |
| Ollama | `ollama/ollama:0.34.2` | Docker Hub, verified tag; release `v0.34.2` on GitHub (2026-09-15) |

Ports and volumes are decided in Phase 1: the MVP requires a persistent volume for
`/root/.ollama` and for the database, and forbids publishing `11434` in the final
delivery.

## AI model

| Item | Pinned value | Source |
|---|---|---|
| Reference | `qwen3:4b` | `https://ollama.com/library/qwen3:4b` |
| Weights layer | `sha256:3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f` (2,497,280,480 bytes) | Ollama registry manifest |
| Configuration | `sha256:e18a783aae5525fd2852fc94c985541a77e791e034abc2d3056474d59de336fc` | Ollama registry manifest |
| Template | `sha256:2d54db2b9bb29ce7db54fea63a891f5859603813c555b1f88b5e0994652897f9` | Ollama registry manifest |
| Licence | `sha256:d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12` | Ollama registry manifest |
| Parameters | `sha256:cff3f395ef3756ab63e58b0ad1b32bb6f802905cae1472e6a12034e4246fbbdb` | Ollama registry manifest |

The download size (~2.5 GB) forces the installation to be a button with a progress bar
and the model to live on a persistent volume. Phase 8 must check that the digest after
`pull` matches the weights layer in this table; if Ollama republishes the tag, the
difference is reported before updating.

## Approved inference configuration

Names verified in the official Ollama documentation (`/api/chat` and `/faq`):

| Setting | Value | Mechanism |
|---|---|---|
| Model | `qwen3:4b` | constant in the backend, never sent by the browser |
| Context | 8192 tokens | `options.num_ctx` per request (the FAQ states 4096 by default) |
| Thinking | disabled | `think: false` in `/api/chat` |
| Question temperature | 0.2 | `options.temperature` |
| Report temperature | 0 | `options.temperature` |
| Parallelism | 1 | `OLLAMA_NUM_PARALLEL=1` |
| Models loaded at once | 1 | `OLLAMA_MAX_LOADED_MODELS=1` |
| No cloud | enabled | `OLLAMA_NO_CLOUD=1` |

`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_NO_CLOUD` appear in the
official Ollama FAQ; `OLLAMA_NO_CLOUD=1` is the documented way to disable the cloud
features. `keep_alive` and `format` (JSON or JSON Schema) belong to the `/api/chat`
body. None of this is exposed to the browser.

## Official references (no pinned version)

These URLs are the only accepted source so that methods are not invented:

| Use | Reference |
|---|---|
| Three.js fundamentals | https://threejs.org/manual/pages/fundamentals.html |
| Three.js GLTFLoader | https://threejs.org/docs/pages/GLTFLoader.html |
| Three.js Raycaster | https://threejs.org/docs/pages/Raycaster.html |
| Three.js InstancedMesh | https://threejs.org/docs/pages/InstancedMesh.html |
| OR-Tools routing | https://developers.google.com/optimization/routing |
| OR-Tools CVRP | https://developers.google.com/optimization/routing/cvrp |
| OR-Tools VRPTW | https://developers.google.com/optimization/routing/vrptw |
| OR-Tools penalties | https://developers.google.com/optimization/routing/penalties |
| Ollama Docker | https://docs.ollama.com/docker |
| Ollama chat API | https://docs.ollama.com/api/chat |
| Ollama pull API | https://docs.ollama.com/api/pull |
| Ollama tags API | https://docs.ollama.com/api/tags |
| Ollama FAQ (env vars, context) | https://docs.ollama.com/faq |
| Ollama structured outputs | https://docs.ollama.com/capabilities/structured-outputs |
| Ollama tool calling | https://docs.ollama.com/capabilities/tool-calling |
| Ollama thinking | https://docs.ollama.com/capabilities/thinking |

## How this table was reproduced

```powershell
# npm
npm view three version
(Invoke-RestMethod "https://registry.npmjs.org/three/0.186.0").dist.integrity

# PyPI
(Invoke-RestMethod "https://pypi.org/pypi/ortools/9.15.6755/json").info.version

# image tags
curl.exe -s -o NUL -w "%{http_code}" https://hub.docker.com/v2/repositories/node/tags/24.21.0-bookworm-slim

# model manifest
curl.exe -sDI -H "Accept: application/vnd.docker.distribution.manifest.v2+json" https://registry.ollama.ai/v2/library/qwen3/manifests/4b
```

It requires network access. Without network, this document is read as an already
approved contract and the Phase 0 tests do not query the registries again.
