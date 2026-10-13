// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test against the built dist/: create a vault, write and save a
// document, lock, unlock and reopen it; then autosave, the other-tab screen,
// the recovery key, backup/restore, share links, passkeys, history and a live
// session between two browser contexts. Run with `bun run test:e2e` after
// `scripts/build.sh`. SHOTS=<dir> saves screenshots; HEADED=1 shows the browser.
// LIVE_RELAYS=local forces the in-process Nostr relay instead of the public ones.
import { chromium, type BrowserContext, type Locator, type Page, type WebSocketRoute } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RELAYS } from '../../src/live/transport';

const DIST = resolve(import.meta.dir, '../../../dist');
const SHOTS = process.env.SHOTS ?? '';
const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'recovered horse battery staple';
const BACKUP_PASSPHRASE = 'backup horse battery staple';
const GUEST_PASSPHRASE = 'guest horse battery staple';
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

const dialog = (page: Page): Locator => page.locator('dialog').last();

/** The text of a .docx: word/document.xml without its tags. */
function docxText(path: string): string {
  const out = Bun.spawnSync(['unzip', '-p', path, 'word/document.xml']);
  if (out.exitCode !== 0) throw new Error(`unzip failed: ${out.stderr.toString()}`);
  return out.stdout.toString().replace(/<[^>]+>/g, '');
}

/** Exports the first vault document unencrypted (the vault overlay is shown) and returns its text. */
async function exportText(page: Page): Promise<string> {
  const row = page.locator('.doc-list .doc').first();
  await row.waitFor({ timeout: 30_000 });
  await row.getByRole('button', { name: 'Export', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Unencrypted file…' }).click();
  const downloading = page.waitForEvent('download', { timeout: 30_000 });
  await dialog(page).getByRole('button', { name: 'Export unencrypted' }).click();
  const file = await downloading;
  const path = await file.path();
  return docxText(path);
}

/** Lock screen of an existing vault → vault list → the first document in the editor. */
async function unlockAndOpen(page: Page, passphrase: string): Promise<void> {
  await page.fill('#passphrase', passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await waitVaultAndOpen(page);
}

async function waitVaultAndOpen(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
  await page.locator('.editor-status').waitFor({ state: 'detached', timeout: 180_000 });
  await page.locator('.doc-list .doc-name').first().click();
  await page.locator('body > canvas').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
}

/** Creation screen → recovery key screen (its key is returned) → vault. */
async function createVault(page: Page, passphrase: string): Promise<string> {
  await page.locator('#passphrase-repeat').waitFor({ timeout: 60_000 });
  await page.fill('#passphrase', passphrase);
  await page.fill('#passphrase-repeat', passphrase);
  await page.getByRole('button', { name: 'Create vault' }).click();
  return storeRecoveryKey(page);
}

async function storeRecoveryKey(page: Page): Promise<string> {
  await page.getByRole('heading', { name: 'Recovery key' }).waitFor({ timeout: 60_000 });
  const key = (await page.locator('pre.recovery-key').innerText()).trim();
  const next = page.getByRole('button', { name: 'Continue' });
  const disabledBefore = await next.isDisabled();
  await page.locator('#recovery-stored').check();
  await next.click();
  return disabledBefore ? key : `(Continue was enabled before ticking) ${key}`;
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  const box = await page.locator('body > canvas').boundingBox();
  if (!box) throw new Error('editor canvas has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type(text, { delay: 30 });
}

const normalizeWs = (url: string): string => url.replace(/\/+$/, '');

/** A minimal NIP-01 relay in this process: EVENT / REQ / CLOSE / EOSE with fan-out. */
interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
}
type NostrFilter = Record<string, unknown>;

class LocalRelay {
  private readonly stored: NostrEvent[] = [];
  private readonly subs = new Map<WebSocketRoute, Map<string, NostrFilter[]>>();
  events = 0;

  attach(ws: WebSocketRoute): void {
    this.subs.set(ws, new Map());
    ws.onMessage((raw) => this.receive(ws, typeof raw === 'string' ? raw : raw.toString()));
    ws.onClose(() => this.subs.delete(ws));
  }

  private receive(ws: WebSocketRoute, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify(['NOTICE', 'invalid JSON']));
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, ...rest] = msg as [string, ...unknown[]];
    if (type === 'EVENT') {
      const event = rest[0] as NostrEvent;
      this.events++;
      ws.send(JSON.stringify(['OK', event.id, true, '']));
      const ephemeral = event.kind >= 20000 && event.kind < 30000;
      if (!ephemeral) this.stored.push(event);
      for (const [peer, subs] of this.subs) {
        for (const [id, filters] of subs) {
          if (filters.some((f) => matches(f, event))) peer.send(JSON.stringify(['EVENT', id, event]));
        }
      }
    } else if (type === 'REQ') {
      const id = String(rest[0]);
      const filters = rest.slice(1) as NostrFilter[];
      this.subs.get(ws)?.set(id, filters);
      for (const f of filters) {
        let found = this.stored.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at);
        if (typeof f.limit === 'number') found = found.slice(0, f.limit);
        for (const e of found) ws.send(JSON.stringify(['EVENT', id, e]));
      }
      ws.send(JSON.stringify(['EOSE', id]));
    } else if (type === 'CLOSE') {
      this.subs.get(ws)?.delete(String(rest[0]));
    }
  }
}

function matches(filter: NostrFilter, event: NostrEvent): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'ids' && !(value as string[]).some((v) => event.id.startsWith(v))) return false;
    if (key === 'authors' && !(value as string[]).some((v) => event.pubkey.startsWith(v))) return false;
    if (key === 'kinds' && !(value as number[]).includes(event.kind)) return false;
    if (key === 'since' && event.created_at < (value as number)) return false;
    if (key === 'until' && event.created_at > (value as number)) return false;
    if (key.startsWith('#')) {
      const name = key.slice(1);
      const wanted = value as string[];
      if (!event.tags.some((t) => t[0] === name && t[1] !== undefined && wanted.includes(t[1]))) return false;
    }
  }
  return true;
}

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
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'],
  });
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
    const gpu = await page.evaluate(async () => {
      const g = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      return g ? (await g.requestAdapter()) != null : false;
    });
    check.ok(gpu, 'WebGPU adapter available');
    if (!gpu) {
      await shot(page, '00-no-webgpu');
      return 1;
    }

    // Create the vault; the recovery key is shown before the vault opens.
    await page.locator('#passphrase-repeat').waitFor();
    await shot(page, '01-create-vault');
    const recoveryKey = await createVault(page, PASSPHRASE);
    check.ok(/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(recoveryKey), `recovery key is shown at creation, Continue only once stored (${recoveryKey.slice(0, 20)}…)`);
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
    // The previous blob stays as a version (history), so the save adds a second blob.
    check.ok(await waitForDocs(page, (f) => docFiles(f).length === 2 && docFiles(f).some(([, hash]) => hash === firstHash)
      && docFiles(f).some(([, hash]) => hash !== firstHash)),
      'second save writes a new document blob and keeps the first as a version');

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

    // Autosave: type without ⌘S; the toolbar says Modified, and Lock saves first.
    await typeInEditor(page, ' autosaved');
    const saveState = page.locator('nav.pill [role=status]');
    await saveState.filter({ hasText: 'Modified' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    check.ok((await saveState.innerText()) === 'Modified', `toolbar shows Modified after typing (${await saveState.innerText()})`);

    // Lock, unlock, reopen.
    await page.locator('nav.pill').getByRole('button', { name: 'Lock' }).click();
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
    check.ok((await saveState.innerText()) === 'Saved', `toolbar shows Saved after reopening (${await saveState.innerText()})`);
    await page.locator('nav.pill').getByRole('button', { name: 'Vault' }).click();
    const afterLock = await exportText(page);
    check.ok(afterLock.includes('Hello sealoffice again autosaved'), `text typed without ⌘S is saved by Lock (${afterLock})`);
    await page.locator('.vault-header').getByRole('button', { name: 'Close' }).click();

    // A second tab of the same browser: "open in another tab", then Use here.
    const other = await context.newPage();
    watch(other);
    await other.goto(`${origin}/`);
    await other.getByRole('heading', { name: 'Open in another tab' }).waitFor({ timeout: 30_000 });
    check.ok(true, 'a second tab shows "Open in another tab"');
    await shot(other, '09-other-tab');
    await other.getByRole('button', { name: 'Use here' }).click();
    await other.getByRole('button', { name: 'Unlock', exact: true }).waitFor({ timeout: 60_000 });
    await page.getByRole('heading', { name: 'This vault is now open in another tab' }).waitFor({ timeout: 60_000 });
    check.ok(true, 'Use here moves the vault: the second tab gets the lock screen, the first says it is open elsewhere');
    await page.getByRole('button', { name: 'Use here' }).click();
    await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor({ timeout: 60_000 });
    await other.getByRole('heading', { name: 'This vault is now open in another tab' }).waitFor({ timeout: 60_000 });
    check.ok(true, 'Use here in the first tab takes the vault back');
    await other.close();

    // Forgotten passphrase: the recovery key resets it and the document opens.
    await page.getByRole('button', { name: 'Forgot passphrase? Use the recovery key' }).click();
    await dialog(page).getByLabel('Recovery key', { exact: true }).fill(recoveryKey);
    await dialog(page).getByLabel('New passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog(page).getByLabel('Repeat new passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog(page).getByRole('button', { name: 'Reset passphrase' }).click();
    await waitVaultAndOpen(page);
    await shot(page, '10-recovered');
    check.ok(pageErrors.length === 0, `the recovery key resets the passphrase and the document opens (${pageErrors.join('; ')})`);

    // Back up the vault and make a share link.
    await page.locator('nav.pill').getByRole('button', { name: 'Vault' }).click();
    await page.getByRole('button', { name: 'Back up vault…' }).click();
    await dialog(page).getByLabel('Backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    await dialog(page).getByLabel('Repeat backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    const backingUp = page.waitForEvent('download', { timeout: 60_000 });
    await dialog(page).getByRole('button', { name: 'Back up' }).click();
    const backup = await backingUp;
    const backupPath = join(await backup.path(), '..', backup.suggestedFilename());
    await backup.saveAs(backupPath);
    check.ok(readFileSync(backupPath).subarray(0, AGE_HEADER.length).toString() === AGE_HEADER, `backup is an age file (${backup.suggestedFilename()})`);

    await page.locator('.doc-list .doc').first().getByRole('button', { name: 'Share…' }).click();
    await dialog(page).getByRole('button', { name: 'Link with the key included' }).click();
    await dialog(page).getByRole('button', { name: 'Copy link' }).click();
    await dialog(page).getByText('Copied.').waitFor({ timeout: 10_000 });
    const shareLink = await readClipboard(page);
    check.ok(shareLink.startsWith(`${origin}/#`), `share link points at this app (${shareLink.slice(0, 60)}…)`);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await page.locator('.vault-header').getByRole('button', { name: 'Close' }).click();

    // Restore the backup into a fresh browser.
    const restoredContext = await newContext();
    const restored = await restoredContext.newPage();
    watch(restored);
    await restored.goto(`${origin}/`);
    await restored.locator('#passphrase-repeat').waitFor({ timeout: 60_000 });
    const choosing = restored.waitForEvent('filechooser');
    await restored.getByRole('button', { name: 'Restore a backup…' }).click();
    await (await choosing).setFiles(backupPath);
    await dialog(restored).getByLabel('Backup passphrase', { exact: true }).fill(BACKUP_PASSPHRASE);
    await dialog(restored).getByLabel('New vault passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(restored).getByLabel('Repeat vault passphrase', { exact: true }).fill(PASSPHRASE);
    await dialog(restored).getByRole('button', { name: 'Restore' }).click();
    await storeRecoveryKey(restored);
    await restored.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
    await shot(restored, '11-restored');
    const restoredText = await exportText(restored);
    check.ok(restoredText.includes('Hello sealoffice again autosaved'), `backup restored in a fresh browser holds the document (${restoredText})`);
    await restoredContext.close();

    // Open the share link in another fresh browser: the document is imported.
    const sharedContext = await newContext();
    const shared = await sharedContext.newPage();
    watch(shared);
    await shared.goto(shareLink);
    await createVault(shared, PASSPHRASE);
    await shared.getByRole('heading', { name: 'Shared document' }).waitFor({ timeout: 60_000 });
    await dialog(shared).getByRole('button', { name: 'Save' }).click();
    await dialog(shared).getByRole('heading', { name: 'Saved' }).waitFor({ timeout: 30_000 });
    await dialog(shared).getByRole('button', { name: 'OK' }).click();
    await shared.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
    await shot(shared, '12-shared');
    const sharedText = await exportText(shared);
    check.ok(sharedText.includes('Hello sealoffice again autosaved'), `share link imports the document in another browser (${sharedText})`);
    await sharedContext.close();

    // Passkey: add one, lock, unlock with it.
    await page.locator('nav.pill').getByRole('button', { name: 'Vault' }).click();
    const addPasskey = page.getByRole('button', { name: 'Add passkey…' });
    await addPasskey.waitFor({ timeout: 10_000 }).catch(() => undefined);
    check.ok(await addPasskey.isVisible(), 'vault offers "Add passkey…" with a PRF authenticator');
    if (await addPasskey.isVisible()) {
      await addPasskey.click();
      await dialog(page).getByRole('heading', { name: 'Passkey added' }).waitFor({ timeout: 60_000 });
      await dialog(page).getByRole('button', { name: 'OK' }).click();
      await page.locator('.vault-header').getByRole('button', { name: 'Close' }).click();
      await page.locator('nav.pill').getByRole('button', { name: 'Lock' }).click();
      const withPasskey = page.getByRole('button', { name: 'Unlock with a passkey' });
      await withPasskey.waitFor({ timeout: 60_000 });
      await withPasskey.click();
      await waitVaultAndOpen(page);
      await shot(page, '13-passkey');
      check.ok(true, 'the vault unlocks with the passkey');
      await page.locator('nav.pill').getByRole('button', { name: 'Vault' }).click();
    }

    // History: restore the first version.
    const docRow = page.locator('.doc-list .doc').first();
    await docRow.getByRole('button', { name: 'History' }).click();
    const versions = dialog(page).getByRole('button', { name: 'Restore' });
    await versions.first().waitFor({ timeout: 10_000 });
    check.ok((await versions.count()) >= 2, `history lists the earlier versions (${await versions.count()})`);
    await versions.last().click();
    await dialog(page).getByRole('heading', { name: 'Restore this version?' }).waitFor({ timeout: 30_000 });
    await dialog(page).getByRole('button', { name: 'Restore' }).click();
    await dialog(page).waitFor({ state: 'detached', timeout: 30_000 });
    const historyText = await exportText(page);
    check.ok(historyText.includes('Hello sealoffice') && !historyText.includes('again'), `restoring version 1 brings back the first save (${historyText})`);

    // Live session: host on live.html, a guest in another browser receives the snapshot.
    const forceLocal = process.env.LIVE_RELAYS === 'local';
    const reachable = !forceLocal && (await relaysReachable());
    const relays = new Map<string, LocalRelay>();
    const routeRelays = async (ctx: BrowserContext): Promise<void> => {
      for (const url of RELAYS) {
        await ctx.routeWebSocket(new RegExp(`^${url.replace(/[.]/g, '\\.')}/?$`), (ws) => {
          let relay = relays.get(url);
          if (!relay) {
            relay = new LocalRelay();
            relays.set(url, relay);
          }
          relay.attach(ws);
        });
      }
    };
    console.log(`  live: ${reachable ? 'public Nostr relays' : 'in-process Nostr relay (public relays unreachable or LIVE_RELAYS=local)'}`);
    let guestContext: BrowserContext | null = null;
    try {
      if (!reachable) await routeRelays(context);
      await docRow.getByRole('button', { name: 'Live session…' }).click();
      await dialog(page).getByRole('button', { name: 'Start' }).click();
      await page.waitForURL(/\/live\.html#r=.+&k=.+&h=.+/, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor({ timeout: 60_000 });
      await page.fill('#passphrase', NEW_PASSPHRASE);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      const hostBar = page.locator('nav.live-bar');
      await hostBar.waitFor({ timeout: 120_000 });
      await hostBar.getByRole('button', { name: 'Copy invite link' }).click();
      await hostBar.getByText('Invite link copied.').waitFor({ timeout: 10_000 });
      const invite = await readClipboard(page);
      check.ok(/\/live\.html#r=[^&]+&k=[^&]+$/.test(invite), `invite link has room and key only (${invite.replace(/k=.*/, 'k=…')})`);

      guestContext = await newContext();
      if (!reachable) await routeRelays(guestContext);
      const guest = await guestContext.newPage();
      watch(guest);
      await guest.goto(invite);
      const guestBar = guest.locator('nav.live-bar');
      await guestBar.waitFor({ timeout: 120_000 });
      check.ok(await guestBar.getByRole('button', { name: 'Request the pen' }).isVisible(), 'guest receives the host snapshot and shows the session bar');
      await shot(guest, '14-live-guest');

      await typeInEditor(page, ' live');
      // The pen holder's autosave sends a snapshot every 3 s.
      await page.waitForTimeout(10_000);
      await guestBar.getByRole('button', { name: 'Save a copy in my vault' }).click();
      await guest.locator('#passphrase-repeat').waitFor({ timeout: 60_000 });
      await guest.fill('#passphrase', GUEST_PASSPHRASE);
      await guest.fill('#passphrase-repeat', GUEST_PASSPHRASE);
      await guest.getByRole('button', { name: 'Create vault' }).click();
      await storeRecoveryKey(guest);
      await dialog(guest).getByRole('heading', { name: 'Copy saved' }).waitFor({ timeout: 60_000 });
      await dialog(guest).getByRole('button', { name: 'OK' }).click();
      await guestBar.getByRole('button', { name: 'Leave' }).click();
      await guest.waitForURL(`${origin}/`, { timeout: 30_000 });
      await guest.fill('#passphrase', GUEST_PASSPHRASE);
      await guest.getByRole('button', { name: 'Unlock', exact: true }).click();
      await guest.getByRole('heading', { name: 'Vault' }).waitFor({ timeout: 60_000 });
      const liveText = await exportText(guest);
      check.ok(liveText.includes('Hello sealoffice live'), `guest's copy holds what the host typed live (${liveText})`);
      check.ok(liveSockets.size > 0, `live pages connected to pinned relays only (${[...liveSockets].join(', ')})`);
      if (!reachable) {
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
