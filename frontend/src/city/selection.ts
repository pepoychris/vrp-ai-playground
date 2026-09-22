/**
 * Deterministic coordinate selection for the city.
 *
 * These are the two helpers the MVP names: `nearestRoadNode()` and
 * `nearestRoadEdge()`. They work in the local x/z plane of the city, they never leave
 * the configured radius, and a tie is always resolved by the lexicographically smaller
 * identifier, so the same point always selects the same thing.
 *
 * The radius rejection is what a later phase turns into `422 SNAP_OUT_OF_RADIUS` and
 * `422 SNAP_NO_VALID_EDGE`: the caller decides, the helper only reports the truth.
 */

import {
  EPSILON_M,
  SNAP_EDGE_MAX_RADIUS_M,
  SNAP_NODE_MAX_RADIUS_M,
  distanceXz,
  type CityNodeKind,
  type CityPoint,
  type RoadNetwork,
} from './dataset';

export interface PlanarPoint {
  x: number;
  z: number;
}

export interface SegmentProjection {
  projectedPoint: CityPoint;
  /** Position along the segment, clamped to [0, 1]. */
  t: number;
  distanceMeters: number;
}

export interface RoadNodeSnap {
  nodeId: string;
  kind: CityNodeKind;
  position: CityPoint;
  distanceMeters: number;
}

export interface RoadEdgeSnap {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  bidirectional: boolean;
  projectedPoint: CityPoint;
  t: number;
  distanceMeters: number;
  /** Unit vector from `fromNodeId` to `toNodeId`, in local x/z. */
  direction: { x: number; z: number };
  /** Compass-style heading of `direction`: 0 points to +z, 90 points to +x. */
  headingDegrees: number;
}

export interface NearestEdgeOptions {
  maxRadius?: number;
  excludedEdgeIds?: Iterable<string>;
}

export function isWithinRadius(distanceMeters: number, maxRadius: number): boolean {
  return distanceMeters <= maxRadius + EPSILON_M;
}

/** Unit direction of an edge from `fromNodeId` to `toNodeId`. */
export function edgeDirection(network: RoadNetwork, edgeId: string): { x: number; z: number } {
  const edge = network.edges.get(edgeId);
  if (!edge) throw new Error(`unknown edge ${edgeId}`);
  const from = network.nodes.get(edge.fromNodeId);
  const to = network.nodes.get(edge.toNodeId);
  if (!from || !to) throw new Error(`edge ${edgeId} references a missing node`);
  const dx = to.position.x - from.position.x;
  const dz = to.position.z - from.position.z;
  const length = Math.hypot(dx, dz);
  if (length <= EPSILON_M) return { x: 1, z: 0 };
  return { x: dx / length, z: dz / length };
}

export function headingDegrees(direction: { x: number; z: number }): number {
  const degrees = (Math.atan2(direction.x, direction.z) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Project a point onto one edge in the XZ plane, with `t` clamped to [0, 1]. */
export function projectPointOnRoadEdge(
  network: RoadNetwork,
  edgeId: string,
  point: PlanarPoint,
): SegmentProjection {
  const edge = network.edges.get(edgeId);
  if (!edge) throw new Error(`unknown edge ${edgeId}`);
  const from = network.nodes.get(edge.fromNodeId);
  const to = network.nodes.get(edge.toNodeId);
  if (!from || !to) throw new Error(`edge ${edgeId} references a missing node`);
  return projectOnSegmentXz(point, from.position, to.position);
}

export function projectOnSegmentXz(
  point: PlanarPoint,
  start: CityPoint,
  end: CityPoint,
): SegmentProjection {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= EPSILON_M) {
    return {
      projectedPoint: { x: start.x, y: start.y, z: start.z },
      t: 0,
      distanceMeters: distanceXz(point, start),
    };
  }
  const rawT = ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared;
  const t = Math.min(1, Math.max(0, rawT));
  const projectedPoint: CityPoint = {
    x: start.x + t * dx,
    y: start.y + t * (end.y - start.y),
    z: start.z + t * dz,
  };
  return { projectedPoint, t, distanceMeters: distanceXz(point, projectedPoint) };
}

/**
 * Closest road node inside `maxRadius`, or `null` when nothing is close enough. An
 * exact tie (within `EPSILON_M`) goes to the lexicographically smaller node id.
 */
export function nearestRoadNode(
  network: RoadNetwork,
  point: PlanarPoint,
  maxRadius: number = SNAP_NODE_MAX_RADIUS_M,
): RoadNodeSnap | null {
  let best: RoadNodeSnap | null = null;
  for (const nodeId of network.nodeIds) {
    const node = network.nodes.get(nodeId);
    if (!node) continue;
    const distanceMeters = distanceXz(point, node.position);
    if (!isWithinRadius(distanceMeters, maxRadius)) continue;
    if (best === null || distanceMeters < best.distanceMeters - EPSILON_M) {
      best = {
        nodeId: node.nodeId,
        kind: node.kind,
        position: node.position,
        distanceMeters,
      };
      continue;
    }
    const isTie = Math.abs(distanceMeters - best.distanceMeters) <= EPSILON_M;
    if (isTie && node.nodeId < best.nodeId) {
      best = {
        nodeId: node.nodeId,
        kind: node.kind,
        position: node.position,
        distanceMeters,
      };
    }
  }
  return best;
}

/**
 * Closest road edge inside `maxRadius`, with excluded edges skipped before the
 * distance test. Excluding first is what stops a barrier from being placed twice on the
 * same edge. An exact tie goes to the lexicographically smaller edge id.
 */
export function nearestRoadEdge(
  network: RoadNetwork,
  point: PlanarPoint,
  options: NearestEdgeOptions = {},
): RoadEdgeSnap | null {
  const maxRadius = options.maxRadius ?? SNAP_EDGE_MAX_RADIUS_M;
  const excluded = new Set(options.excludedEdgeIds ?? []);
  let best: RoadEdgeSnap | null = null;
  for (const edgeId of network.edgeIds) {
    if (excluded.has(edgeId)) continue;
    const edge = network.edges.get(edgeId);
    if (!edge) continue;
    const projection = projectPointOnRoadEdge(network, edgeId, point);
    if (!isWithinRadius(projection.distanceMeters, maxRadius)) continue;
    const candidate = (): RoadEdgeSnap => {
      const direction = edgeDirection(network, edgeId);
      return {
        edgeId: edge.edgeId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        bidirectional: edge.bidirectional,
        projectedPoint: projection.projectedPoint,
        t: projection.t,
        distanceMeters: projection.distanceMeters,
        direction,
        headingDegrees: headingDegrees(direction),
      };
    };
    if (best === null || projection.distanceMeters < best.distanceMeters - EPSILON_M) {
      best = candidate();
      continue;
    }
    const isTie = Math.abs(projection.distanceMeters - best.distanceMeters) <= EPSILON_M;
    if (isTie && edge.edgeId < best.edgeId) {
      best = candidate();
    }
  }
  return best;
}
