/**
 * Explicit resource ownership for the Phase 2 scene.
 *
 * Fixture instances are clones that share geometry, materials and textures with the
 * loaded source. This module makes that sharing deliberate: a registry collects every
 * unique resource once, and disposal releases each of them exactly once no matter how
 * many copies are on screen.
 */

import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';

export interface ResourceUsageCounts {
  geometryCount: number;
  materialCount: number;
  textureCount: number;
}

export interface ResourceDisposalReport extends ResourceUsageCounts {
  alreadyDisposed: boolean;
}

function materialList(material: Material | Material[] | undefined): Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function texturesOf(material: Material): Texture[] {
  const textures: Texture[] = [];
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const candidate = value as Texture | undefined;
    if (candidate?.isTexture) {
      textures.push(candidate);
    }
  }
  return textures;
}

export class ResourceRegistry {
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials = new Map<string, Material>();
  private readonly textures = new Map<string, Texture>();
  private disposed = false;

  static from(root: Object3D): ResourceRegistry {
    return new ResourceRegistry().collect(root);
  }

  collect(root: Object3D): this {
    if (this.disposed) {
      throw new Error('cannot collect resources after disposal; build a new registry');
    }
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) {
        this.geometries.set(mesh.geometry.uuid, mesh.geometry);
      }
      for (const material of materialList(mesh.material)) {
        this.materials.set(material.uuid, material);
        for (const texture of texturesOf(material)) {
          this.textures.set(texture.uuid, texture);
        }
      }
    });
    return this;
  }

  get usage(): ResourceUsageCounts {
    return {
      geometryCount: this.geometries.size,
      materialCount: this.materials.size,
      textureCount: this.textures.size,
    };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get uniqueGeometries(): readonly BufferGeometry[] {
    return [...this.geometries.values()];
  }

  get uniqueMaterials(): readonly Material[] {
    return [...this.materials.values()];
  }

  get uniqueTextures(): readonly Texture[] {
    return [...this.textures.values()];
  }

  dispose(): ResourceDisposalReport {
    if (this.disposed) {
      return { ...this.usage, alreadyDisposed: true };
    }
    for (const geometry of this.geometries.values()) {
      geometry.dispose();
    }
    for (const material of this.materials.values()) {
      material.dispose();
    }
    for (const texture of this.textures.values()) {
      texture.dispose();
    }
    this.disposed = true;
    return { ...this.usage, alreadyDisposed: false };
  }
}

/**
 * Clone a loaded fixture without copying geometry, materials or textures. Three.js
 * `clone()` shares those by reference, which is the reuse rule the MVP asks for.
 */
export function instantiateShared<TSource extends Object3D>(source: TSource): TSource {
  return source.clone(true);
}

export function disposeScene(root: Object3D): ResourceDisposalReport {
  const registry = ResourceRegistry.from(root);
  const report = registry.dispose();
  root.remove(...root.children);
  return report;
}
