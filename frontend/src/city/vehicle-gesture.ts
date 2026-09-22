/**
 * The Phase 6 claw gesture, as a pure state machine.
 *
 * The pointer gesture is the part of the drag that must behave exactly the same in the
 * browser and in a unit test, so it lives here instead of inside the scene: pressing the
 * right button lifts one vehicle, moving the pointer only re-resolves the drop preview,
 * and releasing either snaps to a road node or restores the original node.
 *
 * Nothing here plans a route. A pointer move re-resolves the nearest node (a bounded scan
 * of the city nodes) and never recomputes the scenario, which is what keeps a drag from
 * triggering one optimization per mouse move.
 */

import {
  SNAP_NODE_MAX_RADIUS_M,
  type CityPoint,
  type RoadNetwork,
} from './dataset';
import { nearestRoadNode } from './selection';

export interface ClawPreview {
  accepted: boolean;
  nodeId: string | null;
  position: CityPoint;
  distanceMeters: number;
  reason: 'SNAP_OUT_OF_RADIUS' | null;
}

export interface ClawGesture {
  pointerId: number;
  vehicleId: string;
  originNodeId: string;
  originPosition: CityPoint;
  pointer: CityPoint;
  preview: ClawPreview;
}

export interface BeginClawOptions {
  pointerId: number;
  vehicleId: string;
  originNodeId: string;
  originPosition: CityPoint;
  pointer: CityPoint;
  network: RoadNetwork;
}

export interface ClawDrop {
  accepted: boolean;
  nodeId: string | null;
  position: CityPoint;
  reason: 'SNAP_OUT_OF_RADIUS' | null;
}

/** Resolve one drop preview for a pointer position. Never plans a route. */
export function resolveClawPreview(network: RoadNetwork, pointer: CityPoint): ClawPreview {
  const snap = nearestRoadNode(network, pointer, SNAP_NODE_MAX_RADIUS_M);
  if (!snap) {
    return {
      accepted: false,
      nodeId: null,
      position: pointer,
      distanceMeters: Number.POSITIVE_INFINITY,
      reason: 'SNAP_OUT_OF_RADIUS',
    };
  }
  return {
    accepted: true,
    nodeId: snap.nodeId,
    position: snap.position,
    distanceMeters: snap.distanceMeters,
    reason: null,
  };
}

export function beginClawGesture(options: BeginClawOptions): ClawGesture {
  return {
    pointerId: options.pointerId,
    vehicleId: options.vehicleId,
    originNodeId: options.originNodeId,
    originPosition: options.originPosition,
    pointer: options.pointer,
    preview: resolveClawPreview(options.network, options.pointer),
  };
}

/** Move the lifted vehicle and refresh the preview; no scenario work happens here. */
export function updateClawGesture(
  gesture: ClawGesture,
  pointer: CityPoint,
  network: RoadNetwork,
): ClawGesture {
  if (samePlanarPoint(gesture.pointer, pointer)) return gesture;
  return { ...gesture, pointer, preview: resolveClawPreview(network, pointer) };
}

/**
 * Decide the outcome of a release.
 *
 * A drop outside the radius is rejected and the caller restores the original node; a
 * drop on the node the vehicle already occupies is accepted without any change.
 */
export function resolveClawDrop(gesture: ClawGesture, network: RoadNetwork): ClawDrop {
  const preview = resolveClawPreview(network, gesture.pointer);
  if (!preview.accepted || preview.nodeId === null) {
    return {
      accepted: false,
      nodeId: null,
      position: gesture.originPosition,
      reason: 'SNAP_OUT_OF_RADIUS',
    };
  }
  const node = network.nodes.get(preview.nodeId);
  return {
    accepted: true,
    nodeId: preview.nodeId,
    position: node?.position ?? preview.position,
    reason: null,
  };
}

export function clawDropChangesNode(gesture: ClawGesture, network: RoadNetwork): boolean {
  const drop = resolveClawDrop(gesture, network);
  return drop.accepted && drop.nodeId !== gesture.originNodeId;
}

export function describeClawPreview(preview: ClawPreview): string {
  if (!preview.accepted) {
    return `Drop rejected · no road node within ${SNAP_NODE_MAX_RADIUS_M.toFixed(0)} m`;
  }
  return `Drop preview · node ${preview.nodeId} at ${preview.distanceMeters.toFixed(1)} m`;
}

export function describeClawDrop(drop: ClawDrop, originNodeId: string): string {
  if (!drop.accepted) {
    return `Drop rejected · the vehicle stays on node ${originNodeId}`;
  }
  return `Vehicle dropped on node ${drop.nodeId}`;
}

export function samePlanarPoint(left: CityPoint, right: CityPoint): boolean {
  return left.x === right.x && left.z === right.z;
}

export interface GesturePlacement {
  vehicleId: string;
  position: CityPoint;
  lifted: boolean;
}

/**
 * Overlay the dragged vehicle on the sampled placements.
 *
 * The lift only changes what is drawn: the scenario stays untouched until the drop is
 * accepted, which is what makes an invalid drop a pure visual revert.
 */
export function applyGestureToPlacements<T extends GesturePlacement>(
  placements: readonly T[],
  gesture: ClawGesture | null,
): T[] {
  if (!gesture) return [...placements];
  return placements.map((placement) =>
    placement.vehicleId === gesture.vehicleId
      ? { ...placement, position: gesture.pointer, lifted: true }
      : placement,
  );
}
