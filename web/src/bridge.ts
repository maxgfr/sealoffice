// SPDX-License-Identifier: AGPL-3.0-only
// The window functions the editor calls for File > Open and File > Save.
import { SaveSignal } from './autosave';
import { editorSaveHandler } from './editor';
import { extension } from './importer';
import { alert, confirm, errorMessage, form, pickLocalFile } from './ui';
import type { Vault } from './vault';
import { SaveTracker } from './savetracker';
import type { OpenDoc } from './vaultview';
import { withExtension } from './docactions';
import type { BlankKind } from './editor';

interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

declare global {
  interface Window {
    ibisOfficePickFile?: () => Promise<PickedFile | null>;
    ibisOfficeSaveFile?: (name: string, bytes: Uint8Array, saveAs: boolean) => Promise<string | null>;
    /** In place of the new tab the editor opens: `?new=<kind>` (File > New) or `''` (its logo). */
    ibisOfficeOpenTab?: (query: string) => void;
    ibisOfficePickIcc?: () => Promise<PickedFile | null>;
    ibisOfficeIccSave?: (name: string, bytes: Uint8Array) => void;
    ibisOfficeIccForget?: () => void;
    ibisOfficeIccLoad?: () => Promise<PickedFile | null>;
    ibisOfficeFontFetchText?: (url: string) => Promise<string>;
    ibisOfficeFontsInstalled?: () => Promise<{ file: string; size: number }[]>;
    ibisOfficeFontDownload?: (file: string, url: string, size: number) => Promise<number>;
    ibisOfficeFontsLoad?: () => Promise<Uint8Array[]>;
    ibisOfficeEmbedAction?: (kind: string, name: string, bytes?: Uint8Array) => void;
  }
}

/**
 * The editor's other window functions, so none is missing when it calls (one
 * it declares without `catch` throws inside the wasm). Nothing leaves the
 * page: the font list is empty, so the font setup never offers a download,
 * and a CMYK profile is kept for this page only, outside the library.
 */
export function installEditorHooks(): void {
  let icc: PickedFile | null = null;
  window.ibisOfficeFontFetchText = async () => '';
  window.ibisOfficeFontsInstalled = async () => [];
  window.ibisOfficeFontsLoad = async () => [];
  window.ibisOfficeFontDownload = () => Promise.reject(new Error('font downloads are off in sealoffice'));
  window.ibisOfficePickIcc = async () => {
    const file = await pickLocalFile('.icc,.icm');
    focusEditor();
    return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  };
  // A view on the wasm memory, valid only during the call: copied.
  window.ibisOfficeIccSave = (name, bytes) => {
    icc = { name, bytes: bytes.slice() };
  };
  window.ibisOfficeIccForget = () => {
    icc = null;
  };
  window.ibisOfficeIccLoad = async () => icc;
  // The embed buttons are off (no set_embed_options): never called.
  window.ibisOfficeEmbedAction = () => undefined;
}

/**
 * `open` as the editor calls `ibisOfficeOpenTab`: with the kind of `?new=`, or
 * null for the bare page. Deferred: the editor calls from inside itself, and
 * `open` calls back into it.
 */
export function openTabHandler(open: (kind: BlankKind | null) => void): (query: string) => void {
  return (query) => {
    const kind = new URLSearchParams(query).get('new');
    setTimeout(() => open(kind === 'docx' || kind === 'xlsx' || kind === 'pptx' ? kind : null), 0);
  };
}

export class Bridge {
  private readonly tracker: SaveTracker;
  /** Fires once each editor save has been written to the vault (or failed). */
  readonly saved = new SaveSignal();
  private afterSave: ((id: string, bytes: Uint8Array) => Promise<void>) | null = null;
  private name = '';
  private writing = 0;

  /**
   * `pick` answers the editor's File > Open (null: nothing to open); `openTab`
   * its File > New (a kind) and its logo (null), which upstream opens in a new tab.
   */
  constructor(
    vault: Vault,
    private readonly pickDoc: () => Promise<OpenDoc | null>,
    private readonly openTab: (kind: BlankKind | null) => void,
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
    window.ibisOfficeSaveFile = editorSaveHandler((name, bytes, saveAs) => this.save(name, bytes, saveAs));
    // A new tab would boot another sealoffice (one tab per library), not a new file.
    window.ibisOfficeOpenTab = openTabHandler(this.openTab);
    installEditorHooks();
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
