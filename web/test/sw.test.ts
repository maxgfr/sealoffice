// SPDX-License-Identifier: AGPL-3.0-only
// The service worker reads only sealoffice's own caches: the origin (maxgfr.github.io) is shared
// by other sites, and one of them could plant a response for our URLs in a cache of its own.
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
  g.fetch = (request: Request) => network(request);
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
});
