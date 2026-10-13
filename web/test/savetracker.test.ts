// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { SaveTracker, type SavePrompts } from '../src/savetracker';
import { MemoryStore } from '../src/store';
import { Vault } from '../src/vault';
import { crypto } from './seal';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

async function setup(prompts: Partial<SavePrompts> = {}): Promise<{ vault: Vault; tracker: SaveTracker }> {
  const vault = new Vault(new MemoryStore(), crypto);
  await vault.create('correct horse battery');
  const tracker = new SaveTracker(vault, {
    askName: prompts.askName ?? (async (name) => name),
    confirmReplace: prompts.confirmReplace ?? (async () => false),
  });
  return { vault, tracker };
}

describe('save tracker', () => {
  test('a second new file named like a saved one does not overwrite it', async () => {
    const { vault, tracker } = await setup();
    const first = await tracker.save('Document1.docx', bytes('first'), false);
    expect(first).not.toBeNull();
    const firstId = tracker.currentId;
    if (!firstId) throw new Error('first save not tracked');
    // File > New again: the editor names it Document1.docx once more.
    const second = await tracker.save('Document1.docx', bytes('second'), false);
    expect(vault.list()).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(text(await vault.read(firstId))).toBe('first');
  });

  test('saving the current document again updates it in place', async () => {
    const { vault, tracker } = await setup();
    const name = await tracker.save('Document1.docx', bytes('one'), false);
    if (!name) throw new Error('not saved');
    const id = tracker.currentId;
    expect(await tracker.save(name, bytes('two'), false)).toBe(name);
    expect(vault.list()).toHaveLength(1);
    expect(tracker.currentId).toBe(id);
    if (!id) throw new Error('not tracked');
    expect(text(await vault.read(id))).toBe('two');
  });

  test('a file whose name matches a stored document that was not opened gets a new entry', async () => {
    const { vault, tracker } = await setup();
    const stored = await vault.write('report.docx', bytes('stored'));
    tracker.opened({ id: null, name: 'report.docx' });
    expect(await tracker.save('report.docx', bytes('imported'), false)).toBe('report (2).docx');
    expect(text(await vault.read(stored.id))).toBe('stored');
  });

  test('an opened vault document is updated by its own save', async () => {
    const { vault, tracker } = await setup();
    const stored = await vault.write('report.docx', bytes('v1'));
    tracker.opened({ id: stored.id, name: stored.name });
    expect(await tracker.save('report.docx', bytes('v2'), false)).toBe('report.docx');
    expect(vault.list()).toHaveLength(1);
    expect(text(await vault.read(stored.id))).toBe('v2');
  });

  test('save as onto an existing name needs confirmation', async () => {
    let asked = 0;
    const { vault, tracker } = await setup({ askName: async () => 'other.docx', confirmReplace: async () => { asked++; return false; } });
    const other = await vault.write('other.docx', bytes('keep'));
    expect(await tracker.save('mine.docx', bytes('new'), true)).toBeNull();
    expect(asked).toBe(1);
    expect(text(await vault.read(other.id))).toBe('keep');
  });

  test('save as to a fresh name creates a new entry', async () => {
    const { vault, tracker } = await setup({ askName: async () => 'copy.docx' });
    const stored = await vault.write('report.docx', bytes('v1'));
    tracker.opened({ id: stored.id, name: stored.name });
    expect(await tracker.save('report.docx', bytes('v2'), true)).toBe('copy.docx');
    expect(vault.list()).toHaveLength(2);
    expect(text(await vault.read(stored.id))).toBe('v1');
  });
});
