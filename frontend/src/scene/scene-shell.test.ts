import { Mesh, PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { RENDER_BUDGET, SCENE_PLAN, type AssetId } from './assets';
import { measureObject3D } from './budget';
import {
  createFetchStub,
  installProgressEventShim,
  manifestForHeadless,
} from './local-fixtures';
import { loadSceneAssets, type SceneAssetBundle } from './load-assets';
import {
  WebGLUnavailableError,
  buildStageRoot,
  createGroundPlane,
  createLightingRig,
  createSceneShell,
  type RendererLike,
} from './scene-shell';

installProgressEventShim();

async function loadBundle(): Promise<SceneAssetBundle> {
  const stub = createFetchStub();
  vi.stubGlobal('fetch', vi.fn(stub.fetch));
  return loadSceneAssets({ assets: manifestForHeadless() });
}

function geometriesFor(bundleRoot: { traverse: (callback: (object: unknown) => void) => void }, assetId: AssetId) {
  const geometries = new Set<string>();
  bundleRoot.traverse((object) => {
    const mesh = object as Mesh & { parent?: { userData?: { assetId?: AssetId } } };
    if (!mesh.isMesh) return;
    const owner =
      (mesh.userData?.assetId as AssetId | undefined) ??
      (mesh.parent?.userData?.assetId as AssetId | undefined);
    if (owner === assetId) geometries.add(mesh.geometry.uuid);
  });
  return geometries;
}

describe('stage plan', () => {
  it('places every planned instance', async () => {
    const bundle = await loadBundle();

    const stage = buildStageRoot(bundle);

    expect(stage.instanceCount).toBe(SCENE_PLAN.instances.length);
    expect(stage.placementCount).toBe(SCENE_PLAN.instances.length);
    expect(stage.missingAssetIds).toEqual([]);
  });

  it('reports the missing assets instead of placing them', async () => {
    const bundle = await loadBundle();
    const withoutBarrier: SceneAssetBundle = {
      ...bundle,
      assets: new Map([...bundle.assets].filter(([id]) => id !== 'barrier')),
    };

    const stage = buildStageRoot(withoutBarrier);

    expect(stage.instanceCount).toBe(SCENE_PLAN.instances.length - 1);
    expect(stage.missingAssetIds).toEqual(['barrier']);
  });

  it('reuses one geometry for the six robot instances', async () => {
    const bundle = await loadBundle();
    const stage = buildStageRoot(bundle);

    const robotGeometries = geometriesFor(stage.root, 'robotVehicle');

    expect(robotGeometries.size).toBe(1);
  });
});

describe('lighting and ground', () => {
  it('builds the rig from the visual tokens', () => {
    const rig = createLightingRig();
    const names = rig.children.map((child) => child.name);

    expect(names).toEqual(['AmbientLight', 'KeyLight', 'FillLight', 'RimLight']);
  });

  it('lays a single ground plane for the stage', () => {
    const ground = createGroundPlane();

    expect(ground.name).toBe('GroundPlane');
    expect(ground.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    expect(ground.receiveShadow).toBe(false);
  });
});

describe('scene shell', () => {
  it('survives a missing WebGL context and explains why', () => {
    const shell = createSceneShell({ width: 640, height: 360 });

    expect(shell.renderer).toBeNull();
    expect(shell.rendererError).toMatch(/canvas|WebGL/i);
    expect(() => shell.render()).not.toThrow();
    shell.dispose();
  });

  it('reports the WebGL failure raised by an injected renderer factory', () => {
    const shell = createSceneShell({
      width: 640,
      height: 360,
      createRenderer: () => {
        throw new WebGLUnavailableError('no context in this environment');
      },
    });

    expect(shell.rendererError).toBe('no context in this environment');
    shell.dispose();
  });

  it('builds the fixture stage inside the deterministic budget', async () => {
    const bundle = await loadBundle();
    const shell = createSceneShell({ width: 640, height: 360 });

    const report = shell.buildStage(bundle);

    expect(report.instanceCount).toBe(SCENE_PLAN.instances.length);
    expect(report.usage.geometryCount).toBe(8);
    expect(report.usage.materialCount).toBe(5);
    expect(report.usage.textureCount).toBe(0);
    expect(report.usage.instanceCount).toBe(14);
    expect(report.budget.pass).toBe(true);
    expect(report.budget.checks.every((check) => check.actual <= check.limit)).toBe(true);
    expect(shell.lastBuild?.instanceCount).toBe(SCENE_PLAN.instances.length);
    shell.dispose();
  });

  it('plays animation states without a renderer', async () => {
    const bundle = await loadBundle();
    const shell = createSceneShell({ width: 640, height: 360 });
    shell.buildStage(bundle);

    const move = shell.playState('move');
    expect(move.state).toBe('move');
    expect(move.entries).toHaveLength(6);
    expect(move.entries.every((entry) => entry.clipName === 'move' && entry.authored)).toBe(true);

    const deploy = shell.playState('deploy');
    expect(deploy.entries.map((entry) => entry.assetId)).toEqual(['barrier']);
    expect(() => shell.tick(0.25)).not.toThrow();
    shell.dispose();
  });

  it('keeps a camera aspect ratio on resize', async () => {
    const shell = createSceneShell({ width: 640, height: 360 });
    shell.resize(800, 400);

    const camera = shell.camera as PerspectiveCamera;
    expect(camera.aspect).toBeCloseTo(2, 6);
    shell.dispose();
  });

  it('disposes the shared resources it owns', async () => {
    const bundle = await loadBundle();
    const shell = createSceneShell({ width: 640, height: 360 });
    shell.buildStage(bundle);

    const report = shell.dispose();

    expect(report.alreadyDisposed).toBe(false);
    expect(report.geometryCount).toBeGreaterThanOrEqual(8);
    expect(report.materialCount).toBeGreaterThanOrEqual(5);
    expect(shell.scene.children).toHaveLength(0);
  });

  it('rebuilds identically on a fresh shell', async () => {
    const bundle = await loadBundle();
    const first = createSceneShell({ width: 640, height: 360 });
    const firstReport = first.buildStage(bundle);
    first.dispose();

    const second = createSceneShell({ width: 640, height: 360 });
    const secondReport = second.buildStage(bundle);
    second.dispose();

    expect(secondReport.usage).toEqual(firstReport.usage);
    expect(secondReport.budget.pass).toBe(true);
    expect(RENDER_BUDGET.stage.maxInstanceCount).toBeGreaterThanOrEqual(secondReport.usage.instanceCount);
  });

  it('exposes the measured stage when no renderer is available', async () => {
    const bundle = await loadBundle();
    const shell = createSceneShell({
      width: 640,
      height: 360,
      createRenderer: (): RendererLike => ({
        setSize: () => undefined,
        render: () => undefined,
        dispose: () => undefined,
      }),
    });
    const report = shell.buildStage(bundle);

    expect(shell.renderer).not.toBeNull();
    expect(measureObject3D(shell.stageRoot).drawCalls).toBe(report.usage.drawCalls);
    expect(() => {
      shell.render();
      shell.dispose();
    }).not.toThrow();
  });
});
