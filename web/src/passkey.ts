// SPDX-License-Identifier: AGPL-3.0-only
// Passkey unlock through the WebAuthn PRF extension. The passkey's PRF output
// for a stored salt is the passphrase of a second copy of the vault key
// (vault.ts: identity.passkey.age); nothing secret is kept in the clear.
import { base64url, fromBase64url, type PasskeyInfo, type Vault } from './vault';

const SALT_BYTES = 32;

/** Whether this browser says it can evaluate PRF; when unsure, no passkey button is shown. */
export async function prfSupported(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !('getClientCapabilities' in PublicKeyCredential)) return false;
  const capabilities = await PublicKeyCredential.getClientCapabilities();
  return capabilities['extension:prf'] === true;
}

/** Creates a passkey for this vault and lets it unlock the vault. */
export async function registerPasskey(vault: Vault): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'sealoffice' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'sealoffice vault', displayName: 'sealoffice vault' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('no passkey was created');
  const results = credential.getClientExtensionResults().prf;
  if (!results?.enabled) throw new Error('this passkey cannot unlock the vault: it does not support the PRF extension');
  const info: PasskeyInfo = { credentialId: base64url(new Uint8Array(credential.rawId)), salt: base64url(salt) };
  // Some authenticators evaluate PRF at creation; the others need one sign-in.
  const prf = results.results?.first ? prfBytes(results.results.first) : await evaluatePrf(info);
  await vault.addPasskey(prf, info);
}

/** Unlocks `vault` with its registered passkey. */
export async function unlockWithPasskey(vault: Vault): Promise<void> {
  const info = await vault.passkey();
  if (!info) throw new Error('no passkey for this vault');
  await vault.unlockWithPrf(await evaluatePrf(info));
}

async function evaluatePrf(info: PasskeyInfo): Promise<Uint8Array> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromBase64url(info.credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: fromBase64url(info.salt) } } },
    },
  });
  if (!(assertion instanceof PublicKeyCredential)) throw new Error('the passkey did not answer');
  const first = assertion.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error('the passkey did not return a PRF output');
  return prfBytes(first);
}

function prfBytes(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
}
