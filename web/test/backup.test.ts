// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { backupFileName, createBackup, openBackup, restoreBackup, restoreIntoNewVault } from '../src/backup';
import { MemoryStore } from '../src/store';
import { readTar } from '../src/tar';
import { Vault } from '../src/vault';
import { crypto } from './seal';

// bun ignores bunfig's [test] timeout, and the default is reset per file: scrypt needs the intended 120 s.
setDefaultTimeout(120_000);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

async function vaultWith(): Promise<Vault> {
  const vault = new Vault(new MemoryStore(), crypto);
  await vault.create('vault passphrase');
  const a = await vault.write('a.docx', bytes('old a'), undefined, { folder: 'Work', officePassword: 'office' });
  await vault.write('a.docx', bytes('current a'), a.id);
  await vault.write('Été.xlsx', bytes('b'));
  return vault;
}

describe('backup', () => {
  test('file name', () => {
    expect(backupFileName(new Date(2026, 0, 5))).toBe('sealoffice-backup-2026-01-05.tar.age');
  });

  test('holds the current versions and a manifest; restores into an empty vault', async () => {
    const source = await vaultWith();
    const backup = await createBackup(source, 'backup pw', crypto, new Date(2026, 9, 13));
    expect(backup.name).toBe('sealoffice-backup-2026-10-13.tar.age');
    expect(crypto.is_age(backup.bytes)).toBe(true);
    // Plain age + tar: what `age -d | tar x` sees.
    // Numbered in vault order; documents written in the same millisecond may come either way.
    const names = readTar(crypto.decrypt_passphrase(backup.bytes, 'backup pw')).map((f) => f.name);
    expect(names[0]).toBe('sealoffice-backup/manifest.json');
    expect(names.slice(1).map((n) => n.replace(/files\/[12]-/, 'files/N-')).sort())
      .toEqual(['sealoffice-backup/files/N-a.docx', 'sealoffice-backup/files/N-Été.xlsx'].sort());
    expect(names.slice(1).map((n) => n.match(/files\/(\d)-/)?.[1]).sort()).toEqual(['1', '2']);
    expect(() => openBackup(backup.bytes, 'wrong', crypto)).toThrow('wrong passphrase');

    const docs = openBackup(backup.bytes, 'backup pw', crypto);
    const target = new Vault(new MemoryStore(), crypto);
    await target.create('another passphrase');
    await restoreBackup(target, docs);
    const restored = target.list().sort((x, y) => x.name.localeCompare(y.name));
    expect(restored.map((e) => e.name)).toEqual(['a.docx', 'Été.xlsx']);
    const a = restored[0];
    if (!a) throw new Error('not restored');
    expect(text(await target.read(a.id))).toBe('current a');
    expect(a.folder).toBe('Work');
    expect(a.officePassword).toBe('office');
    expect(a.versions).toEqual([]);
  }, 30_000);

  test('merging renames clashing documents', async () => {
    const vault = await vaultWith();
    const docs = openBackup((await createBackup(vault, 'pw', crypto)).bytes, 'pw', crypto);
    await restoreBackup(vault, docs);
    expect(vault.list().map((e) => e.name).sort()).toEqual(['a (2).docx', 'a.docx', 'Été (2).xlsx', 'Été.xlsx'].sort());
  }, 30_000);

  test('restoring into a new vault leaves nothing behind on failure', async () => {
    const backup = (await createBackup(await vaultWith(), 'backup pw', crypto)).bytes;
    const store = new MemoryStore();
    const vault = new Vault(store, crypto);
    await expect(restoreIntoNewVault(vault, backup, 'wrong', 'new vault pass', crypto)).rejects.toThrow('wrong passphrase');
    expect(await vault.exists()).toBe(false);
    const damaged = backup.slice(0, backup.length - 40);
    await expect(restoreIntoNewVault(vault, damaged, 'backup pw', 'new vault pass', crypto)).rejects.toThrow();
    expect(await vault.exists()).toBe(false);

    // A storage failure while writing the documents wipes the new vault.
    class FailingDocs extends MemoryStore {
      override async put(key: string, value: Uint8Array): Promise<void> {
        if (key.startsWith('docs/')) throw new Error('quota exceeded');
        await super.put(key, value);
      }
    }
    const failing = new FailingDocs();
    const other = new Vault(failing, crypto);
    await expect(restoreIntoNewVault(other, backup, 'backup pw', 'new vault pass', crypto)).rejects.toThrow('quota exceeded');
    expect(await other.exists()).toBe(false);
    expect(failing.blobs.size).toBe(0);

    // Retrying with the right passphrase then works.
    await restoreIntoNewVault(vault, backup, 'backup pw', 'new vault pass', crypto);
    expect(vault.list()).toHaveLength(2);
    expect(store.blobs.size).toBeGreaterThan(0);
  }, 60_000);

  test('refuses other files', async () => {
    expect(() => openBackup(bytes('PK not age'), 'pw', crypto)).toThrow('not a sealoffice backup');
    const notBackup = crypto.encrypt_passphrase(bytes('x'.repeat(1024)), 'pw');
    expect(() => openBackup(notBackup, 'pw', crypto)).toThrow();
  });
});
