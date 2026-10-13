// SPDX-License-Identifier: AGPL-3.0-only
// Offline cache, one cache per version: the core files listed in build-info.json are precached at
// install; assets/** (icons, art borders) are cached on first use.

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WorkerScope {
  readonly location: Location;
  readonly registration: { readonly scope: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const PREFIX = 'sealoffice-';
const version = new URL(scope.location.href).searchParams.get('v') ?? 'dev';
const CACHE = `${PREFIX}${version}`;
const BUILD_INFO = 'build-info.json';

const ASSETS = 'assets/';

const resolve = (path: string): string => new URL(path, scope.registration.scope).href;

scope.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch(resolve(BUILD_INFO), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${BUILD_INFO}: HTTP ${response.status}`);
    const info = (await response.json()) as { files?: unknown };
    const files = Array.isArray(info.files)
      ? info.files.filter((f): f is string => typeof f === 'string' && !f.startsWith(ASSETS))
      : [];
    const cache = await caches.open(CACHE);
    await cache.addAll(['./', ...files].map((f) => new Request(resolve(f), { cache: 'no-cache' })));
    await scope.skipWaiting();
  })());
});

scope.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await scope.clients.claim();
  })());
});

scope.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.location.origin) return;
  if (url.pathname.endsWith(`/${BUILD_INFO}`)) {
    // Always ask the network first, so a new release is noticed.
    event.respondWith(fetch(request).catch(async () => (await caches.match(request)) ?? Response.error()));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && url.pathname.startsWith(new URL(resolve(ASSETS)).pathname)) {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
