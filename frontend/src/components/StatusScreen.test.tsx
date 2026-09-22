import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INACTIVE_AI_STATUS, INACTIVE_READINESS } from '../state/readiness';
import { StatusScreen } from './StatusScreen';

function render(readiness = INACTIVE_READINESS): string {
  return renderToStaticMarkup(
    <StatusScreen readiness={readiness} refreshing={false} onRefresh={() => undefined} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatusScreen', () => {
  it('renders the inactive startup screen', () => {
    const markup = render();

    expect(markup).toContain('RoboRoute Nexus');
    expect(markup).toContain('System status');
    expect(markup).toContain('Inactive (IDLE)');
    expect(markup).toContain('No active scenario');
    expect(markup).toContain('qwen3:4b');
    expect(markup).toContain('>Unavailable<');
    expect(markup).toContain('0 vehicles, 0 orders');
  });

  it('separates service availability, installed model and loaded model', () => {
    const markup = render({
      ...INACTIVE_READINESS,
      api: 'online',
      ai: { ...INACTIVE_AI_STATUS, serviceAvailable: true, modelInstalled: true },
    });

    expect(markup).toContain('AI service (Ollama)');
    expect(markup).toContain('Model installed');
    expect(markup).toContain('Model loaded');
    expect(markup).toContain('>Available<');
    expect(markup).toContain('>Yes<');
  });

  it('does not call the network while rendering', () => {
    const fetchStub = vi.fn(() => {
      throw new Error('the status screen must not fetch while rendering');
    });
    vi.stubGlobal('fetch', fetchStub);

    render();

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('exposes no phase metadata in the user interface', () => {
    const markup = render();

    expect(markup).not.toMatch(/phase\s*\d/i);
    expect(markup).not.toMatch(/fase\s*\d/i);
  });
});
