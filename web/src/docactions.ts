// SPDX-License-Identifier: AGPL-3.0-only
// What can be done to a stored document, shared by the home screen's cards and
// the editor's app bar: download, share, history, live session, disk link,
// move, rename, delete and the per-document lock; plus import, backup and
// restore. Locked documents ask for their passphrase before anything reads them.
import type { Autosaver } from './autosave';
import { createBackup, openBackup, restoreBackup } from './backup';
import { type DiskLinks, pickAgeFile, pickSaveTarget } from './diskfile';
import type { SealCrypto } from './crypto';
import { canOfficeProtect, download, exportDocument, type ExportFormat } from './exporter';
import { extension, importFile, isDocumentName, type AskSecret } from './importer';
import { newSessionSecrets } from './live/protocol';
import { MAX_LINK_LENGTH, openShare, randomKey, shareFile, shareFragment, type SharedLink } from './share';
import {
  alert, button, confirm, errorMessage, form, formatDate, formatSize, h, modal, pickLocalFile,
} from './ui';
import type { DocEntry, Vault } from './vault';
import type { OpenDoc } from './vaultview';

/** The running editor, once a document is open in it. */
export interface EditorSession {
  autosaver: Autosaver;
  /** The library id of the open document, null while it was never saved. */
  currentId(): string | null;
  /** The id of the document on screen in the editor; null at Home. */
  editing(): string | null;
  /** Replaces the editor's document (save it first). */
  open(doc: OpenDoc): void;
}

/** Shortest passphrase for a document lock. */
const MIN_DOC_PASSPHRASE = 8;

export class DocActions {
  private session: EditorSession | null = null;
  private links: DiskLinks | null = null;
  /** Running `withDoc` tasks by document id: nested ones share one unlock. */
  private holds = new Map<string, number>();
  /** Called after a document is deleted from its passphrase prompt. */
  private removed: () => void = () => {};

  constructor(
    private readonly vault: Vault,
    private readonly seal: SealCrypto,
  ) {}

  /** Enables "Open a .age from disk" and "Link to disk" (File System Access browsers). */
  attachDiskLinks(links: DiskLinks): void {
    this.links = links;
  }

  get diskLinks(): DiskLinks | null {
    return this.links;
  }

  /** Runs `refresh` after "Forgot it? Delete this document" deleted one. */
  onRemoved(refresh: () => void): void {
    this.removed = refresh;
  }

  attachEditor(session: EditorSession): void {
    this.session = session;
  }

  /**
   * Saves the open document to the library before something reads or replaces
   * it. False when it could not be saved and the user chose to stop.
   */
  async saveOpenDoc(action: string): Promise<boolean> {
    if (!this.session) return true;
    const problem = await this.session.autosaver.flush().then(
      (result) => (result === 'unsavable'
        ? 'The open document cannot be saved to the library.'
        : result === 'timeout' ? 'Saving the open document did not finish.' : null),
      (error: unknown) => `Saving the open document failed: ${errorMessage(error)}`,
    );
    if (!problem) return true;
    return confirm(`${action} anyway?`, `${problem} Its latest changes are not in the library.`, `${action} anyway`, true);
  }

  /**
   * Makes a locked document readable: asks for its passphrase unless its key
   * is already in memory. False when the user cancelled.
   */
  async unlockDoc(entry: DocEntry): Promise<boolean> {
    if (!entry.lock || this.vault.isDocOpen(entry.id)) return true;
    let forgotten = false;
    const values = await form({
      title: `Open "${entry.name}"`,
      text: 'This document is locked with its own passphrase.',
      fields: [{ name: 'secret', label: 'Document passphrase', type: 'password', autocomplete: 'off' }],
      submit: 'Unlock',
      aside: (close) => h('div', { class: 'lock-links' }, button('Forgot it? Delete this document', () => {
        forgotten = true;
        close();
      }, 'link')),
      validate: async (v) => {
        await this.vault.openDoc(entry.id, v.secret ?? '');
        return null;
      },
    });
    if (forgotten && (await this.forgetDoc(entry))) this.removed();
    return values !== null;
  }

  /**
   * Runs `task` with `entry` readable, after its passphrase if it is locked;
   * null when cancelled. Unless `entry` is on screen in the editor, its key is
   * forgotten once the last such task ends, whatever the outcome.
   */
  async withDoc<T>(entry: DocEntry, task: () => Promise<T>): Promise<T | null> {
    this.holds.set(entry.id, (this.holds.get(entry.id) ?? 0) + 1);
    try {
      if (!(await this.unlockDoc(entry))) return null;
      return await task();
    } finally {
      const left = (this.holds.get(entry.id) ?? 1) - 1;
      if (left > 0) {
        this.holds.set(entry.id, left);
      } else {
        this.holds.delete(entry.id);
        if (this.session?.editing() !== entry.id) this.vault.forgetDocKey(entry.id);
      }
    }
  }

  /** The saved bytes of `id`, after its passphrase if it is locked; null when cancelled. */
  async readDoc(id: string): Promise<Uint8Array | null> {
    const entry = this.requireEntry(id);
    return this.withDoc(entry, () => this.vault.read(id));
  }

  /**
   * Downloads the saved version of `id`, or its earlier version stored in blob
   * `version`. Without `format`, asks for one.
   */
  async exportDoc(id: string, format?: ExportFormat, version?: string): Promise<void> {
    if (version === undefined && !(await this.saveOpenDoc('Download'))) return;
    const entry = this.requireEntry(id);
    const when = version === undefined ? null : entry.versions.find((v) => v.blob === version)?.modified;
    if (when === undefined) throw new Error('no such version');
    const chosen = format ?? await modal<ExportFormat | null>(`Download "${entry.name}"`, (close, body) => {
      body.append(
        h('p', {}, when === null ? 'Downloads the last saved version.' : `Downloads the version saved ${formatDate(when)}.`),
        h('div', { class: 'choices' },
          button('Encrypted .age file (passphrase)', () => close('age'), 'primary'),
          canOfficeProtect(entry.name) ? button('Password-protected Office file', () => close('office')) : null,
          button('Original file, not encrypted', () => close('plain')),
        ),
        h('div', { class: 'actions' }, button('Cancel', () => close(null))),
      );
    }, null);
    if (!chosen) return;
    await this.withDoc(entry, () => this.exportChosen(entry, chosen, version));
  }

  private async exportChosen(entry: DocEntry, chosen: ExportFormat, version: string | undefined): Promise<void> {
    const id = entry.id;
    let secret = '';
    if (chosen !== 'plain') {
      const word = chosen === 'age' ? 'passphrase' : 'password';
      const values = await form({
        title: chosen === 'age' ? 'Encrypt with a passphrase' : 'Protect with a password',
        text: chosen === 'age'
          ? 'Decrypt it later here, or with age -d.'
          : 'Office apps ask for this password when opening the file.',
        // An imported Office file's own password is offered again; it can be changed.
        fields: [
          { name: 'secret', label: `Export ${word}`, type: 'password', autocomplete: 'new-password', value: chosen === 'office' ? entry.officePassword : undefined },
          { name: 'repeat', label: `Repeat ${word}`, type: 'password', autocomplete: 'new-password', value: chosen === 'office' ? entry.officePassword : undefined },
        ],
        submit: 'Download',
        validate: (v) => {
          if (!v.secret) return `Enter a ${word}.`;
          return v.secret === v.repeat ? null : `The ${word}s do not match.`;
        },
      });
      if (!values) return;
      secret = values.secret ?? '';
    }
    const bytes = version === undefined ? await this.vault.read(id) : await this.vault.readVersion(id, version);
    download(exportDocument({ name: entry.name, bytes }, chosen, secret, this.seal));
  }

  /** Links `entry` to a new .age file on disk, or removes its link. True when changed. */
  async toggleLink(entry: DocEntry): Promise<boolean> {
    const links = this.links;
    if (!links) return false;
    if (links.isLinked(entry.id)) {
      await links.unlink(entry.id);
      return true;
    }
    if (!(await this.saveOpenDoc('Link'))) return false;
    const linked = await this.withDoc(entry, async () => {
      const handle = await pickSaveTarget(`${entry.name}.age`);
      if (!handle) return false;
      await links.link(entry.id, handle, await this.vault.read(entry.id));
      return true;
    });
    return linked === true;
  }

  /** Imports a .age file from disk and keeps it linked; the new entry, or null. */
  async openFromDisk(): Promise<DocEntry | null> {
    const links = this.links;
    if (!links) return null;
    const handle = await pickAgeFile();
    if (!handle) return null;
    const ct = await links.read(handle);
    let plain = links.tryVaultKey(ct);
    if (plain === null) {
      const values = await form({
        title: 'Decrypt age file',
        text: `"${handle.name}" is not encrypted to this library's key. Enter its passphrase.`,
        fields: [{ name: 'secret', label: 'Passphrase', type: 'password' }],
        submit: 'Decrypt',
        validate: (v) => {
          plain = this.seal.decrypt_passphrase(ct, v.secret ?? '');
          return null;
        },
      });
      if (!values) return null;
    }
    if (plain === null) return null;
    const name = handle.name.toLowerCase().endsWith('.age') ? handle.name.slice(0, -'.age'.length) : handle.name;
    if (!isDocumentName(name)) throw new Error(`"${name}" is not a supported document`);
    const entry = await this.vault.write(this.vault.uniqueName(name), plain);
    // From now on the file holds what the library holds, encrypted to the library key.
    await links.link(entry.id, handle, plain);
    return entry;
  }

  /** Saves the open document, then reopens `entry` on live.html as the host of a new session. */
  async startLive(entry: DocEntry): Promise<void> {
    const again = this.vault.isProtected
      ? ' You will unlock the library again.'
      : entry.lock ? ' You will enter the document passphrase again.' : '';
    if (!(await confirm(
      'Start a live session?',
      `"${entry.name}" opens in a live session: people you invite see each save and can ask for the pen to edit. ` +
      'Connections go through public Nostr relays and directly between browsers, which see each other\'s IP address. ' +
      `Everything sent is end-to-end encrypted.${again}`,
      'Start',
    ))) return;
    if (!(await this.saveOpenDoc('Start'))) return;
    const { room, key } = newSessionSecrets();
    location.assign(new URL(`live.html#r=${room}&k=${key}&h=${entry.id}`, location.href).href);
  }

  /** Makes a share link for the saved version of `id`. */
  async shareDoc(id: string): Promise<void> {
    if (!(await this.saveOpenDoc('Share'))) return;
    const entry = this.requireEntry(id);
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
    await this.withDoc(entry, () => this.shareChosen(entry, mode));
  }

  private async shareChosen(entry: DocEntry, mode: 'link' | 'separate'): Promise<void> {
    const id = entry.id;
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

  /** Offers to store a document received through a share link; the new entry, or null. */
  async receiveShared(link: SharedLink): Promise<DocEntry | null> {
    if (!(await confirm('Shared document', `Save the shared document "${link.name}" in your library?`, 'Save'))) return null;
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
        if (!values) return null;
      }
    } else {
      await alert('Choose the file', `Pick "${link.name}.age", the file that came with this link.`);
      const file = await pickLocalFile('.age');
      if (!file) return null;
      doc = { name: link.name, bytes: this.seal.decrypt_passphrase(new Uint8Array(await file.arrayBuffer()), link.key) };
    }
    if (!doc) return null;
    const received: { name: string; bytes: Uint8Array } = doc;
    if (!isDocumentName(received.name)) throw new Error(`"${received.name}" is not a supported document`);
    const entry = await this.vault.write(this.vault.uniqueName(received.name), received.bytes);
    await alert('Saved', `"${entry.name}" is in your library.`);
    return entry;
  }

  /** Downloads an encrypted archive of every document's current version. */
  async backup(): Promise<void> {
    if (!(await this.saveOpenDoc('Back up'))) return;
    const values = await form({
      title: 'Back up library',
      text: 'Every document goes into one archive encrypted with this passphrase, without the version history. ' +
        'Locked documents stay locked inside it. Restore it here, or open it with age -d backup.tar.age | tar x.',
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

  /** Adds the documents of a backup to the library; true when some were added. */
  async restore(): Promise<boolean> {
    const file = await pickLocalFile('.age');
    if (!file) return false;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let count = 0;
    const values = await form({
      title: 'Restore a backup',
      text: `Adds the documents of "${file.name}" to this library. Documents whose name is taken get a new name.`,
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

  /** Lists the earlier versions of `entry`; true when one was restored. */
  async history(entry: DocEntry): Promise<boolean> {
    const restored = await this.withDoc(entry, () => this.historyModal(entry));
    return restored === true;
  }

  private historyModal(entry: DocEntry): Promise<boolean> {
    return modal<boolean>(`Version history of "${entry.name}"`, (close, body) => {
      // Versions are named by blob: a save while this is open shifts their indexes.
      const rows = this.vault.versions(entry.id).map((version) => h(
        'li',
        { class: 'doc' },
        h('div', { class: 'doc-main' }, h('span', {}, formatDate(version.modified)), h('span', { class: 'muted small' }, formatSize(version.size))),
        h('div', { class: 'doc-actions' },
          button('Download', () => this.run(() => this.exportDoc(entry.id, undefined, version.blob))),
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
        h('p', { class: 'muted small' }, rows.length === 0
          ? 'No earlier version yet: each save keeps the previous one here.'
          : `The last ${rows.length} saved versions, newest first.`),
        h('ul', { class: 'doc-list' }, ...rows),
        h('div', { class: 'actions' }, button('Close', () => close(false))),
      );
    }, false);
  }

  /** Asks for a new name; the renamed entry, or null when cancelled. */
  async renameDoc(entry: DocEntry): Promise<DocEntry | null> {
    const ext = extension(entry.name);
    const values = await form({
      title: 'Rename',
      fields: [{ name: 'name', label: 'File name', value: entry.name }],
      submit: 'Rename',
      validate: (v) => this.nameProblem(entry, v.name ?? ''),
    });
    if (!values) return null;
    return this.vault.rename(entry.id, withExtension(values.name ?? '', ext) ?? entry.name);
  }

  /** Why `name` cannot be the new name of `entry`, or null when it can. */
  nameProblem(entry: DocEntry, name: string): string | null {
    const ext = extension(entry.name);
    const full = withExtension(name, ext);
    if (full === null) return `The name must end in .${ext}.`;
    if (this.vault.uniqueName(full, entry.id) !== full) return 'Another document has this name.';
    return null;
  }

  /** A folder name typed by the user; '' means no folder, null cancelled. */
  async askFolder(title: string, current: string, folders: string[]): Promise<string | null> {
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

  /** Deletes `entry` after asking; true when deleted. */
  async deleteDoc(entry: DocEntry): Promise<boolean> {
    if (!(await confirm(`Delete "${entry.name}"?`, 'The document and its history are removed from the library for good.', 'Delete', true))) return false;
    await this.vault.remove(entry.id);
    return true;
  }

  /** Deletes a locked `entry` whose passphrase is lost, after a no-recovery warning; true when deleted. */
  private async forgetDoc(entry: DocEntry): Promise<boolean> {
    const values = await form({
      title: `Delete "${entry.name}"?`,
      text: 'Without its passphrase this document cannot be recovered by anyone. ' +
        'Deleting it removes the document and its history from the library for good.',
      fields: [],
      submit: 'Delete',
      danger: true,
      acknowledge: 'I understand that this document cannot be recovered',
    });
    if (!values) return false;
    await this.vault.remove(entry.id);
    return true;
  }

  /** Locks `entry` with its own passphrase, after a no-recovery warning; true when locked. */
  async lockDoc(entry: DocEntry): Promise<boolean> {
    if (!(await this.saveOpenDoc('Lock'))) return false;
    // The new key stays in memory only while `entry` is on screen in the editor.
    const locked = await this.withDoc(entry, () => this.lockForm(entry));
    return locked === true;
  }

  private async lockForm(entry: DocEntry): Promise<boolean> {
    let secret = '';
    const values = await form({
      title: `Lock "${entry.name}"`,
      text: 'The document and its history are encrypted with a passphrase of their own, asked for each time it is opened, ' +
        'downloaded or shared. There is no recovery: if you forget this passphrase, the document is lost for good.',
      fields: [
        { name: 'secret', label: 'Document passphrase', type: 'password', autocomplete: 'new-password' },
        { name: 'repeat', label: 'Repeat document passphrase', type: 'password', autocomplete: 'new-password' },
      ],
      acknowledge: 'I understand that a forgotten passphrase cannot be recovered',
      submit: 'Lock',
      validate: async (v) => {
        if ((v.secret ?? '').length < MIN_DOC_PASSPHRASE) return `Use at least ${MIN_DOC_PASSPHRASE} characters.`;
        if (v.secret !== v.repeat) return 'The passphrases do not match.';
        secret = v.secret ?? '';
        await this.vault.lockDoc(entry.id, secret);
        // A linked file is rewritten for the document key: no library-key copy stays on disk.
        await this.rewriteLink(entry.id);
        return null;
      },
    });
    if (!values) return false;
    // The document on screen keeps saving: its key stays in memory until Home or a reload.
    if (this.session?.editing() === entry.id && !this.vault.isDocOpen(entry.id)) await this.vault.openDoc(entry.id, secret);
    return true;
  }

  /** Removes the lock of `entry` once its passphrase checks out; true when removed. */
  async removeLock(entry: DocEntry): Promise<boolean> {
    if (!(await this.saveOpenDoc('Remove lock'))) return false;
    const values = await form({
      title: `Remove the lock of "${entry.name}"`,
      text: 'The document goes back to the library\'s own protection.',
      fields: [{ name: 'secret', label: 'Document passphrase', type: 'password', autocomplete: 'off' }],
      submit: 'Remove lock',
      validate: async (v) => {
        await this.vault.removeDocLock(entry.id, v.secret ?? '');
        await this.rewriteLink(entry.id);
        return null;
      },
    });
    return values !== null;
  }

  /** Imports each file (into `folder`), then reports what happened to each one. */
  async importFiles(files: File[], folder?: string): Promise<DocEntry[]> {
    const added: DocEntry[] = [];
    const report: [string, string][] = [];
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
  run(action: () => Promise<unknown>): void {
    action().catch((error: unknown) => {
      console.error(error);
      return alert('Something went wrong', errorMessage(error));
    });
  }

  /** Rewrites the linked disk file of `id`, if any, for the key its document now has. */
  private async rewriteLink(id: string): Promise<void> {
    if (this.links?.isLinked(id)) await this.links.write(id, await this.vault.read(id));
  }

  private requireEntry(id: string): DocEntry {
    const entry = this.vault.entry(id);
    if (!entry) throw new Error('no such document');
    return entry;
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
