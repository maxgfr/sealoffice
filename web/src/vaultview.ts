// SPDX-License-Identifier: AGPL-3.0-only
// The vault screen: document list (search, sort, folders, history), new,
// import, export, rename, delete, and the vault's settings.
import type { Autosaver } from './autosave';
import { createBackup, openBackup, restoreBackup } from './backup';
import { type DiskLinks, pickAgeFile, pickSaveTarget } from './diskfile';
import type { SealCrypto } from './crypto';
import type { BlankKind, EditorModule } from './editor';
import { canOfficeProtect, download, exportDocument, type ExportFormat } from './exporter';
import { ACCEPT, extension, importFile, isDocumentName, type AskSecret } from './importer';
import { autoLockDialog, changePassphraseDialog, showRecoveryKeyDialog, wipeDialog } from './lock';
import { prfSupported, registerPasskey } from './passkey';
import { newSessionSecrets } from './live/protocol';
import { MAX_LINK_LENGTH, openShare, randomKey, shareFile, shareFragment, type SharedLink } from './share';
import {
  alert, button, confirm, errorMessage, form, formatDate, formatSize, h, modal, pickLocalFile, pickLocalFiles, searchKey, select,
} from './ui';
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

type SortOrder = 'modified' | 'name' | 'size';
const SORT_SETTING = 'sealoffice-sort';
/** Folder filter values besides a folder name. */
const ALL = '\0all';
const TOP = '\0top';

function savedSort(): SortOrder {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SORT_SETTING);
  } catch {
    // Storage blocked: use the default.
  }
  return saved === 'name' || saved === 'size' ? saved : 'modified';
}

function saveSort(order: SortOrder): void {
  try {
    localStorage.setItem(SORT_SETTING, order);
  } catch {
    // Storage blocked: the order lasts for this page only.
  }
}

/** The running editor, once a document is open in it. */
export interface EditorSession {
  autosaver: Autosaver;
  /** The vault id of the open document, null while it was never saved. */
  currentId(): string | null;
  /** Replaces the editor's document (save it first). */
  open(doc: OpenDoc): void;
}

export class VaultView {
  private overlay: HTMLElement | null = null;
  private session: EditorSession | null = null;
  private query = '';
  private sort: SortOrder = savedSort();
  private folderFilter = ALL;
  /** Folders made with "New folder…" that hold no document yet. */
  private readonly newFolders = new Set<string>();
  /** Vault-only mode: this browser cannot run the editor. */
  private editingDisabled = false;
  private links: DiskLinks | null = null;

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
      const filters = h('div', { class: 'filter-row' });
      const choose = options.choose && !this.editingDisabled;
      const refreshList = (): void => this.renderList(list, choose ? done : null, refresh);
      const refresh = (): void => {
        this.renderFilters(filters, refresh, refreshList);
        refreshList();
      };
      const header = h(
        'header',
        { class: 'vault-header' },
        h('h1', {}, 'Vault'),
        options.closable ? button('Close', () => done(null)) : null,
      );
      const create = options.choose
        ? h('div', { class: 'new-row' }, ...NEW_KINDS.map(([kind, label, name]) => {
          const el = button(label, () => this.run(() => this.newDoc(kind, name).then(done)));
          el.disabled = this.editingDisabled;
          return el;
        }))
        : null;
      const banner = this.editingDisabled
        ? h('p', { class: 'form-error', role: 'note' },
          'Editing is unavailable in this browser: it has neither WebGPU nor WebGL2. ' +
          'You can still import, export, back up, restore and share documents. To edit, use a recent Chrome, Edge, Safari or Firefox.')
        : null;
      const importFiles = (files: File[]): void => this.run(async () => {
        const added = await this.importFiles(files);
        const only = added[0];
        if (choose && added.length === 1 && only) {
          done({ id: only.id, name: only.name, bytes: await this.vault.read(only.id) });
        } else {
          refresh();
        }
      });
      const importButton = button('Import files…', () => this.run(async () => {
        const files = await pickLocalFiles(ACCEPT);
        if (files.length > 0) importFiles(files);
      }));
      const storage = h('p', { class: 'muted small storage' });
      const footer = h(
        'footer',
        { class: 'vault-footer' },
        button('Change passphrase', () => this.run(async () => {
          if (await changePassphraseDialog(this.vault)) await alert('Passphrase changed', 'Use the new passphrase from now on.');
        })),
        button('Back up vault…', () => this.run(() => this.backup())),
        button('Restore backup…', () => this.run(async () => {
          if (await this.restore()) refresh();
        })),
        button('Show recovery key…', () => this.run(() => showRecoveryKeyDialog(this.vault))),
        button('Auto-lock…', () => this.run(autoLockDialog)),
        button('Wipe vault…', () => this.run(() => wipeDialog(this.vault)), 'danger-link'),
      );
      const panel = h(
        'section',
        { class: 'card vault', 'aria-labelledby': 'vault-title' },
        header,
        options.status ?? null,
        banner,
        create,
        h('div', { class: 'toolbar-row' },
          importButton,
          this.links ? button('Open a .age from disk…', () => this.run(async () => {
            if (await this.openFromDisk()) refresh();
          })) : null,
          h('span', { class: 'muted small' }, 'or drop files here')),
        filters,
        list,
        footer,
        storage,
      );
      panel.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        panel.classList.add('dropping');
      });
      panel.addEventListener('dragleave', (event) => {
        if (event.target === panel) panel.classList.remove('dropping');
      });
      panel.addEventListener('drop', (event) => {
        event.preventDefault();
        panel.classList.remove('dropping');
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length > 0) importFiles(files);
      });
      this.run(() => this.renderStorage(storage));
      header.querySelector('h1')?.setAttribute('id', 'vault-title');
      this.run(() => this.passkeyButton(footer));
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

  /** Enables "Open a .age from disk" and "Link to disk" (File System Access browsers). */
  attachDiskLinks(links: DiskLinks): void {
    this.links = links;
  }

  /** Vault-only mode: everything but opening documents in the editor. */
  disableEditing(): void {
    this.editingDisabled = true;
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  attachEditor(session: EditorSession): void {
    this.session = session;
  }

  /**
   * Saves the open document to the vault before something reads or replaces
   * it. False when it could not be saved and the user chose to stop.
   */
  async saveOpenDoc(action: string): Promise<boolean> {
    if (!this.session) return true;
    const problem = await this.session.autosaver.flush().then(
      (result) => (result === 'unsavable'
        ? 'The open document cannot be saved to the vault.'
        : result === 'timeout' ? 'Saving the open document did not finish.' : null),
      (error: unknown) => `Saving the open document failed: ${errorMessage(error)}`,
    );
    if (!problem) return true;
    return confirm(`${action} anyway?`, `${problem} Its latest changes are not in the vault.`, `${action} anyway`, true);
  }

  /** Exports the saved version of `id`, or its earlier version stored in blob `version`, after asking for the format. */
  async exportDoc(id: string, version?: string): Promise<void> {
    if (version === undefined && !(await this.saveOpenDoc('Export'))) return;
    const entry = this.vault.entry(id);
    if (!entry) throw new Error('no such document');
    const when = version === undefined ? null : entry.versions.find((v) => v.blob === version)?.modified;
    if (when === undefined) throw new Error('no such version');
    const format = await modal<ExportFormat | null>(`Export "${entry.name}"`, (close, body) => {
      body.append(
        h('p', {}, when === null ? 'Exports the last saved version.' : `Exports the version saved ${formatDate(when)}.`),
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
        // An imported Office file's own password is offered again; it can be changed.
        fields: [
          { name: 'secret', label: `Export ${word}`, type: 'password', autocomplete: 'new-password', value: format === 'office' ? entry.officePassword : undefined },
          { name: 'repeat', label: `Repeat ${word}`, type: 'password', autocomplete: 'new-password', value: format === 'office' ? entry.officePassword : undefined },
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
    const bytes = version === undefined ? await this.vault.read(id) : await this.vault.readVersion(id, version);
    download(exportDocument({ name: entry.name, bytes }, format, secret, this.seal));
  }

  /** Links `entry` to a new .age file on disk, or removes its link. True when changed. */
  private async toggleLink(entry: DocEntry): Promise<boolean> {
    const links = this.links;
    if (!links) return false;
    if (links.isLinked(entry.id)) {
      await links.unlink(entry.id);
      return true;
    }
    if (!(await this.saveOpenDoc('Link'))) return false;
    const handle = await pickSaveTarget(`${entry.name}.age`);
    if (!handle) return false;
    await links.link(entry.id, handle, await this.vault.read(entry.id));
    return true;
  }

  /** Imports a .age file from disk and keeps it linked. True when imported. */
  private async openFromDisk(): Promise<boolean> {
    const links = this.links;
    if (!links) return false;
    const handle = await pickAgeFile();
    if (!handle) return false;
    const ct = await links.read(handle);
    let plain = links.tryVaultKey(ct);
    if (plain === null) {
      const values = await form({
        title: 'Decrypt age file',
        text: `"${handle.name}" is not encrypted to this vault's key. Enter its passphrase.`,
        fields: [{ name: 'secret', label: 'Passphrase', type: 'password' }],
        submit: 'Decrypt',
        validate: (v) => {
          plain = this.seal.decrypt_passphrase(ct, v.secret ?? '');
          return null;
        },
      });
      if (!values) return false;
    }
    if (plain === null) return false;
    const name = handle.name.toLowerCase().endsWith('.age') ? handle.name.slice(0, -'.age'.length) : handle.name;
    if (!isDocumentName(name)) throw new Error(`"${name}" is not a supported document`);
    const entry = await this.vault.write(this.vault.uniqueName(name), plain);
    // From now on the file holds what the vault holds, encrypted to the vault key.
    await links.link(entry.id, handle, plain);
    return true;
  }

  /** Saves the open document, then reopens `entry` on live.html as the host of a new session. */
  private async startLive(entry: DocEntry): Promise<void> {
    if (!(await confirm(
      'Start a live session?',
      `"${entry.name}" opens in a live session: people you invite see each save and can ask for the pen to edit. ` +
      'Connections go through public Nostr relays and directly between browsers, which see each other\'s IP address. ' +
      'Everything sent is end-to-end encrypted. You will unlock the vault again.',
      'Start',
    ))) return;
    if (!(await this.saveOpenDoc('Start'))) return;
    const { room, key } = newSessionSecrets();
    location.assign(new URL(`live.html#r=${room}&k=${key}&h=${entry.id}`, location.href).href);
  }

  /** Makes a share link for the saved version of `id`. */
  async shareDoc(id: string): Promise<void> {
    if (!(await this.saveOpenDoc('Share'))) return;
    const entry = this.vault.entry(id);
    if (!entry) throw new Error('no such document');
    const mode = await modal<'link' | 'separate' | null>(`Share "${entry.name}"`, (close, body) => {
      body.append(
        h('p', {}, 'The document is encrypted into the link itself; nothing is uploaded. Anyone with the link can open it.'),
        h('div', { class: 'choices' },
          button('Link with the key included', () => close('link'), 'primary'),
          button('Link + passphrase given separately…', () => close('separate')),
        ),
        h('div', { class: 'actions' }, button('Cancel', () => close(null))),
      );
    }, null);
    if (!mode) return;
    let key = randomKey();
    if (mode === 'separate') {
      const values = await form({
        title: 'Share passphrase',
        text: 'Give this passphrase to the recipient another way (phone, in person).',
        fields: [
          { name: 'secret', label: 'Passphrase', type: 'password', autocomplete: 'new-password' },
          { name: 'repeat', label: 'Repeat passphrase', type: 'password', autocomplete: 'new-password' },
        ],
        submit: 'Make link',
        validate: (v) => {
          if (!v.secret) return 'Enter a passphrase.';
          return v.secret === v.repeat ? null : 'The passphrases do not match.';
        },
      });
      if (!values) return;
      key = values.secret ?? '';
    }
    const doc = { name: entry.name, bytes: await this.vault.read(id) };
    const base = new URL('./', location.href).href;
    const link = base + (await shareFragment(doc, key, mode === 'separate', this.seal));
    if (link.length <= MAX_LINK_LENGTH) {
      await showLink('Share link', mode === 'separate'
        ? 'Send this link; the recipient also needs the passphrase.'
        : 'Send this link over a channel you trust: it contains the key.', link);
      return;
    }
    // Too large for a link: the encrypted file goes one way, the key link another.
    const large = shareFile(doc, key, this.seal);
    download(large.file);
    await showLink('Share as a file', `"${entry.name}" is too large for a link. Send the downloaded "${large.file.name}", ` +
      (mode === 'separate' ? 'and the passphrase separately.' : 'and this link, which holds its key.'), base + large.fragment);
  }

  /** Offers to store a document received through a share link. */
  async receiveShared(link: SharedLink): Promise<void> {
    if (!(await confirm('Shared document', `Save the shared document "${link.name}" in your vault?`, 'Save'))) return;
    let doc: { name: string; bytes: Uint8Array } | null = null;
    if (link.kind === 'doc') {
      const known = link.key;
      if (known !== null) {
        doc = await openShare(link, known, this.seal);
      } else {
        const values = await form({
          title: 'Passphrase',
          text: `The sender gave you a passphrase for "${link.name}".`,
          fields: [{ name: 'secret', label: 'Passphrase', type: 'password' }],
          submit: 'Open',
          validate: async (v) => {
            doc = await openShare(link, v.secret ?? '', this.seal);
            return null;
          },
        });
        if (!values) return;
      }
    } else {
      await alert('Choose the file', `Pick "${link.name}.age", the file that came with this link.`);
      const file = await pickLocalFile('.age');
      if (!file) return;
      doc = { name: link.name, bytes: this.seal.decrypt_passphrase(new Uint8Array(await file.arrayBuffer()), link.key) };
    }
    if (!doc) return;
    const received: { name: string; bytes: Uint8Array } = doc;
    if (!isDocumentName(received.name)) throw new Error(`"${received.name}" is not a supported document`);
    const entry = await this.vault.write(this.vault.uniqueName(received.name), received.bytes);
    await alert('Saved', `"${entry.name}" is in your vault.`);
  }

  /** Adds the passkey setting to `footer` when this browser supports PRF. */
  private async passkeyButton(footer: HTMLElement): Promise<void> {
    if (!(await prfSupported())) return;
    const has = (await this.vault.passkey()) !== null;
    const el = has
      ? button('Remove passkey', () => this.run(async () => {
        if (!(await confirm('Remove the passkey?', 'The vault will open with the passphrase only.', 'Remove', true))) return;
        await this.vault.removePasskey();
        el.replaceWith(h('span', { class: 'muted small' }, 'Passkey removed.'));
      }))
      : button('Add passkey…', () => this.run(async () => {
        await registerPasskey(this.vault);
        el.replaceWith(h('span', { class: 'muted small' }, 'Passkey added.'));
        await alert('Passkey added', 'The lock screen now offers to unlock with this passkey.');
      }));
    footer.insertBefore(el, footer.lastElementChild);
  }

  /** Downloads an encrypted archive of every document's current version. */
  private async backup(): Promise<void> {
    if (!(await this.saveOpenDoc('Back up'))) return;
    const values = await form({
      title: 'Back up vault',
      text: 'Every document goes into one archive encrypted with this passphrase, without the version history. ' +
        'Restore it here, or open it with age -d backup.tar.age | tar x.',
      fields: [
        { name: 'secret', label: 'Backup passphrase', type: 'password', autocomplete: 'new-password' },
        { name: 'repeat', label: 'Repeat backup passphrase', type: 'password', autocomplete: 'new-password' },
      ],
      submit: 'Back up',
      validate: (v) => {
        if (!v.secret) return 'Enter a passphrase.';
        return v.secret === v.repeat ? null : 'The passphrases do not match.';
      },
    });
    if (!values) return;
    download(await createBackup(this.vault, values.secret ?? '', this.seal));
  }

  /** Adds the documents of a backup to the vault; true when some were added. */
  private async restore(): Promise<boolean> {
    const file = await pickLocalFile('.age');
    if (!file) return false;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let count = 0;
    const values = await form({
      title: 'Restore backup',
      text: `Adds the documents of "${file.name}" to this vault. Documents whose name is taken get a new name.`,
      fields: [{ name: 'secret', label: 'Backup passphrase', type: 'password', autocomplete: 'off' }],
      submit: 'Restore',
      validate: async (v) => {
        count = (await restoreBackup(this.vault, openBackup(bytes, v.secret ?? '', this.seal))).length;
        return null;
      },
    });
    if (!values) return false;
    await alert('Backup restored', `${count} document${count === 1 ? '' : 's'} added.`);
    return true;
  }

  /** Folders in use plus the ones just made. */
  private allFolders(): string[] {
    return [...new Set([...this.vault.folders(), ...this.newFolders])].sort((a, b) => a.localeCompare(b));
  }

  private renderFilters(row: HTMLElement, refresh: () => void, refreshList: () => void): void {
    const search = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search documents', class: 'search' });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      refreshList();
    });
    const folders = this.allFolders();
    if (this.folderFilter !== ALL && this.folderFilter !== TOP && !folders.includes(this.folderFilter)) this.folderFilter = ALL;
    row.replaceChildren(
      search,
      select('Sort by', [['modified', 'Last modified'], ['name', 'Name'], ['size', 'Size']], this.sort, (value) => {
        this.sort = value === 'name' || value === 'size' ? value : 'modified';
        saveSort(this.sort);
        refresh();
      }),
      select('Folder', [[ALL, 'All folders'], [TOP, 'No folder'], ...folders.map((f): [string, string] => [f, f])], this.folderFilter, (value) => {
        this.folderFilter = value;
        refresh();
      }),
      button('New folder…', () => this.run(async () => {
        const name = await this.askFolder('New folder', '');
        if (name === null || name === '') return;
        this.newFolders.add(name);
        this.folderFilter = name;
        refresh();
      })),
    );
  }

  private renderList(list: HTMLElement, choose: ((doc: OpenDoc) => void) | null, refresh: () => void): void {
    const all = this.vault.list();
    const key = searchKey(this.query.trim());
    const docs = all
      .filter((e) => key === '' || searchKey(e.name).includes(key))
      .filter((e) => this.folderFilter === ALL || (this.folderFilter === TOP ? e.folder === undefined : e.folder === this.folderFilter))
      .sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name) : this.sort === 'size' ? b.size - a.size : b.modified - a.modified);
    const rows: HTMLElement[] = [];
    if (this.folderFilter === ALL) {
      // Grouped: top-level documents first, then one heading per folder.
      for (const folder of [undefined, ...this.allFolders()]) {
        const inFolder = docs.filter((e) => e.folder === folder);
        if (folder !== undefined && (inFolder.length > 0 || (key === '' && this.newFolders.has(folder)))) {
          rows.push(h('li', { class: 'folder-heading' }, folder));
        }
        rows.push(...inFolder.map((entry) => this.row(entry, choose, refresh)));
      }
    } else {
      rows.push(...docs.map((entry) => this.row(entry, choose, refresh)));
    }
    list.replaceChildren(...rows);
    if (all.length === 0) {
      list.append(h('li', { class: 'empty muted' }, 'No documents yet. Create one or import a file.'));
    } else if (docs.length === 0) {
      list.append(h('li', { class: 'empty muted' }, 'No document matches.'));
    }
  }

  /** Shows how much storage the vault uses, and offers to make it persistent. */
  private async renderStorage(line: HTMLElement): Promise<void> {
    if (!navigator.storage?.estimate) return;
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    line.replaceChildren(
      `Storage: ${formatSize(usage ?? 0)} used of ${formatSize(quota ?? 0)}. `,
      persisted
        ? 'Persistent: the browser will not evict it.'
        : 'Not persistent: the browser may evict it when space runs low. ',
    );
    if (!persisted && navigator.storage.persist) {
      line.append(button('Make persistent', () => this.run(async () => {
          if (!(await navigator.storage.persist())) {
            await alert('Not granted', 'The browser declined. Installing the app or bookmarking the page can help; keep backups either way.');
          }
          await this.renderStorage(line);
        }), 'link'));
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
      h('div', { class: 'doc-main' }, name, h('span', { class: 'muted small' },
        `${formatSize(entry.size)} · modified ${formatDate(entry.modified)}`,
        this.links?.isLinked(entry.id) ? h('span', { class: 'linked', title: 'Every save also rewrites its .age file on disk' }, ' · Linked') : null)),
      h('div', { class: 'doc-actions' },
        button('Export', () => this.run(() => this.exportDoc(entry.id))),
        this.links ? button(this.links.isLinked(entry.id) ? 'Unlink' : 'Link to disk…', () => this.run(async () => {
          if (await this.toggleLink(entry)) refresh();
        })) : null,
        button('Share…', () => this.run(() => this.shareDoc(entry.id))),
        this.editingDisabled ? null : button('Live session…', () => this.run(() => this.startLive(entry))),
        entry.versions.length > 0
          ? button('History', () => this.run(async () => {
            if (await this.history(entry)) refresh();
          }))
          : null,
        button('Move to…', () => this.run(async () => {
          const folder = await this.askFolder(`Move "${entry.name}"`, entry.folder ?? '');
          if (folder === null) return;
          await this.vault.setFolder(entry.id, folder);
          this.newFolders.delete(folder);
          refresh();
        })),
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

  /** A folder name typed or picked by the user; '' means no folder, null cancelled. */
  private async askFolder(title: string, current: string): Promise<string | null> {
    const folders = this.allFolders();
    const values = await form({
      title,
      text: folders.length > 0
        ? `Existing folders: ${folders.join(', ')}. Leave empty for no folder.`
        : 'Leave empty for no folder.',
      fields: [{ name: 'folder', label: 'Folder', value: current }],
      submit: 'OK',
      validate: (v) => (/[/\\]/.test(v.folder ?? '') ? 'Folder names cannot contain / or \\.' : null),
    });
    return values ? (values.folder ?? '').trim() : null;
  }

  /** Lists the earlier versions of `entry`; true when one was restored. */
  private history(entry: DocEntry): Promise<boolean> {
    return modal<boolean>(`History of "${entry.name}"`, (close, body) => {
      // Versions are named by blob: a save while this is open shifts their indexes.
      const rows = this.vault.versions(entry.id).map((version) => h(
        'li',
        { class: 'doc' },
        h('div', { class: 'doc-main' }, h('span', {}, formatDate(version.modified)), h('span', { class: 'muted small' }, formatSize(version.size))),
        h('div', { class: 'doc-actions' },
          button('Export', () => this.run(() => this.exportDoc(entry.id, version.blob))),
          button('Restore', () => this.run(async () => {
            if (!(await this.saveOpenDoc('Restore'))) return;
            if (!(await confirm('Restore this version?', 'It becomes the current version; the current one is kept in the history.', 'Restore'))) return;
            const restored = await this.vault.restoreVersion(entry.id, version.blob);
            const bytes = await this.vault.read(restored.id);
            await this.links?.write(restored.id, bytes);
            // The open document was saved above; show the restored bytes in its place.
            if (this.session && this.session.currentId() === entry.id) {
              this.session.open({ id: restored.id, name: restored.name, bytes });
            }
            close(true);
          }), 'primary'),
        ),
      ));
      body.append(
        h('p', { class: 'muted small' }, `The last ${rows.length} saved versions, newest first.`),
        h('ul', { class: 'doc-list' }, ...rows),
        h('div', { class: 'actions' }, button('Close', () => close(false))),
      );
    }, false);
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

  /** Imports each file into the current folder, then reports what happened to each one. */
  private async importFiles(files: File[]): Promise<DocEntry[]> {
    const added: DocEntry[] = [];
    const report: [string, string][] = [];
    const folder = this.folderFilter === ALL || this.folderFilter === TOP ? undefined : this.folderFilter;
    for (const file of files) {
      try {
        const imported = await importFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, this.seal, askSecret);
        if (!imported) {
          report.push([file.name, 'skipped']);
          continue;
        }
        const meta = {
          ...(imported.officePassword === undefined ? {} : { officePassword: imported.officePassword }),
          ...(folder === undefined ? {} : { folder }),
        };
        const entry = await this.vault.write(this.vault.uniqueName(imported.name), imported.bytes, undefined, meta);
        added.push(entry);
        report.push([file.name, entry.name === file.name ? 'imported' : `imported as "${entry.name}"`]);
      } catch (error) {
        console.error(error);
        report.push([file.name, `failed: ${errorMessage(error)}`]);
      }
    }
    // One clean import needs no report.
    if (files.length > 1 || added.length !== 1) {
      await modal<void>('Import', (close, body) => {
        const ok = button('OK', () => close(), 'primary');
        body.append(
          h('ul', { class: 'report' }, ...report.map(([name, result]) => h('li', {}, h('strong', {}, name), ` ${result}`))),
          h('div', { class: 'actions' }, ok),
        );
        queueMicrotask(() => ok.focus());
      }, undefined);
    }
    return added;
  }

  /** Runs a UI action, reporting its failure in a dialog. */
  private run(action: () => Promise<unknown>): void {
    action().catch((error: unknown) => {
      console.error(error);
      return alert('Something went wrong', errorMessage(error));
    });
  }
}

function showLink(title: string, text: string, link: string): Promise<void> {
  return modal<void>(title, (close, body) => {
    const status = h('p', { class: 'muted small', 'aria-live': 'polite' });
    const copy = button('Copy link', () => {
      navigator.clipboard.writeText(link).then(
        () => { status.textContent = 'Copied.'; },
        (error: unknown) => { status.textContent = `Could not copy: ${errorMessage(error)}`; },
      );
    }, 'primary');
    body.append(
      h('p', {}, text),
      h('pre', { class: 'recovery-key share-link' }, link.length > 400 ? `${link.slice(0, 400)}…` : link),
      status,
      h('div', { class: 'actions' }, button('Close', () => close()), copy),
    );
    queueMicrotask(() => copy.focus());
  }, undefined);
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

/**
 * The document picked in the vault, read again after `save` flushed the open
 * one: when both are the same document, the bytes read before the flush lack
 * the latest changes. Null when the save failed and the user stopped.
 */
export async function savedThenRead(
  doc: OpenDoc,
  save: () => Promise<boolean>,
  read: (id: string) => Promise<Uint8Array>,
): Promise<OpenDoc | null> {
  if (!(await save())) return null;
  return doc.id === null ? doc : { ...doc, bytes: await read(doc.id) };
}
