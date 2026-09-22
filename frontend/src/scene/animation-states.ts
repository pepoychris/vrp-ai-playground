/**
 * The stable animation vocabulary shared by the fixtures, the runtime and the UI.
 *
 * This module deliberately has no Three.js import: the readiness panel and the asset
 * contract can name a state without pulling the renderer into the first paint.
 */

import { MOTION_TOKENS } from './design-tokens';

export const ANIMATION_STATES = ['idle', 'move', 'grab', 'deploy'] as const;

export type AnimationState = (typeof ANIMATION_STATES)[number];

export const ANIMATION_STATE_LABELS: Record<AnimationState, string> = {
  idle: 'Idle',
  move: 'Movement',
  grab: 'Grab',
  deploy: 'Barrier deployment',
};

export const ANIMATION_STATE_DESCRIPTIONS: Record<AnimationState, string> = {
  idle: 'Waiting robot: a small suspension bob, looped.',
  move: 'Travelling robot: forward motion, looped.',
  grab: 'Claw closing on a parcel, played once.',
  deploy: 'Barrier arm rising into the blocking position, played once.',
};

/**
 * Fixtures that carry no authored clip still need the same four states, so the runtime
 * builds a deterministic placeholder clip from the state name. The placeholder is a
 * stand-in for authored art, never a silent no-op.
 */
export const PLACEHOLDER_CLIP_POLICY =
  'A state without an authored clip receives a deterministic procedural clip built from the state name; it is marked as not authored in the bundle and in the UI.';

export function isAnimationState(value: string): value is AnimationState {
  return (ANIMATION_STATES as readonly string[]).includes(value);
}

export function animationStateDurationSeconds(state: AnimationState): number {
  return MOTION_TOKENS.states[state].duration / 1000;
}

export function animationStateLoops(state: AnimationState): boolean {
  return MOTION_TOKENS.states[state].loop;
}

/** Cross-check helper used by the contract tests. */
export function findUnknownAnimationStates(values: readonly string[]): string[] {
  return values.filter((value) => !isAnimationState(value));
}
