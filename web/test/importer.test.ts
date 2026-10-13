// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { exportDocument } from '../src/exporter';
import { detect, importFile, isDocumentName, type AskSecret } from '../src/importer';
import { crypto } from './seal';

const docx = await Bun.file(
  new URL('../../vendor/ibis-office/test/benchmark/securities-registration-statement.docx', import.meta.url),
).bytes();

const answer = (secret: string | null): AskSecret => async () => secret;
const never: AskSecret = async () => {
  throw new Error('should not ask');
};

describe('importer', () => {
  test('detects age, Office-encrypted and plain packages', () => {
    expect(detect(docx, crypto)).toBe('zip');
    expect(detect(crypto.encrypt_passphrase(docx, 'pw'), crypto)).toBe('age');
    expect(detect(crypto.office_protect(docx, 'pw'), crypto)).toBe('office-encrypted');
    expect(detect(new TextEncoder().encode('hello'), crypto)).toBe('unknown');
  });

  test('plain documents pass through', async () => {
    const result = await importFile({ name: 'a.docx', bytes: docx }, crypto, never);
    expect(result?.name).toBe('a.docx');
    expect(result?.bytes).toEqual(docx);
  });

  test('Office-encrypted files ask for the password', async () => {
    const file = { name: 'p.docx', bytes: crypto.office_protect(docx, 'office pw') };
    expect((await importFile(file, crypto, answer('office pw')))?.bytes).toEqual(docx);
    await expect(importFile(file, crypto, answer('nope'))).rejects.toThrow('wrong password');
    expect(await importFile(file, crypto, answer(null))).toBeNull();
  });

  test('age files: passphrase or secret key, name without .age', async () => {
    const byPassphrase = await importFile({ name: 'r.docx.age', bytes: crypto.encrypt_passphrase(docx, 'age pw') }, crypto, answer('age pw'));
    expect(byPassphrase?.name).toBe('r.docx');
    expect(byPassphrase?.bytes).toEqual(docx);

    const identity = crypto.Identity.generate();
    const wrapped = identity.wrap('k');
    const key = new TextDecoder().decode(crypto.decrypt_passphrase(wrapped, 'k'));
    const ct = crypto.encrypt_to(identity.recipient(), docx);
    identity.free();
    const byKey = await importFile({ name: 's.docx.age', bytes: ct }, crypto, answer(key));
    expect(byKey?.bytes).toEqual(docx);

    await expect(importFile({ name: 'r.docx.age', bytes: crypto.encrypt_passphrase(docx, 'age pw') }, crypto, answer('bad')))
      .rejects.toThrow('wrong passphrase');
  });

  test('age export of an Office-protected file needs both secrets', async () => {
    const office = exportDocument({ name: 'x.docx', bytes: docx }, 'office', 'inner', crypto);
    const sealed = exportDocument(office, 'age', 'outer', crypto);
    expect(sealed.name).toBe('x.docx.age');
    const asks: string[] = [];
    const ask: AskSecret = async ({ kind }) => {
      asks.push(kind);
      return kind === 'age-passphrase' ? 'outer' : 'inner';
    };
    expect((await importFile(sealed, crypto, ask))?.bytes).toEqual(docx);
    expect(asks).toEqual(['age-passphrase', 'office-password']);
  });

  test('rejects unsupported names', async () => {
    expect(isDocumentName('a.DOCX')).toBe(true);
    expect(isDocumentName('a.pdf')).toBe(false);
    await expect(importFile({ name: 'a.pdf', bytes: docx }, crypto, never)).rejects.toThrow('not a supported document');
  });
});
