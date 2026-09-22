import { createRoadNetwork, reachableNodeIds } from '../city/dataset';

export const MIN_VEHICLES = 1;
export const MAX_VEHICLES = 6;
export const MIN_ORDERS = 6;
export const MAX_ORDERS = 24;
export const DEFAULT_SEED = 20260922;

export type VehicleStatus = 'AVAILABLE' | 'EN_ROUTE' | 'DELAYED' | 'BLOCKED' | 'FINISHED';
export type OrderStatus = 'PENDING' | 'ASSIGNED' | 'DELIVERED' | 'DELAYED' | 'UNASSIGNED';
export type Priority = 'LOW' | 'NORMAL' | 'URGENT';
export type ScenarioStatus = 'IDLE' | 'READY' | 'OPTIMIZING' | 'RUNNING' | 'PAUSED';

/**
 * The simulation clock of one revision. `tick` is the authoritative counter and
 * `elapsedSeconds` is derived from it, so the two can never disagree.
 */
export interface SimulationState {
  running: boolean;
  speedMultiplier: number;
  tick: number;
  elapsedSeconds: number;
}

/** The command that produced a revision, as published by the API. */
export interface AppliedCommand {
  commandId: string;
  kind: string;
  appliedAgainstRevision: number;
  rebased: boolean;
  replayed: boolean;
}

export interface Vehicle {
  vehicleId: string;
  capacityKilograms: number;
  capacityCubicMeters: number;
  loadKilograms: number;
  loadCubicMeters: number;
  batteryPercent: number;
  speedKilometersPerHour: number;
  costPerKilometerCents: number;
  costPerMinuteCents: number;
  fixedCostCents: number;
  currentNodeId: string | null;
  status: VehicleStatus;
  assignedOrderIds: string[];
}

export interface Order {
  orderId: string;
  deliveryNodeId: string;
  weightKilograms: number;
  volumeCubicMeters: number;
  priority: Priority;
  timeWindow: { startSeconds: number; endSeconds: number };
  serviceSeconds: number;
  status: OrderStatus;
  assignedVehicleId: string | null;
  sequenceIndex: number | null;
}

export interface RouteStop {
  orderId: string;
  nodeId: string;
  arrivalSeconds: number;
  serviceStartSeconds: number;
  serviceEndSeconds: number;
  delaySeconds: number;
}

export interface VehicleRoute {
  vehicleId: string;
  nodeSequence: string[];
  edgeSequence: string[];
  stops: RouteStop[];
  distanceMeters: number;
  driveSeconds: number;
  loadUtilizationPercent: number;
  endsAtSeconds: number;
}

export interface RoutePlan {
  scenarioRevision: number;
  generatedAt: string;
  timeLimitSeconds: number;
  solverOutcome: 'OPTIMAL' | 'FEASIBLE' | 'TIME_LIMIT_REACHED' | 'INFEASIBLE' | 'NO_SOLUTION';
  objectiveIsProvenOptimal: boolean;
  objectiveCost: number;
  objectiveCostBreakdown: {
    distanceMeters: number;
    driveSeconds: number;
    delaySeconds: number;
    dropPenaltyUnits: number;
    unassignedOrderCount: number;
  };
  vehicles: VehicleRoute[];
  unassignedOrders: { orderId: string; reason: 'NO_CAPACITY' | 'TIME_WINDOW' | 'UNREACHABLE' | 'DROPPED_BY_PENALTY' }[];
}

export interface KpiSnapshot {
  scenarioRevision: number;
  computedAt: string;
  distanceTotalMeters: number;
  plannedDurationSeconds: number;
  economicCostCents: number;
  economicCostBreakdown: {
    activeVehicleFixedCostCents: number;
    distanceCostCents: number;
    driveTimeCostCents: number;
    delayPenaltyCents: number;
    unassignedOrderPenaltyCents: number;
  };
  ordersDelivered: number;
  ordersPending: number;
  ordersDelayed: number;
  ordersUnassigned: number;
  activeVehicles: number;
  capacityUtilizationPercentByVehicle: Record<string, number>;
  lastIntervention: unknown | null;
}

export interface ScenarioSnapshot {
  scenarioId: string;
  scenarioRevision: number;
  previousRevision: number | null;
  status: ScenarioStatus;
  seed: number;
  graph: { cityId: string; graphVersion: number; nodes: unknown[]; edges: unknown[] };
  vehicles: Vehicle[];
  orders: Order[];
  barriers: unknown[];
  blockedEdgeIds: string[];
  routePlan: RoutePlan | null;
  kpis: KpiSnapshot | null;
  simulation: SimulationState;
  appliedCommand: AppliedCommand | null;
  emittedAt: string;
}

export interface RoutePlanSummary {
  headline: string;
  detail: string;
}

/**
 * User-facing copy for a route plan.
 *
 * The panel labels the result as "best routes found" and never shows the raw solver
 * enum or a promise of proven optimality, which the frozen contract forbids.
 */
export function routePlanSummary(plan: RoutePlan): RoutePlanSummary {
  const activeVehicles = plan.vehicles.filter((route) => route.stops.length > 0).length;
  const stops = plan.vehicles.reduce((total, route) => total + route.stops.length, 0);
  return {
    headline: 'Best routes found',
    detail:
      `${activeVehicles} active ${activeVehicles === 1 ? 'vehicle' : 'vehicles'} · ` +
      `${stops} stops · ${plan.timeLimitSeconds}s search limit`,
  };
}

export class SeededPrng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x6d2b79f5;
  }

  nextUint(): number {
    let value = this.state;
    value ^= (value << 13) >>> 0;
    value ^= value >>> 17;
    value ^= (value << 5) >>> 0;
    this.state = value >>> 0;
    return this.state;
  }

  fraction(): number {
    return this.nextUint() / 0x1_0000_0000;
  }

  intBetween(minimum: number, maximum: number): number {
    if (minimum > maximum) throw new Error('minimum must not exceed maximum');
    return minimum + Math.floor(this.fraction() * (maximum - minimum + 1));
  }

  choice<T>(values: readonly T[]): T {
    return values[this.intBetween(0, values.length - 1)];
  }
}

export function validateSeed(seed: number): string | null {
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff
    ? null
    : 'Seed must be an integer between 0 and 4,294,967,295.';
}

export function validateVehicleCount(count: number): string | null {
  return Number.isInteger(count) && count >= MIN_VEHICLES && count <= MAX_VEHICLES
    ? null
    : `Vehicle count must be between ${MIN_VEHICLES} and ${MAX_VEHICLES}.`;
}

export function validateOrderCount(count: number): string | null {
  return Number.isInteger(count) && count >= MIN_ORDERS && count <= MAX_ORDERS
    ? null
    : `Order count must be between ${MIN_ORDERS} and ${MAX_ORDERS}.`;
}

export function generateVehicles(count: number, seed: number): Vehicle[] {
  const countError = validateVehicleCount(count);
  const seedError = validateSeed(seed);
  if (countError) throw new Error(countError);
  if (seedError) throw new Error(seedError);
  const prng = new SeededPrng(seed ^ 0xf1ee7);
  return Array.from({ length: count }, (_, offset) => {
    const capacity = prng.intBetween(30, 60);
    return {
      vehicleId: `R-${String(offset + 1).padStart(2, '0')}`,
      capacityKilograms: capacity,
      capacityCubicMeters: Number((capacity / 20).toFixed(2)),
      loadKilograms: 0,
      loadCubicMeters: 0,
      batteryPercent: prng.intBetween(70, 100),
      speedKilometersPerHour: prng.intBetween(24, 42),
      costPerKilometerCents: prng.intBetween(20, 80),
      costPerMinuteCents: prng.intBetween(10, 40),
      fixedCostCents: prng.intBetween(300, 700),
      currentNodeId: createRoadNetwork().depotNodeId,
      status: 'AVAILABLE',
      assignedOrderIds: [],
    } satisfies Vehicle;
  });
}

export function generateOrders(count: number, seed: number): Order[] {
  const countError = validateOrderCount(count);
  const seedError = validateSeed(seed);
  if (countError) throw new Error(countError);
  if (seedError) throw new Error(seedError);
  const network = createRoadNetwork();
  const reachable = reachableNodeIds(network, network.depotNodeId);
  const deliveryNodes = network.deliveryNodeIds.filter((nodeId) => reachable.has(nodeId));
  const prng = new SeededPrng(seed ^ 0x0d3e);
  return Array.from({ length: count }, (_, offset) => {
    const start = prng.intBetween(0, 900);
    return {
      orderId: `O-${String(offset + 1).padStart(3, '0')}`,
      deliveryNodeId: prng.choice(deliveryNodes),
      weightKilograms: Number((prng.intBetween(1, 20) + prng.fraction()).toFixed(2)),
      volumeCubicMeters: Number((0.1 + prng.fraction() * 1.5).toFixed(2)),
      priority: prng.choice<Priority>(['LOW', 'NORMAL', 'URGENT']),
      timeWindow: { startSeconds: start, endSeconds: start + prng.intBetween(300, 1800) },
      serviceSeconds: prng.intBetween(60, 180),
      status: 'PENDING',
      assignedVehicleId: null,
      sequenceIndex: null,
    } satisfies Order;
  });
}

export function validateScenarioSnapshot(snapshot: ScenarioSnapshot): string[] {
  const problems: string[] = [];
  if (snapshot.vehicles.length > MAX_VEHICLES) problems.push('More than six vehicles are present.');
  if (snapshot.orders.length > MAX_ORDERS) problems.push('More than twenty-four orders are present.');
  const deliveryIds = new Set(createRoadNetwork().deliveryNodeIds);
  for (const order of snapshot.orders) {
    if (!deliveryIds.has(order.deliveryNodeId)) problems.push(`${order.orderId} is not on a delivery node.`);
    if (order.weightKilograms <= 0 || order.volumeCubicMeters <= 0) problems.push(`${order.orderId} has invalid demand.`);
    if (order.timeWindow.startSeconds >= order.timeWindow.endSeconds) problems.push(`${order.orderId} has an invalid time window.`);
  }
  for (const vehicle of snapshot.vehicles) {
    if (vehicle.capacityKilograms <= 0 || vehicle.capacityCubicMeters <= 0) problems.push(`${vehicle.vehicleId} has invalid capacity.`);
    if (vehicle.loadKilograms < 0 || vehicle.loadKilograms > vehicle.capacityKilograms) problems.push(`${vehicle.vehicleId} exceeds kilogram capacity.`);
    if (vehicle.loadCubicMeters < 0 || vehicle.loadCubicMeters > vehicle.capacityCubicMeters) problems.push(`${vehicle.vehicleId} exceeds volume capacity.`);
  }
  return problems;
}

export const SCENARIO_STORAGE_KEY = 'roboroute.currentScenario';

export function readPersistedScenario(): ScenarioSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SCENARIO_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ScenarioSnapshot) : null;
  } catch {
    return null;
  }
}

export function persistScenario(snapshot: ScenarioSnapshot | null): void {
  if (typeof localStorage === 'undefined') return;
  if (snapshot) localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(snapshot));
  else localStorage.removeItem(SCENARIO_STORAGE_KEY);
}
