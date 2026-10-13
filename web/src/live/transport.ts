// SPDX-License-Identifier: AGPL-3.0-only
// How live peers reach each other: Trystero over pinned Nostr relays for
// signalling, then WebRTC data channels. live.html's CSP connect-src lists
// exactly RELAYS; index.html allows no network at all.

/** The Nostr relays used for signalling. Keep live.html's CSP connect-src in sync. */
export const RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  'wss://relay.sigit.io',
  'wss://schnorr.me',
];

export const APP_ID = 'sealoffice';

/** A room: broadcast or targeted bytes between peers. */
export interface Transport {
  readonly selfId: string;
  send(data: Uint8Array, target?: string): Promise<void>;
  onMessage(handler: (data: Uint8Array, peer: string) => void): void;
  onPeerJoin(handler: (peer: string) => void): void;
  onPeerLeave(handler: (peer: string) => void): void;
  leave(): Promise<void>;
}

/** Joins `room` through Trystero's Nostr strategy; `password` also encrypts the signalling. */
export async function joinTrystero(room: string, password: string): Promise<Transport> {
  // Loaded only on live.html: the main page never contains or runs network code paths.
  const { joinRoom, selfId } = await import('trystero/nostr');
  const joined = joinRoom({ appId: APP_ID, password, relayConfig: { urls: RELAYS, redundancy: RELAYS.length } }, room);
  const action = joined.makeAction<Uint8Array>('msg');
  return {
    selfId,
    send: (data, target) => action.send(data, target === undefined ? undefined : { target }),
    onMessage: (handler) => {
      action.onMessage = (data, context) => {
        handler(data instanceof Uint8Array ? data : new Uint8Array(data), context.peerId);
      };
    },
    onPeerJoin: (handler) => {
      joined.onPeerJoin = handler;
    },
    onPeerLeave: (handler) => {
      joined.onPeerLeave = handler;
    },
    leave: () => joined.leave(),
  };
}

/** Peers in one process, for tests: delivery is asynchronous, like the network. */
export class MemoryHub {
  private readonly peers = new Map<string, {
    message: (data: Uint8Array, peer: string) => void;
    join: (peer: string) => void;
    leave: (peer: string) => void;
  }>();

  private count = 0;

  join(): Transport {
    const selfId = `peer-${++this.count}`;
    const entry = { message: (_d: Uint8Array, _p: string) => undefined as void, join: (_p: string) => undefined as void, leave: (_p: string) => undefined as void };
    const others = [...this.peers.keys()];
    this.peers.set(selfId, entry);
    // Both sides learn of each other, as with a real room.
    queueMicrotask(() => {
      for (const other of others) {
        this.peers.get(other)?.join(selfId);
        entry.join(other);
      }
    });
    return {
      selfId,
      send: async (data, target) => {
        for (const [id, peer] of this.peers) {
          if (id === selfId || (target !== undefined && id !== target)) continue;
          const copy = data.slice();
          setTimeout(() => peer.message(copy, selfId), 0);
        }
      },
      onMessage: (handler) => {
        entry.message = handler;
      },
      onPeerJoin: (handler) => {
        entry.join = handler;
      },
      onPeerLeave: (handler) => {
        entry.leave = handler;
      },
      leave: async () => {
        this.peers.delete(selfId);
        for (const peer of this.peers.values()) peer.leave(selfId);
      },
    };
  }
}
