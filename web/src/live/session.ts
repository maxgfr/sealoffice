// SPDX-License-Identifier: AGPL-3.0-only
// A live session: one peer at a time holds the pen and edits; each of its
// saves is broadcast as an encrypted snapshot that the others load. The host
// (who started the session) hands the pen over on request, or on its own when
// someone starts typing while the holder has paused; before it moves, the
// holder saves and broadcasts its last changes, so no edit is lost.
import { type LiveMessage, openMessage, sealMessage, SnapshotOrder } from './protocol';
import type { Transport } from './transport';

/** The editor exports a session needs. */
export interface LiveEditor {
  is_dirty(): boolean;
  open_bytes(name: string, bytes: Uint8Array): void;
}

export interface Snapshot {
  name: string;
  bytes: Uint8Array;
}

export interface SessionEvents {
  /** Peers present (not counting this one), by id → display name. */
  peers?(peers: Map<string, string>): void;
  /** The pen moved; `mine` when this peer now holds it. */
  pen?(holder: string, mine: boolean): void;
  /** Host only: `peer` asks for the pen. */
  penRequest?(peer: string, name: string): void;
  /** Typing did not get the pen: `holder` is still typing. */
  penBusy?(holder: string): void;
  /** A newer snapshot arrived (applied to the editor already, when there is one and it is clean). */
  snapshot?(snapshot: Snapshot, applied: boolean): void;
  /** A message could not be read (altered, foreign key): it is dropped. */
  rejected?(error: unknown): void;
  /** Sending failed. */
  error?(error: unknown): void;
}

export class LiveSession {
  private readonly order = new SnapshotOrder();
  private readonly names = new Map<string, string>();
  private hostId: string;
  private penHolder: string;
  private editor: LiveEditor | null = null;
  private latestSnapshot: Snapshot | null = null;
  /** A snapshot not loaded because the editor had local changes. */
  private held: Snapshot | null = null;
  /** Host: settles the wait for the holder's answer (true: released, false: busy). */
  private released: ((free: boolean) => void) | null = null;
  private inbox: Promise<void> = Promise.resolve();
  /** Host: pen moves, one at a time. */
  private handovers: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: Transport,
    private readonly key: CryptoKey,
    private readonly options: {
      host: boolean;
      name: string;
      events?: SessionEvents;
      /** Before giving up the pen: save, so the last changes go out as a snapshot. */
      beforeRelease?: () => Promise<void>;
      /** How long the host waits for a holder that does not answer (left, disconnected). */
      releaseTimeoutMs?: number;
      /** Typing takes the pen from a holder that has not typed for this long. */
      idleMs?: number;
      /** When this peer's user last typed into the document (ms since the epoch). */
      lastInput?: () => number;
    },
  ) {
    this.hostId = options.host ? transport.selfId : '';
    this.penHolder = this.hostId;
    // One message at a time, in arrival order: decryption is async and must not reorder them.
    transport.onMessage((data, peer) => {
      this.inbox = this.inbox
        .then(() => this.receive(data, peer))
        .catch((error: unknown) => this.options.events?.rejected?.(error));
    });
    transport.onPeerJoin((peer) => {
      this.names.set(peer, this.names.get(peer) ?? 'Guest');
      this.emitPeers();
      this.welcome(peer).catch((error: unknown) => this.report(error));
    });
    transport.onPeerLeave((peer) => {
      this.names.delete(peer);
      // A holder that left cannot release: stop waiting for it.
      if (peer === this.penHolder) this.released?.(true);
      this.emitPeers();
    });
  }

  get selfId(): string {
    return this.transport.selfId;
  }

  get isHost(): boolean {
    return this.options.host;
  }

  get holdsPen(): boolean {
    return this.penHolder === this.transport.selfId;
  }

  get pen(): string {
    return this.penHolder;
  }

  /** The newest snapshot seen or sent. */
  get latest(): Snapshot | null {
    return this.latestSnapshot;
  }

  /** Whether a received snapshot waits because of local changes. */
  get pending(): Snapshot | null {
    return this.held;
  }

  /** Snapshots are loaded into `editor` from now on. */
  attachEditor(editor: LiveEditor): void {
    this.editor = editor;
  }

  /** Host: the document the session starts from. */
  setInitial(snapshot: Snapshot): void {
    this.order.next();
    this.latestSnapshot = snapshot;
  }

  /** Broadcasts a save by the pen holder. */
  async publish(snapshot: Snapshot): Promise<void> {
    if (!this.holdsPen) throw new Error('only the peer holding the pen can publish');
    this.latestSnapshot = snapshot;
    await this.send({ type: 'snapshot', seq: this.order.next(), name: snapshot.name, bytes: snapshot.bytes });
  }

  /**
   * Asks for the pen. `auto`: this peer started typing, and the pen moves
   * without the host's say-so if the holder has paused (see `idleMs`);
   * otherwise the host is asked.
   */
  async requestPen(auto = false): Promise<void> {
    if (this.holdsPen) return;
    if (this.options.host) {
      if (auto) await this.autoGrant(this.transport.selfId);
      return;
    }
    if (!this.hostId) throw new Error('the host is not connected');
    await this.send({ type: 'pen-request', name: this.options.name, ...(auto ? { auto: true } : {}) }, this.hostId);
  }

  /**
   * Host: gives the pen to `peer` (or takes it back with its own id). The
   * current holder first saves and broadcasts its last changes; a holder that
   * does not answer within the timeout loses the pen anyway.
   */
  async grantPen(peer: string): Promise<void> {
    if (!this.options.host) throw new Error('only the host hands out the pen');
    await this.serial(() => this.handOver(peer));
  }

  /** Host: `peer` started typing; the pen moves if its holder has paused, else `peer` hears it is busy. */
  private autoGrant(peer: string): Promise<void> {
    return this.serial(async () => {
      const idleMs = this.options.idleMs;
      const holder = this.penHolder;
      if (idleMs !== undefined && (await this.handOver(peer, idleMs))) return;
      if (peer === this.transport.selfId) {
        this.options.events?.penBusy?.(holder);
      } else {
        await this.send({ type: 'pen-busy', holder }, peer);
      }
    });
  }

  /** Moves the pen to `peer`; with `ifIdleMs`, only if the holder has not typed for that long. Whether it moved. */
  private async handOver(peer: string, ifIdleMs?: number): Promise<boolean> {
    const holder = this.penHolder;
    if (holder === peer) return true;
    if (holder === this.transport.selfId) {
      if (ifIdleMs !== undefined && !this.idleFor(ifIdleMs)) return false;
      await this.options.beforeRelease?.();
    } else if (this.names.has(holder) && !(await this.awaitRelease(holder, ifIdleMs))) {
      return false;
    }
    // The new holder edits from the latest version: one it missed (a peer it
    // has no direct link to) would be overwritten, and its next snapshot would
    // carry a seq the others already passed.
    const latest = this.latestSnapshot;
    if (latest && peer !== this.transport.selfId) {
      await this.send({ type: 'snapshot', seq: this.order.seq, name: latest.name, bytes: latest.bytes }, peer);
    }
    this.setPen(peer);
    await this.send({ type: 'pen-grant', peer });
    return true;
  }

  /** Host: runs pen moves one after the other. */
  private serial<T>(move: () => Promise<T>): Promise<T> {
    const run = this.handovers.then(move, move);
    this.handovers = run.catch(() => undefined);
    return run;
  }

  /** Whether this peer's user has not typed for `ms`. */
  private idleFor(ms: number): boolean {
    return Date.now() - (this.options.lastInput?.() ?? 0) >= ms;
  }

  /** Asks `holder` to release the pen; false when it answers that it is busy typing. */
  private awaitRelease(holder: string, ifIdleMs?: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.released = null;
        resolve(true);
      }, this.options.releaseTimeoutMs ?? 10_000);
      this.released = (free) => {
        clearTimeout(timer);
        this.released = null;
        resolve(free);
      };
      this.send({ type: 'pen-release', ...(ifIdleMs === undefined ? {} : { ifIdleMs }) }, holder).catch((error: unknown) => {
        clearTimeout(timer);
        this.released = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Holder: saves (the snapshot goes out first), then tells the host. */
  private async release(): Promise<void> {
    await this.options.beforeRelease?.();
    await this.send({ type: 'pen-released', seq: this.order.seq }, this.hostId);
  }

  /** Loads the snapshot held back by local changes, dropping them. */
  loadPending(): void {
    const held = this.held;
    if (!held || !this.editor) return;
    this.held = null;
    this.editor.open_bytes(held.name, held.bytes);
  }

  async leave(): Promise<void> {
    await this.transport.leave();
  }

  /** Says hello to a new peer; the host also sends who holds the pen and the document. */
  private async welcome(peer: string): Promise<void> {
    await this.send({ type: 'hello', name: this.options.name }, peer);
    if (!this.options.host) return;
    await this.send({ type: 'presence', host: this.hostId, pen: this.penHolder, seq: this.order.seq }, peer);
    const latest = this.latestSnapshot;
    if (latest) await this.send({ type: 'snapshot', seq: this.order.seq, name: latest.name, bytes: latest.bytes }, peer);
  }

  private async receive(data: Uint8Array, peer: string): Promise<void> {
    const message = await openMessage(this.key, data);
    switch (message.type) {
      case 'hello':
        this.names.set(peer, message.name);
        this.emitPeers();
        return;
      case 'presence':
        // Only the host's own word counts, and a host never takes it from others.
        if (this.options.host || message.host !== peer) return;
        if (message.host !== this.hostId) {
          // A new host instance (first contact, or a reload) numbers its
          // snapshots from 1: start over so its welcome snapshot counts.
          this.order.reset();
          this.latestSnapshot = null;
        }
        this.hostId = message.host;
        this.setPen(message.pen);
        return;
      case 'pen-request':
        if (!this.options.host) return;
        if (message.auto) {
          // Not awaited: the holder's answer comes through this same inbox.
          this.autoGrant(peer).catch((error: unknown) => this.report(error));
        } else {
          this.options.events?.penRequest?.(peer, message.name);
        }
        return;
      case 'pen-grant':
        if (peer === this.hostId) this.setPen(message.peer);
        return;
      case 'pen-release':
        if (peer !== this.hostId || !this.holdsPen) return;
        if (message.ifIdleMs !== undefined && !this.idleFor(message.ifIdleMs)) {
          await this.send({ type: 'pen-busy', holder: this.transport.selfId }, this.hostId);
        } else {
          await this.release();
        }
        return;
      case 'pen-released':
        if (this.options.host && peer === this.penHolder) this.released?.(true);
        return;
      case 'pen-busy':
        if (this.options.host) {
          if (peer === this.penHolder) this.released?.(false);
        } else if (peer === this.hostId) {
          this.options.events?.penBusy?.(message.holder);
        }
        return;
      case 'snapshot':
        // Only the pen holder's snapshots count; the host also brings peers up to date (a new guest, the next holder).
        if (peer === this.penHolder || peer === this.hostId) this.onSnapshot(message);
        return;
    }
  }

  private onSnapshot(message: Extract<LiveMessage, { type: 'snapshot' }>): void {
    // A new guest gets the host's current snapshot at the host's current seq.
    const fresh = message.seq > this.order.seq || (this.latestSnapshot === null && message.seq === this.order.seq && message.seq > 0);
    if (!fresh) return;
    if (message.seq > this.order.seq) this.order.accept(message.seq);
    const snapshot = { name: message.name, bytes: message.bytes };
    this.latestSnapshot = snapshot;
    let applied = false;
    if (this.editor) {
      if (this.editor.is_dirty()) {
        this.held = snapshot;
      } else {
        this.held = null;
        this.editor.open_bytes(snapshot.name, snapshot.bytes);
        applied = true;
      }
    }
    this.options.events?.snapshot?.(snapshot, applied);
  }

  private setPen(holder: string): void {
    this.penHolder = holder;
    this.options.events?.pen?.(holder, holder === this.transport.selfId);
  }

  private report(error: unknown): void {
    if (this.options.events?.error) {
      this.options.events.error(error);
    } else {
      console.error('live session:', error);
    }
  }

  private emitPeers(): void {
    this.options.events?.peers?.(new Map(this.names));
  }

  private async send(message: LiveMessage, target?: string): Promise<void> {
    await this.transport.send(await sealMessage(this.key, message), target);
  }
}
