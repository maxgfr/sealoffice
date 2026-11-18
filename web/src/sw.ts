// SPDX-License-Identifier: AGPL-3.0-only
// Offline cache, one cache per deploy: the core files listed in build-info.json are precached at
// install, each checked against SHA256SUMS so a cache never mixes two deploys (the CDN can serve
// files of the previous one for a while); assets/** (icons, art borders) are cached on first use.
// The PDF converter's wasm (18 MB compressed) is not precached: it is fetched on the first PDF
// export and cached only once it matches this deploy's SHA256SUMS, kept in the cache at install.
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
/** Fetched on first use, then cached once checked against this deploy's SHA256SUMS. */
const ON_DEMAND = 'pkg/pdf/seal_pdf_bg.wasm';

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

async function sha256(data: Response | ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data instanceof Response ? await data.arrayBuffer() : data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match?.[1] && match[2]) sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * `ON_DEMAND` from this deploy's cache; else another own cache's copy, or the network's, taken
 * only if it matches this deploy's SHA256SUMS (stored with the cache at install), then cached.
 * A copy from another deploy is refused, and nothing is cached.
 */
async function onDemand(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const expected = parseSums(await (await cache.match(resolve(SUMS)))?.text() ?? '').get(ON_DEMAND);
  if (!expected) return fetch(request);
  const keep = async (response: Response): Promise<Response | null> => {
    const bytes = await response.arrayBuffer();
    if ((await sha256(bytes)) !== expected) return null;
    await cache.put(request, new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
    return (await cache.match(request)) ?? Response.error();
  };
  // Another deploy's copy is often the same file: no download then.
  const kept = await ownMatch(request);
  const reused = kept && (await keep(kept));
  if (reused) return reused;
  const response = await fetch(request.url, { cache: 'no-cache' });
  if (!response.ok) return response;
  return (await keep(response)) ?? new Response(null, { status: 502, statusText: 'SHA-256 mismatch, not from this deploy' });
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
      ? info.files.filter((f): f is string => typeof f === 'string' && !f.startsWith(ASSETS) && f !== ON_DEMAND)
      : [];
    const sumsResponse = await fresh(SUMS);
    if (!sumsResponse.ok) throw new Error(`${SUMS}: HTTP ${sumsResponse.status}`);
    const sumsText = await sumsResponse.text();
    const sums = parseSums(sumsText);
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
    // What `ON_DEMAND` is checked against when it is fetched.
    await cache.put(new Request(resolve(SUMS)), new Response(sumsText));
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
  if (url.pathname.endsWith(`/${BUILD_INFO}`) || url.pathname.endsWith(`/${SUMS}`)) {
    // Always ask the network first, so a new release is noticed.
    event.respondWith(fetch(request).catch(async () => (await ownMatch(request)) ?? Response.error()));
    return;
  }
  if (url.pathname === new URL(resolve(ON_DEMAND)).pathname) {
    event.respondWith(onDemand(request));
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
