// SPDX-License-Identifier: AGPL-3.0-only
// The window functions the editor calls for File > Open and File > Save.
import { extension } from './importer';
import { confirm, form } from './ui';
import type { Vault } from './vault';
import { SaveTracker } from './savetracker';
import type { OpenDoc, VaultView } from './vaultview';
import { withExtension } from './vaultview';

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

  constructor(
    vault: Vault,
    private readonly view: VaultView,
  ) {
    this.tracker = new SaveTracker(vault, {
      askName: async (name) => {
        const chosen = await this.askName(name);
        focusEditor();
        return chosen;
      },
      confirmReplace: async (name) => {
        const replace = await confirm(`Replace "${name}"?`, 'A document with this name is already in the vault.', 'Replace', true);
        focusEditor();
        return replace;
      },
    });
  }

  /** The vault document last opened or saved, for Export. */
  get current(): string | null {
    return this.tracker.currentId;
  }

  install(): void {
    window.ibisOfficePickFile = () => this.pick();
    window.ibisOfficeSaveFile = (name, bytes, saveAs) => this.tracker.save(name, bytes, saveAs);
  }

  /** Records the document handed to the editor. */
  track(doc: OpenDoc): void {
    this.tracker.opened(doc);
  }

  private async pick(): Promise<PickedFile | null> {
    const doc = await this.view.show({ choose: true, closable: true });
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
