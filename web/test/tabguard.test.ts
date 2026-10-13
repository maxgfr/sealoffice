// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'bun:test';
import { type ChannelLike, type LockManagerLike, TabGuard } from '../src/tabguard';

/** Web Locks semantics for exclusive locks: a FIFO queue per name. */
class FakeLocks implements LockManagerLike {
  private held = new Set<string>();
  private queue = new Map<string, (() => void)[]>();

  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: Lock | null) => Promise<void>): Promise<void> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => {
        const waiting = this.queue.get(name) ?? [];
        waiting.push(resolve);
        this.queue.set(name, waiting);
      });
    }
    this.held.add(name);
    try {
      await callback({ name, mode: 'exclusive' } as Lock);
    } finally {
      this.held.delete(name);
      const next = this.queue.get(name)?.shift();
      next?.();
    }
  }
}

/** Channels on one hub deliver to every other channel, asynchronously like BroadcastChannel. */
class FakeHub {
  private readonly channels: ChannelLike[] = [];

  channel(): ChannelLike {
    const channel: ChannelLike = {
      onmessage: null,
      postMessage: (message) => {
        for (const other of this.channels) {
          if (other !== channel) setTimeout(() => other.onmessage?.(new MessageEvent('message', { data: message })), 0);
        }
      },
    };
    this.channels.push(channel);
    return channel;
  }
}

describe('tab guard', () => {
  test('only the first tab gets the lock', async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const first = new TabGuard(locks, hub.channel());
    const second = new TabGuard(locks, hub.channel());
    expect(await first.acquire()).toBe(true);
    expect(first.active).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(second.active).toBe(false);
  });

  test('takeover makes the active tab save, then hands over the lock', async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const first = new TabGuard(locks, hub.channel());
    const second = new TabGuard(locks, hub.channel());
    const events: string[] = [];
    first.setYieldHandler(async () => {
      events.push('saving');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('locked');
    });
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await second.takeOver();
    events.push('taken');
    expect(events).toEqual(['saving', 'locked', 'taken']);
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    // A third tab is turned away from the new active tab too.
    expect(await new TabGuard(locks, hub.channel()).acquire()).toBe(false);
  });

  test('a failing yield handler still releases the lock', async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const reported: unknown[] = [];
    const first = new TabGuard(locks, hub.channel(), (error) => reported.push(error));
    const second = new TabGuard(locks, hub.channel());
    first.setYieldHandler(async () => {
      throw new Error('save failed');
    });
    await first.acquire();
    await second.takeOver();
    expect(reported.map((e) => (e instanceof Error ? e.message : e))).toEqual(['save failed']);
    expect(second.active).toBe(true);
  });

  test('a tab without the lock ignores takeover messages', async () => {
    const locks = new FakeLocks();
    const hub = new FakeHub();
    let yielded = false;
    const idle = new TabGuard(locks, hub.channel());
    idle.setYieldHandler(async () => {
      yielded = true;
    });
    const other = new TabGuard(locks, hub.channel());
    await other.takeOver();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(yielded).toBe(false);
    expect(other.active).toBe(true);
  });
});
