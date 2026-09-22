import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ICON_TOKENS,
  LIGHTING,
  MOTION_TOKENS,
  PALETTE,
  SPACING,
  STATUS_COLORS,
  TYPOGRAPHY,
  ambientLampToken,
  applyCssTokens,
  cssTokenVariables,
  lampToken,
  paletteLinearRgb,
  srgbHexToLinearRgb,
} from './design-tokens';

const HEX = /^#[0-9a-f]{6}$/;

describe('palette and status tokens', () => {
  it('declares every colour as a lowercase hex token', () => {
    expect(Object.keys(PALETTE).length).toBeGreaterThan(8);
    expect(Object.values(PALETTE).every((value) => HEX.test(value))).toBe(true);
    expect(Object.values(STATUS_COLORS).every((value) => HEX.test(value))).toBe(true);
  });

  it('covers the states the interface has to show', () => {
    for (const key of ['idle', 'loading', 'ready', 'degraded', 'error'] as const) {
      expect(STATUS_COLORS[key], key).toMatch(HEX);
    }
    expect(STATUS_COLORS.ready).not.toBe(STATUS_COLORS.error);
  });

  it('keeps typography, spacing, lighting, icons and motion complete', () => {
    expect(TYPOGRAPHY.familyStack.length).toBeGreaterThan(0);
    expect(TYPOGRAPHY.sizes.body).toBeGreaterThan(TYPOGRAPHY.sizes.label);
    expect(SPACING.unit).toBeGreaterThan(0);
    expect(SPACING.sm).toBeLessThan(SPACING.lg);
    expect(LIGHTING.ambient.intensity).toBeGreaterThan(0);
    expect(LIGHTING.key.position).toHaveLength(3);
    expect(ICON_TOKENS.strokeWidth).toBeGreaterThan(0);
    expect(Object.keys(ICON_TOKENS.names).length).toBeGreaterThan(3);
    for (const state of ['idle', 'move', 'grab', 'deploy'] as const) {
      expect(MOTION_TOKENS.states[state].duration).toBeGreaterThan(0);
    }
    expect(MOTION_TOKENS.duration.fast).toBeLessThan(MOTION_TOKENS.duration.base);
  });
});

describe('colour conversion', () => {
  it('matches the sRGB transfer function used by the fixture generator', () => {
    expect(srgbHexToLinearRgb('#000000')).toEqual([0, 0, 0]);
    expect(srgbHexToLinearRgb('#ffffff')).toEqual([1, 1, 1]);
    const [red] = srgbHexToLinearRgb(PALETTE.accent);
    expect(red).toBeCloseTo(0.871367, 6);
  });

  it('resolves a palette key and rejects a malformed token', () => {
    expect(paletteLinearRgb('robotShell')).toEqual(srgbHexToLinearRgb(PALETTE.robotShell));
    expect(() => srgbHexToLinearRgb('amber')).toThrowError(/rrggbb/);
  });

  it('exposes three component light tokens', () => {
    const key = lampToken('key');
    expect(key.position).toHaveLength(3);
    expect(key.intensity).toBe(LIGHTING.key.intensity);
    expect(ambientLampToken().intensity).toBe(LIGHTING.ambient.intensity);
  });
});

describe('css variables', () => {
  it('exports every palette and status token with the rr prefix', () => {
    const variables = cssTokenVariables();
    for (const key of Object.keys(PALETTE)) {
      const name = `--rr-color-${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
      expect(variables[name], name).toBe((PALETTE as Record<string, string>)[key]);
    }
    expect(
      Object.keys(variables).filter((name) => name.startsWith('--rr-status-')),
    ).toHaveLength(Object.keys(STATUS_COLORS).length);
    expect(Object.values(variables).every((value) => value.length > 0)).toBe(true);
  });

  it('applies the tokens to a root element and tolerates a missing DOM', () => {
    const applied = new Map<string, string>();
    const target = {
      style: { setProperty: (name: string, value: string) => applied.set(name, value) },
    } as unknown as HTMLElement;

    applyCssTokens(target);

    expect(applied.get('--rr-color-accent')).toBe(PALETTE.accent);
    expect(applied.get('--rr-status-ready')).toBe(STATUS_COLORS.ready);
    expect(applied.get('--rr-font-family')).toBe(TYPOGRAPHY.familyStack);
    expect(() => applyCssTokens(undefined)).not.toThrow();
  });

  it('is consumed by the stylesheet', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toContain('var(--rr-color-surface,');
    expect(css).toContain('var(--rr-status-degraded,');
  });
});
