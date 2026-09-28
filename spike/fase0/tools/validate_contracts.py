#!/usr/bin/env python3
"""Validate the Phase 0 contracts.

It checks three things:

1. that every schema is valid JSON Schema 2020-12 and its cross `$ref`s resolve;
2. that every example validates against the schema declared in `EXAMPLES` (resolving
   the `$exampleRef` composition key first, with an optional JSON Pointer fragment);
3. semantic coherence of the golden example and REST contract coverage: the frozen list
   in `docs/contracts/endpoints.json` is the source of truth and every declared endpoint
   has to appear in `docs/contracts/rest-sse.md`.

Without `jsonschema` installed, steps 1 and 2 are skipped and the script exits with code
2 so that nobody mistakes a partial validation for a complete one.

Usage:
    python spike/fase0/tools/validate_contracts.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_DIR = REPO_ROOT / "docs" / "contracts"
SCHEMAS_DIR = CONTRACTS_DIR / "schemas"
EXAMPLES_DIR = CONTRACTS_DIR / "examples"
ENDPOINTS_FILE = CONTRACTS_DIR / "endpoints.json"
REST_CONTRACT_FILE = CONTRACTS_DIR / "rest-sse.md"

# Reference cost parameters of the MVP. They are configurable in Phase 5, but the
# Phase 0 golden example is validated against these specific values.
DELAY_PENALTY_CENTS_PER_MINUTE = 25
UNASSIGNED_ORDER_PENALTY_CENTS = 1500

LENGTH_TOLERANCE_M = 1e-6
CENT_TOLERANCE = 1e-9
MAX_BARRIERS = 2
EDGE_ALTITUDE_IGNORED = ("x", "z")

DRAFT_URL = "https://json-schema.org/draft/2020-12/schema"

# Example -> (schema file, JSON Pointer fragment inside the schema).
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

try:  # optional dependency: reported as a blocker when it is missing
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    HAS_JSONSCHEMA = True
except ImportError:  # pragma: no cover - depends on the environment
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
    """Resolve a minimal RFC 6901 JSON Pointer."""
    if not pointer:
        return document
    if not pointer.startswith("/"):
        raise ValueError(f"unsupported fragment: {pointer!r}")
    current = document
    for raw_token in pointer.split("/")[1:]:
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            current = current[int(token)]
        else:
            current = current[token]
    return current


def resolve_example_refs(node: Any, *, stack: tuple[str, ...] = ()) -> Any:
    """Recursively replace `{"$exampleRef": "file.json#/pointer"}`."""
    if isinstance(node, dict):
        if set(node.keys()) == {"$exampleRef"}:
            target = node["$exampleRef"]
            if not isinstance(target, str):
                raise ValueError("$exampleRef must be a string")
            file_part, _, pointer = target.partition("#")
            if file_part in stack:
                raise ValueError(f"$exampleRef cycle: {' -> '.join(stack + (file_part,))}")
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
            result.fail(f"schema {path.name}", f"invalid JSON: {exc}")
            continue
        schema_id = schema.get("$id")
        if not schema_id:
            result.fail(f"schema {path.name}", "missing $id")
            continue
        schemas[schema_id] = schema
        result.ok(f"schema {path.name} loaded")
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
        except Exception as exc:  # noqa: BLE001 - reported as-is
            result.fail(f"check_schema {schema_id}", str(exc))
        else:
            result.ok(f"check_schema {Path(schema_id).name}")


def validate_examples(schemas: dict[str, Any], result: CheckResult) -> dict[str, Any]:
    registry = build_registry(schemas) if HAS_JSONSCHEMA else None
    materialized: dict[str, Any] = {}

    example_files = sorted(path.name for path in EXAMPLES_DIR.glob("*.json"))
    for name in example_files:
        if name not in EXAMPLES:
            result.fail(f"example {name}", "no entry in the EXAMPLES table")
    for name in EXAMPLES:
        if name not in example_files:
            result.fail(f"example {name}", "declared in EXAMPLES but missing")

    for name, (schema_file, pointer) in EXAMPLES.items():
        schema_id = f"https://roboroute.local/contracts/{schema_file}"
        if schema_id not in schemas:
            result.fail(f"example {name}", f"missing schema: {schema_file}")
            continue
        try:
            document = resolve_example_refs(load_json(EXAMPLES_DIR / name))
        except Exception as exc:  # noqa: BLE001
            result.fail(f"example {name}", f"could not be composed: {exc}")
            continue
        materialized[name] = document
        if not HAS_JSONSCHEMA:
            continue
        try:
            validator = validator_for(schema_id, pointer, registry)
        except Exception as exc:  # noqa: BLE001
            result.fail(f"example {name}", f"unresolvable schema: {exc}")
            continue
        errors = sorted(validator.iter_errors(document), key=lambda error: list(error.path))
        if errors:
            detail = "; ".join(
                f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
                for error in errors[:4]
            )
            result.fail(f"example {name}", detail)
        else:
            result.ok(f"example {name} validates against {schema_file}{pointer}")
    return materialized


def check_example_composition(materialized: dict[str, Any], result: CheckResult) -> None:
    golden = materialized.get("scenario-revision.example.json")
    if golden is None:
        result.fail("composition", "the golden scenario example is missing")
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
            f"composition {standalone}",
            "the golden example does not match the standalone example",
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
            f"composition {example_name}",
            "the standalone example does not match the object in the golden example",
        )

    edge_example = materialized.get("road-edge.example.json")
    golden_edges = {edge["edgeId"]: edge for edge in golden["graph"]["edges"]}
    result.expect(
        edge_example is not None
        and golden_edges.get(edge_example.get("edgeId")) == edge_example,
        "composition road-edge.example.json",
        "the standalone example does not match the edge in the golden example",
    )


def distance_xz(a: dict[str, float], b: dict[str, float]) -> float:
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def canonical_edge_id(first_node_id: str, second_node_id: str) -> str:
    """Derive the canonical edgeId: E- + nodeId without the dash, lower one first."""
    low, high = sorted((first_node_id, second_node_id))
    return f"E-{low.replace('-', '')}-{high.replace('-', '')}"


def check_scenario_consistency(scenario: dict[str, Any], result: CheckResult) -> None:
    prefix = "scenario"
    nodes = {node["nodeId"]: node for node in scenario["graph"]["nodes"]}
    edges = {edge["edgeId"]: edge for edge in scenario["graph"]["edges"]}

    result.expect(len(nodes) == len(scenario["graph"]["nodes"]), f"{prefix}: unique nodeId")
    result.expect(len(edges) == len(scenario["graph"]["edges"]), f"{prefix}: unique edgeId")
    result.expect(
        sum(1 for node in nodes.values() if node["kind"] == "DEPOT") == 1,
        f"{prefix}: exactly one DEPOT",
    )

    for node in nodes.values():
        result.expect(
            node["position"]["y"] == 0,
            f"{prefix}: node {node['nodeId']} is flat",
            "the MVP city is flat (y = 0)",
        )

    for edge in edges.values():
        label = f"{prefix}: edge {edge['edgeId']}"
        result.expect(
            edge["fromNodeId"] in nodes and edge["toNodeId"] in nodes,
            f"{label} references existing nodes",
        )
        result.expect(
            edge["fromNodeId"] < edge["toNodeId"],
            f"{label} canonical pair",
            "fromNodeId must be the lower one",
        )
        result.expect(
            edge["edgeId"] == canonical_edge_id(edge["fromNodeId"], edge["toNodeId"]),
            f"{label} derived id",
        )
        expected_length = distance_xz(
            nodes[edge["fromNodeId"]]["position"], nodes[edge["toNodeId"]]["position"]
        )
        result.expect(
            abs(edge["lengthMeters"] - expected_length) <= LENGTH_TOLERANCE_M,
            f"{label} lengthMeters",
            f"expected {expected_length}, declared {edge['lengthMeters']}",
        )
        result.expect(
            edge["bidirectional"] is True,
            f"{label} bidirectional",
            "the MVP blocks both directions",
        )

    blocked = set(scenario["blockedEdgeIds"])
    result.expect(
        len(scenario["barriers"]) <= MAX_BARRIERS,
        f"{prefix}: barrier maximum",
        f"{len(scenario['barriers'])} > {MAX_BARRIERS}",
    )
    result.expect(
        blocked == {barrier["blockedEdgeId"] for barrier in scenario["barriers"]},
        f"{prefix}: blockedEdgeIds derives from the barriers",
    )
    result.expect(
        blocked <= set(edges),
        f"{prefix}: blocked edges exist",
        ", ".join(sorted(blocked - set(edges))),
    )

    orders = {order["orderId"]: order for order in scenario["orders"]}
    for order in orders.values():
        result.expect(
            nodes[order["deliveryNodeId"]]["kind"] == "DELIVERY",
            f"{prefix}: order {order['orderId']} on a delivery node",
        )
        result.expect(
            order["timeWindow"]["startSeconds"] < order["timeWindow"]["endSeconds"],
            f"{prefix}: time window of {order['orderId']} is coherent",
        )

    vehicles = {vehicle["vehicleId"]: vehicle for vehicle in scenario["vehicles"]}
    result.expect(
        len(scenario["vehicles"]) <= 6,
        f"{prefix}: vehicle maximum",
    )
    for vehicle in vehicles.values():
        result.expect(
            vehicle["loadKilograms"] <= vehicle["capacityKilograms"],
            f"{prefix}: load of {vehicle['vehicleId']} within capacity",
        )
        result.expect(
            vehicle["currentNodeId"] is None or vehicle["currentNodeId"] in nodes,
            f"{prefix}: current node of {vehicle['vehicleId']} exists",
        )

    plan = scenario.get("routePlan")
    kpis = scenario.get("kpis")
    result.expect(plan is not None, f"{prefix}: the example includes a plan")
    result.expect(kpis is not None, f"{prefix}: the example includes KPIs")
    if plan is None or kpis is None:
        return

    result.expect(
        plan["scenarioRevision"] == scenario["scenarioRevision"],
        f"{prefix}: the plan shares the revision",
    )
    result.expect(
        kpis["scenarioRevision"] == scenario["scenarioRevision"],
        f"{prefix}: the KPIs share the revision",
    )

    route_distance_total = 0.0
    route_duration_max = 0
    active_vehicle_ids: list[str] = []
    stops_by_order: dict[str, tuple[str, int]] = {}
    drive_seconds_by_vehicle: dict[str, int] = {}

    for route in plan["vehicles"]:
        vehicle_id = route["vehicleId"]
        label = f"{prefix}: route of {vehicle_id}"
        result.expect(vehicle_id in vehicles, f"{label} exists in the fleet")
        sequence = route["nodeSequence"]
        result.expect(len(sequence) >= 1, f"{label} has at least one node")
        result.expect(
            sequence[0] == "N-001",
            f"{label} starts at the depot",
            f"starts at {sequence[0]}",
        )
        result.expect(
            len(route["edgeSequence"]) == len(sequence) - 1,
            f"{label} edges coherent with nodes",
        )
        route_distance = 0.0
        for index, (a, b) in enumerate(zip(sequence, sequence[1:])):
            edge_id = canonical_edge_id(a, b)
            result.expect(edge_id in edges, f"{label} edge {edge_id} exists")
            if edge_id not in edges:
                continue
            result.expect(
                route["edgeSequence"][index] == edge_id,
                f"{label} edge in order",
                f"position {index}",
            )
            result.expect(
                edge_id not in blocked,
                f"{label} does not cross a blocked edge",
                edge_id,
            )
            route_distance += edges[edge_id]["lengthMeters"]
        result.expect(
            abs(route_distance - route["distanceMeters"]) <= LENGTH_TOLERANCE_M,
            f"{label} distance",
            f"expected {route_distance}, declared {route['distanceMeters']}",
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
            result.expect(order is not None, f"{label} stop {order_id} exists")
            if order is None:
                continue
            result.expect(
                order["deliveryNodeId"] == stop["nodeId"],
                f"{label} stop {order_id} on its delivery node",
            )
            result.expect(
                order["assignedVehicleId"] == vehicle_id,
                f"{label} order {order_id} points at the vehicle",
            )
            result.expect(
                order["sequenceIndex"] == stop_index,
                f"{label} index of {order_id}",
            )
            result.expect(
                stop["serviceEndSeconds"]
                == stop["serviceStartSeconds"]
                + max(order["serviceSeconds"], 0),
                f"{label} service of {order_id}",
            )

    result.expect(
        abs(route_distance_total - kpis["distanceTotalMeters"]) <= LENGTH_TOLERANCE_M,
        f"{prefix}: total distance of the KPIs",
        f"expected {route_distance_total}, declared {kpis['distanceTotalMeters']}",
    )
    result.expect(
        route_duration_max == kpis["plannedDurationSeconds"],
        f"{prefix}: planned duration of the KPIs",
        f"expected {route_duration_max}, declared {kpis['plannedDurationSeconds']}",
    )
    result.expect(
        len(active_vehicle_ids) == kpis["activeVehicles"],
        f"{prefix}: active vehicles",
        f"expected {len(active_vehicle_ids)}, declared {kpis['activeVehicles']}",
    )

    for order in orders.values():
        if order["status"] == "UNASSIGNED":
            result.expect(
                order["orderId"] not in stops_by_order,
                f"{prefix}: {order['orderId']} has no stop",
            )
            result.expect(
                any(
                    entry["orderId"] == order["orderId"]
                    for entry in plan["unassignedOrders"]
                ),
                f"{prefix}: {order['orderId']} appears in unassignedOrders",
            )
        elif order["status"] in {"ASSIGNED", "DELIVERED", "DELAYED"}:
            result.expect(
                order["orderId"] in stops_by_order,
                f"{prefix}: {order['orderId']} has a stop in the plan",
            )

    unassigned_count = len(plan["unassignedOrders"])
    result.expect(
        unassigned_count == kpis["ordersUnassigned"],
        f"{prefix}: unassigned orders are coherent",
    )
    result.expect(
        plan["objectiveCostBreakdown"]["unassignedOrderCount"] == unassigned_count,
        f"{prefix}: objective breakdown is coherent",
    )
    result.expect(
        (plan["objectiveCostBreakdown"]["dropPenaltyUnits"] > 0) == (unassigned_count > 0),
        f"{prefix}: abandonment penalty is coherent",
    )
    result.expect(
        plan["objectiveCost"]
        == plan["objectiveCostBreakdown"]["driveSeconds"]
        + plan["objectiveCostBreakdown"]["delaySeconds"]
        + plan["objectiveCostBreakdown"]["dropPenaltyUnits"],
        f"{prefix}: objective = drive + delay + drop (example scale)",
        "see docs/contracts/README.md",
    )

    breakdown = kpis["economicCostBreakdown"]
    breakdown_sum = sum(breakdown.values())
    result.expect(
        breakdown_sum == kpis["economicCostCents"],
        f"{prefix}: economic breakdown sums to the total",
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
            f"{prefix}: cost {key}",
            f"expected {value}, declared {breakdown[key]}",
        )

    utilization = kpis["capacityUtilizationPercentByVehicle"]
    for vehicle_id, vehicle in vehicles.items():
        expected = round(vehicle["loadKilograms"] / vehicle["capacityKilograms"] * 100, 1)
        result.expect(
            abs(utilization.get(vehicle_id, -1) - expected) <= 0.05,
            f"{prefix}: utilization of {vehicle_id}",
            f"expected {expected}, declared {utilization.get(vehicle_id)}",
        )

    intervention = kpis["lastIntervention"]
    if intervention is not None:
        result.expect(
            intervention["comparedToRevision"] == scenario["previousRevision"],
            f"{prefix}: the intervention compares against the previous revision",
        )


def check_event_consistency(materialized: dict[str, Any], result: CheckResult) -> None:
    snapshot_event = materialized.get("scenario-snapshot-event.example.json")
    if snapshot_event:
        result.expect(
            snapshot_event["payload"]["scenarioRevision"]
            == snapshot_event["scenarioRevision"],
            "scenario.snapshot event is coherent",
            "the event revision and the payload revision do not match",
        )
        result.expect(
            snapshot_event["eventId"]
            == f"{snapshot_event['scenarioRevision']}:{snapshot_event['eventSeq']}",
            "scenario.snapshot event: eventId formatted revision:sequence",
        )

    install_event = materialized.get("ai-install-progress.example.json")
    if install_event:
        result.expect(
            install_event["scenarioRevision"] is None,
            "ai.install event with no scenario revision",
        )
        result.expect(
            install_event["payload"]["modelName"] == "qwen3:4b",
            "ai.install event with a fixed model",
        )


def check_endpoint_coverage(result: CheckResult) -> None:
    # `endpoints.json` is the frozen source of truth for the endpoint list. The MVP
    # planning document that used to be the reference is gone, so the machine-readable
    # contract now drives the check instead of a hand-copied HTTP block.
    declared = load_json(ENDPOINTS_FILE)
    declared_signatures = [
        f"{endpoint['method']} {endpoint['path']}" for endpoint in declared["endpoints"]
    ]

    result.expect(
        len(declared_signatures) == len(set(declared_signatures)),
        "endpoints.json with no duplicates",
    )

    rest_text = REST_CONTRACT_FILE.read_text(encoding="utf-8")
    for signature in declared_signatures:
        method, path = signature.split(" ", 1)
        candidates = [path]
        for prefix in ("/api/scenarios", "/api/ai"):
            if path.startswith(prefix):
                candidates.append(path[len(prefix) :] or prefix)
        if not any(candidate in rest_text for candidate in candidates):
            result.fail(f"rest-sse.md documents {signature}", "the path is missing")
        elif method not in rest_text:
            result.fail(f"rest-sse.md documents {signature}", "the method is missing")
        else:
            result.ok(f"rest-sse.md documents {signature}")

    error_codes = set()
    for endpoint in declared["endpoints"]:
        error_codes.update(endpoint["errorCodes"])
    schemas_errors = load_json(SCHEMAS_DIR / "envelopes.schema.json")
    catalog = set(schemas_errors["$defs"]["errorCode"]["enum"])
    result.expect(
        error_codes <= catalog,
        "the error codes of endpoints.json exist in the catalogue",
        ", ".join(sorted(error_codes - catalog)),
    )
    for code in sorted(catalog):
        if code not in rest_text:
            result.fail("error catalogue documented", f"{code} is missing from rest-sse.md")
    result.ok("error catalogue documented in rest-sse.md")


def main() -> int:
    result = CheckResult()
    print("== Schemas ==")
    schemas = load_schemas(result)
    if HAS_JSONSCHEMA:
        validate_schema_definitions(schemas, result)

    print("== Examples ==")
    materialized = validate_examples(schemas, result)

    print("== Example composition ==")
    check_example_composition(materialized, result)

    print("== Golden scenario coherence ==")
    golden = materialized.get("scenario-revision.example.json")
    if golden is not None:
        check_scenario_consistency(golden, result)
    else:
        result.fail("golden scenario", "not available")
    check_event_consistency(materialized, result)

    print("== REST contract coverage ==")
    check_endpoint_coverage(result)

    print()
    if result.failures:
        print(f"RESULT: FAIL ({len(result.failures)} problems, {result.passes} checks ok)")
        for failure in result.failures:
            print(f"  - {failure}")
        return 1
    if not HAS_JSONSCHEMA:
        print(
            "RESULT: PARTIAL "
            f"({result.passes} checks ok, schema validation SKIPPED: "
            "the jsonschema package is missing)"
        )
        print("Install the dependencies with: pip install -r spike/fase0/requirements-phase0.txt")
        return 2
    print(f"RESULT: OK ({result.passes} checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
