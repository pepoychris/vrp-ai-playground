/**
 * Road and route surfaces for the city.
 *
 * Two different geometries come out of this module, and keeping them apart is the whole
 * point:
 *
 * - the road surface follows `visualSplineControlPoints`, which is decoration;
 * - a route surface follows the node positions of the ordered edge sequence exactly,
 *   with no smoothing and no curve fitting.
 *
 * Both are built as flat ribbons so they stay deterministic, cheap and testable without
 * a WebGL context.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';

import { CITY_TOKENS } from '../scene/design-tokens';

import {
  roadWidthMetersFor,
  type CityPoint,
  type RoadNetwork,
} from './dataset';

/** Two points closer than this are treated as the same point when building a ribbon. */
const POINT_MERGE_EPSILON_M = 1e-6;

export interface RibbonOptions {
  widthMeters: number;
  heightMeters: number;
  colorHex?: string;
}

export interface RibbonBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface RoadEdgeRange {
  edgeId: string;
  vertexStart: number;
  vertexCount: number;
  triangleStart: number;
  triangleCount: number;
}

export interface RoadMeshBuild {
  mesh: Mesh;
  edgeIds: readonly string[];
  ranges: readonly RoadEdgeRange[];
}

export interface RoutePolyline {
  points: readonly CityPoint[];
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}

export interface RouteVisualOptions {
  widthMeters?: number;
  heightMeters?: number;
  colorHex?: string;
  startNodeId?: string | null;
}

export interface RoutePolylineOptions {
  startNodeId?: string | null;
}

function planarLength(a: CityPoint, b: CityPoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Drop repeated points so a zero-length segment cannot produce a degenerate ribbon.
 * A route that revisits the same node still keeps its logical order.
 */
function mergeRepeatedPoints(points: readonly CityPoint[]): CityPoint[] {
  const merged: CityPoint[] = [];
  for (const point of points) {
    const previous = merged[merged.length - 1];
    if (previous && planarLength(previous, point) <= POINT_MERGE_EPSILON_M) continue;
    merged.push(point);
  }
  return merged;
}

function unitDirection(from: CityPoint, to: CityPoint): { x: number; z: number } | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length <= POINT_MERGE_EPSILON_M) return null;
  return { x: dx / length, z: dz / length };
}

/**
 * Build a flat ribbon along a polyline. Every point produces a left and a right vertex,
 * so the centreline of the ribbon is exactly the polyline the caller passed in: that is
 * what lets a test prove that a route does not get smoothed.
 */
export function ribbonBuffers(
  points: readonly CityPoint[],
  options: RibbonOptions,
): RibbonBuffers {
  const merged = mergeRepeatedPoints(points);
  const halfWidth = options.widthMeters / 2;
  if (merged.length < 2 || !(halfWidth > 0)) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      triangleCount: 0,
    };
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let index = 0; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const current = merged[index];
    const next = merged[index + 1];
    const incoming = previous ? unitDirection(previous, current) : null;
    const outgoing = next ? unitDirection(current, next) : null;
    let direction = incoming ?? outgoing;
    if (incoming && outgoing) {
      const sum = { x: incoming.x + outgoing.x, z: incoming.z + outgoing.z };
      const length = Math.hypot(sum.x, sum.z);
      // A 180 degree reversal has no miter; falling back to the incoming direction
      // keeps the ribbon finite and deterministic.
      direction = length <= POINT_MERGE_EPSILON_M ? incoming : { x: sum.x / length, z: sum.z / length };
    }
    const normal = direction ? { x: -direction.z, z: direction.x } : { x: 1, z: 0 };
    positions.push(
      current.x + normal.x * halfWidth,
      options.heightMeters,
      current.z + normal.z * halfWidth,
    );
    positions.push(
      current.x - normal.x * halfWidth,
      options.heightMeters,
      current.z - normal.z * halfWidth,
    );
    normals.push(0, 1, 0, 0, 1, 0);
  }

  for (let segment = 0; segment < merged.length - 1; segment += 1) {
    const left = segment * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, right);
    indices.push(right, nextLeft, nextRight);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    vertexCount: merged.length * 2,
    triangleCount: indices.length / 3,
  };
}

export function buildRibbonGeometry(
  points: readonly CityPoint[],
  options: RibbonOptions,
): BufferGeometry {
  const buffers = ribbonBuffers(points, options);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(buffers.normals, 3));
  geometry.setIndex(new BufferAttribute(buffers.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Centreline of a ribbon, recovered from the vertex pairs it was built from. */
export function ribbonCentreline(buffers: RibbonBuffers): CityPoint[] {
  const centreline: CityPoint[] = [];
  for (let vertex = 0; vertex < buffers.vertexCount; vertex += 2) {
    const left = vertex * 3;
    const right = left + 3;
    centreline.push({
      x: (buffers.positions[left] + buffers.positions[right]) / 2,
      y: (buffers.positions[left + 1] + buffers.positions[right + 1]) / 2,
      z: (buffers.positions[left + 2] + buffers.positions[right + 2]) / 2,
    });
  }
  return centreline;
}

function roadMaterial(colorHex: string): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color(colorHex),
    roughness: 0.92,
    metalness: 0.0,
  });
}

/**
 * One merged road surface for the whole city, in the dataset's canonical edge order.
 *
 * Every vertex carries the index of the edge it belongs to, and the mesh publishes the
 * matching `edgeIds` array plus the vertex/triangle range of each segment. A rendered
 * road segment therefore still carries its stable `roadEdgeId`, and the whole network
 * costs one draw call.
 */
export function buildRoadMesh(network: RoadNetwork): RoadMeshBuild {
  const { presentation } = network.dataset;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const edgeIndices: number[] = [];
  const ranges: RoadEdgeRange[] = [];
  const edgeIds: string[] = [];

  for (const edgeId of network.edgeIds) {
    const edge = network.edges.get(edgeId);
    if (!edge) continue;
    const buffers = ribbonBuffers(edge.visualSplineControlPoints, {
      widthMeters: roadWidthMetersFor(edge, presentation),
      heightMeters: presentation.roadSurfaceHeightMeters,
    });
    if (buffers.vertexCount === 0) continue;
    const vertexStart = positions.length / 3;
    const triangleStart = indices.length / 3;
    const edgeIndex = edgeIds.length;
    edgeIds.push(edgeId);
    for (const value of buffers.positions) positions.push(value);
    for (const value of buffers.normals) normals.push(value);
    for (let vertex = 0; vertex < buffers.vertexCount; vertex += 1) edgeIndices.push(edgeIndex);
    for (const value of buffers.indices) indices.push(value + vertexStart);
    ranges.push({
      edgeId,
      vertexStart,
      vertexCount: buffers.vertexCount,
      triangleStart,
      triangleCount: buffers.triangleCount,
    });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('aRoadEdgeIndex', new BufferAttribute(new Float32Array(edgeIndices), 1));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  geometry.computeBoundingSphere();

  const mesh = new Mesh(geometry, roadMaterial(CITY_TOKENS.surfaceColors.roadSurface));
  mesh.name = 'CityRoads';
  mesh.userData.roadEdgeIds = [...edgeIds];
  mesh.userData.roadEdgeRanges = ranges.map((range) => ({ ...range }));
  return { mesh, edgeIds, ranges };
}

/**
 * Ordered edge ids to an exact polyline: the points are the node positions themselves,
 * never a sampled or smoothed version of them. A sequence that is not connected throws
 * instead of inventing a shortcut.
 */
export function routePolyline(
  network: RoadNetwork,
  edgeIds: readonly string[],
  options: RoutePolylineOptions = {},
): RoutePolyline {
  if (edgeIds.length === 0) {
    return { points: [], nodeIds: [], edgeIds: [] };
  }
  const points: CityPoint[] = [];
  const nodeIds: string[] = [];
  let cursor: string | null = options.startNodeId ?? null;

  for (const edgeId of edgeIds) {
    const edge = network.edges.get(edgeId);
    if (!edge) throw new Error(`unknown edge ${edgeId}`);
    let from = edge.fromNodeId;
    let to = edge.toNodeId;
    if (cursor !== null) {
      if (edge.fromNodeId === cursor) {
        to = edge.toNodeId;
      } else if (edge.toNodeId === cursor) {
        from = edge.toNodeId;
        to = edge.fromNodeId;
      } else {
        throw new Error(`route edges are not connected: ${edgeId} does not touch ${cursor}`);
      }
    }
    const fromNode = network.nodes.get(from);
    const toNode = network.nodes.get(to);
    if (!fromNode || !toNode) throw new Error(`edge ${edgeId} references a missing node`);
    if (nodeIds.length === 0) {
      nodeIds.push(from);
      points.push(fromNode.position);
    }
    nodeIds.push(to);
    points.push(toNode.position);
    cursor = to;
  }

  return { points, nodeIds, edgeIds: [...edgeIds] };
}

export function routeColorHex(index: number): string {
  const colors = CITY_TOKENS.routeColors;
  return colors[((index % colors.length) + colors.length) % colors.length];
}

export function routeColorCount(): number {
  return CITY_TOKENS.routeColors.length;
}

/**
 * Route surface for one ordered edge sequence. `colorHex` is the per-vehicle colour the
 * MVP asks for; a later phase passes the fleet palette and this stays the same call.
 */
export function createRouteVisual(
  network: RoadNetwork,
  edgeIds: readonly string[],
  options: RouteVisualOptions = {},
): Mesh {
  const presentation = network.dataset.presentation;
  const polyline = routePolyline(network, edgeIds, { startNodeId: options.startNodeId });
  const geometry = buildRibbonGeometry(polyline.points, {
    widthMeters: options.widthMeters ?? presentation.routeWidthMeters,
    heightMeters: options.heightMeters ?? presentation.routeSurfaceHeightMeters,
  });
  const mesh = new Mesh(geometry, roadMaterial(options.colorHex ?? routeColorHex(0)));
  mesh.name = 'RouteVisual';
  mesh.userData.edgeIds = [...edgeIds];
  mesh.userData.nodeIds = [...polyline.nodeIds];
  return mesh;
}

export const ROUTE_VISUAL_OWNER = 'RouteLayer';

/** Layer that owns route surfaces, kept empty until a later phase produces routes. */
export function createRouteLayer(): Object3D {
  const layer = new Object3D();
  layer.name = ROUTE_VISUAL_OWNER;
  return layer;
}
