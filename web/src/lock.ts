// SPDX-License-Identifier: AGPL-3.0-only
// Lock screen, auto-lock and the vault's key management dialogs.
import { confirm, errorMessage, form, h } from './ui';
import type { Vault } from './vault';

const MIN_PASSPHRASE = 10;
const HIDDEN_LOCK_MS = 2 * 60 * 1000;
const IDLE_SETTING = 'sealoffice-idle-minutes';
const DEFAULT_IDLE_MINUTES = 10;

/** Shows the create/unlock screen in `root` until the vault is unlocked. */
export function lockScreen(root: HTMLElement, vault: Vault): Promise<void> {
  return vault.exists().then((exists) => new Promise<void>((resolve) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const passphrase = h('input', { id: 'passphrase', type: 'password', autocomplete: exists ? 'current-password' : 'new-password', required: true });
    const repeat = h('input', { id: 'passphrase-repeat', type: 'password', autocomplete: 'new-password', required: true });
    const submit = h('button', { type: 'submit', class: 'primary' }, exists ? 'Unlock' : 'Create vault');
    const fields = [h('label', { class: 'field', for: 'passphrase' }, h('span', {}, 'Passphrase'), passphrase)];
    if (!exists) {
      fields.push(h('label', { class: 'field', for: 'passphrase-repeat' }, h('span', {}, 'Repeat passphrase'), repeat));
    }
    const lockForm = h(
      'form',
      { class: 'form', novalidate: true },
      ...fields,
      error,
      h('div', { class: 'actions' }, submit),
    );
    const card = h(
      'main',
      { class: 'card lock' },
      h('h1', {}, 'sealoffice'),
      h('p', { class: 'muted' }, exists
        ? 'Your documents are encrypted on this device. Enter your passphrase to open them.'
        : 'Create a vault: documents are encrypted on this device with a key protected by your passphrase. ' +
          'There is no recovery. If you forget the passphrase, the documents are lost.'),
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
        const action = exists ? vault.unlock(passphrase.value) : vault.create(passphrase.value).then(persistStorage);
        action
          .then(() => {
            passphrase.value = '';
            repeat.value = '';
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
  }));
}

/** Asks the browser not to evict the vault under storage pressure. */
async function persistStorage(): Promise<void> {
  if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
    await navigator.storage.persist();
  }
}

/** Locking frees the key and reloads, so nothing decrypted survives in the page. */
export async function lockNow(vault: Vault): Promise<void> {
  try {
    await vault.close();
  } finally {
    location.reload();
  }
}

export async function confirmLock(vault: Vault, editorOpen: boolean): Promise<void> {
  if (!editorOpen || await confirm('Lock the vault?', 'Unsaved changes in the editor will be lost.', 'Lock')) {
    await lockNow(vault);
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
