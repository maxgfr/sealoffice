// SPDX-License-Identifier: AGPL-3.0-only
// Saves the editor's document to the vault without waiting for ⌘S: every
// AUTOSAVE_MS while modified, and on demand (flush) before the tab hides,
// locks, exports or hands over to another tab.

/** The editor exports autosave drives (see editor.ts). */
export interface AutosaveEditor {
  is_dirty(): boolean;
  /** Starts the ⌘S path; false when nothing is savable. The save itself lands later in ibisOfficeSaveFile. */
  save_now(): boolean;
}

/** How a save handed to the vault ended: the name stored, null when cancelled, or the error. */
export type SaveOutcome = { name: string | null } | { error: unknown };

/** Fires once `ibisOfficeSaveFile` has finished writing to the vault (bridge.ts). */
export class SaveSignal {
  private readonly listeners = new Set<(outcome: SaveOutcome) => void>();

  subscribe(listener: (outcome: SaveOutcome) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(outcome: SaveOutcome): void {
    for (const listener of [...this.listeners]) listener(outcome);
  }
}

export type FlushResult = 'saved' | 'clean' | 'unsavable' | 'timeout';

export interface Timers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
}

const browserTimers: Timers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (id) => window.clearInterval(id),
};

export const AUTOSAVE_MS = 30_000;
export const FLUSH_TIMEOUT_MS = 10_000;

export class Autosaver {
  private pending: Promise<FlushResult> | null = null;
  private interval: number | null = null;

  constructor(
    private readonly editor: AutosaveEditor,
    private readonly saved: SaveSignal,
    private readonly timers: Timers = browserTimers,
  ) {}

  get dirty(): boolean {
    return this.editor.is_dirty();
  }

  /** Saves if modified and waits for the vault write; concurrent calls share one save. */
  flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<FlushResult> {
    if (!this.pending) {
      this.pending = this.save(timeoutMs).finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** Flushes every `intervalMs` while modified; `onError` gets failed saves. */
  start(onError: (error: unknown) => void, intervalMs = AUTOSAVE_MS): void {
    this.stop();
    this.interval = this.timers.setInterval(() => {
      if (this.pending || !this.editor.is_dirty()) return;
      this.flush().then((result) => {
        if (result === 'timeout') onError(new Error('the automatic save did not finish'));
      }, onError);
    }, intervalMs);
  }

  stop(): void {
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    this.interval = null;
  }

  private save(timeoutMs: number): Promise<FlushResult> {
    if (!this.editor.is_dirty()) return Promise.resolve('clean');
    return new Promise<FlushResult>((resolve, reject) => {
      let timer = 0;
      const unsubscribe = this.saved.subscribe((outcome) => {
        finish();
        if ('error' in outcome) {
          reject(outcome.error);
        } else {
          resolve(outcome.name === null ? 'unsavable' : 'saved');
        }
      });
      const finish = (): void => {
        unsubscribe();
        this.timers.clearTimeout(timer);
      };
      // Subscribed first: the editor may call back before save_now returns.
      let started: boolean;
      try {
        started = this.editor.save_now();
      } catch (error) {
        finish();
        reject(error);
        return;
      }
      if (!started) {
        finish();
        resolve('unsavable');
        return;
      }
      // A save the editor refuses (shown in its status bar) never reaches the vault.
      timer = this.timers.setTimeout(() => {
        finish();
        resolve('timeout');
      }, timeoutMs);
    });
  }
}
