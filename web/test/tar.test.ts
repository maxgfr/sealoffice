// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTar, writeTar } from '../src/tar';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const LONG = `dir/${'n'.repeat(150)}.docx`;
const UNICODE = 'sealoffice-backup/files/2-Résumé été 文書.docx';

describe('tar', () => {
  test('round trip, including long and unicode names and empty files', () => {
    const files = [
      { name: 'a.txt', bytes: bytes('hello'), modified: 1_700_000_000_000 },
      { name: LONG, bytes: new Uint8Array(1500).fill(7), modified: 1_700_000_001_000 },
      { name: UNICODE, bytes: bytes('é'), modified: 1_700_000_002_000 },
      { name: 'empty', bytes: new Uint8Array(0), modified: 1_700_000_003_000 },
    ];
    const tar = writeTar(files);
    expect(tar.length % 512).toBe(0);
    expect(readTar(tar)).toEqual(files);
  });

  test('the system tar extracts it with the right names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sealoffice-tar-'));
    const archive = join(dir, 'x.tar');
    writeFileSync(archive, writeTar([{ name: LONG, bytes: bytes('long') }, { name: UNICODE, bytes: bytes('uni') }]));
    const result = Bun.spawnSync(['tar', '-xf', archive, '-C', dir]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, LONG), 'utf8')).toBe('long');
    expect(readFileSync(join(dir, UNICODE), 'utf8')).toBe('uni');
  });

  test('reads an archive made by the system tar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sealoffice-tar-'));
    writeFileSync(join(dir, 'Été.txt'), 'summer');
    // COPYFILE_DISABLE: no macOS "._" metadata entries.
    const result = Bun.spawnSync(['tar', '--format', 'pax', '-cf', '-', '-C', dir, 'Été.txt'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(result.exitCode).toBe(0);
    const files = readTar(new Uint8Array(result.stdout));
    expect(files.map((f) => f.name)).toEqual(['Été.txt']);
    expect(new TextDecoder().decode(files[0]?.bytes)).toBe('summer');
  });

  test('a damaged header is refused', () => {
    const tar = writeTar([{ name: 'a.txt', bytes: bytes('hello') }]);
    tar[10] = (tar[10] ?? 0) ^ 1;
    expect(() => readTar(tar)).toThrow('bad tar header');
  });
});
