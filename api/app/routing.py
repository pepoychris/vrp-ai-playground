"""Deterministic Phase 5 routing, travel-time and optimisation primitives.

Every physical unit stays explicit: edge lengths are metres, travel times are whole
seconds, economic values are euro cents and objective values are dimensionless units.
Leg travel time is ``ceil(length / min(road speed limit, vehicle speed))``, so a slow
robot is never planned as if it drove at the road limit.

OR-Tools is used when the wheel is installed in the runtime. The deterministic
constructive fallback keeps contract tests and minimal development images useful: it
never consults the wall clock, so it always produces the same published plan for the
same revision.
"""

from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush
from math import ceil
from typing import Any

try:  # Optional in minimal environments; the production image pins this wheel.
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
except ImportError:  # pragma: no cover - exercised only when the optional wheel is absent
    pywrapcp = None
    routing_enums_pb2 = None


# Objective units. The Phase 5 model scores whole seconds of driving, a fixed weight
# per second of delay and a penalty per dropped order. Metres never enter the
# objective: distance is reported separately in the physical breakdown.
DELAY_UNITS_PER_SECOND = 10
URGENT_PENALTY = 3000
NORMAL_PENALTY = 1000
LOW_PENALTY = 250
PRIORITY_PENALTIES = {"URGENT": URGENT_PENALTY, "NORMAL": NORMAL_PENALTY, "LOW": LOW_PENALTY}

# Economic scale in euro cents, independent from the objective units. The frozen KPI
# example pins the NORMAL value at 1500 cents; URGENT stays strictly above NORMAL.
UNASSIGNED_PENALTY_CENTS = {"URGENT": 3000, "NORMAL": 1500, "LOW": 750}
DELAY_PENALTY_CENTS_PER_SECOND = 2

# Any arc at least this long can never fit inside the planning horizon, so the solver
# drops the order instead of pretending the two points are connected.
UNREACHABLE_ARC_SECONDS = 1_000_000
PLANNING_HORIZON_SECONDS = 24 * 3600

DEFAULT_TIME_LIMIT_SECONDS = 2
MIN_TIME_LIMIT_SECONDS = 1
MAX_TIME_LIMIT_SECONDS = 2


@dataclass(frozen=True, slots=True)
class PathResult:
    distance_meters: float
    drive_seconds: int
    node_sequence: tuple[str, ...]
    edge_sequence: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SolverResult:
    """Order ids selected per vehicle plus the solver state behind them."""

    assignments: dict[str, list[str]]
    outcome: str
    proven_optimal: bool


def depot_node_id(graph: dict[str, Any]) -> str:
    """Return the single depot node of the active graph."""
    return next(node["nodeId"] for node in graph["nodes"] if node["kind"] == "DEPOT")


def travel_seconds(
    length_meters: float, speed_limit_kph: float, vehicle_speed_kph: float | None = None
) -> int:
    """Whole seconds for one leg at the vehicle speed, capped by the road limit."""
    effective_kph = float(speed_limit_kph)
    if vehicle_speed_kph is not None:
        effective_kph = min(effective_kph, float(vehicle_speed_kph))
    if effective_kph <= 0:
        raise ValueError("effective speed must be positive")
    return ceil(length_meters / (effective_kph * 1000 / 3600))


def _adjacency(
    graph: dict[str, Any], blocked: set[str]
) -> dict[str, list[tuple[str, str, float, float]]]:
    """Map each node to ``(toNodeId, edgeId, lengthMeters, speedLimitKph)`` arcs."""
    result: dict[str, list[tuple[str, str, float, float]]] = {
        node["nodeId"]: [] for node in graph["nodes"]
    }
    for edge in graph["edges"]:
        if edge["edgeId"] in blocked:
            continue
        result[edge["fromNodeId"]].append(
            (
                edge["toNodeId"],
                edge["edgeId"],
                float(edge["lengthMeters"]),
                float(edge["speedLimitKph"]),
            )
        )
        if edge.get("bidirectional", False):
            result[edge["toNodeId"]].append(
                (
                    edge["fromNodeId"],
                    edge["edgeId"],
                    float(edge["lengthMeters"]),
                    float(edge["speedLimitKph"]),
                )
            )
    for neighbours in result.values():
        neighbours.sort(key=lambda item: (item[0], item[1]))
    return result


def shortest_path(
    graph: dict[str, Any],
    start: str,
    goal: str,
    blocked_edge_ids: set[str] | None = None,
    vehicle_speed_kph: float | None = None,
) -> PathResult | None:
    """Return a deterministic Dijkstra path, or ``None`` for a disconnected pair."""
    if start == goal:
        return PathResult(0.0, 0, (start,), ())
    adjacency = _adjacency(graph, blocked_edge_ids or set())
    queue: list[tuple[int, float, tuple[str, ...], str]] = [(0, 0.0, (start,), start)]
    best: dict[str, tuple[int, float, tuple[str, ...], tuple[str, ...]]] = {
        start: (0, 0.0, (start,), ())
    }
    while queue:
        seconds, distance, node_path, node = heappop(queue)
        current = best.get(node)
        if current is None or current[:3] != (seconds, distance, node_path):
            continue
        if node == goal:
            return PathResult(distance, seconds, node_path, current[3])
        for next_node, edge_id, edge_distance, edge_speed in adjacency.get(node, []):
            edge_seconds = travel_seconds(edge_distance, edge_speed, vehicle_speed_kph)
            candidate = (
                seconds + edge_seconds,
                distance + edge_distance,
                node_path + (next_node,),
                current[3] + (edge_id,),
            )
            previous = best.get(next_node)
            if previous is None or candidate[:3] < previous[:3]:
                best[next_node] = candidate
                heappush(queue, (candidate[0], candidate[1], candidate[2], next_node))
    return None


def build_distance_time_matrices(
    graph: dict[str, Any],
    points: list[str],
    blocked_edge_ids: set[str] | None = None,
    vehicle_speed_kph: float | None = None,
) -> dict[str, dict[str, dict[str, int | float | None]]]:
    """Build explicit metres/seconds matrices for the relevant scenario points.

    Unreachable pairs stay ``None``: an impossible path is never reported as zero
    distance or zero time.
    """
    blocked = blocked_edge_ids or set()
    return {
        origin: {
            destination: (
                None
                if (
                    path := shortest_path(
                        graph, origin, destination, blocked, vehicle_speed_kph
                    )
                )
                is None
                else {
                    "distanceMeters": path.distance_meters,
                    "driveSeconds": path.drive_seconds,
                }
            )
            for destination in points
        }
        for origin in points
    }


def _append_path(nodes: list[str], edges: list[str], path: PathResult) -> None:
    if not nodes:
        nodes.extend(path.node_sequence)
    else:
        nodes.extend(path.node_sequence[1:])
    edges.extend(path.edge_sequence)


def _idle_route(vehicle: dict[str, Any], start: str) -> dict[str, Any]:
    """A route without stops is exactly one node and never invents distance."""
    return {
        "vehicleId": vehicle["vehicleId"],
        "nodeSequence": [start],
        "edgeSequence": [],
        "stops": [],
        "distanceMeters": 0.0,
        "driveSeconds": 0,
        "loadUtilizationPercent": 0.0,
        "endsAtSeconds": 0,
    }


def _route_for_orders(
    graph: dict[str, Any],
    vehicle: dict[str, Any],
    orders: list[dict[str, Any]],
    blocked: set[str],
) -> dict[str, Any] | None:
    """Materialise one vehicle route.

    ``driveSeconds`` counts driving only, while ``endsAtSeconds`` is the end of the
    last service and therefore also carries waiting and service time. The route ends
    at its last stop: no return leg is charged to the plan.
    """
    speed = float(vehicle["speedKilometersPerHour"])
    start = vehicle.get("currentNodeId") or depot_node_id(graph)
    if not orders:
        return _idle_route(vehicle, start)
    nodes, edges = [start], []
    stops: list[dict[str, Any]] = []
    distance = 0.0
    drive_seconds = 0
    clock = 0
    kilograms = 0.0
    volume = 0.0
    current = start
    for order in orders:
        path = shortest_path(graph, current, order["deliveryNodeId"], blocked, speed)
        if path is None:
            return None
        _append_path(nodes, edges, path)
        distance += path.distance_meters
        drive_seconds += path.drive_seconds
        arrival = clock + path.drive_seconds
        service_start = max(arrival, int(order["timeWindow"]["startSeconds"]))
        delay = max(0, service_start - int(order["timeWindow"]["endSeconds"]))
        service_end = service_start + int(order["serviceSeconds"])
        stops.append(
            {
                "orderId": order["orderId"],
                "nodeId": order["deliveryNodeId"],
                "arrivalSeconds": arrival,
                "serviceStartSeconds": service_start,
                "serviceEndSeconds": service_end,
                "delaySeconds": delay,
            }
        )
        clock = service_end
        kilograms += float(order["weightKilograms"])
        volume += float(order["volumeCubicMeters"])
        current = order["deliveryNodeId"]
    load_ratio = max(
        kilograms / float(vehicle["capacityKilograms"]),
        volume / float(vehicle["capacityCubicMeters"]),
    )
    return {
        "vehicleId": vehicle["vehicleId"],
        "nodeSequence": nodes,
        "edgeSequence": edges,
        "stops": stops,
        "distanceMeters": distance,
        "driveSeconds": drive_seconds,
        "loadUtilizationPercent": min(100.0, load_ratio * 100),
        "endsAtSeconds": clock,
    }


def _first_unreachable_order(
    graph: dict[str, Any],
    vehicle: dict[str, Any],
    orders: list[dict[str, Any]],
    blocked: set[str],
) -> str | None:
    """Return the first order whose leg cannot be driven, if any."""
    speed = float(vehicle["speedKilometersPerHour"])
    current = vehicle.get("currentNodeId") or depot_node_id(graph)
    for order in orders:
        if shortest_path(graph, current, order["deliveryNodeId"], blocked, speed) is None:
            return order["orderId"]
        current = order["deliveryNodeId"]
    return None


def _drop_reason(order: dict[str, Any], vehicles: list[dict[str, Any]]) -> str:
    """Classify an order the solver refused while the scenario stays feasible."""
    fits_somewhere = any(
        float(order["weightKilograms"]) <= float(vehicle["capacityKilograms"]) + 1e-9
        and float(order["volumeCubicMeters"])
        <= float(vehicle["capacityCubicMeters"]) + 1e-9
        for vehicle in vehicles
    )
    return "DROPPED_BY_PENALTY" if fits_somewhere else "NO_CAPACITY"


def _constructive_assignments(
    graph: dict[str, Any],
    vehicles: list[dict[str, Any]],
    orders: list[dict[str, Any]],
    blocked: set[str],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    """Deterministic capacity-safe fallback used when OR-Tools is unavailable.

    The pass is bounded by the contract input sizes (at most 24 orders and 6
    vehicles) and never consults the wall clock, so it is reproducible.
    """
    assignments: dict[str, list[dict[str, Any]]] = {
        vehicle["vehicleId"]: [] for vehicle in vehicles
    }
    reasons: dict[str, str] = {}
    remaining_kg = {
        vehicle["vehicleId"]: float(vehicle["capacityKilograms"])
        - float(vehicle.get("loadKilograms", 0))
        for vehicle in vehicles
    }
    remaining_volume = {
        vehicle["vehicleId"]: float(vehicle["capacityCubicMeters"])
        - float(vehicle.get("loadCubicMeters", 0))
        for vehicle in vehicles
    }
    priority = {"URGENT": 0, "NORMAL": 1, "LOW": 2}
    ordered = sorted(
        orders,
        key=lambda order: (
            priority.get(order["priority"], 1),
            int(order["timeWindow"]["endSeconds"]),
            order["orderId"],
        ),
    )
    for order in ordered:
        candidates: list[tuple[float, str]] = []
        had_capacity = False
        for vehicle in vehicles:
            vehicle_id = vehicle["vehicleId"]
            if (
                remaining_kg[vehicle_id] + 1e-9 < float(order["weightKilograms"])
                or remaining_volume[vehicle_id] + 1e-9
                < float(order["volumeCubicMeters"])
            ):
                continue
            had_capacity = True
            current = (
                assignments[vehicle_id][-1]["deliveryNodeId"]
                if assignments[vehicle_id]
                else (vehicle.get("currentNodeId") or depot_node_id(graph))
            )
            path = shortest_path(
                graph,
                current,
                order["deliveryNodeId"],
                blocked,
                float(vehicle["speedKilometersPerHour"]),
            )
            if path is not None:
                candidates.append((path.distance_meters, vehicle_id))
        if not candidates:
            reasons[order["orderId"]] = "NO_CAPACITY" if had_capacity else "UNREACHABLE"
            continue
        _, selected = min(candidates, key=lambda item: (item[0], item[1]))
        assignments[selected].append(order)
        remaining_kg[selected] -= float(order["weightKilograms"])
        remaining_volume[selected] -= float(order["volumeCubicMeters"])
    return assignments, reasons


def _ortools_assignments(
    graph: dict[str, Any],
    vehicles: list[dict[str, Any]],
    orders: list[dict[str, Any]],
    blocked: set[str],
    time_limit_seconds: int,
) -> SolverResult | None:
    """Solve the bounded VRP with OR-Tools, or return ``None`` when unavailable.

    Each vehicle keeps its own transit callback, so time windows and arc costs are
    evaluated with that vehicle's own speed. Unreachable pairs use a finite arc that
    cannot fit in the planning horizon, so the solver drops the order through its
    penalty instead of inventing a connection.
    """
    if pywrapcp is None or routing_enums_pb2 is None:
        return None
    depot = depot_node_id(graph)
    point_ids = [depot, *[order["deliveryNodeId"] for order in orders]]
    index_of = {node_id: index for index, node_id in enumerate(point_ids)}
    speeds = [float(vehicle["speedKilometersPerHour"]) for vehicle in vehicles]
    matrices = {
        speed: build_distance_time_matrices(graph, point_ids, blocked, speed)
        for speed in set(speeds)
    }

    # Open routes: every vehicle ends on a free synthetic node, so the solver never
    # charges a return leg that the published route does not contain.
    end_node = len(point_ids)
    starts = [
        index_of.get(vehicle.get("currentNodeId") or depot, 0) for vehicle in vehicles
    ]
    manager = pywrapcp.RoutingIndexManager(
        len(point_ids) + 1, len(vehicles), starts, [end_node] * len(vehicles)
    )
    routing = pywrapcp.RoutingModel(manager)

    def arc_seconds(speed: float, from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        if to_node == end_node:
            return 0
        if from_node == end_node:
            return UNREACHABLE_ARC_SECONDS
        entry = matrices[speed][point_ids[from_node]][point_ids[to_node]]
        return UNREACHABLE_ARC_SECONDS if entry is None else int(entry["driveSeconds"])

    callbacks = [
        routing.RegisterTransitCallback(
            lambda from_index, to_index, speed=speed: arc_seconds(
                speed, from_index, to_index
            )
        )
        for speed in speeds
    ]
    for vehicle_index, callback in enumerate(callbacks):
        routing.SetArcCostEvaluatorOfVehicle(callback, vehicle_index)
    routing.AddDimensionWithVehicleTransits(
        callbacks, 0, PLANNING_HORIZON_SECONDS, False, "Time"
    )
    time_dimension = routing.GetDimensionOrDie("Time")
    for vehicle_index in range(len(vehicles)):
        time_dimension.CumulVar(routing.Start(vehicle_index)).SetRange(
            0, PLANNING_HORIZON_SECONDS
        )
    def order_index_of(from_index: int) -> int | None:
        node = manager.IndexToNode(from_index)
        return node - 1 if 1 <= node <= len(orders) else None

    def kilograms_demand(from_index: int) -> int:
        order_index = order_index_of(from_index)
        if order_index is None:
            return 0
        return int(round(float(orders[order_index]["weightKilograms"]) * 100))

    def volume_demand(from_index: int) -> int:
        order_index = order_index_of(from_index)
        if order_index is None:
            return 0
        return int(round(float(orders[order_index]["volumeCubicMeters"]) * 100))

    kilograms_callback = routing.RegisterUnaryTransitCallback(kilograms_demand)
    routing.AddDimensionWithVehicleCapacity(
        kilograms_callback,
        0,
        [int(round(float(vehicle["capacityKilograms"]) * 100)) for vehicle in vehicles],
        True,
        "Kilograms",
    )
    volume_callback = routing.RegisterUnaryTransitCallback(volume_demand)
    routing.AddDimensionWithVehicleCapacity(
        volume_callback,
        0,
        [
            int(round(float(vehicle["capacityCubicMeters"]) * 100))
            for vehicle in vehicles
        ],
        True,
        "Volume",
    )
    for order_index, order in enumerate(orders, start=1):
        index = manager.NodeToIndex(order_index)
        # Service never starts before the window opens, but a late arrival is a
        # delay to be paid for (exactly what the plan reports as delaySeconds)
        # instead of an impossible order.
        time_dimension.CumulVar(index).SetRange(
            int(order["timeWindow"]["startSeconds"]), PLANNING_HORIZON_SECONDS
        )
        time_dimension.SetCumulVarSoftUpperBound(
            index,
            int(order["timeWindow"]["endSeconds"]),
            DELAY_UNITS_PER_SECOND,
        )
        routing.AddDisjunction([index], PRIORITY_PENALTIES[order["priority"]])
    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    parameters.time_limit.FromSeconds(
        max(MIN_TIME_LIMIT_SECONDS, min(MAX_TIME_LIMIT_SECONDS, int(time_limit_seconds)))
    )
    parameters.sat_parameters.random_seed = 1
    solution = routing.SolveWithParameters(parameters)
    status = routing.status()
    search_status = routing_enums_pb2.RoutingSearchStatus
    empty = {vehicle["vehicleId"]: [] for vehicle in vehicles}
    if solution is None:
        if status == search_status.ROUTING_INFEASIBLE:
            return SolverResult(empty, "INFEASIBLE", False)
        if status == search_status.ROUTING_FAIL_TIMEOUT:
            return SolverResult(empty, "TIME_LIMIT_REACHED", False)
        return SolverResult(empty, "NO_SOLUTION", False)
    assignments: dict[str, list[str]] = {vehicle["vehicleId"]: [] for vehicle in vehicles}
    for vehicle_index, vehicle in enumerate(vehicles):
        index = routing.Start(vehicle_index)
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node > 0:
                assignments[vehicle["vehicleId"]].append(orders[node - 1]["orderId"])
            index = solution.Value(routing.NextVar(index))
    if status == search_status.ROUTING_OPTIMAL:
        return SolverResult(assignments, "OPTIMAL", True)
    if status == search_status.ROUTING_FAIL_TIMEOUT:
        return SolverResult(assignments, "TIME_LIMIT_REACHED", False)
    return SolverResult(assignments, "FEASIBLE", False)


def optimize_snapshot(
    snapshot: dict[str, Any], time_limit_seconds: int = DEFAULT_TIME_LIMIT_SECONDS
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Optimise one snapshot within the bounded search limit.

    The published plan is capacity-safe and, which orders stay unassigned is always
    an explicit list instead of a silent drop.
    """
    graph = snapshot["graph"]
    blocked = set(snapshot.get("blockedEdgeIds", []))
    vehicles = snapshot["vehicles"]
    orders = snapshot["orders"]
    depot = depot_node_id(graph)

    unassigned: dict[str, str] = {}
    candidates: list[dict[str, Any]] = []
    for order in orders:
        if shortest_path(graph, depot, order["deliveryNodeId"], blocked) is None:
            unassigned[order["orderId"]] = "UNREACHABLE"
        else:
            candidates.append(order)

    solver = (
        _ortools_assignments(graph, vehicles, candidates, blocked, time_limit_seconds)
        if candidates
        else None
    )
    assignments: dict[str, list[dict[str, Any]]]
    if solver is None:
        assignments, reasons = _constructive_assignments(
            graph, vehicles, candidates, blocked
        )
        unassigned.update(reasons)
        outcome = "FEASIBLE" if any(assignments.values()) else "INFEASIBLE"
        proven_optimal = False
    else:
        by_id = {order["orderId"]: order for order in candidates}
        assignments = {
            vehicle["vehicleId"]: [
                by_id[order_id]
                for order_id in solver.assignments[vehicle["vehicleId"]]
                if order_id in by_id
            ]
            for vehicle in vehicles
        }
        served = {
            order["orderId"] for selected in assignments.values() for order in selected
        }
        for order in candidates:
            if order["orderId"] not in served:
                unassigned[order["orderId"]] = _drop_reason(order, vehicles)
        outcome = solver.outcome
        proven_optimal = solver.proven_optimal

    route_vehicles: list[dict[str, Any]] = []
    for vehicle in vehicles:
        pending = assignments.get(vehicle["vehicleId"], [])
        route = _route_for_orders(graph, vehicle, pending, blocked)
        while route is None and pending:
            failed = _first_unreachable_order(graph, vehicle, pending, blocked)
            if failed is None:
                break
            unassigned[failed] = "UNREACHABLE"
            pending = [order for order in pending if order["orderId"] != failed]
            route = _route_for_orders(graph, vehicle, pending, blocked)
        if route is None:
            route = _route_for_orders(graph, vehicle, [], blocked)
        assert route is not None
        route_vehicles.append(route)

    assigned_ids = {
        stop["orderId"] for route in route_vehicles for stop in route["stops"]
    }
    unassigned = {
        order_id: reason
        for order_id, reason in unassigned.items()
        if order_id not in assigned_ids
    }

    total_distance = sum(route["distanceMeters"] for route in route_vehicles)
    total_drive = sum(route["driveSeconds"] for route in route_vehicles)
    total_delay = sum(
        stop["delaySeconds"] for route in route_vehicles for stop in route["stops"]
    )
    orders_by_id = {order["orderId"]: order for order in orders}
    drop_penalty = sum(
        PRIORITY_PENALTIES[orders_by_id[order_id]["priority"]] for order_id in unassigned
    )
    # Objective units: driving seconds + weighted delay + drop penalty. Distance is
    # reported in the breakdown but excluded from the objective.
    objective_cost = int(
        round(total_drive + total_delay * DELAY_UNITS_PER_SECOND + drop_penalty)
    )
    unassigned_reasons = [
        {"orderId": order_id, "reason": unassigned[order_id]}
        for order_id in sorted(unassigned)
    ]
    route_plan = {
        "scenarioRevision": snapshot["scenarioRevision"],
        "generatedAt": snapshot["emittedAt"],
        "timeLimitSeconds": time_limit_seconds,
        "solverOutcome": outcome,
        "objectiveIsProvenOptimal": proven_optimal,
        "objectiveCost": objective_cost,
        "objectiveCostBreakdown": {
            "distanceMeters": total_distance,
            "driveSeconds": total_drive,
            "delaySeconds": total_delay,
            "dropPenaltyUnits": drop_penalty,
            "unassignedOrderCount": len(unassigned),
        },
        "vehicles": route_vehicles,
        "unassignedOrders": unassigned_reasons,
    }

    active_routes = [route for route in route_vehicles if route["stops"]]
    vehicle_by_id = {vehicle["vehicleId"]: vehicle for vehicle in vehicles}
    economic_breakdown = {
        "activeVehicleFixedCostCents": int(
            sum(
                int(vehicle_by_id[route["vehicleId"]]["fixedCostCents"])
                for route in active_routes
            )
        ),
        "distanceCostCents": int(
            round(
                sum(
                    (route["distanceMeters"] / 1000)
                    * int(vehicle_by_id[route["vehicleId"]]["costPerKilometerCents"])
                    for route in active_routes
                )
            )
        ),
        "driveTimeCostCents": int(
            round(
                sum(
                    (route["driveSeconds"] / 60)
                    * int(vehicle_by_id[route["vehicleId"]]["costPerMinuteCents"])
                    for route in active_routes
                )
            )
        ),
        "delayPenaltyCents": int(round(total_delay * DELAY_PENALTY_CENTS_PER_SECOND)),
        "unassignedOrderPenaltyCents": int(
            sum(
                UNASSIGNED_PENALTY_CENTS[orders_by_id[order_id]["priority"]]
                for order_id in unassigned
            )
        ),
    }
    orders_delayed = sum(
        1
        for route in route_vehicles
        for stop in route["stops"]
        if stop["delaySeconds"] > 0
    )
    capacity_utilization: dict[str, float] = {}
    for vehicle in vehicles:
        route = next(
            item for item in route_vehicles if item["vehicleId"] == vehicle["vehicleId"]
        )
        if route["stops"]:
            capacity_utilization[vehicle["vehicleId"]] = route["loadUtilizationPercent"]
        else:
            capacity_utilization[vehicle["vehicleId"]] = min(
                100.0,
                max(
                    float(vehicle.get("loadKilograms", 0))
                    / float(vehicle["capacityKilograms"]),
                    float(vehicle.get("loadCubicMeters", 0))
                    / float(vehicle["capacityCubicMeters"]),
                )
                * 100,
            )
    kpis = {
        "scenarioRevision": snapshot["scenarioRevision"],
        "computedAt": snapshot["emittedAt"],
        "distanceTotalMeters": total_distance,
        "plannedDurationSeconds": max(
            (route["endsAtSeconds"] for route in route_vehicles), default=0
        ),
        "economicCostCents": int(sum(economic_breakdown.values())),
        "economicCostBreakdown": economic_breakdown,
        # Phase 5 only publishes a plan: nothing has been delivered yet, so the
        # pending count is every assigned order and the delivered count stays zero.
        "ordersDelivered": 0,
        "ordersPending": len(assigned_ids),
        "ordersDelayed": orders_delayed,
        "ordersUnassigned": len(unassigned),
        "activeVehicles": len(active_routes),
        "capacityUtilizationPercentByVehicle": capacity_utilization,
        "lastIntervention": None,
    }
    return route_plan, kpis
