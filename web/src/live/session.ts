// SPDX-License-Identifier: AGPL-3.0-only
// A live session: one peer at a time holds the pen and edits; each of its
// saves is broadcast as an encrypted snapshot that the others load. The host
// (who started the session) hands the pen over on request; before it moves,
// the holder saves and broadcasts its last changes, so no edit is lost.
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
  /** Host: resolves the wait for the holder's 'pen-released'. */
  private released: (() => void) | null = null;
  private inbox: Promise<void> = Promise.resolve();

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
      if (peer === this.penHolder) this.released?.();
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

  /** Asks the host for the pen. */
  async requestPen(): Promise<void> {
    if (this.holdsPen) return;
    if (!this.hostId) throw new Error('the host is not connected');
    await this.send({ type: 'pen-request', name: this.options.name }, this.hostId);
  }

  /**
   * Host: gives the pen to `peer` (or takes it back with its own id). The
   * current holder first saves and broadcasts its last changes; a holder that
   * does not answer within the timeout loses the pen anyway.
   */
  async grantPen(peer: string): Promise<void> {
    if (!this.options.host) throw new Error('only the host hands out the pen');
    const holder = this.penHolder;
    if (holder === peer) return;
    if (holder === this.transport.selfId) {
      await this.options.beforeRelease?.();
    } else if (this.names.has(holder)) {
      await this.awaitRelease(holder);
    }
    this.setPen(peer);
    await this.send({ type: 'pen-grant', peer });
  }

  private awaitRelease(holder: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.released = null;
        resolve();
      }, this.options.releaseTimeoutMs ?? 10_000);
      this.released = () => {
        clearTimeout(timer);
        this.released = null;
        resolve();
      };
      this.send({ type: 'pen-release' }, holder).catch((error: unknown) => {
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
        if (this.options.host) this.options.events?.penRequest?.(peer, message.name);
        return;
      case 'pen-grant':
        if (peer === this.hostId) this.setPen(message.peer);
        return;
      case 'pen-release':
        if (peer === this.hostId && this.holdsPen) await this.release();
        return;
      case 'pen-released':
        if (this.options.host && peer === this.penHolder) this.released?.();
        return;
      case 'snapshot':
        // Only the pen holder's snapshots count; the host also brings a new guest up to date.
        if (peer === this.penHolder || (peer === this.hostId && this.latestSnapshot === null)) this.onSnapshot(message);
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
