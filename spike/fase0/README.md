# Prueba técnica de la Fase 0

Material de verificación, no de producto. Aquí está la implementación mínima que
demuestra que los contratos de `docs/contracts/` se pueden cumplir con las
tecnologías del MVP. La Fase 3 y la Fase 5 reimplementan estas piezas dentro del
backend; este directorio se puede descartar entonces.

## Contenido

| Ruta | Qué demuestra |
|---|---|
| `world/coords.py` | Conversión mundo Three.js ↔ grafo, distancias XZ y tiempo de conducción. |
| `world/graph.py` | Snap a nodo y arista, bloqueo bidireccional de aristas, Dijkstra y matrices de distancia. |
| `revision_guard.py` | Descarte de resultados obsoletos por `scenarioRevision`, `tick` y `commandId`. |
| `vrp_min.py` | VRP mínimo con OR-Tools sobre el grafo del contrato: capacidad, abandono penalizado y estado del solver. |
| `tools/validate_contracts.py` | Valida esquemas, ejemplos, coherencia del ejemplo dorado y cobertura del contrato REST. |
| `glb/` | GLB de prueba, spike de navegador y verificación sin navegador con `GLTFLoader` y `Raycaster`. |
| `tests/` | 41 pruebas (`unittest`) de coordenadas, grafo, descarte de resultados y contrato. |

## Dependencias

```bash
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r spike/fase0/requirements-phase0.txt
```

Versiones fijadas y hashes: `docs/contracts/versions.md`. El conjunto resuelto
quedó congelado en `requirements-phase0.lock.txt`.

Para el spike de GLB:

```bash
cd spike/fase0/glb
npm install
```

Instala solo `three` 0.186.0 (versión fijada, sin rangos).

## Comandos de verificación

Desde la raíz del repositorio:

```bash
# 1. pruebas de las reglas mundo/grafo y de descarte de resultados
.\.venv\Scripts\python.exe -m unittest discover -s spike/fase0/tests -t .

# 2. valida esquemas, ejemplos, composición y cobertura REST
.\.venv\Scripts\python.exe spike/fase0/tools/validate_contracts.py

# 3. VRP mínimo con OR-Tools
.\.venv\Scripts\python.exe spike/fase0/vrp_min.py

# 4. GLB: carga y selección sin navegador
cd spike/fase0/glb
npm run verify
```

Regenerar el GLB de prueba (determinista, sin dependencias):

```bash
python spike/fase0/glb/tools/make_fixture_glb.py
```

Verificación manual en navegador (opcional):

```bash
cd spike/fase0/glb
npm run serve      # python -m http.server 4173 --directory .
# abrir http://localhost:4173/web/ y hacer clic en el cubo
```

La página publica `window.__spikeStatus` con `glbLoaded`, `meshCount`, `vertexCount`,
`selected` y `objectName` para poder comprobarlo desde la consola.

## Resultados medidos (2026-09-22)

- `unittest`: 41 pruebas, todas correctas.
- `validate_contracts.py`: 191 comprobaciones, sin fallos (`RESULTADO: OK`).
- `vrp_min.py`: `ROUTING_SUCCESS` → `FEASIBLE`, O-003 (40 kg) abandonado por
  capacidad, 1200 m de recorrido con regreso al depósito. El resumen marca
  `objectiveIsProvenOptimal: false`.
- `npm run verify`: GLB válido, 24 vértices y 36 índices, caja 2×2×2 en el origen y
  `Raycaster` seleccionando `SpikeCube`.

## Supuestos y desviaciones

1. **Ciclo cerrado en el VRP del spike.** `vrp_min.py` modela un CVRP clásico que
   regresa al depósito, así que su distancia (1200 m) no coincide con la del plan del
   ejemplo dorado (840 m), que termina en la última parada. La decisión de si el
   `RoutePlan` incluye el regreso se fija en la Fase 5.
2. **Escala del objetivo.** El spike usa metros como coste de arco; la escala
   definitiva del modelo se decide en la Fase 5. Lo que sí queda congelado es que
   `objectiveCost` no es dinero y no implica optimalidad.
3. **Sin comprobación automática en navegador.** `playwright` no está instalado en
   este entorno (requiere descargar binarios de navegador). La verificación headless
   cubre la carga del GLB y la selección con `Raycaster` usando el mismo `GLTFLoader`
   de three.js; el spike de navegador queda documentado para comprobación manual, y
   la Fase 9 decide si se automatiza.
4. **Sin Docker en esta fase.** Las imágenes base están fijadas en
   `docs/contracts/versions.md`, pero no se levanta ningún contenedor: eso es Fase 1.
5. **`ortools` no expone constantes Python** para `routing.status()` en 9.15.6755; los
   nombres se leen del descriptor del enum `RoutingSearchStatus.Value`, sin escribir
   identificadores a mano.

## Fuera de alcance

Pantallas finales, simulación, backend productivo, Docker Compose, Ollama real,
autenticación, mapas externos y datos de producción. Nada de eso se ha tocado.
