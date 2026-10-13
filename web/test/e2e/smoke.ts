// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test against the built dist/: first launch on the home screen
// without a passphrase, a Word document typed and saved without ⌘S, Excel and
// PowerPoint, reload, an encrypted .age download imported back, a document lock,
// protecting the library (recovery key, lock screen, passkey, forgotten
// passphrase, removing protection); then the other-tab screen, backup/restore
// with a locked document, share links, history and a live session between two
// browser contexts. Run with `bun run test:e2e` after `scripts/build.sh`.
// SHOTS=<dir> saves screenshots; HEADED=1 shows the browser.
// LIVE_RELAYS=local forces the in-process Nostr relay instead of the public ones.
import type { BrowserContext, Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELAYS } from '../../src/live/transport';
import {
  Check, DIST, type LocalRelay, SHOTS, WORD, appbar, card, cardMenu, dialog, editorShown, goHome, hasWebGpu, home, launch, openCard, readClipboard,
  routeRelays, serve, shot, typeInEditor, waitHome, wordText,
} from './lib';

const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'recovered horse battery staple';
const BACKUP_PASSPHRASE = 'backup horse battery staple';
const EXPORT_PASSPHRASE = 'export horse battery staple';
const DOC_PASSPHRASE = 'document horse staple';
const AGE_HEADER = 'age-encryption.org/v1';
const EXCEL = 'Workbook.xlsx';
const POWERPOINT = 'Presentation.pptx';

/** Every file under the library's OPFS root: path → first bytes as text and SHA-256 of the content. */
async function opfs(page: Page): Promise<Record<string, { head: string; hash: string }>> {
  return page.evaluate(async () => {
    const out: Record<string, { head: string; hash: string }> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind === 'directory') {
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        } else {
          let file: File;
          try {
            file = await (handle as FileSystemFileHandle).getFile();
          } catch (e) {
            // The app may be saving: an entry listed by the iterator (a createWritable swap file,
            // a blob being replaced) can vanish before getFile(). It is simply no longer there.
            if (e instanceof DOMException && e.name === 'NotFoundError') continue;
            throw e;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
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

async function waitForDocs(page: Page, predicate: (files: Record<string, { hash: string }>) => boolean): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (predicate(await opfs(page))) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const docFiles = (files: Record<string, { hash: string }>): [string, string][] =>
  Object.entries(files).filter(([k]) => k.startsWith('sealoffice/docs/')).map(([k, v]) => [k, v.hash]);

/** OPFS files that are not age files, besides the unprotected library's plain key. */
function nonAgeFiles(files: Record<string, { head: string }>): string[] {
  return Object.keys(files).filter((n) => n !== 'sealoffice/identity.key' && n !== 'sealoffice/passkey.json' && files[n]?.head !== AGE_HEADER);
}


/** Lock screen → home. */
async function unlock(page: Page, passphrase: string): Promise<void> {
  await page.fill('#passphrase', passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await waitHome(page);
}

/** The recovery key dialog: its key, Continue only enabled once "stored" is ticked. */
async function storeRecoveryKey(page: Page): Promise<string> {
  await dialog(page).getByRole('heading', { name: 'Recovery key' }).waitFor({ timeout: 60_000 });
  const key = (await dialog(page).locator('pre.recovery-key').innerText()).trim();
  const next = dialog(page).getByRole('button', { name: 'Continue' });
  const disabledBefore = await next.isDisabled();
  await page.locator('#recovery-stored').check();
  await next.click();
  return disabledBefore ? key : `(Continue was enabled before ticking) ${key}`;
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('.home-bar').getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog(page).getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 10_000 });
}

async function closeSettings(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
}

const normalizeWs = (url: string): string => url.replace(/\/+$/, '');

/** True when at least one pinned relay accepts a WebSocket from this machine within 8 s. */
async function relaysReachable(): Promise<boolean> {
  const tries = RELAYS.map((url) => new Promise<boolean>((done) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      done(false);
    }, 8000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      done(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(false);
    };
  }));
  return (await Promise.all(tries)).some((ok) => ok);
}

/** connect-src of a built page. */
function connectSrc(file: string): string[] {
  const html = readFileSync(join(DIST, file), 'utf8');
  const match = /connect-src ([^;"]*)/.exec(html);
  return match?.[1]?.trim().split(/\s+/) ?? [];
}

async function main(): Promise<number> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no build; run scripts/build.sh first`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const server = serve();
  // localhost, not 127.0.0.1: WebAuthn refuses IP addresses as relying party ids.
  const origin = `http://localhost:${server.port}`;
  const check = new Check();
  const notProven: string[] = [];
  const browser = await launch();
  const offOrigin: string[] = [];
  const offLive: string[] = [];
  const liveSockets = new Set<string>();
  const policyErrors: string[] = [];
  const pageErrors: string[] = [];
  const pinned = new Set(RELAYS.map(normalizeWs));
  const isLive = (page: Page): boolean => new URL(page.url() || origin).pathname.endsWith('/live.html');
  const watched = new WeakSet<Page>();
  /** Network, console and error watchers on every page of every context. */
  const watch = (page: Page): void => {
    if (watched.has(page)) return;
    watched.add(page);
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (['blob:', 'data:'].includes(url.protocol) || url.origin === origin) return;
      // live.html may only reach the pinned relays; index.html nothing at all.
      if (isLive(page) && pinned.has(normalizeWs(r.url()))) return;
      (isLive(page) ? offLive : offOrigin).push(r.url());
    });
    page.on('websocket', (ws) => {
      if (isLive(page) && pinned.has(normalizeWs(ws.url()))) {
        liveSockets.add(normalizeWs(ws.url()));
      } else {
        (isLive(page) ? offLive : offOrigin).push(ws.url());
      }
    });
    page.on('console', (m) => {
      const text = m.text();
      if (/Content Security Policy|Trusted ?Type|securitypolicyviolation/i.test(text)) policyErrors.push(text);
      if (m.type() === 'error') console.log(`  console.error: ${text.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
  };
  const newContext = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    context.on('page', watch);
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`securitypolicyviolation ${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`);
      });
    });
    return context;
  };

  // The built pages' CSP: index.html reaches nothing, live.html only the pinned relays.
  const indexConnect = connectSrc('index.html');
  check.ok(indexConnect.length === 1 && indexConnect[0] === "'self'", `index.html connect-src is 'self' only (${indexConnect.join(' ')})`);
  const liveConnect = connectSrc('live.html');
  check.ok(liveConnect[0] === "'self'" && liveConnect.length === RELAYS.length + 1 && RELAYS.every((r) => liveConnect.includes(r)),
    `live.html connect-src is 'self' plus exactly the pinned relays (${liveConnect.join(' ')})`);

  try {
    const context = await newContext();
    const page = await context.newPage();
    watch(page);
    // Passkeys: a virtual platform authenticator with PRF.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    });

    await page.goto(`${origin}/`);
    const gpu = await hasWebGpu(page);
    check.ok(gpu, 'WebGPU adapter available');
    if (!gpu) {
      await shot(page, '00-no-webgpu');
      return 1;
    }

    // 1. First launch: the home screen, no passphrase, three tiles.
    await waitHome(page);
    check.ok(!(await page.locator('#passphrase').isVisible()), 'first launch opens on the home screen without a passphrase');
    const tiles = ['Word document', 'Excel workbook', 'PowerPoint presentation'];
    const tilesShown = await Promise.all(tiles.map((name) => page.getByRole('button', { name, exact: true }).isEnabled()));
    check.ok(tilesShown.every(Boolean), 'home shows the three create tiles');
    check.ok(await page.getByText('Not protected').isVisible(), 'home footer says the library is not protected');
    await shot(page, '01-home-empty');
    const firstFiles = await opfs(page);
    check.ok(firstFiles['sealoffice/identity.key'] !== undefined && firstFiles['sealoffice/identity.age'] === undefined,
      `an unprotected library keeps its key in identity.key (${Object.keys(firstFiles).join(', ')})`);

    // A Word document typed without ⌘S: Home saves it, the card says so, reopening shows it.
    await page.getByRole('button', { name: 'Word document', exact: true }).click();
    await editorShown(page);
    await shot(page, '02-editor-new');
    check.ok(pageErrors.length === 0, `no uncaught errors after opening the editor (${pageErrors.join('; ')})`);
    check.ok((await appbar(page).locator('.appbar-name').innerText()) === WORD, 'the app bar names the new document');
    const canvasBox = await page.locator('body > canvas').boundingBox();
    check.ok(canvasBox !== null && Math.round(canvasBox.y) === 48, `the canvas starts below the 48 px app bar (${canvasBox?.y})`);
    await typeInEditor(page, 'Hello sealoffice');
    const saveState = appbar(page).locator('[role=status]');
    await saveState.filter({ hasText: 'Unsaved changes' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    check.ok((await saveState.innerText()) === 'Unsaved changes', `app bar shows Unsaved changes after typing (${await saveState.innerText()})`);
    await goHome(page);
    const wordCard = card(page, WORD);
    await wordCard.waitFor({ timeout: 30_000 });
    const openBadge = (await wordCard.locator('.badge-pill.open').innerText().catch(() => '')).trim();
    check.ok(openBadge === 'Open · Saved', `back home, the open document's card says Saved (${openBadge})`);
    await shot(page, '03-home-card');
    const typed = await wordText(page);
    check.ok(typed.includes('Hello sealoffice'), `text typed without ⌘S is saved by Home (${typed})`);
    await openCard(page, WORD);
    check.ok((await saveState.innerText()) === 'Saved', `app bar shows Saved after reopening (${await saveState.innerText()})`);
    // ⌘S still saves, and the earlier save is kept as a version.
    const beforeSave = docFiles(await opfs(page)).length;
    await typeInEditor(page, ' again');
    await page.waitForTimeout(500);
    await page.keyboard.press('Meta+S');
    check.ok(await waitForDocs(page, (f) => docFiles(f).length === beforeSave + 1), '⌘S writes a new blob and keeps the previous one as a version');

    // About from the ⋯ menu.
    await appbar(page).getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'About', exact: true }).click();
    const powered = page.getByRole('link', { name: 'ibisOffice' });
    await powered.waitFor({ timeout: 10_000 }).catch(() => undefined);
    check.ok(await powered.isVisible(), 'About shows the "Powered by ibisOffice" link');
    await page.locator('dialog').getByRole('button', { name: 'Close' }).click();

    // 2. Excel and PowerPoint open in the same editor.
    for (const [tile, name] of [['Excel workbook', EXCEL], ['PowerPoint presentation', POWERPOINT]] as const) {
      await goHome(page);
      await page.getByRole('button', { name: tile, exact: true }).click();
      await editorShown(page);
      check.ok((await appbar(page).locator('.appbar-name').innerText()) === name, `${tile} opens as ${name}`);
    }
    await shot(page, '04-editor-pptx');
    await goHome(page);
    check.ok((await page.locator('.doc-card').count()) === 3, 'home shows three documents');
    check.ok(pageErrors.length === 0, `no uncaught errors after the three kinds (${pageErrors.join('; ')})`);

    // 3. Reload: no passphrase, the documents are there.
    await page.reload();
    await waitHome(page);
    check.ok(!(await page.locator('#passphrase').isVisible()) && (await page.locator('.doc-card').count()) === 3,
      'after a reload the documents are there without a passphrase');
    const files = await opfs(page);
    const plain = nonAgeFiles(files);
    check.ok(plain.length === 0, `every other OPFS file is an age file (${plain.join(', ') || 'all'})`);

    // A second tab of the same browser: "Open in another tab", then Use here.
    const other = await context.newPage();
    watch(other);
    await other.goto(`${origin}/`);
    await other.getByRole('heading', { name: 'Open in another tab' }).waitFor({ timeout: 30_000 });
    check.ok(true, 'a second tab shows "Open in another tab"');
    await shot(other, '05-other-tab');
    await other.getByRole('button', { name: 'Use here' }).click();
    await home(other).waitFor({ timeout: 60_000 });
    await page.getByRole('heading', { name: 'sealoffice is now open in another tab' }).waitFor({ timeout: 60_000 });
    check.ok(true, 'Use here moves the library: the second tab gets the home screen, the first says it is open elsewhere');
    await page.getByRole('button', { name: 'Use here' }).click();
    await waitHome(page);
    await other.getByRole('heading', { name: 'sealoffice is now open in another tab' }).waitFor({ timeout: 60_000 });
    check.ok(true, 'Use here in the first tab takes the library back');
    await other.close();

    // 4. Download an encrypted .age, then import it back with its passphrase.
    const ageDownload = page.waitForEvent('download', { timeout: 30_000 });
    await cardMenu(page, WORD, 'Download', 'Encrypted .age');
    await dialog(page).getByLabel('Export passphrase', { exact: true }).fill(EXPORT_PASSPHRASE);
    await dialog(page).getByLabel('Repeat passphrase', { exact: true }).fill(EXPORT_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Download', exact: true }).click();
    const ageFile = await ageDownload;
    const agePath = join(await ageFile.path(), '..', ageFile.suggestedFilename());
    await ageFile.saveAs(agePath);
    check.ok(readFileSync(agePath).subarray(0, AGE_HEADER.length).toString() === AGE_HEADER && ageFile.suggestedFilename().endsWith('.age'),
      `encrypted download is an age file (${ageFile.suggestedFilename()})`);
    const importing = page.waitForEvent('filechooser');
    await page.locator('.home-bar').getByRole('button', { name: 'Import', exact: true }).click();
    await (await importing).setFiles(agePath);
    await dialog(page).getByLabel('Passphrase or secret key', { exact: true }).fill(EXPORT_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Decrypt' }).click();
    const reimported = 'Document (2).docx';
    await card(page, reimported).waitFor({ timeout: 30_000 }).catch(() => undefined);
    const reimportedText = (await card(page, reimported).count()) === 1 ? await wordText(page, reimported) : '';
    check.ok(reimportedText.includes('Hello sealoffice again'), `the .age download imports back with its passphrase (${reimportedText})`);
    await cardMenu(page, reimported, 'Delete…');
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await card(page, reimported).waitFor({ state: 'detached', timeout: 10_000 });

    // 5. Document lock: lock the Word document, reload, wrong then right passphrase, remove the lock.
    await cardMenu(page, WORD, 'Lock…');
    await dialog(page).getByLabel('Document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(page).getByLabel('Repeat document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    const lockButton = dialog(page).getByRole('button', { name: 'Lock', exact: true });
    const lockDisabled = await lockButton.isDisabled();
    await dialog(page).getByRole('checkbox').check();
    await lockButton.click();
    await dialog(page).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    check.ok(lockDisabled, 'locking a document needs the no-recovery box ticked');
    check.ok(await wordCard.getByText('Locked').isVisible(), 'the locked document shows a lock badge');
    // Locked from Home: its key is not kept, so opening it asks for the passphrase without a reload.
    await page.getByRole('button', { name: `Open ${WORD}`, exact: true }).click();
    const askedAtOnce = await dialog(page).getByLabel('Document passphrase', { exact: true })
      .waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check.ok(askedAtOnce, 'a document locked from Home asks for its passphrase before a reload');
    if (askedAtOnce) {
      await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog(page).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
    }
    await page.reload();
    await waitHome(page);
    await page.getByRole('button', { name: `Open ${WORD}`, exact: true }).click();
    await dialog(page).getByLabel('Document passphrase', { exact: true }).fill('not the passphrase');
    await dialog(page).getByRole('button', { name: 'Unlock', exact: true }).click();
    await dialog(page).locator('.form-error').filter({ hasText: /./ }).waitFor({ timeout: 60_000 }).catch(() => undefined);
    const docError = await dialog(page).locator('.form-error').innerText().catch(() => '');
    check.ok(docError !== '', `a wrong document passphrase is refused (${docError})`);
    await dialog(page).getByLabel('Document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Unlock', exact: true }).click();
    await editorShown(page);
    check.ok(true, 'the right document passphrase opens the locked document');
    await shot(page, '06-locked-open');
    await goHome(page);
    await cardMenu(page, WORD, 'Remove lock…');
    await dialog(page).getByLabel('Document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Remove lock', exact: true }).click();
    await dialog(page).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    check.ok((await wordCard.getByText('Locked').count()) === 0, 'Remove lock takes the badge off');

    // 6. Protect the library: recovery key, lock screen after a reload.
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Protect with a passphrase…' }).click();
    await dialog(page).getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(page).getByLabel('Repeat passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Protect', exact: true }).click();
    const recoveryKey = await storeRecoveryKey(page);
    check.ok(/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(recoveryKey), `protecting shows the recovery key, Continue only once stored (${recoveryKey.slice(0, 20)}…)`);
    // A passkey, while the library is protected.
    const addPasskey = dialog(page).getByRole('button', { name: 'Add passkey…' });
    await addPasskey.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const passkeyOffered = await addPasskey.isVisible();
    check.ok(passkeyOffered, 'Settings offers "Add passkey…" with a PRF authenticator');
    if (passkeyOffered) {
      await addPasskey.click();
      await dialog(page).getByRole('heading', { name: 'Passkey added' }).waitFor({ timeout: 60_000 });
      await dialog(page).getByRole('button', { name: 'OK' }).click();
    }
    await closeSettings(page);
    check.ok(await page.locator('.home-footer').getByText('Protected', { exact: true }).isVisible(), 'home footer says Protected');
    const protectedFiles = await opfs(page);
    check.ok(protectedFiles['sealoffice/identity.key'] === undefined && protectedFiles['sealoffice/identity.age'] !== undefined,
      `a protected library has no plain key left (${Object.keys(protectedFiles).filter((n) => n.includes('identity')).join(', ')})`);
    const protectedPlain = nonAgeFiles(protectedFiles);
    check.ok(protectedPlain.length === 0, `every OPFS file of the protected library is an age file (${protectedPlain.join(', ') || 'all'})`);

    // Autosave before locking: type without ⌘S, then Lock library in the app bar.
    await openCard(page, WORD);
    await typeInEditor(page, ' autosaved');
    await appbar(page).getByRole('button', { name: 'Lock library', exact: true }).click();
    await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor({ timeout: 30_000 });
    await shot(page, '07-locked');
    await page.fill('#passphrase', 'wrong passphrase!');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.locator('.form-error').filter({ hasText: /./ }).waitFor({ timeout: 60_000 });
    check.ok(true, `wrong passphrase is refused (${await page.locator('.form-error').innerText()})`);
    await unlock(page, PASSPHRASE);
    const afterLock = await wordText(page);
    check.ok(afterLock.includes('Hello sealoffice again autosaved'), `text typed without ⌘S is saved by Lock library (${afterLock})`);

    // Passkey unlock.
    if (passkeyOffered) {
      await page.locator('.home-footer').getByRole('button', { name: 'Lock now' }).click();
      const withPasskey = page.getByRole('button', { name: 'Unlock with a passkey' });
      await withPasskey.waitFor({ timeout: 60_000 });
      await withPasskey.click();
      await waitHome(page);
      await shot(page, '08-passkey');
      check.ok(true, 'the library unlocks with the passkey');
    }

    // Forgotten passphrase: the recovery key resets it.
    await page.reload();
    await page.getByRole('button', { name: 'Forgot passphrase? Use the recovery key' }).click();
    await dialog(page).getByLabel('Recovery key', { exact: true }).fill(recoveryKey);
    await dialog(page).getByLabel('New passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog(page).getByLabel('Repeat new passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Reset passphrase' }).click();
    await waitHome(page);
    await shot(page, '09-recovered');
    check.ok((await page.locator('.doc-card').count()) === 3, 'the recovery key resets the passphrase and the documents are there');

    // Remove protection: back to opening without a passphrase.
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Remove protection…' }).click();
    await dialog(page).getByLabel('Passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog(page).getByRole('checkbox').check();
    await dialog(page).getByRole('button', { name: 'Remove protection', exact: true }).click();
    await dialog(page).getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 60_000 });
    await closeSettings(page);
    await page.reload();
    await waitHome(page);
    check.ok(!(await page.locator('#passphrase').isVisible()) && (await page.locator('.doc-card').count()) === 3,
      'after Remove protection the library opens without a passphrase');

    // 7. Backup with a locked document, restored into a fresh browser.
    await cardMenu(page, EXCEL, 'Lock…');
    await dialog(page).getByLabel('Document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(page).getByLabel('Repeat document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(page).getByRole('checkbox').check();
    await dialog(page).getByRole('button', { name: 'Lock', exact: true }).click();
    await dialog(page).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Back up library…' }).click();
    await dialog(page).getByLabel('Backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    await dialog(page).getByLabel('Repeat backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    const backingUp = page.waitForEvent('download', { timeout: 60_000 });
    await dialog(page).getByRole('button', { name: 'Back up', exact: true }).click();
    const backup = await backingUp;
    const backupPath = join(await backup.path(), '..', backup.suggestedFilename());
    await backup.saveAs(backupPath);
    check.ok(readFileSync(backupPath).subarray(0, AGE_HEADER.length).toString() === AGE_HEADER, `backup is an age file (${backup.suggestedFilename()})`);
    await closeSettings(page);

    const restoredContext = await newContext();
    const restored = await restoredContext.newPage();
    watch(restored);
    await restored.goto(`${origin}/`);
    await waitHome(restored);
    const choosing = restored.waitForEvent('filechooser');
    await restored.getByRole('button', { name: 'Restore a backup…' }).click();
    await (await choosing).setFiles(backupPath);
    await dialog(restored).getByLabel('Backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    await dialog(restored).getByRole('button', { name: 'Restore', exact: true }).click();
    await dialog(restored).getByRole('heading', { name: 'Backup restored' }).waitFor({ timeout: 60_000 });
    await dialog(restored).getByRole('button', { name: 'OK' }).click();
    await shot(restored, '10-restored');
    const restoredText = await wordText(restored);
    check.ok(restoredText.includes('Hello sealoffice again autosaved'), `backup restored in a fresh browser holds the document (${restoredText})`);
    check.ok(await card(restored, EXCEL).getByText('Locked').isVisible(), 'the locked document is still locked after the restore');
    await restored.getByRole('button', { name: `Open ${EXCEL}`, exact: true }).click();
    await dialog(restored).getByLabel('Document passphrase', { exact: true }).fill(DOC_PASSPHRASE);
    await dialog(restored).getByRole('button', { name: 'Unlock', exact: true }).click();
    await editorShown(restored);
    check.ok(true, 'the restored locked document opens with its own passphrase');
    // Lost document passphrase, on this throwaway copy: the prompt offers to delete the document.
    await restored.reload();
    await waitHome(restored);
    await restored.getByRole('button', { name: `Open ${EXCEL}`, exact: true }).click();
    await dialog(restored).getByLabel('Document passphrase', { exact: true }).fill('not the passphrase');
    await dialog(restored).getByRole('button', { name: 'Unlock', exact: true }).click();
    await dialog(restored).locator('.form-error').filter({ hasText: /./ }).waitFor({ timeout: 60_000 }).catch(() => undefined);
    const forgotDoc = dialog(restored).getByRole('button', { name: 'Forgot it? Delete this document', exact: true });
    check.ok(await forgotDoc.isVisible(), 'a wrong document passphrase prompt offers "Forgot it? Delete this document"');
    await forgotDoc.click();
    const forgetButton = dialog(restored).getByRole('button', { name: 'Delete', exact: true });
    await forgetButton.waitFor({ timeout: 10_000 });
    const forgetDisabled = await forgetButton.isDisabled();
    await dialog(restored).getByRole('checkbox').check();
    await forgetButton.click();
    const forgotten = await card(restored, EXCEL).waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false);
    check.ok(forgetDisabled && forgotten, 'deleting a locked document with a lost passphrase needs the box ticked and removes its card');
    await restoredContext.close();

    // Share link, opened in another fresh browser: the document is imported.
    await cardMenu(page, WORD, 'Share link…');
    await dialog(page).getByRole('button', { name: 'Link with the key included' }).click();
    await dialog(page).getByRole('button', { name: 'Copy link' }).click();
    await dialog(page).getByText('Copied.').waitFor({ timeout: 10_000 });
    const shareLink = await readClipboard(page);
    check.ok(shareLink.startsWith(`${origin}/#`), `share link points at this app (${shareLink.slice(0, 60)}…)`);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    const sharedContext = await newContext();
    const shared = await sharedContext.newPage();
    watch(shared);
    await shared.goto(shareLink);
    await shared.getByRole('heading', { name: 'Shared document' }).waitFor({ timeout: 60_000 });
    await dialog(shared).getByRole('button', { name: 'Save' }).click();
    await dialog(shared).getByRole('heading', { name: 'Saved' }).waitFor({ timeout: 30_000 });
    await dialog(shared).getByRole('button', { name: 'OK' }).click();
    await waitHome(shared);
    await shot(shared, '11-shared');
    const sharedText = await wordText(shared);
    check.ok(sharedText.includes('Hello sealoffice again autosaved'), `share link imports the document in another browser (${sharedText})`);
    await sharedContext.close();

    // History: restore the oldest version (the blank document).
    await cardMenu(page, WORD, 'Version history');
    const versions = dialog(page).getByRole('button', { name: 'Restore' });
    await versions.first().waitFor({ timeout: 10_000 });
    check.ok((await versions.count()) >= 2, `history lists the earlier versions (${await versions.count()})`);
    await versions.last().click();
    await dialog(page).getByRole('heading', { name: 'Restore this version?' }).waitFor({ timeout: 30_000 });
    await dialog(page).getByRole('button', { name: 'Restore' }).click();
    await dialog(page).waitFor({ state: 'detached', timeout: 30_000 });
    const historyText = await wordText(page);
    check.ok(!historyText.includes('again'), `restoring the oldest version brings back the first save (${historyText})`);

    // Live session: host on live.html, a guest in another browser receives the snapshot.
    const forceLocal = process.env.LIVE_RELAYS === 'local';
    const reachable = !forceLocal && (await relaysReachable());
    const relays = new Map<string, LocalRelay>();
    console.log(`  live: ${reachable ? 'public Nostr relays' : 'in-process Nostr relay (public relays unreachable or LIVE_RELAYS=local)'}`);
    let guestContext: BrowserContext | null = null;
    try {
      if (!reachable) await routeRelays(context, relays);
      await cardMenu(page, WORD, 'Live session…');
      await dialog(page).getByRole('button', { name: 'Start' }).click();
      await page.waitForURL(/\/live\.html#r=.+&k=.+/, { timeout: 30_000 });
      // The library is not protected: the host goes straight to the session.
      const hostBar = page.locator('nav.live-bar');
      await hostBar.waitFor({ timeout: 120_000 });
      check.ok(!(await page.locator('#passphrase').isVisible()), 'the host of an unprotected library is not asked to unlock it');
      await hostBar.getByRole('button', { name: 'Copy invite link' }).click();
      await hostBar.getByText('Invite link copied.').waitFor({ timeout: 10_000 });
      const invite = await readClipboard(page);
      check.ok(/\/live\.html#r=[^&]+&k=[^&]+$/.test(invite), `invite link has room and key only (${invite.replace(/k=.*/, 'k=…')})`);
      check.ok(page.url() === invite, 'the host\'s address bar shows the invite link, without the library id');

      guestContext = await newContext();
      if (!reachable) await routeRelays(guestContext, relays);
      const guest = await guestContext.newPage();
      watch(guest);
      await guest.goto(invite);
      const guestBar = guest.locator('nav.live-bar');
      await guestBar.waitFor({ timeout: 120_000 });
      check.ok(await guestBar.getByRole('button', { name: 'Request the pen' }).isVisible(), 'guest receives the host snapshot and shows the session bar');
      await shot(guest, '12-live-guest');

      await typeInEditor(page, 'Hello sealoffice live');
      // The pen holder's autosave sends a snapshot every 3 s.
      await page.waitForTimeout(10_000);
      await guestBar.getByRole('button', { name: 'Save a copy in my library' }).click();
      await dialog(guest).getByRole('heading', { name: 'Copy saved' }).waitFor({ timeout: 60_000 });
      await dialog(guest).getByRole('button', { name: 'OK' }).click();
      check.ok(true, 'a guest saves a copy into a new, unprotected library without a passphrase');
      await guestBar.getByRole('button', { name: 'Leave' }).click();
      await guest.waitForURL(`${origin}/`, { timeout: 30_000 });
      await waitHome(guest);
      const liveText = await wordText(guest);
      check.ok(liveText.includes('Hello sealoffice live'), `guest's copy holds what the host typed live (${liveText})`);
      if (reachable) {
        check.ok(liveSockets.size > 0, `live pages connected to pinned relays only (${[...liveSockets].join(', ')})`);
      } else {
        // Routed sockets raise no 'websocket' event: the relay's own count shows the pages reached it.
        const events = [...relays.values()].reduce((n, r) => n + r.events, 0);
        check.ok(events > 0, `in-process relay carried the signalling (${events} events)`);
      }
    } catch (error) {
      if (!reachable && /routeWebSocket|not a function|not supported/i.test(String(error))) {
        notProven.push(`live: public relays unreachable and the local relay could not be routed (${String(error).slice(0, 200)})`);
      } else {
        check.ok(false, `live session (${reachable ? 'public relays' : 'in-process relay'}): ${String(error).slice(0, 300)}`);
      }
    } finally {
      await guestContext?.close();
    }

    // Lost passphrase and recovery key: delete everything from the lock screen, in a fresh browser.
    const lostContext = await newContext();
    const lost = await lostContext.newPage();
    watch(lost);
    await lost.goto(`${origin}/`);
    await waitHome(lost);
    await lost.getByRole('button', { name: 'Word document', exact: true }).click();
    await editorShown(lost);
    await goHome(lost);
    await openSettings(lost);
    await dialog(lost).getByRole('button', { name: 'Protect with a passphrase…' }).click();
    await dialog(lost).getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(lost).getByLabel('Repeat passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(lost).getByRole('button', { name: 'Protect', exact: true }).click();
    await storeRecoveryKey(lost);
    await closeSettings(lost);
    await lost.reload();
    await lost.getByRole('button', { name: 'Lost both? Delete everything and start over' }).click();
    const startOver = dialog(lost).getByRole('button', { name: 'Delete everything', exact: true });
    await startOver.waitFor({ timeout: 10_000 });
    const disabledAtFirst = await startOver.isDisabled();
    await dialog(lost).getByRole('checkbox').check();
    const disabledWithBoxOnly = await startOver.isDisabled();
    await dialog(lost).getByLabel('Confirmation', { exact: true }).fill('delete');
    const disabledWithWrongWord = await startOver.isDisabled();
    await dialog(lost).getByLabel('Confirmation', { exact: true }).fill('DELETE');
    const enabledAtLast = await startOver.isEnabled();
    check.ok(disabledAtFirst && disabledWithBoxOnly && disabledWithWrongWord && enabledAtLast,
      'Delete everything stays disabled until the box is ticked and DELETE typed');
    await startOver.click();
    await waitHome(lost);
    await shot(lost, '13-started-over');
    check.ok((await lost.locator('.doc-card').count()) === 0 && !(await lost.locator('#passphrase').isVisible()),
      'deleting everything from the lock screen opens an empty home');
    check.ok(await lost.locator('.home-footer').getByText('Not protected').isVisible(), 'after starting over the home footer says Not protected');
    await lostContext.close();
    check.ok(pageErrors.length === 0, `no uncaught errors (${pageErrors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop(true);
  }
  check.ok(offOrigin.length === 0, `no off-origin requests (${offOrigin.length}: ${offOrigin.slice(0, 5).join(', ')})`);
  check.ok(offLive.length === 0, `live.html reaches only the pinned relays (${offLive.length}: ${offLive.slice(0, 5).join(', ')})`);
  check.ok(policyErrors.length === 0, `no CSP / Trusted Types violations (${policyErrors.length}: ${policyErrors.slice(0, 5).join(' | ')})`);
  for (const what of notProven) console.log(`NOT PROVEN ${what}`);
  if (check.failures.length > 0) {
    console.log(`smoke: ${check.failures.length} failure(s)${notProven.length > 0 ? `, ${notProven.length} NOT PROVEN` : ''}`);
    return 1;
  }
  if (notProven.length > 0) {
    console.log(`smoke: NOT PROVEN (${notProven.length} case(s) could not run; see above)`);
    return 2;
  }
  console.log('smoke: PASS');
  return 0;
}

process.exit(await main());
