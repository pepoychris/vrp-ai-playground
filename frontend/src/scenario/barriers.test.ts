/**
 * Phase 7 barrier placement, preview and closure impact.
 *
 * The pure layer owns three promises the phase is graded on: a drag preview resolves to
 * the nearest road edge (or refuses politely), a published barrier is placed on the edge
 * id it blocks, and a cut reports the vehicles and orders it actually affects.
 */

import { describe, expect, it } from 'vitest';

import {
  SNAP_EDGE_MAX_RADIUS_M,
  createRoadNetwork,
  type CityDataset,
} from '../city/dataset';
import {
  affectedVehicleIds,
  barrierImpact,
  barrierPlacements,
  describeBarrierImpactReason,
  describeBarrierPlacement,
  describeBarrierPreview,
  resolveBarrierPreview,
} from './barriers';
import type { Barrier, RoutePlan, ScenarioSnapshot } from './scenario';

/** Two parallel roads four metres apart, so a drop is unambiguous. */
function parallelRoadDataset(): CityDataset {
  return {
    cityId: 'test-city',
    graphVersion: 1,
    capturedAt: '2026-09-22',
    generator: 'test',
    seed: 1,
    units: 'meters',
    coordinateSystem: 'local-xz-up-y',
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    presentation: {
      groundMarginMeters: 10,
      routeWidthMeters: 2,
      roadWidthMetersBySpeedKph: { 30: 7 },
      blockPadHeightMeters: 0.06,
      roadSurfaceHeightMeters: 0.02,
      routeSurfaceHeightMeters: 0.08,
      buildingAssetId: 'buildingFixture',
    },
    nodes: [
      { nodeId: 'N-001', kind: 'DEPOT', position: { x: -20, y: 0, z: 0 } },
      { nodeId: 'N-002', kind: 'DELIVERY', position: { x: 20, y: 0, z: 0 } },
      { nodeId: 'N-003', kind: 'DELIVERY', position: { x: -20, y: 0, z: 4 } },
      { nodeId: 'N-004', kind: 'DELIVERY', position: { x: 20, y: 0, z: 4 } },
    ],
    edges: [
      {
        edgeId: 'E-N001-N002',
        fromNodeId: 'N-001',
        toNodeId: 'N-002',
        bidirectional: true,
        lengthMeters: 40,
        speedLimitKph: 30,
        visualSplineControlPoints: [
          { x: -20, y: 0, z: 0 },
          { x: 20, y: 0, z: 0 },
        ],
      },
      {
        edgeId: 'E-N003-N004',
        fromNodeId: 'N-003',
        toNodeId: 'N-004',
        bidirectional: true,
        lengthMeters: 40,
        speedLimitKph: 30,
        visualSplineControlPoints: [
          { x: -20, y: 0, z: 4 },
          { x: 20, y: 0, z: 4 },
        ],
      },
    ],
    blocks: [],
    landmarks: [],
  } as unknown as CityDataset;
}

const BARRIER: Barrier = {
  barrierId: 'B-1',
  blockedEdgeId: 'E-N001-N002',
  position: { x: 0, y: 0, z: 0 },
  placedAtRevision: 4,
};

function planWith(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    scenarioRevision: 5,
    generatedAt: '2026-09-22T09:00:00.000Z',
    timeLimitSeconds: 2,
    solverOutcome: 'FEASIBLE',
    objectiveIsProvenOptimal: false,
    objectiveCost: 1000,
    objectiveCostBreakdown: {
      distanceMeters: 100,
      driveSeconds: 10,
      delaySeconds: 0,
      dropPenaltyUnits: 1000,
      unassignedOrderCount: 0,
    },
    vehicles: [
      {
        vehicleId: 'R-01',
        nodeSequence: ['N-001', 'N-002'],
        edgeSequence: ['E-N001-N002'],
        stops: [
          {
            orderId: 'O-001',
            nodeId: 'N-002',
            arrivalSeconds: 30,
            serviceStartSeconds: 30,
            serviceEndSeconds: 60,
            delaySeconds: 0,
          },
        ],
        distanceMeters: 40,
        driveSeconds: 40,
        loadUtilizationPercent: 40,
        endsAtSeconds: 60,
      },
    ],
    unassignedOrders: [],
    ...overrides,
  };
}

function snapshotWith(barriers: Barrier[], plan: RoutePlan | null = null): ScenarioSnapshot {
  return {
    scenarioId: 'scenario',
    scenarioRevision: 5,
    previousRevision: 4,
    status: 'READY',
    seed: 1,
    graph: { cityId: 'robot-city', graphVersion: 1, nodes: [], edges: [] },
    vehicles: [],
    orders: [],
    barriers,
    blockedEdgeIds: [...new Set(barriers.map((barrier) => barrier.blockedEdgeId))].sort(),
    routePlan: plan,
    kpis: null,
    simulation: { running: false, speedMultiplier: 1, tick: 0, elapsedSeconds: 0 },
    appliedCommand: null,
    emittedAt: '2026-09-22T09:00:00.000Z',
  };
}

describe('barrier drag preview', () => {
  it('snaps a drop on the road to that edge and reports the projection', () => {
    const network = createRoadNetwork(parallelRoadDataset());
    const preview = resolveBarrierPreview(network, { x: 0, y: 0, z: 1 });

    expect(preview.accepted).toBe(true);
    expect(preview.edgeId).toBe('E-N001-N002');
    expect(preview.distanceMeters).toBeCloseTo(1, 6);
    expect(preview.projectedPoint).toEqual({ x: 0, y: 0, z: 0 });
    expect(preview.edgeMidpoint).toEqual({ x: 0, y: 0, z: 0 });
    expect(preview.edgeLengthMeters).toBe(40);
    expect(preview.reason).toBeNull();
  });

  it('refuses a drop that no road can accept, and says why', () => {
    const network = createRoadNetwork(parallelRoadDataset());
    const preview = resolveBarrierPreview(network, { x: 0, y: 0, z: 40 });

    expect(preview.accepted).toBe(false);
    expect(preview.edgeId).toBeNull();
    expect(preview.reason).toBe('SNAP_NO_VALID_EDGE');
    expect(preview.distanceMeters).toBe(Number.POSITIVE_INFINITY);
    expect(describeBarrierPreview(preview)).toContain('No road within');
    expect(describeBarrierPreview(preview)).toContain('release to cancel');
  });

  it('never offers a road that is already closed', () => {
    const network = createRoadNetwork(parallelRoadDataset());
    const preview = resolveBarrierPreview(
      network,
      { x: 0, y: 0, z: 1 },
      ['E-N001-N002'],
    );

    expect(preview.accepted).toBe(true);
    expect(preview.edgeId).toBe('E-N003-N004');
    expect(preview.distanceMeters).toBeLessThanOrEqual(SNAP_EDGE_MAX_RADIUS_M);
  });

  it('reports a valid preview as a both-directions closure', () => {
    const network = createRoadNetwork(parallelRoadDataset());
    const preview = resolveBarrierPreview(network, { x: 0, y: 0, z: 1 });

    expect(describeBarrierPreview(preview)).toContain('E-N001-N002');
    expect(describeBarrierPreview(preview)).toContain('blocks both directions');
    expect(describeBarrierPlacement(true, preview.edgeId, 'B-2')).toBe(
      'Road E-N001-N002 closed by B-2',
    );
    expect(describeBarrierPlacement(false, null, null)).toContain('rejected');
  });
});

describe('placed barriers', () => {
  it('places every barrier on the edge id it blocks, in identifier order', () => {
    const network = createRoadNetwork(parallelRoadDataset());
    const placements = barrierPlacements(
      snapshotWith([
        { ...BARRIER, barrierId: 'B-2', blockedEdgeId: 'E-N003-N004', position: { x: 0, y: 0, z: 4 } },
        BARRIER,
      ]),
      network,
      'B-2',
    );

    expect(placements.map((placement) => placement.barrierId)).toEqual(['B-1', 'B-2']);
    expect(placements.map((placement) => placement.edgeId)).toEqual([
      'E-N001-N002',
      'E-N003-N004',
    ]);
    expect(placements[0].headingDegrees).toBeCloseTo(90, 6);
    expect(placements.map((placement) => placement.selected)).toEqual([false, true]);
  });
});

describe('closure impact', () => {
  it('is inactive while no road is closed', () => {
    const impact = barrierImpact(snapshotWith([]));
    expect(impact.active).toBe(false);
    expect(impact.vehicles).toEqual([]);
    expect(impact.orders).toEqual([]);
    expect(affectedVehicleIds(snapshotWith([])).size).toBe(0);
  });

  it('reports the vehicles that still drive through a closed road', () => {
    const snapshot = snapshotWith([BARRIER], planWith());
    const impact = barrierImpact(snapshot);

    expect(impact.active).toBe(true);
    expect(impact.edgeIds).toEqual(['E-N001-N002']);
    expect(impact.vehicles).toEqual([{ vehicleId: 'R-01', reason: 'CLOSED_ROAD' }]);
    expect(affectedVehicleIds(snapshot)).toEqual(new Set(['R-01']));
    expect(describeBarrierImpactReason('CLOSED_ROAD')).toBe('route crosses the closed road');
  });

  it('reports an isolated order with the plan reason and highlights its vehicle', () => {
    const snapshot = snapshotWith(
      [{ ...BARRIER, blockedEdgeId: 'E-N003-N004' }],
      planWith({
        vehicles: [
          {
            vehicleId: 'R-02',
            nodeSequence: ['N-001'],
            edgeSequence: [],
            stops: [],
            distanceMeters: 0,
            driveSeconds: 0,
            loadUtilizationPercent: 0,
            endsAtSeconds: 0,
          },
        ],
        unassignedOrders: [{ orderId: 'O-009', reason: 'UNREACHABLE' }],
      }),
    );
    const impact = barrierImpact(snapshot);

    expect(impact.orders).toEqual([{ orderId: 'O-009', reason: 'UNREACHABLE' }]);
    // The vehicle keeps its route edges, so it is reported for the work it lost, not for
    // driving a closed road.
    expect(impact.vehicles).toEqual([{ vehicleId: 'R-02', reason: 'NO_WORK' }]);
    expect(describeBarrierImpactReason('NO_WORK')).toBe('no stops left after the closure');
    expect(describeBarrierImpactReason('UNREACHABLE')).toBe('isolated by the closure');
  });

  it('reports the delay a closure adds to a stop that is still served', () => {
    const snapshot = snapshotWith(
      [{ ...BARRIER, blockedEdgeId: 'E-N003-N004' }],
      planWith({
        vehicles: [
          {
            vehicleId: 'R-01',
            nodeSequence: ['N-001', 'N-002'],
            edgeSequence: [],
            stops: [
              {
                orderId: 'O-001',
                nodeId: 'N-002',
                arrivalSeconds: 90,
                serviceStartSeconds: 90,
                serviceEndSeconds: 120,
                delaySeconds: 45,
              },
            ],
            distanceMeters: 40,
            driveSeconds: 90,
            loadUtilizationPercent: 40,
            endsAtSeconds: 120,
          },
        ],
      }),
    );
    const impact = barrierImpact(snapshot);

    expect(impact.orders).toEqual([{ orderId: 'O-001', reason: 'DELAYED' }]);
    expect(impact.vehicles).toEqual([{ vehicleId: 'R-01', reason: 'DELAYED_ORDER' }]);
  });
});
