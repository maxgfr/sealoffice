// SPDX-License-Identifier: AGPL-3.0-only
// The encrypted document vault. Only age ciphertext ever reaches the store:
//   identity.age     the vault key, age scrypt-encrypted with the passphrase
//   index.age        JSON list of DocEntry, encrypted to the vault key
//   passkey.json     optional, plaintext: the passkey's credential id and PRF salt
//   identity.passkey.age  optional: the vault key, age scrypt-encrypted with the
//                      passkey's PRF output (base64url) as passphrase
//   docs/<id>.<n>.age  each document version, encrypted to the vault key; a
//                      write stores a new blob, then the index; the old blob
//                      becomes a version, and the oldest past MAX_VERSIONS is dropped
import type { SealCrypto, SealIdentity } from './crypto';
import type { BlobStore } from './store';

export interface DocEntry {
  id: string;
  name: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Milliseconds since the epoch. */
  created: number;
  modified: number;
  /** SHA-256 of the stored ciphertext, checked before every read. */
  sha256: string;
  /** Store key of the current ciphertext. */
  blob: string;
  /** One-level folder name; absent at the top level. */
  folder?: string;
  /** Password of the Office file this was imported from, offered again on export. */
  officePassword?: string;
  /** Earlier versions, newest first, at most MAX_VERSIONS. */
  versions: VersionEntry[];
}

/** A previous version of a document, kept by copy-on-write. */
export interface VersionEntry {
  blob: string;
  sha256: string;
  size: number;
  /** When this version was written. */
  modified: number;
}

/** Fields `write` keeps or sets besides the bytes. */
export interface DocMeta {
  folder?: string;
  officePassword?: string;
}

export const MAX_VERSIONS = 10;
const INDEX_VERSION = 2;

const IDENTITY_KEY = 'identity.age';
const INDEX_KEY = 'index.age';
const PASSKEY_INFO_KEY = 'passkey.json';
const PASSKEY_IDENTITY_KEY = 'identity.passkey.age';

/** What the browser needs to ask the passkey for its PRF output; not secret. */
export interface PasskeyInfo {
  /** base64url credential id. */
  credentialId: string;
  /** base64url PRF salt (`eval.first`). */
  salt: string;
}
const DOCS_PREFIX = 'docs/';
const docKey = (id: string): string => `${DOCS_PREFIX}${id}.${randomHex()}.age`;

export class VaultLockedError extends Error {
  constructor() {
    super('the vault is locked');
  }
}

export class Vault {
  private identity: SealIdentity | null = null;
  private entries: DocEntry[] = [];
  /** Whether the index just loaded was an older format, to rewrite as the current one. */
  private migrated = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: BlobStore,
    private readonly seal: SealCrypto,
  ) {}

  get unlocked(): boolean {
    return this.identity !== null;
  }

  async exists(): Promise<boolean> {
    return (await this.store.get(IDENTITY_KEY)) !== null;
  }

  create(passphrase: string): Promise<void> {
    return this.serial(async () => {
      if (await this.exists()) throw new Error('a vault already exists');
      if (passphrase.length === 0) throw new Error('empty passphrase');
      const identity = this.seal.Identity.generate();
      try {
        await this.store.put(IDENTITY_KEY, identity.wrap(passphrase));
        this.replaceIdentity(identity);
        this.entries = [];
        await this.saveIndex();
      } catch (error) {
        this.lock();
        throw error;
      }
    });
  }

  unlock(passphrase: string): Promise<void> {
    return this.unlockFrom(IDENTITY_KEY, passphrase);
  }

  /** Unlocks with the 32-byte PRF output of the vault's passkey. */
  unlockWithPrf(prf: Uint8Array): Promise<void> {
    return this.unlockFrom(PASSKEY_IDENTITY_KEY, prfPassphrase(prf));
  }

  /** The registered passkey, or null. */
  async passkey(): Promise<PasskeyInfo | null> {
    const raw = await this.store.get(PASSKEY_INFO_KEY);
    return raw && parsePasskeyInfo(new TextDecoder().decode(raw));
  }

  /** Lets the passkey whose PRF output for `info.salt` is `prf` unlock the vault. */
  addPasskey(prf: Uint8Array, info: PasskeyInfo): Promise<void> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const wrapped = identity.wrap(prfPassphrase(prf));
      await this.store.put(PASSKEY_IDENTITY_KEY, wrapped);
      await this.store.put(PASSKEY_INFO_KEY, new TextEncoder().encode(JSON.stringify(info)));
    });
  }

  removePasskey(): Promise<void> {
    return this.serial(async () => {
      this.requireIdentity();
      await this.store.delete(PASSKEY_INFO_KEY);
      await this.store.delete(PASSKEY_IDENTITY_KEY);
    });
  }

  private unlockFrom(key: string, passphrase: string): Promise<void> {
    return this.serial(async () => {
      const wrapped = await this.store.get(key);
      if (!wrapped) throw new Error(key === IDENTITY_KEY ? 'no vault here' : 'no passkey for this vault');
      const identity = this.seal.Identity.unlock(wrapped, passphrase);
      try {
        this.entries = await this.loadIndex(identity);
      } catch (error) {
        identity.free();
        throw error;
      }
      this.replaceIdentity(identity);
      if (this.migrated) await this.saveIndex();
      await this.sweepOrphans();
    });
  }

  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      if (newPassphrase.length === 0) throw new Error('empty passphrase');
      const wrapped = await this.store.get(IDENTITY_KEY);
      if (!wrapped) throw new Error('no vault here');
      this.seal.Identity.unlock(wrapped, oldPassphrase).free();
      await this.store.put(IDENTITY_KEY, identity.wrap(newPassphrase));
    });
  }

  /** The vault key as an `AGE-SECRET-KEY-1…` string, after checking `passphrase`. */
  recoveryKey(passphrase: string): Promise<string> {
    return this.serial(async () => {
      const wrapped = await this.store.get(IDENTITY_KEY);
      if (!wrapped) throw new Error('no vault here');
      return new TextDecoder().decode(this.seal.decrypt_passphrase(wrapped, passphrase)).trim();
    });
  }

  /**
   * Opens the vault with its recovery key (or the text of the key file) and
   * protects the key with `newPassphrase`. The key must decrypt the index.
   */
  resetWithRecoveryKey(key: string, newPassphrase: string): Promise<void> {
    return this.serial(async () => {
      if (newPassphrase.length === 0) throw new Error('empty passphrase');
      if (!(await this.exists())) throw new Error('no vault here');
      const secret = parseRecoveryKey(key);
      if (!secret) throw new Error('this is not a recovery key (it starts with AGE-SECRET-KEY-1)');
      const identity = this.seal.Identity.from_secret_key(secret);
      try {
        if (!(await this.store.get(INDEX_KEY))) throw new Error('the vault index is missing');
        this.entries = await this.loadIndex(identity).catch((error: unknown) => {
          throw new Error(`this recovery key does not open this vault (${error instanceof Error ? error.message : String(error)})`);
        });
        await this.store.put(IDENTITY_KEY, identity.wrap(newPassphrase));
      } catch (error) {
        identity.free();
        this.entries = [];
        throw error;
      }
      this.replaceIdentity(identity);
      if (this.migrated) await this.saveIndex();
      await this.sweepOrphans();
    });
  }

  /** The vault's public `age1…` recipient, for files only this vault (or its recovery key) can open. */
  recipient(): string {
    return this.requireIdentity().recipient();
  }

  /** Decrypts an age file encrypted to the vault key (a linked disk file). */
  decryptForVault(ct: Uint8Array): Uint8Array {
    return this.requireIdentity().decrypt(ct);
  }

  /** Documents, most recently modified first. */
  list(): DocEntry[] {
    this.requireIdentity();
    return this.entries.map(copyEntry).sort((a, b) => b.modified - a.modified);
  }

  entry(id: string): DocEntry | undefined {
    const found = this.entries.find((e) => e.id === id);
    return found && copyEntry(found);
  }

  read(id: string): Promise<Uint8Array> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const entry = this.findEntry(id);
      return this.readBlob(identity, `"${entry.name}"`, entry);
    });
  }

  /**
   * The earlier versions of `id`, newest first. `readVersion` and
   * `restoreVersion` take an index into this list, or a version's `blob`,
   * which stays valid while newer writes shift the indexes.
   */
  versions(id: string): VersionEntry[] {
    this.requireIdentity();
    return this.findEntry(id).versions.map((v) => ({ ...v }));
  }

  /** The bytes of version `ref` (index or blob) of `id`, after the same integrity check as `read`. */
  readVersion(id: string, ref: number | string): Promise<Uint8Array> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const entry = this.findEntry(id);
      const i = findVersion(entry, ref);
      return this.readBlob(identity, `version ${i + 1} of "${entry.name}"`, entry.versions[i]!);
    });
  }

  /** Makes version `ref` (index or blob) of `id` the current one; the replaced current becomes a version. */
  restoreVersion(id: string, ref: number | string): Promise<DocEntry> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const entry = this.findEntry(id);
      const i = findVersion(entry, ref);
      const bytes = this.readBlob(identity, `version ${i + 1} of "${entry.name}"`, entry.versions[i]!);
      return this.writeNow(identity, entry.name, await bytes, entry);
    });
  }

  /**
   * Stores `bytes` as a new document, or replaces document `id` (keeping the
   * replaced bytes as a version). `meta` fields override the stored ones.
   */
  write(name: string, bytes: Uint8Array, id?: string, meta: DocMeta = {}): Promise<DocEntry> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const existing = id === undefined ? undefined : this.findEntry(id);
      return this.writeNow(identity, name, bytes, existing, meta);
    });
  }

  rename(id: string, name: string): Promise<DocEntry> {
    return this.serial(async () => {
      this.requireIdentity();
      return this.updateEntry(id, { name: checkName(name), modified: Date.now() });
    });
  }

  /** Moves `id` into `folder`; null or an empty name moves it to the top level. */
  setFolder(id: string, folder: string | null): Promise<DocEntry> {
    return this.serial(async () => {
      this.requireIdentity();
      const clean = folder === null ? '' : checkFolder(folder);
      return this.updateEntry(id, { folder: clean === '' ? undefined : clean });
    });
  }

  /** Folder names in use, sorted. */
  folders(): string[] {
    this.requireIdentity();
    const names = new Set(this.entries.flatMap((e) => (e.folder === undefined ? [] : [e.folder])));
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.requireIdentity();
      const entry = this.findEntry(id);
      this.entries = this.entries.filter((e) => e.id !== id);
      await this.saveIndex();
      for (const key of [entry.blob, ...entry.versions.map((v) => v.blob)]) await this.dropBlob(key);
    });
  }

  /** Deletes the key, the index and every document. */
  wipe(): Promise<void> {
    return this.serial(async () => {
      this.lock();
      for (const key of await this.store.list()) {
        await this.store.delete(key);
      }
    });
  }

  /** Waits for pending vault work, then frees the key. */
  close(): Promise<void> {
    return this.serial(async () => {
      this.lock();
    });
  }

  lock(): void {
    this.identity?.free();
    this.identity = null;
    this.entries = [];
  }

  /** A name not yet used in the vault, made from `name` ("a.docx" → "a (2).docx"). */
  uniqueName(name: string, exceptId?: string): string {
    const taken = new Set(this.entries.filter((e) => e.id !== exceptId).map((e) => e.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private async readBlob(identity: SealIdentity, label: string, ref: { blob: string; sha256: string }): Promise<Uint8Array> {
    const blob = await this.store.get(ref.blob);
    if (!blob) throw new Error(`${label} is missing from storage`);
    if (this.seal.sha256_hex(blob) !== ref.sha256) {
      throw new Error(`${label} failed its integrity check`);
    }
    return identity.decrypt(blob);
  }

  private async writeNow(
    identity: SealIdentity,
    name: string,
    bytes: Uint8Array,
    existing: DocEntry | undefined,
    meta: DocMeta = {},
  ): Promise<DocEntry> {
    const cleanName = checkName(name);
    const folder = meta.folder === undefined ? existing?.folder : checkFolder(meta.folder) || undefined;
    const officePassword = meta.officePassword ?? existing?.officePassword;
    const ct = identity.encrypt(bytes);
    const now = Date.now();
    const kept = existing
      ? [{ blob: existing.blob, sha256: existing.sha256, size: existing.size, modified: existing.modified }, ...existing.versions]
      : [];
    const entry: DocEntry = {
      id: existing?.id ?? newId(),
      name: cleanName,
      size: bytes.length,
      created: existing?.created ?? now,
      modified: now,
      sha256: this.seal.sha256_hex(ct),
      blob: '',
      ...(folder === undefined ? {} : { folder }),
      ...(officePassword === undefined ? {} : { officePassword }),
      versions: kept.slice(0, MAX_VERSIONS),
    };
    entry.blob = docKey(entry.id);
    // Copy-on-write: the old blob stays valid until the index no longer names it.
    await this.store.put(entry.blob, ct);
    const previous = this.entries;
    this.entries = [...previous.filter((e) => e.id !== entry.id), entry];
    try {
      await this.saveIndex();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    for (const dropped of kept.slice(MAX_VERSIONS)) await this.dropBlob(dropped.blob);
    return copyEntry(entry);
  }

  /** Replaces fields of `id` other than its bytes, and saves the index. */
  private async updateEntry(id: string, changes: Partial<Omit<DocEntry, 'id' | 'blob' | 'sha256' | 'versions'>>): Promise<DocEntry> {
    const updated: DocEntry = { ...this.findEntry(id), ...changes };
    if (updated.folder === undefined) delete updated.folder;
    const previous = this.entries;
    this.entries = previous.map((e) => (e.id === id ? updated : e));
    try {
      await this.saveIndex();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    return copyEntry(updated);
  }

  /** Deletes a blob the index no longer names; a failure leaves an orphan the next unlock sweeps. */
  private async dropBlob(key: string): Promise<void> {
    try {
      await this.store.delete(key);
    } catch (error) {
      console.warn(`could not delete ${key}; it will be removed at next unlock:`, error);
    }
  }

  /** Removes document blobs the index does not name (left by interrupted writes). */
  private async sweepOrphans(): Promise<void> {
    const live = new Set(this.entries.flatMap((e) => [e.blob, ...e.versions.map((v) => v.blob)]));
    for (const key of await this.store.list()) {
      if (key.startsWith(DOCS_PREFIX) && !live.has(key)) await this.dropBlob(key);
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private replaceIdentity(identity: SealIdentity): void {
    if (this.identity !== identity) this.identity?.free();
    this.identity = identity;
  }

  private requireIdentity(): SealIdentity {
    if (!this.identity) throw new VaultLockedError();
    return this.identity;
  }

  private findEntry(id: string): DocEntry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error('no such document');
    return entry;
  }

  private async loadIndex(identity: SealIdentity): Promise<DocEntry[]> {
    this.migrated = false;
    const blob = await this.store.get(INDEX_KEY);
    if (!blob) return [];
    const json = new TextDecoder().decode(identity.decrypt(blob));
    const { version, docs } = parseIndex(json);
    this.migrated = version < INDEX_VERSION;
    return docs;
  }

  private async saveIndex(): Promise<void> {
    const identity = this.requireIdentity();
    const json = JSON.stringify({ version: INDEX_VERSION, docs: this.entries });
    await this.store.put(INDEX_KEY, identity.encrypt(new TextEncoder().encode(json)));
  }
}

/** The age passphrase a passkey's PRF output stands for. */
export function prfPassphrase(prf: Uint8Array): string {
  if (prf.length !== 32) throw new Error('the passkey returned an unexpected PRF output');
  return base64url(prf);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function parsePasskeyInfo(json: string): PasskeyInfo {
  const data: unknown = JSON.parse(json);
  if (typeof data !== 'object' || data === null) throw new Error('passkey.json is damaged');
  const r = data as Record<string, unknown>;
  if (typeof r.credentialId !== 'string' || typeof r.salt !== 'string') throw new Error('passkey.json is damaged');
  return { credentialId: r.credentialId, salt: r.salt };
}

/** The `AGE-SECRET-KEY-1…` line in `text` (a bare key or an age identity file), or null. */
export function parseRecoveryKey(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^AGE-SECRET-KEY-1[0-9A-Z]+$/i.test(trimmed)) return trimmed.toUpperCase();
  }
  return null;
}

/** The recovery key as an age identity file, usable with `age -d -i`. */
export function recoveryKeyFile(key: string, created = new Date()): string {
  return `# sealoffice recovery key: it opens your vault without the passphrase. Keep it safe.\n# created: ${created.toISOString()}\n${key}\n`;
}

/** Reads an index of any known version; version 1 entries get no folder and no versions. */
function parseIndex(json: string): { version: number; docs: DocEntry[] } {
  const data: unknown = JSON.parse(json);
  if (typeof data !== 'object' || data === null || !('docs' in data) || !Array.isArray(data.docs)) {
    throw new Error('the vault index is damaged');
  }
  const version = 'version' in data && typeof data.version === 'number' ? data.version : 1;
  if (version > INDEX_VERSION) throw new Error('this vault was written by a newer sealoffice; update the page');
  const docs = data.docs.map((raw: unknown): DocEntry => {
    if (typeof raw !== 'object' || raw === null) throw new Error('the vault index is damaged');
    const r = raw as Record<string, unknown>;
    const id = r.id;
    if (
      typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) ||
      typeof r.name !== 'string' ||
      typeof r.size !== 'number' ||
      typeof r.created !== 'number' ||
      typeof r.modified !== 'number' ||
      typeof r.sha256 !== 'string' ||
      !isDocBlob(r.blob, id) ||
      (r.folder !== undefined && typeof r.folder !== 'string') ||
      (r.officePassword !== undefined && typeof r.officePassword !== 'string')
    ) {
      throw new Error('the vault index is damaged');
    }
    const rawVersions = version >= 2 ? r.versions : [];
    if (!Array.isArray(rawVersions)) throw new Error('the vault index is damaged');
    const versions = rawVersions.map((v: unknown): VersionEntry => {
      if (typeof v !== 'object' || v === null) throw new Error('the vault index is damaged');
      const rv = v as Record<string, unknown>;
      if (!isDocBlob(rv.blob, id) || typeof rv.sha256 !== 'string' || typeof rv.size !== 'number' || typeof rv.modified !== 'number') {
        throw new Error('the vault index is damaged');
      }
      return { blob: rv.blob, sha256: rv.sha256, size: rv.size, modified: rv.modified };
    });
    return {
      id,
      name: r.name,
      size: r.size,
      created: r.created,
      modified: r.modified,
      sha256: r.sha256,
      blob: r.blob,
      ...(typeof r.folder === 'string' ? { folder: r.folder } : {}),
      ...(typeof r.officePassword === 'string' ? { officePassword: r.officePassword } : {}),
      versions,
    };
  });
  return { version, docs };
}

function isDocBlob(blob: unknown, id: string): blob is string {
  return typeof blob === 'string' && blob.startsWith(`${DOCS_PREFIX}${id}.`) && blob.endsWith('.age');
}

function copyEntry(entry: DocEntry): DocEntry {
  return { ...entry, versions: entry.versions.map((v) => ({ ...v })) };
}

/** The index of version `ref` (an index or a blob key) of `entry`; throws when it is gone. */
function findVersion(entry: DocEntry, ref: number | string): number {
  const i = typeof ref === 'number' ? ref : entry.versions.findIndex((v) => v.blob === ref);
  if (!entry.versions[i]) throw new Error('no such version');
  return i;
}

/** A folder name: trimmed, one level, empty for the top level. */
function checkFolder(folder: string): string {
  const trimmed = folder.trim();
  if (/[/\\\0]/.test(trimmed)) throw new Error('folder names cannot contain / or \\');
  return trimmed;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('empty file name');
  if (/[/\\\0]/.test(trimmed)) throw new Error('file names cannot contain / or \\');
  return trimmed;
}

function randomHex(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(): string {
  return crypto.randomUUID();
}
