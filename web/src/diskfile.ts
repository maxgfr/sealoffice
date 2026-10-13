// SPDX-License-Identifier: AGPL-3.0-only
// Vault documents linked to a .age file on disk (File System Access API:
// Chrome and Edge). Every vault save of a linked document rewrites the file,
// encrypted to the vault key, so `age -d -i sealoffice-recovery-key.txt`
// opens it. File handles are kept in IndexedDB; they are not secret.

/** The part of a FileSystemFileHandle a link uses. */
export interface DiskHandle {
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void> }>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Where handles are kept: document id → handle. */
export interface HandleStore {
  get(id: string): Promise<DiskHandle | undefined>;
  put(id: string, handle: DiskHandle): Promise<void>;
  delete(id: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** The vault operations a link needs. */
export interface LinkVault {
  recipient(): string;
  decryptForVault(ct: Uint8Array): Uint8Array;
}

export interface LinkCrypto {
  encrypt_to(recipient: string, plain: Uint8Array): Uint8Array;
}

interface PickerWindow {
  showOpenFilePicker?(options: object): Promise<DiskHandle[]>;
  showSaveFilePicker?(options: object): Promise<DiskHandle>;
}

const AGE_TYPES = [{ description: 'age encrypted file', accept: { 'application/octet-stream': ['.age'] } }];

/** Whether this browser can link files on disk. */
export function diskLinksSupported(): boolean {
  return typeof (globalThis as PickerWindow).showOpenFilePicker === 'function';
}

export class DiskLinks {
  private linked = new Set<string>();

  constructor(
    private readonly handles: HandleStore,
    private readonly vault: LinkVault,
    private readonly seal: LinkCrypto,
  ) {}

  /** Loads which documents are linked; call once before `isLinked`. */
  async load(): Promise<void> {
    this.linked = new Set(await this.handles.keys());
  }

  isLinked(id: string): boolean {
    return this.linked.has(id);
  }

  /** Links `id` to `handle` and writes `bytes` there right away. */
  async link(id: string, handle: DiskHandle, bytes: Uint8Array): Promise<void> {
    await this.handles.put(id, handle);
    this.linked.add(id);
    await this.write(id, bytes);
  }

  async unlink(id: string): Promise<void> {
    await this.handles.delete(id);
    this.linked.delete(id);
  }

  /** Rewrites the linked file of `id` with `bytes`; does nothing when `id` is not linked. */
  async write(id: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.handles.get(id);
    if (!handle) return;
    await ensureWritable(handle);
    const ct = this.seal.encrypt_to(this.vault.recipient(), bytes);
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(ct));
    await writable.close();
  }

  /** The age bytes of a disk file. */
  async read(handle: DiskHandle): Promise<Uint8Array> {
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  /** Decrypts a disk file with the vault key; null when it was encrypted for something else. */
  tryVaultKey(ct: Uint8Array): Uint8Array | null {
    try {
      return this.vault.decryptForVault(ct);
    } catch (error) {
      // Not for this vault's key: the caller asks for a passphrase instead.
      console.info('not encrypted to the vault key:', error);
      return null;
    }
  }
}

/** Asks again for write access when the browser dropped it (after a reload, for one). */
async function ensureWritable(handle: DiskHandle): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error(`no permission to write "${handle.name}"`);
  }
}

export async function pickAgeFile(): Promise<DiskHandle | null> {
  const picker = (globalThis as PickerWindow).showOpenFilePicker;
  if (!picker) throw new Error('this browser cannot link files on disk');
  try {
    const [handle] = await picker({ types: AGE_TYPES, multiple: false });
    return handle ?? null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export async function pickSaveTarget(suggestedName: string): Promise<DiskHandle | null> {
  const picker = (globalThis as PickerWindow).showSaveFilePicker;
  if (!picker) throw new Error('this browser cannot link files on disk');
  try {
    return await picker({ suggestedName, types: AGE_TYPES });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** Handles in IndexedDB database `sealoffice-links`. */
export class IdbHandleStore implements HandleStore {
  private db: Promise<IDBDatabase> | null = null;

  async get(id: string): Promise<DiskHandle | undefined> {
    const value: unknown = await this.request('readonly', (s) => s.get(id));
    return value === undefined ? undefined : (value as DiskHandle);
  }

  async put(id: string, handle: DiskHandle): Promise<void> {
    await this.request('readwrite', (s) => s.put(handle, id));
  }

  async delete(id: string): Promise<void> {
    await this.request('readwrite', (s) => s.delete(id));
  }

  async keys(): Promise<string[]> {
    const keys = await this.request('readonly', (s) => s.getAllKeys());
    return keys.map(String);
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('sealoffice-links', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('links');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('cannot open the link store'));
    });
    return this.db;
  }

  private async request<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = make(db.transaction('links', mode).objectStore('links'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('link store request failed'));
    });
  }
}
