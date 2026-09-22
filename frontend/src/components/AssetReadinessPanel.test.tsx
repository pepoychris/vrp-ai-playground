import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXPECTED_ASSET_COUNT,
  INITIAL_ASSET_READINESS,
  type AssetReadinessState,
} from '../state/asset-readiness';
import { AssetReadinessPanel } from './AssetReadinessPanel';
import { SceneStage } from './SceneStage';

function render(state: AssetReadinessState): string {
  return renderToStaticMarkup(<AssetReadinessPanel readiness={state} onReload={() => undefined} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssetReadinessPanel', () => {
  it('renders the waiting state', () => {
    const markup = render(INITIAL_ASSET_READINESS);

    expect(markup).toContain('3D assets');
    expect(markup).toContain('Fixture library');
    expect(markup).toContain('Waiting');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('Waiting to load');
    expect(markup).toContain('>Loading assets<');
  });

  it('renders live progress while loading', () => {
    const markup = render({
      ...INITIAL_ASSET_READINESS,
      status: 'loading',
      loadedItems: 2,
      ratio: 0.4,
    });

    expect(markup).toContain(`Loading 2 of ${EXPECTED_ASSET_COUNT}`);
    expect(markup).toContain('aria-valuenow="40"');
    expect(markup).toContain('disabled');
  });

  it('reports a ready library and offers a reload', () => {
    const markup = render({
      ...INITIAL_ASSET_READINESS,
      status: 'ready',
      loadedItems: EXPECTED_ASSET_COUNT,
      ratio: 1,
    });

    expect(markup).toContain('Ready');
    expect(markup).toContain(`${EXPECTED_ASSET_COUNT} of ${EXPECTED_ASSET_COUNT} loaded`);
    expect(markup).toContain('Reload assets');
    expect(markup).not.toContain('disabled');
  });

  it('lists the fixtures that failed without losing the healthy ones', () => {
    const markup = render({
      ...INITIAL_ASSET_READINESS,
      status: 'degraded',
      loadedItems: EXPECTED_ASSET_COUNT - 1,
      ratio: (EXPECTED_ASSET_COUNT - 1) / EXPECTED_ASSET_COUNT,
      failures: [{ id: 'barrier', url: '/assets/models/barrier.glb', reason: 'HTTP 404' }],
    });

    expect(markup).toContain('Degraded');
    expect(markup).toContain('1 failed');
    expect(markup).toContain('barrier: HTTP 404');
  });

  it('shows a bundle-level error', () => {
    const markup = render({
      ...INITIAL_ASSET_READINESS,
      status: 'failed',
      error: 'asset pipeline exploded',
    });

    expect(markup).toContain('Unavailable');
    expect(markup).toContain('asset pipeline exploded');
    expect(markup).toContain('No fixture asset could be loaded');
  });

  it('does not touch the network while rendering', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('rendering must not fetch');
    });
    vi.stubGlobal('fetch', fetchStub);

    render(INITIAL_ASSET_READINESS);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('leaks no workflow phase wording into the interface', () => {
    const markup = `${render(INITIAL_ASSET_READINESS)}${render({
      ...INITIAL_ASSET_READINESS,
      status: 'ready',
      ratio: 1,
      loadedItems: EXPECTED_ASSET_COUNT,
    })}`;

    expect(markup).not.toMatch(/phase\s*\d/i);
    expect(markup).not.toMatch(/fase\s*\d/i);
  });
});

describe('SceneStage', () => {
  // Phase 3 replaced the fixture preview with the city view; the placeholder contract is
  // unchanged: a canvas, an accessible name, a waiting note and no fetch of its own.
  it('renders an accessible placeholder before the fixtures arrive', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('rendering must not fetch');
    });
    vi.stubGlobal('fetch', fetchStub);

    const markup = renderToStaticMarkup(
      <SceneStage bundle={null} snapshot={null} onRelocateVehicle={() => undefined} />,
    );

    expect(markup).toContain('City view');
    expect(markup).toContain('stage__canvas');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('Waiting for the fixture assets.');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
