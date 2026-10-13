// SPDX-License-Identifier: AGPL-3.0-only
// The encrypted document vault. Only age ciphertext ever reaches the store:
//   identity.age     the vault key, age scrypt-encrypted with the passphrase
//   index.age        JSON list of DocEntry, encrypted to the vault key
//   docs/<id>.<n>.age  each document version, encrypted to the vault key; a
//                      write stores a new blob, then the index, then drops the old blob
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
}

const IDENTITY_KEY = 'identity.age';
const INDEX_KEY = 'index.age';
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
    return this.serial(async () => {
      const wrapped = await this.store.get(IDENTITY_KEY);
      if (!wrapped) throw new Error('no vault here');
      const identity = this.seal.Identity.unlock(wrapped, passphrase);
      try {
        this.entries = await this.loadIndex(identity);
      } catch (error) {
        identity.free();
        throw error;
      }
      this.replaceIdentity(identity);
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

  /** Documents, most recently modified first. */
  list(): DocEntry[] {
    this.requireIdentity();
    return this.entries.map((e) => ({ ...e })).sort((a, b) => b.modified - a.modified);
  }

  entry(id: string): DocEntry | undefined {
    const found = this.entries.find((e) => e.id === id);
    return found && { ...found };
  }

  read(id: string): Promise<Uint8Array> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const entry = this.findEntry(id);
      const blob = await this.store.get(entry.blob);
      if (!blob) throw new Error(`"${entry.name}" is missing from storage`);
      if (this.seal.sha256_hex(blob) !== entry.sha256) {
        throw new Error(`"${entry.name}" failed its integrity check`);
      }
      return identity.decrypt(blob);
    });
  }

  /** Stores `bytes` as a new document, or replaces document `id`. */
  write(name: string, bytes: Uint8Array, id?: string): Promise<DocEntry> {
    return this.serial(async () => {
      const identity = this.requireIdentity();
      const cleanName = checkName(name);
      const existing = id === undefined ? undefined : this.findEntry(id);
      const ct = identity.encrypt(bytes);
      const now = Date.now();
      const entry: DocEntry = {
        id: existing?.id ?? newId(),
        name: cleanName,
        size: bytes.length,
        created: existing?.created ?? now,
        modified: now,
        sha256: this.seal.sha256_hex(ct),
        blob: '',
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
      if (existing) await this.dropBlob(existing.blob);
      return { ...entry };
    });
  }

  rename(id: string, name: string): Promise<DocEntry> {
    return this.serial(async () => {
      this.requireIdentity();
      const entry = { ...this.findEntry(id), name: checkName(name), modified: Date.now() };
      this.entries = this.entries.map((e) => (e.id === id ? entry : e));
      await this.saveIndex();
      return { ...entry };
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.requireIdentity();
      const entry = this.findEntry(id);
      this.entries = this.entries.filter((e) => e.id !== id);
      await this.saveIndex();
      await this.dropBlob(entry.blob);
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
    const live = new Set(this.entries.map((e) => e.blob));
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
    const blob = await this.store.get(INDEX_KEY);
    if (!blob) return [];
    const json = new TextDecoder().decode(identity.decrypt(blob));
    return parseIndex(json);
  }

  private async saveIndex(): Promise<void> {
    const identity = this.requireIdentity();
    const json = JSON.stringify({ version: 1, docs: this.entries });
    await this.store.put(INDEX_KEY, identity.encrypt(new TextEncoder().encode(json)));
  }
}

function parseIndex(json: string): DocEntry[] {
  const data: unknown = JSON.parse(json);
  if (typeof data !== 'object' || data === null || !('docs' in data) || !Array.isArray(data.docs)) {
    throw new Error('the vault index is damaged');
  }
  return data.docs.map((raw: unknown): DocEntry => {
    if (!isDocEntry(raw)) throw new Error('the vault index is damaged');
    return { id: raw.id, name: raw.name, size: raw.size, created: raw.created, modified: raw.modified, sha256: raw.sha256, blob: raw.blob };
  });
}

function isDocEntry(raw: unknown): raw is DocEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' && /^[0-9a-f-]{36}$/.test(r.id) &&
    typeof r.name === 'string' &&
    typeof r.size === 'number' &&
    typeof r.created === 'number' &&
    typeof r.modified === 'number' &&
    typeof r.sha256 === 'string' &&
    typeof r.blob === 'string' && r.blob.startsWith(`${DOCS_PREFIX}${r.id}.`) && r.blob.endsWith('.age')
  );
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
