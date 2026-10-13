// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MemoryStore } from '../src/store';
import { MAX_VERSIONS, parseRecoveryKey, recoveryKeyFile, Vault, VaultLockedError } from '../src/vault';
import { crypto } from './seal';

// bun ignores bunfig's [test] timeout, and the default is reset per file: scrypt needs the intended 120 s.
setDefaultTimeout(120_000);

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

  test('a replace keeps the old blob as a version and unlock sweeps only orphans', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'));
    const b = await vault.write('a.docx', bytes('two'), a.id);
    expect(b.blob).not.toBe(a.blob);
    expect(store.blobs.has(a.blob)).toBe(true);
    expect(b.versions.map((v) => v.blob)).toEqual([a.blob]);
    const orphan = `docs/${a.id}.deadbeef.age`;
    store.blobs.set(orphan, bytes('stale'));
    vault.lock();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(store.blobs.has(orphan)).toBe(false);
    expect(store.blobs.has(b.blob)).toBe(true);
    expect(store.blobs.has(a.blob)).toBe(true);
    expect(text(await reopened.read(a.id))).toBe('two');
    expect(text(await reopened.readVersion(a.id, 0))).toBe('one');
  });

  test('history keeps the last ten versions, newest first', async () => {
    const { store, vault } = await fresh();
    const first = await vault.write('a.docx', bytes('v0'));
    const blobs = [first.blob];
    for (let n = 1; n <= MAX_VERSIONS + 2; n++) {
      blobs.push((await vault.write('a.docx', bytes(`v${n}`), first.id)).blob);
    }
    const versions = vault.versions(first.id);
    expect(MAX_VERSIONS).toBe(10);
    expect(versions).toHaveLength(10);
    expect(text(await vault.readVersion(first.id, 0))).toBe(`v${MAX_VERSIONS + 1}`);
    expect(text(await vault.readVersion(first.id, 9))).toBe('v2');
    expect(text(await vault.read(first.id))).toBe(`v${MAX_VERSIONS + 2}`);
    // The two oldest blobs are gone from storage, the rest are all kept.
    expect(store.blobs.has(blobs[0] ?? '')).toBe(false);
    expect(store.blobs.has(blobs[1] ?? '')).toBe(false);
    for (const blob of blobs.slice(2)) expect(store.blobs.has(blob)).toBe(true);
    await expect(vault.readVersion(first.id, 10)).rejects.toThrow('no such version');
  });

  test('readVersion checks integrity', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('x'.repeat(300)));
    await vault.write('a.docx', bytes('newer'), a.id);
    const blob = store.blobs.get(a.blob);
    if (!blob) throw new Error('blob not stored');
    blob[blob.length - 10] = (blob[blob.length - 10] ?? 0) ^ 1;
    await expect(vault.readVersion(a.id, 0)).rejects.toThrow('version 1 of "a.docx" failed its integrity check');
  });

  test('restoreVersion makes a new current version', async () => {
    const { vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'));
    await vault.write('a.docx', bytes('two'), a.id);
    const restored = await vault.restoreVersion(a.id, 0);
    expect(restored.id).toBe(a.id);
    expect(text(await vault.read(a.id))).toBe('one');
    expect(restored.versions).toHaveLength(2);
    expect(text(await vault.readVersion(a.id, 0))).toBe('two');
    expect(text(await vault.readVersion(a.id, 1))).toBe('one');
  });

  test('a version picked by its blob survives a newer write', async () => {
    const { vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'));
    await vault.write('a.docx', bytes('two'), a.id);
    const picked = vault.versions(a.id)[0]!.blob;
    // A flush or an autosave lands between the listing and the restore.
    await vault.write('a.docx', bytes('three'), a.id);
    expect(text(await vault.readVersion(a.id, picked))).toBe('one');
    const restored = await vault.restoreVersion(a.id, picked);
    expect(text(await vault.read(restored.id))).toBe('one');
    expect(text(await vault.readVersion(a.id, 0))).toBe('three');
  });

  test('a version evicted from the history is refused by blob', async () => {
    const { vault } = await fresh();
    const a = await vault.write('a.docx', bytes('v0'));
    await vault.write('a.docx', bytes('v1'), a.id);
    const oldest = vault.versions(a.id)[0]!.blob;
    for (let n = 2; n <= MAX_VERSIONS + 1; n++) await vault.write('a.docx', bytes(`v${n}`), a.id);
    await expect(vault.readVersion(a.id, oldest)).rejects.toThrow('no such version');
    await expect(vault.restoreVersion(a.id, oldest)).rejects.toThrow('no such version');
    expect(text(await vault.read(a.id))).toBe(`v${MAX_VERSIONS + 1}`);
  });

  test('remove deletes every version blob', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'));
    const b = await vault.write('a.docx', bytes('two'), a.id);
    await vault.remove(a.id);
    expect(store.blobs.has(a.blob)).toBe(false);
    expect(store.blobs.has(b.blob)).toBe(false);
  });

  test('folders and office password survive writes and reloads', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('one'), undefined, { officePassword: 'secret' });
    const b = await vault.write('b.docx', bytes('two'));
    await vault.setFolder(a.id, ' Work ');
    await vault.setFolder(b.id, 'Archive');
    expect(vault.folders()).toEqual(['Archive', 'Work']);
    await vault.write('a.docx', bytes('one, edited'), a.id);
    expect(vault.entry(a.id)?.folder).toBe('Work');
    expect(vault.entry(a.id)?.officePassword).toBe('secret');
    await vault.setFolder(b.id, null);
    expect(vault.entry(b.id)?.folder).toBeUndefined();
    expect(vault.folders()).toEqual(['Work']);
    await expect(vault.setFolder(a.id, 'a/b')).rejects.toThrow('folder names cannot contain');
    vault.lock();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(reopened.entry(a.id)?.folder).toBe('Work');
    expect(reopened.entry(a.id)?.officePassword).toBe('secret');
    expect(reopened.folders()).toEqual(['Work']);
  });

  test('a version 1 index is migrated to version 2 on unlock', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('old.docx', bytes('from v0.1'));
    vault.lock();
    const wrapped = await store.get('identity.age');
    if (!wrapped) throw new Error('no identity');
    const identity = crypto.Identity.unlock(wrapped, PASS);
    const v1 = { version: 1, docs: [{ id: a.id, name: a.name, size: a.size, created: a.created, modified: a.modified, sha256: a.sha256, blob: a.blob }] };
    await store.put('index.age', identity.encrypt(bytes(JSON.stringify(v1))));
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(reopened.list()).toEqual([{ ...a, versions: [] }]);
    expect(text(await reopened.read(a.id))).toBe('from v0.1');
    const index = await store.get('index.age');
    if (!index) throw new Error('no index');
    const saved = JSON.parse(text(identity.decrypt(index))) as { version: number; docs: { versions: unknown[] }[] };
    identity.free();
    expect(saved.version).toBe(2);
    expect(saved.docs[0]?.versions).toEqual([]);
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

  test('recovery key resets the passphrase', async () => {
    const { store, vault } = await fresh();
    const a = await vault.write('a.docx', bytes('rescued'));
    await expect(vault.recoveryKey('wrong passphrase!')).rejects.toThrow();
    const key = await vault.recoveryKey(PASS);
    expect(key).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    vault.lock();
    const file = recoveryKeyFile(key, new Date(0));
    expect(file.startsWith('# ')).toBe(true);
    expect(parseRecoveryKey(file)).toBe(key);
    const reopened = new Vault(store, crypto);
    await reopened.resetWithRecoveryKey(file, 'brand new passphrase');
    expect(reopened.unlocked).toBe(true);
    expect(text(await reopened.read(a.id))).toBe('rescued');
    reopened.lock();
    const again = new Vault(store, crypto);
    await expect(again.unlock(PASS)).rejects.toThrow('wrong passphrase');
    await again.unlock('brand new passphrase');
    expect(text(await again.read(a.id))).toBe('rescued');
  });

  test('a foreign or malformed recovery key changes nothing', async () => {
    const { store, vault } = await fresh();
    vault.lock();
    const before = store.blobs.get('identity.age');
    const other = crypto.Identity.generate();
    const foreignKey = text(crypto.decrypt_passphrase(other.wrap('x'), 'x'));
    other.free();
    const target = new Vault(store, crypto);
    await expect(target.resetWithRecoveryKey(foreignKey, 'new passphrase!')).rejects.toThrow('does not open this vault');
    await expect(target.resetWithRecoveryKey('hello', 'new passphrase!')).rejects.toThrow('not a recovery key');
    expect(target.unlocked).toBe(false);
    expect(store.blobs.get('identity.age')).toBe(before);
    await target.unlock(PASS);
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
