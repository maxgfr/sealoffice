// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { importSessionKey, newSessionSecrets, openMessage, sealMessage, SnapshotOrder } from '../src/live/protocol';
import { type LiveEditor, LiveSession, type SessionEvents } from '../src/live/session';
import { MemoryHub, RELAYS } from '../src/live/transport';
import { keyGoesToEditor } from '../src/live/ui';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

class FakeEditor implements LiveEditor {
  dirty = false;
  opened: string[] = [];
  is_dirty(): boolean {
    return this.dirty;
  }
  open_bytes(name: string, data: Uint8Array): void {
    this.opened.push(`${name}:${text(data)}`);
  }
}

async function pair(events: {
  host?: SessionEvents;
  guest?: SessionEvents;
  guestRelease?: (guest: () => LiveSession) => () => Promise<void>;
  releaseTimeoutMs?: number;
} = {}): Promise<{
  hub: MemoryHub; key: CryptoKey; host: LiveSession; guest: LiveSession; guestEditor: FakeEditor;
}> {
  const hub = new MemoryHub();
  const key = await importSessionKey(newSessionSecrets().key);
  const host = new LiveSession(hub.join(), key, {
    host: true, name: 'Host', events: events.host, ...(events.releaseTimeoutMs === undefined ? {} : { releaseTimeoutMs: events.releaseTimeoutMs }),
  });
  host.setInitial({ name: 'a.docx', bytes: bytes('v1') });
  const release = events.guestRelease?.(() => guest);
  const guest: LiveSession = new LiveSession(hub.join(), key, {
    host: false, name: 'Guest', events: events.guest, ...(release ? { beforeRelease: release } : {}),
  });
  const guestEditor = new FakeEditor();
  guest.attachEditor(guestEditor);
  await settle();
  return { hub, key, host, guest, guestEditor };
}

describe('live protocol', () => {
  test('messages round trip, bytes included', async () => {
    const key = await importSessionKey(newSessionSecrets().key);
    const sealed = await sealMessage(key, { type: 'snapshot', seq: 3, name: 'a.docx', bytes: bytes('doc') });
    expect(text(sealed)).not.toContain('a.docx');
    const opened = await openMessage(key, sealed);
    expect(opened).toEqual({ type: 'snapshot', seq: 3, name: 'a.docx', bytes: bytes('doc') });
    const again = await sealMessage(key, { type: 'hello', name: 'x' });
    expect(again.slice(0, 12)).not.toEqual(sealed.slice(0, 12));
  });

  test('tampered or foreign-key messages are rejected', async () => {
    const key = await importSessionKey(newSessionSecrets().key);
    const other = await importSessionKey(newSessionSecrets().key);
    const sealed = await sealMessage(key, { type: 'hello', name: 'x' });
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(openMessage(key, tampered)).rejects.toThrow('live message rejected');
    await expect(openMessage(other, sealed)).rejects.toThrow('live message rejected');
    await expect(importSessionKey('c2hvcnQ')).rejects.toThrow('damaged');
  });

  test('snapshot order only moves forward', () => {
    const order = new SnapshotOrder();
    expect(order.accept(2)).toBe(true);
    expect(order.accept(2)).toBe(false);
    expect(order.accept(1)).toBe(false);
    expect(order.next()).toBe(3);
  });

  test('relays are pinned wss URLs, matching live.html CSP exactly', async () => {
    for (const relay of RELAYS) expect(relay).toMatch(/^wss:\/\/[a-z0-9.-]+$/);
    const html = await Bun.file(new URL('../live.html', import.meta.url)).text();
    const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)?.[1] ?? '';
    const connect = /connect-src ([^;]*)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
    expect(connect).toEqual(["'self'", ...RELAYS]);
    const index = await Bun.file(new URL('../index.html', import.meta.url)).text();
    expect(index).toContain("connect-src 'self';");
  });
});

describe('input shield', () => {
  /** An element inside the containers matching `inside` (comma lists like Element.closest). */
  const element = (inside: string[]): { closest(selectors: string): unknown } => ({
    closest: (selectors) => (selectors.split(',').map((x) => x.trim()).some((x) => inside.includes(x)) ? {} : null),
  });

  test('keys for the editor are blocked; the app\'s own UI still gets them', () => {
    expect(keyGoesToEditor(null)).toBe(true);
    expect(keyGoesToEditor(element([]))).toBe(true);
    expect(keyGoesToEditor(element(['.overlay']))).toBe(false);
    expect(keyGoesToEditor(element(['dialog']))).toBe(false);
    expect(keyGoesToEditor(element(['.live-bar']))).toBe(false);
  });
});

describe('live session', () => {
  test('a host that rejoins as a new instance is followed again', async () => {
    const { hub, key, host, guest, guestEditor } = await pair();
    for (let n = 2; n <= 5; n++) await host.publish({ name: 'a.docx', bytes: bytes(`v${n}`) });
    await settle();
    expect(guestEditor.opened.at(-1)).toBe('a.docx:v5');
    await host.leave();
    await settle();
    // A reload: same room and key, a new peer whose seq restarts.
    const again = new LiveSession(hub.join(), key, { host: true, name: 'Host' });
    again.setInitial({ name: 'a.docx', bytes: bytes('r1') });
    await settle();
    expect(guest.pen).toBe(again.selfId);
    expect(guestEditor.opened.at(-1)).toBe('a.docx:r1');
    await again.publish({ name: 'a.docx', bytes: bytes('r2') });
    await settle();
    expect(guestEditor.opened.at(-1)).toBe('a.docx:r2');
  });

  test('a new guest gets the host document and who holds the pen', async () => {
    const pens: string[] = [];
    const { host, guest, guestEditor } = await pair({ guest: { pen: (holder) => pens.push(holder) } });
    expect(guestEditor.opened).toEqual(['a.docx:v1']);
    expect(guest.pen).toBe(host.selfId);
    expect(guest.holdsPen).toBe(false);
    expect(pens).toEqual([host.selfId]);
  });

  test('snapshots from the pen holder reach the others; stale ones are ignored', async () => {
    const stored: string[] = [];
    const { hub, key, host, guest, guestEditor } = await pair({ host: { snapshot: (s) => stored.push(text(s.bytes)) } });
    await host.publish({ name: 'a.docx', bytes: bytes('v2') });
    await settle();
    expect(guestEditor.opened.at(-1)).toBe('a.docx:v2');
    await expect(guest.publish({ name: 'a.docx', bytes: bytes('nope') })).rejects.toThrow('only the peer holding the pen');
    // A replayed older snapshot changes nothing.
    const replayer = hub.join();
    await settle();
    await replayer.send(await sealMessage(key, { type: 'snapshot', seq: 1, name: 'a.docx', bytes: bytes('old') }));
    await settle();
    expect(guestEditor.opened.at(-1)).toBe('a.docx:v2');
    expect(stored).toEqual([]);
  });

  test('pen request and grant; the new holder publishes to the host', async () => {
    const requests: string[] = [];
    const stored: string[] = [];
    const { host, guest } = await pair({
      host: { penRequest: (peer, name) => requests.push(`${peer}:${name}`), snapshot: (s) => stored.push(text(s.bytes)) },
    });
    await guest.requestPen();
    await settle();
    expect(requests).toEqual([`${guest.selfId}:Guest`]);
    await host.grantPen(guest.selfId);
    await settle();
    expect(guest.holdsPen).toBe(true);
    expect(host.holdsPen).toBe(false);
    await guest.publish({ name: 'a.docx', bytes: bytes('by guest') });
    await settle();
    expect(stored).toEqual(['by guest']);
    await expect(guest.grantPen(host.selfId)).rejects.toThrow('only the host');
  });

  test('only the pen holder\'s snapshots are accepted', async () => {
    const stored: string[] = [];
    const { hub, key, guestEditor } = await pair({ host: { snapshot: (s) => stored.push(text(s.bytes)) } });
    // A peer with the key but without the pen sends a newer snapshot: dropped by everyone.
    const intruder = hub.join();
    await settle();
    await intruder.send(await sealMessage(key, { type: 'snapshot', seq: 99, name: 'a.docx', bytes: bytes('not the holder') }));
    await settle();
    expect(guestEditor.opened).toEqual(['a.docx:v1']);
    expect(stored).toEqual([]);
  });

  test('the holder sends its last changes before the pen moves', async () => {
    const log: string[] = [];
    const { host, guest } = await pair({
      host: {
        snapshot: (s) => log.push(`host got ${text(s.bytes)}`),
        pen: (holder) => log.push(`host pen ${holder === host.selfId ? 'host' : 'guest'}`),
      },
      guestRelease: (self) => async () => {
        log.push('guest flushes');
        await self().publish({ name: 'a.docx', bytes: bytes('unsaved edits') });
      },
    });
    await host.grantPen(guest.selfId);
    await settle();
    expect(guest.holdsPen).toBe(true);
    log.length = 0;
    await host.grantPen(host.selfId);
    expect(log).toEqual(['guest flushes', 'host got unsaved edits', 'host pen host']);
    expect(host.latest && text(host.latest.bytes)).toBe('unsaved edits');
    await settle();
    expect(guest.holdsPen).toBe(false);
  });

  test('a holder that does not answer loses the pen after the timeout', async () => {
    const { host, guest } = await pair({
      releaseTimeoutMs: 30,
      guestRelease: () => () => new Promise<void>(() => undefined),
    });
    await host.grantPen(guest.selfId);
    await settle();
    const started = Date.now();
    await host.grantPen(host.selfId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(host.holdsPen).toBe(true);
  });

  test('a snapshot is held back while the editor has local changes', async () => {
    const { host, guest, guestEditor } = await pair();
    guestEditor.dirty = true;
    await host.publish({ name: 'a.docx', bytes: bytes('v2') });
    await settle();
    expect(guestEditor.opened).toEqual(['a.docx:v1']);
    expect(guest.pending && text(guest.pending.bytes)).toBe('v2');
    guest.loadPending();
    expect(guestEditor.opened.at(-1)).toBe('a.docx:v2');
    expect(guest.pending).toBeNull();
  });

  test('foreign messages are dropped and reported', async () => {
    const rejected: unknown[] = [];
    const hub = new MemoryHub();
    const key = await importSessionKey(newSessionSecrets().key);
    const intruderKey = await importSessionKey(newSessionSecrets().key);
    const guest = new LiveSession(hub.join(), key, { host: false, name: 'G', events: { rejected: (e) => rejected.push(e) } });
    const editor = new FakeEditor();
    guest.attachEditor(editor);
    const intruder = new LiveSession(hub.join(), intruderKey, { host: true, name: 'X' });
    intruder.setInitial({ name: 'evil.docx', bytes: bytes('evil') });
    await settle();
    expect(editor.opened).toEqual([]);
    expect(rejected.length).toBeGreaterThan(0);
  });
});
