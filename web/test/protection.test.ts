// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  BANNER_DISMISSED, createLibrary, dismissProtectBanner, MIN_PASSPHRASE, sharedOriginRisk, showProtectBanner,
} from '../src/protection';
import { MemoryStore } from '../src/store';
import { parseRecoveryKey, Vault } from '../src/vault';
import { crypto } from './seal';

setDefaultTimeout(120_000);

const PASS = 'correct horse battery';

function memorySession(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('a new library is protected by default', () => {
  test('the passphrase choice makes a protected library, with a working recovery key', async () => {
    const store = new MemoryStore();
    const vault = new Vault(store, crypto);
    const key = await createLibrary(vault, { protect: true, passphrase: PASS });
    expect(vault.isProtected).toBe(true);
    expect(await vault.state()).toBe('protected');
    // No library key in the clear anywhere in the store.
    expect(await store.get('identity.key')).toBeNull();
    expect(key).toStartWith('AGE-SECRET-KEY-1');
    expect(parseRecoveryKey(key ?? '')).toBe(key);
    await vault.close();
    const reopened = new Vault(store, crypto);
    await reopened.unlock(PASS);
    expect(reopened.unlocked).toBe(true);
  });

  test('a short passphrase is refused, and nothing is created', async () => {
    const vault = new Vault(new MemoryStore(), crypto);
    await expect(createLibrary(vault, { protect: true, passphrase: 'x'.repeat(MIN_PASSPHRASE - 1) })).rejects.toThrow(
      `at least ${MIN_PASSPHRASE}`,
    );
    expect(await vault.state()).toBe('none');
  });

  test('an unprotected library needs the risk acknowledged', async () => {
    const vault = new Vault(new MemoryStore(), crypto);
    await expect(createLibrary(vault, { protect: false, acknowledged: false })).rejects.toThrow('acknowledged');
    expect(await vault.state()).toBe('none');
    expect(await createLibrary(vault, { protect: false, acknowledged: true })).toBeNull();
    expect(await vault.state()).toBe('open');
    expect(vault.isProtected).toBe(false);
  });
});

describe('the "not protected" banner', () => {
  test('shows for an unprotected library, never for a protected one', () => {
    expect(showProtectBanner(false, memorySession())).toBe(true);
    expect(showProtectBanner(true, memorySession())).toBe(false);
  });

  test('dismissing hides it for this session only', () => {
    const tab = memorySession();
    dismissProtectBanner(tab);
    expect(tab.data.get(BANNER_DISMISSED)).toBe('1');
    expect(showProtectBanner(false, tab)).toBe(false);
    // A new session (a new tab, or the browser restarted) shows it again.
    expect(showProtectBanner(false, memorySession())).toBe(true);
  });

  test('still shows when session storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(() => dismissProtectBanner(blocked)).not.toThrow();
    expect(showProtectBanner(false, blocked)).toBe(true);
    expect(showProtectBanner(false, null)).toBe(true);
  });

  test('names the address the key can be read from', () => {
    expect(sharedOriginRisk('maxgfr.github.io')).toContain('any page served from maxgfr.github.io');
  });
});
