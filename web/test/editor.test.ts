// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'bun:test';
import { editorSaveHandler } from '../src/editor';

test('a save keeps the bytes the editor handed over, even once its memory has moved', async () => {
  // The editor passes a view on its wasm memory; while the page saves
  // asynchronously, that memory can grow (its buffer is then detached) or be reused.
  const memory = new ArrayBuffer(64);
  const view = new Uint8Array(memory, 8, 4);
  view.set([0x50, 0x4b, 0x03, 0x04]);
  const kept: number[][] = [];
  const handler = editorSaveHandler(async (_name, bytes) => {
    await Promise.resolve();
    kept.push([...bytes]);
    await Promise.resolve();
    kept.push([...bytes]);
    return 'a.docx';
  });
  const saving = handler('a.docx', view, false);
  structuredClone(memory, { transfer: [memory] });
  expect(view.length).toBe(0);
  expect(await saving).toBe('a.docx');
  expect(kept).toEqual([[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x03, 0x04]]);
});
