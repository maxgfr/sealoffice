// SPDX-License-Identifier: AGPL-3.0-only
// Lock screen, auto-lock and the vault's key management dialogs.
import { download } from './exporter';
import type { FlushResult } from './autosave';
import { restoreIntoNewVault } from './backup';
import type { SealCrypto } from './crypto';
import { prfSupported, unlockWithPasskey } from './passkey';
import { button, confirm, errorMessage, form, h, modal, pickLocalFile } from './ui';
import { recoveryKeyFile, type Vault } from './vault';

const MIN_PASSPHRASE = 10;
const HIDDEN_LOCK_MS = 2 * 60 * 1000;
const IDLE_SETTING = 'sealoffice-idle-minutes';
const DEFAULT_IDLE_MINUTES = 10;

/** Shows the create/unlock screen in `root` until the vault is unlocked. */
export async function lockScreen(root: HTMLElement, vault: Vault, seal: SealCrypto): Promise<void> {
  const exists = await vault.exists();
  const passkey = exists && (await vault.passkey()) !== null && (await prfSupported());
  return new Promise<void>((resolve) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const passphrase = h('input', { id: 'passphrase', type: 'password', autocomplete: exists ? 'current-password' : 'new-password', required: true });
    const repeat = h('input', { id: 'passphrase-repeat', type: 'password', autocomplete: 'new-password', required: true });
    const submit = h('button', { type: 'submit', class: 'primary' }, exists ? 'Unlock' : 'Create vault');
    const fields = [h('label', { class: 'field', for: 'passphrase' }, h('span', {}, 'Passphrase'), passphrase)];
    if (!exists) {
      fields.push(h('label', { class: 'field', for: 'passphrase-repeat' }, h('span', {}, 'Repeat passphrase'), repeat));
    }
    const forgot = exists
      ? button('Forgot passphrase? Use the recovery key', () => {
        void recoveryResetDialog(vault).then((reset) => {
          if (!reset) return;
          card.remove();
          resolve();
        });
      }, 'link')
      : button('Restore a backup…', () => {
        void restoreNewVaultDialog(vault, seal).then(async (secret) => {
          if (secret === null) return;
          await recoveryKeyCard(root, await vault.recoveryKey(secret));
          card.remove();
          resolve();
        }).catch((e: unknown) => {
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
      ...fields,
      error,
      h('div', { class: 'actions' }, forgot, passkeyButton, submit),
    );
    const card = h(
      'main',
      { class: 'card lock' },
      h('h1', {}, 'sealoffice'),
      h('p', { class: 'muted' }, exists
        ? 'Your documents are encrypted on this device. Enter your passphrase to open them.'
        : 'Create a vault: documents are encrypted on this device with a key protected by your passphrase. ' +
          'You will get a recovery key next: it is the only way back in if you forget the passphrase.'),
      lockForm,
    );
    lockForm.addEventListener('submit', (event) => {
      event.preventDefault();
      error.textContent = '';
      if (!exists && passphrase.value.length < MIN_PASSPHRASE) {
        error.textContent = `Use at least ${MIN_PASSPHRASE} characters.`;
        return;
      }
      if (!exists && passphrase.value !== repeat.value) {
        error.textContent = 'The passphrases do not match.';
        return;
      }
      submit.disabled = true;
      submit.textContent = exists ? 'Unlocking…' : 'Creating…';
      // Let the button repaint before scrypt keeps the page busy.
      requestAnimationFrame(() => setTimeout(() => {
        const secret = passphrase.value;
        const action: Promise<string | null> = exists
          ? vault.unlock(secret).then(() => null)
          : vault.create(secret).then(persistStorage).then(() => vault.recoveryKey(secret));
        action
          .then(async (key) => {
            passphrase.value = '';
            repeat.value = '';
            if (key !== null) await recoveryKeyCard(root, key);
            card.remove();
            resolve();
          })
          .catch((e: unknown) => {
            error.textContent = errorMessage(e);
            submit.disabled = false;
            submit.textContent = exists ? 'Unlock' : 'Create vault';
            passphrase.select();
          });
      }, 0));
    });
    root.replaceChildren(card);
    passphrase.focus();
  });
}

/** Shows the new vault's recovery key in `root` until the user confirms they stored it. */
function recoveryKeyCard(root: HTMLElement, key: string): Promise<void> {
  return new Promise((resolve) => {
    const stored = h('input', { id: 'recovery-stored', type: 'checkbox' });
    const next = button('Continue', () => resolve(), 'primary');
    next.disabled = true;
    stored.addEventListener('change', () => {
      next.disabled = !stored.checked;
    });
    root.replaceChildren(h(
      'main',
      { class: 'card lock' },
      h('h1', {}, 'Recovery key'),
      h('p', { class: 'muted' },
        'This key opens your vault if you forget the passphrase. Store it somewhere safe, away from this device: ' +
        'anyone who has it can read your documents. It is shown again only with your passphrase.'),
      ...recoveryKeyControls(key),
      h('label', { class: 'field', for: 'recovery-stored' }, stored, h('span', {}, 'I have stored the recovery key')),
      h('div', { class: 'actions' }, next),
    ));
    stored.focus();
  });
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
      h('p', {}, 'It opens your vault without the passphrase. Keep it away from this device.'),
      ...recoveryKeyControls(key),
      h('div', { class: 'actions' }, done),
    );
    queueMicrotask(() => done.focus());
  }, undefined);
}

/**
 * No vault yet: creates one from a backup file with a new passphrase.
 * Resolves to that passphrase, or null when cancelled.
 */
async function restoreNewVaultDialog(vault: Vault, seal: SealCrypto): Promise<string | null> {
  const file = await pickLocalFile('.age');
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const values = await form({
    title: 'Restore a backup',
    text: `Creates a vault with the documents of "${file.name}".`,
    fields: [
      { name: 'backup', label: 'Backup passphrase', type: 'password', autocomplete: 'off' },
      { name: 'new', label: 'New vault passphrase', type: 'password', autocomplete: 'new-password' },
      { name: 'repeat', label: 'Repeat vault passphrase', type: 'password', autocomplete: 'new-password' },
    ],
    submit: 'Restore',
    validate: async (v) => {
      if ((v.new ?? '').length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
      if (v.new !== v.repeat) return 'The passphrases do not match.';
      await restoreIntoNewVault(vault, bytes, v.backup ?? '', v.new ?? '', seal);
      await persistStorage();
      return null;
    },
  });
  return values ? (values.new ?? '') : null;
}

/** "Forgot passphrase?": opens the vault with the recovery key and sets a new passphrase. */
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

/** Asks the browser not to evict the vault under storage pressure. */
async function persistStorage(): Promise<void> {
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
        ? 'The document cannot be saved to the vault.'
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

/** Locks after `idleMinutes()` without input, or after the tab stays hidden for two minutes. */
export function startAutoLock(vault: Vault): void {
  let idleTimer = 0;
  let hiddenTimer = 0;
  const reset = (): void => {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => void lockNow(vault), idleMinutes() * 60 * 1000);
  };
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, reset, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (document.visibilityState === 'hidden') {
      hiddenTimer = window.setTimeout(() => void lockNow(vault), HIDDEN_LOCK_MS);
    }
  });
  reset();
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

export async function wipeDialog(vault: Vault): Promise<void> {
  const values = await form({
    title: 'Wipe vault',
    text: 'This permanently deletes every document and the vault key from this browser. Type WIPE to confirm.',
    fields: [{ name: 'confirm', label: 'Confirmation' }],
    submit: 'Wipe everything',
    danger: true,
    validate: (v) => (v.confirm === 'WIPE' ? null : 'Type WIPE in capital letters.'),
  });
  if (values) {
    await vault.wipe();
    location.reload();
  }
}

export async function autoLockDialog(): Promise<void> {
  await form({
    title: 'Auto-lock',
    text: 'Lock the vault after this many minutes without activity.',
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
