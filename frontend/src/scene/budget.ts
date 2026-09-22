/**
 * Deterministic renderer and resource budgets.
 *
 * The measurement runs on the scene graph, not on the GPU: it counts triangles, draw
 * calls, texture payload and a documented CPU-side memory proxy. Frames per second and
 * GPU memory are host specific and are never reported here as measured values; the
 * budget file only states the target the demo is designed for.
 */

import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';

import { RENDER_BUDGET, type AssetBudgetLimits, type StageBudgetLimits } from './assets';

export interface ResourceUsage {
  triangles: number;
  drawCalls: number;
  textureCount: number;
  textureBytes: number;
  geometryCount: number;
  materialCount: number;
  instanceCount: number;
  geometryBytes: number;
  memoryProxyBytes: number;
  /** Set only when the usage describes a file on disk (the fixture benchmark). */
  fileBytes: number;
}

export interface BudgetCheck {
  metric: string;
  actual: number;
  limit: number;
  pass: boolean;
}

export interface BudgetReport {
  scope: string;
  pass: boolean;
  usage: ResourceUsage;
  checks: readonly BudgetCheck[];
}

export interface MeasurementOptions {
  memoryProxyBytesPerInstance?: number;
  fileBytes?: number;
}

export function geometryByteLength(geometry: BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    const array = (attribute as { array?: ArrayLike<number> & { byteLength?: number } } | undefined)?.array;
    if (array?.byteLength) {
      bytes += array.byteLength;
    }
  }
  const index = geometry.getIndex();
  if (index?.array?.byteLength) {
    bytes += index.array.byteLength;
  }
  return bytes;
}

/**
 * Texture payload proxy. A real GPU upload is driver dependent, so this only reports
 * the bytes the CPU side can account for: the owned typed array when there is one,
 * otherwise four bytes per pixel for the decoded image.
 */
export function textureByteLength(texture: Texture): number {
  const image = texture.image as
    | { data?: { byteLength?: number }; width?: number; height?: number }
    | undefined;
  if (!image) return 0;
  if (image.data?.byteLength) return image.data.byteLength;
  if (image.width && image.height) return image.width * image.height * 4;
  return 0;
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

export function measureObject3D(root: Object3D, options: MeasurementOptions = {}): ResourceUsage {
  const perInstance = options.memoryProxyBytesPerInstance ?? RENDER_BUDGET.memoryProxyBytesPerInstance;
  const geometries = new Map<string, BufferGeometry>();
  const materials = new Map<string, Material>();
  const textures = new Map<string, Texture>();
  let triangles = 0;
  let drawCalls = 0;
  let instanceCount = 0;

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const instanced = mesh as Mesh & { isInstancedMesh?: boolean; count?: number };
    const instances = instanced.isInstancedMesh ? (instanced.count ?? 0) : 1;
    instanceCount += instances;
    const materialsForMesh = materialList(mesh.material);
    drawCalls += Math.max(materialsForMesh.length, 1);
    if (mesh.geometry) {
      geometries.set(mesh.geometry.uuid, mesh.geometry);
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      // An instanced mesh submits its geometry once per instance, so the rendered
      // triangle count scales with the instance count while the draw call does not.
      const perInstance = index ? index.count / 3 : position ? position.count / 3 : 0;
      triangles += perInstance * instances;
    }
    for (const material of materialsForMesh) {
      materials.set(material.uuid, material);
      for (const texture of texturesOf(material)) {
        textures.set(texture.uuid, texture);
      }
    }
  });

  let geometryBytes = 0;
  for (const geometry of geometries.values()) {
    geometryBytes += geometryByteLength(geometry);
  }
  let textureBytes = 0;
  for (const texture of textures.values()) {
    textureBytes += textureByteLength(texture);
  }

  return {
    triangles: Math.round(triangles),
    drawCalls,
    textureCount: textures.size,
    textureBytes,
    geometryCount: geometries.size,
    materialCount: materials.size,
    instanceCount,
    geometryBytes,
    memoryProxyBytes: geometryBytes + textureBytes + instanceCount * perInstance,
    fileBytes: options.fileBytes ?? 0,
  };
}

export function evaluateBudget(
  scope: string,
  usage: ResourceUsage,
  limits: AssetBudgetLimits | StageBudgetLimits,
): BudgetReport {
  const checks: BudgetCheck[] = [
    check('triangles', usage.triangles, limits.maxTriangles),
    check('drawCalls', usage.drawCalls, limits.maxDrawCalls),
    check('textureCount', usage.textureCount, limits.maxTextureCount),
    check('textureBytes', usage.textureBytes, limits.maxTextureBytes),
  ];
  if ('maxFileBytes' in limits) {
    checks.push(check('fileBytes', usage.fileBytes, limits.maxFileBytes));
  }
  if ('maxMemoryProxyBytes' in limits) {
    checks.push(check('memoryProxyBytes', usage.memoryProxyBytes, limits.maxMemoryProxyBytes));
    checks.push(check('instanceCount', usage.instanceCount, limits.maxInstanceCount));
  }
  return { scope, pass: checks.every((entry) => entry.pass), usage, checks };
}

function check(metric: string, actual: number, limit: number): BudgetCheck {
  return { metric, actual, limit, pass: actual <= limit };
}

export function formatBudgetReport(report: BudgetReport): string[] {
  const lines = [`${report.scope}: ${report.pass ? 'PASS' : 'FAIL'}`];
  for (const entry of report.checks) {
    lines.push(
      `  ${entry.pass ? 'PASS' : 'FAIL'} ${entry.metric} ${entry.actual} / ${entry.limit}`,
    );
  }
  return lines;
}

export function describeBudgetTargets(): {
  targetFps: number;
  minimumAcceptableFps: number;
  measured: false;
  note: string;
} {
  return {
    targetFps: RENDER_BUDGET.targetFps,
    minimumAcceptableFps: RENDER_BUDGET.minimumAcceptableFps,
    measured: false,
    note: RENDER_BUDGET.measurementNotes,
  };
}
