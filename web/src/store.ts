// SPDX-License-Identifier: AGPL-3.0-only
// Byte storage keyed by slash-separated paths ("docs/<id>.age").

export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key, in no particular order. */
  list(): Promise<string[]>;
}

export class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    const bytes = this.blobs.get(key);
    return bytes ? bytes.slice() : null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, bytes.slice());
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async list(): Promise<string[]> {
    return [...this.blobs.keys()];
  }
}

/** Origin Private File System storage under one root directory. */
export class OpfsStore implements BlobStore {
  constructor(private readonly rootName = 'sealoffice') {}

  private async root(): Promise<FileSystemDirectoryHandle> {
    const origin = await navigator.storage.getDirectory();
    return origin.getDirectoryHandle(this.rootName, { create: true });
  }

  private async parent(key: string, create: boolean): Promise<[FileSystemDirectoryHandle, string] | null> {
    const parts = key.split('/');
    const name = parts.pop();
    if (!name || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`invalid storage key: ${key}`);
    }
    let dir = await this.root();
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (error) {
        if (!create && isNotFound(error)) return null;
        throw error;
      }
    }
    return [dir, name];
  }

  async get(key: string): Promise<Uint8Array | null> {
    const found = await this.parent(key, false);
    if (!found) return null;
    const [dir, name] = found;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const found = await this.parent(key, true);
    if (!found) throw new Error(`cannot create ${key}`);
    const [dir, name] = found;
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    try {
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const found = await this.parent(key, false);
    if (!found) return;
    const [dir, name] = found;
    try {
      await dir.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        } else {
          keys.push(prefix + name);
        }
      }
    };
    await walk(await this.root(), '');
    return keys;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
