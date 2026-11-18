// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the offline cache against the built dist/: the service worker
// is named after the deploy and caches all of it, each file checked against
// SHA256SUMS; a file from another deploy (the CDN can serve one for a while) fails
// the install instead of being cached. The PDF converter's wasm is the exception:
// cached on the first PDF export, once checked, and refused (by the worker, and by
// the page without one) when it is not this deploy's. Run with `bun run test:e2e:sw`
// after `scripts/build.sh`.
import type { Browser, Page } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minimalDocx } from '../ooxml';
import { Check, DIST, cardMenu, dialog, launch, serve, startUnprotected } from './lib';

const PDF_WASM = '/pkg/pdf/seal_pdf_bg.wasm';

interface Info {
  version: string;
  commit: string;
  files: string[];
}

/** The service worker's state once it settled: its script URL, and each sealoffice cache with its entries. */
async function swState(page: Page): Promise<{ script: string; caches: Record<string, string[]> }> {
  return page.evaluate(async () => {
    // Settled: a worker activated, or the install failed (no worker left at all).
    for (let i = 0; i < 300; i++) {
      const r = await navigator.serviceWorker.getRegistration();
      if (r?.active?.state === 'activated') break;
      if (i > 5 && r && !r.installing && !r.waiting && !r.active) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      if (!name.startsWith('sealoffice-')) continue;
      out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    }
    return { script: (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? '', caches: out };
  });
}

async function visit(browser: Browser, override?: (path: string) => Response | null): Promise<Awaited<ReturnType<typeof swState>>> {
  const server = serve(override);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.port}/`);
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration()) !== undefined, null, { timeout: 30_000 });
    const state = await swState(page);
    await context.close();
    return state;
  } finally {
    server.stop(true);
  }
}

/**
 * A first visit that imports a Word file and downloads it as PDF once the worker controls the page
 * (or with no worker at all): whether a PDF came, the alert shown instead, and the caches after.
 */
async function exportPdf(browser: Browser, options: { override?: (path: string) => Response | null; worker?: boolean } = {}):
  Promise<{ pdf: boolean; alert: string; caches: Record<string, string[]> }> {
  const server = serve(options.override);
  try {
    const context = await browser.newContext({ serviceWorkers: options.worker === false ? 'block' : 'allow' });
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.port}/`);
    if (options.worker !== false) {
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 120_000 });
    }
    await startUnprotected(page);
    const importing = page.waitForEvent('filechooser');
    await page.locator('.home-bar').getByRole('button', { name: 'Import', exact: true }).click();
    await (await importing).setFiles({ name: 'Note.docx', mimeType: 'application/octet-stream', buffer: Buffer.from(minimalDocx('Hello PDF')) });
    const downloading = page.waitForEvent('download', { timeout: 120_000 }).then((d) => d.suggestedFilename() === 'Note.pdf', () => false);
    await cardMenu(page, 'Note.docx', 'Download', 'PDF');
    const failed = page.getByRole('heading', { name: 'Something went wrong' });
    const pdf = await Promise.race([downloading, failed.waitFor({ timeout: 120_000 }).then(() => false, () => false)]);
    const alert = (await failed.count()) > 0 ? await dialog(page).innerText() : '';
    const state = options.worker === false ? { caches: {} } : await swState(page);
    await context.close();
    return { pdf, alert, caches: state.caches };
  } finally {
    server.stop(true);
  }
}

async function main(): Promise<number> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no build; run scripts/build.sh first`);
  const info = JSON.parse(readFileSync(join(DIST, 'build-info.json'), 'utf8')) as Info;
  const build = info.commit.slice(0, 12);
  const name = `sealoffice-${info.version}-${build}`;
  const check = new Check();
  const browser = await launch();
  try {
    const ok = await visit(browser);
    check.ok(ok.script !== '' && new URL(ok.script).searchParams.get('b') === build, `the worker is named after the deploy (${ok.script.replace(/^.*\//, '')})`);
    const cached = ok.caches[name] ?? [];
    const wanted = ['/', '/main.js', '/live.html', '/pkg/editor/ibis_office_app.js', '/pkg/editor/ibis_office_app_bg.wasm',
      '/pkg/pdf/seal_pdf.js', '/pdf-worker.js', '/SHA256SUMS'];
    check.ok(wanted.every((p) => cached.includes(p)) && cached.length >= info.files.filter((f) => !f.startsWith('assets/')).length,
      `the deploy is cached under ${name} (${cached.length} files; caches: ${Object.keys(ok.caches).join(', ')})`);
    check.ok(!cached.includes(PDF_WASM), 'the PDF converter\'s wasm is not precached');

    // The first PDF export downloads the wasm; the worker checks it, then caches it.
    const first = await exportPdf(browser);
    check.ok(first.pdf && (first.caches[name] ?? []).includes(PDF_WASM),
      `the first PDF export caches the converter (pdf: ${first.pdf}; ${first.alert || 'no alert'})`);

    // A converter from another deploy: refused by the worker, nothing cached.
    const tampered = (path: string) => (path === PDF_WASM
      ? new Response(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), { headers: { 'Content-Type': 'application/wasm' } })
      : null);
    const refused = await exportPdf(browser, { override: tampered });
    check.ok(!refused.pdf && refused.alert.includes('SHA-256 mismatch') && !(refused.caches[name] ?? [PDF_WASM]).includes(PDF_WASM),
      `a converter that is not this deploy's is refused by the worker and not cached (${refused.alert.replace(/\s+/g, ' ')})`);
    // Without a worker, the page checks it against build-info.json itself.
    const unchecked = await exportPdf(browser, { override: tampered, worker: false });
    check.ok(!unchecked.pdf && unchecked.alert.includes('is not this deploy\'s'),
      `without a worker, the page refuses it too (${unchecked.alert.replace(/\s+/g, ' ')})`);

    // main.js from another deploy: the install fails, nothing is cached for this one.
    const stale = await visit(browser, (path) => (path === '/main.js'
      ? new Response(`${readFileSync(join(DIST, 'main.js'), 'utf8')}\n// another deploy\n`, { headers: { 'Content-Type': 'text/javascript' } })
      : null));
    check.ok(stale.caches[name] === undefined && stale.script === '',
      `a file from another deploy fails the install (active: ${stale.script || 'none'}; caches: ${Object.keys(stale.caches).join(', ') || 'none'})`);
  } finally {
    await browser.close();
  }
  if (check.failures.length > 0) {
    console.log(`sw: ${check.failures.length} failure(s)`);
    return 1;
  }
  console.log('sw: PASS');
  return 0;
}

process.exit(await main());
