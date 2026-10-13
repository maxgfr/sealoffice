// SPDX-License-Identifier: AGPL-3.0-only
// Minimal tar (POSIX ustar) reader and writer for regular files. Names that
// are not plain ASCII or do not fit the 100-byte field get a pax extended
// header ("path=…"), which GNU and BSD tar both read.

export interface TarFile {
  name: string;
  bytes: Uint8Array;
  /** Modification time, milliseconds since the epoch. */
  modified?: number;
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function writeTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const mtime = Math.floor((file.modified ?? Date.now()) / 1000);
    const nameBytes = encoder.encode(file.name);
    const plain = /^[\x20-\x7e]*$/.test(file.name) && nameBytes.length <= 100;
    if (!plain) {
      const pax = encoder.encode(paxRecord('path', file.name));
      parts.push(header({ name: 'PaxHeader', size: pax.length, mtime, type: 'x' }), ...padded(pax));
    }
    const shortName = plain ? file.name : asciiFallback(file.name);
    parts.push(header({ name: shortName, size: file.bytes.length, mtime, type: '0' }), ...padded(file.bytes));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}

export function readTar(tar: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  let paxPath: string | null = null;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    if (checksum(block) !== octal(block, 148, 8)) throw new Error('the archive is damaged (bad tar header)');
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error('the archive is truncated');
    const body = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      paxPath = parsePax(decoder.decode(body)).get('path') ?? null;
      continue;
    }
    if (type !== '0' && type !== '\0') {
      paxPath = null;
      continue;
    }
    const prefix = text(block, 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    paxPath = null;
    files.push({ name, bytes: body.slice(), modified: octal(block, 136, 12) * 1000 });
  }
  return files;
}

function header(fields: { name: string; size: number; mtime: number; type: string }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  put(block, 0, 100, fields.name);
  put(block, 100, 8, '0000644\0');
  put(block, 108, 8, '0000000\0');
  put(block, 116, 8, '0000000\0');
  put(block, 124, 12, `${fields.size.toString(8).padStart(11, '0')}\0`);
  put(block, 136, 12, `${fields.mtime.toString(8).padStart(11, '0')}\0`);
  put(block, 148, 8, '        ');
  put(block, 156, 1, fields.type);
  put(block, 257, 6, 'ustar\0');
  put(block, 263, 2, '00');
  put(block, 148, 8, `${checksum(block).toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** "<len> key=value\n", where len counts the whole record, itself included. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

function parsePax(records: string): Map<string, string> {
  const values = new Map<string, string>();
  const bytes = encoder.encode(records);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(decoder.decode(bytes.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0) throw new Error('the archive is damaged (bad pax header)');
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const eq = record.indexOf('=');
    if (eq > 0) values.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return values;
}

/** The name field for a file whose real name is in a pax header. */
function asciiFallback(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return ascii.length <= 100 ? ascii : ascii.slice(ascii.length - 100);
}

function put(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const value = text(block, offset, length).trim();
  return value === '' ? 0 : parseInt(value, 8);
}

/** Sum of the header bytes with the checksum field read as spaces. */
function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum;
}

function padded(bytes: Uint8Array): Uint8Array[] {
  const rest = bytes.length % BLOCK;
  return rest === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - rest)];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
