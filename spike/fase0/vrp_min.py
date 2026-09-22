"""Prueba tecnica: VRP minimo con OR-Tools sobre el grafo del contrato.

Objetivo de la Fase 0: comprobar que OR-Tools devuelve una solucion para un escenario
pequeno, que respeta la capacidad y que deja fuera un pedido imposible en lugar de
bloquearse. No calcula el VRP de produccion (eso es la Fase 5) y **no afirma
optimalidad**: informa del estado que devuelve el solver.

Diferencias conscientes con el plan del contrato, a decidir en la Fase 5:

- este spike modela un CVRP clasico, que cierra el ciclo en el deposito; el
  `RoutePlan` del contrato termina en la ultima parada y no incluye el regreso;
- la escala del objetivo aqui son metros; la escala definitiva se fija en la Fase 5.

Ejecucion:
    python spike/fase0/vrp_min.py

Requiere `ortools` (ver spike/fase0/README.md).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from spike.fase0.world.graph import RoadGraph  # noqa: E402

GOLDEN_SCENARIO = (
    REPO_ROOT / "docs" / "contracts" / "examples" / "scenario-revision.example.json"
)
TIME_LIMIT_SECONDS = 2
DEPOT_NODE_ID = "N-001"
# Escala interna del modelo: el objetivo se declara en unidades propias, nunca euros.
METERS_PER_UNIT = 1
DROP_PENALTY_UNITS = 100_000
URGENT_MULTIPLIER = 3

# Pedidos de la prueba: el tercero pesa mas que la capacidad del unico vehiculo, asi
# que el solver debe abandonarlo con penalizacion.
ORDERS = [
    {"order_id": "O-001", "node_id": "N-006", "demand_kg": 12, "priority": "URGENT", "service_s": 120},
    {"order_id": "O-002", "node_id": "N-007", "demand_kg": 10, "priority": "NORMAL", "service_s": 90},
    {"order_id": "O-003", "node_id": "N-006", "demand_kg": 40, "priority": "NORMAL", "service_s": 60},
]
VEHICLE_CAPACITY_KG = 30
VEHICLE_SPEED_KPH = 36


def load_scenario() -> dict:
    with GOLDEN_SCENARIO.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def routing_status_names(routing_enums_pb2: object) -> dict[int, str]:
    """Nombres de estado leidos del descriptor de la propia libreria.

    OR-Tools 9.15.6755 no expone constantes Python para el estado de busqueda, pero su
    descriptor si publica el enum `RoutingSearchStatus.Value`, asi que los nombres se
    leen de ahi en lugar de escribirlos a mano.
    """
    message = getattr(routing_enums_pb2, "RoutingSearchStatus", None)
    if message is None:
        return {}
    enum = message.DESCRIPTOR.enum_types_by_name.get("Value")
    if enum is None:
        return {}
    return {value.number: value.name for value in enum.values}


def map_outcome(status_name: str) -> str:
    if status_name == "ROUTING_OPTIMAL":
        return "OPTIMAL"
    if status_name in {
        "ROUTING_SUCCESS",
        "ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED",
    }:
        return "FEASIBLE"
    if status_name == "ROUTING_FAIL_TIMEOUT":
        return "TIME_LIMIT_REACHED"
    if status_name == "ROUTING_INFEASIBLE":
        return "INFEASIBLE"
    return "NO_SOLUTION"


def solve() -> dict:
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    scenario = load_scenario()
    graph = RoadGraph.from_scenario(scenario)
    # Escenario sin barreras: la prueba aisla el solver del estado de bloqueo.
    blocked: frozenset[str] = frozenset()

    stops = [DEPOT_NODE_ID] + [order["node_id"] for order in ORDERS]
    matrix = graph.distance_matrix(stops, stops, blocked)

    manager = pywrapcp.RoutingIndexManager(len(stops), 1, 0)
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        distance = matrix[(stops[from_node], stops[to_node])]
        if distance is None:
            # Inalcanzable no es coste cero: se penaliza tan fuerte que el solver lo evita.
            return 10_000_000
        return int(round(distance / METERS_PER_UNIT))

    distance_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(distance_callback_index)

    demands = [0] + [order["demand_kg"] for order in ORDERS]

    def demand_callback(from_index: int) -> int:
        return int(demands[manager.IndexToNode(from_index)])

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index, 0, [VEHICLE_CAPACITY_KG], True, "Capacity"
    )

    for index, order in enumerate(ORDERS, start=1):
        penalty = DROP_PENALTY_UNITS
        if order["priority"] == "URGENT":
            penalty *= URGENT_MULTIPLIER
        routing.AddDisjunction([manager.NodeToIndex(index)], penalty)

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.time_limit.FromSeconds(TIME_LIMIT_SECONDS)

    solution = routing.SolveWithParameters(search_parameters)
    status_value = routing.status()
    status_name = routing_status_names(routing_enums_pb2).get(
        status_value, f"UNKNOWN({status_value})"
    )

    summary: dict = {
        "solverStatusValue": status_value,
        "solverStatusName": status_name,
        "solverOutcome": map_outcome(status_name),
        "objectiveIsProvenOptimal": status_name == "ROUTING_OPTIMAL",
        "timeLimitSeconds": TIME_LIMIT_SECONDS,
        "vehicleCapacityKilograms": VEHICLE_CAPACITY_KG,
    }

    if solution is None:
        summary["route"] = None
        summary["droppedOrders"] = [order["order_id"] for order in ORDERS]
        summary["note"] = "sin solucion dentro del limite; se reporta el estado del solver"
        return summary

    route: list[str] = []
    delivered_orders: list[str] = []
    load_kg = 0
    index = routing.Start(0)
    total_cost = 0
    total_distance = 0.0
    while not routing.IsEnd(index):
        node = manager.IndexToNode(index)
        route.append(stops[node])
        if node > 0:
            load_kg += demands[node]
            delivered_orders.append(ORDERS[node - 1]["order_id"])
        previous = index
        index = solution.Value(routing.NextVar(index))
        total_cost += routing.GetArcCostForVehicle(previous, index, 0)
        leg = matrix[(stops[manager.IndexToNode(previous)], stops[manager.IndexToNode(index)])]
        total_distance += 0.0 if leg is None else leg
    route.append(stops[manager.IndexToNode(index)])

    dropped = [order["order_id"] for order in ORDERS if order["order_id"] not in delivered_orders]
    summary.update(
        {
            "route": route,
            "deliveredOrders": delivered_orders,
            "droppedOrders": dropped,
            "loadKilograms": load_kg,
            "distanceMeters": total_distance,
            "driveSeconds": total_distance / (VEHICLE_SPEED_KPH / 3.6),
            "objectiveCost": total_cost,
            "note": (
                "objetivo en unidades internas del modelo; no es dinero y no implica "
                "garantia de optimalidad"
            ),
        }
    )
    return summary


def main() -> int:
    try:
        summary = solve()
    except ImportError as exc:  # pragma: no cover - depende del entorno
        print(f"BLOQUEO: falta la dependencia ortools ({exc})", file=sys.stderr)
        print(
            "Instala con: pip install -r spike/fase0/requirements-phase0.txt",
            file=sys.stderr,
        )
        return 3

    print(json.dumps(summary, indent=2, ensure_ascii=True))

    failures: list[str] = []
    if summary["route"] is None:
        failures.append("el solver no devolvio ninguna solucion")
    else:
        if summary["loadKilograms"] > VEHICLE_CAPACITY_KG:
            failures.append(
                f"carga {summary['loadKilograms']} kg supera la capacidad {VEHICLE_CAPACITY_KG} kg"
            )
        if "O-003" not in summary["droppedOrders"]:
            failures.append("O-003 (40 kg) deberia quedar sin asignar por capacidad")
        # Ciclo cerrado en el deposito: N-001 -> N-007 -> N-006 -> N-001 son 1200 m.
        if abs(summary["distanceMeters"] - 1200.0) > 1e-6:
            failures.append(
                f"distancia esperada 1200 m (ida y vuelta al deposito) para el escenario "
                f"sin barreras, obtenida {summary['distanceMeters']}"
            )
        if set(summary["deliveredOrders"]) != {"O-001", "O-002"}:
            failures.append(
                f"se esperaban O-001 y O-002 entregados, obtenidos {summary['deliveredOrders']}"
            )

    if failures:
        print("\nRESULTADO: FALLO", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print("\nRESULTADO: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
