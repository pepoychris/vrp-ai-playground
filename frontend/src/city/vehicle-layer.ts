/**
 * Vehicles and the claw arm, plus Raycaster-compatible picking.
 *
 * The layer keeps one logical root per vehicle: the root is what the simulation moves,
 * never the selected child mesh, so a drag can never fight the mesh hierarchy. The claw
 * is a child of the vehicle root, which is why it follows a lifted robot without a second
 * transform to keep in sync.
 *
 * Picking answers in two steps: an exact Raycaster hit against the vehicle meshes, and a
 * bounded screen-space fallback, so a small robot stays selectable at any zoom.
 */

import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Object3D,
  type OrthographicCamera,
  type Raycaster,
  Vector3,
} from 'three';

import type { SceneAssetBundle } from '../scene/load-assets';
import { CITY_TOKENS, STATUS_COLORS } from '../scene/design-tokens';
import { instantiateShared } from '../scene/resources';

import type { CityPoint } from './dataset';
import { findFirstMesh } from './city-stage';

export const VEHICLE_LAYER_NAME = 'VehicleLayer';
/** Screen-space pick radius, in pixels, used when the exact hit misses. */
export const PICK_RADIUS_PIXELS = 22;
/** How far a lifted robot hovers above its road node. */
export const CLAW_LIFT_METERS = 6;

export interface VehiclePlacement {
  vehicleId: string;
  nodeId?: string;
  position: CityPoint;
  headingDegrees: number;
  colorHex?: string;
  lifted?: boolean;
  /** True for a vehicle a road closure affects: highlighted in the city view. */
  highlighted?: boolean;
}

export interface VehicleLayer {
  root: Group;
  objects: Map<string, Object3D>;
  /** One material per palette index, created once and reused across fleet changes. */
  materials: Map<number, MeshStandardMaterial>;
  fallbackBody: BoxGeometry;
  fallbackClaw: BoxGeometry;
  /** Footprint geometry and material for the affected-vehicle highlight. */
  highlightGeometry: PlaneGeometry;
  highlightMaterial: MeshStandardMaterial;
}

export function fallbackVehicleGeometry(): BoxGeometry {
  return new BoxGeometry(1.6, 0.8, 1.6).translate(0, 0.4, 0);
}

export function createVehicleLayer(): VehicleLayer {
  const root = new Group();
  root.name = VEHICLE_LAYER_NAME;
  return {
    root,
    objects: new Map(),
    materials: new Map(),
    fallbackBody: fallbackVehicleGeometry(),
    fallbackClaw: new BoxGeometry(0.6, 0.4, 0.6),
    highlightGeometry: new PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2),
    highlightMaterial: new MeshStandardMaterial({
      color: new Color(STATUS_COLORS.degraded),
      emissive: new Color(STATUS_COLORS.degraded),
      emissiveIntensity: 0.35,
      roughness: 0.7,
      metalness: 0.0,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  };
}

function vehicleMaterial(colorHex: string): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color(colorHex),
    roughness: 0.55,
    metalness: 0.25,
  });
}

const CLAW_MATERIAL_KEY = -1;

function clawObject(layer: VehicleLayer, bundle: SceneAssetBundle | null): Object3D {
  const loaded = bundle?.assets.get('robotClaw');
  if (!loaded) {
    const fallback = new Mesh(
      layer.fallbackClaw,
      cachedMaterial(layer, CLAW_MATERIAL_KEY, CITY_TOKENS.surfaceColors.blockPad),
    );
    fallback.name = 'VehicleClawFallback';
    fallback.position.y = 1.4;
    return fallback;
  }
  const instance = instantiateShared(loaded.scene);
  instance.name = 'VehicleClaw';
  instance.position.y = 1.4;
  return instance;
}

/**
 * Rebuild the vehicle layer from the current placements.
 *
 * Vehicles are reused by id so a moving robot keeps its identity, its colour and its
 * attached claw across frames; a vehicle that left the scenario is removed.
 */
export function applyVehiclePlacements(
  layer: VehicleLayer,
  placementSource: readonly VehiclePlacement[],
  bundle: SceneAssetBundle | null = null,
): Map<string, Object3D> {
  const seen = new Set<string>();
  placementSource.forEach((placement, index) => {
    seen.add(placement.vehicleId);
    let object = layer.objects.get(placement.vehicleId);
    if (!object) {
      object = createVehicleObject(layer, placement, index, bundle);
      layer.objects.set(placement.vehicleId, object);
      layer.root.add(object);
    }
    object.position.set(placement.position.x, placement.lifted ? CLAW_LIFT_METERS : 0, placement.position.z);
    object.rotation.y = (placement.headingDegrees * Math.PI) / 180;
    object.userData.lifted = Boolean(placement.lifted);
    object.userData.roadNodeId = placement.nodeId;
    const claw = object.getObjectByName('VehicleClaw') ?? object.getObjectByName('VehicleClawFallback');
    if (claw) claw.visible = Boolean(placement.lifted);
    const highlight = object.getObjectByName('VehicleHighlight');
    if (highlight) highlight.visible = Boolean(placement.highlighted);
  });
  for (const [vehicleId, object] of [...layer.objects.entries()]) {
    if (seen.has(vehicleId)) continue;
    layer.root.remove(object);
    layer.objects.delete(vehicleId);
  }
  return layer.objects;
}

function createVehicleObject(
  layer: VehicleLayer,
  placement: VehiclePlacement,
  index: number,
  bundle: SceneAssetBundle | null,
): Object3D {
  const root = new Group();
  root.name = `Vehicle-${placement.vehicleId}`;
  root.userData.vehicleId = placement.vehicleId;
  const loaded = bundle?.assets.get('robotVehicle');
  const fixtureMesh = loaded ? findFirstMesh(loaded.scene) : null;
  const paletteIndex = index % CITY_TOKENS.routeColors.length;
  const material = cachedMaterial(
    layer,
    paletteIndex,
    placement.colorHex ?? CITY_TOKENS.routeColors[paletteIndex],
  );
  const body = new Mesh(fixtureMesh?.geometry ?? layer.fallbackBody, material);
  body.name = 'VehicleBody';
  body.userData.vehicleId = placement.vehicleId;
  const highlight = new Mesh(layer.highlightGeometry, layer.highlightMaterial);
  highlight.name = 'VehicleHighlight';
  highlight.position.y = 0.05;
  highlight.visible = Boolean(placement.highlighted);
  root.add(body, clawObject(layer, bundle), highlight);
  return root;
}

function cachedMaterial(layer: VehicleLayer, index: number, colorHex: string): MeshStandardMaterial {
  const existing = layer.materials.get(index);
  if (existing) return existing;
  const material = vehicleMaterial(colorHex);
  layer.materials.set(index, material);
  return material;
}

export function setVehicleLifted(
  layer: VehicleLayer,
  vehicleId: string,
  lifted: boolean,
  liftMeters: number = CLAW_LIFT_METERS,
): boolean {
  const object = layer.objects.get(vehicleId);
  if (!object) return false;
  object.position.y = lifted ? liftMeters : 0;
  object.userData.lifted = lifted;
  const claw = object.getObjectByName('VehicleClaw') ?? object.getObjectByName('VehicleClawFallback');
  if (claw) claw.visible = lifted;
  return true;
}

export function vehicleColorHex(index: number): string {
  return CITY_TOKENS.routeColors[index % CITY_TOKENS.routeColors.length];
}

/** Nearest vehicle root under the ray, or ``null``. */
export function pickVehicleId(raycaster: Raycaster, root: Object3D): string | null {
  const hits = raycaster.intersectObject(root, true);
  for (const hit of hits) {
    const vehicleId = vehicleIdOf(hit.object);
    if (vehicleId) return vehicleId;
  }
  return null;
}

export function vehicleIdOf(object: Object3D | null): string | null {
  let current: Object3D | null = object;
  while (current) {
    const vehicleId = current.userData?.vehicleId;
    if (typeof vehicleId === 'string') return vehicleId;
    current = current.parent;
  }
  return null;
}

/**
 * Screen-space fallback for picking: the closest vehicle origin within `radiusPixels`.
 *
 * The projection is the inverse of the pointer mapping the camera already uses, so the
 * fallback agrees with the exact hit whenever the exact hit is available.
 */
export function nearestVehicleInScreenSpace(
  camera: OrthographicCamera,
  vehicles: readonly { vehicleId: string; position: CityPoint }[],
  pixel: { x: number; y: number },
  width: number,
  height: number,
  radiusPixels: number = PICK_RADIUS_PIXELS,
): string | null {
  camera.updateMatrixWorld(true);
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const vehicle of vehicles) {
    const projected = new Vector3(
      vehicle.position.x,
      vehicle.position.y,
      vehicle.position.z,
    ).project(camera);
    const x = ((projected.x + 1) / 2) * width;
    const y = ((1 - projected.y) / 2) * height;
    const distance = Math.hypot(x - pixel.x, y - pixel.y);
    if (distance > radiusPixels) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = vehicle.vehicleId;
    }
  }
  return bestId;
}
