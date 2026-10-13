// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type DiskHandle, DiskLinks, type HandleStore } from '../src/diskfile';
import { MemoryStore } from '../src/store';
import { Vault } from '../src/vault';
import { crypto } from './seal';

// bun ignores bunfig's [test] timeout, and the default is reset per file: scrypt needs the intended 120 s.
setDefaultTimeout(120_000);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A file on a fake disk, with a permission the test can revoke. */
class FakeHandle implements DiskHandle {
  content = new Uint8Array(0);
  permission: PermissionState = 'granted';
  grantOnRequest = true;
  requests = 0;

  constructor(readonly name: string) {}

  async getFile(): Promise<Blob> {
    return new Blob([new Uint8Array(this.content)]);
  }

  async createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void> }> {
    if (this.permission !== 'granted') throw new Error('NotAllowedError');
    let pending = new Uint8Array(0);
    return {
      write: async (data) => {
        pending = data.slice();
      },
      close: async () => {
        this.content = pending;
      },
    };
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    this.requests++;
    if (this.grantOnRequest) this.permission = 'granted';
    return this.permission;
  }
}

class MemoryHandles implements HandleStore {
  readonly map = new Map<string, DiskHandle>();
  async get(id: string): Promise<DiskHandle | undefined> {
    return this.map.get(id);
  }
  async put(id: string, handle: DiskHandle): Promise<void> {
    this.map.set(id, handle);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

async function setup(): Promise<{ vault: Vault; handles: MemoryHandles; links: DiskLinks }> {
  const vault = new Vault(new MemoryStore(), crypto);
  await vault.create('vault passphrase');
  const handles = new MemoryHandles();
  return { vault, handles, links: new DiskLinks(handles, vault, crypto) };
}

describe('disk links', () => {
  test('a linked file is rewritten encrypted to the vault key, readable with the recovery key', async () => {
    const { vault, links } = await setup();
    const handle = new FakeHandle('a.docx.age');
    await links.link('doc-1', handle, bytes('first'));
    expect(links.isLinked('doc-1')).toBe(true);
    expect(crypto.is_age(handle.content)).toBe(true);
    await links.write('doc-1', bytes('second'));
    const key = await vault.recoveryKey('vault passphrase');
    const identity = crypto.Identity.from_secret_key(key);
    expect(new TextDecoder().decode(identity.decrypt(handle.content))).toBe('second');
    identity.free();
    expect(links.tryVaultKey(await links.read(handle))).toEqual(bytes('second'));
  });

  test('unlinked documents are not written; links survive a reload of the store', async () => {
    const { vault, handles, links } = await setup();
    await links.write('nothing', bytes('x'));
    const handle = new FakeHandle('b.age');
    await links.link('doc-2', handle, bytes('one'));
    const again = new DiskLinks(handles, vault, crypto);
    await again.load();
    expect(again.isLinked('doc-2')).toBe(true);
    await again.unlink('doc-2');
    expect(again.isLinked('doc-2')).toBe(false);
    await again.write('doc-2', bytes('ignored'));
    expect(handles.map.size).toBe(0);
  });

  test('a lost permission is asked again; a refusal is an error', async () => {
    const { links } = await setup();
    const handle = new FakeHandle('c.age');
    await links.link('doc-3', handle, bytes('one'));
    handle.permission = 'prompt';
    await links.write('doc-3', bytes('two'));
    expect(handle.requests).toBe(1);
    handle.permission = 'prompt';
    handle.grantOnRequest = false;
    await expect(links.write('doc-3', bytes('three'))).rejects.toThrow('no permission to write "c.age"');
  });

  test('a file for another key is not opened with the vault key', async () => {
    const { links } = await setup();
    const passphraseFile = crypto.encrypt_passphrase(bytes('elsewhere'), 'pw');
    expect(links.tryVaultKey(passphraseFile)).toBeNull();
  });
});
