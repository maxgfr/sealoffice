// SPDX-License-Identifier: AGPL-3.0-only
// Protection by default. The live site shares its origin (maxgfr.github.io)
// with other sites, and OPFS belongs to the origin: an unprotected library's
// key, kept in the clear there, can be read by any page of that origin. So a
// new library is protected unless the user explicitly opts out, and an
// unprotected one says so on the home screen until it is protected.
import type { Vault } from './vault';

export const MIN_PASSPHRASE = 10;

/** How a new library starts: protected, or unprotected only once the risk was acknowledged. */
export type NewLibrary =
  | { protect: true; passphrase: string }
  | { protect: false; acknowledged: boolean };

/** Creates the library `choice` asks for; resolves to the recovery key of a protected one, else null. */
export async function createLibrary(vault: Vault, choice: NewLibrary): Promise<string | null> {
  if (choice.protect) {
    if (choice.passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`);
    return vault.create(choice.passphrase);
  }
  if (!choice.acknowledged) throw new Error('an unprotected library needs the risk acknowledged');
  await vault.createUnprotected();
  return null;
}

/** sessionStorage: the "not protected" banner was dismissed in this tab. */
export const BANNER_DISMISSED = 'sealoffice-protect-banner-dismissed';

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function session(): SessionStore | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Whether the home screen shows the "not protected" banner. */
export function showProtectBanner(isProtected: boolean, store: SessionStore | null = session()): boolean {
  if (isProtected) return false;
  try {
    return store?.getItem(BANNER_DISMISSED) !== '1';
  } catch {
    return true;
  }
}

/** Hides the banner until this tab is closed; it comes back in the next session. */
export function dismissProtectBanner(store: SessionStore | null = session()): void {
  try {
    store?.setItem(BANNER_DISMISSED, '1');
  } catch {
    // Storage blocked: dismissed for this page only (the caller hides it).
  }
}

/** Where the risk comes from, in the words of the page's own address. */
export function sharedOriginRisk(host: string): string {
  return `Its key is stored in the clear in this browser, where any page served from ${host} can read it, ` +
    'including other sites published at that address, and anyone using this browser profile.';
}
