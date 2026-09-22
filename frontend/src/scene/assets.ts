/**
 * Asset manifest and scene plan for the Phase 2 fixture pipeline.
 *
 * Everything here comes from JSON contract files so the fixture generator, the
 * benchmark and the runtime cannot drift apart. The manifest never contains an
 * absolute or external URL: every asset is served from this origin.
 */

import rawContract from './asset-contract.json';
import rawBudget from './render-budget.json';
import rawPlan from './scene-plan.json';
import { ANIMATION_STATES, findUnknownAnimationStates, type AnimationState } from './animation-states';

export type AssetId = 'robotVehicle' | 'robotClaw' | 'barrier' | 'depotLandmark' | 'buildingFixture';

export interface AssetClipChannel {
  node: string;
  path: 'translation' | 'rotation';
  times: readonly number[];
  vectors: readonly (readonly number[])[];
}

export interface AssetClipDefinition {
  state: AnimationState;
  clipName: string;
  durationSeconds: number;
  channels: readonly AssetClipChannel[];
}

export interface AssetMaterialDefinition {
  name: string;
  paletteKey: string;
  metallicFactor: number;
  roughnessFactor: number;
  emissivePaletteKey: string | null;
}

export interface AssetDefinition {
  id: AssetId;
  fileName: string;
  label: string;
  sceneName: string;
  rootNode: string;
  material: AssetMaterialDefinition;
  clips: readonly AssetClipDefinition[];
  /**
   * States this fixture never authors. The runtime builds a deterministic placeholder
   * clip for them, which keeps the animation vocabulary complete for static props.
   */
  placeholderStates: readonly AnimationState[];
  declaredNodes: readonly string[];
  /** Same-origin URL the browser loads. */
  url: string;
}

export interface ScenePlacement {
  assetId: AssetId;
  position: readonly [number, number, number];
  rotationYDegrees: number;
  scale: number;
}

export interface ScenePlan {
  capturedAt: string;
  groundRadius: number;
  camera: {
    fov: number;
    near: number;
    far: number;
    position: readonly [number, number, number];
    lookAt: readonly [number, number, number];
  };
  instances: readonly ScenePlacement[];
}

export interface RenderBudget {
  capturedAt: string;
  targetFps: number;
  minimumAcceptableFps: number;
  perAsset: AssetBudgetLimits;
  /** Phase 2 fixture stage. */
  stage: StageBudgetLimits;
  /** Phase 3 city stage: more geometry, same measurement method. */
  city: StageBudgetLimits;
  memoryProxyBytesPerInstance: number;
  measurementNotes: string;
}

export interface AssetBudgetLimits {
  maxTriangles: number;
  maxDrawCalls: number;
  maxTextureCount: number;
  maxTextureBytes: number;
  maxFileBytes: number;
}

export interface StageBudgetLimits {
  maxTriangles: number;
  maxDrawCalls: number;
  maxTextureCount: number;
  maxTextureBytes: number;
  maxMemoryProxyBytes: number;
  maxInstanceCount: number;
}

export const ASSET_BASE_PATH = rawContract.assetBasePath;
export const ASSET_CONTRACT_GENERATOR = rawContract.generator;
export const RENDER_BUDGET = rawBudget as RenderBudget;
export const SCENE_PLAN = rawPlan as unknown as ScenePlan;

export function assetUrl(fileName: string): string {
  return `${ASSET_BASE_PATH}/${fileName}`;
}

interface RawAssetDefinition {
  id: AssetId;
  fileName: string;
  label: string;
  sceneName: string;
  rootNode: string;
  material: AssetMaterialDefinition;
  nodes: readonly { name: string }[];
  clips: readonly AssetClipDefinition[];
  placeholderStates: readonly AnimationState[];
}

export const ASSET_MANIFEST: readonly AssetDefinition[] = (
  rawContract.assets as unknown as readonly RawAssetDefinition[]
).map((asset) => ({
  ...asset,
  clips: asset.clips.map((clip) => ({ ...clip, state: clip.state as AnimationState })),
  placeholderStates: asset.placeholderStates.map((state) => state as AnimationState),
  declaredNodes: asset.nodes.map((node) => node.name),
  url: assetUrl(asset.fileName),
}));

export const ASSET_IDS = ASSET_MANIFEST.map((asset) => asset.id);

export function assetById(id: AssetId): AssetDefinition {
  const asset = ASSET_MANIFEST.find((candidate) => candidate.id === id);
  if (!asset) {
    throw new Error(`unknown asset id ${id}`);
  }
  return asset;
}

export function animationStatesFor(id: AssetId): readonly AnimationState[] {
  return assetById(id).clips.map((clip) => clip.state);
}

export function placementsFor(id: AssetId): readonly ScenePlacement[] {
  return SCENE_PLAN.instances.filter((instance) => instance.assetId === id);
}

export function instanceCounts(): Record<AssetId, number> {
  const counts = {} as Record<AssetId, number>;
  for (const id of ASSET_IDS) {
    counts[id] = placementsFor(id).length;
  }
  return counts;
}

/**
 * Contract self-check. Returns an empty list when the JSON contract is coherent, and a
 * human readable problem list otherwise, so a broken manifest fails a test instead of
 * a user session.
 */
export function validateAssetContract(assets: readonly AssetDefinition[] = ASSET_MANIFEST): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const asset of assets) {
    if (seenIds.has(asset.id)) problems.push(`duplicate asset id ${asset.id}`);
    seenIds.add(asset.id);
    if (seenFiles.has(asset.fileName)) problems.push(`duplicate asset file ${asset.fileName}`);
    seenFiles.add(asset.fileName);
    if (!asset.url.startsWith(`${ASSET_BASE_PATH}/`)) {
      problems.push(`${asset.id}: url ${asset.url} is not served from ${ASSET_BASE_PATH}`);
    }
    if (/^[a-z]+:\/\//i.test(asset.url) || asset.url.startsWith('//')) {
      problems.push(`${asset.id}: url ${asset.url} must stay same-origin`);
    }
    if (!asset.rootNode) problems.push(`${asset.id}: missing root node`);
    if (!asset.declaredNodes.includes(asset.rootNode)) {
      problems.push(`${asset.id}: root node ${asset.rootNode} is not declared`);
    }
    for (const node of asset.clips.flatMap((clip) => clip.channels.map((channel) => channel.node))) {
      if (!asset.declaredNodes.includes(node)) {
        problems.push(`${asset.id}: animation channel targets undeclared node ${node}`);
      }
    }
    for (const problem of findUnknownAnimationStates(asset.clips.map((clip) => clip.state))) {
      problems.push(`${asset.id}: unknown animation state ${problem}`);
    }
    const clipNames = new Set(asset.clips.map((clip) => clip.clipName));
    if (clipNames.size !== asset.clips.length) {
      problems.push(`${asset.id}: duplicate clip names`);
    }
    for (const problem of findUnknownAnimationStates(asset.placeholderStates)) {
      problems.push(`${asset.id}: unknown placeholder state ${problem}`);
    }
    for (const state of asset.placeholderStates) {
      if (asset.clips.some((clip) => clip.state === state)) {
        problems.push(`${asset.id}: ${state} is both authored and a placeholder`);
      }
    }
  }
  const covered = new Set(
    assets.flatMap((asset) => [
      ...asset.clips.map((clip) => clip.state),
      ...asset.placeholderStates,
    ]),
  );
  for (const state of ANIMATION_STATES) {
    if (!covered.has(state)) {
      problems.push(`no fixture authors the ${state} state`);
    }
  }
  return problems;
}
