// SPDX-License-Identifier: AGPL-3.0-only
// PDF export through the seal-pdf wasm (crates/seal-pdf: office2pdf and Typst),
// run in the page: the document never leaves it. The module is large, so it is
// downloaded (the service worker does not precache it) and compiled on the
// first export only, after a check against this deploy's SHA-256; each
// conversion then runs in a worker of its own (./pdfworker.ts).
import { buildInfo } from './about';
import { extension, type NamedBytes } from './importer';

/** What the page sends the worker: the compiled module, where its JS glue is, and the document. */
export interface PdfJob {
  module: WebAssembly.Module;
  glue: string;
  bytes: Uint8Array;
  ext: string;
}

export type PdfResult = { pdf: Uint8Array; error?: undefined } | { error: string };

/** The extensions seal-pdf converts; it refuses CSV. Kept in step with `kind` in crates/seal-pdf. */
const PDF_EXTENSIONS: readonly string[] = [
  'docx', 'docm', 'dotx', 'dotm',
  'xlsx', 'xlsm', 'xltx', 'xltm',
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
];

export function canPdf(name: string): boolean {
  return PDF_EXTENSIONS.includes(extension(name));
}

/** `name` with its last extension replaced by .pdf. */
export function pdfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot <= 0 ? name : name.slice(0, dot)}.pdf`;
}

const WASM = 'pkg/pdf/seal_pdf_bg.wasm';

let compiled: Promise<WebAssembly.Module> | null = null;

/**
 * Compiles the wasm served next to the page at `./pkg/pdf/`, once, if it
 * matches the hash build-info.json gives for it (none in a development build).
 */
export function loadPdf(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    const url = new URL(`./${WASM}`, location.href);
    const [response, info] = await Promise.all([
      fetch(url).catch(() => {
        throw new Error('it is downloaded on the first PDF export, about 18 MB: connect to the internet and try again');
      }),
      buildInfo(),
    ]);
    if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    const bytes = await response.arrayBuffer();
    const expected = info?.sha256?.[WASM];
    if (expected) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const actual = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      if (actual !== expected) throw new Error(`${url.pathname} is not this deploy's (its SHA-256 does not match build-info.json)`);
    }
    return WebAssembly.compile(bytes);
  })();
  // A failed load (offline before the first export cached it) can be retried.
  compiled.catch(() => {
    compiled = null;
  });
  return compiled;
}

/** Whether `error` is a cancel through an AbortSignal: callers say nothing about it. */
export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** `promise`, or `signal`'s reason as soon as it aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * `doc` as a PDF named after it. Rejects with the reason alone: the editor and
 * the Download menu each say what failed around it. `signal` cancels: the
 * conversion's worker is stopped, and this rejects with its reason (an AbortError).
 */
export async function toPdf(doc: NamedBytes, signal?: AbortSignal): Promise<NamedBytes> {
  if (!canPdf(doc.name)) throw new Error('PDF export supports Word, Excel and PowerPoint files.');
  signal?.throwIfAborted();
  // A cancelled load goes on: the next export finds it done.
  const module = await unlessAborted(loadPdf().catch((error: unknown) => {
    throw new Error(`the PDF converter did not load (${error instanceof Error ? error.message : String(error)})`);
  }), signal);
  const job: PdfJob = { module, glue: new URL('./pkg/pdf/seal_pdf.js', location.href).href, bytes: doc.bytes, ext: extension(doc.name) };
  return { name: pdfName(doc.name), bytes: await convert(job, signal) };
}

function convert(job: PdfJob, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.js', location.href), { type: 'module' });
    const stop = (): void => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      stop();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<PdfResult>) => {
      stop();
      if (data.error === undefined) resolve(data.pdf);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stop();
      reject(new Error(event.message || 'the PDF converter did not start'));
    };
    // The bytes are copied: the caller keeps its own.
    worker.postMessage(job);
  });
}
