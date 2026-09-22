# Registro de versiones aprobadas

Captura: **2026-09-22** (Europe/Madrid). Todas las versiones de esta tabla se han
leído de la fuente oficial del registro correspondiente, no de memoria ni de
estimaciones. Los hashes permiten comprobar que el artefacto descargado es el mismo
que se aprobó en Fase 0.

## Política de pinning

1. **Ninguna dependencia se declara con `latest`, `^`, `~` ni rangos abiertos.** Se
   fija la versión exacta en `package.json` / `requirements*.txt` y en las etiquetas
   de imagen de Docker.
2. Cada versión fijada lleva su fuente oficial y, cuando el registro lo publica, su
   hash (`integrity` en npm, `sha256` en PyPI, digest en el registro de modelos).
3. Las **referencias oficiales** (documentación de API) se citan aparte y no se
   consideran versiones: sirven para no inventar métodos ni parámetros.
4. Las dependencias transitivas se congelan con lockfile en la Fase 1
   (`package-lock.json`, `requirements.lock.txt`). Este documento fija las directas.
5. Actualizar una versión exige: comprobar la fuente oficial, actualizar este
   documento, actualizar el lockfile en la misma fase y anotar el motivo.

## Entorno local verificado

Comandos ejecutados en la máquina de desarrollo el 2026-09-22:

| Herramienta | Versión observada |
|---|---|
| Node.js | 24.21.0 |
| npm | 12.0.2 |
| Python | 3.14.7 |
| Docker | 29.8.0 |
| git | 2.51.2 (windows.1) |

Estas versiones son las del entorno donde se ejecutan las pruebas de la Fase 0. No
son todavía las de la entrega: las de la entrega son las imágenes Docker fijadas más
abajo.

## Frontend

Fuente: registro npm (`https://registry.npmjs.org/<paquete>/<versión>`).

| Paquete | Versión fijada | `integrity` (sha512) |
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

Notas de riesgo a resolver en la Fase 1, no en la Fase 0:

- `typescript` 7.x es la generación nativa del compilador. La Fase 1 debe comprobar
  que `vite` 8.3.0 + `@vitejs/plugin-react` 6.1.1 + `typescript` 7.0.2 compilan el
  esqueleto sin errores y, si no lo hace, registrar la desviación con la versión más
  cercana en este mismo documento.
- Las versiones de navegador de Playwright no se fijan aquí. La Fase 9 decide si se
  fija el binario; hoy solo se fija la versión del paquete de test.

## Backend

Fuente: PyPI (`https://pypi.org/pypi/<paquete>/<versión>/json`).

| Paquete | Versión fijada | Artefacto comprobado | sha256 |
|---|---|---|---|
| `fastapi` | 0.141.1 | `fastapi-0.141.1-py3-none-any.whl` | `bfb91aa2d334c61cb35ba9a116fc123b3d3df31640b801cf57a7a78ec3f603b3` |
| `uvicorn` | 0.53.0 | `uvicorn-0.53.0-py3-none-any.whl` | `e8dca71ec86dce5f04e333f0d56cdedf942446e6643b9cea1af0d6d3a02cb03e` |
| `pydantic` | 2.13.5 | `pydantic-2.13.5-py3-none-any.whl` | `346a034f080da3755d8e9cb5e00e8b07de1d39e4f6e2c87d8ab7cafa0b269a73` |
| `ortools` | 9.15.6755 | `ortools-9.15.6755-cp314-cp314-win_amd64.whl` | `afabb869e5fabeb704bd8147b22bf8139dee042e55fabd0d447a996428009e0c` |
| `jsonschema` | 4.26.0 | `jsonschema-4.26.0-py3-none-any.whl` | `d489f15263b8d200f8387e64b4c3a75f06629559fb73deb8fdfb525f2dab50ce` |
| `httpx` | 0.28.1 | `httpx-0.28.1-py3-none-any.whl` | `d909fcccc110f8c7faf814ca82a9a4d816bc5a6dbfea25d6591d6985b8ba59ad` |

`ortools` 9.15.6755 publica ruedas para CPython 3.9 a 3.14 en `win_amd64`, entre
ellas `cp314`, que es la que necesita el Python local 3.14.7. La instalación se
verificó en la Fase 0: `ortools` arrastra `numpy`, `pandas`, `protobuf` y `absl-py`, y
también traen rueda `cp314`. El conjunto resuelto queda fijado en
`spike/fase0/requirements-phase0.lock.txt`.

## Infraestructura (imágenes base)

| Imagen | Etiqueta fijada | Fuente |
|---|---|---|
| Node (build frontend) | `node:24.21.0-bookworm-slim` | Docker Hub, etiqueta verificada |
| Python (API) | `python:3.14.7-slim-bookworm` | Docker Hub, etiqueta verificada |
| Ollama | `ollama/ollama:0.34.2` | Docker Hub, etiqueta verificada; release `v0.34.2` en GitHub (2026-09-15) |

Los puertos y volúmenes se deciden en la Fase 1: el MVP exige volumen persistente
para `/root/.ollama` y para la base de datos, y prohíbe publicar `11434` en la
entrega final.

## Modelo de IA

| Elemento | Valor fijado | Fuente |
|---|---|---|
| Referencia | `qwen3:4b` | `https://ollama.com/library/qwen3:4b` |
| Capa de pesos | `sha256:3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f` (2.497.280.480 bytes) | manifiesto del registro de Ollama |
| Configuración | `sha256:e18a783aae5525fd2852fc94c985541a77e791e034abc2d3056474d59de336fc` | manifiesto del registro de Ollama |
| Plantilla | `sha256:2d54db2b9bb29ce7db54fea63a891f5859603813c555b1f88b5e0994652897f9` | manifiesto del registro de Ollama |
| Licencia | `sha256:d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12` | manifiesto del registro de Ollama |
| Parámetros | `sha256:cff3f395ef3756ab63e58b0ad1b32bb6f802905cae1472e6a12034e4246fbbdb` | manifiesto del registro de Ollama |

El tamaño de descarga (~2,5 GB) obliga a que la instalación sea un botón con barra
de progreso y a que el modelo viva en un volumen persistente. La Fase 8 debe
comprobar que el digest tras `pull` coincide con la capa de pesos de esta tabla; si
Ollama republica la etiqueta, la diferencia se reporta antes de actualizar.

## Configuración de inferencia aprobada

Nombres verificados en la documentación oficial de Ollama (`/api/chat` y `/faq`):

| Ajuste | Valor | Mecanismo |
|---|---|---|
| Modelo | `qwen3:4b` | constante en el backend, nunca enviada por el navegador |
| Contexto | 8192 tokens | `options.num_ctx` por petición (la FAQ indica 4096 por defecto) |
| Thinking | desactivado | `think: false` en `/api/chat` |
| Temperatura de consultas | 0.2 | `options.temperature` |
| Temperatura de informes | 0 | `options.temperature` |
| Paralelismo | 1 | `OLLAMA_NUM_PARALLEL=1` |
| Modelos cargados a la vez | 1 | `OLLAMA_MAX_LOADED_MODELS=1` |
| Sin nube | activo | `OLLAMA_NO_CLOUD=1` |

`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS` y `OLLAMA_NO_CLOUD` aparecen en la
FAQ oficial de Ollama; `OLLAMA_NO_CLOUD=1` es la forma documentada de desactivar las
funciones de nube. `keep_alive` y `format` (JSON o JSON Schema) pertenecen al cuerpo
de `/api/chat`. Nada de esto se expone al navegador.

## Referencias oficiales (sin versión fijada)

Estas URLs son la única fuente aceptada para no inventar métodos:

| Uso | Referencia |
|---|---|
| Three.js fundamentos | https://threejs.org/manual/pages/fundamentals.html |
| Three.js GLTFLoader | https://threejs.org/docs/pages/GLTFLoader.html |
| Three.js Raycaster | https://threejs.org/docs/pages/Raycaster.html |
| Three.js InstancedMesh | https://threejs.org/docs/pages/InstancedMesh.html |
| OR-Tools routing | https://developers.google.com/optimization/routing |
| OR-Tools CVRP | https://developers.google.com/optimization/routing/cvrp |
| OR-Tools VRPTW | https://developers.google.com/optimization/routing/vrptw |
| OR-Tools penalizaciones | https://developers.google.com/optimization/routing/penalties |
| Ollama Docker | https://docs.ollama.com/docker |
| Ollama chat API | https://docs.ollama.com/api/chat |
| Ollama pull API | https://docs.ollama.com/api/pull |
| Ollama tags API | https://docs.ollama.com/api/tags |
| Ollama FAQ (env vars, contexto) | https://docs.ollama.com/faq |
| Ollama structured outputs | https://docs.ollama.com/capabilities/structured-outputs |
| Ollama tool calling | https://docs.ollama.com/capabilities/tool-calling |
| Ollama thinking | https://docs.ollama.com/capabilities/thinking |

## Cómo se reprodujo esta tabla

```powershell
# npm
npm view three version
(Invoke-RestMethod "https://registry.npmjs.org/three/0.186.0").dist.integrity

# PyPI
(Invoke-RestMethod "https://pypi.org/pypi/ortools/9.15.6755/json").info.version

# etiquetas de imagen
curl.exe -s -o NUL -w "%{http_code}" https://hub.docker.com/v2/repositories/node/tags/24.21.0-bookworm-slim

# manifiesto del modelo
curl.exe -sDI -H "Accept: application/vnd.docker.distribution.manifest.v2+json" https://registry.ollama.ai/v2/library/qwen3/manifests/4b
```

Requiere red. Sin red, este documento se lee como contrato ya aprobado y las pruebas
de Fase 0 no vuelven a consultar los registros.
