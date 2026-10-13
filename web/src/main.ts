// SPDX-License-Identifier: AGPL-3.0-only
// Boot: WebGPU check → lock screen → vault → full-screen editor.
import { buildInfo, showAbout } from './about';
import { Bridge, focusEditor } from './bridge';
import { loadCrypto } from './crypto';
import { assetBase, loadEditor, type EditorModule } from './editor';
import { confirmLock, lockScreen, startAutoLock } from './lock';
import { OpfsStore } from './store';
import { alert, button, errorMessage, h } from './ui';
import { Vault } from './vault';
import { VaultView } from './vaultview';

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

async function hasWebGPU(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return (await gpu?.requestAdapter()) != null;
  } catch {
    return false;
  }
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

async function boot(root: HTMLElement): Promise<void> {
  if (!(await hasWebGPU())) {
    message(root, 'WebGPU required', 'sealoffice needs WebGPU: use a recent Chrome, Edge, or Safari 26+.');
    return;
  }
  const seal = await loadCrypto();
  const vault = new Vault(new OpfsStore(), seal);
  await lockScreen(root, vault);
  startAutoLock(vault);

  const status = progressStatus();
  const editorLoad: Promise<EditorModule> = loadEditor(status.update);
  editorLoad.then(() => status.done(), (error: unknown) => status.done(error));
  const view = new VaultView(vault, seal, () => editorLoad);
  const bridge = new Bridge(vault, view);
  bridge.install();

  let editorOpen = false;
  const toolbar = h(
    'nav',
    { class: 'pill', 'aria-label': 'sealoffice' },
    button('Vault', () => {
      if (editorOpen) void view.show({ choose: false, closable: true }).then(focusEditor);
    }),
    button('Export', () => {
      const id = bridge.current;
      if (!id) {
        void alert('Nothing to export', 'Save the document to the vault first.');
        return;
      }
      view.exportDoc(id).catch((error: unknown) => alert('Export failed', errorMessage(error)));
    }),
    button('Lock', () => void confirmLock(vault, editorOpen)),
    button('About', () => void showAbout()),
  );
  document.body.append(toolbar);

  const first = await view.show({ choose: true, closable: false, status: status.el });
  if (!first) return;
  const editor = await editorLoad;
  bridge.track(first);
  root.replaceChildren();
  editor.run(assetBase(), first.name, first.bytes);
  editorOpen = true;
  toolbar.classList.add('over-editor');
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
