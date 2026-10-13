// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { type AutosaveEditor, Autosaver, SaveSignal, type Timers } from '../src/autosave';

/** Timers driven by `advance`. */
class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private readonly tasks = new Map<number, { at: number; every: number | null; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.next++;
    this.tasks.set(id, { at: this.now + ms, every: null, callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  setInterval(callback: () => void, ms: number): number {
    const id = this.next++;
    this.tasks.set(id, { at: this.now + ms, every: ms, callback });
    return id;
  }

  clearInterval(id: number): void {
    this.tasks.delete(id);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.every === null) {
        this.tasks.delete(id);
      } else {
        task.at += task.every;
      }
      task.callback();
    }
    this.now = end;
  }
}

/** An editor whose ⌘S path ends in the save signal, like the wasm one via the bridge. */
class FakeEditor implements AutosaveEditor {
  dirty = false;
  savable = true;
  saves = 0;
  /** What the bridge reports for the next save; 'none' means the editor never calls it. */
  reply: { name: string | null } | { error: unknown } | 'none' = { name: 'a.docx' };

  constructor(private readonly signal: SaveSignal) {}

  is_dirty(): boolean {
    return this.dirty;
  }

  save_now(): boolean {
    if (!this.dirty || !this.savable) return false;
    this.saves++;
    const reply = this.reply;
    if (reply === 'none') return true;
    // The JS save handler runs after save_now returns.
    queueMicrotask(() => {
      if ('name' in reply && reply.name !== null) this.dirty = false;
      this.signal.emit(reply);
    });
    return true;
  }
}

function setup(): { editor: FakeEditor; timers: FakeTimers; autosaver: Autosaver } {
  const signal = new SaveSignal();
  const editor = new FakeEditor(signal);
  const timers = new FakeTimers();
  return { editor, timers, autosaver: new Autosaver(editor, signal, timers) };
}

describe('autosave', () => {
  test('flush on a clean document does nothing', async () => {
    const { editor, autosaver } = setup();
    expect(await autosaver.flush()).toBe('clean');
    expect(editor.saves).toBe(0);
  });

  test('flush saves a modified document and waits for the vault', async () => {
    const { editor, autosaver } = setup();
    editor.dirty = true;
    expect(await autosaver.flush()).toBe('saved');
    expect(editor.saves).toBe(1);
    expect(autosaver.dirty).toBe(false);
  });

  test('flush reports a document that cannot be saved', async () => {
    const { editor, autosaver } = setup();
    editor.dirty = true;
    editor.savable = false;
    expect(await autosaver.flush()).toBe('unsavable');
    editor.savable = true;
    editor.reply = { name: null };
    expect(await autosaver.flush()).toBe('unsavable');
  });

  test('flush times out when the save never arrives', async () => {
    const { editor, timers, autosaver } = setup();
    editor.dirty = true;
    editor.reply = 'none';
    const result = autosaver.flush(10_000);
    timers.advance(9_999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    timers.advance(1);
    expect(await result).toBe('timeout');
  });

  test('a failed vault write rejects the flush', async () => {
    const { editor, autosaver } = setup();
    editor.dirty = true;
    editor.reply = { error: new Error('quota exceeded') };
    await expect(autosaver.flush()).rejects.toThrow('quota exceeded');
  });

  test('concurrent flushes share one save', async () => {
    const { editor, autosaver } = setup();
    editor.dirty = true;
    const [a, b] = await Promise.all([autosaver.flush(), autosaver.flush()]);
    expect([a, b]).toEqual(['saved', 'saved']);
    expect(editor.saves).toBe(1);
  });

  test('saves every 30 seconds only while modified', async () => {
    const { editor, timers, autosaver } = setup();
    const errors: unknown[] = [];
    autosaver.start((error) => errors.push(error));
    timers.advance(30_000);
    expect(editor.saves).toBe(0);
    editor.dirty = true;
    timers.advance(29_999);
    expect(editor.saves).toBe(0);
    timers.advance(1);
    expect(editor.saves).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.dirty).toBe(false);
    timers.advance(30_000);
    expect(editor.saves).toBe(1);
    autosaver.stop();
    editor.dirty = true;
    timers.advance(60_000);
    expect(editor.saves).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a failing periodic save is reported', async () => {
    const { editor, timers, autosaver } = setup();
    const errors: unknown[] = [];
    autosaver.start((error) => errors.push(error));
    editor.dirty = true;
    editor.reply = { error: new Error('disk full') };
    timers.advance(30_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(errors.map((e) => (e instanceof Error ? e.message : e))).toEqual(['disk full']);
  });
});
