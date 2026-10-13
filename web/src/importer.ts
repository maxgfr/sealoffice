// SPDX-License-Identifier: AGPL-3.0-only
// Turns a file from disk (plain, Office-encrypted or age) into plain document bytes.
import type { SealCrypto } from './crypto';

/** Extensions the editor opens. */
export const DOCUMENT_EXTENSIONS = [
  'docx', 'docm', 'dotx', 'dotm',
  'xlsx', 'xlsm', 'xltx', 'xltm', 'csv',
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
] as const;

export const ACCEPT = [...DOCUMENT_EXTENSIONS, 'age'].map((e) => `.${e}`).join(',');

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export type FileKind = 'age' | 'office-encrypted' | 'zip' | 'unknown';

/** What a file holds, judged from its bytes. */
export function detect(bytes: Uint8Array, seal: SealCrypto): FileKind {
  if (seal.is_age(bytes)) return 'age';
  if (seal.office_is_encrypted(bytes)) return 'office-encrypted';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  return 'unknown';
}

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isDocumentName(name: string): boolean {
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(extension(name));
}

/** An imported document; `officePassword` is set when the file was Office-protected. */
export interface ImportedFile extends NamedBytes {
  officePassword?: string;
}

/** Asks the user for a secret; null means cancelled. */
export type AskSecret = (request: { kind: 'office-password' | 'age-passphrase'; fileName: string }) => Promise<string | null>;

const SECRET_KEY_PREFIX = 'AGE-SECRET-KEY-1';

/**
 * Decrypts `file` as needed and checks the editor can open it.
 * Resolves to null when the user cancels a prompt.
 */
export async function importFile(file: NamedBytes, seal: SealCrypto, ask: AskSecret): Promise<ImportedFile | null> {
  let { name, bytes } = file;
  if (detect(bytes, seal) === 'age') {
    const secret = await ask({ kind: 'age-passphrase', fileName: name });
    if (secret === null) return null;
    bytes = decryptAge(bytes, secret, seal);
    if (extension(name) === 'age') name = name.slice(0, -'.age'.length);
  }
  if (!isDocumentName(name)) {
    throw new Error(`"${name}" is not a supported document (${DOCUMENT_EXTENSIONS.map((e) => `.${e}`).join(', ')})`);
  }
  if (detect(bytes, seal) === 'office-encrypted') {
    const password = await ask({ kind: 'office-password', fileName: name });
    if (password === null) return null;
    return { name, bytes: seal.office_decrypt(bytes, password), officePassword: password };
  }
  return { name, bytes };
}

/** `secret` is either a passphrase or an `AGE-SECRET-KEY-1…` identity. */
function decryptAge(bytes: Uint8Array, secret: string, seal: SealCrypto): Uint8Array {
  const trimmed = secret.trim();
  if (!trimmed.toUpperCase().startsWith(SECRET_KEY_PREFIX)) {
    return seal.decrypt_passphrase(bytes, secret);
  }
  const identity = seal.Identity.from_secret_key(trimmed);
  try {
    return identity.decrypt(bytes);
  } finally {
    identity.free();
  }
}
