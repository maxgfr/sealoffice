// SPDX-License-Identifier: AGPL-3.0-only
// Live session messages. Every message is JSON, encrypted with AES-GCM under
// the session key from the link (fresh random 96-bit nonce each time), on top
// of the transport's own encryption. Pure: no DOM, no network.
import { base64url, fromBase64url } from '../vault';

export type LiveMessage =
  | { type: 'hello'; name: string }
  | { type: 'snapshot'; seq: number; name: string; bytes: Uint8Array }
  /** To the host; `auto` when the peer started typing (the pen then moves without asking, once the holder has paused). */
  | { type: 'pen-request'; name: string; auto?: boolean }
  | { type: 'pen-grant'; peer: string }
  /**
   * Host → holder: save and broadcast your last changes, the pen is about to move.
   * With `ifIdleMs`, only if you have not typed for that long; else answer 'pen-busy'.
   */
  | { type: 'pen-release'; ifIdleMs?: number }
  /** Holder → host: done; `seq` is the last snapshot sent. */
  | { type: 'pen-released'; seq: number }
  /** The pen stays with `holder`, who is typing: holder → host, then host → the peer that asked. */
  | { type: 'pen-busy'; holder: string }
  | { type: 'presence'; host: string; pen: string; seq: number };

const NONCE_BYTES = 12;

/** A fresh 128-bit room id and 256-bit key, base64url, for a new session link. */
export function newSessionSecrets(): { room: string; key: string } {
  return {
    room: base64url(crypto.getRandomValues(new Uint8Array(16))),
    key: base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

export async function importSessionKey(key: string): Promise<CryptoKey> {
  const raw = fromBase64url(key);
  if (raw.length !== 32) throw new Error('the session key in this link is damaged');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealMessage(key: CryptoKey, message: LiveMessage): Promise<Uint8Array> {
  const json = JSON.stringify(message, (_k, value: unknown) => (value instanceof Uint8Array ? { $b: base64url(value) } : value));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(json)));
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce);
  out.set(ct, NONCE_BYTES);
  return out;
}

/** Decrypts and checks a message; throws when it was altered, made with another key, or malformed. */
export async function openMessage(key: CryptoKey, data: Uint8Array): Promise<LiveMessage> {
  if (data.length <= NONCE_BYTES) throw new Error('live message too short');
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, NONCE_BYTES) }, key, data.slice(NONCE_BYTES));
  } catch (error) {
    throw new Error(`live message rejected: it was altered or made with another key (${String(error)})`);
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain), (_k, value: unknown) =>
    typeof value === 'object' && value !== null && typeof (value as { $b?: unknown }).$b === 'string'
      ? fromBase64url((value as { $b: string }).$b)
      : value);
  if (!isLiveMessage(parsed)) throw new Error('live message malformed');
  return parsed;
}

function isLiveMessage(m: unknown): m is LiveMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  switch (r.type) {
    case 'hello':
      return typeof r.name === 'string';
    case 'pen-request':
      return typeof r.name === 'string' && (r.auto === undefined || typeof r.auto === 'boolean');
    case 'snapshot':
      return typeof r.seq === 'number' && Number.isInteger(r.seq) && typeof r.name === 'string' && r.bytes instanceof Uint8Array;
    case 'pen-grant':
      return typeof r.peer === 'string';
    case 'pen-release':
      return r.ifIdleMs === undefined || (typeof r.ifIdleMs === 'number' && Number.isFinite(r.ifIdleMs) && r.ifIdleMs >= 0);
    case 'pen-busy':
      return typeof r.holder === 'string';
    case 'pen-released':
      return typeof r.seq === 'number';
    case 'presence':
      return typeof r.host === 'string' && typeof r.pen === 'string' && typeof r.seq === 'number';
    default:
      return false;
  }
}

/** Accepts only snapshots newer than the last one accepted. */
export class SnapshotOrder {
  private last = 0;

  get seq(): number {
    return this.last;
  }

  /** True (and remembered) when `seq` is newer than everything before. */
  accept(seq: number): boolean {
    if (seq <= this.last) return false;
    this.last = seq;
    return true;
  }

  /** Forgets every seq: a new sender instance numbers from 1 again. */
  reset(): void {
    this.last = 0;
  }

  /** The seq for a snapshot this peer sends. */
  next(): number {
    this.last += 1;
    return this.last;
  }
}
