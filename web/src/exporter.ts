// SPDX-License-Identifier: AGPL-3.0-only
// Exports of a saved vault document, and the download itself.
import type { SealCrypto } from './crypto';
import type { NamedBytes } from './importer';
import { canPdf, toPdf } from './pdf';
import { busy } from './ui';

export type ExportFormat = 'age' | 'office' | 'plain' | 'pdf';

/** The Download menus' entries, in order. */
export const DOWNLOAD_FORMATS: readonly [ExportFormat, string][] = [
  ['plain', 'Original'], ['age', 'Encrypted .age'], ['office', 'Password-protected Office'], ['pdf', 'PDF'],
];

/** Whether a document named `name` can be downloaded in `format`. */
export function canExport(format: ExportFormat, name: string): boolean {
  if (format === 'office') return canOfficeProtect(name);
  if (format === 'pdf') return canPdf(name);
  return true;
}

/**
 * The file to download for `doc` in `format`; `secret` is unused for plain.
 * PDF is converted asynchronously, by `toPdf` in ./pdf.
 */
export function exportDocument(doc: NamedBytes, format: Exclude<ExportFormat, 'pdf'>, secret: string, seal: SealCrypto): NamedBytes {
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

/**
 * Converts `doc` to PDF in the page, behind a busy dialog, then downloads it.
 * Cancelled from the dialog, it rejects with an AbortError (see `isAbort`).
 */
export async function downloadPdf(doc: NamedBytes): Promise<void> {
  const file = await busy('Making the PDF…', 'A long document can take a few seconds. The first export also downloads the converter (about 18 MB).', (signal) => toPdf(doc, signal), true);
  download(file, 'application/pdf');
}

export function download(file: NamedBytes, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type }));
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
