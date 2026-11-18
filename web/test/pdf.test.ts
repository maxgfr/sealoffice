// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportPdfHandler } from '../src/bridge';
import { canExport, DOWNLOAD_FORMATS } from '../src/exporter';
import { canPdf, isAbort, pdfName, toPdf } from '../src/pdf';
import { minimalDocx, minimalPptx, minimalXlsx } from './ooxml';

// The seal-pdf wasm and its worker are only in a full build (scripts/build.sh): too large to build for every test run.
const DIST = new URL('../../dist/', import.meta.url);
const built = ['pkg/pdf/seal_pdf_bg.wasm', 'pdf-worker.js'].every((f) => existsSync(fileURLToPath(new URL(f, DIST))));

describe('pdf names', () => {
  test('every Word, Excel and PowerPoint extension converts, in any case; CSV and others do not', () => {
    for (const name of ['a.docx', 'a.docm', 'a.dotx', 'a.dotm', 'a.xlsx', 'a.xlsm', 'a.xltx', 'a.xltm',
      'a.pptx', 'a.pptm', 'a.ppsx', 'a.ppsm', 'a.potx', 'a.potm', 'Report.DOCX']) {
      expect(canPdf(name)).toBe(true);
    }
    for (const name of ['a.csv', 'A.CSV', 'a.docx.age', 'a.pdf', 'docx', '']) expect(canPdf(name)).toBe(false);
  });

  test('the PDF is named after the document, its last extension replaced', () => {
    expect(pdfName('Report.docx')).toBe('Report.pdf');
    expect(pdfName('Q3 v1.2.xlsx')).toBe('Q3 v1.2.pdf');
    expect(pdfName('Deck.PPTX')).toBe('Deck.pdf');
    expect(pdfName('notes')).toBe('notes.pdf');
  });

  test('the Download menu offers PDF, disabled for CSV', () => {
    expect(DOWNLOAD_FORMATS.map(([format]) => format)).toContain('pdf');
    expect(canExport('pdf', 'a.xlsx')).toBe(true);
    expect(canExport('pdf', 'a.csv')).toBe(false);
    expect(canExport('plain', 'a.csv')).toBe(true);
  });

  test('a CSV is refused before the module loads', async () => {
    await expect(toPdf({ name: 'a.csv', bytes: new Uint8Array(1) })).rejects.toThrow('PDF export supports Word, Excel and PowerPoint files.');
  });

  test('a cancelled export rejects with an AbortError, which callers keep quiet about', async () => {
    const error = await toPdf({ name: 'a.docx', bytes: new Uint8Array(1) }, AbortSignal.abort()).catch((e: unknown) => e);
    expect(isAbort(error)).toBe(true);
    expect(isAbort(new Error('parse error'))).toBe(false);
  });
});

test('a converter that does not match build-info.json\'s SHA-256 is refused before it compiles', async () => {
  const g = globalThis as { location?: unknown; fetch: unknown };
  const saved = [g.location, g.fetch];
  g.location = { href: 'https://example.test/app/' };
  g.fetch = async (url: URL | string) => String(url).endsWith('/build-info.json')
    ? Response.json({ sha256: { 'pkg/pdf/seal_pdf_bg.wasm': '0'.repeat(64) } })
    : new Response(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  try {
    await expect(toPdf({ name: 'a.docx', bytes: new Uint8Array(1) })).rejects.toThrow('is not this deploy\'s');
  } finally {
    [g.location, g.fetch] = saved;
  }
});

test('an editor PDF export keeps the bytes the editor handed over, and passes its failure on', async () => {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = { querySelector: () => null };
  try {
    const memory = new ArrayBuffer(64);
    const view = new Uint8Array(memory, 8, 4);
    view.set([0x50, 0x4b, 0x03, 0x04]);
    const kept: number[][] = [];
    const handler = exportPdfHandler(async (doc) => {
      await Promise.resolve();
      kept.push([...doc.bytes]);
    });
    const exporting = handler('a.docx', view);
    structuredClone(memory, { transfer: [memory] });
    await exporting;
    expect(kept).toEqual([[0x50, 0x4b, 0x03, 0x04]]);
    await expect(exportPdfHandler(async () => {
      throw new Error('no');
    })('a.docx', new Uint8Array(1))).rejects.toThrow('no');
  } finally {
    g.document = saved;
  }
});

describe.skipIf(!built)('seal-pdf wasm', () => {
  const g = globalThis as { location?: unknown; fetch: unknown };
  const convert = async (name: string, bytes: Uint8Array) => {
    // The wasm and the worker are found next to the page, and the wasm is fetched from there
    // (another test file replaces fetch for good).
    const saved = [g.location, g.fetch];
    g.location = { href: DIST.href };
    g.fetch = async (url: URL | string) =>
      new Response(Bun.file(fileURLToPath(url)), { headers: { 'Content-Type': 'application/wasm' } });
    try {
      return await toPdf({ name, bytes });
    } finally {
      [g.location, g.fetch] = saved;
    }
  };
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5));

  test('converts a Word, an Excel and a PowerPoint file', async () => {
    for (const [name, make] of [['Doc.docx', minimalDocx], ['Book.xlsm', minimalXlsx], ['Deck.pptx', minimalPptx]] as const) {
      const pdf = await convert(name, make(`Hello from ${name}`));
      expect(pdf.name).toBe(pdfName(name));
      expect(text(pdf.bytes)).toBe('%PDF-');
    }
  });

  test('reports a damaged file, then still converts', async () => {
    await expect(convert('Broken.docx', new Uint8Array([1, 2, 3]))).rejects.toThrow('parse error');
    expect(text((await convert('Doc.docx', minimalDocx('again'))).bytes)).toBe('%PDF-');
  });
});
