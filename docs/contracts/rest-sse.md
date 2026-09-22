# Contrato REST y SSE

Congela la sección 8 del MVP. Cubre los 20 endpoints, los envelopes, los estados y el
catálogo de errores. Los ejemplos citados viven en `examples/` y se validan con
`spike/fase0/tools/validate_contracts.py`.

## 1. Convenciones

- Base: `/api`. Cuerpos y respuestas en `application/json; charset=utf-8`.
- Fechas: ISO-8601 en UTC, sufijo `Z` (`emittedAt`, `generatedAt`, `computedAt`).
- Unidades: las de `world-graph-rules.md`. El dinero siempre en céntimos de euro
  enteros; el objetivo del solver en unidades enteras propias, nunca en euros.
- Toda mutación devuelve el **snapshot atómico** completo de la nueva
  `ScenarioRevision`. El frontend no reconstruye estado parcial.
- Todo comando lleva `commandId` y `scenarioRevision`. Es el mecanismo que permite
  descartar resultados obsoletos.
- Prohibido: el navegador no elige modelo, no envía `model`, `think`, `options` ni
  `keep_alive`.

## 2. Envelope de comando

Todo `POST`/`PATCH`/`DELETE` que muta estado usa este envelope (esquema:
`schemas/envelopes.schema.json#/$defs/commandEnvelope`):

```json
{
  "commandId": "3f1c0b6a-4f4d-4d4f-9a2f-2f6a6c9d9b21",
  "scenarioRevision": 4
}
```

| Campo | Tipo | Regla |
|---|---|---|
| `commandId` | UUID v4 | obligatorio; lo genera el cliente; identifica el intento lógico |
| `scenarioRevision` | entero ≥ 0 | obligatorio; última revisión que el cliente ha aplicado |

Semántica:

1. El servidor aplica el comando al estado actual y responde con la revisión
   resultante. No rechaza por ir "una revisión por detrás": el gesto del usuario es
   la intención y el snapshot devuelto es autoritativo.
2. El campo `appliedAgainstRevision` de la respuesta dice contra qué revisión se
   aplicó realmente. Si difiere del `scenarioRevision` enviado, `rebased` es `true` y
   el frontend debe aceptar el snapshot nuevo y descartar cualquier respuesta en
   vuelo anterior.
3. **Reintento idempotente:** repetir el mismo `commandId` no vuelve a mutar el
   estado. El servidor devuelve el resultado guardado con `replayed: true`. La
   ventana de idempotencia es la vida del escenario.
4. `DELETE /api/scenarios/{scenarioId}` no exige envelope: es una operación de
   reinicio sobre el recurso. El resto sí.

## 3. Envelope de respuesta

Esquema: `schemas/envelopes.schema.json#/$defs/successResponse`. Ejemplo:
`examples/mutation-response-barrier.example.json`.

```json
{
  "scenarioId": "0f1a...-...",
  "scenarioRevision": 5,
  "previousRevision": 4,
  "emittedAt": "2026-09-22T09:10:44.512Z",
  "appliedCommand": {
    "commandId": "3f1c0b6a-4f4d-4d4f-9a2f-2f6a6c9d9b21",
    "kind": "BARRIER_PLACED",
    "appliedAgainstRevision": 4,
    "rebased": false,
    "replayed": false
  },
  "revision": { "...": "ScenarioRevision completa" },
  "result": { "...": "objeto específico del endpoint o ausente" }
}
```

`GET /api/scenarios/{scenarioId}` no envuelve: devuelve directamente un
`ScenarioRevision` (`schemas/scenario-revision.schema.json`).

## 4. Reglas de descarte de resultados obsoletos

Obligatorias en el frontend, y verificables en la Fase 6/9 con tests:

1. Mantener `maxAppliedRevision` por escenario. Descartar cualquier payload cuyo
   `scenarioRevision` sea menor. A igual revisión, el último recibido gana.
2. Mantener `maxAppliedTick` dentro de la revisión actual. Descartar eventos de
   simulación con `tick <= maxAppliedTick`.
3. Una respuesta directa de comando solo se aplica si su `commandId` coincide con el
   comando pendiente; si llega un `commandId` viejo, se descarta sin tocar la UI.
4. Tras un evento `scenario.resync`, el cliente hace `GET /api/scenarios/{id}` y
   fija `maxAppliedRevision` con lo recibido antes de volver a pintar.
5. Un descarte nunca se presenta como error al usuario: es el comportamiento
   esperado de una carrera perdida.

## 5. Catálogo de errores

Esquema: `schemas/envelopes.schema.json#/$defs/errorResponse`; ejemplo:
`examples/error-response.example.json`.

```json
{
  "error": {
    "code": "SNAP_OUT_OF_RADIUS",
    "message": "El punto de suelta está a 31.4 m del nodo válido más cercano.",
    "details": { "distanceMeters": 31.4, "maxRadiusMeters": 12.0 },
    "scenarioRevision": 4,
    "commandId": "3f1c0b6a-4f4d-4d4f-9a2f-2f6a6c9d9b21",
    "retryable": false
  }
}
```

| Código | HTTP | Cuándo | `retryable` |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | cuerpo o parámetros inválidos, incluido `commandId` ausente | no |
| `MODEL_OVERRIDE_FORBIDDEN` | 400 | la petición intenta fijar `model`, `think`, `options` o `keep_alive` | no |
| `SCENARIO_NOT_FOUND` | 404 | escenario inexistente o reiniciado | no |
| `VEHICLE_NOT_FOUND` | 404 | `vehicleId` desconocido en el escenario | no |
| `ORDER_NOT_FOUND` | 404 | `orderId` desconocido en el escenario | no |
| `BARRIER_NOT_FOUND` | 404 | `barrierId` desconocido | no |
| `PROPOSAL_NOT_FOUND` | 404 | propuesta caducada o ya resuelta | no |
| `BARRIER_LIMIT_REACHED` | 409 | ya hay 3 barreras activas | no |
| `NO_FLEET_DEPLOYED` | 409 | optimizar sin vehículos | no |
| `NO_ORDERS_AVAILABLE` | 409 | optimizar sin pedidos | no |
| `SIMULATION_NOT_RUNNING` | 409 | pausar una simulación ya parada | no |
| `SNAP_OUT_OF_RADIUS` | 422 | soltar fuera del radio de snap | no |
| `SNAP_NO_VALID_EDGE` | 422 | soltar una barrera sin arista candidata | no |
| `AI_SERVICE_UNAVAILABLE` | 503 | Ollama no responde o no está en la red interna | sí |
| `AI_MODEL_NOT_INSTALLED` | 409 | activar o chatear sin `qwen3:4b` descargado | no |
| `AI_MODEL_NOT_LOADED` | 409 | chatear antes de `POST /api/ai/activate` | no |
| `AI_INSTALL_IN_PROGRESS` | 409 | segunda instalación concurrente | no |
| `AI_OUTPUT_INVALID` | 502 | el modelo devuelve JSON que no cumple el esquema | sí |
| `INTERNAL_ERROR` | 500 | fallo no clasificado | sí |

## 6. Endpoints de escenario

Todos cuelgan de `/api/scenarios`. `rev` indica que la operación incrementa
`scenarioRevision`; `—` indica que no la toca.

| # | Método y ruta | Cuerpo | Éxito | Errores | rev |
|---|---|---|---|---|---|
| 1 | `POST /api/scenarios` | `{seed}` | 201 `successResponse` | 400 | nueva |
| 2 | `DELETE /api/scenarios/{scenarioId}` | — | 200 `scenarioRevision` | 404 | sí |
| 3 | `POST /{scenarioId}/vehicles/generate` | `{commandId, scenarioRevision, count}` | 200 `successResponse` | 400, 404 | sí |
| 4 | `POST /{scenarioId}/orders/generate` | `{commandId, scenarioRevision, count}` | 200 `successResponse` | 400, 404 | sí |
| 5 | `POST /{scenarioId}/optimize` | `{commandId, scenarioRevision, timeLimitSeconds?}` | 200 `successResponse` + `result.routePlan` | 400, 404, 409 `NO_FLEET_DEPLOYED`/`NO_ORDERS_AVAILABLE` | sí |
| 6 | `POST /{scenarioId}/simulation/start` | `{commandId, scenarioRevision, speedMultiplier?}` | 200 `successResponse` | 400, 404 | sí |
| 7 | `POST /{scenarioId}/simulation/pause` | `{commandId, scenarioRevision}` | 200 `successResponse` | 400, 404, 409 `SIMULATION_NOT_RUNNING` | sí |
| 8 | `PATCH /{scenarioId}/vehicles/{vehicleId}/position` | `{commandId, scenarioRevision, position}` | 200 `successResponse` + `result.positionSnap` | 400, 404, 422 `SNAP_OUT_OF_RADIUS` | sí |
| 9 | `POST /{scenarioId}/barriers` | `{commandId, scenarioRevision, position}` o `{..., edgeId}` | 200 `successResponse` + `result.barrierPlacement` | 400, 404, 409 `BARRIER_LIMIT_REACHED`, 422 `SNAP_NO_VALID_EDGE` | sí |
| 10 | `DELETE /{scenarioId}/barriers/{barrierId}` | — | 200 `successResponse` | 404 | sí |
| 11 | `GET /{scenarioId}` | — | 200 `scenarioRevision` | 404 | — |
| 12 | `GET /{scenarioId}/events` | — | 200 `text/event-stream` | 404 | — |

Detalles que no se pueden deducir de la tabla:

- **1** `seed` es entero sin signo. El escenario nace **vacío**: sin vehículos, sin
  pedidos, sin rutas, `status: "IDLE"`, `scenarioRevision: 0`.
- **3** `count ∈ [1, 6]`; fuera de rango es `400 VALIDATION_ERROR`, no un recorte
  silencioso.
- **4** `count ∈ [6, 24]`; los pedidos se colocan solo en nodos `DELIVERY`
  alcanzables desde el depósito.
- **5** `timeLimitSeconds` admite 1 o 2; por defecto 2. La respuesta lleva
  `solverOutcome` y `objectiveIsProvenOptimal`, y la UI muestra "mejores rutas
  encontradas", nunca una garantía de optimalidad. Un escenario inviable devuelve
  pedidos en `unassignedOrders`, no un error.
- **6/7** Cambian `simulation.running` y emiten telemetría por SSE. El reloj de
  simulación no crea revisiones nuevas.
- **8** `position` es un punto de mundo Three.js `{x, y, z}` en espacio local de
  `cityRoot`. El servidor ajusta al nodo más próximo, rechaza si supera el radio y
  reoptimiza **una sola vez**. El `result.positionSnap` devuelve el punto pedido, el
  nodo ajustado, la distancia y si se aceptó.
- **9** Si el cuerpo trae `position`, el servidor ajusta a la arista más próxima
  excluyendo las ya bloqueadas. Si trae `edgeId`, se valida contra el grafo. La
  respuesta devuelve `result.barrierPlacement` y el snapshot ya incluye la arista en
  `blockedEdgeIds`.
- **10** Retirar una barrera recalcula y compara KPIs. `barrierId` inexistente es
  `404`.
- **12** Flujo SSE descrito en la sección 8.

## 7. Endpoints de IA

Prefijo `/api/ai`. La regla común: **el modelo lo fija el backend**
(`qwen3:4b`, ver `versions.md`).

| # | Método y ruta | Cuerpo | Éxito | Errores |
|---|---|---|---|---|
| 13 | `GET /api/ai/status` | — | 200 `aiStatus` | — |
| 14 | `POST /api/ai/model/install` | `{}` | 202 `installJob` (o 200 si ya estaba instalado / en curso) | 503 |
| 15 | `GET /api/ai/model/install/events` | — | 200 `text/event-stream` | 503 |
| 16 | `POST /api/ai/activate` | `{}` | 200 `aiStatus` con `modelLoaded: true` | 409 `AI_MODEL_NOT_INSTALLED`, 503 |
| 17 | `POST /api/ai/chat` | `{commandId, scenarioRevision, messages[]}` | 200 `aiChatResponse` | 400, 404, 409 `AI_MODEL_NOT_LOADED`, 502, 503 |
| 18 | `POST /api/ai/reports/shift` | `{commandId, scenarioRevision}` | 200 `aiReportResponse` | 400, 404, 409, 502, 503 |
| 19 | `POST /api/ai/proposals/{proposalId}/confirm` | `{commandId, scenarioRevision}` | 200 `successResponse` | 404 `PROPOSAL_NOT_FOUND`, 409 |
| 20 | `POST /api/ai/proposals/{proposalId}/reject` | `{commandId, scenarioRevision}` | 200 `successResponse` | 404 |

Reglas:

1. `GET /api/ai/status` distingue tres cosas que la UI muestra por separado:
   `serviceAvailable` (Ollama responde), `modelInstalled` (`qwen3:4b` está en
   `/api/tags`) y `modelLoaded` (`qwen3:4b` aparece en `/api/ps` o ya se precargó).
2. `POST /api/ai/model/install` es **idempotente**: si el modelo está instalado
   responde 200 con el job en `COMPLETED`; si ya se está descargando responde 200 con
   el job en curso; solo responde 202 cuando arranca una descarga nueva. Nunca lanza
   dos `pull` simultáneos.
3. `POST /api/ai/activate` es una precarga con `keep_alive`; no descarga nada.
4. `/api/ai/chat` recibe el historial conversacional y el `scenarioRevision` que el
   usuario está viendo. El servidor responde usando solo datos del snapshot
   validado, cita la revisión usada y no expone el razonamiento interno del modelo.
5. La respuesta de chat puede incluir una `proposal` de acción. Ninguna acción se
   aplica sin `confirm` humano; `confirm` reutiliza el envelope de comando e
   incrementa la revisión como cualquier otra mutación.
6. Los informes se validan contra JSON Schema y se devuelven en Markdown y JSON.
   Si el modelo devuelve algo que no cumple el esquema: `502 AI_OUTPUT_INVALID`.
7. Ninguna petición puede fijar el modelo:

```json
{
  "commandId": "...",
  "scenarioRevision": 5,
  "messages": [{ "role": "user", "content": "¿por qué cambió la ruta de R-01?" }],
  "model": "llama3"
}
```

Ese cuerpo responde `400 MODEL_OVERRIDE_FORBIDDEN`. Lo mismo con `think`, `options` o
`keep_alive`. La configuración de inferencia (`think: false`, `num_ctx: 8192`,
temperaturas, `keep_alive`) la aplica el proxy del backend.

Respuesta de chat (esquema `envelopes.schema.json#/$defs/aiChatResponse`, ejemplo
`examples/ai-chat-response.example.json`): `answer` (texto en español), `usedRevision`
(revisión del snapshot con la que respondió), `references` (rutas de campo del
snapshot que sustentan la respuesta), `proposal` (opcional) y `timingsMs`.

## 8. SSE del escenario

`GET /api/scenarios/{scenarioId}/events` devuelve `text/event-stream` con eventos
con nombre de campo `event:`.

| Evento | Cuándo | Payload |
|---|---|---|
| `scenario.snapshot` | tras cualquier mutación o al conectar | `ScenarioRevision` completa |
| `scenario.simulation` | cada tick mientras `simulation.running` | posiciones por vehículo + `tick` + `elapsedSeconds` |
| `scenario.optimizer` | al empezar y terminar un cálculo | `STARTED`/`FINISHED`/`FAILED` + duración + `solverOutcome` |
| `scenario.resync` | el cliente pide reanudar desde un `Last-Event-ID` que ya no está en el buffer | motivo + revisión actual |
| `scenario.error` | fallo asíncrono del servidor | envelope de error |

Reglas:

1. `id:` es `"{scenarioRevision}:{eventSeq}"`, con `eventSeq` monótono por escenario.
   Es lo que el navegador reenvía como `Last-Event-ID` al reconectar.
2. El servidor guarda un buffer acotado por escenario. Si el `Last-Event-ID` pedido
   ya no está, no inventa historia: emite `scenario.resync` y el cliente hace `GET`.
3. Cada `data:` es un objeto del esquema `events.schema.json`
   (`scenarioEventEnvelope` con `type` de variante).
4. El heartbeat es un comentario SSE (`: ping`), no un evento con payload.
5. Los eventos de simulación no crean revisión: van atados a la revisión vigente y
   llevan su propio `tick`. Así el reloj no compite con la regla de descarte por
   revisión.

Ejemplo: `examples/scenario-snapshot-event.example.json`.

## 9. SSE de instalación del modelo

`GET /api/ai/model/install/events` emite:

| Evento | Payload |
|---|---|
| `ai.install` | `{ state, modelName, percent, statusText, error }` |
| `ai.status` | `{ serviceAvailable, modelInstalled, modelLoaded, modelName }` |

`state` ∈ `IDLE`, `DOWNLOADING`, `VERIFYING`, `COMPLETED`, `FAILED`. `percent` es
`null` mientras el backend no pueda calcularlo y `statusText` es el texto de estado
que reporta Ollama. El contrato no fija claves internas del stream de Ollama: el
backend las traduce a estos campos, de modo que un cambio de Ollama no rompe al
frontend. Ejemplo: `examples/ai-install-progress.example.json`.

## 10. Estados

```text
IDLE ──(vehículos y/o pedidos generados)──▶ READY
READY ──(optimize en curso)──▶ OPTIMIZING ──(fin)──▶ READY
READY ──(simulation/start)──▶ RUNNING ──(simulation/pause)──▶ PAUSED ──▶ RUNNING
cualquiera ──(DELETE /api/scenarios/{id})──▶ escenario nuevo en IDLE
```

- `simulation.running` y `status` son coherentes: `RUNNING` implica `running: true`.
- El estado de IA (`serviceAvailable`, `modelInstalled`, `modelLoaded`) es
  independiente del estado del escenario y se consulta en `GET /api/ai/status`.
- Tras `docker compose up` el escenario no existe hasta que el usuario energiza la
  ciudad; el backend no crea escenarios solo.

## 11. Congelación y cambios

- Versión de contrato: **v1**, congelada el 2026-09-22.
- Los endpoints de esta tabla son los que aparecen, sin añadidos, en
  `endpoints.json`; el test de cobertura comprueba que coinciden exactamente con la
  sección 8 del MVP.
- Añadir un endpoint o cambiar la semántica de `scenarioRevision` exige subir
  `contractVersion` y actualizar esquemas, ejemplos y este documento en la misma
  fase.
