/**
 * Isometric view and navigation for the city, with no mapping library involved.
 *
 * The camera is a true orthographic isometric view of the local city: azimuth 45°, the
 * isometric elevation and a frustum derived from the dataset bounds. Zoom only changes
 * `camera.zoom`, pan slides the camera along the ground, and both keep the screen/local
 * x-z mapping exact, which is what makes a click land on the same node after any
 * navigation.
 */

import { OrthographicCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

import { CITY_DATASET, type CityDataset, type CityPoint } from './dataset';

export interface GroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NdcPoint {
  x: number;
  y: number;
}

export interface CityCameraOptions {
  width: number;
  height: number;
  bounds?: GroundBounds;
}

export interface CityControls {
  camera: OrthographicCamera;
  /**
   * Navigation switch. The claw gesture turns it off so a right-button drag cannot pan
   * or zoom the view at the same time.
   */
  enabled: boolean;
  /** Point on the ground the camera looks at, in local x/z. */
  readonly target: CityPoint;
  readonly zoom: number;
  readonly frustumHeight: number;
  zoomBy(factor: number): number;
  zoomIn(): number;
  zoomOut(): number;
  /** Slide the camera so the ground follows a pointer drag in pixels. */
  panByPixels(deltaX: number, deltaY: number): CityPoint;
  resize(width: number, height: number): void;
  focusOn(point: { x: number; z: number }): void;
  reset(): void;
}

/** True isometric azimuth and elevation, in degrees. */
export const ISOMETRIC_AZIMUTH_DEGREES = 45;
export const ISOMETRIC_ELEVATION_DEGREES = 35.26438968275465;
export const MIN_CITY_ZOOM = 0.45;
export const MAX_CITY_ZOOM = 3.5;
const ZOOM_STEP = 1.12;
/** Frustum height as a multiple of the city diagonal, so the whole city fits at zoom 1. */
const FRUSTUM_DIAGONAL_FACTOR = 1.15;

const GROUND_PLANE = new Plane(new Vector3(0, 1, 0), 0);
const WORLD_UP = new Vector3(0, 1, 0);

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function cityBoundsOf(dataset: CityDataset = CITY_DATASET): GroundBounds {
  return { ...dataset.bounds };
}

export function boundsCenter(bounds: GroundBounds): CityPoint {
  return { x: (bounds.minX + bounds.maxX) / 2, y: 0, z: (bounds.minZ + bounds.maxZ) / 2 };
}

export function boundsDiagonal(bounds: GroundBounds): number {
  return Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
}

/** Unit vector from the ground target towards the camera. */
export function isometricDirection(): Vector3 {
  const azimuth = degreesToRadians(ISOMETRIC_AZIMUTH_DEGREES);
  const elevation = degreesToRadians(ISOMETRIC_ELEVATION_DEGREES);
  const horizontal = Math.cos(elevation);
  return new Vector3(
    Math.sin(azimuth) * horizontal,
    Math.sin(elevation),
    Math.cos(azimuth) * horizontal,
  ).normalize();
}

/** Canvas pixel offsets to normalised device coordinates. */
export function pixelToNdc(
  offsetX: number,
  offsetY: number,
  width: number,
  height: number,
): NdcPoint {
  return {
    x: (offsetX / Math.max(width, 1)) * 2 - 1,
    y: -(offsetY / Math.max(height, 1)) * 2 + 1,
  };
}

function applyFrustum(
  camera: OrthographicCamera,
  width: number,
  height: number,
  frustumHeight: number,
): void {
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  const halfHeight = frustumHeight / 2;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

export function createCityControls(options: CityCameraOptions): CityControls {
  const bounds = options.bounds ?? cityBoundsOf();
  const center = boundsCenter(bounds);
  const direction = isometricDirection();
  const frustumHeight = boundsDiagonal(bounds) * FRUSTUM_DIAGONAL_FACTOR;
  const distance = boundsDiagonal(bounds);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, distance + frustumHeight * 2);
  camera.name = 'CityIsometricCamera';
  camera.up.set(WORLD_UP.x, WORLD_UP.y, WORLD_UP.z);
  const target = new Vector3(center.x, 0, center.z);

  const place = () => {
    camera.position.set(
      target.x + direction.x * distance,
      target.y + direction.y * distance,
      target.z + direction.z * distance,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  };

  let width = options.width;
  let height = options.height;
  applyFrustum(camera, width, height, frustumHeight);
  place();

  const controls: CityControls = {
    camera,
    enabled: true,
    get target(): CityPoint {
      return { x: target.x, y: 0, z: target.z };
    },
    get zoom(): number {
      return camera.zoom;
    },
    get frustumHeight(): number {
      return frustumHeight;
    },
    zoomBy(factor: number) {
      if (!controls.enabled) return camera.zoom;
      camera.zoom = Math.min(MAX_CITY_ZOOM, Math.max(MIN_CITY_ZOOM, camera.zoom * factor));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return camera.zoom;
    },
    zoomIn() {
      return controls.zoomBy(ZOOM_STEP);
    },
    zoomOut() {
      return controls.zoomBy(1 / ZOOM_STEP);
    },
    panByPixels(deltaX: number, deltaY: number) {
      if (!controls.enabled) return controls.target;
      // World units per pixel on the ground. Zoom shrinks it, which is what makes a
      // dragged point stay under the pointer.
      camera.updateMatrixWorld(true);
      const worldPerPixel = frustumHeight / (Math.max(height, 1) * camera.zoom);
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      right.y = 0;
      right.normalize();
      const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      // Ground direction that moves the view vertically on screen: perpendicular to the
      // camera right axis and on the ground plane.
      const groundVertical = new Vector3().crossVectors(right, WORLD_UP).normalize();
      const verticalGain = up.dot(groundVertical);
      target.addScaledVector(right, -deltaX * worldPerPixel);
      if (Math.abs(verticalGain) > 1e-6) {
        target.addScaledVector(groundVertical, (deltaY * worldPerPixel) / verticalGain);
      }
      place();
      return controls.target;
    },
    resize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
      applyFrustum(camera, width, height, frustumHeight);
      place();
    },
    focusOn(point: { x: number; z: number }) {
      target.set(point.x, 0, point.z);
      place();
    },
    reset() {
      camera.zoom = 1;
      target.set(center.x, 0, center.z);
      applyFrustum(camera, width, height, frustumHeight);
      place();
    },
  };
  return controls;
}

/**
 * Intersect a normalised device coordinate with the ground plane, in local x/z. Returns
 * `null` when the ray misses the ground, so a caller never reads a stale coordinate.
 */
export function groundPointFromNdc(
  camera: OrthographicCamera,
  ndc: NdcPoint,
): CityPoint | null {
  camera.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
  const hit = raycaster.ray.intersectPlane(GROUND_PLANE, new Vector3());
  if (!hit) return null;
  return { x: hit.x, y: 0, z: hit.z };
}

/** Normalised device coordinate of an exact ground point. Inverse of `groundPointFromNdc`. */
export function ndcFromGroundPoint(camera: OrthographicCamera, point: CityPoint): NdcPoint {
  camera.updateMatrixWorld(true);
  const projected = new Vector3(point.x, point.y, point.z).project(camera);
  return { x: projected.x, y: projected.y };
}
