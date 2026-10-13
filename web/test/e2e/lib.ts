// SPDX-License-Identifier: AGPL-3.0-only
// Helpers shared by the end-to-end scripts: the dist/ server, the check list,
// the home screen and editor, and reading a downloaded .docx.
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DIST = resolve(import.meta.dir, '../../../dist');
export const SHOTS = process.env.SHOTS ?? '';
export const WORD = 'Document.docx';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff2: 'font/woff2',
};

export function serve(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(DIST, `.${path}`);
      if (!file.startsWith(DIST) || !existsSync(file)) return new Response('not found', { status: 404 });
      const ext = file.split('.').pop() ?? '';
      return new Response(Bun.file(file), {
        headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
      });
    },
  });
}

/** Chrome with WebGPU, headless unless HEADED=1. */
export function launch(): Promise<Browser> {
  return chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'],
  });
}

export class Check {
  failures: string[] = [];
  notes: string[] = [];
  ok(cond: boolean, what: string): void {
    (cond ? this.notes : this.failures).push(`${cond ? 'ok' : 'FAIL'} ${what}`);
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  }
}

export async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  console.log(`  screenshot ${path}`);
}

/** Whether the page has a WebGPU adapter. */
export async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const g = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return g ? (await g.requestAdapter()) != null : false;
  });
}

export const dialog = (page: Page): Locator => page.locator('dialog').last();

/** A part of a .docx (word/document.xml by default), as is. */
export function docxXml(path: string, part = 'word/document.xml'): string {
  const out = Bun.spawnSync(['unzip', '-p', path, part]);
  if (out.exitCode !== 0) throw new Error(`unzip failed: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

/** The text of a .docx: word/document.xml without its tags. */
export function docxText(path: string): string {
  return docxXml(path).replace(/<[^>]+>/g, '');
}

export const home = (page: Page): Locator => page.locator('.home');
export const card = (page: Page, name: string): Locator => page.locator('.doc-card').filter({ has: page.getByRole('button', { name: `Open ${name}`, exact: true }) });
export const appbar = (page: Page): Locator => page.locator('nav.appbar');

/** Home screen shown, editor downloaded. */
export async function waitHome(page: Page): Promise<void> {
  await home(page).waitFor({ timeout: 60_000 });
  await page.locator('.editor-status').waitFor({ state: 'detached', timeout: 180_000 });
}

/** Opens the ⋯ menu of `name`'s card and picks `items` (a submenu path). */
export async function cardMenu(page: Page, name: string, ...items: string[]): Promise<void> {
  await page.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
  for (const item of items) await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Downloads `name` as its original file from the home screen and returns its path. */
export async function downloadOriginal(page: Page, name: string): Promise<string> {
  const downloading = page.waitForEvent('download', { timeout: 30_000 });
  await cardMenu(page, name, 'Download', 'Original');
  return (await downloading).path();
}

/** The Word document's text, from the home screen. */
export async function wordText(page: Page, name = WORD): Promise<string> {
  await card(page, name).waitFor({ timeout: 30_000 });
  return docxText(await downloadOriginal(page, name));
}

/** Opens `name`'s card in the editor. */
export async function openCard(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await editorShown(page);
}

export async function editorShown(page: Page): Promise<void> {
  await appbar(page).waitFor({ timeout: 60_000 });
  await page.locator('body > canvas').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(3000);
}

export async function goHome(page: Page): Promise<void> {
  await appbar(page).getByRole('button', { name: 'Home', exact: true }).click();
  await home(page).waitFor({ timeout: 60_000 });
}

export async function typeInEditor(page: Page, text: string): Promise<void> {
  const box = await page.locator('body > canvas').boundingBox();
  if (!box) throw new Error('editor canvas has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type(text, { delay: 30 });
}

export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
