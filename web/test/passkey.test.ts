// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MemoryStore } from '../src/store';
import { base64url, fromBase64url, prfPassphrase, Vault } from '../src/vault';
import { crypto } from './seal';

// bun ignores bunfig's [test] timeout, and the default is reset per file: scrypt needs the intended 120 s.
setDefaultTimeout(120_000);

const PASS = 'correct horse battery';
const INFO = { credentialId: 'Y3JlZGVudGlhbA', salt: 'c2FsdA' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);
const fakePrf = (seed: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff);

async function withPasskey(): Promise<{ store: MemoryStore; vault: Vault; id: string }> {
  const store = new MemoryStore();
  const vault = new Vault(store, crypto);
  await vault.create(PASS);
  const { id } = await vault.write('a.docx', bytes('via passkey'));
  await vault.addPasskey(fakePrf(1), INFO);
  vault.lock();
  return { store, vault, id };
}

describe('passkey', () => {
  test('base64url round trip and PRF passphrase', () => {
    const raw = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64url(base64url(raw))).toEqual(raw);
    expect(base64url(raw)).not.toMatch(/[+/=]/);
    expect(prfPassphrase(fakePrf(1))).toHaveLength(43);
    expect(() => prfPassphrase(new Uint8Array(16))).toThrow('unexpected PRF output');
  });

  test('the PRF output unlocks; another output does not', async () => {
    const { store, id } = await withPasskey();
    const vault = new Vault(store, crypto);
    expect(await vault.passkey()).toEqual(INFO);
    await expect(vault.unlockWithPrf(fakePrf(2))).rejects.toThrow('wrong passphrase');
    expect(vault.unlocked).toBe(false);
    await vault.unlockWithPrf(fakePrf(1));
    expect(text(await vault.read(id))).toBe('via passkey');
    const wrapped = store.blobs.get('identity.passkey.age');
    if (!wrapped) throw new Error('no passkey copy');
    expect(text(wrapped)).not.toContain('AGE-SECRET-KEY');
  });

  test('changing or resetting the passphrase keeps the passkey working', async () => {
    const { store, id } = await withPasskey();
    const vault = new Vault(store, crypto);
    await vault.unlock(PASS);
    await vault.changePassphrase(PASS, 'second passphrase');
    const key = await vault.recoveryKey('second passphrase');
    vault.lock();
    await vault.resetWithRecoveryKey(key, 'third passphrase');
    vault.lock();
    await vault.unlockWithPrf(fakePrf(1));
    expect(text(await vault.read(id))).toBe('via passkey');
  }, 30_000); // six scrypt runs

  test('removePasskey deletes both files', async () => {
    const { store } = await withPasskey();
    const vault = new Vault(store, crypto);
    await vault.unlockWithPrf(fakePrf(1));
    await vault.removePasskey();
    expect(store.blobs.has('passkey.json')).toBe(false);
    expect(store.blobs.has('identity.passkey.age')).toBe(false);
    expect(await vault.passkey()).toBeNull();
    vault.lock();
    await expect(vault.unlockWithPrf(fakePrf(1))).rejects.toThrow('no passkey for this vault');
  });

  test('addPasskey needs an unlocked vault', async () => {
    const { vault } = await withPasskey();
    await expect(vault.addPasskey(fakePrf(3), INFO)).rejects.toThrow('the vault is locked');
  });
});
