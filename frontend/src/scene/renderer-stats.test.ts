import { describe, expect, it } from 'vitest';

import {
  describeRendererDetail,
  describeRendererStats,
  readRendererStats,
  type RendererStats,
} from './renderer-stats';

const STATS: RendererStats = {
  drawCalls: 34,
  triangles: 21300,
  geometries: 12,
  textures: 5,
  programs: 3,
  pixelRatio: 1.5,
  contextName: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)',
};

describe('readRendererStats', () => {
  it('reads the numbers Three.js exposes on renderer.info', () => {
    const stats = readRendererStats({
      info: {
        render: { calls: 34, triangles: 21300 },
        memory: { geometries: 12, textures: 5 },
        programs: [{}, {}, {}],
      },
      getPixelRatio: () => 1.5,
      getContext: () => ({
        getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
        getParameter: () => 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)',
      }),
    });

    expect(stats).toMatchObject({
      drawCalls: 34,
      triangles: 21300,
      geometries: 12,
      textures: 5,
      programs: 3,
      pixelRatio: 1.5,
      contextName: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)',
    });
  });

  it('answers null for a renderer without info, so nothing is invented', () => {
    expect(readRendererStats(null)).toBeNull();
    expect(readRendererStats(undefined)).toBeNull();
    expect(readRendererStats({})).toBeNull();
    expect(readRendererStats({ info: {} })).toBeNull();
  });

  it('survives a hostile counter or a failing getter', () => {
    const stats = readRendererStats({
      info: { render: { calls: -3, triangles: Number.NaN }, memory: { textures: 2 } },
      getPixelRatio: () => {
        throw new Error('context lost');
      },
      getContext: () => {
        throw new Error('context lost');
      },
    });

    expect(stats).toMatchObject({ drawCalls: 0, triangles: 0, textures: 2, pixelRatio: 1 });
    expect(stats?.contextName).toBeNull();
  });
});

describe('renderer telemetry copy', () => {
  it('reports the compact measurement and omits the fps when nothing is animating', () => {
    expect(describeRendererStats(STATS, 60)).toBe('60 fps · 34 draw calls · 21.3k triangles · 1.5x DPR');
    expect(describeRendererStats(STATS, null)).toBe('34 draw calls · 21.3k triangles · 1.5x DPR');
    expect(describeRendererStats(STATS, 0)).toBe('34 draw calls · 21.3k triangles · 1.5x DPR');
  });

  it('says nothing at all when the renderer could not be measured', () => {
    expect(describeRendererStats(null, 60)).toBeNull();
    expect(describeRendererDetail(null, 60)).toBeNull();
  });

  it('names the source of every number in the tooltip', () => {
    const detail = describeRendererDetail(STATS, 59.94);

    expect(detail).toContain('renderer.info');
    expect(detail).toContain('34 draw calls');
    expect(detail).toContain('12 geometries');
    expect(detail).toContain('59.9 fps while the simulation is animating');
    expect(detail).toContain('ANGLE (Intel');
  });
});
