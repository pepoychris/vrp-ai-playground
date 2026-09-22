/**
 * Renderer telemetry for the Phase 9 city stage.
 *
 * Data in, string out. The numbers come from Three.js `renderer.info`, which is valid
 * until the next rendered frame, plus the frame counter of the animation loop. Nothing
 * here is estimated: a measurement that is unavailable is omitted from the label instead
 * of being rendered as a zero.
 *
 * This module deliberately imports nothing, so the stage can read the numbers without
 * pulling the Three.js chunk into the initial bundle.
 */

export interface RendererStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  pixelRatio: number;
  /** The driver's renderer string when the browser exposes it, e.g. `ANGLE (...)`. */
  contextName: string | null;
}

interface RendererProbe {
  info?: {
    render?: { calls?: unknown; triangles?: unknown };
    memory?: { geometries?: unknown; textures?: unknown };
    programs?: unknown;
  } | null;
  getPixelRatio?: () => unknown;
  getContext?: () => unknown;
}

/**
 * Read Three.js `renderer.info` defensively.
 *
 * The argument is `unknown` on purpose: the renderer is optional in this application (a
 * browser without WebGL has none), and a test double has no `info` at all. Both answer
 * `null`, and the stage then shows no numbers rather than invented ones.
 */
export function readRendererStats(renderer: unknown): RendererStats | null {
  const probe = renderer as RendererProbe | null;
  const info = probe?.info;
  if (!info) return null;

  const render = info.render;
  const memory = info.memory;
  if (!render && !memory) return null;

  return {
    drawCalls: toCount(render?.calls),
    triangles: toCount(render?.triangles),
    geometries: toCount(memory?.geometries),
    textures: toCount(memory?.textures),
    programs: Array.isArray(info.programs) ? info.programs.length : 0,
    pixelRatio: readPixelRatio(probe),
    contextName: readContextName(probe),
  };
}

/** The compact line the stage shows: only the numbers that are actually measured. */
export function describeRendererStats(
  stats: RendererStats | null,
  fps: number | null,
): string | null {
  if (stats === null) return null;
  const parts: string[] = [];
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    parts.push(`${Math.round(fps)} fps`);
  }
  parts.push(`${stats.drawCalls} draw ${stats.drawCalls === 1 ? 'call' : 'calls'}`);
  parts.push(`${formatCount(stats.triangles)} triangles`);
  parts.push(`${formatPixelRatio(stats.pixelRatio)} DPR`);
  return parts.join(' · ');
}

/**
 * The longer explanation behind the compact line, used as its tooltip.
 *
 * It names the source of every number so the reading is auditable, and it states the FPS
 * window instead of implying a benchmark.
 */
export function describeRendererDetail(
  stats: RendererStats | null,
  fps: number | null,
): string | null {
  if (stats === null) return null;
  const parts = [
    'Measured from Three.js renderer.info after the last rendered frame',
    `${stats.drawCalls} draw calls`,
    `${stats.triangles} triangles`,
    `${stats.geometries} geometries`,
    `${stats.textures} textures`,
    `${stats.programs} shader programs`,
    `${stats.pixelRatio} device pixel ratio`,
  ];
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
    parts.push(`${fps.toFixed(1)} fps while the simulation is animating`);
  }
  if (stats.contextName) parts.push(stats.contextName);
  return parts.join(' · ');
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function formatCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatPixelRatio(value: number): string {
  return `${value.toFixed(2).replace(/\.?0+$/, '')}x`;
}

function readPixelRatio(probe: RendererProbe): number {
  if (typeof probe.getPixelRatio !== 'function') return 1;
  try {
    return toCount(probe.getPixelRatio()) || 1;
  } catch {
    return 1;
  }
}

function readContextName(probe: RendererProbe): string | null {
  if (typeof probe.getContext !== 'function') return null;
  try {
    const context = probe.getContext() as {
      getExtension?: (name: string) => unknown;
      getParameter?: (parameter: unknown) => unknown;
    } | null;
    const extension = context?.getExtension?.('WEBGL_debug_renderer_info') as {
      UNMASKED_RENDERER_WEBGL?: unknown;
    } | null;
    if (extension?.UNMASKED_RENDERER_WEBGL === undefined) return null;
    const name = context?.getParameter?.(extension.UNMASKED_RENDERER_WEBGL);
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}
