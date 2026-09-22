/**
 * Animation clip resolution and playback for the Phase 2 fixtures.
 *
 * Authored clips come from the GLB. When a fixture has no authored clip for a state,
 * a deterministic procedural placeholder is built instead and flagged as not authored,
 * so a missing animation is visible instead of silently ignored.
 */

import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import type { AnimationAction, Object3D } from 'three';

import {
  animationStateDurationSeconds,
  animationStateLoops,
  type AnimationState,
} from './animation-states';
import type { AssetDefinition, AssetId } from './assets';

export interface ResolvedClip {
  state: AnimationState;
  clipName: string;
  clip: AnimationClip;
  authored: boolean;
}

export interface AssetWithClips {
  asset: AssetDefinition;
  scene: Object3D;
  clips: readonly ResolvedClip[];
}

function quaternionTrack(
  targetObjectName: string,
  times: readonly number[],
  angles: readonly { axis: Vector3; radians: number }[],
): QuaternionKeyframeTrack {
  const values: number[] = [];
  for (const entry of angles) {
    const quaternion = new Quaternion().setFromAxisAngle(entry.axis, entry.radians);
    values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }
  return new QuaternionKeyframeTrack(`${targetObjectName}.quaternion`, [...times], values);
}

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * Deterministic stand-in for a fixture without authored art. It depends only on the
 * state, the target name and the duration, so the same input always produces the same
 * clip on every machine.
 */
export function createPlaceholderClip(
  state: AnimationState,
  targetObjectName: string,
  clipName: string = state,
  durationSeconds: number = animationStateDurationSeconds(state),
): AnimationClip {
  switch (state) {
    case 'idle': {
      const track = new VectorKeyframeTrack(
        `${targetObjectName}.position`,
        [0, durationSeconds / 2, durationSeconds],
        [0, 0, 0, 0, 0.02, 0, 0, 0, 0],
      );
      return new AnimationClip(clipName, durationSeconds, [track]);
    }
    case 'move': {
      return new AnimationClip(clipName, durationSeconds, [
        quaternionTrack(
          targetObjectName,
          [0, durationSeconds / 2, durationSeconds],
          [
            { axis: AXIS_Y, radians: 0 },
            { axis: AXIS_Y, radians: Math.PI },
            { axis: AXIS_Y, radians: Math.PI * 2 },
          ],
        ),
      ]);
    }
    case 'grab': {
      return new AnimationClip(clipName, durationSeconds, [
        quaternionTrack(
          targetObjectName,
          [0, durationSeconds / 2, durationSeconds],
          [
            { axis: AXIS_X, radians: 0 },
            { axis: AXIS_X, radians: -0.3 },
            { axis: AXIS_X, radians: 0 },
          ],
        ),
      ]);
    }
    case 'deploy': {
      return new AnimationClip(clipName, durationSeconds, [
        quaternionTrack(
          targetObjectName,
          [0, durationSeconds],
          [
            { axis: AXIS_Z, radians: -1.25 },
            { axis: AXIS_Z, radians: 0 },
          ],
        ),
      ]);
    }
    default: {
      return new AnimationClip(clipName, durationSeconds, []);
    }
  }
}

export function resolveAssetClips(
  asset: AssetDefinition,
  scene: Object3D,
  animations: readonly AnimationClip[],
): ResolvedClip[] {
  const target = scene.getObjectByName(asset.rootNode) ?? scene;
  const declared: ResolvedClip[] = asset.clips.map((definition) => {
    const fromGlb = animations.find((clip) => clip.name === definition.clipName);
    if (fromGlb) {
      return {
        state: definition.state,
        clipName: definition.clipName,
        clip: fromGlb,
        authored: true,
      };
    }
    return {
      state: definition.state,
      clipName: definition.clipName,
      clip: createPlaceholderClip(
        definition.state,
        target.name || asset.rootNode,
        definition.clipName,
        definition.durationSeconds,
      ),
      authored: false,
    };
  });
  const placeholders: ResolvedClip[] = asset.placeholderStates.map((state) => ({
    state,
    clipName: state,
    clip: createPlaceholderClip(state, target.name || asset.rootNode, state),
    authored: false,
  }));
  return [...declared, ...placeholders];
}

export interface ClipPlaybackEntry {
  assetId: AssetId;
  clipName: string;
  authored: boolean;
}

export interface AnimationPlayback {
  state: AnimationState;
  entries: readonly ClipPlaybackEntry[];
}

export interface AnimationDirector {
  readonly current: AnimationPlayback | null;
  /** One mixer per animated instance, keyed by `<assetId>#<instanceIndex>`. */
  readonly mixers: ReadonlyMap<string, AnimationMixer>;
  play(state: AnimationState): AnimationPlayback;
  update(deltaSeconds: number): void;
  stop(): void;
}

export interface AnimationDirectorOptions {
  fadeSeconds?: number;
}

export function createAnimationDirector(
  sources: readonly AssetWithClips[],
  options: AnimationDirectorOptions = {},
): AnimationDirector {
  const fadeSeconds = options.fadeSeconds ?? 0.15;
  const mixers = new Map<string, AnimationMixer>();
  const actors: {
    assetId: AssetId;
    actions: Map<AnimationState, { action: AnimationAction; clipName: string; authored: boolean }>;
  }[] = [];
  let current: AnimationPlayback | null = null;

  sources.forEach((source, index) => {
    const key = `${source.asset.id}#${index}`;
    const mixer = new AnimationMixer(source.scene);
    const perState = new Map<
      AnimationState,
      { action: AnimationAction; clipName: string; authored: boolean }
    >();
    for (const resolved of source.clips) {
      const action = mixer.clipAction(resolved.clip);
      const loops = animationStateLoops(resolved.state);
      action.setLoop(loops ? LoopRepeat : LoopOnce, loops ? Infinity : 1);
      action.clampWhenFinished = !loops;
      perState.set(resolved.state, {
        action,
        clipName: resolved.clipName,
        authored: resolved.authored,
      });
    }
    mixers.set(key, mixer);
    actors.push({ assetId: source.asset.id, actions: perState });
  });

  return {
    get current() {
      return current;
    },
    get mixers() {
      return mixers;
    },
    play(state) {
      const entries: ClipPlaybackEntry[] = [];
      for (const actor of actors) {
        const chosen = actor.actions.get(state);
        for (const candidate of actor.actions.values()) {
          if (candidate.action !== chosen?.action && candidate.action.isRunning()) {
            candidate.action.fadeOut(fadeSeconds);
          }
        }
        if (!chosen) continue;
        chosen.action.reset();
        chosen.action.fadeIn(fadeSeconds);
        chosen.action.play();
        entries.push({
          assetId: actor.assetId,
          clipName: chosen.clipName,
          authored: chosen.authored,
        });
      }
      current = { state, entries };
      return current;
    },
    update(deltaSeconds) {
      for (const mixer of mixers.values()) {
        mixer.update(deltaSeconds);
      }
    },
    stop() {
      for (const actor of actors) {
        for (const candidate of actor.actions.values()) {
          candidate.action.stop();
        }
      }
      current = null;
    },
  };
}
