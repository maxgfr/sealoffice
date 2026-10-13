// SPDX-License-Identifier: AGPL-3.0-only
// Decides which vault document an editor save lands in. The editor names every
// new file the same way ("Document1.docx", and templates too), so a file name
// alone never identifies a stored document: only the one document this page
// handed to the editor, or created from its last save, is ever replaced.
import type { DocEntry } from './vault';

/** The vault operations a save needs. */
export interface SaveVault {
  entry(id: string): DocEntry | undefined;
  list(): DocEntry[];
  uniqueName(name: string): string;
  write(name: string, bytes: Uint8Array, id?: string): Promise<DocEntry>;
}

export interface SavePrompts {
  /** The name to save under, or null when cancelled. */
  askName(name: string): Promise<string | null>;
  /** Whether to replace the existing document `name`. */
  confirmReplace(name: string): Promise<boolean>;
}

export interface CurrentDoc {
  id: string | null;
  name: string;
}

/** Names the editor gives a file that has never been saved (vendor i18n shell.tsv). */
const UNTITLED = new Set(
  ['Document1.docx', 'Book1.xlsx', 'Presentation1.pptx', '文書 1.docx', 'プレゼンテーション 1.pptx'].map((n) => n.toLowerCase()),
);

export function isUntitled(name: string): boolean {
  return UNTITLED.has(name.toLowerCase());
}

export class SaveTracker {
  private doc: CurrentDoc | null = null;

  constructor(
    private readonly vault: SaveVault,
    private readonly prompts: SavePrompts,
  ) {}

  /** The vault document the editor is showing, if it is stored. */
  get currentId(): string | null {
    return this.doc?.id ?? null;
  }

  /** Records the document just handed to the editor. */
  opened(doc: CurrentDoc): void {
    this.doc = { id: doc.id, name: doc.name };
  }

  /** Stores a save from the editor; the name it was stored under, or null when cancelled. */
  async save(name: string, bytes: Uint8Array, saveAs: boolean): Promise<string | null> {
    if (saveAs) return this.saveAs(name, bytes);
    const id = this.ownId(name);
    const entry = id
      ? await this.vault.write(name, bytes, id)
      : await this.vault.write(this.freshName(name), bytes);
    this.opened(entry);
    return entry.name;
  }

  private async saveAs(name: string, bytes: Uint8Array): Promise<string | null> {
    const target = await this.prompts.askName(name);
    if (target === null) return null;
    const existing = this.vault.list().find((e) => e.name.toLowerCase() === target.toLowerCase());
    if (existing && !(await this.prompts.confirmReplace(existing.name))) return null;
    const entry = await this.vault.write(target, bytes, existing?.id);
    this.opened(entry);
    return entry.name;
  }

  /** The current document's id when `name` is that document, still stored. */
  private ownId(name: string): string | null {
    const doc = this.doc;
    if (!doc || doc.id === null || doc.name !== name || isUntitled(name)) return null;
    return this.vault.entry(doc.id) ? doc.id : null;
  }

  /** A free vault name; never an untitled name, so the next new file cannot match it. */
  private freshName(name: string): string {
    const unique = this.vault.uniqueName(name);
    if (!isUntitled(unique)) return unique;
    const dot = unique.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [unique.slice(0, dot), unique.slice(dot)] : [unique, ''];
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (this.vault.uniqueName(candidate) === candidate) return candidate;
    }
  }
}
