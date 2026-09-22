/**
 * The Phase 2 scene shell.
 *
 * It owns one disposable scene graph: lighting from the visual tokens, a neutral
 * ground plane, one fixture stage built from the loaded bundle, and an animation
 * director over the staged instances. The WebGL renderer is optional on purpose: when
 * the browser cannot create a context the shell still builds, measures and disposes
 * its resources, and reports why the preview is unavailable instead of failing.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';

import {
  createAnimationDirector,
  type AnimationDirector,
  type AnimationPlayback,
  type AssetWithClips,
} from './animation-clips';
import type { AnimationState } from './animation-states';
import { RENDER_BUDGET, SCENE_PLAN, type AssetId, type ScenePlan } from './assets';
import { evaluateBudget, measureObject3D, type BudgetReport } from './budget';
import { ambientLampToken, LIGHTING, lampToken } from './design-tokens';
import type { SceneAssetBundle } from './load-assets';
import { instantiateShared, ResourceRegistry, type ResourceDisposalReport } from './resources';

export class WebGLUnavailableError extends Error {
  constructor(message = 'WebGL is not available in this browser') {
    super(message);
    this.name = 'WebGLUnavailableError';
  }
}

export interface RendererLike {
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  dispose(): void;
}

export interface StageBuild {
  root: Group;
  instanceCount: number;
  placementCount: number;
  missingAssetIds: readonly AssetId[];
}

export interface StageBuildReport extends StageBuild {
  usage: ReturnType<typeof measureObject3D>;
  budget: BudgetReport;
}

export interface SceneShellOptions {
  canvas?: HTMLCanvasElement;
  width: number;
  height: number;
  plan?: ScenePlan;
  createRenderer?: (canvas: HTMLCanvasElement | undefined) => RendererLike;
  fadeSeconds?: number;
}

export interface SceneShell {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly stageRoot: Group;
  readonly registry: ResourceRegistry;
  readonly renderer: RendererLike | null;
  readonly rendererError: string | null;
  readonly lastBuild: StageBuildReport | null;
  buildStage(bundle: SceneAssetBundle): StageBuildReport;
  playState(state: AnimationState): AnimationPlayback;
  tick(deltaSeconds: number): void;
  render(): void;
  resize(width: number, height: number): void;
  dispose(): ResourceDisposalReport;
}

export function buildStageRoot(bundle: SceneAssetBundle, plan: ScenePlan = SCENE_PLAN): StageBuild {
  const root = new Group();
  root.name = 'FixtureStage';
  const missing = new Set<AssetId>();
  let instanceCount = 0;

  for (const placement of plan.instances) {
    const asset = bundle.assets.get(placement.assetId);
    if (!asset) {
      missing.add(placement.assetId);
      continue;
    }
    // Shared clone: geometry, materials and textures are referenced, never copied.
    const instance = instantiateShared(asset.scene);
    instance.position.set(placement.position[0], placement.position[1], placement.position[2]);
    instance.rotation.y = (placement.rotationYDegrees * Math.PI) / 180;
    instance.scale.setScalar(placement.scale);
    instance.name = `${asset.id}-${instanceCount}`;
    instance.userData.assetId = placement.assetId;
    root.add(instance);
    instanceCount += 1;
  }

  return { root, instanceCount, placementCount: plan.instances.length, missingAssetIds: [...missing] };
}

export function createLightingRig(): Group {
  const rig = new Group();
  rig.name = 'LightingRig';

  const ambientToken = ambientLampToken();
  const ambient = new AmbientLight(new Color(ambientToken.color), ambientToken.intensity);
  ambient.name = 'AmbientLight';
  rig.add(ambient);

  for (const name of ['key', 'fill', 'rim'] as const) {
    const token = lampToken(name);
    const light = new DirectionalLight(new Color(token.color), token.intensity);
    light.name = `${name[0].toUpperCase()}${name.slice(1)}Light`;
    light.position.set(token.position[0], token.position[1], token.position[2]);
    rig.add(light);
  }
  return rig;
}

export function createGroundPlane(plan: ScenePlan = SCENE_PLAN): Mesh {
  const geometry = new PlaneGeometry(plan.groundRadius * 2, plan.groundRadius * 2);
  const material = new MeshStandardMaterial({
    color: new Color(LIGHTING.ground.color),
    roughness: LIGHTING.ground.roughness,
    metalness: LIGHTING.ground.metalness,
  });
  const ground = new Mesh(geometry, material);
  ground.name = 'GroundPlane';
  ground.rotation.x = -Math.PI / 2;
  return ground;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createDefaultRenderer(
  canvas: HTMLCanvasElement | undefined,
  width: number,
  height: number,
): RendererLike {
  if (!canvas) {
    throw new WebGLUnavailableError('A canvas element is required to create the WebGL renderer');
  }
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'low-power',
  });
  const ratio = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  renderer.setPixelRatio(Math.min(ratio, 1.5));
  renderer.setSize(width, height, false);
  return renderer;
}

export function createSceneShell(options: SceneShellOptions): SceneShell {
  const plan = options.plan ?? SCENE_PLAN;
  const scene = new Scene();
  scene.name = 'RoboRouteFixtureScene';
  scene.background = new Color(LIGHTING.background);
  scene.fog = new Fog(new Color(LIGHTING.fog.color), LIGHTING.fog.near, LIGHTING.fog.far);

  const camera = new PerspectiveCamera(
    plan.camera.fov,
    options.width / Math.max(options.height, 1),
    plan.camera.near,
    plan.camera.far,
  );
  camera.position.set(
    plan.camera.position[0],
    plan.camera.position[1],
    plan.camera.position[2],
  );
  camera.lookAt(plan.camera.lookAt[0], plan.camera.lookAt[1], plan.camera.lookAt[2]);

  const registry = new ResourceRegistry();
  const lighting = createLightingRig();
  const ground = createGroundPlane(plan);
  scene.add(lighting, ground);
  registry.collect(lighting).collect(ground);

  const stageRoot = new Group();
  stageRoot.name = 'FixtureStageHost';
  scene.add(stageRoot);

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

  let director: AnimationDirector = createAnimationDirector([], {
    fadeSeconds: options.fadeSeconds,
  });
  let lastBuild: StageBuildReport | null = null;
  const ownedRoots: Object3D[] = [];

  return {
    scene,
    camera,
    stageRoot,
    registry,
    get renderer() {
      return renderer;
    },
    get rendererError() {
      return rendererError;
    },
    get lastBuild() {
      return lastBuild;
    },
    buildStage(bundle) {
      for (const root of ownedRoots) {
        stageRoot.remove(root);
      }
      ownedRoots.length = 0;
      director.stop();

      const stage = buildStageRoot(bundle, plan);
      stageRoot.add(stage.root);
      ownedRoots.push(stage.root);
      registry.collect(stage.root);

      const actors: AssetWithClips[] = [];
      stage.root.children.forEach((child) => {
        const assetId = child.userData.assetId as AssetId | undefined;
        if (!assetId) return;
        const loaded = bundle.assets.get(assetId);
        if (!loaded) return;
        actors.push({ asset: loaded.asset, scene: child, clips: loaded.clips });
      });
      director = createAnimationDirector(actors, { fadeSeconds: options.fadeSeconds });

      const usage = measureObject3D(stage.root);
      const budget = evaluateBudget('phase-2-fixture-stage', usage, RENDER_BUDGET.stage);
      lastBuild = { ...stage, usage, budget };
      return lastBuild;
    },
    playState(state) {
      return director.play(state);
    },
    tick(deltaSeconds) {
      director.update(deltaSeconds);
    },
    render() {
      renderer?.render(scene, camera);
    },
    resize(width, height) {
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer?.setSize(width, height, false);
    },
    dispose() {
      director.stop();
      stageRoot.remove(...ownedRoots);
      ownedRoots.length = 0;
      const report = registry.dispose();
      scene.clear();
      renderer?.dispose();
      renderer = null;
      return report;
    },
  };
}
