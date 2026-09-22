# MVP — RoboRoute Nexus

## Centro de control 3D de última milla con robots e IA local

## 1. Visión del producto

**RoboRoute Nexus** será una demo interactiva de última milla presentada como una ciudad robótica en miniatura. El usuario no recibirá un escenario ya ejecutándose: entrará en una ciudad inactiva y controlará toda la experiencia desde un panel temático.

Desde el frontend podrá:

- Generar pedidos aleatorios.
- Crear y gestionar entre 1 y 6 vehículos robot.
- Calcular y visualizar las mejores rutas encontradas.
- Iniciar, pausar y reiniciar la simulación.
- Sujetar un vehículo con una garra robótica usando el botón derecho, moverlo y soltarlo en otra zona.
- Arrastrar una barrera robótica hasta una carretera para bloquearla.
- Observar cómo se recalculan rutas, tiempos, costes y retrasos.
- Consultar a un asistente local basado en `qwen3:4b`.
- Generar y descargar informes operativos en Markdown.

La propuesta visual será un **diorama 3D futurista y low-poly**, con carreteras iluminadas, edificios industriales, un depósito central, drones ambientales, vehículos robot y rutas representadas como flujos de energía.

## 2. Decisiones de alcance

### 2.1 Qué significa “todo empieza desde el frontend”

El usuario ejecutará una única vez:

```bash
docker compose up --build
```

Docker levantará los servicios, pero el escenario permanecerá vacío e inactivo. No se generarán pedidos, vehículos, rutas ni simulaciones automáticamente.

Las acciones de negocio comenzarán únicamente al pulsar los controles del frontend. Incluso la descarga y activación inicial de Qwen tendrá su propio botón y barra de progreso.

Un navegador no puede iniciar los contenedores que todavía deben servir ese mismo frontend; por tanto, `docker compose up` es el único paso previo inevitable.

### 2.2 Mapa completamente personalizado

El MVP no utilizará Leaflet, Mapbox, Google Maps, tiles de OpenStreetMap ni OSRM.

Se construirá una ciudad ficticia mediante Three.js y un grafo vial local:

- Cada intersección será un nodo.
- Cada tramo de carretera será una arista con un identificador estable.
- El mismo JSON alimentará la geometría visible y el motor de rutas.
- Las coordenadas serán locales `x/z`, no latitud y longitud.
- Una barrera bloqueará una arista real del grafo, no simplemente una zona visual.

Esta decisión hace que la demo sea offline, reproducible, estéticamente libre y coherente con la optimización.

### 2.3 Ollama dentro del mismo stack, no del mismo contenedor

Ollama será un servicio independiente dentro del mismo proyecto Docker Compose. El backend será el único componente autorizado para comunicarse con él.

```text
Navegador
   │
   ├── Frontend React + Three.js
   │          │
   │          ▼
   └────── Backend FastAPI
                 ├── Grafo vial + Dijkstra/A*
                 ├── OR-Tools
                 ├── Estado y eventos de simulación
                 └── Ollama ── qwen3:4b
```

No se expondrá el puerto de Ollama directamente al navegador.

## 3. Recorrido de la demo

1. La aplicación abre con la ciudad apagada y el mensaje **“Núcleo logístico en espera”**.
2. El usuario pulsa **“Energizar ciudad”** y se activa la escena 3D.
3. Selecciona de 1 a 6 robots y pulsa **“Desplegar flota”**.
4. Selecciona de 6 a 24 pedidos y pulsa **“Fabricar pedidos”**.
5. Pulsa **“Calcular misión”** y aparecen las rutas por colores.
6. Pulsa **“Iniciar reparto”** y los robots se desplazan.
7. Mantiene el botón derecho sobre un robot; una garra desciende, lo eleva y permite recolocarlo.
8. Al soltarlo, el robot se ajusta a la carretera válida más cercana y se recalcula la operación.
9. Arrastra una barrera desde el inventario y la coloca sobre una carretera.
10. El sistema bloquea el tramo, recalcula y muestra la comparación antes/después.
11. El usuario pregunta a la IA por el cambio y genera un informe final.

## 4. Controles principales del frontend

| Control temático | Función real |
|---|---|
| Energizar ciudad | Inicializa el escenario visual, sin generar datos |
| Desplegar flota | Genera entre 1 y 6 vehículos robot |
| Fabricar pedidos | Genera pedidos aleatorios sobre nodos válidos |
| Calcular misión | Ejecuta el optimizador |
| Iniciar/Pausar reparto | Controla la simulación |
| Invocar garra | Muestra instrucciones; el agarre real se realiza con botón derecho |
| Desplegar barrera | Permite arrastrar una barrera al mapa |
| Activar núcleo IA | Descarga o precarga `qwen3:4b` |
| Informe de misión | Genera y descarga un informe Markdown |
| Reiniciar colonia | Vacía el escenario y vuelve al estado inicial |

Los nombres temáticos siempre tendrán un subtítulo descriptivo para que la interfaz siga siendo comprensible.

## 5. Alcance funcional del MVP

### Escenario

- Una ciudad ficticia de tamaño fijo.
- Un depósito central.
- Entre 40 y 80 nodos viales.
- Entre 6 y 24 pedidos.
- Entre 1 y 6 vehículos.
- Generación reproducible mediante una semilla visible.
- Un máximo inicial de 3 barreras simultáneas para mantener la demo legible.

### Vehículos

Cada robot tendrá:

- Identificador `R-01` a `R-06`.
- Capacidad.
- Carga actual.
- Nivel de energía simulado.
- Velocidad.
- Coste por kilómetro y minuto.
- Posición actual en el grafo.
- Estado: disponible, en ruta, retrasado, bloqueado o finalizado.

### Pedidos

Cada pedido tendrá:

- Identificador.
- Nodo de entrega.
- Peso o volumen.
- Prioridad baja, normal o urgente.
- Ventana horaria.
- Tiempo de servicio.
- Estado operativo.

### Indicadores

- Distancia total.
- Duración prevista.
- Coste estimado.
- Pedidos entregados, pendientes, retrasados y no asignados.
- Utilización de capacidad por robot.
- Número de vehículos activos.
- Impacto de la última intervención.

El coste mostrado se calculará de forma determinista:

```text
coste estimado =
  costes fijos de vehículos activos
  + distancia × coste/km
  + tiempo de conducción × coste/minuto
  + retraso × penalización/minuto
  + pedidos no asignados × penalización
```

La función objetivo de OR-Tools y el coste económico se conservarán como magnitudes distintas.

## 6. Arquitectura propuesta

### Frontend

- React + TypeScript + Vite.
- Three.js directo, sin librería cartográfica.
- Estado de interfaz separado del estado imperativo de la escena 3D.
- EventSource/SSE para recibir revisiones del escenario y progreso de Ollama.
- Modelos GLB propios para vehículos, garra, barrera y edificios singulares.

### Backend

- Python + FastAPI.
- Estado del escenario persistido en SQLite para el MVP.
- Grafo vial propio con Dijkstra o A*.
- Google OR-Tools para asignación, orden de visitas, capacidades y ventanas horarias.
- Servicio de simulación con eventos discretos.
- Proxy seguro hacia Ollama.

### Infraestructura

- `frontend`: compilación y servidor web.
- `api`: FastAPI, grafo, OR-Tools y simulación.
- `ollama`: inferencia local.
- Volumen persistente para el modelo de Ollama.
- Volumen persistente para la base de datos.

## 7. Flujo de recálculo

```text
Interacción del usuario
        │
        ▼
Posición 3D de Three.js
        │
        ▼
Snap al nodo/arista vial más próximo
        │
        ▼
Nueva revisión del escenario
        │
        ├── Actualizar aristas bloqueadas
        ├── Regenerar matrices con Dijkstra/A*
        ├── Resolver asignación y secuencia con OR-Tools
        ├── Calcular ETA, retrasos y costes
        └── Publicar snapshot atómico por SSE
                          │
                          ▼
            Actualizar rutas y panel 3D
```

Cada comando incluirá `commandId` y `scenarioRevision`. El frontend descartará resultados antiguos que lleguen después de una revisión más reciente.

## 8. Contrato mínimo de API

```http
POST   /api/scenarios
DELETE /api/scenarios/{scenarioId}
POST   /api/scenarios/{scenarioId}/vehicles/generate
POST   /api/scenarios/{scenarioId}/orders/generate
POST   /api/scenarios/{scenarioId}/optimize
POST   /api/scenarios/{scenarioId}/simulation/start
POST   /api/scenarios/{scenarioId}/simulation/pause
PATCH  /api/scenarios/{scenarioId}/vehicles/{vehicleId}/position
POST   /api/scenarios/{scenarioId}/barriers
DELETE /api/scenarios/{scenarioId}/barriers/{barrierId}
GET    /api/scenarios/{scenarioId}
GET    /api/scenarios/{scenarioId}/events

GET    /api/ai/status
POST   /api/ai/model/install
GET    /api/ai/model/install/events
POST   /api/ai/activate
POST   /api/ai/chat
POST   /api/ai/reports/shift
POST   /api/ai/proposals/{proposalId}/confirm
POST   /api/ai/proposals/{proposalId}/reject
```

El backend fijará el modelo `qwen3:4b`; el navegador no podrá elegir otro nombre de modelo arbitrario.

## 9. Papel de la IA local

Qwen no calculará rutas, distancias, costes ni tiempos. Recibirá datos ya calculados y se ocupará de interpretar y explicar.

### Funciones de lectura

- Resumir el estado de la operación.
- Explicar por qué cambió una ruta.
- Identificar pedidos con riesgo de retraso.
- Comparar los indicadores anteriores y posteriores a una barrera.
- Explicar la carga y utilización de un vehículo.
- Responder preguntas sobre incidentes y restricciones.

### Informes

- Informe de inicio de misión.
- Informe posterior a una intervención.
- Informe final de turno.
- Resumen de incidencias, impacto y recomendaciones.
- Exportación en Markdown y JSON.

### Funciones adicionales para la demo

- **Guía contextual:** sugiere una interacción interesante según el estado actual.
- **Narrador de decisiones:** produce una explicación breve al terminar cada recálculo.
- **Comparador A/B:** explica el antes y el después usando snapshots del optimizador.
- **Clasificador de incidencias:** interpreta frases como “R-03 tiene una avería de 20 minutos”.
- **Propuestas seguras:** puede proponer retrasar un vehículo, marcarlo como no disponible o solicitar una reoptimización.

Toda acción propuesta por la IA se mostrará en una tarjeta de confirmación. El modelo nunca modificará directamente el escenario.

### Configuración inicial

```text
Modelo: qwen3:4b
Contexto: 8192 tokens
Thinking: desactivado
Temperatura de consultas: 0.2
Temperatura de informes estructurados: 0
Paralelismo: 1
Modelos cargados simultáneamente: 1
```

La primera descarga necesita Internet. Después, el modelo permanecerá en un volumen local y la inferencia funcionará sin servicios de pago, con `OLLAMA_NO_CLOUD=1`.

---

# Plan de implementación — 10 fases

## Fase 0 — Base documental y contratos

### Qué implementar

- Crear un registro de versiones aprobadas para Three.js, OR-Tools, Ollama y `qwen3:4b`.
- Definir los esquemas `RoadNode`, `RoadEdge`, `Vehicle`, `Order`, `Barrier`, `RoutePlan`, `KpiSnapshot` y `ScenarioRevision`.
- Congelar los contratos REST/SSE y las reglas de coordenadas `Three.js x/z ↔ grafo`.
- Crear una pequeña prueba técnica para cargar un GLB, seleccionar un objeto y resolver un VRP mínimo.

### Referencias

- [Three.js Fundamentals](https://threejs.org/manual/pages/fundamentals.html)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [OR-Tools Vehicle Routing](https://developers.google.com/optimization/routing)
- [Ollama Docker](https://docs.ollama.com/docker)
- [Ollama Chat API](https://docs.ollama.com/api/chat)

### Verificación

- Todos los contratos disponen de esquema y ejemplo válido.
- La conversión mundo/grafo tiene tests de ida y vuelta.
- El GLB de prueba se carga y puede seleccionarse.
- OR-Tools devuelve una solución para un escenario pequeño.

### Guardas

- No comenzar la interfaz final antes de fijar coordenadas e identificadores de aristas.
- No inventar métodos no presentes en la documentación oficial.
- No utilizar el LLM como optimizador.

## Fase 1 — Esqueleto del proyecto y arranque inactivo

### Qué implementar

- Crear frontend, API y servicio Ollama en Docker Compose.
- Añadir volúmenes persistentes para SQLite y `/root/.ollama`.
- Servir una pantalla inicial con estados de API, simulación e IA.
- Mantener el escenario vacío después de `docker compose up`.
- Implementar `GET /health`, `GET /api/ai/status` y el estado global `IDLE`.

### Referencias

- Copiar el patrón CPU/volumen de [Ollama Docker](https://docs.ollama.com/docker).
- Usar `GET /api/tags` y `GET /api/ps` según la [API de Ollama](https://docs.ollama.com/api/tags).

### Verificación

- `docker compose up --build` levanta todos los servicios.
- No existen pedidos, vehículos ni modelo descargándose automáticamente.
- El frontend diferencia `servicio disponible`, `modelo instalado` y `modelo cargado`.
- Ollama solo es accesible desde la red interna del stack.

### Guardas

- No usar un contenedor monolítico.
- No publicar el puerto `11434` en producción.
- No usar etiquetas Docker `latest` en la entrega final.

## Fase 2 — Identidad visual robótica y pipeline 3D

### Qué implementar

- Definir paleta, tipografías, iconografía, iluminación y lenguaje de animación.
- Crear en Blender los GLB de vehículo robot, garra, barrera y depósito.
- Incorporar animaciones mínimas: espera, movimiento, agarre y despliegue.
- Implementar pantalla de carga temática con progreso real de assets.
- Fijar presupuestos de polígonos, texturas, draw calls y tamaño de archivo.

### Referencias

- Copiar el patrón `GLTFLoader.loadAsync()` de [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html).
- Reproducir clips con [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html).
- Gestionar progreso con [LoadingManager](https://threejs.org/docs/pages/LoadingManager.html).

### Verificación

- Todos los modelos cargan sin errores ni rutas externas.
- Los materiales conservan la misma identidad visual.
- La escena mantiene el objetivo de FPS en el equipo de demo.
- Los recursos se liberan al regenerar la escena.

### Guardas

- No añadir postprocesado hasta cumplir el presupuesto de rendimiento.
- No exportar texturas o animaciones que no se utilicen.
- No crear seis variantes completas del robot; reutilizar geometría y variar materiales.

## Fase 3 — Ciudad 3D y grafo vial compartido

### Qué implementar

- Crear `robot-city.json` con nodos, aristas, velocidad, longitud y spline visual.
- Generar carreteras, suelo, manzanas y edificios desde el dataset local.
- Usar edificios instanciados y modelos singulares solo donde aporten identidad.
- Renderizar rutas con líneas anchas y colores por vehículo.
- Implementar cámara isométrica, zoom y navegación sin librerías cartográficas.
- Crear funciones `nearestRoadNode()` y `nearestRoadEdge()`.

### Referencias

- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Three.js ShapeGeometry](https://threejs.org/docs/pages/ShapeGeometry.html)
- [Three.js ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)
- [Three.js Line2](https://threejs.org/docs/pages/Line2.html)
- [Three.js OrbitControls](https://threejs.org/docs/pages/OrbitControls.html)

### Verificación

- Cada carretera visible corresponde a un `roadEdgeId`.
- Todos los nodos de entrega son alcanzables desde el depósito sin barreras.
- La ruta visual sigue exactamente la secuencia de aristas lógica.
- Resize, zoom y selección mantienen coordenadas correctas.

### Guardas

- No suavizar la ruta lógica con curvas visuales.
- No guardar coordenadas Three.js como latitud/longitud.
- No crear cientos de meshes repetidos cuando pueda usarse `InstancedMesh`.

## Fase 4 — Generación de flota y pedidos desde la interfaz

### Qué implementar

- Añadir controles para cantidad de vehículos `1..6`, pedidos `6..24` y semilla.
- Implementar **Desplegar flota**, **Fabricar pedidos** y **Reiniciar colonia**.
- Generar atributos aleatorios dentro de rangos válidos.
- Mostrar tarjetas de robot, inventario, capacidad y energía.
- Colocar pedidos exclusivamente en nodos de entrega alcanzables.
- Validar límites tanto en frontend como en backend.

### Referencias

- Reutilizar los esquemas definidos en la Fase 0.
- Mantener la escena 3D imperativa y publicar a React solo eventos semánticos.

### Verificación

- Nunca pueden existir más de 6 vehículos.
- La misma semilla produce el mismo escenario.
- No se generan pedidos aislados ni capacidades negativas.
- Reiniciar elimina rutas, barreras, animaciones y estado persistido del escenario actual.

### Guardas

- No usar `Math.random()` disperso por componentes; centralizar un PRNG con semilla.
- No generar datos durante el arranque de Docker.
- No permitir que el frontend eluda las restricciones del backend.

## Fase 5 — Optimización, rutas y KPIs

### Qué implementar

- Calcular caminos mínimos sobre el grafo activo con Dijkstra o A*.
- Construir matrices de tiempo y distancia para los puntos relevantes.
- Implementar OR-Tools con inicios por vehículo, capacidades, ventanas horarias y pedidos descartables.
- Limitar cada búsqueda a 1–2 segundos.
- Calcular rutas geométricas, ETA, retrasos, costes y pedidos no asignados.
- Publicar un snapshot atómico con nueva `scenarioRevision`.

### Referencias

- [OR-Tools Capacity Constraints](https://developers.google.com/optimization/routing/cvrp)
- [OR-Tools Time Windows](https://developers.google.com/optimization/routing/vrptw)
- [OR-Tools Penalties](https://developers.google.com/optimization/routing/penalties)
- [OR-Tools Common Routing Tasks](https://developers.google.com/optimization/routing/routing_tasks)

### Verificación

- Ningún vehículo supera su capacidad.
- Los pedidos urgentes reciben una penalización superior al resto.
- Los escenarios inviables devuelven pedidos no asignados, no bloquean la aplicación.
- El panel, las rutas y el snapshot muestran la misma revisión.
- Se muestran “mejores rutas encontradas”, no una garantía falsa de optimalidad.

### Guardas

- No mezclar euros, segundos y metros sin una función explícita.
- No convertir caminos imposibles en coste cero.
- No ejecutar una búsqueda sin límite temporal.

## Fase 6 — Simulación y garra robótica

### Qué implementar

- Animar los robots a lo largo de las aristas de su ruta.
- Implementar iniciar, pausar y velocidad de simulación.
- Seleccionar vehículos con `Raycaster`.
- Reservar el botón derecho para el agarre y cancelar `contextmenu`.
- Capturar el puntero, desactivar temporalmente la cámara y mostrar la garra.
- Elevar el robot mientras se arrastra y mostrar una previsualización del punto de suelta.
- Al soltar, ajustar al nodo vial más próximo y recalcular una única vez.

### Referencias

- [Three.js Raycaster](https://threejs.org/docs/pages/Raycaster.html)
- [Three.js Ray](https://threejs.org/docs/pages/Ray.html)
- [Three.js Plane](https://threejs.org/docs/pages/Plane.html)
- [W3C Pointer Events](https://www.w3.org/TR/pointerevents/)

### Verificación

- El menú contextual no aparece dentro del canvas.
- El vehículo continúa sujeto aunque el puntero salga momentáneamente del canvas.
- Una suelta fuera del radio válido se rechaza y devuelve el robot a su posición.
- Una suelta válida cambia su nodo inicial y produce una sola reoptimización.
- La simulación no aplica snapshots obsoletos.

### Guardas

- No usar `DragControls` esperando que resuelva el gesto personalizado.
- No mover el mesh hijo seleccionado; mover la raíz lógica del vehículo.
- No recalcular en cada `pointermove`.

## Fase 7 — Barrera robótica y cortes de carretera

### Qué implementar

- Añadir una barrera GLB arrastrable desde una bandeja de herramientas.
- Mostrar una proyección válida/inválida sobre la carretera más cercana.
- Al soltar, asociar la barrera a un `roadEdgeId`.
- Bloquear ambas direcciones cuando la carretera sea bidireccional.
- Regenerar matrices, rutas, KPIs y comparación antes/después.
- Permitir seleccionar y retirar la barrera.
- Destacar visualmente vehículos y pedidos afectados.

### Referencias

- Reutilizar `Raycaster`, `Ray.intersectPlane()` y Pointer Events de la Fase 6.
- Reutilizar el patrón de aristas descartadas y penalizaciones de OR-Tools.

### Verificación

- Ninguna ruta nueva atraviesa una arista bloqueada.
- Retirar la barrera restaura la arista y recalcula.
- Si una zona queda aislada, los pedidos aparecen como no asignados.
- El panel muestra variaciones de distancia, coste, ETA y retrasos.

### Guardas

- No tratar la barrera como un elemento puramente decorativo.
- No bloquear una posición de píxel; bloquear un identificador vial.
- No ocultar la posibilidad de que un corte vuelva inviable un pedido.

## Fase 8 — Copiloto local con Qwen3:4b

### Qué implementar

- Añadir **Instalar núcleo Qwen** y transmitir el progreso de `POST /api/pull`.
- Persistir el modelo y hacer idempotente la instalación.
- Añadir **Activar núcleo IA** mediante una solicitud de precarga.
- Implementar chat, explicaciones causales, comparación A/B e informes.
- Usar herramientas de solo lectura para obtener datos validados.
- Usar JSON Schema y validación Pydantic para informes.
- Implementar propuestas de acción con confirmación humana y revisión de escenario.

### Referencias

- [Ollama Pull API](https://docs.ollama.com/api/pull)
- [Ollama Chat API](https://docs.ollama.com/api/chat)
- [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [Ollama Tool Calling](https://docs.ollama.com/capabilities/tool-calling)
- [Modelo qwen3:4b](https://ollama.com/library/qwen3%3A4b)

### Verificación

- El progreso de descarga es visible y recuperable tras un fallo.
- Tras la instalación, reiniciar los contenedores no vuelve a descargar el modelo.
- El asistente responde en español usando exclusivamente datos del snapshot.
- Los informes cumplen el esquema y pueden descargarse en Markdown.
- Ninguna acción se ejecuta sin confirmación.
- Se prueba una batería de consultas ambiguas, IDs inválidos y respuestas mal formadas.

### Guardas

- No llamar a Ollama directamente desde el navegador.
- No aceptar el nombre del modelo enviado por el frontend.
- No confiar en JSON sin validarlo.
- No mostrar el razonamiento interno del modelo.
- No configurar el contexto máximo de 256K para esta demo.

## Fase 9 — Integración, verificación y presentación de portfolio

### Qué implementar

- Crear una secuencia guiada de demo de 3–5 minutos.
- Añadir tooltips e instrucciones visuales para la garra y la barrera.
- Crear pruebas unitarias, integración API y pruebas end-to-end.
- Medir FPS, draw calls, uso de memoria, tiempo de optimización y latencia de IA.
- Añadir manejo de errores recuperable para WebGL, OR-Tools y Ollama.
- Preparar README, arquitectura, GIF/vídeo y capturas del antes/después.
- Documentar requisitos de hardware y tiempos medidos en el equipo real.

### Referencias

- Usar `renderer.info` según [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html).
- Aplicar el resize recomendado por [Three.js Responsive Design](https://threejs.org/manual/pages/responsive.html).
- Verificar la implementación contra todas las referencias de las fases anteriores.

### Verificación final

- El proyecto arranca con un único comando y permanece inactivo hasta usar el frontend.
- Se generan 1–6 vehículos y 6–24 pedidos desde la interfaz.
- Las rutas respetan capacidad, ventanas y carreteras bloqueadas.
- La garra mueve un vehículo y provoca un recálculo coherente.
- La barrera bloquea una carretera y modifica rutas y KPIs.
- Qwen funciona localmente, explica resultados y genera un informe válido.
- La demo completa puede repetirse con la misma semilla.
- No existen llamadas a servicios cartográficos o de IA de pago.

### Guardas

- No ampliar el MVP con autenticación, multiusuario o mapas reales.
- No incorporar nuevas animaciones hasta corregir fallos funcionales y de rendimiento.
- No dar por terminado el proyecto sin ejecutar la secuencia completa desde un volumen limpio y otra vez con el modelo persistido.

---

## 10. Definición de terminado

El MVP estará terminado cuando una persona pueda ejecutar la siguiente historia sin utilizar consola después del arranque de Docker:

1. Abrir el frontend.
2. Activar la ciudad.
3. Crear hasta seis robots y varios pedidos.
4. Calcular e iniciar las rutas.
5. Mover un robot con la garra.
6. Bloquear una carretera con una barrera.
7. Ver el recálculo y la comparación de KPIs.
8. Preguntar a Qwen por las decisiones tomadas.
9. Descargar un informe Markdown.
10. Reiniciar el escenario y reproducirlo mediante la misma semilla.

## 11. Fuera del MVP

- Mapas reales, geocodificación y GPS.
- Leaflet, Mapbox, Google Maps, tiles OSM u OSRM.
- Tráfico real o meteorología real.
- Aplicación móvil o controles táctiles avanzados.
- Autenticación, equipos y multiusuario.
- Entrenamiento o fine-tuning de modelos.
- RAG y base vectorial.
- Procesamiento de imágenes.
- Optimización de grandes flotas.
- Despliegue público de Ollama.

Estas capacidades podrán añadirse después, pero no deben impedir que el núcleo interactivo y visual quede pulido.

## 12. Riesgos principales y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Modelos GLB demasiado pesados | Presupuesto de polígonos/texturas y medición desde la Fase 2 |
| Conflicto entre cámara y garra | Desactivar controles de cámara durante el agarre y usar pointer capture |
| Reoptimización lenta | Grafo pequeño, máximo 6 vehículos y límite OR-Tools de 1–2 segundos |
| Resultados obsoletos | `scenarioRevision` y descarte de respuestas antiguas |
| Qwen inventa métricas | Herramientas de lectura, snapshots validados y JSON Schema |
| Primera respuesta lenta | Botón de precarga, indicador de estado y `keep_alive` |
| Barrera deja pedidos aislados | Mostrar pedidos no asignados y explicar la causa |
| Demo irrepetible | Semilla visible y escenarios reproducibles |

