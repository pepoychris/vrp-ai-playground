import { AnimationMixer, Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { createAnimationDirector, createPlaceholderClip } from './animation-clips';
import {
  ANIMATION_STATES,
  ANIMATION_STATE_DESCRIPTIONS,
  ANIMATION_STATE_LABELS,
  animationStateDurationSeconds,
  animationStateLoops,
  findUnknownAnimationStates,
  isAnimationState,
} from './animation-states';
import { assetById } from './assets';

describe('animation vocabulary', () => {
  it('names the four states the MVP asks for', () => {
    expect([...ANIMATION_STATES]).toEqual(['idle', 'move', 'grab', 'deploy']);
  });

  it('labels and describes every state', () => {
    for (const state of ANIMATION_STATES) {
      expect(ANIMATION_STATE_LABELS[state].length).toBeGreaterThan(0);
      expect(ANIMATION_STATE_DESCRIPTIONS[state].length).toBeGreaterThan(0);
      expect(isAnimationState(state)).toBe(true);
    }
    expect(isAnimationState('walk')).toBe(false);
    expect(findUnknownAnimationStates(['idle', 'walk'])).toEqual(['walk']);
  });

  it('takes the duration and the loop flag from the motion tokens', () => {
    expect(animationStateDurationSeconds('idle')).toBeCloseTo(2, 6);
    expect(animationStateLoops('idle')).toBe(true);
    expect(animationStateLoops('move')).toBe(true);
    expect(animationStateLoops('grab')).toBe(false);
    expect(animationStateLoops('deploy')).toBe(false);
  });
});

describe('placeholder clips', () => {
  it('is deterministic for the same inputs', () => {
    const first = createPlaceholderClip('idle', 'DepotLandmark');
    const second = createPlaceholderClip('idle', 'DepotLandmark');

    expect(first.name).toBe('idle');
    expect(first.duration).toBe(second.duration);
    expect(first.tracks.map((track) => [...track.values])).toEqual(
      second.tracks.map((track) => [...track.values]),
    );
  });

  it('produces a distinct, non-empty track per state', () => {
    const signatures = ANIMATION_STATES.map((state) => {
      const clip = createPlaceholderClip(state, 'Fixture', state, 1);
      expect(clip.tracks.length).toBeGreaterThan(0);
      expect(clip.tracks[0].name).toContain('Fixture');
      expect(clip.duration).toBe(1);
      return JSON.stringify(clip.tracks[0].values);
    });

    expect(new Set(signatures).size).toBe(ANIMATION_STATES.length);
  });

  it('uses the clip name and duration it is given', () => {
    const clip = createPlaceholderClip('deploy', 'Barrier', 'deploy', 0.5);
    expect(clip.name).toBe('deploy');
    expect(clip.duration).toBe(0.5);
  });
});

describe('animation director', () => {
  it('plays the requested state and advances its mixers', () => {
    const target = new Object3D();
    target.name = 'Actor';
    const director = createAnimationDirector([
      {
        asset: assetById('robotVehicle'),
        scene: target,
        clips: [
          {
            state: 'idle',
            clipName: 'idle',
            clip: createPlaceholderClip('idle', 'Actor'),
            authored: false,
          },
          {
            state: 'move',
            clipName: 'move',
            clip: createPlaceholderClip('move', 'Actor'),
            authored: false,
          },
        ],
      },
    ]);

    const playback = director.play('move');
    expect(playback.state).toBe('move');
    expect(playback.entries).toEqual([
      { assetId: 'robotVehicle', clipName: 'move', authored: false },
    ]);
    const [mixer] = [...director.mixers.values()];
    expect(mixer).toBeInstanceOf(AnimationMixer);
    expect(() => director.update(0.2)).not.toThrow();

    director.stop();
    expect(director.current).toBeNull();
  });

  it('skips the states an asset does not declare', () => {
    const target = new Object3D();
    target.name = 'Actor';
    const director = createAnimationDirector([
      {
        asset: assetById('robotVehicle'),
        scene: target,
        clips: [
          {
            state: 'idle',
            clipName: 'idle',
            clip: createPlaceholderClip('idle', 'Actor'),
            authored: true,
          },
        ],
      },
    ]);

    expect(director.play('deploy').entries).toEqual([]);
    expect(director.play('idle').entries).toHaveLength(1);
  });
});
