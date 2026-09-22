/**
 * Phase 7 barrier placement, preview and impact, as pure functions.
 *
 * The barrier tool is the drag counterpart of the Phase 6 claw, and it follows the same
 * rule: a pointer move only re-resolves the nearest road edge, and nothing here plans a
 * route. Placement, removal and the before/after comparison belong to the published
 * snapshot, which is why the scenario recomputes exactly once per accepted barrier.
 *
 * A barrier blocks a `blockedEdgeId`, never a pixel position, and it blocks that edge in
 * both directions: every MVP road is bidirectional.
 */

import {
  SNAP_EDGE_MAX_RADIUS_M,
  createRoadNetwork,
  roadWidthMetersFor,
  type CityPoint,
  type RoadNetwork,
} from '../city/dataset';
import { edgeDirection, headingDegrees, nearestRoadEdge } from '../city/selection';

import type { ScenarioSnapshot } from './scenario';
import { currentRoutePlan } from './simulation';

/** Reason reported when no road edge is close enough to receive a barrier. */
export type BarrierRejectionCode = 'SNAP_NO_VALID_EDGE';

export interface BarrierPreview {
  accepted: boolean;
  edgeId: string | null;
  /** Raw world point under the pointer, kept so the marker stays where the user dragged. */
  pointer: CityPoint;
  /** Where the barrier post would be placed: the projection on the candidate edge. */
  projectedPoint: CityPoint;
  /** Centre of the candidate edge, where the road highlight is drawn. */
  edgeMidpoint: CityPoint;
  edgeLengthMeters: number;
  edgeWidthMeters: number;
  distanceMeters: number;
  /** Edge heading in degrees; the barrier arm is rotated to cross the road. */
  headingDegrees: number;
  reason: BarrierRejectionCode | null;
}

export interface BarrierPlacement {
  barrierId: string;
  edgeId: string;
  /** Snapped position from the published barrier, in local world metres. */
  position: CityPoint;
  headingDegrees: number;
  selected: boolean;
}

export type BarrierVehicleReason = 'CLOSED_ROAD' | 'NO_WORK' | 'DELAYED_ORDER';

export interface AffectedVehicle {
  vehicleId: string;
  reason: BarrierVehicleReason;
}

export interface AffectedOrder {
  orderId: string;
  reason: string;
}

/**
 * What the active road closures cost, as far as one snapshot can tell.
 *
 * The rules are deliberately conservative:
 * - an order the plan could not assign is reported with the plan's own reason;
 * - an order the plan delays is reported as delayed;
 * - a vehicle whose published route still crosses a closed road is reported, because
 *   that is exactly the invariant Phase 7 has to make visible;
 * - a vehicle with no stops while the plan dropped orders is reported as idle work;
 * - a vehicle carrying a delayed order is reported with it.
 *
 * A closure that changes nothing highlights nothing, which is the honest answer: there
 * is no affected vehicle or order to point at.
 */
export function barrierImpact(snapshot: ScenarioSnapshot): {
  active: boolean;
  edgeIds: string[];
  vehicles: AffectedVehicle[];
  orders: AffectedOrder[];
} {
  const edgeIds = [...new Set(snapshot.blockedEdgeIds)].sort();
  if (snapshot.barriers.length === 0 || edgeIds.length === 0) {
    return { active: false, edgeIds: [], vehicles: [], orders: [] };
  }

  const blocked = new Set(edgeIds);
  const plan = currentRoutePlan(snapshot);
  const vehicles = new Map<string, BarrierVehicleReason>();
  const orders = new Map<string, string>();
  if (plan) {
    for (const item of plan.unassignedOrders) orders.set(item.orderId, item.reason);
    const hasDroppedOrders = plan.unassignedOrders.length > 0;
    for (const route of plan.vehicles) {
      if (route.edgeSequence.some((edgeId) => blocked.has(edgeId))) {
        vehicles.set(route.vehicleId, 'CLOSED_ROAD');
      } else if (route.stops.length === 0 && hasDroppedOrders) {
        vehicles.set(route.vehicleId, 'NO_WORK');
      }
      for (const stop of route.stops) {
        if (stop.delaySeconds <= 0) continue;
        if (!orders.has(stop.orderId)) orders.set(stop.orderId, 'DELAYED');
        if (!vehicles.has(route.vehicleId)) vehicles.set(route.vehicleId, 'DELAYED_ORDER');
      }
    }
  }

  return {
    active: true,
    edgeIds,
    vehicles: [...vehicles.entries()]
      .map(([vehicleId, reason]) => ({ vehicleId, reason }))
      .sort((left, right) => (left.vehicleId < right.vehicleId ? -1 : 1)),
    orders: [...orders.entries()]
      .map(([orderId, reason]) => ({ orderId, reason }))
      .sort((left, right) => (left.orderId < right.orderId ? -1 : 1)),
  };
}

/** The set of vehicle ids to highlight for the active closures. */
export function affectedVehicleIds(snapshot: ScenarioSnapshot): Set<string> {
  return new Set(barrierImpact(snapshot).vehicles.map((item) => item.vehicleId));
}

/**
 * Resolve one drop preview for a pointer position.
 *
 * The already blocked roads are excluded before the distance test, exactly like the
 * server does, so the preview can never offer a road the server would refuse.
 */
export function resolveBarrierPreview(
  network: RoadNetwork,
  pointer: CityPoint,
  excludedEdgeIds: Iterable<string> = [],
): BarrierPreview {
  const snap = nearestRoadEdge(network, pointer, {
    maxRadius: SNAP_EDGE_MAX_RADIUS_M,
    excludedEdgeIds,
  });
  if (!snap) {
    return {
      accepted: false,
      edgeId: null,
      pointer,
      projectedPoint: pointer,
      edgeMidpoint: pointer,
      edgeLengthMeters: 0,
      edgeWidthMeters: 0,
      distanceMeters: Number.POSITIVE_INFINITY,
      headingDegrees: 0,
      reason: 'SNAP_NO_VALID_EDGE',
    };
  }
  const edge = network.edges.get(snap.edgeId);
  const from = edge ? network.nodes.get(edge.fromNodeId)?.position : undefined;
  const to = edge ? network.nodes.get(edge.toNodeId)?.position : undefined;
  const edgeMidpoint: CityPoint = from && to
    ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }
    : snap.projectedPoint;
  return {
    accepted: true,
    edgeId: snap.edgeId,
    pointer,
    projectedPoint: snap.projectedPoint,
    edgeMidpoint,
    edgeLengthMeters: edge?.lengthMeters ?? 0,
    edgeWidthMeters: edge ? roadWidthMetersFor(edge, network.dataset.presentation) : 0,
    distanceMeters: snap.distanceMeters,
    headingDegrees: snap.headingDegrees,
    reason: null,
  };
}

/** Placement of every active barrier: snapped point plus the heading that crosses the road. */
export function barrierPlacements(
  snapshot: ScenarioSnapshot,
  network: RoadNetwork = createRoadNetwork(),
  selectedBarrierId: string | null = null,
): BarrierPlacement[] {
  return [...snapshot.barriers]
    .sort((left, right) => (left.barrierId < right.barrierId ? -1 : 1))
    .map((barrier) => {
      const edge = network.edges.get(barrier.blockedEdgeId);
      return {
        barrierId: barrier.barrierId,
        edgeId: barrier.blockedEdgeId,
        position: barrier.position,
        headingDegrees: edge
          ? headingDegrees(edgeDirection(network, barrier.blockedEdgeId))
          : 0,
        selected: barrier.barrierId === selectedBarrierId,
      };
    });
}

export function describeBarrierPreview(preview: BarrierPreview): string {
  if (!preview.accepted || preview.edgeId === null) {
    return `No road within ${SNAP_EDGE_MAX_RADIUS_M.toFixed(0)} m · release to cancel`;
  }
  return (
    `Closure preview · edge ${preview.edgeId} at ${preview.distanceMeters.toFixed(1)} m · ` +
    'blocks both directions'
  );
}

export function describeBarrierPlacement(
  accepted: boolean,
  edgeId: string | null,
  barrierId: string | null,
): string {
  if (!accepted || edgeId === null) {
    return 'Closure rejected · no road edge under the pointer';
  }
  return `Road ${edgeId} closed${barrierId ? ` by ${barrierId}` : ''}`;
}

export function describeBarrierImpactReason(reason: string): string {
  if (reason === 'CLOSED_ROAD') return 'route crosses the closed road';
  if (reason === 'NO_WORK') return 'no stops left after the closure';
  if (reason === 'DELAYED_ORDER') return 'carries an order the plan delays';
  if (reason === 'DELAYED') return 'delayed by the current plan';
  if (reason === 'UNREACHABLE') return 'isolated by the closure';
  return reason.toLowerCase().replaceAll('_', ' ');
}
