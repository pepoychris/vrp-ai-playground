import { describe, expect, it } from 'vitest';

import { ANIMATION_STATES } from './animation-states';
import {
  ASSET_BASE_PATH,
  ASSET_CONTRACT_GENERATOR,
  ASSET_MANIFEST,
  RENDER_BUDGET,
  SCENE_PLAN,
  animationStatesFor,
  assetById,
  instanceCounts,
  placementsFor,
  validateAssetContract,
  type AssetDefinition,
} from './assets';

describe('asset manifest', () => {
  it('is internally consistent', () => {
    expect(validateAssetContract()).toEqual([]);
    expect(ASSET_CONTRACT_GENERATOR).toBe('roboroute-nexus-phase2-fixture-generator');
  });

  it('uses stable names and same-origin URLs only', () => {
    expect(ASSET_MANIFEST).toHaveLength(5);
    expect(ASSET_MANIFEST.map((asset) => asset.id)).toEqual([
      'robotVehicle',
      'robotClaw',
      'barrier',
      'depotLandmark',
      'buildingFixture',
    ]);
    for (const asset of ASSET_MANIFEST) {
      expect(asset.url).toBe(`${ASSET_BASE_PATH}/${asset.fileName}`);
      expect(asset.url).not.toMatch(/^[a-z]+:\/\//i);
      expect(asset.url.startsWith('/')).toBe(true);
      expect(asset.declaredNodes.length).toBeGreaterThan(0);
    }
  });

  it('covers every animation state across the library', () => {
    const states = new Set(
      ASSET_MANIFEST.flatMap((asset) => [
        ...asset.clips.map((clip) => clip.state),
        ...asset.placeholderStates,
      ]),
    );
    for (const state of ANIMATION_STATES) {
      expect(states.has(state), state).toBe(true);
    }
  });

  it('maps the authored clips the fixtures ship', () => {
    expect(animationStatesFor('robotVehicle')).toEqual(['idle', 'move']);
    expect(animationStatesFor('robotClaw')).toEqual(['grab']);
    expect(animationStatesFor('barrier')).toEqual(['deploy']);
    expect(animationStatesFor('depotLandmark')).toEqual([]);
    expect(assetById('depotLandmark').placeholderStates).toEqual(['idle']);
    expect(assetById('buildingFixture').placeholderStates).toEqual(['idle']);
  });

  it('rejects an unknown asset id', () => {
    expect(() => assetById('hovercraft' as never)).toThrowError(/unknown asset id/);
  });
});

describe('scene plan and budget', () => {
  it('stages only declared assets', () => {
    const known = new Set(ASSET_MANIFEST.map((asset) => asset.id));
    expect(SCENE_PLAN.instances.length).toBeGreaterThanOrEqual(6);
    for (const instance of SCENE_PLAN.instances) {
      expect(known.has(instance.assetId), instance.assetId).toBe(true);
      expect(instance.position).toHaveLength(3);
      expect(instance.scale).toBeGreaterThan(0);
    }
    expect(placementsFor('robotVehicle')).toHaveLength(6);
    const counts = instanceCounts();
    expect(Object.values(counts).reduce((total, value) => total + value, 0)).toBe(
      SCENE_PLAN.instances.length,
    );
    expect(counts.robotVehicle).toBe(6);
  });

  it('keeps the camera and ground inside the plan', () => {
    expect(SCENE_PLAN.groundRadius).toBeGreaterThan(0);
    expect(SCENE_PLAN.camera.near).toBeGreaterThan(0);
    expect(SCENE_PLAN.camera.far).toBeGreaterThan(SCENE_PLAN.camera.near);
    expect(SCENE_PLAN.camera.position).toHaveLength(3);
  });

  it('declares a target frame rate and a lower acceptance floor', () => {
    expect(RENDER_BUDGET.targetFps).toBe(60);
    expect(RENDER_BUDGET.minimumAcceptableFps).toBeLessThanOrEqual(RENDER_BUDGET.targetFps);
    expect(RENDER_BUDGET.perAsset.maxFileBytes).toBeGreaterThan(0);
    expect(RENDER_BUDGET.stage.maxMemoryProxyBytes).toBeGreaterThan(0);
    expect(RENDER_BUDGET.measurementNotes).toMatch(/host specific/i);
  });
});

describe('contract validation', () => {
  const base = ASSET_MANIFEST[0];

  function corrupt(patch: Partial<AssetDefinition>): string[] {
    return validateAssetContract([{ ...base, ...patch }, ...ASSET_MANIFEST.slice(1)]);
  }

  it('flags a duplicated asset', () => {
    expect(validateAssetContract([base, ...ASSET_MANIFEST])).toContain(
      `duplicate asset id ${base.id}`,
    );
  });

  it('flags an external or off-base URL', () => {
    expect(corrupt({ url: 'https://cdn.example.com/robot.glb' }).join(' ')).toMatch(
      /same-origin/,
    );
    expect(corrupt({ url: '/elsewhere/robot.glb' }).join(' ')).toMatch(/is not served from/);
  });

  it('flags an undeclared animation target', () => {
    const problems = corrupt({
      clips: [
        {
          state: 'idle',
          clipName: 'idle',
          durationSeconds: 1,
          channels: [{ node: 'Ghost', path: 'rotation', times: [0, 1], vectors: [[0, 0, 0], [0, 0, 0]] }],
        },
      ],
    });
    expect(problems.join(' ')).toMatch(/undeclared node Ghost/);
  });

  it('flags a state that is both authored and a placeholder', () => {
    const problems = corrupt({ placeholderStates: ['idle'] });
    expect(problems.join(' ')).toMatch(/both authored and a placeholder/);
  });
});
