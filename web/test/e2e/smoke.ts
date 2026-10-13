// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test against the built dist/: create a vault, write and save a
// document, lock, unlock and reopen it. Run with `bun run test:e2e` after
// `scripts/build.sh`. SHOTS=<dir> saves screenshots; HEADED=1 shows the browser.
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dir, '../../../dist');
const SHOTS = process.env.SHOTS ?? '';
const PASSPHRASE = 'correct horse battery staple';
const AGE_HEADER = 'age-encryption.org/v1';

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

function serve(): ReturnType<typeof Bun.serve> {
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

class Check {
  failures: string[] = [];
  notes: string[] = [];
  ok(cond: boolean, what: string): void {
    (cond ? this.notes : this.failures).push(`${cond ? 'ok' : 'FAIL'} ${what}`);
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  console.log(`  screenshot ${path}`);
}

/** Every file under the vault's OPFS root: path → first bytes as text and SHA-256 of the content. */
async function opfs(page: Page): Promise<Record<string, { head: string; hash: string }>> {
  return page.evaluate(async () => {
    const out: Record<string, { head: string; hash: string }> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind === 'directory') {
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        } else {
          const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          out[`${prefix}${name}`] = {
            head: new TextDecoder().decode(bytes.slice(0, 21)),
            hash: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
          };
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });
}

async function typeAndSave(page: Page, text: string): Promise<void> {
  const canvas = page.locator('body > canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('editor canvas has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Meta+S');
}

async function waitForDocs(page: Page, predicate: (files: Record<string, { hash: string }>) => boolean): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (predicate(await opfs(page))) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const docFiles = (files: Record<string, { hash: string }>): [string, string][] =>
  Object.entries(files).filter(([k]) => k.startsWith('sealoffice/docs/')).map(([k, v]) => [k, v.hash]);

async function main(): Promise<number> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no build; run scripts/build.sh first`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const server = serve();
  const origin = `http://127.0.0.1:${server.port}`;
  const check = new Check();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'],
  });
  const offOrigin: string[] = [];
  const policyErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (!['blob:', 'data:'].includes(url.protocol) && url.origin !== origin) offOrigin.push(r.url());
    });
    page.on('console', (m) => {
      const text = m.text();
      if (/Content Security Policy|Trusted ?Type|securitypolicyviolation/i.test(text)) policyErrors.push(text);
      if (m.type() === 'error') console.log(`  console.error: ${text.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`securitypolicyviolation ${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`);
      });
    });

    await page.goto(`${origin}/`);
    const gpu = await page.evaluate(async () => {
      const g = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return g ? (await g.requestAdapter()) != null : false;
    });
    check.ok(gpu, 'WebGPU adapter available');
    if (!gpu) {
      await shot(page, '00-no-webgpu');
      return 1;
    }

    // Create the vault.
    await page.locator('#passphrase-repeat').waitFor();
    await shot(page, '01-create-vault');
    await page.fill('#passphrase', PASSPHRASE);
    await page.fill('#passphrase-repeat', PASSPHRASE);
    await page.getByRole('button', { name: 'Create vault' }).click();
    await page.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
    await page.locator('.editor-status').waitFor({ state: 'detached', timeout: 180_000 });
    await shot(page, '02-vault-empty');

    // New Word document.
    await page.getByRole('button', { name: 'New document' }).click();
    await page.locator('body > canvas').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await shot(page, '03-editor-new');
    check.ok(pageErrors.length === 0, `no uncaught errors after opening the editor (${pageErrors.join('; ')})`);
    check.ok(await page.locator('nav.pill.over-editor').isVisible(), 'toolbar pill is shown over the editor');

    // First save creates the document.
    await typeAndSave(page, 'Hello sealoffice');
    check.ok(await waitForDocs(page, (f) => docFiles(f).length === 1), 'first save writes one document blob');
    await page.waitForTimeout(500);
    await shot(page, '04-editor-saved');
    const firstHash = docFiles(await opfs(page))[0]?.[1];

    // Second save changes it.
    await typeAndSave(page, ' again');
    check.ok(await waitForDocs(page, (f) => docFiles(f).length === 1 && docFiles(f)[0]?.[1] !== firstHash),
      'second save replaces the document blob');

    const files = await opfs(page);
    const names = Object.keys(files);
    check.ok(names.includes('sealoffice/identity.age') && names.includes('sealoffice/index.age'), `vault files present (${names.join(', ')})`);
    const plain = names.filter((n) => files[n]?.head !== AGE_HEADER);
    check.ok(plain.length === 0, `every OPFS file is an age file (${plain.join(', ') || 'all'})`);

    // The vault list shows the saved document.
    await page.locator('nav.pill').getByRole('button', { name: 'Vault' }).click();
    const row = page.locator('.doc-list .doc');
    await row.first().waitFor();
    check.ok((await row.count()) === 1, 'vault list shows one document');
    check.ok(/modified/.test(await row.first().innerText()), 'vault row shows a modified time');
    await shot(page, '05-vault-list');
    await page.getByRole('button', { name: 'Close' }).click();

    // About.
    await page.locator('nav.pill').getByRole('button', { name: 'About' }).click();
    const powered = page.getByRole('link', { name: 'ibisOffice' });
    await powered.waitFor({ timeout: 10_000 }).catch(() => undefined);
    check.ok(await powered.isVisible(), 'About shows the "Powered by ibisOffice" link');
    await shot(page, '06-about');
    await page.locator('dialog').getByRole('button', { name: 'Close' }).click();

    // Lock, unlock, reopen.
    await page.locator('nav.pill').getByRole('button', { name: 'Lock' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Lock' }).click();
    await page.getByRole('button', { name: 'Unlock' }).waitFor({ timeout: 30_000 });
    await shot(page, '07-locked');
    await page.fill('#passphrase', 'wrong passphrase!');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.locator('.form-error').filter({ hasText: /./ }).waitFor({ timeout: 60_000 });
    check.ok(true, `wrong passphrase is refused (${await page.locator('.form-error').innerText()})`);
    await page.fill('#passphrase', PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
    await page.locator('.editor-status').waitFor({ state: 'detached', timeout: 180_000 });
    await page.locator('.doc-list .doc-name').first().click();
    await page.locator('body > canvas').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await shot(page, '08-reopened');
    check.ok(pageErrors.length === 0, `no uncaught errors after reopening (${pageErrors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop(true);
  }
  check.ok(offOrigin.length === 0, `no off-origin requests (${offOrigin.length}: ${offOrigin.slice(0, 5).join(', ')})`);
  check.ok(policyErrors.length === 0, `no CSP / Trusted Types violations (${policyErrors.length}: ${policyErrors.slice(0, 5).join(' | ')})`);
  console.log(check.failures.length === 0 ? 'smoke: PASS' : `smoke: ${check.failures.length} failure(s)`);
  return check.failures.length === 0 ? 0 : 1;
}

process.exit(await main());
