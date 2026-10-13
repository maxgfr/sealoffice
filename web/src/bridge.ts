// SPDX-License-Identifier: AGPL-3.0-only
// The window functions the editor calls for File > Open and File > Save.
import { SaveSignal } from './autosave';
import { extension } from './importer';
import { alert, confirm, errorMessage, form } from './ui';
import type { Vault } from './vault';
import { SaveTracker } from './savetracker';
import type { OpenDoc } from './vaultview';
import { withExtension } from './docactions';

interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

declare global {
  interface Window {
    ibisOfficePickFile?: () => Promise<PickedFile | null>;
    ibisOfficeSaveFile?: (name: string, bytes: Uint8Array, saveAs: boolean) => Promise<string | null>;
  }
}

export class Bridge {
  private readonly tracker: SaveTracker;
  /** Fires once each editor save has been written to the vault (or failed). */
  readonly saved = new SaveSignal();
  private afterSave: ((id: string, bytes: Uint8Array) => Promise<void>) | null = null;
  private name = '';
  private writing = 0;

  /** `pick` answers the editor's File > Open (null: nothing to open). */
  constructor(
    vault: Vault,
    private readonly pickDoc: () => Promise<OpenDoc | null>,
  ) {
    this.tracker = new SaveTracker(vault, {
      askName: async (name) => {
        const chosen = await this.askName(name);
        focusEditor();
        return chosen;
      },
      confirmReplace: async (name) => {
        const replace = await confirm(`Replace "${name}"?`, 'A document with this name is already in the library.', 'Replace', true);
        focusEditor();
        return replace;
      },
    });
  }

  /** The library document last opened or saved, for the app bar's actions. */
  get current(): string | null {
    return this.tracker.currentId;
  }

  /** The name of the document in the editor. */
  get currentName(): string {
    return this.name;
  }

  /** Whether an editor save is being written to the library right now. */
  get saving(): boolean {
    return this.writing > 0;
  }

  install(): void {
    window.ibisOfficePickFile = () => this.pick();
    window.ibisOfficeSaveFile = (name, bytes, saveAs) => this.save(name, bytes, saveAs);
  }

  /** Runs after every successful vault save (linked disk files). */
  setAfterSave(hook: (id: string, bytes: Uint8Array) => Promise<void>): void {
    this.afterSave = hook;
  }

  /** Records the document handed to the editor. */
  track(doc: OpenDoc): void {
    this.tracker.opened(doc);
    this.name = doc.name;
  }

  private async save(name: string, bytes: Uint8Array, saveAs: boolean): Promise<string | null> {
    this.writing++;
    try {
      const stored = await this.tracker.save(name, bytes, saveAs);
      if (stored !== null) this.name = stored;
      this.saved.emit({ name: stored });
      const id = this.tracker.currentId;
      if (stored !== null && id !== null && this.afterSave) {
        // The vault copy is safe; a failing extra copy is reported without failing the save.
        this.afterSave(id, bytes).catch((error: unknown) => {
          console.error(error);
          void alert('Linked file not updated', `The library has the document, but its file on disk was not updated: ${errorMessage(error)}`);
        });
      }
      return stored;
    } catch (error) {
      this.saved.emit({ error });
      throw error;
    } finally {
      this.writing--;
    }
  }

  private async pick(): Promise<PickedFile | null> {
    const doc = await this.pickDoc();
    focusEditor();
    if (!doc) return null;
    this.track(doc);
    return { name: doc.name, bytes: doc.bytes };
  }

  private async askName(name: string): Promise<string | null> {
    const ext = extension(name);
    const values = await form({
      title: 'Save as',
      fields: [{ name: 'name', label: 'File name', value: name }],
      submit: 'Save',
      validate: (v) => (withExtension(v.name ?? '', ext) === null ? `The name must end in .${ext}.` : null),
    });
    return values ? withExtension(values.name ?? '', ext) : null;
  }
}

/** Gives keyboard focus back to the editor's canvas. */
export function focusEditor(): void {
  document.querySelector<HTMLElement>('body > canvas')?.focus();
}
