/**
 * Live capture of the control deck, used to build the execution GIF.
 *
 * The frames are real viewport screenshots of the running product, taken while the
 * simulation clock advances, so the published GIF shows actual robots moving instead of a
 * re-composition of static stills. Every frame lands in `tools/demos/.frames/execution/`,
 * which is a transient directory: it is ignored by git and deleted once the GIF has been
 * built, so the repository only ever carries the composed animation.
 *
 * Usage (with the stack already running):
 *
 *   node tools/demos/capture_execution.mjs
 *
 * `ROBOROUTE_CAPTURE_BASE` overrides the origin (default `http://127.0.0.1:8080`, the
 * Compose front door) and `ROBOROUTE_FRAME_MS` the delay between motion frames.
 */

import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ROBOROUTE_CAPTURE_BASE ?? 'http://127.0.0.1:8080';
const OUT = join(HERE, '.frames', 'execution');
const FRAME_MS = Number(process.env.ROBOROUTE_FRAME_MS ?? 220);
const VIEWPORT = { width: 1440, height: 900 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const frames = [];

async function shot(page, label) {
  const file = join(OUT, `${String(frames.length).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file });
  frames.push({ file, label });
}

/** Keep every frame on the same framing: the deck header, the city and the fleet. */
async function park(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
}

/**
 * Close one road from the dashboard dock.
 *
 * The drop has to land inside the snap radius of a road, and which pixels those are
 * depends on how the camera fitted the district, so the helper walks a deterministic grid
 * of candidate points over the canvas and stops at the first accepted drop. Ported from the
 * product E2E so the capture exercises the same interaction.
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
const page = await browser.newPage({ viewport: VIEWPORT });
await page.addInitScript(() => window.localStorage.clear());

await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 });
await shot(page, 'landing');

// The deck only exists after the primary call to action.
await page.getByRole('button', { name: 'Start Optimizing' }).click();
await page.locator('.stage__canvas').waitFor({ state: 'visible', timeout: 60_000 });
await park(page);
await page.waitForTimeout(600);
await shot(page, 'deck-idle');

// Configure the colony and publish a plan.
await page.getByRole('button', { name: 'Fleet', exact: true }).click();
await page.getByRole('button', { name: 'Deploy Fleet' }).click();
await page.locator('.robot-card').first().waitFor({ state: 'visible', timeout: 60_000 });
await page.getByRole('button', { name: 'Generate Orders' }).click();
await page.getByRole('button', { name: 'Optimize Routes' }).click();
await page.locator('.route-summary').waitFor({ state: 'visible', timeout: 90_000 });
await park(page);
await shot(page, 'fleet-optimized');

// Run the shift. The clock drives the plan, so the next block of frames is genuine motion.
await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await park(page);
await page.waitForTimeout(400);
await shot(page, 'dashboard-optimized');
// The speed is chosen before the clock starts, so the run opens at x4.
await page.getByLabel('Simulation speed').selectOption('4');
await page.getByRole('button', { name: 'Start Simulation' }).click();
await page.getByTestId('simulation-clock').filter({ hasText: 'Running' }).waitFor({ timeout: 30_000 });
await park(page);
for (let index = 0; index < 14; index += 1) {
  await page.waitForTimeout(FRAME_MS);
  await shot(page, `motion-${String(index).padStart(2, '0')}`);
}

// An intervention: close a road, let the planner re-plan, then reopen it.
await park(page);
await closeOneRoad(page);
await park(page);
await shot(page, 'closed-00');
for (let index = 1; index < 5; index += 1) {
  await page.waitForTimeout(FRAME_MS);
  await shot(page, `closed-${String(index).padStart(2, '0')}`);
}

const firstCard = page.getByTestId('closure-card').first();
await firstCard.getByRole('button', { name: 'Reopen road' }).click();
await park(page);
await shot(page, 'reopened-00');
for (let index = 1; index < 5; index += 1) {
  await page.waitForTimeout(FRAME_MS);
  await shot(page, `reopened-${String(index).padStart(2, '0')}`);
}

await browser.close();

// The landing hero is the same city render, captured at 2x and without the deck chrome, so
// the page can use the product's own artwork instead of a screenshot of its headline.
const heroBrowser = await chromium.launch({ headless: true });
const heroPage = await heroBrowser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await heroPage.addInitScript(() => window.localStorage.clear());
await heroPage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 });
await heroPage.getByRole('button', { name: 'Start Optimizing' }).click();
await heroPage.locator('.stage__canvas').waitFor({ state: 'visible', timeout: 60_000 });
await heroPage.getByRole('button', { name: 'Fleet', exact: true }).click();
await heroPage.getByRole('button', { name: 'Deploy Fleet' }).click();
await heroPage.locator('.robot-card').first().waitFor({ state: 'visible', timeout: 60_000 });
await heroPage.getByRole('button', { name: 'Generate Orders' }).click();
await heroPage.getByRole('button', { name: 'Optimize Routes' }).click();
await heroPage.locator('.route-summary').waitFor({ state: 'visible', timeout: 120_000 });
await heroPage.getByRole('button', { name: 'Dashboard', exact: true }).click();
await heroPage.evaluate(() => window.scrollTo(0, 0));
await heroPage.waitForTimeout(1500);
await heroPage.locator('.stage__canvas').screenshot({ path: join(OUT, 'hero-canvas.png') });
await heroBrowser.close();

writeFileSync(
  join(HERE, '.frames', 'execution.json'),
  `${JSON.stringify({ base: BASE, viewport: VIEWPORT, frames }, null, 2)}\n`,
);
console.log(`captured ${frames.length} execution frames from ${BASE} into ${OUT}`);
