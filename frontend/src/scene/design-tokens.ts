/**
 * The single source of truth for the visual identity (MVP Phase 2).
 *
 * `visual-tokens.json` holds the raw values so that non-TypeScript tools (the fixture
 * generator and the asset benchmark) read exactly the same palette. This module gives
 * those values a typed surface for the frontend and can push them into CSS custom
 * properties, so `index.css` never has to repeat a colour by hand.
 */

import rawTokens from './visual-tokens.json';

export type PaletteKey = keyof typeof rawTokens.palette;
export type StatusColorKey = keyof typeof rawTokens.statusColors;
export type MotionStateKey = keyof typeof rawTokens.motion.states;
export type IconKey = keyof typeof rawTokens.icons.names;

export const VISUAL_TOKENS = rawTokens;
export const PALETTE = rawTokens.palette;
export const STATUS_COLORS = rawTokens.statusColors;
export const TYPOGRAPHY = rawTokens.typography;
export const SPACING = rawTokens.spacing;
export const LIGHTING = rawTokens.lighting;
export const ICON_TOKENS = rawTokens.icons;
export const MOTION_TOKENS = rawTokens.motion;

export interface LampToken {
  color: string;
  intensity: number;
  position: readonly [number, number, number];
}

export interface AmbientLampToken {
  color: string;
  intensity: number;
}

function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert an sRGB `#rrggbb` token to the linear RGB triple glTF and Three.js use for
 * material colours. Rounding matches the Python fixture generator exactly, which is
 * what lets the tests compare a fixture material against its token.
 */
export function srgbHexToLinearRgb(hex: string): [number, number, number] {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error(`expected a #rrggbb colour token, received ${hex}`);
  }
  return [0, 2, 4].map((index) => {
    const channel = Number.parseInt(raw.slice(index, index + 2), 16) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return Number(linear.toFixed(6));
  }) as [number, number, number];
}

/** Resolve a token key to its linear RGB triple, failing loudly on a typo. */
export function paletteLinearRgb(key: PaletteKey): [number, number, number] {
  const hex = PALETTE[key];
  if (typeof hex !== 'string') {
    throw new Error(`palette token ${key} is not a colour string`);
  }
  return srgbHexToLinearRgb(hex);
}

function asVector3(value: readonly number[], label: string): [number, number, number] {
  if (value.length !== 3) {
    throw new Error(`${label} must have three components, received ${value.length}`);
  }
  return [value[0], value[1], value[2]];
}

export function ambientLampToken(): AmbientLampToken {
  return { color: LIGHTING.ambient.color, intensity: LIGHTING.ambient.intensity };
}

export function lampToken(name: 'key' | 'fill' | 'rim'): LampToken {
  const lamp = LIGHTING[name];
  return {
    color: lamp.color,
    intensity: lamp.intensity,
    position: asVector3(lamp.position, `${name} light position`),
  };
}

/** CSS custom properties derived from the token file, for `:root`. */
export function cssTokenVariables(): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(PALETTE)) {
    variables[`--rr-color-${kebabCase(key)}`] = value as string;
  }
  for (const [key, value] of Object.entries(STATUS_COLORS)) {
    variables[`--rr-status-${kebabCase(key)}`] = value as string;
  }
  for (const [key, value] of Object.entries(SPACING)) {
    variables[`--rr-space-${kebabCase(key)}`] = typeof value === 'number' ? `${value}px` : String(value);
  }
  for (const [key, value] of Object.entries(MOTION_TOKENS.duration)) {
    variables[`--rr-motion-${kebabCase(key)}`] = `${value}ms`;
  }
  variables['--rr-easing-standard'] = MOTION_TOKENS.easing.standard;
  variables['--rr-easing-emphasis'] = MOTION_TOKENS.easing.emphasis;
  variables['--rr-font-family'] = TYPOGRAPHY.familyStack;
  variables['--rr-font-mono'] = TYPOGRAPHY.monoStack;
  variables['--rr-font-size-body'] = `${TYPOGRAPHY.sizes.body}px`;
  variables['--rr-font-size-heading'] = `${TYPOGRAPHY.sizes.heading}px`;
  variables['--rr-font-size-label'] = `${TYPOGRAPHY.sizes.label}px`;
  return variables;
}

/**
 * Push the tokens into CSS custom properties on the given root element. It is a no-op
 * without a DOM (server rendering and unit tests), which keeps the module importable
 * from any environment.
 */
export function applyCssTokens(
  target: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): Record<string, string> {
  const variables = cssTokenVariables();
  if (!target) {
    return variables;
  }
  for (const [name, value] of Object.entries(variables)) {
    target.style.setProperty(name, value);
  }
  return variables;
}
