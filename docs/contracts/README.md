# Contratos de RoboRoute Nexus

Este directorio congela lo mínimo necesario para empezar a construir sin renegociar
nombres, unidades ni revisiones a mitad de fase. Es la referencia normativa de la
Fase 0 del MVP (`MVP_ROBOROUTE_ULTIMA_MILLA.md`).

## Contenido

| Archivo | Contenido |
|---|---|
| `versions.md` | Registro de versiones aprobadas, fuentes oficiales y política de pinning. |
| `world-graph-rules.md` | Reglas de coordenadas mundo/grafo, identificadores estables y bloqueo de aristas. |
| `rest-sse.md` | Contrato REST/SSE de la sección 8 del MVP, envelopes de comando/revisión/error y estados. |
| `endpoints.json` | Lista legible por máquina de los endpoints del MVP (la usan los tests de cobertura). |
| `schemas/*.schema.json` | JSON Schema 2020-12 de cada entidad, envelope y evento. |
| `examples/*.json` | Un ejemplo válido por esquema o por variante de envelope/evento. |

## Estado del contrato

- Versión: **contrato v1**, congelado el **2026-09-22**.
- Cambios posteriores en nombres de campo, unidades o semántica de revisión requieren
  subir `contractVersion` en `endpoints.json`, actualizar el esquema y el ejemplo
  correspondiente, y anotar la decisión. Un cambio de contrato nunca se hace de
  forma implícita dentro de una fase de implementación.
- Los esquemas no describen pantallas, estilos ni estado de React: describen datos.

## Cómo se validan

```bash
python spike/fase0/tools/validate_contracts.py
```

El validador:

1. carga todos los esquemas y comprueba que son JSON Schema 2020-12 válidos;
2. resuelve las referencias cruzadas entre esquemas por `$id`;
3. resuelve la clave de composición `$exampleRef` (véase abajo);
4. valida cada ejemplo contra el esquema declarado en su tabla de mapeo;
5. comprueba que `endpoints.json` cubre exactamente los endpoints de la sección 8
   del MVP y que cada uno aparece en `rest-sse.md`.

Sin `jsonschema` instalado, el validador solo comprueba JSON válido y refs internas.
La instalación de la dependencia se documenta en `spike/fase0/README.md`.

## Convención de composición de ejemplos (`$exampleRef`)

Algunos envelopes y eventos incrustan un `ScenarioRevision` completo. Para no
duplicar ese objeto en varios ficheros, un ejemplo puede escribir:

```json
{ "$exampleRef": "scenario-revision.example.json" }
```

El validador sustituye ese objeto por el contenido del ejemplo referenciado
(recursivamente, con detección de ciclos) antes de validar. La salida validada es
siempre el objeto ya materializado, de modo que la composición no relaja la
validación. Esta clave es una convención de la Fase 0, no forma parte del contrato
REST: nunca se envía por HTTP.

## Unidades y precisión (resumen)

La regla completa está en `world-graph-rules.md`; el resumen operativo es:

| Magnitud | Unidad y tipo | Ejemplo de campo |
|---|---|---|
| Distancia | metros, número | `distanceMeters` |
| Tiempo | segundos, entero | `driveSeconds` |
| Dinero | céntimos de euro, entero | `economicCostCents` |
| Peso | kilogramos, número | `weightKilograms` |
| Volumen | metros cúbicos, número | `volumeCubicMeters` |
| Velocidad | km/h, número | `speedLimitKph` |
| Proporción | porcentaje 0–100, número | `loadUtilizationPercent` |
| Objetivo del solver | unidades enteras sin unidad física, entero | `objectiveCost` |

`objectiveCost` **nunca** se presenta como euros: refleja la escala interna del
optimizador. El coste económico se calcula aparte y es el único que se muestra al
usuario.

## Coste económico determinista

El MVP separa dos magnitudes que no se mezclan:

- **objetivo del solver**: suma de costes de arco y penalizaciones en unidades
  internas enteras (`objectiveCost`). No es dinero y no se muestra como euros.
- **coste económico**: solo depende de la solución ya calculada y se expresa en
  céntimos enteros (`economicCostCents`).

```text
economicCostCents =
    costes fijos de vehículos activos
  + distancia × coste/km de cada vehículo
  + tiempo de conducción × coste/minuto de cada vehículo
  + retraso × penalización/minuto
  + pedidos no asignados × penalización por pedido
```

Reglas de cálculo:

1. Cada sumando se redondea a céntimos enteros antes de sumar; el total es la suma de
   los sumandos redondeados, no el redondeo de la suma.
2. "Vehículo activo" es el que tiene al menos una parada en el plan vigente. Un
   vehículo desplegado sin paradas no suma coste fijo.
3. Valores de referencia usados por el ejemplo dorado y por el validador de la
   Fase 0: `DELAY_PENALTY_CENTS_PER_MINUTE = 25` y
   `UNASSIGNED_ORDER_PENALTY_CENTS = 1500`. La Fase 5 puede ajustarlos, pero
   cualquier cambio obliga a actualizar el ejemplo dorado y el validador en el mismo
   cambio.

## Implementación de referencia

`spike/fase0/` contiene la implementación mínima que cumple estos contratos y las
pruebas que la respaldan: conversión mundo/grafo, snap, bloqueo de aristas, caminos
mínimos, descarte de resultados obsoletos, VRP mínimo con OR-Tools y carga de un GLB.
No es producto: la Fase 3 y la Fase 5 lo reimplementan dentro del backend.

## Fuera del alcance de estos contratos

Autenticación, multiusuario, mapas externos, latitud/longitud, generación de datos,
persistencia concreta en SQLite, elección de librería de estado en React y modelos
GLB finales. La Fase 0 no implementa pantallas ni backend productivo.
