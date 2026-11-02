// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of a shared document against the built dist/: "Shared document"
// on the home screen opens a blank Word document in a live session whose link is
// in the address bar (and copied); a reload keeps the host; a guest opening the
// link takes the pen by typing once the host has paused, the host cannot take it
// while the guest types, then takes it back by typing; both edits end up in the
// host's library. Relays run in this process. Run with `bun run test:e2e:live`
// after `scripts/build.sh`. SHOTS=<dir> saves screenshots; HEADED=1 shows the browser.
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Check, DIST, type LocalRelay, SHOTS, WORD, dialog, hasWebGpu, launch, readClipboard, routeRelays, serve, shot, typeInEditor,
  startUnprotected, waitHome, wordText,
} from './lib';

/** A little more than the app's pause before typing takes the pen (AUTO_PEN_IDLE_MS). */
const PAUSE_MS = 6500;

const liveBar = (page: Page): Locator => page.locator('nav.live-bar');
const penLabel = (page: Page): Locator => liveBar(page).locator('strong');

/** Waits until the session bar's pen label reads `text`; whether it did. */
async function penIs(page: Page, text: string, timeout = 20_000): Promise<boolean> {
  return liveBar(page).locator('strong', { hasText: text }).waitFor({ timeout }).then(() => true, () => false);
}

async function main(): Promise<number> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no build; run scripts/build.sh first`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const server = serve();
  const origin = `http://localhost:${server.port}`;
  const check = new Check();
  const pageErrors: string[] = [];
  const relays = new Map<string, LocalRelay>();
  const browser: Browser = await launch();
  const newContext = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await routeRelays(context, relays);
    context.on('page', (page) => {
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  console.error: ${m.text().slice(0, 200)}`);
      });
    });
    return context;
  };
  try {
    const host = await (await newContext()).newPage();
    await host.goto(`${origin}/`);
    const gpu = await hasWebGpu(host);
    check.ok(gpu, 'WebGPU adapter available');
    if (!gpu) return 1;
    await startUnprotected(host);
    await waitHome(host);

    // A: one tile, a kind, and the session's link is in the address bar and the clipboard.
    await shot(host, 'live-00-home');
    await host.getByRole('button', { name: /^Shared document/ }).click();
    await dialog(host).getByRole('heading', { name: 'New shared document' }).waitFor({ timeout: 10_000 });
    await shot(host, 'live-00-dialog');
    check.ok(await dialog(host).getByText(/IP address/).isVisible(), 'the shared document dialog says what a live session exposes');
    await dialog(host).getByRole('button', { name: 'Word document', exact: true }).click();
    await liveBar(host).waitFor({ timeout: 120_000 });
    const invite = host.url();
    check.ok(/\/live\.html#r=[^&]+&k=[^&]+$/.test(invite), `the address bar shows the invite link, without the library id (${invite.replace(/k=.*/, 'k=…')})`);
    check.ok(await penIs(host, 'You have the pen'), 'the host starts with the pen');
    const copied = await readClipboard(host).catch(() => '');
    check.ok(copied === invite, 'the invite link is copied on start');
    await shot(host, 'live-01-host');

    // A reload of the host's tab: still the host.
    await host.reload();
    await liveBar(host).waitFor({ timeout: 120_000 });
    check.ok(await penIs(host, 'You have the pen'), 'after a reload the tab is still the host');
    check.ok((await liveBar(host).getByRole('button', { name: 'Save a copy in my library' }).count()) === 0, 'the reloaded host has no guest button');
    await typeInEditor(host, 'Hello from host');

    // The guest opens the link in another browser.
    const guest = await (await newContext()).newPage();
    await guest.goto(invite);
    await liveBar(guest).waitFor({ timeout: 120_000 });
    check.ok(await penIs(guest, 'Host has the pen'), `the guest sees the host holds the pen (${await penLabel(guest).innerText()})`);

    // B: the host has paused; the guest types and gets the pen without the host answering anything.
    await host.waitForTimeout(PAUSE_MS);
    await guest.keyboard.press('x');
    check.ok(await penIs(guest, 'You have the pen'), 'typing gives the guest the pen once the host has paused');
    check.ok(await penIs(host, 'Guest has the pen'), 'the host sees the guest holds the pen');
    check.ok((await host.locator('dialog').count()) === 0, 'the host was not asked anything');
    await typeInEditor(guest, ' and guest');
    await shot(guest, 'live-02-guest-pen');

    // The guest is typing: the host's typing does not take the pen, and says why.
    await guest.keyboard.type(' typing on', { delay: 100 });
    await host.keyboard.press('y');
    const busy = await liveBar(host).getByText('Guest is typing').waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check.ok(busy && (await penIs(guest, 'You have the pen', 1000)), 'the guest keeps the pen while typing; the host is told it is busy');

    // The guest pauses: the host types and takes the pen back, with the guest's last edits.
    await guest.waitForTimeout(PAUSE_MS);
    await host.keyboard.press('y');
    check.ok(await penIs(host, 'You have the pen'), 'typing gives the host the pen back once the guest has paused');
    check.ok(await penIs(guest, 'Host has the pen'), 'the guest sees the host holds the pen again');
    await typeInEditor(host, ' and host again');
    // The pen holder saves every 3 s.
    await host.waitForTimeout(5000);
    await shot(host, 'live-03-host-back');

    await liveBar(host).getByRole('button', { name: 'Leave' }).click();
    await waitHome(host);
    const saved = await wordText(host, WORD);
    check.ok(saved.includes('Hello from host') && saved.includes('and guest typing on') && saved.includes('and host again'),
      `the host's library holds both people's edits (${saved})`);
    check.ok(pageErrors.length === 0, `no uncaught errors (${pageErrors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop(true);
  }
  if (check.failures.length > 0) {
    console.log(`live: ${check.failures.length} failure(s)`);
    return 1;
  }
  console.log('live: PASS');
  return 0;
}

process.exit(await main());
