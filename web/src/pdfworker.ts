// SPDX-License-Identifier: AGPL-3.0-only
// The worker one PDF conversion runs in (built to pdf-worker.js). A wasm trap
// (a panic, or memory running out on a huge file) leaves the module unusable,
// and wasm memory never shrinks: a worker per conversion takes both away with
// it, and the page stays responsive meanwhile.
import type { PdfJob, PdfResult } from './pdf';

interface PdfGlue {
  initSync(init: { module: WebAssembly.Module }): unknown;
  to_pdf(bytes: Uint8Array, ext: string): Uint8Array;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<PdfJob>) => void) | null;
  postMessage(message: PdfResult, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = async ({ data }) => {
  try {
    const glue: PdfGlue = await import(data.glue);
    glue.initSync({ module: data.module });
    const pdf = glue.to_pdf(data.bytes, data.ext);
    scope.postMessage({ pdf }, [pdf.buffer]);
  } catch (error) {
    scope.postMessage({
      error: error instanceof WebAssembly.RuntimeError
        ? 'the converter stopped; the document may be too large for it'
        : error instanceof Error ? error.message : String(error),
    });
  }
};
