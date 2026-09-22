import { describe, expect, it } from 'vitest';

import { createRoadNetwork } from '../city/dataset';

import type { ScenarioSnapshot, VehicleRoute } from './scenario';
import {
  MAX_TICKS_PER_ADVANCE,
  SIMULATION_SPEED_CHOICES,
  SIMULATION_TICK_SECONDS,
  advanceSimulationClock,
  boundedTickDelta,
  clampSpeedMultiplier,
  currentRoutePlan,
  routeLegs,
  routeSurfaces,
  sampleVehicleAt,
  simulationClockLabel,
  simulationState,
  vehiclePlacements,
  vehicleSamples,
} from './simulation';

const NETWORK = createRoadNetwork();
const DEPOT = NETWORK.depotNodeId;

function snapshotWithPlan(
  routes: VehicleRoute[],
  overrides: Partial<ScenarioSnapshot> = {},
): ScenarioSnapshot {
  return {
    scenarioId: 'scenario-1',
    scenarioRevision: 4,
    previousRevision: 3,
    status: 'RUNNING',
    seed: 7,
    graph: { cityId: 'robot-city', graphVersion: 1, nodes: [], edges: [] },
    vehicles: [
      {
        vehicleId: 'R-01',
        capacityKilograms: 40,
        capacityCubicMeters: 2,
        loadKilograms: 0,
        loadCubicMeters: 0,
        batteryPercent: 90,
        speedKilometersPerHour: 36,
        costPerKilometerCents: 40,
        costPerMinuteCents: 20,
        fixedCostCents: 400,
        currentNodeId: DEPOT,
        status: 'EN_ROUTE',
        assignedOrderIds: [],
      },
    ],
    orders: [],
    barriers: [],
    blockedEdgeIds: [],
    routePlan: {
      scenarioRevision: 4,
      generatedAt: '2026-09-22T09:00:00.000Z',
      timeLimitSeconds: 2,
      solverOutcome: 'FEASIBLE',
      objectiveIsProvenOptimal: false,
      objectiveCost: 10,
      objectiveCostBreakdown: {
        distanceMeters: 0,
        driveSeconds: 0,
        delaySeconds: 0,
        dropPenaltyUnits: 0,
        unassignedOrderCount: 0,
      },
      vehicles: routes,
      unassignedOrders: [],
    },
    kpis: null,
    simulation: { running: true, speedMultiplier: 1, tick: 0, elapsedSeconds: 0 },
    appliedCommand: null,
    emittedAt: '2026-09-22T09:00:00.000Z',
    ...overrides,
  };
}

/** Two collinear edges through three real city nodes, so the geometry is the dataset's. */
function straightRoute(): VehicleRoute {
  return {
    vehicleId: 'R-01',
    nodeSequence: ['N-001', 'N-002', 'N-003'],
    edgeSequence: ['E-N001-N002', 'E-N002-N003'],
    stops: [
      {
        orderId: 'O-001',
        nodeId: 'N-003',
        arrivalSeconds: 60,
        serviceStartSeconds: 60,
        serviceEndSeconds: 120,
        delaySeconds: 0,
      },
    ],
    distanceMeters: 0,
    driveSeconds: 0,
    loadUtilizationPercent: 0,
    endsAtSeconds: 120,
  };
}

describe('simulation clock', () => {
  it('derives elapsed seconds from whole ticks', () => {
    const state = simulationState({ running: true, speedMultiplier: 2, tick: 6 });
    expect(state.tick).toBe(6);
    expect(state.elapsedSeconds).toBe(6 * SIMULATION_TICK_SECONDS);
    expect(simulationState({ running: false }).tick).toBe(0);
  });

  it('advances monotonically and never past the bounded window', () => {
    const base = simulationState({ running: true, tick: 3 });
    expect(advanceSimulationClock(base, 0).tick).toBe(3);
    expect(advanceSimulationClock(base, -5).tick).toBe(3);
    expect(advanceSimulationClock(base, 2).tick).toBe(5);
    expect(advanceSimulationClock(base, MAX_TICKS_PER_ADVANCE * 4).tick).toBe(
      3 + MAX_TICKS_PER_ADVANCE,
    );
  });

  it('bounded ticks scale with speed and reject nonsense', () => {
    expect(boundedTickDelta(0, 1)).toBe(0);
    expect(boundedTickDelta(2 * SIMULATION_TICK_SECONDS, 1)).toBe(2);
    expect(boundedTickDelta(2 * SIMULATION_TICK_SECONDS, 4)).toBe(8);
    expect(boundedTickDelta(2 * SIMULATION_TICK_SECONDS, 0)).toBe(0);
    expect(boundedTickDelta(10_000, 8)).toBe(MAX_TICKS_PER_ADVANCE);
  });

  it('bounds the speed multiplier instead of silently clamping it', () => {
    expect(clampSpeedMultiplier(0.5)).toBe(0.5);
    expect(clampSpeedMultiplier(8)).toBe(8);
    expect(() => clampSpeedMultiplier(0)).toThrow();
    expect(() => clampSpeedMultiplier(9)).toThrow();
    expect(SIMULATION_SPEED_CHOICES.every((choice) => clampSpeedMultiplier(choice) === choice)).toBe(
      true,
    );
  });

  it('labels the clock for the control panel', () => {
    expect(simulationClockLabel(simulationState({ running: true, tick: 4, speedMultiplier: 2 }))).toBe(
      'Running · tick 4 · 2.0s · x2',
    );
    expect(simulationClockLabel(simulationState({ running: false }))).toContain('Stopped');
    expect(
      simulationClockLabel(simulationState({ running: false, tick: 2 })),
    ).toContain('Paused');
  });
});

describe('movement along route edges', () => {
  it('uses whole seconds capped by the slower of road and robot', () => {
    const legs = routeLegs(NETWORK, straightRoute().nodeSequence, straightRoute().edgeSequence, 36);
    expect(legs).toHaveLength(2);
    expect(legs[0].edgeId).toBe('E-N001-N002');
    expect(legs[0].seconds).toBe(
      Math.ceil(legs[0].lengthMeters / ((36 * 1000) / 3600)),
    );
  });

  it('stops at a disconnected edge instead of inventing a shortcut', () => {
    expect(routeLegs(NETWORK, ['N-001'], ['E-N050-N060'], 36)).toEqual([]);
  });

  it('interpolates along the edge and clamps at the last stop', () => {
    const route = straightRoute();
    const legs = routeLegs(NETWORK, route.nodeSequence, route.edgeSequence, 36);
    const total = legs.reduce((sum, leg) => sum + leg.seconds, 0);
    const from = NETWORK.nodes.get('N-001')!.position;
    const to = NETWORK.nodes.get('N-002')!.position;

    const start = sampleVehicleAt(NETWORK, legs, 0, 'N-001');
    expect(start.nodeId).toBe('N-001');
    expect(start.edgeId).toBe('E-N001-N002');
    expect(start.progress).toBe(0);
    expect(start.arrived).toBe(false);
    expect(start.position.x).toBeCloseTo(from.x, 6);

    const half = sampleVehicleAt(NETWORK, legs, legs[0].seconds / 2, 'N-001');
    expect(half.progress).toBeCloseTo(0.5, 6);
    expect(half.position.x).toBeCloseTo((from.x + to.x) / 2, 6);
    expect(half.position.z).toBeCloseTo((from.z + to.z) / 2, 6);

    const arrived = sampleVehicleAt(NETWORK, legs, total + 100, 'N-001');
    expect(arrived.arrived).toBe(true);
    expect(arrived.edgeId).toBeNull();
    expect(arrived.nodeId).toBe('N-003');
    expect(arrived.position.x).toBeCloseTo(NETWORK.nodes.get('N-003')!.position.x, 6);
  });

  it('is reproducible for the same clock', () => {
    const route = straightRoute();
    const legs = routeLegs(NETWORK, route.nodeSequence, route.edgeSequence, 36);
    const first = vehicleSamples(snapshotWithPlan([route]), 12);
    const second = vehicleSamples(snapshotWithPlan([route]), 12);
    expect(first).toEqual(second);
    expect(sampleVehicleAt(NETWORK, legs, 12, 'N-001')).toEqual(
      sampleVehicleAt(NETWORK, legs, 12, 'N-001'),
    );
  });

  it('ignores a route plan that belongs to an older revision', () => {
    const stale = snapshotWithPlan([straightRoute()], {
      scenarioRevision: 9,
      routePlan: { ...snapshotWithPlan([straightRoute()]).routePlan!, scenarioRevision: 8 },
    });
    expect(currentRoutePlan(stale)).toBeNull();
    expect(vehicleSamples(stale, 5)).toEqual([]);
    expect(routeSurfaces(stale)).toEqual([]);
  });
});

describe('scene placements', () => {
  it('maps every vehicle to its sample and marks the lifted one', () => {
    const snapshot = snapshotWithPlan([straightRoute()]);
    const placements = vehiclePlacements(snapshot, 0, 'R-01');
    expect(placements).toHaveLength(1);
    expect(placements[0].vehicleId).toBe('R-01');
    expect(placements[0].lifted).toBe(true);
    expect(placements[0].nodeId).toBe('N-001');
  });

  it('keeps an idle fleet parked on its current node without a plan', () => {
    const snapshot = snapshotWithPlan([], { routePlan: null });
    const placements = vehiclePlacements(snapshot, 0);
    expect(placements).toHaveLength(1);
    expect(placements[0].nodeId).toBe(DEPOT);
    expect(placements[0].lifted).toBe(false);
  });

  it('publishes one route surface per vehicle that drives', () => {
    const surfaces = routeSurfaces(snapshotWithPlan([straightRoute()]));
    expect(surfaces).toEqual([
      {
        vehicleId: 'R-01',
        startNodeId: 'N-001',
        edgeIds: ['E-N001-N002', 'E-N002-N003'],
      },
    ]);
  });
});
