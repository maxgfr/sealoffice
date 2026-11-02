// SPDX-License-Identifier: AGPL-3.0-only
// Offline cache, one cache per deploy: the core files listed in build-info.json are precached at
// install, each checked against SHA256SUMS so a cache never mixes two deploys (the CDN can serve
// files of the previous one for a while); assets/** (icons, art borders) are cached on first use.
// The previous deploy's cache stays until the next one, for pages still running it.

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
const params = new URL(scope.location.href).searchParams;
const version = params.get('v') ?? 'dev';
/** The deploy's commit (its first 12 digits), when the page knew it. */
const build = params.get('b') ?? '';
const CACHE = `${PREFIX}${version}${build ? `-${build}` : ''}`;
/** Remembers which cache is current, so an activation knows the one before. */
const META = `${PREFIX}meta`;
const BUILD_INFO = 'build-info.json';
const SUMS = 'SHA256SUMS';

const ASSETS = 'assets/';

const resolve = (path: string): string => new URL(path, scope.registration.scope).href;

const fresh = (path: string): Promise<Response> => fetch(new Request(resolve(path), { cache: 'no-cache' }));

/**
 * A copy from this app's own caches only: this deploy's first, then the others it kept (a page
 * still running the previous deploy). Never `caches.match()`, which searches every cache of the
 * origin, and the origin (maxgfr.github.io) is shared by other sites, which could plant a
 * response for our URLs in a cache of theirs.
 */
async function ownMatch(request: Request, options?: CacheQueryOptions): Promise<Response | undefined> {
  const names = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== META && name !== CACHE);
  for (const name of [CACHE, ...names]) {
    if (!(await caches.has(name))) continue;
    const hit = await (await caches.open(name)).match(request, options);
    if (hit) return hit;
  }
  return undefined;
}

async function sha256(response: Response): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

scope.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fresh(BUILD_INFO);
    if (!response.ok) throw new Error(`${BUILD_INFO}: HTTP ${response.status}`);
    const info = (await response.json()) as { commit?: unknown; files?: unknown };
    // This worker is named after a deploy: it caches that deploy or nothing.
    const commit = typeof info.commit === 'string' ? info.commit : '';
    if (build && !commit.startsWith(build)) throw new Error(`${BUILD_INFO} is from another deploy (${commit}, not ${build})`);
    const files = Array.isArray(info.files)
      ? info.files.filter((f): f is string => typeof f === 'string' && !f.startsWith(ASSETS))
      : [];
    const sumsResponse = await fresh(SUMS);
    if (!sumsResponse.ok) throw new Error(`${SUMS}: HTTP ${sumsResponse.status}`);
    const sums = new Map<string, string>();
    for (const line of (await sumsResponse.text()).split('\n')) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (match?.[1] && match[2]) sums.set(match[2], match[1]);
    }
    // Fetched in full before anything is stored: a file from another deploy fails the
    // install, and the browser tries again on a later visit.
    const checked = await Promise.all([['./', 'index.html'], ...files.map((f) => [f, f])].map(async ([path = '', sumOf = '']) => {
      const file = await fresh(path);
      if (!file.ok) throw new Error(`${path}: HTTP ${file.status}`);
      const expected = sums.get(sumOf);
      if (expected && (await sha256(file.clone())) !== expected) throw new Error(`${path} is from another deploy`);
      return [path, file] as const;
    }));
    const cache = await caches.open(CACHE);
    for (const [path, file] of checked) await cache.put(new Request(resolve(path)), file);
    await scope.skipWaiting();
  })());
});

scope.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const meta = await caches.open(META);
    const previous = await (await meta.match(resolve('current')))?.text();
    // Pages still running the previous deploy load its files on demand: keep it until the next one.
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE && name !== META && name !== previous) await caches.delete(name);
    }
    if (previous !== CACHE) await meta.put(resolve('current'), new Response(CACHE));
    await scope.clients.claim();
  })());
});

scope.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== scope.location.origin) return;
  if (url.pathname.endsWith(`/${BUILD_INFO}`)) {
    // Always ask the network first, so a new release is noticed.
    event.respondWith(fetch(request).catch(async () => (await ownMatch(request)) ?? Response.error()));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const options = { ignoreSearch: request.mode === 'navigate' };
    // This deploy's copy first, then the previous deploy's (a page still running it).
    const cached = await ownMatch(request, options);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && url.pathname.startsWith(new URL(resolve(ASSETS)).pathname)) {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
