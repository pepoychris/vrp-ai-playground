import { describe, expect, it } from 'vitest';

import { CITY_DATASET, SNAP_NODE_MAX_RADIUS_M, type CityPoint, createRoadNetwork } from './dataset';
import {
  applyGestureToPlacements,
  beginClawGesture,
  clawDropChangesNode,
  describeClawDrop,
  describeClawPreview,
  resolveClawDrop,
  resolveClawPreview,
  updateClawGesture,
} from './vehicle-gesture';

const NETWORK = createRoadNetwork();
const DEPOT = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT')!;
const DELIVERY = CITY_DATASET.nodes.find((node) => node.kind === 'DELIVERY')!;
const MID_BLOCK: CityPoint = { x: 24, y: 0, z: 24 };

describe('claw drop preview', () => {
  it('accepts a point inside the node radius and reports the node', () => {
    const preview = resolveClawPreview(NETWORK, {
      x: DEPOT.position.x + 2,
      y: 0,
      z: DEPOT.position.z - 2,
    });
    expect(preview.accepted).toBe(true);
    expect(preview.nodeId).toBe(DEPOT.nodeId);
    expect(preview.reason).toBeNull();
    expect(preview.position.x).toBeCloseTo(DEPOT.position.x, 9);
    expect(describeClawPreview(preview)).toContain(DEPOT.nodeId);
  });

  it('rejects a point outside the radius and keeps the pointer for feedback', () => {
    const preview = resolveClawPreview(NETWORK, MID_BLOCK);
    expect(preview.accepted).toBe(false);
    expect(preview.nodeId).toBeNull();
    expect(preview.reason).toBe('SNAP_OUT_OF_RADIUS');
    expect(preview.position).toEqual(MID_BLOCK);
    expect(describeClawPreview(preview)).toContain(
      SNAP_NODE_MAX_RADIUS_M.toFixed(0),
    );
  });
});

describe('claw gesture', () => {
  it('lifts the vehicle on the node it was grabbed from', () => {
    const gesture = beginClawGesture({
      pointerId: 7,
      vehicleId: 'R-01',
      originNodeId: DEPOT.nodeId,
      originPosition: DEPOT.position,
      pointer: { x: DEPOT.position.x, y: 0, z: DEPOT.position.z },
      network: NETWORK,
    });
    expect(gesture.vehicleId).toBe('R-01');
    expect(gesture.originNodeId).toBe(DEPOT.nodeId);
    expect(gesture.preview.accepted).toBe(true);
  });

  it('only refreshes the preview while the pointer moves', () => {
    const gesture = beginClawGesture({
      pointerId: 1,
      vehicleId: 'R-01',
      originNodeId: DEPOT.nodeId,
      originPosition: DEPOT.position,
      pointer: { x: DEPOT.position.x, y: 0, z: DEPOT.position.z },
      network: NETWORK,
    });
    const unchanged = updateClawGesture(gesture, gesture.pointer, NETWORK);
    expect(unchanged).toBe(gesture);

    const moved = updateClawGesture(gesture, MID_BLOCK, NETWORK);
    expect(moved).not.toBe(gesture);
    expect(moved.pointer).toEqual(MID_BLOCK);
    expect(moved.preview.accepted).toBe(false);
    expect(moved.originNodeId).toBe(DEPOT.nodeId);
  });

  it('resolves a valid release to the snapped node and an invalid one to the origin', () => {
    const base = {
      pointerId: 1,
      vehicleId: 'R-01',
      originNodeId: DEPOT.nodeId,
      originPosition: DEPOT.position,
      network: NETWORK,
    };
    const valid = resolveClawDrop(
      beginClawGesture({ ...base, pointer: DELIVERY.position }),
      NETWORK,
    );
    expect(valid.accepted).toBe(true);
    expect(valid.nodeId).toBe(DELIVERY.nodeId);
    expect(valid.position).toEqual(DELIVERY.position);

    const invalid = resolveClawDrop(beginClawGesture({ ...base, pointer: MID_BLOCK }), NETWORK);
    expect(invalid.accepted).toBe(false);
    expect(invalid.reason).toBe('SNAP_OUT_OF_RADIUS');
    expect(invalid.position).toEqual(DEPOT.position);
    expect(describeClawDrop(invalid, DEPOT.nodeId)).toContain('stays on node');
  });

  it('knows when a drop would actually move the vehicle', () => {
    const base = {
      pointerId: 1,
      vehicleId: 'R-01',
      originNodeId: DEPOT.nodeId,
      originPosition: DEPOT.position,
      network: NETWORK,
    };
    expect(clawDropChangesNode(beginClawGesture({ ...base, pointer: DEPOT.position }), NETWORK)).toBe(
      false,
    );
    expect(
      clawDropChangesNode(beginClawGesture({ ...base, pointer: DELIVERY.position }), NETWORK),
    ).toBe(true);
    expect(clawDropChangesNode(beginClawGesture({ ...base, pointer: MID_BLOCK }), NETWORK)).toBe(
      false,
    );
  });
});

describe('placements under a gesture', () => {
  const placements = [
    { vehicleId: 'R-01', position: { x: 0, y: 0, z: 0 }, lifted: false },
    { vehicleId: 'R-02', position: { x: 10, y: 0, z: 0 }, lifted: false },
  ];

  it('returns the sampled placements untouched when nothing is dragged', () => {
    expect(applyGestureToPlacements(placements, null)).toEqual(placements);
  });

  it('lifts only the dragged vehicle and leaves the scenario alone', () => {
    const gesture = beginClawGesture({
      pointerId: 1,
      vehicleId: 'R-01',
      originNodeId: DEPOT.nodeId,
      originPosition: DEPOT.position,
      pointer: { x: 5, y: 0, z: 5 },
      network: NETWORK,
    });
    const applied = applyGestureToPlacements(placements, gesture);
    expect(applied[0]).toMatchObject({ lifted: true, position: { x: 5, y: 0, z: 5 } });
    expect(applied[1]).toEqual(placements[1]);
    expect(placements[0].lifted).toBe(false);
  });
});
