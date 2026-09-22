/**
 * Phase 3 coordinate selection.
 *
 * `nearestRoadNode()` and `nearestRoadEdge()` have to be boringly predictable: same
 * point, same answer, radius respected, ties broken by identifier order, and the
 * projection reported exactly. Each of those is one test below.
 */

import { describe, expect, it } from 'vitest';

import {
  CITY_DATASET,
  EPSILON_M,
  SNAP_EDGE_MAX_RADIUS_M,
  SNAP_NODE_MAX_RADIUS_M,
  canonicalEdgeId,
  createRoadNetwork,
  distanceXz,
  type CityDataset,
} from './dataset';
import {
  edgeDirection,
  headingDegrees,
  isWithinRadius,
  nearestRoadEdge,
  nearestRoadNode,
  projectPointOnRoadEdge,
} from './selection';

/** Tiny hand-built network: two parallel roads four metres apart. */
function parallelRoadNetwork(): ReturnType<typeof createRoadNetwork> {
  const dataset = {
    cityId: 'test-city',
    graphVersion: 1,
    capturedAt: '2026-09-22',
    generator: 'test',
    seed: 1,
    units: 'meters',
    coordinateSystem: 'local-xz-up-y',
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
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
      { nodeId: 'N-001', kind: 'DEPOT', position: { x: 0, y: 0, z: 0 } },
      { nodeId: 'N-002', kind: 'JUNCTION', position: { x: 10, y: 0, z: 0 } },
      { nodeId: 'N-003', kind: 'JUNCTION', position: { x: 0, y: 0, z: 4 } },
      { nodeId: 'N-004', kind: 'DELIVERY', position: { x: 10, y: 0, z: 4 } },
    ],
    edges: [
      {
        edgeId: canonicalEdgeId('N-001', 'N-002'),
        fromNodeId: 'N-001',
        toNodeId: 'N-002',
        bidirectional: true,
        lengthMeters: 10,
        speedLimitKph: 30,
        visualSplineControlPoints: [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
      },
      {
        edgeId: canonicalEdgeId('N-003', 'N-004'),
        fromNodeId: 'N-003',
        toNodeId: 'N-004',
        bidirectional: true,
        lengthMeters: 10,
        speedLimitKph: 30,
        visualSplineControlPoints: [
          { x: 0, y: 0, z: 4 },
          { x: 10, y: 0, z: 4 },
        ],
      },
    ],
    blocks: [],
    landmarks: [],
  } as unknown as CityDataset;
  return createRoadNetwork(dataset);
}

describe('nearestRoadNode', () => {
  const network = createRoadNetwork();

  it('returns the node itself for a point on the node', () => {
    const depot = network.nodes.get(network.depotNodeId);
    const snap = nearestRoadNode(network, { x: depot!.position.x, z: depot!.position.z });

    expect(snap?.nodeId).toBe(network.depotNodeId);
    expect(snap?.kind).toBe('DEPOT');
    expect(snap?.distanceMeters).toBe(0);
    expect(snap?.position).toEqual(depot?.position);
  });

  it('measures the XZ distance and ignores the elevation', () => {
    const node = network.nodes.get('N-001') as { position: { x: number; z: number } };
    const offset = { x: node.position.x + 3, z: node.position.z - 4 };
    const snap = nearestRoadNode(network, offset);

    expect(snap?.nodeId).toBe('N-001');
    expect(snap?.distanceMeters).toBeCloseTo(5, 9);
  });

  it('rejects everything outside the radius', () => {
    // Mid-block: 24 m from the nearest avenue crossing in this grid.
    const snap = nearestRoadNode(network, { x: 24, z: 24 });
    expect(snap).toBeNull();
    expect(nearestRoadNode(network, { x: 24, z: 24 }, 40)?.nodeId).toBeTruthy();
  });

  it('treats exactly the radius as inside', () => {
    expect(isWithinRadius(SNAP_NODE_MAX_RADIUS_M, SNAP_NODE_MAX_RADIUS_M)).toBe(true);
    expect(isWithinRadius(SNAP_NODE_MAX_RADIUS_M + 1e-6, SNAP_NODE_MAX_RADIUS_M)).toBe(false);
  });

  it('breaks an exact tie with the lexicographically smaller node id', () => {
    const tied = parallelRoadNetwork();
    const snap = nearestRoadNode(tied, { x: 0, z: 2 });

    expect(snap?.distanceMeters).toBeCloseTo(2, 9);
    expect(snap?.nodeId).toBe('N-001');
  });
});

describe('nearestRoadEdge', () => {
  const network = createRoadNetwork();

  it('projects a point onto the edge and reports t, direction and heading', () => {
    const edge = network.edges.get('E-N001-N002');
    const from = network.nodes.get(edge!.fromNodeId) as { position: { x: number; z: number } };
    const to = network.nodes.get(edge!.toNodeId) as { position: { x: number; z: number } };
    const projection = projectPointOnRoadEdge(network, 'E-N001-N002', {
      x: (from.position.x + to.position.x) / 2,
      z: (from.position.z + to.position.z) / 2,
    });

    expect(projection.t).toBeCloseTo(0.5, 9);
    expect(projection.distanceMeters).toBeCloseTo(0, 9);
    expect(projection.projectedPoint.x).toBeCloseTo((from.position.x + to.position.x) / 2, 9);
    expect(projection.projectedPoint.z).toBeCloseTo((from.position.z + to.position.z) / 2, 9);

    const snap = nearestRoadEdge(network, { x: projection.projectedPoint.x, z: projection.projectedPoint.z });
    expect(snap?.edgeId).toBe('E-N001-N002');
    expect(snap?.distanceMeters).toBeCloseTo(0, 9);
    expect(snap?.fromNodeId).toBe('N-001');
    expect(snap?.toNodeId).toBe('N-002');
    expect(snap?.bidirectional).toBe(true);
    expect(snap?.direction).toEqual(
      edgeDirection(network, 'E-N001-N002'),
    );
    expect(snap?.headingDegrees).toBeCloseTo(90, 6);
  });

  it('round-trips a point that lies on an edge', () => {
    const edge = network.edges.get('E-N032-N033') ?? network.edges.get(network.edgeIds[0]);
    const from = network.nodes.get(edge!.fromNodeId) as { position: { x: number; z: number } };
    const to = network.nodes.get(edge!.toNodeId) as { position: { x: number; z: number } };
    const sample = { x: from.position.x + 0.3 * (to.position.x - from.position.x), z: from.position.z + 0.3 * (to.position.z - from.position.z) };

    const snap = nearestRoadEdge(network, sample);

    expect(snap?.edgeId).toBe(edge?.edgeId);
    expect(snap?.distanceMeters).toBeLessThanOrEqual(1e-9);
    expect(distanceXz(snap!.projectedPoint, sample)).toBeLessThanOrEqual(1e-9);
    expect(snap?.t).toBeCloseTo(0.3, 9);
  });

  it('rejects everything outside the radius', () => {
    expect(nearestRoadEdge(network, { x: 24, z: 24 })).toBeNull();
    expect(nearestRoadEdge(network, { x: 24, z: 24 }, { maxRadius: 40 })?.edgeId).toBeTruthy();
    expect(SNAP_EDGE_MAX_RADIUS_M).toBe(12);
  });

  it('skips excluded edges before measuring, so a blocked edge is never chosen', () => {
    const tied = parallelRoadNetwork();
    const point = { x: 5, z: 2 };

    expect(nearestRoadEdge(tied, point)?.edgeId).toBe('E-N001-N002');
    const withoutFirst = nearestRoadEdge(tied, point, { excludedEdgeIds: ['E-N001-N002'] });
    expect(withoutFirst?.edgeId).toBe('E-N003-N004');
    expect(withoutFirst?.t).toBeCloseTo(0.5, 9);

    const allExcluded = nearestRoadEdge(tied, point, {
      excludedEdgeIds: ['E-N001-N002', 'E-N003-N004'],
    });
    expect(allExcluded).toBeNull();
  });

  it('breaks an exact tie with the lexicographically smaller edge id', () => {
    const snap = nearestRoadEdge(parallelRoadNetwork(), { x: 5, z: 2 });

    expect(snap?.distanceMeters).toBeCloseTo(2, 9);
    expect(snap?.edgeId).toBe('E-N001-N002');
  });

  it('is independent of the order the dataset lists its nodes and edges', () => {
    const shuffled = structuredClone(CITY_DATASET) as CityDataset;
    shuffled.nodes = [...shuffled.nodes].reverse();
    shuffled.edges = [...shuffled.edges].reverse();
    const networkA = createRoadNetwork(CITY_DATASET);
    const networkB = createRoadNetwork(shuffled);
    const point = { x: 11.5, z: -37.25 };

    expect(nearestRoadNode(networkB, point)).toEqual(nearestRoadNode(networkA, point));
    expect(nearestRoadEdge(networkB, point)).toEqual(nearestRoadEdge(networkA, point));
  });
});

describe('direction metadata', () => {
  it('reports a unit vector and a compass heading', () => {
    const network = createRoadNetwork();
    const direction = edgeDirection(network, 'E-N001-N002');

    expect(Math.hypot(direction.x, direction.z)).toBeCloseTo(1, 9);
    expect(direction.x).toBeCloseTo(1, 9);
    expect(direction.z).toBeCloseTo(0, 9);
    expect(headingDegrees(direction)).toBeCloseTo(90, 9);
  });

  it('uses 0 for +z, 90 for +x, 180 for -z and 270 for -x', () => {
    expect(headingDegrees({ x: 0, z: 1 })).toBeCloseTo(0, 9);
    expect(headingDegrees({ x: 1, z: 0 })).toBeCloseTo(90, 9);
    expect(headingDegrees({ x: 0, z: -1 })).toBeCloseTo(180, 9);
    expect(headingDegrees({ x: -1, z: 0 })).toBeCloseTo(270, 9);
  });

  it('keeps the edge direction even when the sampled point sits near the far end', () => {
    const network = createRoadNetwork();
    const to = network.nodes.get('N-002') as { position: { x: number; z: number } };
    const snap = nearestRoadEdge(network, { x: to.position.x - 0.5, z: to.position.z });

    expect(snap?.t).toBeGreaterThan(0.95);
    expect(snap?.direction).toEqual(edgeDirection(network, 'E-N001-N002'));
    expect(snap?.fromNodeId).toBe('N-001');
  });
});

describe('determinism', () => {
  it('returns identical snaps for identical input', () => {
    const network = createRoadNetwork();
    const point = { x: 3.5, z: -12.75 };

    expect(nearestRoadNode(network, point)).toEqual(nearestRoadNode(network, point));
    expect(nearestRoadEdge(network, point)).toEqual(nearestRoadEdge(network, point));
  });

  it('never reports a node or an edge closer than the epsilon it claims', () => {
    const network = createRoadNetwork();
    const snap = nearestRoadEdge(network, { x: 0, z: 0 });

    expect(snap?.distanceMeters).toBeLessThanOrEqual(EPSILON_M);
  });
});
