/**
 * The Phase 6 vehicle layer.
 *
 * The layer has to keep one logical root per vehicle, move that root (never the selected
 * child mesh), carry the claw only while a robot is lifted, and stay pickable through a
 * Raycaster from the isometric camera.
 */

import { Raycaster, Vector2, type Mesh, type OrthographicCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { loadSceneAssets, type SceneAssetBundle } from '../scene/load-assets';
import {
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from '../scene/local-fixtures';

import { createCityControls, ndcFromGroundPoint, pixelToNdc } from './city-camera';
import { CITY_DATASET, type CityPoint } from './dataset';
import { CITY_TOKENS } from '../scene/design-tokens';
import {
  CLAW_LIFT_METERS,
  applyVehiclePlacements,
  createVehicleLayer,
  fallbackVehicleGeometry,
  nearestVehicleInScreenSpace,
  pickVehicleId,
  setVehicleLifted,
  vehicleIdOf,
} from './vehicle-layer';

installProgressEventShim();

const WIDTH = 900;
const HEIGHT = 600;
const DEPOT = CITY_DATASET.nodes.find((node) => node.kind === 'DEPOT')!;
const DELIVERY = CITY_DATASET.nodes.find((node) => node.kind === 'DELIVERY')!;

async function loadBundle(): Promise<SceneAssetBundle> {
  vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
  return loadSceneAssets({ assets: manifestForHeadless() });
}

function camera(): OrthographicCamera {
  return createCityControls({ width: WIDTH, height: HEIGHT }).camera;
}

function pixelOf(point: CityPoint, view: OrthographicCamera): { x: number; y: number } {
  const ndc = ndcFromGroundPoint(view, point);
  return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
}

function raycastAt(view: OrthographicCamera, pixel: { x: number; y: number }): Raycaster {
  const ndc = pixelToNdc(pixel.x, pixel.y, WIDTH, HEIGHT);
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), view);
  return raycaster;
}

describe('vehicle layer without the fixture bundle', () => {
  it('builds one root per vehicle with a fallback body', () => {
    const layer = createVehicleLayer();
    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', nodeId: DEPOT.nodeId, position: DEPOT.position, headingDegrees: 0 },
      { vehicleId: 'R-02', nodeId: DELIVERY.nodeId, position: DELIVERY.position, headingDegrees: 90 },
    ]);

    expect(layer.root.name).toBe('VehicleLayer');
    expect([...layer.objects.keys()]).toEqual(['R-01', 'R-02']);
    expect(layer.objects.get('R-01')!.name).toBe('Vehicle-R-01');
    expect(layer.objects.get('R-01')!.getObjectByName('VehicleBody')).toBeTruthy();
    expect(layer.objects.get('R-01')!.position.x).toBeCloseTo(DEPOT.position.x, 9);
    expect(layer.objects.get('R-02')!.rotation.y).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reuses a vehicle root across updates and drops one that left the scenario', () => {
    const layer = createVehicleLayer();
    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', position: DEPOT.position, headingDegrees: 0 },
      { vehicleId: 'R-02', position: DELIVERY.position, headingDegrees: 0 },
    ]);
    const first = layer.objects.get('R-01');

    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', nodeId: DELIVERY.nodeId, position: DELIVERY.position, headingDegrees: 0 },
    ]);

    expect(layer.objects.get('R-01')).toBe(first);
    expect(layer.objects.has('R-02')).toBe(false);
    expect(layer.root.children.map((child) => child.name)).toEqual(['Vehicle-R-01']);
    // One material per fleet palette slot plus the claw: the count is bounded by the
    // palette, so replacing the fleet can never grow the cache without limit.
    expect(layer.materials.size).toBeLessThanOrEqual(CITY_TOKENS.routeColors.length + 1);
    const bodyMaterial = (mesh: unknown) => (mesh as Mesh).material;
    expect(bodyMaterial(first!.getObjectByName('VehicleBody'))).toBe(
      bodyMaterial(layer.objects.get('R-01')!.getObjectByName('VehicleBody')),
    );
  });

  it('lifts the logical root, never the child mesh, and reveals the claw', () => {
    const layer = createVehicleLayer();
    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', position: DEPOT.position, headingDegrees: 0, lifted: true },
    ]);
    const root = layer.objects.get('R-01')!;
    const claw = root.getObjectByName('VehicleClawFallback');

    expect(root.position.y).toBe(CLAW_LIFT_METERS);
    expect(root.userData.lifted).toBe(true);
    expect(claw?.visible).toBe(true);
    expect(root.getObjectByName('VehicleBody')!.position.y).toBe(0);

    expect(setVehicleLifted(layer, 'R-01', false)).toBe(true);
    expect(root.position.y).toBe(0);
    expect(claw?.visible).toBe(false);
    expect(setVehicleLifted(layer, 'R-99', true)).toBe(false);
  });

  it('exposes a deterministic fallback body geometry', () => {
    const layer = createVehicleLayer();
    expect(layer.fallbackBody).toBeInstanceOf(fallbackVehicleGeometry().constructor);
  });
});

describe('vehicle picking', () => {
  it('picks the vehicle under the pointer with a Raycaster', () => {
    const layer = createVehicleLayer();
    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', position: DEPOT.position, headingDegrees: 0 },
    ]);
    const view = camera();

    expect(pickVehicleId(raycastAt(view, pixelOf(DEPOT.position, view)), layer.root)).toBe('R-01');
    expect(pickVehicleId(raycastAt(view, { x: 2, y: 2 }), layer.root)).toBeNull();
  });

  it('falls back to the closest vehicle origin in screen space', () => {
    const view = camera();
    const vehicles = [
      { vehicleId: 'R-01', position: DEPOT.position },
      { vehicleId: 'R-02', position: DELIVERY.position },
    ];
    const pixel = pixelOf(DEPOT.position, view);

    expect(nearestVehicleInScreenSpace(view, vehicles, pixel, WIDTH, HEIGHT, 10)).toBe('R-01');
    expect(
      nearestVehicleInScreenSpace(
        view,
        vehicles,
        { x: pixel.x + 400, y: pixel.y },
        WIDTH,
        HEIGHT,
        10,
      ),
    ).toBeNull();
  });

  it('walks up from a hit mesh to the logical vehicle id', () => {
    const layer = createVehicleLayer();
    applyVehiclePlacements(layer, [
      { vehicleId: 'R-01', position: DEPOT.position, headingDegrees: 0 },
    ]);
    const body = layer.objects.get('R-01')!.getObjectByName('VehicleBody')!;
    expect(vehicleIdOf(body)).toBe('R-01');
    expect(vehicleIdOf(layer.root)).toBeNull();
    expect(vehicleIdOf(null)).toBeNull();
  });
});

describe('vehicle layer with the Phase 2 assets', () => {
  it('reuses the robot-vehicle fixture geometry and the claw fixture', async () => {
    const bundle = await loadBundle();
    const layer = createVehicleLayer();
    applyVehiclePlacements(
      layer,
      [{ vehicleId: 'R-01', position: DEPOT.position, headingDegrees: 0, lifted: true }],
      bundle,
    );
    const root = layer.objects.get('R-01')!;

    expect(root.getObjectByName('VehicleBody')).toBeTruthy();
    expect(root.getObjectByName('VehicleClaw')).toBeTruthy();
    expect(root.getObjectByName('VehicleClawFallback')).toBeFalsy();
    expect(root.getObjectByName('VehicleClaw')!.visible).toBe(true);
  });
});
