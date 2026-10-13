// SPDX-License-Identifier: AGPL-3.0-only
// Lock screen of a protected library, auto-lock and the key management dialogs.
import { download } from './exporter';
import type { FlushResult } from './autosave';
import { prfSupported, unlockWithPasskey } from './passkey';
import { button, confirm, errorMessage, form, h, modal } from './ui';
import { recoveryKeyFile, type Vault } from './vault';

export const MIN_PASSPHRASE = 10;
const HIDDEN_LOCK_MS = 2 * 60 * 1000;
const IDLE_SETTING = 'sealoffice-idle-minutes';
const DEFAULT_IDLE_MINUTES = 10;

/** Shows the unlock screen of a protected library in `root` until it is unlocked. */
export async function lockScreen(root: HTMLElement, vault: Vault): Promise<void> {
  const passkey = (await vault.passkey()) !== null && (await prfSupported());
  return new Promise<void>((resolve) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const passphrase = h('input', { id: 'passphrase', type: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Unlock');
    const forgot = button('Forgot passphrase? Use the recovery key', () => {
      void recoveryResetDialog(vault).then((reset) => {
        if (!reset) return;
        card.remove();
        resolve();
      });
    }, 'link');
    const lostBoth = button('Lost both? Delete everything and start over', () => {
      error.textContent = '';
      startOverDialog(vault).then((done) => {
        if (!done) return;
        card.remove();
        resolve();
      }, (e: unknown) => {
        error.textContent = errorMessage(e);
      });
    }, 'link');
    const passkeyButton = passkey
      ? button('Unlock with a passkey', () => {
        error.textContent = '';
        unlockWithPasskey(vault).then(() => {
          card.remove();
          resolve();
        }, (e: unknown) => {
          error.textContent = errorMessage(e);
        });
      })
      : null;
    const lockForm = h(
      'form',
      { class: 'form', novalidate: true },
      h('label', { class: 'field', for: 'passphrase' }, h('span', {}, 'Passphrase'), passphrase),
      error,
      h('div', { class: 'actions' }, passkeyButton, submit),
      h('div', { class: 'lock-links' }, forgot, lostBoth),
    );
    const card = h(
      'main',
      { class: 'card lock' },
      h('p', { class: 'brand' }, 'sealoffice'),
      h('h1', {}, 'Library locked'),
      h('p', { class: 'muted' }, 'Your documents are encrypted on this device. Enter your passphrase to open them.'),
      lockForm,
    );
    lockForm.addEventListener('submit', (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = 'Unlocking…';
      // Let the button repaint before scrypt keeps the page busy.
      requestAnimationFrame(() => setTimeout(() => {
        vault.unlock(passphrase.value)
          .then(() => {
            passphrase.value = '';
            card.remove();
            resolve();
          })
          .catch((e: unknown) => {
            error.textContent = errorMessage(e);
            submit.disabled = false;
            submit.textContent = 'Unlock';
            passphrase.select();
          });
      }, 0));
    });
    root.replaceChildren(card);
    passphrase.focus();
  });
}

/** Shows a new recovery key until the user confirms they stored it (no other way out). */
export function recoveryKeyDialog(key: string): Promise<void> {
  return modal<void>('Recovery key', (close, body) => {
    const stored = h('input', { id: 'recovery-stored', type: 'checkbox' });
    const next = button('Continue', () => close(), 'primary');
    next.disabled = true;
    stored.addEventListener('change', () => {
      next.disabled = !stored.checked;
    });
    body.append(
      h('p', { class: 'muted' },
        'This key opens your library if you forget the passphrase. Store it somewhere safe, away from this device: ' +
        'anyone who has it can read your documents. It is shown again only with your passphrase.'),
      ...recoveryKeyControls(key),
      h('label', { class: 'field', for: 'recovery-stored' }, stored, h('span', {}, 'I have stored the recovery key')),
      h('div', { class: 'actions' }, next),
    );
    queueMicrotask(() => stored.focus());
  }, undefined, false);
}

/** The key, plus Copy and Download buttons. */
function recoveryKeyControls(key: string): HTMLElement[] {
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const copy = button('Copy', () => {
    navigator.clipboard.writeText(key).then(
      () => { status.textContent = 'Copied.'; },
      (error: unknown) => { status.textContent = `Could not copy: ${errorMessage(error)}`; },
    );
  });
  const save = button('Download sealoffice-recovery-key.txt', () => {
    download({ name: 'sealoffice-recovery-key.txt', bytes: new TextEncoder().encode(recoveryKeyFile(key)) });
  });
  return [h('pre', { class: 'recovery-key' }, key), h('div', { class: 'actions' }, copy, save), status];
}

/** Settings: shows the recovery key again once the passphrase checks out. */
export async function showRecoveryKeyDialog(vault: Vault): Promise<void> {
  let key = '';
  const values = await form({
    title: 'Show recovery key',
    fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password', autocomplete: 'current-password' }],
    submit: 'Show',
    validate: async (v) => {
      key = await vault.recoveryKey(v.passphrase ?? '');
      return null;
    },
  });
  if (!values) return;
  await modal<void>('Recovery key', (close, body) => {
    const done = button('Done', () => close(), 'primary');
    body.append(
      h('p', {}, 'It opens your library without the passphrase. Keep it away from this device.'),
      ...recoveryKeyControls(key),
      h('div', { class: 'actions' }, done),
    );
    queueMicrotask(() => done.focus());
  }, undefined);
}

/** "Forgot passphrase?": opens the library with the recovery key and sets a new passphrase. */
async function recoveryResetDialog(vault: Vault): Promise<boolean> {
  const values = await form({
    title: 'Use the recovery key',
    text: 'Paste the AGE-SECRET-KEY-1… key, or the content of sealoffice-recovery-key.txt, then choose a new passphrase.',
    fields: [
      { name: 'key', label: 'Recovery key', type: 'password', autocomplete: 'off' },
      { name: 'new', label: 'New passphrase', type: 'password', autocomplete: 'new-password' },
      { name: 'repeat', label: 'Repeat new passphrase', type: 'password', autocomplete: 'new-password' },
    ],
    submit: 'Reset passphrase',
    validate: async (v) => {
      if ((v.new ?? '').length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
      if (v.new !== v.repeat) return 'The new passphrases do not match.';
      await vault.resetWithRecoveryKey(v.key ?? '', v.new ?? '');
      return null;
    },
  });
  return values !== null;
}

/** Asks the browser not to evict the library under storage pressure. */
export async function persistStorage(): Promise<void> {
  if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
    await navigator.storage.persist();
  }
}

let saveBeforeLock: (() => Promise<FlushResult>) | null = null;
let leaving = false;

/** Saves the open document before every lock (the autosaver's flush). */
export function setSaveBeforeLock(flush: () => Promise<FlushResult>): void {
  saveBeforeLock = flush;
}

/** True once the page is reloading on purpose, so no "leave page?" prompt is due. */
export function unloading(): boolean {
  return leaving;
}

/**
 * Saves the open document, then frees the key and reloads, so nothing
 * decrypted survives in the page. When the save cannot happen, `interactive`
 * asks before dropping the changes; otherwise they are dropped.
 */
export async function lockNow(vault: Vault, interactive = true): Promise<void> {
  if (saveBeforeLock) {
    const problem = await saveBeforeLock().then(
      (result) => (result === 'unsavable'
        ? 'The document cannot be saved to the library.'
        : result === 'timeout' ? 'Saving the document did not finish.' : null),
      (error: unknown) => `Saving the document failed: ${errorMessage(error)}`,
    );
    if (problem) {
      console.warn(problem);
      if (interactive && !(await confirm('Lock without saving?', `${problem} Unsaved changes will be lost.`, 'Lock anyway', true))) return;
    }
  }
  leaving = true;
  try {
    await vault.close();
  } finally {
    location.reload();
  }
}

export function idleMinutes(): number {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(IDLE_SETTING);
  } catch {
    // Storage blocked: use the default.
  }
  const minutes = Number(saved);
  return Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : DEFAULT_IDLE_MINUTES;
}

function setIdleMinutes(minutes: number): void {
  try {
    localStorage.setItem(IDLE_SETTING, String(minutes));
  } catch {
    // Storage blocked: the setting lasts for this page only.
  }
}

/**
 * Locks after `idleMinutes()` without input, or after the tab stays hidden for
 * two minutes; only while the library is protected (it can change in Settings).
 */
/** Locks a protected vault after a while idle or hidden; returns a function that stops it. */
export function startAutoLock(vault: Vault): () => void {
  let idleTimer = 0;
  let hiddenTimer = 0;
  const lockIfProtected = (): void => {
    if (vault.isProtected) void lockNow(vault);
  };
  const reset = (): void => {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(lockIfProtected, idleMinutes() * 60 * 1000);
  };
  const onVisibility = (): void => {
    clearTimeout(hiddenTimer);
    if (document.visibilityState === 'hidden') {
      hiddenTimer = window.setTimeout(lockIfProtected, HIDDEN_LOCK_MS);
    }
  };
  const activity = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  for (const type of activity) window.addEventListener(type, reset, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reset();
  return () => {
    clearTimeout(idleTimer);
    clearTimeout(hiddenTimer);
    for (const type of activity) window.removeEventListener(type, reset, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export async function changePassphraseDialog(vault: Vault): Promise<boolean> {
  const values = await form({
    title: 'Change passphrase',
    fields: [
      { name: 'old', label: 'Current passphrase', type: 'password', autocomplete: 'current-password' },
      { name: 'new', label: 'New passphrase', type: 'password', autocomplete: 'new-password' },
      { name: 'repeat', label: 'Repeat new passphrase', type: 'password', autocomplete: 'new-password' },
    ],
    submit: 'Change',
    validate: async (v) => {
      if ((v.new ?? '').length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
      if (v.new !== v.repeat) return 'The new passphrases do not match.';
      await vault.changePassphrase(v.old ?? '', v.new ?? '');
      return null;
    },
  });
  return values !== null;
}

/**
 * "Lost both?": without the passphrase or the recovery key nothing can be
 * decrypted, so the only way out is to erase the library and start an empty,
 * unprotected one. True once that is done.
 */
async function startOverDialog(vault: Vault): Promise<boolean> {
  const values = await form({
    title: 'Delete everything and start over',
    text: 'Without the passphrase or the recovery key, nothing in this library can be recovered. ' +
      'Every document, its version history, the passkey and the settings in this browser are erased for good. ' +
      'Documents linked to files on disk keep those files. Type DELETE to confirm.',
    fields: [{ name: 'confirm', label: 'Confirmation' }],
    submit: 'Delete everything',
    danger: true,
    acknowledge: 'I understand that nothing can be recovered',
    ready: (v) => v.confirm === 'DELETE',
  });
  if (!values) return false;
  await vault.wipe();
  await vault.createUnprotected();
  return true;
}

export async function wipeDialog(vault: Vault): Promise<void> {
  const values = await form({
    title: 'Delete all documents',
    text: 'This permanently deletes every document, its history and the library key from this browser. Type DELETE to confirm.',
    fields: [{ name: 'confirm', label: 'Confirmation' }],
    submit: 'Delete everything',
    danger: true,
    validate: (v) => (v.confirm === 'DELETE' ? null : 'Type DELETE in capital letters.'),
  });
  if (values) {
    await vault.wipe();
    location.reload();
  }
}

export async function autoLockDialog(): Promise<void> {
  await form({
    title: 'Auto-lock',
    text: 'Lock the library after this many minutes without activity.',
    fields: [{ name: 'minutes', label: 'Minutes', type: 'number', value: String(idleMinutes()) }],
    submit: 'Save',
    validate: (v) => {
      const minutes = Number(v.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return 'Enter a whole number from 1 to 240.';
      setIdleMinutes(minutes);
      return null;
    },
  });
}
