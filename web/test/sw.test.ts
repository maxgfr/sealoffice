// SPDX-License-Identifier: AGPL-3.0-only
// The service worker reads only sealoffice's own caches: the origin (maxgfr.github.io) is shared
// by other sites, and one of them could plant a response for our URLs in a cache of its own.
// The PDF converter's wasm is not precached; it is cached on first use once it matches SHA256SUMS.
import { beforeAll, describe, expect, test } from 'bun:test';

type Listener = (event: { request: Request; respondWith(response: Promise<Response>): void; waitUntil(p: Promise<unknown>): void }) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request | string, options?: CacheQueryOptions): Promise<Response | undefined> {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (options?.ignoreSearch) url.search = '';
    return this.entries.get(url.href)?.clone();
  }
  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(typeof request === 'string' ? request : request.url, response);
  }
}

class FakeCaches {
  readonly store = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.store.get(name);
    if (!cache) this.store.set(name, (cache = new FakeCache()));
    return cache;
  }
  async has(name: string): Promise<boolean> {
    return this.store.has(name);
  }
  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }
  /** Searches every cache of the origin: the worker must never call it. */
  async match(): Promise<Response | undefined> {
    throw new Error('caches.match() reads other sites\' caches');
  }
}

const SCOPE = 'https://maxgfr.github.io/sealoffice/';
const CACHE = 'sealoffice-1.0.0-abc';
const fakeCaches = new FakeCaches();
const listeners = new Map<string, Listener>();
let network: (request: Request) => Promise<Response> = () => Promise.reject(new TypeError('offline'));

async function respond(url: string, mode: RequestMode = 'same-origin'): Promise<Response> {
  const request = new Request(url);
  Object.defineProperty(request, 'mode', { value: mode });
  let result: Promise<Response> | undefined;
  listeners.get('fetch')?.({ request, respondWith: (r) => { result = r; }, waitUntil: () => {} });
  if (!result) throw new Error('the worker did not answer');
  return result;
}

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.caches = fakeCaches;
  g.fetch = (input: Request | string) => network(new Request(input));
  g.location = new URL(`${SCOPE}sw.js?v=1.0.0&b=abc`);
  g.registration = { scope: SCOPE };
  g.clients = { claim: async () => {} };
  g.skipWaiting = async () => {};
  g.addEventListener = (type: string, listener: Listener) => listeners.set(type, listener);
  await import('../src/sw');
});

describe('service worker', () => {
  test('serves its own cache when offline', async () => {
    await (await fakeCaches.open(CACHE)).put(`${SCOPE}main.js`, new Response('ours'));
    expect(await (await respond(`${SCOPE}main.js`)).text()).toBe('ours');
  });

  test('serves the previous deploy\'s cache, a page may still run it', async () => {
    await (await fakeCaches.open('sealoffice-0.9.0-old')).put(`${SCOPE}old.js`, new Response('previous'));
    expect(await (await respond(`${SCOPE}old.js`)).text()).toBe('previous');
  });

  test('never serves a response another site planted in its own cache', async () => {
    await (await fakeCaches.open('other-site')).put(`${SCOPE}evil.js`, new Response('planted'));
    await (await fakeCaches.open('other-site')).put(`${SCOPE}build-info.json`, new Response('planted'));
    network = () => Promise.resolve(new Response('network'));
    expect(await (await respond(`${SCOPE}evil.js`)).text()).toBe('network');
    network = () => Promise.reject(new TypeError('offline'));
    await expect(respond(`${SCOPE}evil.js`)).rejects.toThrow('offline');
    expect((await respond(`${SCOPE}build-info.json`)).type).toBe('error');
  });

  test('falls back to its own copy of build-info.json when offline', async () => {
    await (await fakeCaches.open(CACHE)).put(`${SCOPE}build-info.json`, new Response('{"commit":"abc"}'));
    expect(await (await respond(`${SCOPE}build-info.json`)).text()).toBe('{"commit":"abc"}');
  });

  const WASM = `${SCOPE}pkg/pdf/seal_pdf_bg.wasm`;
  const hex = async (text: string): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
  const served = new Map<string, string>();
  const serving = (request: Request): Promise<Response> => {
    const body = served.get(request.url);
    return body === undefined ? Promise.reject(new TypeError('offline')) : Promise.resolve(new Response(body));
  };

  test('installs without the PDF wasm, keeping SHA256SUMS to check it later', async () => {
    served.set(`${SCOPE}build-info.json`, JSON.stringify({ commit: 'abcdef', files: ['main.js', 'pkg/pdf/seal_pdf_bg.wasm', 'assets/a.svg'] }));
    served.set(`${SCOPE}SHA256SUMS`, `${await hex('index')}  index.html\n${await hex('main')}  main.js\n${await hex('wasm')}  pkg/pdf/seal_pdf_bg.wasm\n`);
    for (const [path, body] of [['', 'index'], ['main.js', 'main'], ['pkg/pdf/seal_pdf_bg.wasm', 'wasm']]) served.set(`${SCOPE}${path}`, body ?? '');
    network = serving;
    let installing: Promise<unknown> | undefined;
    listeners.get('install')?.({ request: new Request(SCOPE), respondWith: () => {}, waitUntil: (p) => { installing = p; } });
    await installing;
    const cached = [...(await fakeCaches.open(CACHE)).entries.keys()];
    expect(cached).toContain(`${SCOPE}main.js`);
    expect(cached).toContain(`${SCOPE}SHA256SUMS`);
    expect(cached).not.toContain(WASM);
  });

  test('refuses a PDF wasm that is not this deploy\'s, and caches nothing', async () => {
    await (await fakeCaches.open('sealoffice-0.9.0-old')).put(WASM, new Response('old wasm'));
    served.set(WASM, 'tampered');
    const response = await respond(WASM);
    expect(response.status).toBe(502);
    expect(await (await fakeCaches.open(CACHE)).match(WASM)).toBeUndefined();
  });

  test('reuses another deploy\'s PDF wasm when it is the same file', async () => {
    await (await fakeCaches.open('sealoffice-0.9.0-old')).put(WASM, new Response('wasm'));
    network = () => Promise.reject(new TypeError('offline'));
    expect(await (await respond(WASM)).text()).toBe('wasm');
    expect(await (await (await fakeCaches.open(CACHE)).match(WASM))?.text()).toBe('wasm');
  });

  test('fetches the PDF wasm on first use, checks it, then serves it offline', async () => {
    await fakeCaches.delete('sealoffice-0.9.0-old');
    (await fakeCaches.open(CACHE)).entries.delete(WASM);
    served.set(WASM, 'wasm');
    network = serving;
    expect(await (await respond(WASM)).text()).toBe('wasm');
    network = () => Promise.reject(new TypeError('offline'));
    expect(await (await respond(WASM)).text()).toBe('wasm');
  });
});
