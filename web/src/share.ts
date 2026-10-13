// SPDX-License-Identifier: AGPL-3.0-only
// Share links: the document travels in the URL fragment, which browsers never
// send to the server. deflate-raw, then age with a random 256-bit key (or a
// passphrase the sender gives separately), then base64url:
//   #s=v1.<name>.<data>.<key>    key in the link
//   #s=v1.<name>.<data>          key given separately
//   #k=v1.<name>.<key>           too large for a link: the .age file goes separately
import type { SealCrypto } from './crypto';
import type { NamedBytes } from './importer';
import { base64url, fromBase64url } from './vault';

const VERSION = 'v1';
/** Past this, links get unwieldy (and some apps cut them): send a file instead. */
export const MAX_LINK_LENGTH = 1_500_000;

export type SharedLink =
  | { kind: 'doc'; name: string; data: Uint8Array; key: string | null }
  | { kind: 'key'; name: string; key: string };

/** A random 256-bit key, base64url. */
export function randomKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The `#s=` fragment for `doc`; the key is left out when `separateKey` is true. */
export async function shareFragment(doc: NamedBytes, key: string, separateKey: boolean, seal: SealCrypto): Promise<string> {
  const data = base64url(seal.encrypt_passphrase(await deflate(doc.bytes), key));
  const parts = [VERSION, encodeName(doc.name), data];
  if (!separateKey) parts.push(key);
  return `#s=${parts.join('.')}`;
}

/** For a document too large for a link: the `.age` file (readable with age -d) and its `#k=` key link. */
export function shareFile(doc: NamedBytes, key: string, seal: SealCrypto): { file: NamedBytes; fragment: string } {
  return {
    file: { name: `${doc.name}.age`, bytes: seal.encrypt_passphrase(doc.bytes, key) },
    fragment: `#k=${[VERSION, encodeName(doc.name), key].join('.')}`,
  };
}

/** Reads a share fragment; null when `hash` is not one. */
export function parseShare(hash: string): SharedLink | null {
  const match = /^#([sk])=(.*)$/s.exec(hash);
  if (!match) return null;
  const [, kind, body = ''] = match;
  const parts = body.split('.');
  if (parts[0] !== VERSION) throw new Error('this share link was made by a newer sealoffice');
  const name = decodeName(parts[1] ?? '');
  if (kind === 'k') {
    if (parts.length !== 3 || !parts[2]) throw new Error('this share link is damaged');
    return { kind: 'key', name, key: parts[2] };
  }
  if ((parts.length !== 3 && parts.length !== 4) || !parts[2]) throw new Error('this share link is damaged');
  return { kind: 'doc', name, data: fromBase64url(parts[2]), key: parts[3] || null };
}

/** The document of a `#s=` link, with its key or the passphrase given separately. */
export async function openShare(link: { name: string; data: Uint8Array }, key: string, seal: SealCrypto): Promise<NamedBytes> {
  return { name: link.name, bytes: await inflate(seal.decrypt_passphrase(link.data, key)) };
}

function encodeName(name: string): string {
  return base64url(new TextEncoder().encode(name));
}

function decodeName(encoded: string): string {
  const name = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64url(encoded));
  if (!name || /[/\\\0]/.test(name)) throw new Error('this share link is damaged');
  return name;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
