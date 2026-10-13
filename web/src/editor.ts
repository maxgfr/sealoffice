// SPDX-License-Identifier: AGPL-3.0-only
// Loads the ibisOffice editor wasm served at ./pkg/editor/.

export type BlankKind = 'docx' | 'xlsx' | 'pptx';

export interface EditorModule {
  default(init: { module_or_path: Response | Promise<Response> }): Promise<unknown>;
  /** Starts the editor; only once per page. `assetBase` must be absolute. */
  run(assetBase: string, fileName?: string, bytes?: Uint8Array): void;
  blank_file(kind: BlankKind): Uint8Array;
}

const base = (): URL => new URL('./pkg/editor/', location.href);

/** The absolute site root the editor fetches its assets from. */
export function assetBase(): string {
  return new URL('.', location.href).href.replace(/\/$/, '');
}

/** Downloads and instantiates the editor; `onProgress` gets 0..1, or null when the size is unknown. */
export async function loadEditor(onProgress: (fraction: number | null) => void): Promise<EditorModule> {
  const mod: EditorModule = await import(new URL('ibis_office_app.js', base()).href);
  await mod.default({ module_or_path: fetchWasm(onProgress) });
  return mod;
}

async function fetchWasm(onProgress: (fraction: number | null) => void): Promise<Response> {
  const url = new URL('ibis_office_app_bg.wasm', base());
  const [response, size] = await Promise.all([fetch(url), wasmSize(url)]);
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  const compressed = response.headers.has('Content-Encoding');
  const total = size > 0 ? size : compressed ? 0 : Number(response.headers.get('Content-Length'));
  if (!response.body || !(total > 0)) {
    onProgress(null);
    return response;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 1));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
}

/** The uncompressed size the build writes next to the wasm, or 0. */
async function wasmSize(wasm: URL): Promise<number> {
  try {
    const response = await fetch(new URL(`${wasm.href}.size`));
    return response.ok ? Number((await response.text()).trim()) || 0 : 0;
  } catch {
    // Missing size file: progress falls back to Content-Length.
    return 0;
  }
}
