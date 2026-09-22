import { describe, expect, it } from 'vitest';

import {
  MAX_ORDERS,
  MAX_VEHICLES,
  generateOrders,
  generateVehicles,
  routePlanSummary,
  validateOrderCount,
  validateScenarioSnapshot,
  validateVehicleCount,
} from './scenario';
import type { RoutePlan } from './scenario';

describe('seeded scenario generation', () => {
  it('repeats the same fleet and orders for the same seed', () => {
    expect(generateVehicles(6, 123)).toEqual(generateVehicles(6, 123));
    expect(generateOrders(24, 123)).toEqual(generateOrders(24, 123));
  });

  it('keeps fleet and order controls inside the MVP bounds', () => {
    expect(validateVehicleCount(0)).toBeTruthy();
    expect(validateVehicleCount(MAX_VEHICLES + 1)).toBeTruthy();
    expect(validateOrderCount(5)).toBeTruthy();
    expect(validateOrderCount(MAX_ORDERS + 1)).toBeTruthy();
    expect(generateVehicles(MAX_VEHICLES, 4)).toHaveLength(MAX_VEHICLES);
    expect(generateOrders(MAX_ORDERS, 4)).toHaveLength(MAX_ORDERS);
  });

  it('puts every order on a reachable delivery node with positive demand', () => {
    const orders = generateOrders(12, 8);
    expect(orders.every((order) => order.deliveryNodeId.startsWith('N-'))).toBe(true);
    expect(orders.every((order) => order.weightKilograms > 0 && order.volumeCubicMeters > 0)).toBe(true);
    expect(orders.every((order) => order.timeWindow.startSeconds < order.timeWindow.endSeconds)).toBe(true);
  });

  it('rejects over-capacity or isolated data before rendering cards', () => {
    const vehicles = generateVehicles(1, 2);
    const orders = generateOrders(6, 2);
    const snapshot = {
      scenarioId: 'scenario', scenarioRevision: 1, previousRevision: null, status: 'READY' as const,
      seed: 2, graph: { cityId: 'robot-city', graphVersion: 1, nodes: [], edges: [] },
      vehicles, orders, barriers: [], blockedEdgeIds: [], routePlan: null, kpis: null,
      simulation: { running: false, speedMultiplier: 1, tick: 0, elapsedSeconds: 0 },
      appliedCommand: null, emittedAt: new Date(0).toISOString(),
    };
    expect(validateScenarioSnapshot(snapshot)).toEqual([]);
    const invalid = { ...snapshot, vehicles: [{ ...vehicles[0], loadKilograms: vehicles[0].capacityKilograms + 1 }] };
    expect(validateScenarioSnapshot(invalid)).toContain('R-01 exceeds kilogram capacity.');
  });
});

describe('route plan summary copy', () => {
  const basePlan: RoutePlan = {
    scenarioRevision: 5,
    generatedAt: '2026-09-22T09:00:00.000Z',
    timeLimitSeconds: 2,
    solverOutcome: 'FEASIBLE',
    objectiveIsProvenOptimal: false,
    objectiveCost: 1084,
    objectiveCostBreakdown: {
      distanceMeters: 840,
      driveSeconds: 84,
      delaySeconds: 0,
      dropPenaltyUnits: 1000,
      unassignedOrderCount: 1,
    },
    vehicles: [
      {
        vehicleId: 'R-01',
        nodeSequence: ['N-032', 'N-023'],
        edgeSequence: ['E-N023-N032'],
        stops: [
          {
            orderId: 'O-001',
            nodeId: 'N-023',
            arrivalSeconds: 60,
            serviceStartSeconds: 60,
            serviceEndSeconds: 180,
            delaySeconds: 0,
          },
        ],
        distanceMeters: 840,
        driveSeconds: 84,
        loadUtilizationPercent: 73.3,
        endsAtSeconds: 180,
      },
      {
        vehicleId: 'R-02',
        nodeSequence: ['N-032'],
        edgeSequence: [],
        stops: [],
        distanceMeters: 0,
        driveSeconds: 0,
        loadUtilizationPercent: 0,
        endsAtSeconds: 0,
      },
    ],
    unassignedOrders: [{ orderId: 'O-002', reason: 'NO_CAPACITY' }],
  };

  it('labels the plan as best routes found with the search limit', () => {
    const summary = routePlanSummary(basePlan);
    expect(summary.headline).toBe('Best routes found');
    expect(summary.detail).toContain('1 active vehicle');
    expect(summary.detail).toContain('1 stops');
    expect(summary.detail).toContain('2s search limit');
  });

  it('never exposes the raw solver enum or an optimality guarantee', () => {
    for (const outcome of [
      'OPTIMAL',
      'FEASIBLE',
      'TIME_LIMIT_REACHED',
      'INFEASIBLE',
      'NO_SOLUTION',
    ] as const) {
      const summary = routePlanSummary({
        ...basePlan,
        solverOutcome: outcome,
        objectiveIsProvenOptimal: outcome === 'OPTIMAL',
      });
      const copy = `${summary.headline} ${summary.detail}`.toLowerCase();
      expect(copy).not.toContain(outcome.toLowerCase());
      expect(copy).not.toContain('optimal');
      expect(copy).not.toContain('proven');
    }
  });
});
