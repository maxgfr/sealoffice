// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { type OpenDoc, savedThenRead } from '../src/vaultview';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('switching documents', () => {
  test('picking the open document reads it after the flush', async () => {
    const stored = new Map([['a', 'typed before']]);
    // The vault list read the bytes before the open document was saved.
    const picked: OpenDoc = { id: 'a', name: 'a.docx', bytes: bytes(stored.get('a')!) };
    const save = async (): Promise<boolean> => {
      stored.set('a', 'typed before and after');
      return true;
    };
    const doc = await savedThenRead(picked, save, async (id) => bytes(stored.get(id)!));
    expect(doc?.name).toBe('a.docx');
    expect(text(doc!.bytes)).toBe('typed before and after');
  });

  test('a new document keeps its bytes; a refused save opens nothing', async () => {
    const blank: OpenDoc = { id: null, name: 'Document.docx', bytes: bytes('blank') };
    const read = (): Promise<Uint8Array> => Promise.reject(new Error('not stored'));
    expect(text((await savedThenRead(blank, async () => true, read))!.bytes)).toBe('blank');
    expect(await savedThenRead(blank, async () => false, read)).toBeNull();
  });
});
