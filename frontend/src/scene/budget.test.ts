import { BoxGeometry, DataTexture, Group, InstancedMesh, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RENDER_BUDGET } from './assets';
import {
  describeBudgetTargets,
  evaluateBudget,
  formatBudgetReport,
  geometryByteLength,
  measureObject3D,
  textureByteLength,
  type ResourceUsage,
} from './budget';

function emptyUsage(): ResourceUsage {
  return {
    triangles: 0,
    drawCalls: 0,
    textureCount: 0,
    textureBytes: 0,
    geometryCount: 0,
    materialCount: 0,
    instanceCount: 0,
    geometryBytes: 0,
    memoryProxyBytes: 0,
    fileBytes: 0,
  };
}

describe('measureObject3D', () => {
  it('measures triangles, draw calls and unique resources', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial();
    const root = new Group();
    root.add(new Mesh(geometry, material), new Mesh(geometry, material));

    const usage = measureObject3D(root);

    expect(usage.triangles).toBe(24);
    expect(usage.drawCalls).toBe(2);
    expect(usage.instanceCount).toBe(2);
    expect(usage.geometryCount).toBe(1);
    expect(usage.materialCount).toBe(1);
    expect(usage.geometryBytes).toBe(geometryByteLength(geometry));
    expect(usage.memoryProxyBytes).toBe(
      usage.geometryBytes + 2 * RENDER_BUDGET.memoryProxyBytesPerInstance,
    );
  });

  it('counts an instanced mesh as its instance count', () => {
    const root = new Group();
    root.add(new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 6));

    const usage = measureObject3D(root);

    expect(usage.instanceCount).toBe(6);
    expect(usage.drawCalls).toBe(1);
    expect(usage.triangles).toBe(72);
  });

  it('accounts for textures as documented bytes', () => {
    const texture = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    expect(textureByteLength(texture)).toBe(64);

    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ map: texture })));

    const usage = measureObject3D(root);
    expect(usage.textureCount).toBe(1);
    expect(usage.textureBytes).toBe(64);
  });

  it('reports the owning material count when materials differ', () => {
    const root = new Group();
    root.add(
      new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x111111 })),
      new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x222222 })),
    );

    const usage = measureObject3D(root);
    expect(usage.materialCount).toBe(2);
    expect(usage.geometryCount).toBe(2);
  });

  it('is deterministic for the same graph', () => {
    const build = () => {
      const root = new Object3D();
      root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
      return root;
    };
    expect(measureObject3D(build())).toEqual(measureObject3D(build()));
  });
});

describe('evaluateBudget', () => {
  it('passes when every measured value is inside the limits', () => {
    const usage: ResourceUsage = {
      ...emptyUsage(),
      triangles: 100,
      drawCalls: 2,
      memoryProxyBytes: 2048,
      fileBytes: 1024,
    };
    const report = evaluateBudget('fixture', usage, {
      maxTriangles: 1500,
      maxDrawCalls: 4,
      maxTextureCount: 2,
      maxTextureBytes: 131072,
      maxFileBytes: 262144,
    });

    expect(report.pass).toBe(true);
    expect(report.checks.every((entry) => entry.pass)).toBe(true);
    expect(report.checks.map((entry) => entry.metric)).toContain('fileBytes');
  });

  it('fails with the offending metric named', () => {
    const usage: ResourceUsage = {
      ...emptyUsage(),
      triangles: 20000,
      drawCalls: 40,
      instanceCount: 64,
    };
    const report = evaluateBudget('stage', usage, RENDER_BUDGET.stage);

    expect(report.pass).toBe(false);
    const failed = report.checks.filter((entry) => !entry.pass).map((entry) => entry.metric);
    expect(failed).toContain('drawCalls');
    expect(failed).toContain('instanceCount');
    expect(formatBudgetReport(report).join('\n')).toMatch(/FAIL/);
  });

  it('reports frame rate targets as budgets, not as measurements', () => {
    const targets = describeBudgetTargets();
    expect(targets.targetFps).toBe(RENDER_BUDGET.targetFps);
    expect(targets.measured).toBe(false);
    expect(targets.note.length).toBeGreaterThan(0);
  });
});
