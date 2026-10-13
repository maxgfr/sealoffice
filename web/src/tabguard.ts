// SPDX-License-Identifier: AGPL-3.0-only
// One active tab per vault. The active tab holds a Web Lock for its whole
// life; another tab can ask it, over a BroadcastChannel, to save, lock and
// let go, then takes the lock itself.

export const LOCK_NAME = 'sealoffice-vault';
export const CHANNEL_NAME = 'sealoffice';

/** The part of `navigator.locks` the guard uses. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: Lock | null) => Promise<void>): Promise<void>;
}

/** The part of a BroadcastChannel the guard uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

interface TakeoverMessage {
  type: 'takeover';
}

function isTakeover(data: unknown): data is TakeoverMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'takeover';
}

export class TabGuard {
  private release: (() => void) | null = null;
  private onYield: () => Promise<void> = async () => undefined;

  constructor(
    private readonly locks: LockManagerLike,
    private readonly channel: ChannelLike,
    /** Reports a yield handler failure; the lock is handed over regardless. */
    private readonly report: (error: unknown) => void = (error) => console.error('saving before handing over failed:', error),
  ) {
    channel.onmessage = (event) => {
      if (isTakeover(event.data) && this.release) this.yieldToOther().catch(this.report);
    };
  }

  get active(): boolean {
    return this.release !== null;
  }

  /** Runs before this tab gives the lock away: save, then lock the vault. */
  setYieldHandler(handler: () => Promise<void>): void {
    this.onYield = handler;
  }

  /** Takes the lock if no other tab has it; true when this tab is now the active one. */
  async acquire(): Promise<boolean> {
    const granted = await this.hold(true);
    return granted;
  }

  /** Gives the lock up for good and stops answering other tabs (a page done with the library). */
  letGo(): void {
    this.channel.onmessage = null;
    this.release?.();
  }

  /** Asks the active tab to let go, then waits for the lock. */
  async takeOver(): Promise<void> {
    const waiting = this.hold(false);
    this.channel.postMessage({ type: 'takeover' } satisfies TakeoverMessage);
    await waiting;
  }

  /** Requests the lock; resolves once it is held (or, with `ifAvailable`, refused). */
  private hold(ifAvailable: boolean): Promise<boolean> {
    return new Promise<boolean>((granted, failed) => {
      this.locks.request(LOCK_NAME, ifAvailable ? { ifAvailable: true } : {}, (lock) => {
        if (!lock) {
          granted(false);
          return Promise.resolve();
        }
        return new Promise<void>((released) => {
          this.release = () => {
            this.release = null;
            released();
          };
          granted(true);
        });
      }).catch(failed);
    });
  }

  private async yieldToOther(): Promise<void> {
    try {
      await this.onYield();
    } finally {
      this.release?.();
    }
  }
}
