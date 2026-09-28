/**
 * Live capture of the README/product-surface stills.
 *
 * The committed screenshots used to be full-page E2E captures. In a full-page capture the
 * deck's sticky top bar is painted where the page happened to be scrolled, so the bar ended
 * up duplicated and overlapping the first card. This script drives the same running product
 * and takes the stills the repository publishes, but it neutralises the two sticky surfaces
 * for the duration of the capture, records the header band height in a manifest and lets
 * `tools/demos/build_screenshots.py` crop that band away. The result is a clean product shot
 * with no sticky chrome baked into the pixels.
 *
 * Usage (with the stack already running):
 *
 *   node tools/demos/capture_screenshots.mjs
 *
 * `ROBOROUTE_CAPTURE_BASE` overrides the origin (default `http://127.0.0.1:8080`, the
 * Compose front door). Raw frames land in `tools/demos/.frames/screens/`, which is transient
 * and ignored by git; only the composed PNGs are committed.
 */

import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ROBOROUTE_CAPTURE_BASE ?? 'http://127.0.0.1:8080';
const OUT = join(HERE, '.frames', 'screens');
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

/**
 * The two sticky surfaces the capture has to neutralise.
 *
 * `position: sticky` is what makes the shipped product pleasant to scroll and what makes a
 * full-page screenshot unusable, so it is overridden only inside this capture session. The
 * running application is never modified.
 */
const UNSTICK = `
  .deck__topbar { position: static !important; }
  .deck__rail { position: static !important; }
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const captures = [];

async function park(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(260);
}

/** Capture the whole document at 2x; the manifest records what the builder has to trim. */
async function capture(page, name, { full = true, headerHeight = 0 } = {}) {
  const file = join(OUT, `${name}.png`);
  if (full) {
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  } else {
    await page.screenshot({ path: file, animations: 'disabled' });
  }
  captures.push({ name, file, headerHeight, scale: SCALE, viewport: VIEWPORT });
  console.log(`captured ${name}`);
}

/**
 * Close one road from the dashboard dock.
 *
 * Which canvas pixels sit inside the snap radius depends on how the camera fitted the
 * district, so the helper walks a deterministic grid of candidate points and stops at the
 * first accepted drop. Ported from the product E2E so the stills exercise the real gesture.
 */
async function closeOneRoad(page) {
  const canvas = page.locator('.stage__canvas');
  const cards = page.getByTestId('closure-card');
  const arm = page.getByRole('button', { name: /Arm closure tool|Closure tool armed/ });
  const before = await cards.count();

  for (const x of [0.16, 0.26, 0.36, 0.46, 0.56, 0.66, 0.76, 0.86]) {
    for (const y of [0.16, 0.26, 0.36, 0.46, 0.56, 0.66, 0.76, 0.86]) {
      if (await arm.isDisabled()) return;
      if ((await arm.innerText()).includes('Arm closure tool')) {
        await arm.click();
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      const box = await canvas.boundingBox();
      if (!box) throw new Error('the city canvas is not laid out');
      const point = { x: box.x + box.width * x, y: box.y + box.height * y };
      const onCanvas = await page.evaluate(
        (p) =>
          document.elementFromPoint(p.x, p.y)?.classList.contains('stage__canvas') ?? false,
        point,
      );
      if (!onCanvas) continue;
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 8, point.y + 5, { steps: 3 });
      await page.mouse.up();
      if ((await cards.count()) > before) return;
    }
  }
  throw new Error('no point on the city map closed a road');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
await page.addInitScript(() => window.localStorage.clear());

await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 });
await page.waitForTimeout(1200);
// The landing page has no sticky chrome of its own, so it is captured as the reader sees it.
await capture(page, 'landing', { full: false });

await page.getByRole('button', { name: 'Start Optimizing' }).click();
await page.locator('.stage__canvas').waitFor({ state: 'visible', timeout: 60_000 });
await park(page);

// The header band is measured before it is unstuck: that is the strip the builder trims.
const topbar = await page.locator('.deck__topbar').boundingBox();
const headerHeight = Math.round(topbar?.y ?? 0) + Math.round(topbar?.height ?? 0);
await page.addStyleTag({ content: UNSTICK });
await park(page);

// Configure the colony and publish a plan.
await page.getByRole('button', { name: 'Fleet', exact: true }).click();
await page.getByRole('button', { name: 'Deploy Fleet' }).click();
await page.locator('.robot-card').first().waitFor({ state: 'visible', timeout: 60_000 });
await page.getByRole('button', { name: 'Generate Orders' }).click();
await page.getByRole('button', { name: 'Optimize Routes' }).click();
await page.locator('.route-summary').waitFor({ state: 'visible', timeout: 120_000 });
await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await park(page);
await page.waitForTimeout(900);
await capture(page, 'live-city', { headerHeight });

// Run the shift so the clock, the transport bar and the robots are all live.
await page.getByLabel('Simulation speed').selectOption('4');
await page.getByRole('button', { name: 'Start Simulation' }).click();
await page.getByTestId('simulation-clock').filter({ hasText: 'Running' }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(4000);
await park(page);
await capture(page, 'running-clock', { headerHeight });

// An intervention: two closed roads, then one of them reopened.
await closeOneRoad(page);
await closeOneRoad(page);
await park(page);
await page.waitForTimeout(700);
await capture(page, 'road-closure', { headerHeight });

const firstCard = page.getByTestId('closure-card').first();
await firstCard.getByRole('button', { name: 'Reopen road' }).click();
await park(page);
await page.waitForTimeout(900);
await capture(page, 'road-reopened', { headerHeight });

// The scenario builder is the third reference surface.
await page.getByRole('button', { name: 'Scenarios', exact: true }).click();
await park(page);
await page.waitForTimeout(900);
await capture(page, 'scenario-builder', { headerHeight });

await browser.close();

writeFileSync(
  join(OUT, 'manifest.json'),
  `${JSON.stringify({ base: BASE, viewport: VIEWPORT, scale: SCALE, captures }, null, 2)}\n`,
);
console.log(`captured ${captures.length} stills from ${BASE} into ${OUT}`);
