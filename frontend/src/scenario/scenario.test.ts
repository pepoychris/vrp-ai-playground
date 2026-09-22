import { describe, expect, it } from 'vitest';

import {
  MAX_ORDERS,
  MAX_VEHICLES,
  generateOrders,
  generateVehicles,
  validateOrderCount,
  validateScenarioSnapshot,
  validateVehicleCount,
} from './scenario';

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
