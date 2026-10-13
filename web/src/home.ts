// SPDX-License-Identifier: AGPL-3.0-only
// The home screen: create a document, open a file, and the documents as cards
// (search, sort, folders, grid or list), each with its ⋯ menu; the footer says
// how the library is stored and protected.
import type { BlankKind } from './editor';
import type { DocActions } from './docactions';
import type { ExportFormat } from './exporter';
import { canOfficeProtect } from './exporter';
import { fileIcon, icon } from './icons';
import { ACCEPT } from './importer';
import {
  button, formatRelative, formatSize, h, type MenuItem, menuButton, pickLocalFiles, searchKey, select,
} from './ui';
import type { DocEntry, Vault } from './vault';

/** The three blank documents, with the name each new one starts from. */
export const NEW_KINDS: { kind: BlankKind; label: string; name: string }[] = [
  { kind: 'docx', label: 'Word document', name: 'Document.docx' },
  { kind: 'xlsx', label: 'Excel workbook', name: 'Workbook.xlsx' },
  { kind: 'pptx', label: 'PowerPoint presentation', name: 'Presentation.pptx' },
];

type SortOrder = 'modified' | 'name' | 'size';
type ViewMode = 'grid' | 'list';
const SORT_SETTING = 'sealoffice-sort';
const VIEW_SETTING = 'sealoffice-view';
/** Folder filter values besides a folder name. */
const ALL = '\0all';
const TOP = '\0top';

function setting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: use the default.
    return null;
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** What the home screen asks of the page around it (main.ts). */
export interface HomeHost {
  /** Whether this browser can run the editor (WebGPU or WebGL2). */
  graphics: boolean;
  create(kind: BlankKind): Promise<void>;
  open(entry: DocEntry): Promise<void>;
  settings(): Promise<void>;
  about(): Promise<void>;
  /** Saves, then locks a protected library. */
  lockLibrary(): Promise<void>;
  /** Offers to protect an unprotected library (Settings). */
  protect(): Promise<void>;
}

export class Home {
  readonly el: HTMLElement;
  private readonly createRow = h('div', { class: 'tiles' });
  private readonly filters = h('div', { class: 'doc-toolbar' });
  private readonly docs = h('div', { class: 'docs' });
  private readonly footer = h('footer', { class: 'home-footer muted small' });
  private readonly statusSlot = h('div', {});
  private readonly search: HTMLInputElement;
  private query = '';
  private sort: SortOrder;
  private view: ViewMode;
  private folderFilter = ALL;
  /** Folders made with "New folder…" that hold no document yet. */
  private readonly newFolders = new Set<string>();
  /** The document open in the editor, and its save state. */
  private openDoc: { id: string; state: string } | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly actions: DocActions,
    private readonly host: HomeHost,
  ) {
    const savedSort = setting(SORT_SETTING);
    this.sort = savedSort === 'name' || savedSort === 'size' ? savedSort : 'modified';
    this.view = setting(VIEW_SETTING) === 'list' ? 'list' : 'grid';
    this.search = h('input', { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents', class: 'search' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.renderDocs();
    });
    const links = actions.diskLinks;
    const bar = h(
      'header',
      { class: 'home-bar' },
      h('span', { class: 'brand' }, 'sealoffice'),
      this.search,
      h('div', { class: 'home-bar-actions' },
        button('Import', () => this.run(() => this.pickAndImport(false))),
        links ? button('Open a .age from disk…', () => this.run(async () => {
          if (await actions.openFromDisk()) this.refresh();
        })) : null,
        button('Settings', () => this.run(() => host.settings())),
        button('About', () => this.run(() => host.about())),
      ),
    );
    const banner = host.graphics
      ? null
      : h('p', { class: 'form-error banner', role: 'note' },
        'Editing is unavailable in this browser: it has neither WebGPU nor WebGL2. ' +
        'You can still import, download, back up, restore and share documents. To edit, use a recent Chrome, Edge, Safari or Firefox.');
    const main = h(
      'main',
      { class: 'home-main' },
      banner,
      this.statusSlot,
      h('section', { class: 'home-section', 'aria-labelledby': 'create-title' }, h('h2', { id: 'create-title' }, 'Create'), this.createRow),
      h('section', { class: 'home-section', 'aria-labelledby': 'docs-title' },
        h('div', { class: 'section-head' }, h('h2', { id: 'docs-title' }, 'Documents'), this.filters),
        this.docs),
      this.footer,
    );
    this.el = h('div', { class: 'home' }, bar, main);
    this.el.hidden = true;
    this.renderTiles();
    this.listenForDrops();
    document.body.append(this.el);
  }

  /** Shows the editor's download progress above the tiles until it is removed. */
  showStatus(el: HTMLElement): void {
    this.statusSlot.replaceChildren(el);
  }

  show(): void {
    this.el.hidden = false;
    this.refresh();
    if (!this.el.contains(document.activeElement)) this.el.querySelector<HTMLElement>('.tile:not(:disabled), button')?.focus();
  }

  hide(): void {
    this.el.hidden = true;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** Marks the card of the document open in the editor (null: none). */
  markOpen(id: string | null, state = ''): void {
    this.openDoc = id === null ? null : { id, state };
    if (this.visible) this.renderDocs();
  }

  refresh(): void {
    this.renderFilters();
    this.renderDocs();
    this.renderFooter().catch((error: unknown) => console.warn('storage estimate unavailable:', error));
  }

  private renderTiles(): void {
    const tiles = NEW_KINDS.map(({ kind, label }) => {
      const tile = h('button', { type: 'button', class: `tile ${kind}` }, fileIcon(kind, 44), h('span', {}, label));
      tile.addEventListener('click', () => this.run(() => this.host.create(kind)));
      tile.disabled = !this.host.graphics;
      return tile;
    });
    const open = h('button', { type: 'button', class: 'tile open-file' },
      h('span', { class: 'tile-glyph' }, icon('open', 30)),
      h('span', {}, 'Open a file'),
      h('span', { class: 'muted small' }, 'Office or .age'));
    open.addEventListener('click', () => this.run(() => this.pickAndImport(true)));
    open.disabled = !this.host.graphics;
    this.createRow.replaceChildren(...tiles, open);
  }

  /** Picks files and imports them; with `openOne`, a single imported file opens in the editor. */
  private async pickAndImport(openOne: boolean): Promise<void> {
    const files = await pickLocalFiles(ACCEPT, !openOne);
    if (files.length > 0) await this.importFiles(files, openOne);
  }

  private async importFiles(files: File[], openOne: boolean): Promise<void> {
    const folder = this.folderFilter === ALL || this.folderFilter === TOP ? undefined : this.folderFilter;
    const added = await this.actions.importFiles(files, folder);
    this.refresh();
    const only = added[0];
    if (openOne && this.host.graphics && added.length === 1 && only) await this.host.open(only);
  }

  /** Files dropped anywhere on the page are imported. */
  private listenForDrops(): void {
    this.el.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      this.el.classList.add('dropping');
    });
    this.el.addEventListener('dragleave', (event) => {
      if (event.relatedTarget === null || !this.el.contains(event.relatedTarget as Node)) this.el.classList.remove('dropping');
    });
    this.el.addEventListener('drop', (event) => {
      event.preventDefault();
      this.el.classList.remove('dropping');
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) this.run(() => this.importFiles(files, false));
    });
  }

  /** Folders in use plus the ones just made. */
  private allFolders(): string[] {
    return [...new Set([...this.vault.folders(), ...this.newFolders])].sort((a, b) => a.localeCompare(b));
  }

  private renderFilters(): void {
    const folders = this.allFolders();
    if (this.folderFilter !== ALL && this.folderFilter !== TOP && !folders.includes(this.folderFilter)) this.folderFilter = ALL;
    const chip = (value: string, text: string): HTMLButtonElement => {
      const el = button(text, () => {
        this.folderFilter = value;
        this.refresh();
      }, 'chip');
      el.setAttribute('aria-pressed', String(this.folderFilter === value));
      return el;
    };
    const viewButton = (mode: ViewMode, label: string): HTMLButtonElement => {
      const el = h('button', { type: 'button', class: 'icon-button', 'aria-label': label, title: label, 'aria-pressed': String(this.view === mode) },
        icon(mode));
      el.addEventListener('click', () => {
        this.view = mode;
        saveSetting(VIEW_SETTING, mode);
        this.refresh();
      });
      return el;
    };
    this.filters.replaceChildren(
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Folders' },
        chip(ALL, 'All'),
        folders.length > 0 ? chip(TOP, 'No folder') : null,
        ...folders.map((f) => chip(f, f)),
        button('New folder…', () => this.run(async () => {
          const name = await this.actions.askFolder('New folder', '', this.allFolders());
          if (name === null || name === '') return;
          this.newFolders.add(name);
          this.folderFilter = name;
          this.refresh();
        }), 'chip add')),
      h('div', { class: 'view-controls' },
        select('Sort by', [['modified', 'Last modified'], ['name', 'Name'], ['size', 'Size']], this.sort, (value) => {
          this.sort = value === 'name' || value === 'size' ? value : 'modified';
          saveSetting(SORT_SETTING, this.sort);
          this.renderDocs();
        }),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewButton('grid', 'Grid view'), viewButton('list', 'List view'))),
    );
  }

  private renderDocs(): void {
    const all = this.vault.list();
    const key = searchKey(this.query.trim());
    const docs = all
      .filter((e) => key === '' || searchKey(e.name).includes(key))
      .filter((e) => this.folderFilter === ALL || (this.folderFilter === TOP ? e.folder === undefined : e.folder === this.folderFilter))
      .sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name) : this.sort === 'size' ? b.size - a.size : b.modified - a.modified);
    if (all.length === 0) {
      this.docs.replaceChildren(h('div', { class: 'empty-state' },
        h('p', {}, 'No documents yet. Create one above, open a file, or drop files anywhere on this page.'),
        button('Restore a backup…', () => this.run(async () => {
          if (await this.actions.restore()) this.refresh();
        }))));
      return;
    }
    if (docs.length === 0) {
      this.docs.replaceChildren(h('p', { class: 'empty-state muted' }, 'No document matches.'));
      return;
    }
    this.docs.replaceChildren(h('ul', { class: `doc-${this.view}`, 'aria-label': 'Documents' }, ...docs.map((entry) => this.card(entry))));
  }

  private card(entry: DocEntry): HTMLElement {
    const links = this.actions.diskLinks;
    const isOpen = this.openDoc?.id === entry.id;
    const badges = h('span', { class: 'badges' },
      entry.lock ? h('span', { class: 'badge-pill', title: 'Locked with its own passphrase' }, icon('lock', 12), 'Locked') : null,
      links?.isLinked(entry.id) ? h('span', { class: 'badge-pill', title: 'Every save also rewrites its .age file on disk' }, icon('link', 12), 'Linked') : null,
      entry.folder !== undefined ? h('span', { class: 'badge-pill' }, icon('folder', 12), entry.folder) : null,
      isOpen ? h('span', { class: 'badge-pill open' }, this.openDoc?.state ? `Open · ${this.openDoc.state}` : 'Open') : null,
    );
    const openButton = h('button', { type: 'button', class: 'doc-open', 'aria-label': `Open ${entry.name}` },
      fileIcon(entry.name, this.view === 'grid' ? 48 : 28),
      h('span', { class: 'doc-text' },
        h('span', { class: 'doc-name' }, entry.name),
        h('span', { class: 'doc-meta muted small' }, `${formatRelative(entry.modified)} · ${formatSize(entry.size)}`)));
    openButton.title = entry.name;
    openButton.disabled = !this.host.graphics;
    openButton.addEventListener('click', () => this.run(() => this.host.open(entry)));
    const more = menuButton(icon('more'), `More actions for ${entry.name}`, () => this.menuItems(entry), 'icon-button doc-more');
    return h('li', { class: `doc-card${isOpen ? ' is-open' : ''}`, 'data-id': entry.id }, openButton, badges, more);
  }

  /** The ⋯ menu of a card. */
  private menuItems(entry: DocEntry): (MenuItem | null)[] {
    const a = this.actions;
    const links = a.diskLinks;
    const refreshAfter = (action: () => Promise<unknown>) => (): void => this.run(async () => {
      if (await action()) this.refresh();
    });
    const formats: [ExportFormat, string][] = [['plain', 'Original'], ['age', 'Encrypted .age'], ['office', 'Password-protected Office']];
    return [
      this.host.graphics ? { label: 'Open', action: () => this.run(() => this.host.open(entry)) } : null,
      { label: 'Rename…', action: refreshAfter(() => a.renameDoc(entry)) },
      { label: 'Move to…', action: refreshAfter(async () => {
        const folder = await a.askFolder(`Move "${entry.name}"`, entry.folder ?? '', this.allFolders());
        if (folder === null) return false;
        await this.vault.setFolder(entry.id, folder);
        this.newFolders.delete(folder);
        return true;
      }) },
      { label: 'Version history', action: refreshAfter(() => a.history(entry)) },
      {
        label: 'Download',
        items: formats.map(([format, label]) => ({
          label,
          disabled: format === 'office' && !canOfficeProtect(entry.name),
          action: () => this.run(() => a.exportDoc(entry.id, format)),
        })),
      },
      { label: 'Share link…', action: () => this.run(() => a.shareDoc(entry.id)) },
      this.host.graphics ? { label: 'Live session…', action: () => this.run(() => a.startLive(entry)) } : null,
      links ? { label: links.isLinked(entry.id) ? 'Unlink from disk' : 'Link to disk…', action: refreshAfter(() => a.toggleLink(entry)) } : null,
      entry.lock
        ? { label: 'Remove lock…', action: refreshAfter(() => a.removeLock(entry)) }
        : { label: 'Lock…', action: refreshAfter(() => a.lockDoc(entry)) },
      { label: 'Delete…', danger: true, action: refreshAfter(() => a.deleteDoc(entry)) },
    ];
  }

  /** Storage use and persistence, then how the library is protected. */
  private async renderFooter(): Promise<void> {
    const storage = h('span', {});
    const protection = this.vault.isProtected
      ? h('span', { class: 'protection' }, h('strong', {}, 'Protected'), ' · ',
        button('Lock now', () => this.run(() => this.host.lockLibrary()), 'link'))
      : h('span', { class: 'protection' }, h('strong', {}, 'Not protected'),
        ': anyone using this browser profile can open these documents. ',
        button('Protect…', () => this.run(() => this.host.protect()), 'link'));
    this.footer.replaceChildren(protection, storage);
    if (!navigator.storage?.estimate) return;
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    storage.replaceChildren(
      `Storage: ${formatSize(usage ?? 0)} used of ${formatSize(quota ?? 0)} · `,
      persisted ? 'Persistent' : 'Not persistent: the browser may evict it when space runs low (see Settings).',
    );
  }

  private run(action: () => Promise<unknown>): void {
    this.actions.run(action);
  }
}
