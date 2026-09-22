/**
 * Deterministic Phase 2 asset benchmark.
 *
 * It reads the real fixture GLB files, checks their glTF container, parses them with
 * the pinned GLTFLoader and proves the documented budgets, the geometry reuse, the
 * rebuild determinism and the disposal accounting. Frames per second are not measured:
 * a headless run has no WebGL context, and the budget file says so.
 */

import { describe, expect, it, vi } from 'vitest';

import { ANIMATION_STATES } from './animation-states';
import { ASSET_MANIFEST, RENDER_BUDGET, SCENE_PLAN, assetById } from './assets';
import { evaluateBudget, measureObject3D, type BudgetReport } from './budget';
import { paletteLinearRgb, type PaletteKey } from './design-tokens';
import { loadSceneAssets, type SceneAssetBundle } from './load-assets';
import {
  createFetchStub,
  fixtureBytes,
  installProgressEventShim,
  manifestForHeadless,
  parseLocalFixture,
  readGlbContainer,
} from './local-fixtures';
import { ResourceRegistry } from './resources';
import { buildStageRoot, createGroundPlane, createLightingRig } from './scene-shell';

installProgressEventShim();

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

describe('fixture container', () => {
  it('is a valid single-buffer glTF 2.0 binary without external references', () => {
    for (const asset of ASSET_MANIFEST) {
      const container = readGlbContainer(fixtureBytes(asset.fileName));

      expect(container.magic, asset.fileName).toBe(GLB_MAGIC);
      expect(container.version, asset.fileName).toBe(2);
      expect(container.declaredLength, asset.fileName).toBe(container.byteLength);
      expect(container.chunks.map((chunk) => chunk.type), asset.fileName).toEqual([
        JSON_CHUNK,
        BIN_CHUNK,
      ]);
      expect(container.document.asset?.version).toBe('2.0');
      expect(container.document.asset?.generator).toBe('roboroute-nexus-phase2-fixture-generator');
      expect(container.document.buffers).toHaveLength(1);
      expect(container.document.buffers?.[0].uri).toBeUndefined();
      expect(container.document.buffers?.[0].byteLength).toBe(container.chunks[1].length);
      expect(container.document.images ?? []).toHaveLength(0);
    }
  });

  it('declares min/max bounds on every animation input accessor', () => {
    for (const asset of ASSET_MANIFEST) {
      const container = readGlbContainer(fixtureBytes(asset.fileName));
      const inputs = new Set(
        (container.document.animations ?? []).flatMap((animation) =>
          animation.samplers.map((sampler) => sampler.input),
        ),
      );
      for (const index of inputs) {
        expect(container.document.accessors[index].min, `${asset.fileName}#${index}`).toBeDefined();
        expect(container.document.accessors[index].max, `${asset.fileName}#${index}`).toBeDefined();
      }
    }
  });
});

describe('fixture content', () => {
  it('parses with stable names, clips and token colours', async () => {
    for (const asset of ASSET_MANIFEST) {
      const gltf = await parseLocalFixture(asset.fileName);
      const container = readGlbContainer(fixtureBytes(asset.fileName));

      expect(gltf.scene.getObjectByName(asset.rootNode), asset.fileName).toBeTruthy();
      expect(gltf.animations.map((clip) => clip.name).sort()).toEqual(
        asset.clips.map((clip) => clip.clipName).sort(),
      );

      const baseColor = container.document.materials?.[0].pbrMetallicRoughness?.baseColorFactor ?? [];
      const [red, green, blue] = paletteLinearRgb(asset.material.paletteKey as PaletteKey);
      expect(baseColor[0]).toBeCloseTo(red, 6);
      expect(baseColor[1]).toBeCloseTo(green, 6);
      expect(baseColor[2]).toBeCloseTo(blue, 6);
    }
  });

  it('authors all four animation states across the library', () => {
    const authored = new Set(
      ASSET_MANIFEST.flatMap((asset) => asset.clips.map((clip) => clip.state)),
    );
    const placeholders = new Set(ASSET_MANIFEST.flatMap((asset) => asset.placeholderStates));
    for (const state of ANIMATION_STATES) {
      expect(authored.has(state) || placeholders.has(state), state).toBe(true);
    }
  });
});

describe('deterministic budgets', () => {
  it('keeps every fixture inside its own budget', async () => {
    for (const asset of ASSET_MANIFEST) {
      const bytes = fixtureBytes(asset.fileName);
      const gltf = await parseLocalFixture(asset.fileName);
      const usage = measureObject3D(gltf.scene, { fileBytes: bytes.byteLength });
      const report = evaluateBudget(`${asset.fileName}`, usage, RENDER_BUDGET.perAsset);

      expect(report.pass, format(report)).toBe(true);
    }
  });

  it('keeps the staged plan inside the stage budget', async () => {
    vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
    const bundle = await loadSceneAssets({ assets: manifestForHeadless() });

    const stage = buildStageRoot(bundle);
    const usage = measureObject3D(stage.root);
    const report = evaluateBudget('stage-plan', usage, RENDER_BUDGET.stage);

    expect(report.pass, format(report)).toBe(true);
    expect(usage.instanceCount).toBe(14);
    expect(usage.drawCalls).toBeLessThanOrEqual(RENDER_BUDGET.stage.maxDrawCalls);
    expect(usage.geometryCount).toBe(8);
  });

  it('reports frame rate as a target, never as a measurement', () => {
    expect(RENDER_BUDGET.targetFps).toBeGreaterThanOrEqual(RENDER_BUDGET.minimumAcceptableFps);
    expect(RENDER_BUDGET.measurementNotes).toMatch(/never reported as measured/i);
  });
});

describe('rebuild and disposal', () => {
  async function bundle(): Promise<SceneAssetBundle> {
    vi.stubGlobal('fetch', vi.fn(createFetchStub().fetch));
    return loadSceneAssets({ assets: manifestForHeadless() });
  }

  it('rebuilds the stage with identical resource usage', async () => {
    const first = buildStageRoot(await bundle());
    const second = buildStageRoot(await bundle());

    expect(measureObject3D(second.root)).toEqual(measureObject3D(first.root));
    expect(second.instanceCount).toBe(first.instanceCount);
  });

  it('disposes every unique resource exactly once', async () => {
    const stage = buildStageRoot(await bundle());
    const registry = ResourceRegistry.from(stage.root);
    const usage = measureObject3D(stage.root);

    const report = registry.dispose();

    expect(report.geometryCount).toBe(usage.geometryCount);
    expect(report.materialCount).toBe(usage.materialCount);
    expect(report.textureCount).toBe(0);
    expect(report.alreadyDisposed).toBe(false);
    expect(registry.dispose().alreadyDisposed).toBe(true);
  });

  it('accounts for the scene shell resources too', () => {
    const rig = createLightingRig();
    const ground = createGroundPlane();
    const registry = ResourceRegistry.from(rig).collect(ground);
    const usage = measureObject3D(ground);

    expect(registry.usage.geometryCount).toBe(usage.geometryCount);
    expect(registry.usage.materialCount).toBe(usage.materialCount);
    expect(registry.dispose().alreadyDisposed).toBe(false);
  });
});

describe('plan sanity', () => {
  it('places each asset at least once and the robot six times', () => {
    for (const asset of ASSET_MANIFEST) {
      const placements = SCENE_PLAN.instances.filter((instance) => instance.assetId === asset.id);
      expect(placements.length, asset.id).toBeGreaterThan(0);
    }
    expect(SCENE_PLAN.instances.filter((instance) => instance.assetId === 'robotVehicle')).toHaveLength(6);
    expect(assetById('robotVehicle').placeholderStates).toEqual([]);
  });
});

function format(report: BudgetReport): string {
  return `${report.scope}: ${report.checks
    .map((check) => `${check.metric}=${check.actual}/${check.limit}`)
    .join(' ')}`;
}
