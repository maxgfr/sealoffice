// SPDX-License-Identifier: AGPL-3.0-only
// Typed view of the seal-crypto wasm module (crates/seal-crypto).

/** The vault key. Its secret stays inside wasm; call `free()` when done. */
export interface SealIdentity {
  recipient(): string;
  wrap(passphrase: string): Uint8Array;
  encrypt(plain: Uint8Array): Uint8Array;
  decrypt(ct: Uint8Array): Uint8Array;
  free(): void;
}

export interface SealCrypto {
  Identity: {
    generate(): SealIdentity;
    unlock(wrapped: Uint8Array, passphrase: string): SealIdentity;
    from_secret_key(key: string): SealIdentity;
  };
  encrypt_to(recipient: string, plain: Uint8Array): Uint8Array;
  encrypt_passphrase(plain: Uint8Array, passphrase: string): Uint8Array;
  decrypt_passphrase(ct: Uint8Array, passphrase: string): Uint8Array;
  is_age(bytes: Uint8Array): boolean;
  office_is_encrypted(bytes: Uint8Array): boolean;
  office_decrypt(bytes: Uint8Array, password: string): Uint8Array;
  office_protect(pkg: Uint8Array, password: string): Uint8Array;
  sha256_hex(bytes: Uint8Array): string;
}

interface SealModule extends SealCrypto {
  default(init: { module_or_path: URL }): Promise<unknown>;
}

/** Loads the wasm served next to the page at `./pkg/seal/`. */
export async function loadCrypto(): Promise<SealCrypto> {
  const base = new URL('./pkg/seal/', location.href);
  const mod: SealModule = await import(new URL('seal_crypto.js', base).href);
  await mod.default({ module_or_path: new URL('seal_crypto_bg.wasm', base) });
  return mod;
}
