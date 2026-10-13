// SPDX-License-Identifier: AGPL-3.0-only
// The Settings dialog: how the library is protected (passphrase, recovery key,
// passkey, auto-lock), backup and restore, storage, and deleting everything.
import type { DocActions } from './docactions';
import {
  autoLockDialog, changePassphraseDialog, MIN_PASSPHRASE, persistStorage, recoveryKeyDialog, showRecoveryKeyDialog, wipeDialog,
} from './lock';
import { prfSupported, registerPasskey } from './passkey';
import { alert, button, confirm, errorMessage, form, formatSize, h, modal } from './ui';
import type { Vault } from './vault';

/** Protects the library with a new passphrase, then shows its recovery key; true when protected. */
export async function protectDialog(vault: Vault): Promise<boolean> {
  let key = '';
  const values = await form({
    title: 'Protect with a passphrase',
    text: 'Every document is encrypted again with a new key, protected by this passphrase. sealoffice will ask for it ' +
      'each time it starts, and lock after a while without activity. You get a recovery key next.',
    fields: [
      { name: 'new', label: 'Passphrase', type: 'password', autocomplete: 'new-password' },
      { name: 'repeat', label: 'Repeat passphrase', type: 'password', autocomplete: 'new-password' },
    ],
    submit: 'Protect',
    validate: async (v) => {
      if ((v.new ?? '').length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
      if (v.new !== v.repeat) return 'The passphrases do not match.';
      key = await vault.protect(v.new ?? '');
      return null;
    },
  });
  if (!values) return false;
  await recoveryKeyDialog(key);
  return true;
}

/** Goes back to an unprotected library once the passphrase checks out; true when done. */
async function unprotectDialog(vault: Vault): Promise<boolean> {
  const values = await form({
    title: 'Remove protection',
    text: 'The library key is then stored without a passphrase: anyone using this browser profile can open these documents. ' +
      'The passkey and the recovery key stop working. Documents locked with their own passphrase stay locked.',
    fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password', autocomplete: 'current-password' }],
    acknowledge: 'I understand that the documents will no longer be protected',
    submit: 'Remove protection',
    danger: true,
    validate: async (v) => {
      await vault.unprotect(v.passphrase ?? '');
      return null;
    },
  });
  return values !== null;
}

/** What Settings asks of the page: refreshing the screens after the protection changed. */
export interface SettingsHost {
  changed(): void;
}

export function settingsDialog(vault: Vault, actions: DocActions, host: SettingsHost): Promise<void> {
  return modal<void>('Settings', (close, body) => {
    const run = (action: () => Promise<unknown>): void => actions.run(action);
    const protection = h('section', { class: 'settings-section', 'aria-labelledby': 'settings-protection' });
    const storage = h('p', { class: 'muted small' });
    const renderProtection = async (): Promise<void> => {
      const heading = h('h3', { id: 'settings-protection' }, 'Protection');
      if (!vault.isProtected) {
        protection.replaceChildren(
          heading,
          h('p', {}, h('strong', {}, 'Not protected'), ': anyone using this browser profile can open these documents.'),
          h('div', { class: 'settings-actions' }, button('Protect with a passphrase…', () => run(async () => {
            if (!(await protectDialog(vault))) return;
            host.changed();
            await renderProtection();
          }), 'primary')),
        );
        return;
      }
      const passkeyButton = await passkeySetting(vault, run);
      protection.replaceChildren(
        heading,
        h('p', {}, h('strong', {}, 'Protected'), ' with a passphrase. sealoffice locks after a while without activity.'),
        h('div', { class: 'settings-actions' },
          button('Change passphrase…', () => run(async () => {
            if (await changePassphraseDialog(vault)) await alert('Passphrase changed', 'Use the new passphrase from now on.');
          })),
          button('Show recovery key…', () => run(() => showRecoveryKeyDialog(vault))),
          passkeyButton,
          button('Auto-lock…', () => run(autoLockDialog)),
          button('Remove protection…', () => run(async () => {
            if (!(await unprotectDialog(vault))) return;
            host.changed();
            await renderProtection();
          }), 'danger-link'),
        ),
      );
    };
    const renderStorage = async (): Promise<void> => {
      if (!navigator.storage?.estimate) return;
      const { usage, quota } = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      storage.replaceChildren(
        `${formatSize(usage ?? 0)} used of ${formatSize(quota ?? 0)}. `,
        persisted
          ? 'Persistent: the browser will not evict it.'
          : 'Not persistent: the browser may evict it when space runs low. ',
      );
      if (!persisted && 'persist' in navigator.storage) {
        storage.append(button('Make persistent', () => run(async () => {
          await persistStorage();
          if (!(await navigator.storage.persisted())) {
            await alert('Not granted', 'The browser declined. Installing the app or bookmarking the page can help; keep backups either way.');
          }
          await renderStorage();
        }), 'link'));
      }
    };
    const done = button('Done', () => close(), 'primary');
    body.append(
      protection,
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Backup & restore'),
        h('p', { class: 'muted small' }, 'A backup is one file, encrypted with a passphrase you choose.'),
        h('div', { class: 'settings-actions' },
          button('Back up library…', () => run(() => actions.backup())),
          button('Restore a backup…', () => run(async () => {
            if (await actions.restore()) host.changed();
          })))),
      h('section', { class: 'settings-section' }, h('h3', {}, 'Storage'), storage),
      h('section', { class: 'settings-section' },
        h('h3', {}, 'Delete all documents'),
        h('div', { class: 'settings-actions' }, button('Delete all documents…', () => run(() => wipeDialog(vault)), 'danger-link'))),
      h('div', { class: 'actions' }, done),
    );
    renderProtection().catch((error: unknown) => {
      protection.replaceChildren(h('p', { class: 'form-error' }, errorMessage(error)));
    });
    renderStorage().catch((error: unknown) => console.warn('storage estimate unavailable:', error));
    queueMicrotask(() => done.focus());
  }, undefined);
}

/** "Add passkey…" or "Remove passkey", when this browser supports PRF. */
async function passkeySetting(vault: Vault, run: (action: () => Promise<unknown>) => void): Promise<HTMLElement | null> {
  if (!(await prfSupported())) return null;
  const has = (await vault.passkey()) !== null;
  const el: HTMLElement = has
    ? button('Remove passkey', () => run(async () => {
      if (!(await confirm('Remove the passkey?', 'The library will open with the passphrase only.', 'Remove', true))) return;
      await vault.removePasskey();
      el.replaceWith(h('span', { class: 'muted small' }, 'Passkey removed.'));
    }))
    : button('Add passkey…', () => run(async () => {
      await registerPasskey(vault);
      el.replaceWith(h('span', { class: 'muted small' }, 'Passkey added.'));
      await alert('Passkey added', 'The lock screen now offers to unlock with this passkey.');
    }));
  return el;
}
