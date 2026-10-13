// SPDX-License-Identifier: AGPL-3.0-only
// live.html: the session bar, the editor and the input shield. The host opens
// the vault and stores every snapshot; guests need no vault (memory only) and
// may save a copy into theirs.
import { Autosaver, SaveSignal } from '../autosave';
import type { SealCrypto } from '../crypto';
import { assetBase, loadEditor, type EditorModule } from '../editor';
import { alert, button, confirm, errorMessage, h } from '../ui';
import type { Vault } from '../vault';
import { importSessionKey } from './protocol';
import { LiveSession, type Snapshot } from './session';
import { joinTrystero } from './transport';

/** The pen holder saves this often while editing. */
const LIVE_AUTOSAVE_MS = 3000;

export interface LiveDeps {
  graphics: boolean;
  /** Tab guard and lock screen in `root`; resolves once the vault is open. */
  openVault(root: HTMLElement): Promise<{ vault: Vault; seal: SealCrypto }>;
}

interface LiveLink {
  room: string;
  key: string;
  /** Vault id of the document, on the host's page only (never in the invite link). */
  hostDoc: string | null;
}

export function parseLiveLink(hash: string): LiveLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const room = params.get('r');
  const key = params.get('k');
  if (!room || !key) return null;
  return { room, key, hostDoc: params.get('h') };
}

export async function bootLive(root: HTMLElement, deps: LiveDeps): Promise<void> {
  const link = parseLiveLink(location.hash);
  if (!link) throw new Error('this live session link is incomplete');
  if (!deps.graphics) throw new Error('editing is unavailable in this browser: it has neither WebGPU nor WebGL2');
  const key = await importSessionKey(link.key);
  const invite = new URL(`live.html#r=${link.room}&k=${link.key}`, location.href).href;

  let host: { vault: Vault; id: string; name: string } | null = null;
  let initial: Snapshot | null = null;
  if (link.hostDoc) {
    const { vault } = await deps.openVault(root);
    const entry = vault.entry(link.hostDoc);
    if (!entry) throw new Error('the document of this session is no longer in the vault');
    host = { vault, id: entry.id, name: entry.name };
    initial = { name: entry.name, bytes: await vault.read(entry.id) };
  }

  root.replaceChildren(h('main', { class: 'card lock' }, h('p', { class: 'muted' }, 'Connecting to the session…')));
  const editorLoad = loadEditor(() => undefined);
  const transport = await joinTrystero(link.room, link.key);
  const bar = new LiveBar(invite, host !== null);
  const signal = new SaveSignal();
  let editor: EditorModule | null = null;
  let autosaver: Autosaver | null = null;
  const firstSnapshot = new Promise<Snapshot>((resolve) => {
    if (initial) resolve(initial);
    bar.firstSnapshot = resolve;
  });

  const session: LiveSession = new LiveSession(transport, key, {
    host: host !== null,
    name: host ? 'Host' : 'Guest',
    // The last edits go out as a snapshot before the pen moves.
    beforeRelease: async () => {
      if (!autosaver) return;
      const result = await autosaver.flush();
      if (result === 'timeout' || result === 'unsavable') bar.reportError(new Error('your last changes could not be sent before the pen moved'));
    },
    events: {
      peers: (peers) => bar.showPeers(peers),
      pen: (holder, mine) => {
        bar.showPen(mine, holder === '' ? 'Nobody' : (bar.names.get(holder) ?? 'Another participant'));
        shield.hidden = mine;
        if (!autosaver) return;
        if (mine) {
          autosaver.start(bar.reportError, LIVE_AUTOSAVE_MS);
        } else {
          autosaver.stop();
        }
      },
      penRequest: (peer, name) => {
        void confirm('Pen requested', `${name} asks to edit. Hand over the pen?`, 'Hand over').then(async (yes) => {
          if (yes) await session.grantPen(peer);
        }).catch(bar.reportError);
      },
      snapshot: (snapshot, applied) => {
        bar.firstSnapshot?.(snapshot);
        if (host) {
          host.vault.write(host.name, snapshot.bytes, host.id).catch(bar.reportError);
        }
        bar.showPending(editor !== null && !applied);
      },
      rejected: (error) => console.warn('live message dropped:', error),
      error: bar.reportError,
    },
  });
  if (initial) session.setInitial(initial);
  bar.showPen(session.holdsPen, 'The host');

  // Saves: the pen holder's go to every peer (and the host's vault); nobody else saves.
  window.ibisOfficeSaveFile = async (name, bytes) => {
    try {
      if (!session.holdsPen) throw new Error('only the participant holding the pen can save');
      if (host) await host.vault.write(host.name, bytes, host.id);
      await session.publish({ name: host ? host.name : name, bytes });
      signal.emit({ name });
      return name;
    } catch (error) {
      signal.emit({ error });
      throw error;
    }
  };
  window.ibisOfficePickFile = async () => {
    await alert('Not in a live session', 'Leave the session to open another document.');
    return null;
  };

  const shield = inputShield(() => !session.holdsPen);
  bar.onRequestPen = () => session.requestPen().then(() => bar.note('Request sent to the host.'), bar.reportError);
  bar.onTakePen = () => session.grantPen(transport.selfId).catch(bar.reportError);
  bar.onLoadPending = () => {
    session.loadPending();
    bar.showPending(false);
  };
  bar.onSaveCopy = () => saveCopy(session.latest, deps).catch(bar.reportError);
  bar.onLeave = () => {
    session.leave().then(() => location.assign(new URL('./', location.href).href), bar.reportError);
  };

  if (!host) root.replaceChildren(h('main', { class: 'card lock' }, h('p', { class: 'muted' }, 'Waiting for the host’s document…')));
  const [first, loaded] = await Promise.all([firstSnapshot, editorLoad]);
  editor = loaded;
  root.replaceChildren();
  editor.run(assetBase(), first.name, first.bytes);
  session.attachEditor(editor);
  autosaver = new Autosaver(editor, signal);
  if (session.holdsPen) autosaver.start(bar.reportError, LIVE_AUTOSAVE_MS);
  shield.hidden = session.holdsPen;
  document.body.append(shield, bar.el);
  window.addEventListener('beforeunload', (event) => {
    if (session.holdsPen && autosaver?.dirty) event.preventDefault();
  });
}

/** Guests: stores the current snapshot in their own vault (unlocking it first). */
async function saveCopy(snapshot: Snapshot | null, deps: LiveDeps): Promise<void> {
  if (!snapshot) throw new Error('no document received yet');
  const overlay = h('div', { class: 'overlay' });
  // Above the input shield, which only blocks the editor.
  overlay.style.zIndex = String(SHIELD_Z + 10);
  const panel = h('div', {});
  overlay.append(panel);
  document.body.append(overlay);
  try {
    const { vault } = await deps.openVault(panel);
    const entry = await vault.write(vault.uniqueName(snapshot.name), snapshot.bytes);
    await vault.close();
    await alert('Copy saved', `"${entry.name}" is in your vault.`);
  } finally {
    overlay.remove();
  }
}

const SHIELD_Z = 15;

/** UI the shield never blocks: the session bar, dialogs and overlays (the vault's lock screen). */
const APP_UI = '.live-bar, dialog, .overlay';

/** Whether a key pressed with focus on `target` would reach the editor (canvas, body, nothing). */
export function keyGoesToEditor(target: { closest(selectors: string): unknown } | null): boolean {
  return target === null || target.closest(APP_UI) === null;
}

/**
 * Covers the editor while someone else holds the pen: clicks and keys are
 * blocked, the wheel is passed on so the document still scrolls.
 */
function inputShield(blocking: () => boolean): HTMLElement {
  const shield = h('div', { 'aria-hidden': 'true' });
  Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: String(SHIELD_Z), background: 'transparent', cursor: 'not-allowed' });
  shield.addEventListener('wheel', (event) => {
    const canvas = document.querySelector('body > canvas');
    canvas?.dispatchEvent(new WheelEvent('wheel', event));
  }, { passive: true });
  window.addEventListener('keydown', (event) => {
    if (!blocking() || !keyGoesToEditor(event.target instanceof Element ? event.target : null)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  return shield;
}

/** The session bar: who holds the pen, participants, invite link and actions. */
class LiveBar {
  readonly el: HTMLElement;
  readonly names = new Map<string, string>();
  firstSnapshot: ((snapshot: Snapshot) => void) | null = null;
  onRequestPen: () => void = () => undefined;
  onTakePen: () => void = () => undefined;
  onLoadPending: () => void = () => undefined;
  onSaveCopy: () => void = () => undefined;
  onLeave: () => void = () => undefined;

  private readonly penLabel = h('strong', {}, 'Connecting…');
  private readonly peersLabel = h('span', { class: 'muted small' }, 'No one else yet');
  private readonly status = h('span', { class: 'muted small', role: 'status' });
  private readonly requestButton = button('Request the pen', () => this.onRequestPen());
  private readonly takeButton = button('Take the pen back', () => this.onTakePen());
  private readonly pendingButton = button('Load the new version (drops your changes)', () => this.onLoadPending(), 'danger-link');

  constructor(invite: string, isHost: boolean) {
    const copy = button('Copy invite link', () => {
      navigator.clipboard.writeText(invite).then(() => this.note('Invite link copied.'), this.reportError);
    }, 'primary');
    this.pendingButton.hidden = true;
    this.requestButton.hidden = isHost;
    this.takeButton.hidden = true;
    this.el = h(
      'nav',
      { class: 'pill live-bar', 'aria-label': 'Live session' },
      this.penLabel,
      this.peersLabel,
      copy,
      this.requestButton,
      isHost ? this.takeButton : null,
      this.pendingButton,
      isHost ? null : button('Save a copy in my vault', () => this.onSaveCopy()),
      button('Leave', () => this.onLeave()),
      this.status,
    );
    Object.assign(this.el.style, { top: 'auto', bottom: '8px', right: '8px', flexWrap: 'wrap', alignItems: 'center', gap: '6px', maxWidth: 'calc(100vw - 16px)' });
  }

  showPen(mine: boolean, holder: string): void {
    this.penLabel.textContent = mine ? 'You have the pen' : `${holder} has the pen`;
    this.requestButton.disabled = mine;
    this.takeButton.hidden = mine;
  }

  showPeers(peers: Map<string, string>): void {
    this.names.clear();
    for (const [id, name] of peers) this.names.set(id, name);
    const list = [...peers.values()];
    this.peersLabel.textContent = list.length === 0 ? 'No one else yet' : `With: ${list.join(', ')}`;
  }

  showPending(pending: boolean): void {
    this.pendingButton.hidden = !pending;
    if (pending) this.note('A new version arrived; your unsaved changes are kept for now.');
  }

  note(text: string): void {
    this.status.textContent = text;
  }

  readonly reportError = (error: unknown): void => {
    console.error('live session:', error);
    this.status.textContent = `Error: ${errorMessage(error)}`;
  };
}
