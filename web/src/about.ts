// SPDX-License-Identifier: AGPL-3.0-only
// The About dialog, including the attribution AGPL-3.0 section 7(b) requires.
import { button, h, modal } from './ui';

export interface BuildInfo {
  version: string;
  commit: string;
  upstreamCommit?: string;
  files: string[];
  sha256: Record<string, string>;
}

/**
 * The service worker's URL: the version, and the build (`b`), which changes with every deploy,
 * so each deploy installs its own worker and cache.
 */
export function swUrl(info: Pick<BuildInfo, 'version' | 'commit'>): string {
  const params = new URLSearchParams({ v: info.version });
  if (/^[0-9a-f]{7,}$/.test(info.commit)) params.set('b', info.commit.slice(0, 12));
  return `./sw.js?${params}`;
}

const UPSTREAM = 'https://github.com/ibisjp/ibis-office';
const SOURCE = 'https://github.com/maxgfr/sealoffice';

export async function buildInfo(): Promise<BuildInfo | null> {
  try {
    const response = await fetch(new URL('./build-info.json', location.href), { cache: 'no-cache' });
    return response.ok ? ((await response.json()) as BuildInfo) : null;
  } catch {
    // Offline without a cached copy: About shows "development build".
    return null;
  }
}

function link(href: string, text: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

export async function showAbout(): Promise<void> {
  const info = await buildInfo();
  await modal<void>('About sealoffice', (close, body) => {
    const hashes = info
      ? h('dl', { class: 'hashes' }, ...Object.entries(info.sha256).flatMap(([file, hash]) => [
        h('dt', {}, file),
        h('dd', {}, h('code', {}, hash)),
      ]))
      : null;
    const ok = button('Close', () => close(), 'primary');
    body.append(
      h('p', {}, 'sealoffice is an office suite that runs entirely in your browser. Documents are encrypted with age ' +
        'before they are stored on this device, and nothing is sent over the network.'),
      h('p', { class: 'powered' }, 'Powered by ', link(UPSTREAM, 'ibisOffice')),
      h('p', {}, 'Free software under the GNU AGPL-3.0. ', link(SOURCE, 'Source code'), ' · ',
        link('./LICENSE', 'License'), ' · ', link('./third-party-licenses.md', 'Third-party licenses')),
      h('p', { class: 'muted small' }, info
        ? `Version ${info.version} · build ${info.commit}${info.upstreamCommit ? ` · ibisOffice ${info.upstreamCommit}` : ''}`
        : 'Development build'),
      hashes ?? '',
      h('div', { class: 'actions' }, ok),
    );
    queueMicrotask(() => ok.focus());
  }, undefined);
}
