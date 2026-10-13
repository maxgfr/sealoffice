// SPDX-License-Identifier: AGPL-3.0-only
// Boot: WebGPU check → lock screen → vault → full-screen editor.
import { buildInfo, showAbout } from './about';
import { Bridge, focusEditor } from './bridge';
import { loadCrypto, type SealCrypto } from './crypto';
import { assetBase, loadEditor, type EditorModule } from './editor';
import { Autosaver } from './autosave';
import { lockNow, lockScreen, setSaveBeforeLock, startAutoLock, unloading } from './lock';
import { OpfsStore } from './store';
import { DiskLinks, diskLinksSupported, IdbHandleStore } from './diskfile';
import { parseShare, type SharedLink } from './share';
import { CHANNEL_NAME, TabGuard } from './tabguard';
import { alert, button, errorMessage, h } from './ui';
import { Vault } from './vault';
import { savedThenRead, VaultView } from './vaultview';

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

/** Remembers, across the reload that follows, that this tab handed the vault to another one. */
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

/** Shown while another tab has the vault; resolves once this tab has taken it over. */
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
      h('h1', {}, takeYielded() ? 'This vault is now open in another tab' : 'Open in another tab'),
      h('p', { class: 'muted' }, 'sealoffice works in one tab at a time. Using it here saves and locks the other tab.'),
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

/** Once the vault is open: offers to store the shared document. */
async function receiveShare(view: VaultView, shared: { link: SharedLink | null; error: unknown }): Promise<void> {
  try {
    if (shared.error) throw shared.error;
    if (shared.link) await view.receiveShared(shared.link);
  } catch (error) {
    console.error(error);
    await alert('Could not open the shared document', errorMessage(error));
  }
}

/** One active tab, then the lock screen in `root`: resolves once the vault is open. */
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
  await lockScreen(root, vault, seal);
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

  if (!graphics) {
    // Vault-only mode: the editor is never downloaded.
    const view = new VaultView(vault, seal, () => Promise.reject(new Error('editing is unavailable in this browser')));
    view.disableEditing();
    const links = await loadDiskLinks(vault, seal);
    if (links) view.attachDiskLinks(links);
    await receiveShare(view, shared);
    document.body.append(h(
      'nav',
      { class: 'pill', 'aria-label': 'sealoffice' },
      button('Lock', () => void lockNow(vault)),
      button('About', () => void showAbout()),
    ));
    await view.show({ choose: true, closable: false });
    return;
  }

  const status = progressStatus();
  const editorLoad: Promise<EditorModule> = loadEditor(status.update);
  editorLoad.then(() => status.done(), (error: unknown) => status.done(error));
  const view = new VaultView(vault, seal, () => editorLoad);
  const bridge = new Bridge(vault, view);
  bridge.install();
  const links = await loadDiskLinks(vault, seal);
  if (links) {
    view.attachDiskLinks(links);
    bridge.setAfterSave((id, bytes) => links.write(id, bytes));
  }
  await receiveShare(view, shared);

  let running: EditorModule | null = null;
  /** Vault in choose mode: the picked document replaces the open one, once that one is saved. */
  const switchDocument = async (editor: EditorModule): Promise<void> => {
    const picked = await view.show({ choose: true, closable: true });
    const doc = picked && (await savedThenRead(picked, () => view.saveOpenDoc('Open'), (id) => vault.read(id)));
    if (doc) {
      bridge.track(doc);
      editor.open_bytes(doc.name, doc.bytes);
    }
    focusEditor();
  };
  const saveState = h('span', { class: 'muted small', role: 'status' });
  const toolbar = h(
    'nav',
    { class: 'pill', 'aria-label': 'sealoffice' },
    button('Vault', () => {
      if (running) switchDocument(running).catch((error: unknown) => alert('Could not open the document', errorMessage(error)));
    }),
    button('Export', () => {
      const exportOpen = async (): Promise<void> => {
        // A never-saved document gets its vault id from this save.
        if (!(await view.saveOpenDoc('Export'))) return;
        const id = bridge.current;
        if (!id) {
          await alert('Nothing to export', 'Save the document to the vault first.');
          return;
        }
        await view.exportDoc(id);
      };
      exportOpen().catch((error: unknown) => alert('Export failed', errorMessage(error)));
    }),
    button('Lock', () => void lockNow(vault)),
    button('About', () => void showAbout()),
    saveState,
  );
  document.body.append(toolbar);

  const first = await view.show({ choose: true, closable: false, status: status.el });
  if (!first) return;
  const editor = await editorLoad;
  bridge.track(first);
  root.replaceChildren();
  editor.run(assetBase(), first.name, first.bytes);
  running = editor;
  toolbar.classList.add('over-editor');
  const autosaver = startAutosave(editor, bridge, saveState);
  view.attachEditor({
    autosaver,
    currentId: () => bridge.current,
    open: (doc) => {
      bridge.track(doc);
      editor.open_bytes(doc.name, doc.bytes);
    },
  });
}

/** Autosave, saving before lock and on hide, the leave-page guard and the toolbar's save state. */
function startAutosave(editor: EditorModule, bridge: Bridge, saveState: HTMLElement): Autosaver {
  const autosaver = new Autosaver(editor, bridge.saved);
  let failure: string | null = null;
  const report = (error: unknown): void => {
    console.error('automatic save failed:', error);
    failure = errorMessage(error);
    showState();
  };
  const showState = (): void => {
    const dirty = autosaver.dirty;
    if (!dirty) failure = null;
    saveState.textContent = failure ? 'Not saved' : dirty ? 'Modified' : 'Saved';
    saveState.title = failure ?? '';
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
