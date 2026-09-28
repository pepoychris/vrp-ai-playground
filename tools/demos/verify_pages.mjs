/**
 * Acceptance check for the GitHub Pages landing that lives at the repository root.
 *
 * It runs the page in a real browser at a desktop and a phone viewport and asserts the
 * three things the reported defect was about:
 *
 *   1. the document has no horizontal overflow and no console/page errors;
 *   2. every navigation anchor lands with its section below the sticky header instead of
 *      underneath it (the bug in the supplied screenshot);
 *   3. both demo GIFs actually load, at their published intrinsic size.
 *
 * Usage, from `frontend/` with a static server over the repository root:
 *
 *   node ..\tools\demos\verify_pages.mjs [baseUrl] [screenshotDir]
 *
 * Defaults: `http://127.0.0.1:4174` and no screenshots. Pass a directory to also capture
 * review screenshots of the top of the page, the demos section and every anchored section.
 */

import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4174/';
const SHOTS = process.argv[3] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];

/** Anchors published by the page header. */
const SECTIONS = ['capabilities', 'demos', 'run', 'ai', 'architecture', 'api'];

const failures = [];
const browser = await chromium.launch({ headless: true });

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror ${error.message}`));
  page.on('requestfailed', (request) => errors.push(`requestfailed ${request.url()}`));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  const title = await page.title();
  if (title !== 'RoboRoute Nexus') failures.push(`${viewport.name}: title is "${title}"`);

  const favicon = await page.getAttribute('link[rel="icon"]', 'href');
  if (!favicon || !favicon.includes('favicon')) failures.push(`${viewport.name}: no favicon link`);

  /**
   * The page uses smooth scrolling, so the anchor landing has to be awaited. The scroll is
   * only considered settled once three consecutive samples agree, which is longer than the
   * browser's animation ramp-up.
   */
  const settle = () =>
    page
      .waitForFunction(
        () =>
          new Promise((resolve) => {
            let stable = 0;
            let previous = window.scrollY;
            const tick = () => {
              const current = window.scrollY;
              stable = current === previous ? stable + 1 : 0;
              previous = current;
              if (stable >= 3) resolve(true);
              else setTimeout(tick, 130);
            };
            setTimeout(tick, 130);
          }),
        null,
        { timeout: 8_000 },
      )
      .catch(() => {});

  const landings = [];
  for (const section of SECTIONS) {
    await page.locator(`.topbar__nav a[href="#${section}"]`).click();
    await settle();
    const measured = await page.evaluate((id) => {
      const header = document.querySelector('.topbar')?.getBoundingClientRect();
      const target = document.getElementById(id)?.getBoundingClientRect();
      return {
        headerBottom: header?.bottom ?? 0,
        targetTop: target?.top ?? -1,
        targetVisible: (target?.height ?? 0) > 0,
      };
    }, section);
    landings.push({ section, ...measured });
    if (!measured.targetVisible) failures.push(`${viewport.name}: #${section} is not laid out`);
    if (measured.targetTop < measured.headerBottom - 1) {
      failures.push(
        `${viewport.name}: #${section} starts at ${measured.targetTop} under a ${measured.headerBottom}px header`,
      );
    }
    if (measured.targetTop > measured.headerBottom + 160) {
      failures.push(
        `${viewport.name}: clicking #${section} left it at ${measured.targetTop} instead of the top of the page`,
      );
    }
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, `${viewport.name}-section-${section}.png`) });
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    headerHeight: document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0,
    gifs: Array.from(document.querySelectorAll('img[src$=".gif"]')).map((image) => ({
      src: image.getAttribute('src'),
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  }));

  if (layout.overflow > 0) failures.push(`${viewport.name}: ${layout.overflow}px of horizontal overflow`);
  if (layout.gifs.length !== 2) failures.push(`${viewport.name}: found ${layout.gifs.length} GIFs`);
  for (const gif of layout.gifs) {
    if (!gif.complete || gif.width !== 960 || gif.height !== 600) {
      failures.push(`${viewport.name}: ${gif.src} loaded as ${gif.width}x${gif.height}`);
    }
  }
  if (errors.length) failures.push(...errors.map((error) => `${viewport.name}: ${error}`));

  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, `${viewport.name}-top.png`) });
    await page.locator('#demos').scrollIntoViewIfNeeded();
    await settle();
    await page.screenshot({ path: join(SHOTS, `${viewport.name}-demos.png`), fullPage: false });
  }

  console.log(
    viewport.name,
    JSON.stringify({ title, headerHeight: layout.headerHeight, overflow: layout.overflow, gifs: layout.gifs.length, landings, errors }),
  );
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error('FAILURES:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('page verification: OK');
