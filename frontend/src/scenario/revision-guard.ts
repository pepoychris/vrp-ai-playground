/**
 * The frozen stale-result rules of the Phase 0 contract, as pure functions.
 *
 * 1. Keep the highest applied revision per scenario; a payload with a lower revision is
 *    discarded, and at an equal revision the last payload received wins.
 * 2. Keep the highest applied tick inside the current revision; a simulation event whose
 *    tick is not newer is discarded.
 * 3. A direct command response is applied only when its `commandId` is the pending one.
 *
 * A discarded payload is never an error: it is the expected outcome of a lost race.
 */

import type { ScenarioSnapshot } from './scenario';

export type DiscardReason =
  | 'STALE_REVISION'
  | 'STALE_TICK'
  | 'UNKNOWN_COMMAND'
  | 'OTHER_SCENARIO';

export type GuardDecision =
  | { accepted: true; state: RevisionGuardState }
  | { accepted: false; reason: DiscardReason; state: RevisionGuardState };

export interface RevisionGuardState {
  scenarioId: string | null;
  scenarioRevision: number;
  /** Revision the current tick counter belongs to. */
  simulationRevision: number;
  maxAppliedTick: number;
  pendingCommandId: string | null;
}

export interface TickPayload {
  scenarioRevision: number;
  tick: number;
}

export function createRevisionGuard(): RevisionGuardState {
  return {
    scenarioId: null,
    scenarioRevision: -1,
    simulationRevision: -1,
    maxAppliedTick: -1,
    pendingCommandId: null,
  };
}

export function beginCommand(
  state: RevisionGuardState,
  commandId: string,
): RevisionGuardState {
  return { ...state, pendingCommandId: commandId };
}

function acceptRevision(
  state: RevisionGuardState,
  snapshot: ScenarioSnapshot,
): GuardDecision {
  if (state.scenarioId !== null && state.scenarioId !== snapshot.scenarioId) {
    // A different scenario starts its own timeline instead of being compared with the
    // previous one.
    return {
      accepted: true,
      state: {
        ...state,
        scenarioId: snapshot.scenarioId,
        scenarioRevision: snapshot.scenarioRevision,
        simulationRevision: snapshot.scenarioRevision,
        maxAppliedTick: snapshot.simulation.tick,
      },
    };
  }
  if (snapshot.scenarioRevision < state.scenarioRevision) {
    return { accepted: false, reason: 'STALE_REVISION', state };
  }
  return {
    accepted: true,
    state: {
      ...state,
      scenarioId: snapshot.scenarioId,
      scenarioRevision: snapshot.scenarioRevision,
      simulationRevision: snapshot.scenarioRevision,
      // At an equal revision the last payload wins, and its clock is the new baseline.
      maxAppliedTick:
        snapshot.scenarioRevision === state.scenarioRevision
          ? Math.max(state.maxAppliedTick, snapshot.simulation.tick)
          : snapshot.simulation.tick,
    },
  };
}

/** Apply rules 1 and 3 to a direct command response. */
export function acceptCommandResponse(
  state: RevisionGuardState,
  snapshot: ScenarioSnapshot,
  expectedCommandId: string | null,
): GuardDecision {
  if (
    expectedCommandId !== null &&
    state.pendingCommandId !== null &&
    state.pendingCommandId !== expectedCommandId
  ) {
    return { accepted: false, reason: 'UNKNOWN_COMMAND', state };
  }
  return acceptRevision(state, snapshot);
}

/** Apply rule 1 to a payload that is not the answer to a command (a refresh, say). */
export function acceptSnapshot(
  state: RevisionGuardState,
  snapshot: ScenarioSnapshot,
): GuardDecision {
  return acceptRevision(state, snapshot);
}

/** Apply rule 2 to one simulation tick. */
export function acceptTick(state: RevisionGuardState, payload: TickPayload): GuardDecision {
  if (payload.scenarioRevision !== state.simulationRevision) {
    return { accepted: false, reason: 'STALE_REVISION', state };
  }
  if (payload.tick <= state.maxAppliedTick) {
    return { accepted: false, reason: 'STALE_TICK', state };
  }
  return {
    accepted: true,
    state: { ...state, maxAppliedTick: payload.tick },
  };
}

export function clearPendingCommand(state: RevisionGuardState): RevisionGuardState {
  return { ...state, pendingCommandId: null };
}

/** Clear the pending command only when it is still the one that just answered. */
export function settleCommand(
  state: RevisionGuardState,
  commandId: string | null,
): RevisionGuardState {
  if (commandId === null || state.pendingCommandId !== commandId) return state;
  return { ...state, pendingCommandId: null };
}
