// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/store';
import { Vault, VaultLockedError } from '../src/vault';
import { crypto } from './seal';

const PASS = 'correct horse battery';
const AGE_MAGIC = new TextEncoder().encode('age-encryption.org/v1');
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

class FailingIndexStore extends MemoryStore {
  failIndex = false;

  override async put(key: string, value: Uint8Array): Promise<void> {
    if (this.failIndex && key === 'index.age') throw new Error('index put failed');
    await super.put(key, value);
  }
}

async function fresh(): Promise<{ store: MemoryStore; vault: Vault }> {
  const store = new MemoryStore();
  const vault = new Vault(store, crypto);
  await vault.create(PASS);
  return { store, vault };
}

function startsWithMagic(blob: Uint8Array): boolean {
  return AGE_MAGIC.every((b, i) => blob[i] === b);
}

describe('vault', () => {
  test('create, lock, unlock, wrong passphrase', async () => {
    const { store, vault } = await fresh();
    expect(await vault.exists()).toBe(true);
    expect(vault.unlocked).toBe(true);
    await expect(vault.create(PASS)).rejects.toThrow('a vault already exists');
    vault.lock();
    expect(() => vault.list()).toThrow(VaultLockedError);
    const other = new Vault(store, crypto);
    await expect(other.unlock('wrong passphrase!')).rejects.toThrow('wrong passphrase');
    expect(other.unlocked).toBe(false);
    await other.unlock(PASS);
    expect(other.list()).toEqual([]);
  });

  test('write, read, list, rename, remove', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('first'));
    const b = await vault.write('b.xlsx', bytes('second'));
    expect(text(await vault.read(a.id))).toBe('first');
    expect(vault.list().map((e) => e.name).sort()).toEqual(['a.docx', 'b.xlsx']);
    expect(vault.entry(a.id)?.size).toBe(5);

    const updated = await vault.write('a.docx', bytes('first, edited'), a.id);
    expect(updated.id).toBe(a.id);
    expect(updated.created).toBe(a.created);
    expect(text(await vault.read(a.id))).toBe('first, edited');
    expect(vault.list()).toHaveLength(2);

    const renamed = await vault.rename(b.id, 'budget.xlsx');
    expect(renamed.name).toBe('budget.xlsx');
    expect(vault.uniqueName('budget.xlsx')).toBe('budget (2).xlsx');
    expect(vault.uniqueName('budget.xlsx', b.id)).toBe('budget.xlsx');

    await vault.remove(b.id);
    expect(vault.list().map((e) => e.id)).toEqual([a.id]);
    expect(await store.get(b.blob)).toBeNull();
    await expect(vault.read(b.id)).rejects.toThrow('no such document');
  });

  test('index survives a reload', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('notes.docx', bytes('kept'));
    vault.lock();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(reopened.list()).toEqual([a]);
    expect(text(await reopened.read(a.id))).toBe('kept');
  });

  test('change passphrase', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('still here'));
    await expect(vault.changePassphrase('not the passphrase', 'new passphrase 2')).rejects.toThrow('wrong passphrase');
    await vault.changePassphrase(PASS, 'new passphrase 2');
    vault.lock();
    const reopened = new Vault(store, crypto);
    await expect(reopened.unlock(PASS)).rejects.toThrow('wrong passphrase');
    await reopened.unlock('new passphrase 2');
    expect(text(await reopened.read(a.id))).toBe('still here');
  });

  test('a flipped byte is detected before decryption', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('x'.repeat(500)));
    const key = a.blob;
    const blob = store.blobs.get(key);
    if (!blob) throw new Error('blob not stored');
    blob[blob.length - 20] = (blob[blob.length - 20] ?? 0) ^ 1;
    await expect(vault.read(a.id)).rejects.toThrow('failed its integrity check');
  });

  test('swapped blobs are detected', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('alpha'));
    const b = await vault.write('b.docx', bytes('bravo'));
    const blobA = store.blobs.get(a.blob);
    const blobB = store.blobs.get(b.blob);
    if (!blobA || !blobB) throw new Error('blobs not stored');
    store.blobs.set(a.blob, blobB);
    store.blobs.set(b.blob, blobA);
    await expect(vault.read(a.id)).rejects.toThrow('failed its integrity check');
    await expect(vault.read(b.id)).rejects.toThrow('failed its integrity check');
  });

  test('only age ciphertext reaches storage', async () => {
    const { store, vault } = await fresh();
    await vault.write('secret.docx', bytes('top secret plaintext'));
    const keys = [...store.blobs.keys()].sort();
    expect(keys).toHaveLength(3);
    expect(keys).toContain('identity.age');
    expect(keys).toContain('index.age');
    for (const blob of store.blobs.values()) {
      expect(startsWithMagic(blob)).toBe(true);
      expect(text(blob)).not.toContain('top secret plaintext');
      expect(text(blob)).not.toContain('secret.docx');
    }
  });

  test('an interrupted replace keeps the previous version readable', async () => {
    const store = new FailingIndexStore();
    const vault = new Vault(store, crypto);
    await vault.create(PASS);
    const a = await vault.write('a.docx', bytes('version one'));
    store.failIndex = true;
    await expect(vault.write('a.docx', bytes('version two'), a.id)).rejects.toThrow('index put failed');
    store.failIndex = false;
    expect(text(await vault.read(a.id))).toBe('version one');
    vault.lock();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(text(await reopened.read(a.id))).toBe('version one');
  });

  test('a replace drops the old blob and unlock sweeps orphans', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'));
    const b = await vault.write('a.docx', bytes('two'), a.id);
    expect(b.blob).not.toBe(a.blob);
    expect(store.blobs.has(a.blob)).toBe(false);
    const orphan = `docs/${a.id}.deadbeef.age`;
    store.blobs.set(orphan, bytes('stale'));
    vault.lock();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(store.blobs.has(orphan)).toBe(false);
    expect(store.blobs.has(b.blob)).toBe(true);
    expect(text(await reopened.read(a.id))).toBe('two');
  });

  test('close waits for a pending write before locking', async () => {
    const { vault } = await fresh();
    const pending = vault.write('a.docx', bytes('saved'));
    const closed = vault.close();
    const entry = await pending;
    await closed;
    expect(entry.name).toBe('a.docx');
    expect(vault.unlocked).toBe(false);
  });

  test('wipe deletes everything', async () => {
    const { store, vault } = await fresh();
    await vault.write('a.docx', bytes('gone'));
    await vault.wipe();
    expect(store.blobs.size).toBe(0);
    expect(vault.unlocked).toBe(false);
    expect(await vault.exists()).toBe(false);
  });
});
