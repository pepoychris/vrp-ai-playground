# Reglas de mundo y grafo

Documento normativo de la Fase 0. La implementación de referencia que lo cumple está
en `spike/fase0/world/` y sus pruebas en `spike/fase0/tests/`.

## 1. Sistema de coordenadas

- El mundo es local y plano en el suelo: plano **XZ**, eje **Y hacia arriba**, sistema
  diestro, tal como lo usa Three.js por defecto.
- La unidad es el **metro**. No hay grados, latitud, longitud ni proyección
  cartográfica en ningún punto del sistema.
- El origen `(0, 0, 0)` es el centro de la ciudad ficticia. Todos los nodos del grafo
  son locales respecto a ese origen.
- `y` es la cota de la superficie rodante. Para el MVP vale `0` en toda la ciudad; el
  campo existe para no rehacer el contrato si una fase posterior añade rampas.

## 2. Conversión mundo ↔ grafo

La conversión es una correspondencia de ejes explícita, sin escalado y sin
intercambios:

```text
graph_to_world(p) = (x = p.x, y = p.y, z = p.z)     # Vector3 de Three.js
world_to_graph(v) = (x = v.x, y = v.y, z = v.z)     # punto de grafo
```

Reglas que se derivan de esto:

1. **No se intercambian ejes.** Un punto de grafo con `x = 3, z = 7` es world
   `(3, y, 7)`. Nunca `(7, y, 3)`.
2. **No hay conversión de ejes por convención de motor.** Si algún día se importa un
   activo con Z-up, la rotación se aplica al nodo de escena del modelo, no a la
   geometría ni al grafo.
3. **No hay escalado en la conversión.** Si la escena visual se escala para encuadrar
   la cámara, el factor vive en la transformación del grupo `cityRoot` de Three.js y
   nunca se escribe en el grafo. Toda operación de selección, proyección o snap debe
   ejecutarse en el espacio **local** de `cityRoot` (usando `Object3D.worldToLocal`
   antes de convertir), de modo que mover la cámara o el grupo no cambie el
   resultado.
4. **Ida y vuelta obligatoria.** `world_to_graph(graph_to_world(p)) == p` y
   `graph_to_world(world_to_graph(v)) == v` con tolerancia `1e-9` m.

## 3. Distancias y precisión

- Las distancias lógicas se miden en el plano XZ: `distance_xz(a, b)` ignora `y`.
  Consecuencia: dos nodos con la misma `x/z` y distinta cota están a distancia cero
  para el enrutado. Es una decisión consciente mientras la ciudad sea plana.
- El grafo se serializa en JSON como `float64`. No se redondea para calcular: el
  redondeo es una decisión de presentación.
- Toda comparación con cero usa la constante `EPSILON_M = 1e-9`.
- Las longitudes de arista (`lengthMeters`) son la distancia XZ entre sus extremos.
  Un cambio de geometría obliga a recalcularlas; el contrato no admite longitudes
  "a ojo".

## 4. Identificadores estables

| Entidad | Patrón | Regla de asignación |
|---|---|---|
| Nodo | `N-001` … `N-999` | índice de generación con 3 dígitos, en orden de generación, nunca reasignado |
| Arista | `E-N001-N002` | par canónico: primero el menor `nodeId` en orden lexicográfico |
| Vehículo | `R-01` … `R-06` | índice de flota, máximo 6 |
| Pedido | `O-001` … `O-999` | índice de pedido, máximo 24 por escenario |
| Barrera | `B-1` … `B-3` | índice de barrera activa, máximo 3 |
| Escenario | UUID v4 | generado en `POST /api/scenarios` |
| Comando | UUID v4 | generado por el cliente en cada comando |

Reglas:

1. El `edgeId` **no** depende de la dirección: `E-N002-N001` no es un identificador
   válido y no aparece nunca. La bidireccionalidad se expresa con
   `bidirectional: true`.
2. Con la misma semilla, el generador produce exactamente los mismos identificadores.
3. Los identificadores no se reutilizan dentro de un escenario. Al reiniciar
   (`DELETE /api/scenarios/{id}`) se crea un escenario nuevo y los contadores
   arrancan de nuevo.

## 5. Reglas del grafo

1. El grafo de la ciudad es **inmutable dentro de un escenario**: nodos y aristas no
   cambian después de `POST /api/scenarios`. Lo único que cambia es qué aristas están
   bloqueadas.
2. `lengthMeters` y `speedLimitKph` son por arista y simétricos respecto a la
   dirección.
3. Los pedidos se colocan **solo** en nodos con `kind: "DELIVERY"`.
4. Todo nodo `DELIVERY` debe ser alcanzable desde el nodo `DEPOT` sin barreras. Si un
   corte deja una zona aislada, el pedido pasa a `UNASSIGNED` con motivo
   `UNREACHABLE`; la aplicación no se bloquea ni inventa un camino.
5. Un grafo sin camino válido entre dos nodos no produce coste cero: produce
   "inalcanzable".

## 6. Bloqueo de aristas

1. La fuente de verdad es `blockedEdgeIds` dentro de `ScenarioRevision`. Deriva de
   las barreras activas: `blockedEdgeIds = { b.blockedEdgeId | b ∈ barriers }`.
   `RoadEdge` **no** tiene campo `blocked` para no tener dos fuentes de verdad.
2. Colocar una barrera bloquea la arista **en ambos sentidos** cuando
   `bidirectional: true`, que es el caso de todas las aristas del MVP.
3. El enrutado, la matriz de distancias y el optimizador excluyen las aristas
   bloqueadas. No existe penalización "blanda" sobre una arista bloqueada.
4. Retirar la barrera elimina el identificador de `blockedEdgeIds` y la arista vuelve
   a estar disponible sin más cambios.
5. Máximo 3 barreras activas simultáneas. La cuarta solicitud responde
   `409 BARRIER_LIMIT_REACHED`.
6. Una barrera no se puede colocar sobre una arista ya bloqueada: las aristas
   bloqueadas se excluyen de los candidatos antes de calcular el más próximo.

## 7. Snap a nodo y a arista

Radio: `SNAP_NODE_MAX_RADIUS_M = 12.0` y `SNAP_EDGE_MAX_RADIUS_M = 12.0`. Son dos
constantes distintas aunque hoy compartan valor, para poder separarlas con intención
explícita.

`nearest_node(point, max_radius)`:

1. calcula `distance_xz` a todos los nodos;
2. descarta los que superen `max_radius`;
3. elige la distancia mínima; si hay empate exacto (diferencia ≤ `EPSILON_M`), elige
   el `nodeId` lexicográficamente menor;
4. devuelve `{nodeId, position, distanceMeters}` o `null` si no hay candidato.

`nearest_edge(point, max_radius, excluded_edge_ids)`:

1. descarta las aristas excluidas (las ya bloqueadas, al colocar una barrera);
2. proyecta el punto sobre cada segmento en XZ: `t = clamp(dot(p-a, b-a) / |b-a|², 0, 1)`,
   con `t = 0` si el segmento es degenerado (`|b-a| ≤ EPSILON_M`);
3. distancia = `distance_xz(p, a + t·(b-a))`;
4. descarta lo que supere `max_radius`;
5. elige la distancia mínima y, en empate, el `edgeId` lexicográficamente menor;
6. devuelve `{edgeId, projectedPoint, t, distanceMeters}` o `null`.

Consecuencias de contrato: una suelta de garra sin nodo dentro del radio responde
`422 SNAP_OUT_OF_RADIUS` y el robot vuelve a su posición anterior; una barrera sin
arista válida responde `422 SNAP_NO_VALID_EDGE`. La posición de píxel nunca se
bloquea: se bloquea un `edgeId`.

## 8. Prohibiciones explícitas

- Guardar latitud/longitud o usar tiles, Leaflet, Mapbox, OSM u OSRM.
- Suavizar la polilínea lógica de la ruta: la ruta visual sigue exactamente la
  secuencia de aristas. La suavidad pertenece a la spline decorativa de la carretera
  (`visualSplineControlPoints`), que no se usa para calcular.
- Usar `Math.random()` en componentes: la generación va por PRNG con semilla.
- Bloquear "una zona": se bloquea una arista del grafo.
