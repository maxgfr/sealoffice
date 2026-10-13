// SPDX-License-Identifier: AGPL-3.0-only
// Whole-vault backups: a tar of the current version of every document plus a
// manifest, age-encrypted with a passphrase. Readable without sealoffice:
//   age -d sealoffice-backup-YYYY-MM-DD.tar.age | tar x
// A locked document stays locked: its file is the age ciphertext for its own
// key, and the manifest carries that key wrapped by the document passphrase.
import type { SealCrypto } from './crypto';
import type { NamedBytes } from './importer';
import { readTar, writeTar, type TarFile } from './tar';
import type { DocEntry, DocMeta } from './vault';

const ROOT = 'sealoffice-backup';
const MANIFEST = `${ROOT}/manifest.json`;
const MANIFEST_VERSION = 2;

/** A document as stored in a backup. */
export interface BackupDoc {
  name: string;
  folder?: string;
  officePassword?: string;
  created: number;
  modified: number;
  /** The plaintext, or for a locked document its ciphertext. */
  bytes: Uint8Array;
  /** A locked document: its key wrapped by the document passphrase, and its plaintext size. */
  lock?: { wrapped: string; size: number };
}

/** The vault operations a backup needs. */
export interface BackupVault {
  list(): DocEntry[];
  read(id: string): Promise<Uint8Array>;
  uniqueName(name: string): string;
  write(name: string, bytes: Uint8Array, id?: string, meta?: DocMeta): Promise<DocEntry>;
  exportLocked(id: string): Promise<{ wrapped: string; ciphertext: Uint8Array }>;
  importLocked(name: string, ciphertext: Uint8Array, wrapped: string, size: number, meta?: DocMeta): Promise<DocEntry>;
}

interface ManifestDoc {
  file: string;
  name: string;
  folder?: string;
  officePassword?: string;
  created: number;
  modified: number;
  lock?: { wrapped: string; size: number };
}

export function backupFileName(date = new Date()): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `sealoffice-backup-${day}.tar.age`;
}

/** Every document's current version, encrypted with `passphrase`. */
export async function createBackup(vault: BackupVault, passphrase: string, seal: SealCrypto, date = new Date()): Promise<NamedBytes> {
  if (passphrase.length === 0) throw new Error('empty passphrase');
  const docs: ManifestDoc[] = [];
  const files: TarFile[] = [];
  for (const [n, entry] of vault.list().entries()) {
    const file = `${ROOT}/files/${n + 1}-${entry.name}`;
    const locked = entry.lock ? await vault.exportLocked(entry.id) : null;
    const content = locked ? locked.ciphertext : await vault.read(entry.id);
    files.push({ name: file, bytes: content, modified: entry.modified });
    docs.push({
      file,
      name: entry.name,
      ...(entry.folder === undefined ? {} : { folder: entry.folder }),
      ...(entry.officePassword === undefined ? {} : { officePassword: entry.officePassword }),
      created: entry.created,
      modified: entry.modified,
      ...(locked ? { lock: { wrapped: locked.wrapped, size: entry.size } } : {}),
    });
  }
  const manifest = { version: MANIFEST_VERSION, created: date.getTime(), docs };
  const tar = writeTar([{ name: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)), modified: date.getTime() }, ...files]);
  return { name: backupFileName(date), bytes: seal.encrypt_passphrase(tar, passphrase) };
}

/** Decrypts and checks a backup; throws on a wrong passphrase or a damaged file. */
export function openBackup(bytes: Uint8Array, passphrase: string, seal: SealCrypto): BackupDoc[] {
  if (!seal.is_age(bytes)) throw new Error('this is not a sealoffice backup (.tar.age)');
  const files = new Map(readTar(seal.decrypt_passphrase(bytes, passphrase)).map((f) => [f.name, f.bytes]));
  const manifest = files.get(MANIFEST);
  if (!manifest) throw new Error('this archive is not a sealoffice backup (no manifest)');
  const data: unknown = JSON.parse(new TextDecoder().decode(manifest));
  if (typeof data !== 'object' || data === null) throw new Error('the backup manifest is damaged');
  const m = data as Record<string, unknown>;
  if (typeof m.version !== 'number' || m.version > MANIFEST_VERSION) throw new Error('this backup was made by a newer sealoffice');
  if (!Array.isArray(m.docs)) throw new Error('the backup manifest is damaged');
  return m.docs.map((raw: unknown): BackupDoc => {
    if (typeof raw !== 'object' || raw === null) throw new Error('the backup manifest is damaged');
    const d = raw as Record<string, unknown>;
    if (typeof d.file !== 'string' || typeof d.name !== 'string' || typeof d.created !== 'number' || typeof d.modified !== 'number') {
      throw new Error('the backup manifest is damaged');
    }
    const lock = d.lock;
    if (lock !== undefined && !isManifestLock(lock)) throw new Error('the backup manifest is damaged');
    const fileBytes = files.get(d.file);
    if (!fileBytes) throw new Error(`the backup is missing "${d.name}"`);
    return {
      name: d.name,
      ...(typeof d.folder === 'string' ? { folder: d.folder } : {}),
      ...(typeof d.officePassword === 'string' ? { officePassword: d.officePassword } : {}),
      created: d.created,
      modified: d.modified,
      bytes: fileBytes,
      ...(lock === undefined ? {} : { lock: { wrapped: lock.wrapped, size: lock.size } }),
    };
  });
}

function isManifestLock(lock: unknown): lock is { wrapped: string; size: number } {
  if (typeof lock !== 'object' || lock === null) return false;
  const l = lock as Record<string, unknown>;
  return typeof l.wrapped === 'string' && typeof l.size === 'number';
}

/** The vault operations restoring into a new vault needs. */
export interface NewVault extends BackupVault {
  create(passphrase: string): Promise<void>;
  wipe(): Promise<void>;
}

/**
 * Creates `vault` with `passphrase` from a backup. The backup is decrypted and
 * checked first, and a failure after creation wipes the new vault again, so
 * nothing is left behind that would block another try.
 */
export async function restoreIntoNewVault(
  vault: NewVault,
  backup: Uint8Array,
  backupPassphrase: string,
  passphrase: string,
  seal: SealCrypto,
): Promise<DocEntry[]> {
  const docs = openBackup(backup, backupPassphrase, seal);
  await vault.create(passphrase);
  try {
    return await restoreBackup(vault, docs);
  } catch (error) {
    await vault.wipe();
    throw error;
  }
}

/** Adds every backed-up document to `vault`, renaming those whose name is taken. */
export async function restoreBackup(vault: BackupVault, docs: BackupDoc[]): Promise<DocEntry[]> {
  const restored: DocEntry[] = [];
  for (const doc of docs) {
    const meta: DocMeta = {
      ...(doc.folder === undefined ? {} : { folder: doc.folder }),
      ...(doc.officePassword === undefined ? {} : { officePassword: doc.officePassword }),
    };
    const name = vault.uniqueName(doc.name);
    restored.push(
      doc.lock
        ? await vault.importLocked(name, doc.bytes, doc.lock.wrapped, doc.lock.size, meta)
        : await vault.write(name, doc.bytes, undefined, meta),
    );
  }
  return restored;
}
