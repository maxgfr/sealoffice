// SPDX-License-Identifier: AGPL-3.0-only
// Boot: WebGPU check → library (lock screen only when protected) → home screen
// ⇄ editor screen. The editor starts once per page; Home hides its canvas.
import { buildInfo, showAbout } from './about';
import { AppBar } from './appbar';
import { Bridge, focusEditor } from './bridge';
import { loadCrypto, type SealCrypto } from './crypto';
import { DocActions, hostLive, withExtension } from './docactions';
import { assetBase, type BlankKind, loadEditor, type EditorModule } from './editor';
import { Autosaver } from './autosave';
import { Home, NEW_KINDS } from './home';
import { extension } from './importer';
import { lockNow, lockScreen, persistStorage, setSaveBeforeLock, startAutoLock, unloading } from './lock';
import { protectDialog, settingsDialog } from './settings';
import { OpfsStore } from './store';
import { DiskLinks, diskLinksSupported, IdbHandleStore } from './diskfile';
import { parseShare, type SharedLink } from './share';
import { CHANNEL_NAME, TabGuard } from './tabguard';
import { alert, button, closeMenus, errorMessage, h } from './ui';
import { type DocEntry, Vault } from './vault';
import { type OpenDoc, savedThenRead } from './vaultview';

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL: (url: string) => string }): unknown;
}

/**
 * The CSP requires Trusted Types. Script URLs (service and wasm workers) may
 * only point at this origin or at blob: URLs this origin created.
 */
function installTrustedTypesPolicy(): void {
  const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  factory?.createPolicy('default', {
    createScriptURL: (url) => {
      const parsed = new URL(url, location.href);
      const origin = parsed.protocol === 'blob:' ? new URL(parsed.pathname).origin : parsed.origin;
      if (origin !== location.origin) throw new TypeError(`blocked script URL: ${url}`);
      return url;
    },
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const info = await buildInfo();
  if (!info) return;
  // The version in the URL makes each release install its own cache.
  await navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(info.version)}`, { scope: './' });
}

/** Whether the editor can draw: WebGPU with an adapter, or its WebGL2 fallback. */
async function hasGraphics(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try {
      if ((await gpu.requestAdapter()) != null) return true;
    } catch (error) {
      console.warn('WebGPU unavailable, trying WebGL2:', error);
    }
  }
  return document.createElement('canvas').getContext('webgl2') !== null;
}

const YIELDED_FLAG = 'sealoffice-yielded';

/** Remembers, across the reload that follows, that this tab handed the library to another one. */
function markYielded(): void {
  try {
    sessionStorage.setItem(YIELDED_FLAG, '1');
  } catch (error) {
    console.warn('could not remember the handover:', error);
  }
}

function takeYielded(): boolean {
  try {
    const yielded = sessionStorage.getItem(YIELDED_FLAG) !== null;
    sessionStorage.removeItem(YIELDED_FLAG);
    return yielded;
  } catch (error) {
    console.warn('could not read the handover flag:', error);
    return false;
  }
}

/** Shown while another tab has the library; resolves once this tab has taken it over. */
function otherTabScreen(root: HTMLElement, guard: TabGuard): Promise<void> {
  return new Promise((resolve) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const use = button('Use here', () => {
      use.disabled = true;
      use.textContent = 'Waiting for the other tab…';
      guard.takeOver().then(resolve, (e: unknown) => {
        error.textContent = errorMessage(e);
        use.disabled = false;
        use.textContent = 'Use here';
      });
    }, 'primary');
    root.replaceChildren(h(
      'main',
      { class: 'card lock' },
      h('h1', {}, takeYielded() ? 'sealoffice is now open in another tab' : 'Open in another tab'),
      h('p', { class: 'muted' }, 'sealoffice works in one tab at a time. Using it here saves and closes the other tab.'),
      error,
      h('div', { class: 'actions' }, use),
    ));
    use.focus();
  });
}

function message(root: HTMLElement, title: string, text: string): void {
  root.replaceChildren(h('main', { class: 'card lock' }, h('h1', {}, title), h('p', {}, text)));
}

function progressStatus(): { el: HTMLElement; update: (fraction: number | null) => void; done: (error?: unknown) => void } {
  const bar = h('div', { class: 'progress-bar' });
  const label = h('span', {}, 'Loading the editor…');
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Editor download' }, bar);
  const el = h('div', { class: 'editor-status muted small', 'aria-live': 'polite' }, label, progress);
  return {
    el,
    update: (fraction) => {
      if (fraction === null) {
        progress.classList.add('indeterminate');
        return;
      }
      bar.style.width = `${Math.round(fraction * 100)}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    },
    done: (error) => {
      if (error) {
        label.textContent = `The editor could not be loaded: ${errorMessage(error)}`;
        progress.remove();
      } else {
        el.remove();
      }
    },
  };
}

/** Takes a share link out of the address bar (so it is not kept in history) and parses it. */
function takeShareLink(): { link: SharedLink | null; error: unknown } {
  if (!/^#[sk]=/.test(location.hash)) return { link: null, error: null };
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    return { link: parseShare(hash), error: null };
  } catch (error) {
    return { link: null, error };
  }
}

/** Disk links where the browser supports them (Chrome, Edge). */
async function loadDiskLinks(vault: Vault, seal: SealCrypto): Promise<DiskLinks | null> {
  if (!diskLinksSupported()) return null;
  const links = new DiskLinks(new IdbHandleStore(), vault, seal);
  await links.load();
  return links;
}

/** Once the library is open: offers to store the shared document. */
async function receiveShare(actions: DocActions, shared: { link: SharedLink | null; error: unknown }): Promise<void> {
  try {
    if (shared.error) throw shared.error;
    if (shared.link) await actions.receiveShared(shared.link);
  } catch (error) {
    console.error(error);
    await alert('Could not open the shared document', errorMessage(error));
  }
}

/**
 * One active tab, then the library: created unprotected on first launch,
 * opened at once when unprotected, through the lock screen in `root` when protected.
 */
async function openVault(root: HTMLElement): Promise<{ vault: Vault; seal: SealCrypto }> {
  const guard = new TabGuard(navigator.locks, new BroadcastChannel(CHANNEL_NAME));
  if (!(await guard.acquire())) await otherTabScreen(root, guard);
  takeYielded();
  const seal = await loadCrypto();
  const vault = new Vault(new OpfsStore(), seal);
  guard.setYieldHandler(async () => {
    markYielded();
    await lockNow(vault, false);
  });
  const state = await vault.state();
  if (state === 'none') {
    await vault.createUnprotected();
    await persistStorage().catch((error: unknown) => console.warn('persistent storage unavailable:', error));
  } else if (state === 'open') {
    await vault.openUnprotected();
  } else {
    await lockScreen(root, vault);
  }
  startAutoLock(vault);
  return { vault, seal };
}

/** live.html: a live session page (its CSP allows the pinned relays). */
function isLivePage(): boolean {
  return location.pathname.endsWith('/live.html');
}

async function boot(root: HTMLElement): Promise<void> {
  const graphics = await hasGraphics();
  if (isLivePage()) {
    // Split into its own chunk: index.html never loads the network code.
    const { bootLive } = await import('./live/ui');
    await bootLive(root, { graphics, openVault });
    return;
  }
  const shared = takeShareLink();
  const { vault, seal } = await openVault(root);
  root.replaceChildren();
  const actions = new DocActions(vault, seal);
  const links = await loadDiskLinks(vault, seal);
  if (links) actions.attachDiskLinks(links);

  const status = graphics ? progressStatus() : null;
  const editorLoad: Promise<EditorModule> = graphics
    ? loadEditor((fraction) => status?.update(fraction))
    : Promise.reject(new Error('editing is unavailable in this browser'));
  // The progress line reports a failed download; callers get the rejection too.
  editorLoad.then(() => status?.done(), (error: unknown) => status?.done(error));

  let running: EditorModule | null = null;
  let autosaver: Autosaver | null = null;
  const bridge = new Bridge(vault, async () => {
    // File > Open in the editor: the documents are on the home screen.
    await goHome();
    return null;
  });
  const changed = (): void => {
    home.refresh();
    appbar.refresh();
  };
  actions.onRemoved(changed);
  const home: Home = new Home(vault, actions, {
    graphics,
    create: (kind) => createDoc(kind),
    createLive: (kind) => createLiveDoc(kind),
    open: (entry) => openEntry(entry),
    settings: () => settingsDialog(vault, actions, { changed }),
    about: showAbout,
    lockLibrary: () => lockNow(vault),
    protect: async () => {
      if (await protectDialog(vault)) changed();
    },
  });
  const appbar = new AppBar(vault, actions, {
    home: () => goHome(),
    current: () => {
      const id = bridge.current;
      return id === null ? undefined : vault.entry(id);
    },
    currentName: () => bridge.currentName,
    rename: (entry, name) => renameOpen(entry, name),
    lockLibrary: () => lockNow(vault),
    about: showAbout,
  });
  if (status) home.showStatus(status.el);

  /** Shows the editor's canvas and the app bar. */
  const showEditor = (): void => {
    closeMenus();
    home.hide();
    document.body.classList.remove('at-home');
    appbar.show();
    focusEditor();
  };
  /** Shows Home; the open document's card is marked with its save state. */
  const showHome = (state = ''): void => {
    closeMenus();
    document.body.classList.add('at-home');
    appbar.hide();
    home.markOpen(bridge.current, state);
    home.show();
  };
  /** Saves the open document, then shows Home; a locked document's key is forgotten. */
  async function goHome(): Promise<void> {
    // The editor may still call itself modified just after a save: the flush result decides.
    const flushed = autosaver ? await autosaver.flush().then((r) => r === 'saved' || r === 'clean', () => false) : true;
    if (!flushed && !(await actions.saveOpenDoc('Leave'))) return;
    const id = bridge.current;
    if (id !== null && vault.entry(id)?.lock) vault.forgetDocKeys();
    showHome(autosaver ? (flushed ? 'Saved' : 'Not saved') : '');
  }
  /** Hands `doc` to the editor, starting it on the first document. */
  async function openInEditor(doc: OpenDoc): Promise<void> {
    const editor = await editorLoad;
    bridge.track(doc);
    if (running) {
      editor.open_bytes(doc.name, doc.bytes);
    } else {
      editor.run(assetBase(), doc.name, doc.bytes);
      running = editor;
      autosaver = startAutosave(editor, bridge, appbar);
      actions.attachEditor({
        autosaver,
        currentId: () => bridge.current,
        editing: () => (document.body.classList.contains('at-home') ? null : bridge.current),
        open: (opened) => {
          bridge.track(opened);
          editor.open_bytes(opened.name, opened.bytes);
        },
      });
    }
    showEditor();
  }
  async function openEntry(entry: DocEntry): Promise<void> {
    // The key of a locked `entry` is kept only if it ends up on screen in the editor.
    await actions.withDoc(entry, async () => {
      // Saved first: when `entry` is the open document, its latest changes are read back.
      const doc = await savedThenRead({ id: entry.id, name: entry.name, bytes: new Uint8Array() },
        () => actions.saveOpenDoc('Open'), (id) => vault.read(id));
      if (doc) await openInEditor(doc);
    });
  }
  /** A blank document, stored in the library under a free name, then opened. */
  async function createDoc(kind: BlankKind): Promise<void> {
    const editor = await editorLoad;
    if (!(await actions.saveOpenDoc('Create'))) return;
    const base = NEW_KINDS.find((k) => k.kind === kind)?.name ?? `Document.${kind}`;
    const bytes = editor.blank_file(kind);
    const entry = await vault.write(vault.uniqueName(base), bytes);
    await openInEditor({ id: entry.id, name: entry.name, bytes });
  }
  /** A blank document, stored in the library under a free name, then hosted in a new live session. */
  async function createLiveDoc(kind: BlankKind): Promise<void> {
    const editor = await editorLoad;
    if (!(await actions.saveOpenDoc('Create'))) return;
    const base = NEW_KINDS.find((k) => k.kind === kind)?.name ?? `Document.${kind}`;
    const entry = await vault.write(vault.uniqueName(base), editor.blank_file(kind));
    hostLive(entry.id);
  }
  /** Renames the open document: saved first, then shown again under its new name (the editor saves by name). */
  async function renameOpen(entry: DocEntry, name: string): Promise<void> {
    if (!(await actions.saveOpenDoc('Rename'))) return;
    const renamed = await vault.rename(entry.id, withExtension(name, extension(entry.name)) ?? entry.name);
    const bytes = await vault.read(renamed.id);
    await openInEditor({ id: renamed.id, name: renamed.name, bytes });
  }

  bridge.install();
  if (links) bridge.setAfterSave((id, bytes) => links.write(id, bytes));
  showHome();
  await receiveShare(actions, shared);
  home.refresh();
}

/** The app bar's words for the open document's save state. */
function saveStateText(autosaver: Autosaver, bridge: Bridge, failure: string | null): string {
  if (failure) return 'Not saved';
  if (bridge.saving) return 'Saving…';
  return autosaver.dirty ? 'Unsaved changes' : 'Saved';
}

/** Autosave, saving before lock and on hide, the leave-page guard and the app bar's save state. */
function startAutosave(editor: EditorModule, bridge: Bridge, appbar: AppBar): Autosaver {
  const autosaver = new Autosaver(editor, bridge.saved);
  let failure: string | null = null;
  const report = (error: unknown): void => {
    console.error('automatic save failed:', error);
    failure = errorMessage(error);
    showState();
  };
  const showState = (): void => {
    if (!autosaver.dirty && !bridge.saving) failure = null;
    appbar.showState(saveStateText(autosaver, bridge, failure), failure ?? '');
  };
  autosaver.start(report);
  setSaveBeforeLock(() => autosaver.flush());
  // ⌘S failures are shown by the editor itself; this only refreshes the state.
  bridge.saved.subscribe(showState);
  window.setInterval(showState, 1000);
  showState();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    autosaver.flush().then((result) => {
      if (result === 'timeout') report(new Error('the save did not finish'));
    }, report);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!unloading() && autosaver.dirty) event.preventDefault();
  });
  return autosaver;
}

installTrustedTypesPolicy();
const root = document.getElementById('app');
if (root) {
  registerServiceWorker().catch((error: unknown) => console.warn('offline cache unavailable:', error));
  boot(root).catch((error: unknown) => {
    console.error(error);
    message(root, 'Could not start', errorMessage(error));
  });
}
