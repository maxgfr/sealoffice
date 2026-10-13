// SPDX-License-Identifier: AGPL-3.0-only
// The vault screen: document list, new, import, export, rename, delete.
import type { SealCrypto } from './crypto';
import type { BlankKind, EditorModule } from './editor';
import { canOfficeProtect, download, exportDocument, type ExportFormat } from './exporter';
import { ACCEPT, extension, importFile, isDocumentName, type AskSecret } from './importer';
import { autoLockDialog, changePassphraseDialog, wipeDialog } from './lock';
import { alert, button, confirm, errorMessage, form, formatDate, formatSize, h, modal, pickLocalFile } from './ui';
import type { DocEntry, Vault } from './vault';

/** A document to open in the editor; `id` is null until it is first saved. */
export interface OpenDoc {
  id: string | null;
  name: string;
  bytes: Uint8Array;
}

const NEW_KINDS: [BlankKind, string, string][] = [
  ['docx', 'New document', 'Document.docx'],
  ['xlsx', 'New spreadsheet', 'Spreadsheet.xlsx'],
  ['pptx', 'New presentation', 'Presentation.pptx'],
];

export class VaultView {
  private overlay: HTMLElement | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly seal: SealCrypto,
    private readonly editor: () => Promise<EditorModule>,
  ) {}

  /**
   * Shows the vault. With `choose`, documents can be opened and the promise
   * resolves to the chosen one; without it, only managed (null on close).
   */
  show(options: { choose: boolean; closable: boolean; status?: HTMLElement }): Promise<OpenDoc | null> {
    this.close();
    return new Promise((resolve) => {
      const done = (doc: OpenDoc | null): void => {
        this.close();
        resolve(doc);
      };
      const list = h('ul', { class: 'doc-list', 'aria-label': 'Documents' });
      const refresh = (): void => this.renderList(list, options.choose ? done : null, refresh);
      const header = h(
        'header',
        { class: 'vault-header' },
        h('h1', {}, 'Vault'),
        options.closable ? button('Close', () => done(null)) : null,
      );
      const create = options.choose
        ? h('div', { class: 'new-row' }, ...NEW_KINDS.map(([kind, label, name]) =>
          button(label, () => this.run(() => this.newDoc(kind, name).then(done)))))
        : null;
      const importButton = button('Import file…', () => this.run(async () => {
        const entry = await this.importDoc();
        if (!entry) return;
        if (options.choose) {
          done({ id: entry.id, name: entry.name, bytes: await this.vault.read(entry.id) });
        } else {
          refresh();
        }
      }));
      const footer = h(
        'footer',
        { class: 'vault-footer' },
        button('Change passphrase', () => this.run(async () => {
          if (await changePassphraseDialog(this.vault)) await alert('Passphrase changed', 'Use the new passphrase from now on.');
        })),
        button('Auto-lock…', () => this.run(autoLockDialog)),
        button('Wipe vault…', () => this.run(() => wipeDialog(this.vault)), 'danger-link'),
      );
      const panel = h(
        'section',
        { class: 'card vault', 'aria-labelledby': 'vault-title' },
        header,
        options.status ?? null,
        create,
        h('div', { class: 'toolbar-row' }, importButton),
        list,
        footer,
      );
      header.querySelector('h1')?.setAttribute('id', 'vault-title');
      this.overlay = h('div', { class: 'overlay' }, panel);
      if (options.closable) {
        this.overlay.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') done(null);
        });
      }
      document.body.append(this.overlay);
      refresh();
      panel.querySelector<HTMLElement>('button')?.focus();
    });
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  /** Exports the saved version of `id` after asking for the format. */
  async exportDoc(id: string): Promise<void> {
    const entry = this.vault.entry(id);
    if (!entry) throw new Error('no such document');
    const format = await modal<ExportFormat | null>(`Export "${entry.name}"`, (close, body) => {
      body.append(
        h('p', {}, 'Exports the last saved version.'),
        h('div', { class: 'choices' },
          button('Encrypted .age file (passphrase)', () => close('age'), 'primary'),
          canOfficeProtect(entry.name) ? button('Password-protected Office file', () => close('office')) : null,
          button('Unencrypted file…', () => close('plain'), 'danger-link'),
        ),
        h('div', { class: 'actions' }, button('Cancel', () => close(null))),
      );
    }, null);
    if (!format) return;
    let secret = '';
    if (format === 'plain') {
      const ok = await confirm(
        'Export without encryption?',
        'The downloaded file will be readable by anyone who gets a copy of it, and may be kept by your Downloads folder, backups or sync.',
        'Export unencrypted',
        true,
      );
      if (!ok) return;
    } else {
      const word = format === 'age' ? 'passphrase' : 'password';
      const values = await form({
        title: format === 'age' ? 'Encrypt with a passphrase' : 'Protect with a password',
        text: format === 'age'
          ? 'Decrypt it later here, or with age -d.'
          : 'Office apps ask for this password when opening the file.',
        fields: [
          { name: 'secret', label: `Export ${word}`, type: 'password', autocomplete: 'new-password' },
          { name: 'repeat', label: `Repeat ${word}`, type: 'password', autocomplete: 'new-password' },
        ],
        submit: 'Export',
        validate: (v) => {
          if (!v.secret) return `Enter a ${word}.`;
          return v.secret === v.repeat ? null : `The ${word}s do not match.`;
        },
      });
      if (!values) return;
      secret = values.secret ?? '';
    }
    const bytes = await this.vault.read(id);
    download(exportDocument({ name: entry.name, bytes }, format, secret, this.seal));
  }

  private renderList(list: HTMLElement, choose: ((doc: OpenDoc) => void) | null, refresh: () => void): void {
    const docs = this.vault.list();
    list.replaceChildren(...docs.map((entry) => this.row(entry, choose, refresh)));
    if (docs.length === 0) {
      list.append(h('li', { class: 'empty muted' }, 'No documents yet. Create one or import a file.'));
    }
  }

  private row(entry: DocEntry, choose: ((doc: OpenDoc) => void) | null, refresh: () => void): HTMLElement {
    const open = (): void => this.run(async () => {
      choose?.({ id: entry.id, name: entry.name, bytes: await this.vault.read(entry.id) });
    });
    const name = choose
      ? h('button', { type: 'button', class: 'doc-name link', onclick: open }, entry.name)
      : h('span', { class: 'doc-name' }, entry.name);
    return h(
      'li',
      { class: 'doc' },
      h('span', { class: `badge ${extension(entry.name)}`, 'aria-hidden': 'true' }, extension(entry.name).toUpperCase()),
      h('div', { class: 'doc-main' }, name, h('span', { class: 'muted small' }, `${formatSize(entry.size)} · modified ${formatDate(entry.modified)}`)),
      h('div', { class: 'doc-actions' },
        button('Export', () => this.run(() => this.exportDoc(entry.id))),
        button('Rename', () => this.run(async () => {
          if (await this.renameDoc(entry)) refresh();
        })),
        button('Delete', () => this.run(async () => {
          if (await confirm(`Delete "${entry.name}"?`, 'The document is removed from the vault for good.', 'Delete', true)) {
            await this.vault.remove(entry.id);
            refresh();
          }
        }), 'danger-link'),
      ),
    );
  }

  private async renameDoc(entry: DocEntry): Promise<boolean> {
    const ext = extension(entry.name);
    const values = await form({
      title: 'Rename',
      fields: [{ name: 'name', label: 'File name', value: entry.name }],
      submit: 'Rename',
      validate: (v) => {
        const name = withExtension(v.name ?? '', ext);
        if (name === null) return `The name must end in .${ext}.`;
        if (this.vault.uniqueName(name, entry.id) !== name) return 'Another document has this name.';
        return null;
      },
    });
    if (!values) return false;
    await this.vault.rename(entry.id, withExtension(values.name ?? '', ext) ?? entry.name);
    return true;
  }

  private async newDoc(kind: BlankKind, name: string): Promise<OpenDoc> {
    const editor = await this.editor();
    return { id: null, name: this.vault.uniqueName(name), bytes: editor.blank_file(kind) };
  }

  private async importDoc(): Promise<DocEntry | null> {
    const file = await pickLocalFile(ACCEPT);
    if (!file) return null;
    const imported = await importFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, this.seal, askSecret);
    if (!imported) return null;
    return this.vault.write(this.vault.uniqueName(imported.name), imported.bytes);
  }

  /** Runs a UI action, reporting its failure in a dialog. */
  private run(action: () => Promise<unknown>): void {
    action().catch((error: unknown) => {
      console.error(error);
      return alert('Something went wrong', errorMessage(error));
    });
  }
}

const askSecret: AskSecret = async ({ kind, fileName }) => {
  const values = await form({
    title: kind === 'age-passphrase' ? 'Decrypt age file' : 'Password-protected file',
    text: kind === 'age-passphrase'
      ? `Enter the passphrase for "${fileName}", or an AGE-SECRET-KEY-1… identity.`
      : `"${fileName}" is protected with a password.`,
    fields: [{ name: 'secret', label: kind === 'age-passphrase' ? 'Passphrase or secret key' : 'Password', type: 'password' }],
    submit: 'Decrypt',
  });
  return values?.secret ?? null;
};

/** `name` with extension `ext` (added when missing), or null if it has another one. */
export function withExtension(name: string, ext: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const current = extension(trimmed);
  if (current === ext) return trimmed;
  return isDocumentName(trimmed) || current === 'age' ? null : `${trimmed}.${ext}`;
}
