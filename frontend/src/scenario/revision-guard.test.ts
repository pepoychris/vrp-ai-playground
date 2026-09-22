import { describe, expect, it } from 'vitest';

import type { ScenarioSnapshot } from './scenario';
import {
  acceptAiAnswer,
  acceptCommandResponse,
  acceptSnapshot,
  acceptTick,
  beginCommand,
  createRevisionGuard,
  settleCommand,
  type GuardDecision,
} from './revision-guard';

function expectRejected(decision: GuardDecision): Extract<GuardDecision, { accepted: false }> {
  if (decision.accepted) throw new Error('expected the payload to be discarded');
  return decision;
}

function snapshot(
  scenarioRevision: number,
  tick = 0,
  commandId: string | null = null,
  scenarioId = 'scenario-1',
): ScenarioSnapshot {
  return {
    scenarioId,
    scenarioRevision,
    previousRevision: scenarioRevision - 1,
    status: 'RUNNING',
    seed: 1,
    graph: { cityId: 'robot-city', graphVersion: 1, nodes: [], edges: [] },
    vehicles: [],
    orders: [],
    barriers: [],
    blockedEdgeIds: [],
    routePlan: null,
    kpis: null,
    simulation: { running: true, speedMultiplier: 1, tick, elapsedSeconds: tick * 0.5 },
    appliedCommand: commandId
      ? {
          commandId,
          kind: 'SIMULATION_START',
          appliedAgainstRevision: scenarioRevision - 1,
          rebased: false,
          replayed: false,
        }
      : null,
    emittedAt: '2026-09-22T09:00:00.000Z',
  };
}

describe('stale snapshot discard rule', () => {
  it('keeps the highest applied revision', () => {
    const state = acceptSnapshot(createRevisionGuard(), snapshot(5)).state;
    expect(state.scenarioRevision).toBe(5);

    const older = expectRejected(acceptSnapshot(state, snapshot(4)));
    expect(older.accepted).toBe(false);
    expect(older.reason).toBe('STALE_REVISION');
    expect(older.state.scenarioRevision).toBe(5);

    const newer = acceptSnapshot(state, snapshot(6));
    expect(newer.accepted).toBe(true);
    expect(newer.state.scenarioRevision).toBe(6);
  });

  it('accepts an equal revision and lets the last payload win', () => {
    const state = acceptSnapshot(createRevisionGuard(), snapshot(5, 2)).state;
    const again = acceptSnapshot(state, snapshot(5, 7));
    expect(again.accepted).toBe(true);
    expect(again.state.maxAppliedTick).toBe(7);
  });

  it('starts a fresh timeline for a different scenario', () => {
    const state = acceptSnapshot(createRevisionGuard(), snapshot(9)).state;
    const other = acceptSnapshot(state, snapshot(1, 0, null, 'scenario-2'));
    expect(other.accepted).toBe(true);
    expect(other.state.scenarioId).toBe('scenario-2');
    expect(other.state.scenarioRevision).toBe(1);
  });
});

describe('stale tick discard rule', () => {
  it('only accepts a newer tick inside the current revision', () => {
    const state = acceptSnapshot(createRevisionGuard(), snapshot(5, 3)).state;
    expect(acceptTick(state, { scenarioRevision: 5, tick: 3 }).accepted).toBe(false);
    expect(
      expectRejected(acceptTick(state, { scenarioRevision: 5, tick: 2 })).reason,
    ).toBe('STALE_TICK');
    const next = acceptTick(state, { scenarioRevision: 5, tick: 4 });
    expect(next.accepted).toBe(true);
    expect(next.state.maxAppliedTick).toBe(4);
  });

  it('discards a tick computed for another revision', () => {
    const state = acceptSnapshot(createRevisionGuard(), snapshot(5, 3)).state;
    const stale = expectRejected(acceptTick(state, { scenarioRevision: 4, tick: 99 }));
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('STALE_REVISION');
    expect(stale.state.maxAppliedTick).toBe(3);
  });
});

describe('pending command rule', () => {
  it('applies only the response that answers the pending command', () => {
    const commandA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const commandB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const state = beginCommand(createRevisionGuard(), commandA);

    const foreign = expectRejected(
      acceptCommandResponse(state, snapshot(2, 0, commandB), commandB),
    );
    expect(foreign.accepted).toBe(false);
    expect(foreign.reason).toBe('UNKNOWN_COMMAND');

    const mine = acceptCommandResponse(state, snapshot(2, 0, commandA), commandA);
    expect(mine.accepted).toBe(true);
  });

  it('still discards a rebased-past response and clears its own pending command', () => {
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const pending = beginCommand(createRevisionGuard(), commandId);
    const applied = acceptCommandResponse(pending, snapshot(2, 0, commandId), commandId).state;
    expect(settleCommand(applied, commandId).pendingCommandId).toBeNull();

    const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const overlapping = beginCommand(applied, otherId);
    expect(settleCommand(overlapping, commandId).pendingCommandId).toBe(otherId);
  });
});

describe('AI answer grounding rule', () => {
  it('accepts an answer only for the revision the user is looking at', () => {
    const guard = acceptSnapshot(createRevisionGuard(), snapshot(5)).state;

    expect(acceptAiAnswer(guard, 5)).toBe(true);
    expect(acceptAiAnswer(guard, 4)).toBe(false);
    expect(acceptAiAnswer(guard, 6)).toBe(false);
  });

  it('refuses every answer before a scenario exists', () => {
    expect(acceptAiAnswer(createRevisionGuard(), 1)).toBe(false);
  });
});
