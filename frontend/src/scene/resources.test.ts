import { describe, expect, it, vi } from 'vitest';

import { manifestForHeadless, parseLocalFixture } from './local-fixtures';
import { ResourceRegistry, disposeScene, instantiateShared } from './resources';
import { assetById } from './assets';

async function robotScene() {
  const asset = assetById('robotVehicle');
  const gltf = await parseLocalFixture(asset.fileName);
  return { asset, scene: gltf.scene };
}

describe('shared instances', () => {
  it('never duplicates the fixture geometry, material or textures', async () => {
    const { scene } = await robotScene();
    const copies = Array.from({ length: 6 }, () => instantiateShared(scene));

    const registry = new ResourceRegistry();
    for (const copy of copies) registry.collect(copy);

    expect(copies).toHaveLength(6);
    expect(registry.usage).toEqual({ geometryCount: 1, materialCount: 1, textureCount: 0 });

    const geometries = new Set<string>();
    const materials = new Set<string>();
    for (const copy of copies) {
      copy.traverse((object) => {
        const mesh = object as { isMesh?: boolean; geometry?: { uuid: string }; material?: { uuid: string } };
        if (!mesh.isMesh || !mesh.geometry || !mesh.material) return;
        geometries.add(mesh.geometry.uuid);
        materials.add(mesh.material.uuid);
      });
    }
    expect(geometries.size).toBe(1);
    expect(materials.size).toBe(1);
  });
});

describe('ResourceRegistry', () => {
  it('disposes every unique resource exactly once', async () => {
    const { scene } = await robotScene();
    const registry = new ResourceRegistry();
    for (let index = 0; index < 6; index += 1) registry.collect(instantiateShared(scene));

    const geometryDispose = vi.fn();
    const materialDispose = vi.fn();
    for (const geometry of registry.uniqueGeometries) {
      geometry.addEventListener('dispose', geometryDispose);
    }
    for (const material of registry.uniqueMaterials) {
      material.addEventListener('dispose', materialDispose);
    }

    const report = registry.dispose();

    expect(report).toEqual({
      geometryCount: 1,
      materialCount: 1,
      textureCount: 0,
      alreadyDisposed: false,
    });
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(registry.isDisposed).toBe(true);
  });

  it('is idempotent and refuses to collect after disposal', async () => {
    const { scene } = await robotScene();
    const registry = ResourceRegistry.from(scene);
    registry.dispose();

    const second = registry.dispose();
    expect(second.alreadyDisposed).toBe(true);
    expect(second.geometryCount).toBe(1);
    expect(() => registry.collect(scene)).toThrowError(/after disposal/);
  });
});

describe('disposeScene', () => {
  it('releases resources and empties the graph', async () => {
    const { scene } = await robotScene();
    const copy = instantiateShared(scene);

    const report = disposeScene(copy);

    expect(report.geometryCount).toBeGreaterThan(0);
    expect(copy.children).toHaveLength(0);
  });

  it('works with a manifest that points at the headless origin', () => {
    expect(manifestForHeadless()[0].url.startsWith('http://fixture.local/')).toBe(true);
  });
});
