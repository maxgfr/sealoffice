// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { openShare, parseShare, randomKey, shareFile, shareFragment } from '../src/share';
import { crypto } from './seal';

// bun ignores bunfig's [test] timeout, and the default is reset per file: scrypt needs the intended 120 s.
setDefaultTimeout(120_000);

const doc = { name: 'Été report.docx', bytes: new TextEncoder().encode('hello '.repeat(2000)) };

describe('share links', () => {
  test('round trip with the key in the link, compressed', async () => {
    const key = randomKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fragment = await shareFragment(doc, key, false, crypto);
    expect(fragment.startsWith('#s=v1.')).toBe(true);
    expect(fragment).not.toContain('hello');
    expect(fragment.length).toBeLessThan(doc.bytes.length);
    const link = parseShare(fragment);
    if (link?.kind !== 'doc') throw new Error('not a document link');
    expect(link.name).toBe(doc.name);
    expect(link.key).toBe(key);
    expect(await openShare(link, key, crypto)).toEqual(doc);
  });

  test('separate key: the link alone does not open', async () => {
    const fragment = await shareFragment(doc, 'told on the phone', true, crypto);
    const link = parseShare(fragment);
    if (link?.kind !== 'doc') throw new Error('not a document link');
    expect(link.key).toBeNull();
    await expect(openShare(link, 'a wrong guess', crypto)).rejects.toThrow('wrong passphrase');
    expect((await openShare(link, 'told on the phone', crypto)).bytes).toEqual(doc.bytes);
  });

  test('large documents: an age file plus a key link', () => {
    const key = randomKey();
    const { file, fragment } = shareFile(doc, key, crypto);
    expect(file.name).toBe('Été report.docx.age');
    expect(crypto.decrypt_passphrase(file.bytes, key)).toEqual(doc.bytes);
    expect(parseShare(fragment)).toEqual({ kind: 'key', name: doc.name, key });
  });

  test('other fragments are not share links; damaged ones are refused', () => {
    expect(parseShare('')).toBeNull();
    expect(parseShare('#r=abc&k=def')).toBeNull();
    expect(() => parseShare('#s=v9.abc.def')).toThrow('newer sealoffice');
    expect(() => parseShare('#s=v1.YQ')).toThrow('damaged');
    expect(() => parseShare('#s=v1.YS9i.ZGF0YQ')).toThrow('damaged');
  });
});
