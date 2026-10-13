// SPDX-License-Identifier: AGPL-3.0-only
// Exports of a saved vault document, and the download itself.
import type { SealCrypto } from './crypto';
import type { NamedBytes } from './importer';

export type ExportFormat = 'age' | 'office' | 'plain';

/** The file to download for `doc` in `format`; `secret` is unused for plain. */
export function exportDocument(doc: NamedBytes, format: ExportFormat, secret: string, seal: SealCrypto): NamedBytes {
  switch (format) {
    case 'age':
      return { name: `${doc.name}.age`, bytes: seal.encrypt_passphrase(doc.bytes, secret) };
    case 'office':
      return { name: doc.name, bytes: seal.office_protect(doc.bytes, secret) };
    case 'plain':
      return doc;
  }
}

/** Office protection only applies to OOXML packages, not CSV. */
export function canOfficeProtect(name: string): boolean {
  return !name.toLowerCase().endsWith('.csv');
}

export function download(file: NamedBytes): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Some browsers read the URL just after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
