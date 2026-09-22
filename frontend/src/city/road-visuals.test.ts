/**
 * Phase 3 road and route geometry.
 *
 * The two acceptance criteria this file proves are the ones that are easy to get
 * subtly wrong: every rendered road segment still carries its stable `roadEdgeId`, and
 * a route follows the exact logical polyline instead of a smoothed one.
 */

import { BufferGeometry, Color, type MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';

import { CITY_TOKENS } from '../scene/design-tokens';

import {
  CITY_DATASET,
  createRoadNetwork,
  type CityPoint,
  type RoadNetwork,
} from './dataset';
import {
  buildRoadMesh,
  buildRibbonGeometry,
  createRouteLayer,
  createRouteVisual,
  ribbonBuffers,
  ribbonCentreline,
  routeColorCount,
  routeColorHex,
  routePolyline,
} from './road-visuals';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Ribbon centreline points are the midpoint of two offset vertices stored in a
 * `Float32Array`, so their ground position matches the logical point to within single
 * precision noise instead of bit for bit. A tenth of a millimetre is far below any real
 * smoothing, which moves a point by metres. The height belongs to the ribbon surface,
 * not to the logical polyline, so it is checked separately.
 */
function expectGroundPointsClose(
  actual: readonly CityPoint[],
  expected: readonly CityPoint[],
  tolerance = 1e-4,
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((point, index) => {
    expect(Math.abs(actual[index].x - point.x), `x#${index}`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(actual[index].z - point.z), `z#${index}`).toBeLessThanOrEqual(tolerance);
  });
}

function geometryPositions(geometry: BufferGeometry): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

function centrelineOfGeometry(geometry: BufferGeometry): CityPoint[] {
  const positions = geometryPositions(geometry);
  const points: CityPoint[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex += 2) {
    const left = vertex * 3;
    const right = left + 3;
    points.push({
      x: (positions[left] + positions[right]) / 2,
      y: (positions[left + 1] + positions[right + 1]) / 2,
      z: (positions[left + 2] + positions[right + 2]) / 2,
    });
  }
  return points;
}

function faceNormalYs(geometry: BufferGeometry): number[] {
  const positions = geometryPositions(geometry);
  const index = geometry.getIndex();
  const indices = (index ? index.array : []) as ArrayLike<number>;
  const ys: number[] = [];
  for (let triangle = 0; triangle + 2 < indices.length; triangle += 3) {
    const [a, b, c] = [indices[triangle], indices[triangle + 1], indices[triangle + 2]].map(
      (vertex) => vertex * 3,
    );
    const ux = positions[b] - positions[a];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vz = positions[c + 2] - positions[a + 2];
    // Y component of the edge cross product: the sign tells which way the face points.
    ys.push(uz * vx - ux * vz);
  }
  return ys;
}

function centrelineWithinRange(
  geometry: BufferGeometry,
  vertexStart: number,
  vertexCount: number,
): CityPoint[] {
  const positions = geometryPositions(geometry);
  const points: CityPoint[] = [];
  for (let vertex = vertexStart; vertex < vertexStart + vertexCount; vertex += 2) {
    const left = vertex * 3;
    const right = left + 3;
    points.push({
      x: (positions[left] + positions[right]) / 2,
      y: (positions[left + 1] + positions[right + 1]) / 2,
      z: (positions[left + 2] + positions[right + 2]) / 2,
    });
  }
  return points;
}

describe('ribbonBuffers', () => {
  it('keeps the input polyline exactly on the ribbon centreline', () => {
    const polyline: CityPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 6 },
    ];

    const buffers = ribbonBuffers(polyline, { widthMeters: 2, heightMeters: 0.5 });

    expect(buffers.vertexCount).toBe(6);
    expect(buffers.triangleCount).toBe(4);
    const centreline = ribbonCentreline(buffers);
    expectGroundPointsClose(centreline, polyline);
    expect(centreline.every((point) => Math.abs(point.y - 0.5) <= 1e-6)).toBe(true);
  });

  it('faces every triangle up', () => {
    const geometry = buildRibbonGeometry(
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 0, z: 6 },
        { x: 0, y: 0, z: 6 },
      ],
      { widthMeters: 3, heightMeters: 0.1 },
    );

    for (const normalY of faceNormalYs(geometry)) {
      expect(normalY).toBeGreaterThan(0);
    }
  });

  it('collapses a degenerate polyline instead of building a broken ribbon', () => {
    expect(ribbonBuffers([], { widthMeters: 2, heightMeters: 0 }).vertexCount).toBe(0);
    expect(
      ribbonBuffers([{ x: 1, y: 0, z: 1 }], { widthMeters: 2, heightMeters: 0 }).vertexCount,
    ).toBe(0);
    expect(
      ribbonBuffers(
        [
          { x: 1, y: 0, z: 1 },
          { x: 1, y: 0, z: 1 },
        ],
        { widthMeters: 2, heightMeters: 0 },
      ).vertexCount,
    ).toBe(0);
    expect(
      ribbonBuffers(
        [
          { x: 0, y: 0, z: 0 },
          { x: 5, y: 0, z: 0 },
        ],
        { widthMeters: 0, heightMeters: 0 },
      ).vertexCount,
    ).toBe(0);
  });
});

describe('merged road mesh', () => {
  const network: RoadNetwork = createRoadNetwork();
  const build = buildRoadMesh(network);

  it('renders one segment per dataset edge, in canonical order', () => {
    expect(build.edgeIds).toEqual(network.edgeIds);
    expect(build.ranges).toHaveLength(CITY_DATASET.edges.length);
    expect(build.mesh.name).toBe('CityRoads');
    expect(build.mesh.userData.roadEdgeIds).toEqual(network.edgeIds);
  });

  it('carries the edge index on every vertex and covers the whole buffer', () => {
    const geometry = build.mesh.geometry;
    const edgeIndex = geometry.getAttribute('aRoadEdgeIndex').array as Float32Array;
    const positions = geometryPositions(geometry);
    let expectedVertex = 0;
    let expectedTriangle = 0;

    build.ranges.forEach((range, index) => {
      expect(range.vertexStart, range.edgeId).toBe(expectedVertex);
      expect(range.triangleStart, range.edgeId).toBe(expectedTriangle);
      for (let vertex = range.vertexStart; vertex < range.vertexStart + range.vertexCount; vertex += 1) {
        expect(edgeIndex[vertex], `${range.edgeId}#${vertex}`).toBe(index);
      }
      expectedVertex += range.vertexCount;
      expectedTriangle += range.triangleCount;
    });

    expect(expectedVertex).toBe(positions.length / 3);
    expect(expectedTriangle).toBe((geometry.getIndex() as { count: number }).count / 3);
  });

  it('keeps every segment on its own visual spline and on its own nodes', () => {
    const geometry = build.mesh.geometry;
    for (const range of build.ranges) {
      const edge = network.edges.get(range.edgeId) as { visualSplineControlPoints: readonly CityPoint[] };
      const centreline = centrelineWithinRange(geometry, range.vertexStart, range.vertexCount);
      expectGroundPointsClose(centreline, edge.visualSplineControlPoints);
      expect(
        centreline.every(
          (point) =>
            Math.abs(point.y - CITY_DATASET.presentation.roadSurfaceHeightMeters) <= 1e-4,
        ),
      ).toBe(true);
      const edgeNodes = network.edges.get(range.edgeId) as { fromNodeId: string; toNodeId: string };
      const from = network.nodes.get(edgeNodes.fromNodeId) as { position: CityPoint };
      const to = network.nodes.get(edgeNodes.toNodeId) as { position: CityPoint };
      expectGroundPointsClose([centreline[0]], [from.position]);
      expectGroundPointsClose([centreline[centreline.length - 1]], [to.position]);
    }
  });

  it('lays the road surface just above the ground', () => {
    const y = (build.mesh.geometry.getAttribute('position').array as Float32Array)[1];
    expect(y).toBeCloseTo(CITY_DATASET.presentation.roadSurfaceHeightMeters, 4);
  });
});

describe('routePolyline', () => {
  const network = createRoadNetwork();

  it('follows the exact node positions of an ordered edge sequence', () => {
    const polyline = routePolyline(network, ['E-N032-N033']);

    expect(polyline.nodeIds).toEqual(['N-032', 'N-033']);
    expect(polyline.points).toEqual([
      network.nodes.get('N-032')?.position,
      network.nodes.get('N-033')?.position,
    ]);
  });

  it('walks an edge in reverse when the sequence needs it', () => {
    const polyline = routePolyline(network, ['E-N004-N013', 'E-N012-N013']);

    expect(polyline.nodeIds).toEqual(['N-004', 'N-013', 'N-012']);
    expect(polyline.points).toEqual([
      network.nodes.get('N-004')?.position,
      network.nodes.get('N-013')?.position,
      network.nodes.get('N-012')?.position,
    ]);
    const segment = polyline.points[1];
    const next = polyline.points[2];
    expect(next.x).toBeLessThan(segment.x);
  });

  it('uses the route start node to orient the first bidirectional edge', () => {
    const edgeIds = ['E-N023-N032', 'E-N014-N023'];
    const polyline = routePolyline(network, edgeIds, { startNodeId: 'N-032' });

    expect(polyline.nodeIds).toEqual(['N-032', 'N-023', 'N-014']);
  });

  it('refuses a sequence that is not connected instead of inventing a shortcut', () => {
    expect(() => routePolyline(network, ['E-N032-N033', 'E-N001-N002'])).toThrowError(
      /not connected/,
    );
  });

  it('refuses an unknown edge and returns an empty polyline for an empty sequence', () => {
    expect(() => routePolyline(network, ['E-N999-N998'])).toThrowError(/unknown edge/);
    expect(routePolyline(network, [])).toEqual({ points: [], nodeIds: [], edgeIds: [] });
  });
});

describe('route visual', () => {
  const network = createRoadNetwork();

  it('renders the logical polyline with no smoothing', () => {
    const edgeIds = ['E-N032-N033', 'E-N033-N042'];
    const polyline = routePolyline(network, edgeIds);
    const mesh = createRouteVisual(network, edgeIds);

    const centreline = centrelineOfGeometry(mesh.geometry);

    expectGroundPointsClose(centreline, polyline.points);
    expect(centreline).toHaveLength(3);
    expect(mesh.userData.edgeIds).toEqual(edgeIds);
    expect(mesh.name).toBe('RouteVisual');
  });

  it('uses the per-vehicle colours from the visual tokens', () => {
    const mesh = createRouteVisual(network, ['E-N032-N033'], { colorHex: routeColorHex(2) });
    const material = mesh.material as MeshStandardMaterial;

    expect(material.color.getHex()).toBe(new Color(routeColorHex(2)).getHex());
    expect(material.color.getHex()).not.toBe(new Color(routeColorHex(3)).getHex());
  });

  it('takes its width and height from the dataset presentation', () => {
    const mesh = createRouteVisual(network, ['E-N032-N033']);
    const positions = geometryPositions(mesh.geometry);
    const width = Math.hypot(positions[0] - positions[3], positions[2] - positions[5]);

    expect(width).toBeCloseTo(CITY_DATASET.presentation.routeWidthMeters, 6);
    expect(positions[1]).toBeCloseTo(CITY_DATASET.presentation.routeSurfaceHeightMeters, 4);
    expect(CITY_DATASET.presentation.routeSurfaceHeightMeters).toBeGreaterThan(
      CITY_DATASET.presentation.roadSurfaceHeightMeters,
    );
  });

  it('keeps one route layer ready for later phases', () => {
    const layer = createRouteLayer();

    expect(layer.name).toBe('RouteLayer');
    expect(layer.children).toHaveLength(0);
  });
});

describe('route colours', () => {
  it('declares one deterministic colour per vehicle slot', () => {
    expect(routeColorCount()).toBe(6);
    expect(CITY_TOKENS.routeColors.every((color) => HEX.test(color))).toBe(true);
    expect(new Set(CITY_TOKENS.routeColors).size).toBe(6);
    for (let index = 0; index < 6; index += 1) {
      expect(routeColorHex(index)).toBe(CITY_TOKENS.routeColors[index]);
    }
    expect(routeColorHex(6)).toBe(CITY_TOKENS.routeColors[0]);
    expect(routeColorHex(-1)).toBe(CITY_TOKENS.routeColors[5]);
  });
});
