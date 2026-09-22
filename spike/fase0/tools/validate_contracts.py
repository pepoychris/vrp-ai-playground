#!/usr/bin/env python3
"""Valida los contratos de la Fase 0.

Comprueba tres cosas:

1. que cada esquema es JSON Schema 2020-12 valido y sus `$ref` cruzados resuelven;
2. que cada ejemplo valida contra el esquema declarado en `EXAMPLES` (resolviendo
   antes la clave de composicion `$exampleRef`, con fragmento JSON Pointer opcional);
3. coherencia semantica del ejemplo dorado y cobertura del contrato REST frente a la
   seccion 8 del MVP.

Sin `jsonschema` instalado, los pasos 1 y 2 se saltan y el script termina con codigo
2 para que nadie confunda una validacion parcial con una validacion completa.

Uso:
    python spike/fase0/tools/validate_contracts.py
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_DIR = REPO_ROOT / "docs" / "contracts"
SCHEMAS_DIR = CONTRACTS_DIR / "schemas"
EXAMPLES_DIR = CONTRACTS_DIR / "examples"
ENDPOINTS_FILE = CONTRACTS_DIR / "endpoints.json"
REST_CONTRACT_FILE = CONTRACTS_DIR / "rest-sse.md"
MVP_FILE = REPO_ROOT / "MVP_ROBOROUTE_ULTIMA_MILLA.md"

# Parametros de coste de referencia del MVP. Son configurables en la Fase 5, pero el
# ejemplo dorado de la Fase 0 se valida contra estos valores concretos.
DELAY_PENALTY_CENTS_PER_MINUTE = 25
UNASSIGNED_ORDER_PENALTY_CENTS = 1500

LENGTH_TOLERANCE_M = 1e-6
CENT_TOLERANCE = 1e-9
MAX_BARRIERS = 3
EDGE_ALTITUDE_IGNORED = ("x", "z")

DRAFT_URL = "https://json-schema.org/draft/2020-12/schema"

# Ejemplo -> (archivo de esquema, fragmento JSON Pointer dentro del esquema).
EXAMPLES: dict[str, tuple[str, str]] = {
    "road-node.example.json": ("road-node.schema.json", ""),
    "road-edge.example.json": ("road-edge.schema.json", ""),
    "vehicle.example.json": ("vehicle.schema.json", ""),
    "order.example.json": ("order.schema.json", ""),
    "barrier.example.json": ("barrier.schema.json", ""),
    "route-plan.example.json": ("route-plan.schema.json", ""),
    "kpi-snapshot.example.json": ("kpi-snapshot.schema.json", ""),
    "scenario-revision.example.json": ("scenario-revision.schema.json", ""),
    "command-request-optimize.example.json": (
        "envelopes.schema.json",
        "/$defs/commandEnvelope",
    ),
    "mutation-response-barrier.example.json": (
        "envelopes.schema.json",
        "/$defs/successResponse",
    ),
    "error-response.example.json": ("envelopes.schema.json", "/$defs/errorResponse"),
    "ai-chat-response.example.json": ("envelopes.schema.json", "/$defs/aiChatResponse"),
    "scenario-snapshot-event.example.json": ("events.schema.json", ""),
    "ai-install-progress.example.json": ("events.schema.json", ""),
}

try:  # dependencia opcional: se documenta como bloqueo si no esta
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    HAS_JSONSCHEMA = True
except ImportError:  # pragma: no cover - depende del entorno
    Draft202012Validator = None  # type: ignore[assignment]
    Registry = None  # type: ignore[assignment]
    Resource = None  # type: ignore[assignment]
    DRAFT202012 = None  # type: ignore[assignment]
    HAS_JSONSCHEMA = False


class CheckResult:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.passes = 0

    def ok(self, label: str) -> None:
        self.passes += 1
        print(f"  PASS  {label}")

    def fail(self, label: str, detail: str) -> None:
        self.failures.append(f"{label}: {detail}")
        print(f"  FAIL  {label}: {detail}")

    def expect(self, condition: bool, label: str, detail: str = "") -> None:
        if condition:
            self.ok(label)
        else:
            self.fail(label, detail or "condicion no cumplida")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dereference_pointer(document: Any, pointer: str) -> Any:
    """Resuelve un JSON Pointer RFC 6901 minimo."""
    if not pointer:
        return document
    if not pointer.startswith("/"):
        raise ValueError(f"fragmento no soportado: {pointer!r}")
    current = document
    for raw_token in pointer.split("/")[1:]:
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            current = current[int(token)]
        else:
            current = current[token]
    return current


def resolve_example_refs(node: Any, *, stack: tuple[str, ...] = ()) -> Any:
    """Sustituye recursivamente `{"$exampleRef": "fichero.json#/pointer"}`."""
    if isinstance(node, dict):
        if set(node.keys()) == {"$exampleRef"}:
            target = node["$exampleRef"]
            if not isinstance(target, str):
                raise ValueError("$exampleRef debe ser una cadena")
            file_part, _, pointer = target.partition("#")
            if file_part in stack:
                raise ValueError(f"ciclo de $exampleRef: {' -> '.join(stack + (file_part,))}")
            referenced = resolve_example_refs(
                load_json(EXAMPLES_DIR / file_part), stack=stack + (file_part,)
            )
            return dereference_pointer(referenced, pointer)
        return {
            key: resolve_example_refs(value, stack=stack) for key, value in node.items()
        }
    if isinstance(node, list):
        return [resolve_example_refs(item, stack=stack) for item in node]
    return node


def load_schemas(result: CheckResult) -> dict[str, Any]:
    schemas: dict[str, Any] = {}
    for path in sorted(SCHEMAS_DIR.glob("*.schema.json")):
        try:
            schema = load_json(path)
        except json.JSONDecodeError as exc:
            result.fail(f"esquema {path.name}", f"JSON invalido: {exc}")
            continue
        schema_id = schema.get("$id")
        if not schema_id:
            result.fail(f"esquema {path.name}", "sin $id")
            continue
        schemas[schema_id] = schema
        result.ok(f"esquema {path.name} cargado")
    return schemas


def build_registry(schemas: dict[str, Any]) -> Any:
    resources = [
        (schema_id, Resource.from_contents(schema, default_specification=DRAFT202012))
        for schema_id, schema in schemas.items()
    ]
    return Registry().with_resources(resources)


def validator_for(schema_id: str, pointer: str, registry: Any) -> Any:
    ref = schema_id + ("#" + pointer if pointer else "")
    wrapper = {"$schema": DRAFT_URL, "$ref": ref}
    return Draft202012Validator(wrapper, registry=registry)


def validate_schema_definitions(
    schemas: dict[str, Any], result: CheckResult
) -> None:
    for schema_id, schema in sorted(schemas.items()):
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001 - se reporta tal cual
            result.fail(f"check_schema {schema_id}", str(exc))
        else:
            result.ok(f"check_schema {Path(schema_id).name}")


def validate_examples(schemas: dict[str, Any], result: CheckResult) -> dict[str, Any]:
    registry = build_registry(schemas) if HAS_JSONSCHEMA else None
    materialized: dict[str, Any] = {}

    example_files = sorted(path.name for path in EXAMPLES_DIR.glob("*.json"))
    for name in example_files:
        if name not in EXAMPLES:
            result.fail(f"ejemplo {name}", "sin entrada en la tabla EXAMPLES")
    for name in EXAMPLES:
        if name not in example_files:
            result.fail(f"ejemplo {name}", "declarado en EXAMPLES pero no existe")

    for name, (schema_file, pointer) in EXAMPLES.items():
        schema_id = f"https://roboroute.local/contracts/{schema_file}"
        if schema_id not in schemas:
            result.fail(f"ejemplo {name}", f"esquema ausente: {schema_file}")
            continue
        try:
            document = resolve_example_refs(load_json(EXAMPLES_DIR / name))
        except Exception as exc:  # noqa: BLE001
            result.fail(f"ejemplo {name}", f"no se pudo componer: {exc}")
            continue
        materialized[name] = document
        if not HAS_JSONSCHEMA:
            continue
        try:
            validator = validator_for(schema_id, pointer, registry)
        except Exception as exc:  # noqa: BLE001
            result.fail(f"ejemplo {name}", f"esquema no resolubles: {exc}")
            continue
        errors = sorted(validator.iter_errors(document), key=lambda error: list(error.path))
        if errors:
            detail = "; ".join(
                f"{'/'.join(str(part) for part in error.path) or '<raiz>'}: {error.message}"
                for error in errors[:4]
            )
            result.fail(f"ejemplo {name}", detail)
        else:
            result.ok(f"ejemplo {name} valida contra {schema_file}{pointer}")
    return materialized


def check_example_composition(materialized: dict[str, Any], result: CheckResult) -> None:
    golden = materialized.get("scenario-revision.example.json")
    if golden is None:
        result.fail("composicion", "falta el ejemplo dorado del escenario")
        return

    pairs = [
        ("scenario-revision.example.json#/routePlan", "route-plan.example.json"),
        ("scenario-revision.example.json#/kpis", "kpi-snapshot.example.json"),
    ]
    for golden_pointer, standalone in pairs:
        composed = resolve_example_refs(
            {"$exampleRef": f"{golden_pointer}"}
        )
        expected = materialized.get(standalone)
        result.expect(
            composed == expected,
            f"composicion {standalone}",
            "el ejemplo dorado no coincide con el ejemplo independiente",
        )

    singles = [
        ("barrier.example.json", golden["barriers"][0]),
        ("vehicle.example.json", golden["vehicles"][0]),
        ("order.example.json", golden["orders"][0]),
        ("road-node.example.json", golden["graph"]["nodes"][6]),
    ]
    for example_name, golden_object in singles:
        result.expect(
            materialized.get(example_name) == golden_object,
            f"composicion {example_name}",
            "el ejemplo independiente no coincide con el objeto del ejemplo dorado",
        )

    edge_example = materialized.get("road-edge.example.json")
    golden_edges = {edge["edgeId"]: edge for edge in golden["graph"]["edges"]}
    result.expect(
        edge_example is not None
        and golden_edges.get(edge_example.get("edgeId")) == edge_example,
        "composicion road-edge.example.json",
        "el ejemplo independiente no coincide con la arista del ejemplo dorado",
    )


def distance_xz(a: dict[str, float], b: dict[str, float]) -> float:
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def canonical_edge_id(first_node_id: str, second_node_id: str) -> str:
    """Deriva el edgeId canonico: E- + nodeId sin guion, primero el menor."""
    low, high = sorted((first_node_id, second_node_id))
    return f"E-{low.replace('-', '')}-{high.replace('-', '')}"


def check_scenario_consistency(scenario: dict[str, Any], result: CheckResult) -> None:
    prefix = "escenario"
    nodes = {node["nodeId"]: node for node in scenario["graph"]["nodes"]}
    edges = {edge["edgeId"]: edge for edge in scenario["graph"]["edges"]}

    result.expect(len(nodes) == len(scenario["graph"]["nodes"]), f"{prefix}: nodeId unicos")
    result.expect(len(edges) == len(scenario["graph"]["edges"]), f"{prefix}: edgeId unicos")
    result.expect(
        sum(1 for node in nodes.values() if node["kind"] == "DEPOT") == 1,
        f"{prefix}: exactamente un DEPOT",
    )

    for node in nodes.values():
        result.expect(
            node["position"]["y"] == 0,
            f"{prefix}: nodo {node['nodeId']} plano",
            "la ciudad del MVP es plana (y = 0)",
        )

    for edge in edges.values():
        label = f"{prefix}: arista {edge['edgeId']}"
        result.expect(
            edge["fromNodeId"] in nodes and edge["toNodeId"] in nodes,
            f"{label} referencia nodos existentes",
        )
        result.expect(
            edge["fromNodeId"] < edge["toNodeId"],
            f"{label} par canonico",
            "fromNodeId debe ser el menor",
        )
        result.expect(
            edge["edgeId"] == canonical_edge_id(edge["fromNodeId"], edge["toNodeId"]),
            f"{label} id derivado",
        )
        expected_length = distance_xz(
            nodes[edge["fromNodeId"]]["position"], nodes[edge["toNodeId"]]["position"]
        )
        result.expect(
            abs(edge["lengthMeters"] - expected_length) <= LENGTH_TOLERANCE_M,
            f"{label} lengthMeters",
            f"esperado {expected_length}, declarado {edge['lengthMeters']}",
        )
        result.expect(
            edge["bidirectional"] is True,
            f"{label} bidireccional",
            "el MVP bloquea ambos sentidos",
        )

    blocked = set(scenario["blockedEdgeIds"])
    result.expect(
        len(scenario["barriers"]) <= MAX_BARRIERS,
        f"{prefix}: maximo de barreras",
        f"{len(scenario['barriers'])} > {MAX_BARRIERS}",
    )
    result.expect(
        blocked == {barrier["blockedEdgeId"] for barrier in scenario["barriers"]},
        f"{prefix}: blockedEdgeIds deriva de las barreras",
    )
    result.expect(
        blocked <= set(edges),
        f"{prefix}: aristas bloqueadas existen",
        ", ".join(sorted(blocked - set(edges))),
    )

    orders = {order["orderId"]: order for order in scenario["orders"]}
    for order in orders.values():
        result.expect(
            nodes[order["deliveryNodeId"]]["kind"] == "DELIVERY",
            f"{prefix}: pedido {order['orderId']} en nodo de entrega",
        )
        result.expect(
            order["timeWindow"]["startSeconds"] < order["timeWindow"]["endSeconds"],
            f"{prefix}: ventana de {order['orderId']} coherente",
        )

    vehicles = {vehicle["vehicleId"]: vehicle for vehicle in scenario["vehicles"]}
    result.expect(
        len(scenario["vehicles"]) <= 6,
        f"{prefix}: maximo de vehiculos",
    )
    for vehicle in vehicles.values():
        result.expect(
            vehicle["loadKilograms"] <= vehicle["capacityKilograms"],
            f"{prefix}: carga de {vehicle['vehicleId']} dentro de capacidad",
        )
        result.expect(
            vehicle["currentNodeId"] is None or vehicle["currentNodeId"] in nodes,
            f"{prefix}: nodo actual de {vehicle['vehicleId']} existe",
        )

    plan = scenario.get("routePlan")
    kpis = scenario.get("kpis")
    result.expect(plan is not None, f"{prefix}: el ejemplo incluye plan")
    result.expect(kpis is not None, f"{prefix}: el ejemplo incluye KPIs")
    if plan is None or kpis is None:
        return

    result.expect(
        plan["scenarioRevision"] == scenario["scenarioRevision"],
        f"{prefix}: el plan comparte revision",
    )
    result.expect(
        kpis["scenarioRevision"] == scenario["scenarioRevision"],
        f"{prefix}: los KPIs comparten revision",
    )

    route_distance_total = 0.0
    route_duration_max = 0
    active_vehicle_ids: list[str] = []
    stops_by_order: dict[str, tuple[str, int]] = {}
    drive_seconds_by_vehicle: dict[str, int] = {}

    for route in plan["vehicles"]:
        vehicle_id = route["vehicleId"]
        label = f"{prefix}: ruta de {vehicle_id}"
        result.expect(vehicle_id in vehicles, f"{label} existe en la flota")
        sequence = route["nodeSequence"]
        result.expect(len(sequence) >= 1, f"{label} con al menos un nodo")
        result.expect(
            sequence[0] == "N-001",
            f"{label} empieza en el deposito",
            f"empieza en {sequence[0]}",
        )
        result.expect(
            len(route["edgeSequence"]) == len(sequence) - 1,
            f"{label} aristas coherentes con nodos",
        )
        route_distance = 0.0
        for index, (a, b) in enumerate(zip(sequence, sequence[1:])):
            edge_id = canonical_edge_id(a, b)
            result.expect(edge_id in edges, f"{label} arista {edge_id} existe")
            if edge_id not in edges:
                continue
            result.expect(
                route["edgeSequence"][index] == edge_id,
                f"{label} arista en orden",
                f"posicion {index}",
            )
            result.expect(
                edge_id not in blocked,
                f"{label} no cruza arista bloqueada",
                edge_id,
            )
            route_distance += edges[edge_id]["lengthMeters"]
        result.expect(
            abs(route_distance - route["distanceMeters"]) <= LENGTH_TOLERANCE_M,
            f"{label} distancia",
            f"esperado {route_distance}, declarado {route['distanceMeters']}",
        )
        route_distance_total += route["distanceMeters"]
        route_duration_max = max(route_duration_max, route["endsAtSeconds"])
        drive_seconds_by_vehicle[vehicle_id] = route["driveSeconds"]
        if route["stops"]:
            active_vehicle_ids.append(vehicle_id)
        for stop_index, stop in enumerate(route["stops"]):
            order_id = stop["orderId"]
            stops_by_order[order_id] = (vehicle_id, stop_index)
            order = orders.get(order_id)
            result.expect(order is not None, f"{label} parada {order_id} existe")
            if order is None:
                continue
            result.expect(
                order["deliveryNodeId"] == stop["nodeId"],
                f"{label} parada {order_id} en su nodo de entrega",
            )
            result.expect(
                order["assignedVehicleId"] == vehicle_id,
                f"{label} pedido {order_id} apunta al vehiculo",
            )
            result.expect(
                order["sequenceIndex"] == stop_index,
                f"{label} indice de {order_id}",
            )
            result.expect(
                stop["serviceEndSeconds"]
                == stop["serviceStartSeconds"]
                + max(order["serviceSeconds"], 0),
                f"{label} servicio de {order_id}",
            )

    result.expect(
        abs(route_distance_total - kpis["distanceTotalMeters"]) <= LENGTH_TOLERANCE_M,
        f"{prefix}: distancia total de KPIs",
        f"esperado {route_distance_total}, declarado {kpis['distanceTotalMeters']}",
    )
    result.expect(
        route_duration_max == kpis["plannedDurationSeconds"],
        f"{prefix}: duracion prevista de KPIs",
        f"esperado {route_duration_max}, declarado {kpis['plannedDurationSeconds']}",
    )
    result.expect(
        len(active_vehicle_ids) == kpis["activeVehicles"],
        f"{prefix}: vehiculos activos",
        f"esperado {len(active_vehicle_ids)}, declarado {kpis['activeVehicles']}",
    )

    for order in orders.values():
        if order["status"] == "UNASSIGNED":
            result.expect(
                order["orderId"] not in stops_by_order,
                f"{prefix}: {order['orderId']} sin parada",
            )
            result.expect(
                any(
                    entry["orderId"] == order["orderId"]
                    for entry in plan["unassignedOrders"]
                ),
                f"{prefix}: {order['orderId']} aparece en unassignedOrders",
            )
        elif order["status"] in {"ASSIGNED", "DELIVERED", "DELAYED"}:
            result.expect(
                order["orderId"] in stops_by_order,
                f"{prefix}: {order['orderId']} tiene parada en el plan",
            )

    unassigned_count = len(plan["unassignedOrders"])
    result.expect(
        unassigned_count == kpis["ordersUnassigned"],
        f"{prefix}: pedidos sin asignar coherentes",
    )
    result.expect(
        plan["objectiveCostBreakdown"]["unassignedOrderCount"] == unassigned_count,
        f"{prefix}: desglose del objetivo coherente",
    )
    result.expect(
        (plan["objectiveCostBreakdown"]["dropPenaltyUnits"] > 0) == (unassigned_count > 0),
        f"{prefix}: penalizacion por abandono coherente",
    )
    result.expect(
        plan["objectiveCost"]
        == plan["objectiveCostBreakdown"]["driveSeconds"]
        + plan["objectiveCostBreakdown"]["delaySeconds"]
        + plan["objectiveCostBreakdown"]["dropPenaltyUnits"],
        f"{prefix}: objetivo = conduccion + retraso + abandono (escala del ejemplo)",
        "ver docs/contracts/README.md",
    )

    breakdown = kpis["economicCostBreakdown"]
    breakdown_sum = sum(breakdown.values())
    result.expect(
        breakdown_sum == kpis["economicCostCents"],
        f"{prefix}: desglose economico suma el total",
        f"{breakdown_sum} != {kpis['economicCostCents']}",
    )
    fixed_cost = sum(vehicles[vid]["fixedCostCents"] for vid in active_vehicle_ids)
    distance_cost = sum(
        round(route["distanceMeters"] / 1000 * vehicles[route["vehicleId"]]["costPerKilometerCents"])
        for route in plan["vehicles"]
        if route["vehicleId"] in vehicles
    )
    drive_cost = sum(
        round(
            drive_seconds_by_vehicle.get(route["vehicleId"], 0)
            / 60
            * vehicles[route["vehicleId"]]["costPerMinuteCents"]
        )
        for route in plan["vehicles"]
        if route["vehicleId"] in vehicles
    )
    delay_seconds = sum(stop["delaySeconds"] for route in plan["vehicles"] for stop in route["stops"])
    delay_cost = round(delay_seconds / 60 * DELAY_PENALTY_CENTS_PER_MINUTE)
    unassigned_cost = unassigned_count * UNASSIGNED_ORDER_PENALTY_CENTS
    recomputed = {
        "activeVehicleFixedCostCents": fixed_cost,
        "distanceCostCents": distance_cost,
        "driveTimeCostCents": drive_cost,
        "delayPenaltyCents": delay_cost,
        "unassignedOrderPenaltyCents": unassigned_cost,
    }
    for key, value in recomputed.items():
        result.expect(
            abs(breakdown[key] - value) <= CENT_TOLERANCE,
            f"{prefix}: coste {key}",
            f"esperado {value}, declarado {breakdown[key]}",
        )

    utilization = kpis["capacityUtilizationPercentByVehicle"]
    for vehicle_id, vehicle in vehicles.items():
        expected = round(vehicle["loadKilograms"] / vehicle["capacityKilograms"] * 100, 1)
        result.expect(
            abs(utilization.get(vehicle_id, -1) - expected) <= 0.05,
            f"{prefix}: utilizacion de {vehicle_id}",
            f"esperado {expected}, declarado {utilization.get(vehicle_id)}",
        )

    intervention = kpis["lastIntervention"]
    if intervention is not None:
        result.expect(
            intervention["comparedToRevision"] == scenario["previousRevision"],
            f"{prefix}: la intervencion compara con la revision anterior",
        )


def check_event_consistency(materialized: dict[str, Any], result: CheckResult) -> None:
    snapshot_event = materialized.get("scenario-snapshot-event.example.json")
    if snapshot_event:
        result.expect(
            snapshot_event["payload"]["scenarioRevision"]
            == snapshot_event["scenarioRevision"],
            "evento scenario.snapshot coherente",
            "la revision del evento y del payload no coinciden",
        )
        result.expect(
            snapshot_event["eventId"]
            == f"{snapshot_event['scenarioRevision']}:{snapshot_event['eventSeq']}",
            "evento scenario.snapshot: eventId con formato revision:secuencia",
        )

    install_event = materialized.get("ai-install-progress.example.json")
    if install_event:
        result.expect(
            install_event["scenarioRevision"] is None,
            "evento ai.install sin revision de escenario",
        )
        result.expect(
            install_event["payload"]["modelName"] == "qwen3:4b",
            "evento ai.install con modelo fijado",
        )


def mvp_endpoints() -> list[str]:
    text = MVP_FILE.read_text(encoding="utf-8")
    match = re.search(r"```http\n(.*?)```", text, re.DOTALL)
    if not match:
        raise RuntimeError("no se encontro el bloque http de la seccion 8 del MVP")
    signatures = []
    for line in match.group(1).splitlines():
        stripped = line.strip()
        parts = stripped.split()
        if len(parts) >= 2 and parts[0] in {"GET", "POST", "PATCH", "PUT", "DELETE"}:
            signatures.append(f"{parts[0]} {parts[1]}")
    return signatures


def check_endpoint_coverage(result: CheckResult) -> None:
    declared = load_json(ENDPOINTS_FILE)
    declared_signatures = [
        f"{endpoint['method']} {endpoint['path']}" for endpoint in declared["endpoints"]
    ]
    mvp = mvp_endpoints()

    result.expect(
        len(declared_signatures) == len(set(declared_signatures)),
        "endpoints.json sin duplicados",
    )
    result.expect(
        sorted(declared_signatures) == sorted(mvp),
        "endpoints.json coincide con la seccion 8 del MVP",
        "faltan: "
        + ", ".join(sorted(set(mvp) - set(declared_signatures)))
        + " | sobran: "
        + ", ".join(sorted(set(declared_signatures) - set(mvp))),
    )

    rest_text = REST_CONTRACT_FILE.read_text(encoding="utf-8")
    for signature in mvp:
        method, path = signature.split(" ", 1)
        candidates = [path]
        for prefix in ("/api/scenarios", "/api/ai"):
            if path.startswith(prefix):
                candidates.append(path[len(prefix) :] or prefix)
        if not any(candidate in rest_text for candidate in candidates):
            result.fail(f"rest-sse.md documenta {signature}", "no aparece la ruta")
        elif method not in rest_text:
            result.fail(f"rest-sse.md documenta {signature}", "no aparece el metodo")
        else:
            result.ok(f"rest-sse.md documenta {signature}")

    error_codes = set()
    for endpoint in declared["endpoints"]:
        error_codes.update(endpoint["errorCodes"])
    schemas_errors = load_json(SCHEMAS_DIR / "envelopes.schema.json")
    catalog = set(schemas_errors["$defs"]["errorCode"]["enum"])
    result.expect(
        error_codes <= catalog,
        "los codigos de error de endpoints.json existen en el catalogo",
        ", ".join(sorted(error_codes - catalog)),
    )
    for code in sorted(catalog):
        if code not in rest_text:
            result.fail("catalogo de errores documentado", f"{code} no aparece en rest-sse.md")
    result.ok("catalogo de errores documentado en rest-sse.md")


def main() -> int:
    result = CheckResult()
    print("== Esquemas ==")
    schemas = load_schemas(result)
    if HAS_JSONSCHEMA:
        validate_schema_definitions(schemas, result)

    print("== Ejemplos ==")
    materialized = validate_examples(schemas, result)

    print("== Composicion de ejemplos ==")
    check_example_composition(materialized, result)

    print("== Coherencia del escenario dorado ==")
    golden = materialized.get("scenario-revision.example.json")
    if golden is not None:
        check_scenario_consistency(golden, result)
    else:
        result.fail("escenario dorado", "no disponible")
    check_event_consistency(materialized, result)

    print("== Cobertura del contrato REST ==")
    check_endpoint_coverage(result)

    print()
    if result.failures:
        print(f"RESULTADO: FALLO ({len(result.failures)} problemas, {result.passes} comprobaciones ok)")
        for failure in result.failures:
            print(f"  - {failure}")
        return 1
    if not HAS_JSONSCHEMA:
        print(
            "RESULTADO: PARCIAL "
            f"({result.passes} comprobaciones ok, validacion de esquemas OMITIDA: "
            "falta el paquete jsonschema)"
        )
        print("Instala las dependencias con: pip install -r spike/fase0/requirements-phase0.txt")
        return 2
    print(f"RESULTADO: OK ({result.passes} comprobaciones)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
