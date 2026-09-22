/**
 * Placed barriers and the drag preview, plus Raycaster-compatible picking.
 *
 * A placed barrier is the Phase 2 `barrier` fixture, one logical root per barrier id, and
 * it is rotated by the heading of the road edge it closes so the arm lies across that
 * road. The fixture arm starts at the post and spans 1.8 m, so the root is shifted half an
 * arm against the arm direction: the post stands beside the road and the arm covers the
 * centre, which is how a real closure reads.
 *
 * The drag preview is deliberately schematic: a post, an arm and a flat marker over the
 * candidate road. It carries no plan, so it can be recoloured for a valid or an invalid
 * drop without touching any shared fixture material.
 */

import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
  type Object3D,
  type OrthographicCamera,
  type Raycaster,
} from 'three';

import { PALETTE, STATUS_COLORS } from '../scene/design-tokens';
import type { SceneAssetBundle } from '../scene/load-assets';
import type { BarrierPlacement, BarrierPreview } from '../scenario/barriers';

import { findFirstMesh } from './city-stage';
import type { CityPoint } from './dataset';

export const BARRIER_LAYER_NAME = 'BarrierLayer';
/** Screen-space pick radius, in pixels, used when the exact hit misses. */
export const BARRIER_PICK_RADIUS_PIXELS = 26;
/** Half of the fixture arm span: the root sits this far from the road centre. */
export const BARRIER_POST_OFFSET_METERS = 0.9;
/** Arm span of the Phase 2 fixture, in metres. */
export const BARRIER_ARM_SPAN_METERS = 1.8;

const Y_AXIS = new Vector3(0, 1, 0);
/** Local +X is the arm direction once the root is rotated by the edge heading. */
const ARM_AXIS = new Vector3(1, 0, 0);

export interface BarrierLayer {
  root: Group;
  objects: Map<string, Object3D>;
  /** Schematic drag preview: post, arm and the road marker. */
  preview: Group;
  marker: Mesh;
  /** One material for the schematic preview; its colour reports valid or invalid. */
  previewMaterial: MeshStandardMaterial;
  /** One material for every placed barrier body, created once and reused. */
  bodyMaterial: MeshStandardMaterial;
  markerMaterial: MeshBasicMaterial;
  /** Shared selection footprint, so a selected barrier has no own material to leak. */
  selectionMaterial: MeshBasicMaterial;
  fallbackBody: BoxGeometry;
  fallbackArm: BoxGeometry;
  markerGeometry: PlaneGeometry;
}

export function createBarrierLayer(): BarrierLayer {
  const root = new Group();
  root.name = BARRIER_LAYER_NAME;

  const previewMaterial = new MeshStandardMaterial({
    color: new Color(STATUS_COLORS.ready),
    roughness: 0.5,
    metalness: 0.2,
  });
  const markerMaterial = new MeshBasicMaterial({
    color: new Color(STATUS_COLORS.ready),
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const bodyMaterial = new MeshStandardMaterial({
    color: new Color(PALETTE.barrierArm),
    roughness: 0.5,
    metalness: 0.3,
  });
  const selectionMaterial = new MeshBasicMaterial({
    color: new Color(PALETTE.accent),
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const fallbackBody = new BoxGeometry(0.18, 1.1, 0.18).translate(
    -BARRIER_POST_OFFSET_METERS,
    0.55,
    0,
  );
  const fallbackArm = new BoxGeometry(BARRIER_ARM_SPAN_METERS, 0.16, 0.18).translate(
    0,
    0.95,
    0,
  );
  const markerGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  const preview = new Group();
  preview.name = 'BarrierPreview';
  const previewPost = new Mesh(fallbackBody, previewMaterial);
  previewPost.name = 'BarrierPreviewPost';
  const previewArm = new Mesh(fallbackArm, previewMaterial);
  previewArm.name = 'BarrierPreviewArm';
  const marker = new Mesh(markerGeometry, markerMaterial);
  marker.name = 'BarrierPreviewMarker';
  marker.position.y = 0.04;
  preview.add(previewPost, previewArm, marker);
  preview.visible = false;
  root.add(preview);

  return {
    root,
    objects: new Map(),
    preview,
    marker,
    previewMaterial,
    bodyMaterial,
    markerMaterial,
    selectionMaterial,
    fallbackBody,
    fallbackArm,
    markerGeometry,
  };
}

/**
 * Rebuild the placed barriers from the published placements.
 *
 * A barrier is reused by id so a selection or a camera move does not rebuild the scene
 * graph, and a barrier that was removed disappears.
 */
export function applyBarrierPlacements(
  layer: BarrierLayer,
  placements: readonly BarrierPlacement[],
  bundle: SceneAssetBundle | null = null,
): Map<string, Object3D> {
  const seen = new Set<string>();
  placements.forEach((placement) => {
    seen.add(placement.barrierId);
    let object = layer.objects.get(placement.barrierId);
    if (!object) {
      object = createBarrierObject(layer, placement, bundle);
      layer.objects.set(placement.barrierId, object);
      layer.root.add(object);
    }
    const headingRadians = (placement.headingDegrees * Math.PI) / 180;
    object.rotation.y = headingRadians;
    // The post stands half an arm off the road centre so the arm covers the road.
    const offset = ARM_AXIS.clone()
      .applyAxisAngle(Y_AXIS, headingRadians)
      .multiplyScalar(-BARRIER_POST_OFFSET_METERS);
    object.position.set(
      placement.position.x + offset.x,
      placement.position.y,
      placement.position.z + offset.z,
    );
    object.userData.barrierId = placement.barrierId;
    object.userData.blockedEdgeId = placement.edgeId;
    object.userData.selected = placement.selected;
    const highlight = object.getObjectByName('BarrierSelection');
    if (highlight) highlight.visible = placement.selected;
  });
  for (const [barrierId, object] of [...layer.objects.entries()]) {
    if (seen.has(barrierId)) continue;
    layer.root.remove(object);
    layer.objects.delete(barrierId);
  }
  return layer.objects;
}

function createBarrierObject(
  layer: BarrierLayer,
  placement: BarrierPlacement,
  bundle: SceneAssetBundle | null,
): Object3D {
  const root = new Group();
  root.name = `Barrier-${placement.barrierId}`;
  root.userData.barrierId = placement.barrierId;
  const loaded = bundle?.assets.get('barrier');
  const fixtureMesh = loaded ? findFirstMesh(loaded.scene) : null;
  const body = new Mesh(fixtureMesh?.geometry ?? layer.fallbackBody, layer.bodyMaterial);
  body.name = 'BarrierBody';
  body.userData.barrierId = placement.barrierId;
  // Selection reads as a lit footprint under the barrier, so a selected barrier is obvious
  // without hiding the fixture.
  const selection = new Mesh(layer.markerGeometry, layer.selectionMaterial);
  selection.name = 'BarrierSelection';
  selection.position.y = 0.06;
  selection.scale.set(2.8, 1, 2.8);
  selection.visible = false;
  root.add(body, selection);
  return root;
}

/**
 * Show, move or hide the drag preview.
 *
 * The preview reports validity through its colour: a valid drop turns the schematic
 * barrier and the road marker green, an invalid one turns the barrier red and hides the
 * marker, because there is no candidate road to point at.
 */
export function setBarrierPreview(
  layer: BarrierLayer,
  preview: BarrierPreview | null,
): void {
  if (!preview) {
    layer.preview.visible = false;
    return;
  }
  const color = preview.accepted ? STATUS_COLORS.ready : STATUS_COLORS.error;
  layer.previewMaterial.color.set(color);
  layer.markerMaterial.color.set(color);
  const headingRadians = (preview.headingDegrees * Math.PI) / 180;
  layer.preview.visible = true;
  layer.preview.rotation.y = headingRadians;
  if (preview.accepted) {
    layer.preview.position.set(
      preview.projectedPoint.x,
      preview.projectedPoint.y,
      preview.projectedPoint.z,
    );
    layer.marker.visible = true;
    layer.marker.rotation.y = 0;
    // The marker covers the whole candidate edge: the edge midpoint expressed in the
    // preview's local frame, which is rotated by the edge heading.
    const cos = Math.cos(headingRadians);
    const sin = Math.sin(headingRadians);
    const dx = preview.edgeMidpoint.x - preview.projectedPoint.x;
    const dz = preview.edgeMidpoint.z - preview.projectedPoint.z;
    layer.marker.position.set(dx * cos - dz * sin, 0.04, dx * sin + dz * cos);
    layer.marker.scale.set(preview.edgeWidthMeters, 1, preview.edgeLengthMeters);
    return;
  }
  layer.preview.position.set(preview.pointer.x, preview.pointer.y, preview.pointer.z);
  layer.marker.visible = false;
}

export function barrierIdOf(object: Object3D | null): string | null {
  let current: Object3D | null = object;
  while (current) {
    const barrierId = current.userData?.barrierId;
    if (typeof barrierId === 'string') return barrierId;
    current = current.parent;
  }
  return null;
}

/** Nearest barrier root under the ray, or ``null``. */
export function pickBarrierId(raycaster: Raycaster, root: Object3D): string | null {
  const hits = raycaster.intersectObject(root, true);
  for (const hit of hits) {
    const barrierId = barrierIdOf(hit.object);
    if (barrierId) return barrierId;
  }
  return null;
}

/**
 * Screen-space fallback for picking: the closest barrier origin within `radiusPixels`.
 *
 * It mirrors the vehicle fallback, so a small barrier stays selectable at any zoom.
 */
export function nearestBarrierInScreenSpace(
  camera: OrthographicCamera,
  barriers: readonly { barrierId: string; position: CityPoint }[],
  pixel: { x: number; y: number },
  width: number,
  height: number,
  radiusPixels: number = BARRIER_PICK_RADIUS_PIXELS,
): string | null {
  camera.updateMatrixWorld(true);
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const barrier of barriers) {
    const projected = new Vector3(
      barrier.position.x,
      barrier.position.y,
      barrier.position.z,
    ).project(camera);
    const x = ((projected.x + 1) / 2) * width;
    const y = ((1 - projected.y) / 2) * height;
    const distance = Math.hypot(x - pixel.x, y - pixel.y);
    if (distance > radiusPixels) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = barrier.barrierId;
    }
  }
  return bestId;
}

export type { BarrierPlacement, BarrierPreview };
