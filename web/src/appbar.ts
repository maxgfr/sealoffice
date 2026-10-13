// SPDX-License-Identifier: AGPL-3.0-only
// The editor screen's 48 px app bar: back to Home, the document's icon and
// name (renamed in place), its save state, Share, Download ▸, ⋯ and, in a
// protected library, Lock library. The editor's canvas starts below it.
import type { DocActions } from './docactions';
import type { ExportFormat } from './exporter';
import { canOfficeProtect } from './exporter';
import { fileIcon, icon } from './icons';
import { button, h, type MenuItem, menuButton } from './ui';
import type { DocEntry, Vault } from './vault';

export interface AppBarHost {
  /** Saves, then shows the home screen. */
  home(): Promise<void>;
  /** The library document in the editor, once it was saved. */
  current(): DocEntry | undefined;
  /** The editor document's name, saved or not. */
  currentName(): string;
  /** Saves, renames the open document to `name` and shows it under that name. */
  rename(entry: DocEntry, name: string): Promise<void>;
  lockLibrary(): Promise<void>;
  about(): Promise<void>;
}

export class AppBar {
  readonly el: HTMLElement;
  private readonly iconSlot = h('span', { class: 'appbar-icon' });
  private readonly nameButton = h('button', { type: 'button', class: 'appbar-name', title: 'Rename' });
  private readonly nameSlot = h('span', { class: 'appbar-title' });
  private readonly state = h('span', { class: 'save-state muted small', role: 'status' });
  private readonly lockLibraryButton: HTMLButtonElement;
  private renaming = false;

  constructor(
    private readonly vault: Vault,
    private readonly actions: DocActions,
    private readonly host: AppBarHost,
  ) {
    const run = (action: () => Promise<unknown>) => (): void => actions.run(action);
    const homeButton = h('button', { type: 'button', class: 'appbar-home', 'aria-label': 'Home' }, icon('back'), h('span', {}, 'Home'));
    homeButton.addEventListener('click', run(() => host.home()));
    this.nameButton.addEventListener('click', () => this.startRename());
    this.nameSlot.append(this.nameButton);
    this.lockLibraryButton = button('Lock library', run(() => host.lockLibrary()));
    const share = h('button', { type: 'button', class: 'appbar-action' }, icon('share', 16), h('span', {}, 'Share'));
    share.addEventListener('click', run(async () => {
      const entry = await this.savedEntry('Share');
      if (entry) await actions.shareDoc(entry.id);
    }));
    const formats: [ExportFormat, string][] = [['plain', 'Original'], ['age', 'Encrypted .age'], ['office', 'Password-protected Office']];
    const downloadMenu = menuButton([icon('download', 16), h('span', {}, 'Download')], 'Download', () => formats.map(([format, label]) => ({
      label,
      disabled: format === 'office' && !canOfficeProtect(host.currentName()),
      action: run(async () => {
        const entry = await this.savedEntry('Download');
        if (entry) await actions.exportDoc(entry.id, format);
      }),
    })), 'appbar-action');
    const more = menuButton(icon('more'), 'More actions', () => this.moreItems(), 'icon-button');
    this.el = h(
      'nav',
      { class: 'appbar', 'aria-label': 'Document' },
      homeButton,
      this.iconSlot,
      this.nameSlot,
      this.state,
      h('span', { class: 'appbar-spacer' }),
      share,
      downloadMenu,
      more,
      this.lockLibraryButton,
    );
    this.el.hidden = true;
    document.body.append(this.el);
  }

  show(): void {
    this.el.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.el.hidden = true;
  }

  /** Redraws the name, icon and the protected-only Lock library button. */
  refresh(): void {
    const name = this.host.currentName();
    this.iconSlot.replaceChildren(fileIcon(name, 20));
    if (!this.renaming) this.nameButton.textContent = name;
    this.lockLibraryButton.hidden = !this.vault.isProtected;
  }

  /** Saving…, Saved, Unsaved changes or Not saved (with the reason as a tooltip). */
  showState(text: string, detail = ''): void {
    if (this.state.textContent !== text) this.state.textContent = text;
    this.state.title = detail;
    if (!this.renaming && this.nameButton.textContent !== this.host.currentName()) this.refresh();
  }

  /** The open document's entry after saving it; null when it cannot be saved or the user stopped. */
  private async savedEntry(action: string): Promise<DocEntry | null> {
    if (!(await this.actions.saveOpenDoc(action))) return null;
    const entry = this.host.current();
    if (!entry) throw new Error('save the document to the library first');
    return entry;
  }

  private moreItems(): (MenuItem | null)[] {
    const a = this.actions;
    const links = a.diskLinks;
    const entry = this.host.current();
    const run = (action: (entry: DocEntry) => Promise<unknown>) => (): void => a.run(async () => {
      const saved = await this.savedEntry('Continue');
      if (saved) await action(saved);
      this.refresh();
    });
    return [
      { label: 'Version history', action: run((e) => a.history(e)) },
      { label: 'Live session…', action: run((e) => a.startLive(e)) },
      entry?.lock
        ? { label: 'Remove document lock…', action: run((e) => a.removeLock(e)) }
        : { label: 'Lock document…', action: run((e) => a.lockDoc(e)) },
      links
        ? { label: entry && links.isLinked(entry.id) ? 'Unlink from disk' : 'Link to disk…', action: run((e) => a.toggleLink(e)) }
        : null,
      { label: 'About', action: () => a.run(() => this.host.about()) },
    ];
  }

  /** Replaces the name with a text field: Enter renames, Escape or an unchanged name cancels. */
  private startRename(): void {
    const entry = this.host.current();
    if (!entry || this.renaming) return;
    this.renaming = true;
    const input = h('input', { type: 'text', class: 'appbar-rename', 'aria-label': 'Document name', spellcheck: 'false' });
    input.value = entry.name;
    const error = h('span', { class: 'form-error small', role: 'alert' });
    let done = false;
    const finish = (): void => {
      done = true;
      this.renaming = false;
      this.nameSlot.replaceChildren(this.nameButton);
      this.refresh();
    };
    const commit = (): void => {
      if (done) return;
      const name = input.value.trim();
      if (name === '' || name === entry.name) {
        finish();
        this.nameButton.focus();
        return;
      }
      const problem = this.actions.nameProblem(entry, name);
      if (problem) {
        error.textContent = problem;
        input.select();
        return;
      }
      done = true;
      this.actions.run(async () => {
        try {
          await this.host.rename(entry, name);
        } finally {
          finish();
        }
      });
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish();
        this.nameButton.focus();
      }
    });
    input.addEventListener('input', () => {
      error.textContent = '';
    });
    input.addEventListener('blur', () => {
      if (!done && !error.textContent) commit();
    });
    this.nameSlot.replaceChildren(input, error);
    input.focus();
    // Select the name without its extension.
    input.setSelectionRange(0, Math.max(0, entry.name.lastIndexOf('.')));
  }
}
