/**
 * Live capture of the local copilot, used to build the AI/report GIF.
 *
 * This is a genuine conversation against the running stack: the script deploys a colony,
 * activates the fixed Qwen core, asks a grounded question, waits for the validated answer,
 * builds the shift report, catches the real download and opens the downloaded Markdown so
 * the last frames show the report's own content.
 *
 * Usage (with the stack already running against the local Ollama service):
 *
 *   node tools/demos/capture_copilot.mjs
 *
 * `ROBOROUTE_CAPTURE_BASE` overrides the origin (default `http://127.0.0.1:4180`, the
 * current frontend build proxied to the API at `http://127.0.0.1:8000`). Frames and the
 * downloaded report land in `tools/demos/.frames/copilot/`, a transient directory that is
 * ignored by git; `build_gifs.py` consumes it and the directory is then removed.
 */

import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ROBOROUTE_CAPTURE_BASE ?? 'http://127.0.0.1:4180';
const OUT = join(HERE, '.frames', 'copilot');
const VIEWPORT = { width: 1100, height: 760 };
const QUESTION =
  process.env.ROBOROUTE_CAPTURE_QUESTION ??
  'Why did the robots take these routes, and does any order risk being missed?';
/** The local 4B model is CPU-bound in a container, so the waits are minutes, not seconds. */
const MODEL_TIMEOUT = Number(process.env.ROBOROUTE_MODEL_TIMEOUT_MS ?? 420_000);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const frames = [];

async function shot(page, label) {
  const file = join(OUT, `${String(frames.length).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file });
  frames.push({ file, label });
  return file;
}

/**
 * Put a section at a fixed height in the viewport.
 *
 * Anchoring every step at the same offset keeps the frames comparable, so the cross-fades
 * in the GIF dissolve between two shots of the same region instead of two scroll positions.
 */
async function reveal(page, selector) {
  await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY - 186;
    window.scrollTo(0, Math.max(0, top));
  }, selector);
  await page.waitForTimeout(320);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
const page = await context.newPage();
await page.addInitScript(() => window.localStorage.clear());

await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 });

// The copilot only reads a scenario, so a real colony comes first.
await page.getByRole('button', { name: 'Start Optimizing' }).click();
await page.locator('.stage__canvas').waitFor({ state: 'visible', timeout: 60_000 });
await page.getByRole('button', { name: 'Fleet', exact: true }).click();
await page.getByRole('button', { name: 'Deploy Fleet' }).click();
await page.locator('.robot-card').first().waitFor({ state: 'visible', timeout: 60_000 });
await page.getByRole('button', { name: 'Generate Orders' }).click();
await page.getByRole('button', { name: 'Optimize Routes' }).click();
await page.locator('.route-summary').waitFor({ state: 'visible', timeout: 120_000 });
await page.getByRole('button', { name: 'Analytics', exact: true }).click();
await page.locator('.ai-copilot').waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(900);
await reveal(page, '.ai-status');
await shot(page, 'panel-ready');

// Preload the installed model. Nothing is downloaded; this is the local warm-up.
const activate = page.getByRole('button', { name: 'Activate AI core' });
if (await activate.isEnabled()) {
  await activate.click();
}
await page
  .locator('.ai-status')
  .getByText('Core loaded', { exact: false })
  .waitFor({ timeout: MODEL_TIMEOUT });
await shot(page, 'core-loaded');

// A grounded question about the revision the dashboard is showing.
await page.getByLabel('Copilot question').fill(QUESTION);
await reveal(page, '.ai-chat');
await shot(page, 'question');
const askStartedAt = Date.now();
await page.getByRole('button', { name: 'Ask the copilot' }).click();
await shot(page, 'asking');
await page.locator('.ai-answer').waitFor({ state: 'visible', timeout: MODEL_TIMEOUT });
const answerSeconds = Math.round((Date.now() - askStartedAt) / 1000);
await reveal(page, '.ai-answer');
await shot(page, 'answer');
const answer = (await page.locator('.ai-answer__text').innerText()).trim();

// The shift report, its real download and the downloaded file opened.
await page.getByRole('button', { name: 'Build shift report' }).click();
await page
  .locator('.ai-report')
  .getByText('Schema', { exact: false })
  .waitFor({ timeout: MODEL_TIMEOUT });
await reveal(page, '.ai-report');
await shot(page, 'report-ready');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60_000 }),
  page.getByRole('button', { name: 'Download report (Markdown)' }).click(),
]);
const reportPath = join(OUT, 'report.md');
await download.saveAs(reportPath);
await reveal(page, '.ai-report');
await shot(page, 'downloaded');

const markdown = readFileSync(reportPath, 'utf8');
const viewer = await context.newPage();
await viewer.setViewportSize(VIEWPORT);
await viewer.setContent(reportDocument(markdown, download.suggestedFilename()));
await viewer.waitForTimeout(500);
await viewer.screenshot({ path: join(OUT, `${String(frames.length).padStart(2, '0')}-report-open.png`) });
frames.push({ file: join(OUT, `${String(frames.length).padStart(2, '0')}-report-open.png`), label: 'report-open' });

await browser.close();
writeFileSync(
  join(HERE, '.frames', 'copilot.json'),
  `${JSON.stringify(
    {
      base: BASE,
      viewport: VIEWPORT,
      question: QUESTION,
      answerSeconds,
      answer,
      reportBytes: Buffer.byteLength(markdown, 'utf8'),
      frames,
    },
    null,
    2,
  )}\n`,
);
console.log(`captured ${frames.length} copilot frames (answer in ${answerSeconds}s) into ${OUT}`);

/**
 * Render the downloaded Markdown as a reader would see it once opened.
 *
 * The document is the verbatim file the product wrote; only the typography is added so the
 * GIF frames stay legible after they are scaled down.
 */
function reportDocument(markdown, title) {
  const escape = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (value) =>
    escape(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  const lines = markdown.split(/\r?\n/);
  const html = [];
  let list = null;
  let table = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const closeTable = () => {
    if (table) html.push('</tbody></table>');
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    const row = /^\|(.*)\|$/.exec(line);

    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    if (row) {
      closeList();
      const cells = row[1].split('|').map((cell) => cell.trim());
      if (!table) {
        table = true;
        html.push('<table><tbody>');
      }
      html.push(`<tr>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (item) {
      if (list !== 'ul') {
        closeList();
        list = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (/^-{3,}$/.test(line)) {
      html.push('<hr />');
      continue;
    }
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <title>${escape(title)}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; padding: 34px 46px 60px;
        background: #070d1a; color: #dfe8f5;
        font: 15px/1.62 "Segoe UI", system-ui, sans-serif;
      }
      h1 { font-size: 27px; margin: 0 0 6px; color: #f2f7ff; }
      h2 { font-size: 19px; margin: 22px 0 8px; color: #8fd8ff; }
      h3 { font-size: 16px; margin: 18px 0 6px; color: #b9c9e0; }
      p, li { color: #c8d6ea; }
      code { background: #101c31; padding: 1px 5px; border-radius: 4px; color: #7fe3c4; }
      ul { margin: 6px 0 6px 20px; padding: 0; }
      hr { border: 0; border-top: 1px solid #1d2c46; margin: 18px 0; }
      table { border-collapse: collapse; margin: 10px 0; }
      td { border: 1px solid #1d2c46; padding: 5px 11px; }
      strong { color: #f2f7ff; }
      body::before {
        content: "${escape(title)}";
        display: block; margin: 0 0 18px; padding: 7px 12px;
        background: #0d1729; border: 1px solid #1d2c46; border-radius: 6px;
        color: #6f86a8; font: 12px/1.2 ui-monospace, Menlo, Consolas, monospace;
      }
    </style></head><body>${html.join('\n')}</body></html>`;
}
