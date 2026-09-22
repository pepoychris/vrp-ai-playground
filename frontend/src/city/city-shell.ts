/**
 * The Phase 3 city shell.
 *
 * It is the city sibling of the Phase 2 scene shell and reuses the same building
 * blocks: the lighting rig, the renderer factory, the resource registry, the budget
 * measurement and the design tokens. What changes is the camera, which is a true
 * isometric orthographic view, and the stage, which is generated from
 * `robot-city.json` instead of the fixture plan.
 *
 * The renderer stays optional on purpose: without a WebGL context the shell still
 * builds, measures, selects and disposes everything, and reports why the preview is
 * unavailable.
 */

import { Color, Fog, Group, Raycaster, Scene, Vector2 } from 'three';
import type { Mesh, Object3D, OrthographicCamera } from 'three';

import { LIGHTING } from '../scene/design-tokens';
import type { SceneAssetBundle } from '../scene/load-assets';
import { ResourceRegistry, type ResourceDisposalReport } from '../scene/resources';
import { createDefaultRenderer, createLightingRig, type RendererLike } from '../scene/scene-shell';

import {
  boundsDiagonal,
  boundsCenter,
  createCityControls,
  groundPointFromNdc,
  pixelToNdc,
  type CityControls,
  type GroundBounds,
  type NdcPoint,
} from './city-camera';
import { buildCityStageReport, type CityStageReport } from './city-stage';
import {
  CITY_DATASET,
  SNAP_EDGE_MAX_RADIUS_M,
  SNAP_NODE_MAX_RADIUS_M,
  createRoadNetwork,
  type CityDataset,
  type CityPoint,
  type RoadNetwork,
} from './dataset';
import { nearestRoadEdge, nearestRoadNode, type RoadEdgeSnap, type RoadNodeSnap } from './selection';
import { createRouteVisual } from './road-visuals';
import {
  PICK_RADIUS_PIXELS,
  applyVehiclePlacements,
  createVehicleLayer,
  nearestVehicleInScreenSpace,
  pickVehicleId,
  setVehicleLifted,
  vehicleColorHex,
  type VehicleLayer,
  type VehiclePlacement,
} from './vehicle-layer';

/**
 * Fog distances are derived from the city size: the Phase 2 token values are tuned for
 * a nine metre stage and would hide a four hundred metre district.
 */
const CITY_FOG_NEAR_FACTOR = 1.4;
const CITY_FOG_FAR_FACTOR = 2.6;

export interface CitySelection {
  ground: CityPoint;
  node: RoadNodeSnap | null;
  edge: RoadEdgeSnap | null;
  nodeRadiusMeters: number;
  edgeRadiusMeters: number;
}

export interface CityShellOptions {
  canvas?: HTMLCanvasElement;
  width: number;
  height: number;
  dataset?: CityDataset;
  bounds?: GroundBounds;
  createRenderer?: (canvas: HTMLCanvasElement | undefined) => RendererLike;
}

/**
 * Everything the Phase 6 scenario contributes to the scene: one route surface per
 * vehicle with stops, and the vehicles themselves.
 */
export interface VehicleSceneState {
  routes: readonly { vehicleId: string; edgeIds: readonly string[] }[];
  vehicles: readonly VehiclePlacement[];
}

export interface CityShell {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  readonly cityRoot: Group;
  readonly vehicleRoot: Group;
  readonly registry: ResourceRegistry;
  readonly network: RoadNetwork;
  readonly controls: CityControls;
  readonly renderer: RendererLike | null;
  readonly rendererError: string | null;
  readonly lastBuild: CityStageReport | null;
  readonly cameraEnabled: boolean;
  buildCity(bundle?: SceneAssetBundle | null): CityStageReport;
  syncScenario(state: VehicleSceneState, bundle?: SceneAssetBundle | null): void;
  updateVehiclePlacements(placements: readonly VehiclePlacement[]): void;
  pickVehicleAtPixel(offsetX: number, offsetY: number): string | null;
  groundPointAtPixel(offsetX: number, offsetY: number): CityPoint | null;
  setCameraEnabled(enabled: boolean): void;
  setClawLift(vehicleId: string, lifted: boolean): boolean;
  selectAtNdc(ndc: NdcPoint): CitySelection | null;
  selectAtPixel(offsetX: number, offsetY: number): CitySelection | null;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): ResourceDisposalReport;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createCityShell(options: CityShellOptions): CityShell {
  const dataset = options.dataset ?? CITY_DATASET;
  const network = createRoadNetwork(dataset);
  const bounds: GroundBounds = options.bounds ?? { ...dataset.bounds };
  const diagonal = boundsDiagonal(bounds);

  const scene = new Scene();
  scene.name = 'RoboRouteCityScene';
  scene.background = new Color(LIGHTING.background);
  scene.fog = new Fog(
    new Color(LIGHTING.fog.color),
    diagonal * CITY_FOG_NEAR_FACTOR,
    diagonal * CITY_FOG_FAR_FACTOR,
  );

  const registry = new ResourceRegistry();
  const lighting = createLightingRig();
  scene.add(lighting);
  registry.collect(lighting);

  const controls = createCityControls({
    width: options.width,
    height: options.height,
    bounds,
  });
  const camera = controls.camera as OrthographicCamera;

  const cityRoot = new Group();
  cityRoot.name = 'CityHost';
  scene.add(cityRoot);

  // Scenario layers live outside `cityRoot` so rebuilding the city never drops the
  // vehicles, and the vehicles keep their identity across a scenario sync.
  const routeRoot = new Group();
  routeRoot.name = 'ScenarioRoutes';
  scene.add(routeRoot);
  const vehicles: VehicleLayer = createVehicleLayer();
  scene.add(vehicles.root);
  const raycaster = new Raycaster();

  let renderer: RendererLike | null = null;
  let rendererError: string | null = null;
  try {
    renderer = options.createRenderer
      ? options.createRenderer(options.canvas)
      : createDefaultRenderer(options.canvas, options.width, options.height);
  } catch (error) {
    renderer = null;
    rendererError = describeError(error);
  }

  let width = options.width;
  let height = options.height;
  let lastBuild: CityStageReport | null = null;
  let ownedRoot: Object3D | null = null;
  let cameraEnabled = true;

  const disposeRouteSurfaces = () => {
    routeRoot.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material?.dispose();
      }
    });
    routeRoot.clear();
  };

  return {
    scene,
    camera,
    cityRoot,
    vehicleRoot: vehicles.root,
    registry,
    network,
    controls,
    get renderer() {
      return renderer;
    },
    get rendererError() {
      return rendererError;
    },
    get lastBuild() {
      return lastBuild;
    },
    get cameraEnabled() {
      return cameraEnabled;
    },
    buildCity(bundle = null) {
      if (ownedRoot) {
        cityRoot.remove(ownedRoot);
      }
      const report = buildCityStageReport({ dataset, bundle });
      cityRoot.add(report.root);
      registry.collect(report.root);
      ownedRoot = report.root;
      lastBuild = report;
      return report;
    },
    syncScenario(state, bundle = null) {
      disposeRouteSurfaces();
      state.routes.forEach((route, index) => {
        if (route.edgeIds.length === 0) return;
        const surface = createRouteVisual(network, route.edgeIds, {
          colorHex: vehicleColorHex(index),
        });
        surface.name = `Route-${route.vehicleId}`;
        surface.userData.vehicleId = route.vehicleId;
        routeRoot.add(surface);
      });
      applyVehiclePlacements(vehicles, state.vehicles, bundle);
    },
    updateVehiclePlacements(placements) {
      applyVehiclePlacements(vehicles, placements);
    },
    pickVehicleAtPixel(offsetX, offsetY) {
      const ndc = pixelToNdc(offsetX, offsetY, width, height);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
      const exact = pickVehicleId(raycaster, vehicles.root);
      if (exact) return exact;
      const candidates = [...vehicles.objects.values()].map((object) => ({
        vehicleId: object.userData.vehicleId as string,
        position: { x: object.position.x, y: object.position.y, z: object.position.z },
      }));
      return nearestVehicleInScreenSpace(
        camera,
        candidates,
        { x: offsetX, y: offsetY },
        width,
        height,
        PICK_RADIUS_PIXELS,
      );
    },
    groundPointAtPixel(offsetX, offsetY) {
      return groundPointFromNdc(camera, pixelToNdc(offsetX, offsetY, width, height));
    },
    setCameraEnabled(enabled) {
      cameraEnabled = enabled;
      controls.enabled = enabled;
    },
    setClawLift(vehicleId, lifted) {
      return setVehicleLifted(vehicles, vehicleId, lifted);
    },
    selectAtNdc(ndc) {
      const ground = groundPointFromNdc(camera, ndc);
      if (!ground) return null;
      return {
        ground,
        node: nearestRoadNode(network, ground, SNAP_NODE_MAX_RADIUS_M),
        edge: nearestRoadEdge(network, ground, { maxRadius: SNAP_EDGE_MAX_RADIUS_M }),
        nodeRadiusMeters: SNAP_NODE_MAX_RADIUS_M,
        edgeRadiusMeters: SNAP_EDGE_MAX_RADIUS_M,
      };
    },
    selectAtPixel(offsetX, offsetY) {
      return this.selectAtNdc(pixelToNdc(offsetX, offsetY, width, height));
    },
    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      controls.resize(width, height);
      renderer?.setSize(width, height, false);
    },
    render() {
      renderer?.render(scene, camera);
    },
    dispose() {
      if (ownedRoot) {
        cityRoot.remove(ownedRoot);
        ownedRoot = null;
      }
      disposeRouteSurfaces();
      for (const material of vehicles.materials.values()) material.dispose();
      vehicles.materials.clear();
      vehicles.fallbackBody.dispose();
      vehicles.fallbackClaw.dispose();
      vehicles.objects.clear();
      const report = registry.dispose();
      scene.clear();
      renderer?.dispose();
      renderer = null;
      return report;
    },
  };
}

/** The city view is centred on the dataset, which is also where the depot sits. */
export function cityViewCenter(dataset: CityDataset = CITY_DATASET): CityPoint {
  return boundsCenter(dataset.bounds);
}
