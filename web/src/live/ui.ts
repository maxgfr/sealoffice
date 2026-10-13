// SPDX-License-Identifier: AGPL-3.0-only
// live.html: the session bar, the editor and the input shield. The host opens
// the library (unlocking it only when it is protected) and stores every
// snapshot; guests need no library (memory only) and may save a copy into theirs.
import { Autosaver, SaveSignal } from '../autosave';
import type { SealCrypto } from '../crypto';
import { assetBase, loadEditor, type EditorModule } from '../editor';
import { alert, button, confirm, errorMessage, form, h } from '../ui';
import type { Vault } from '../vault';
import { importSessionKey } from './protocol';
import { LiveSession, type Snapshot } from './session';
import { joinTrystero } from './transport';

/** The pen holder saves this often while editing. */
const LIVE_AUTOSAVE_MS = 3000;
/** Typing takes the pen from a holder that has not typed for this long. */
const AUTO_PEN_IDLE_MS = 5000;
/** Typing while someone else holds the pen asks for it at most this often. */
const AUTO_PEN_RETRY_MS = 1500;
/** sessionStorage: the host's document of room `<room>`, once the address bar shows the invite link. */
const HOST_DOC_KEY = 'sealoffice-live-host:';

export interface LiveDeps {
  graphics: boolean;
  /** Tab guard, then the lock screen in `root` if the library is protected; resolves once it is open. */
  openVault(root: HTMLElement): Promise<{ vault: Vault; seal: SealCrypto }>;
}

interface LiveLink {
  room: string;
  key: string;
  /** Library id of the document, on the host's page only (never in the invite link). */
  hostDoc: string | null;
}

/** A live link's parts; without `h`, the host document `remembered` for the room, if any. */
export function parseLiveLink(hash: string, remembered: (room: string) => string | null = () => null): LiveLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const room = params.get('r');
  const key = params.get('k');
  if (!room || !key) return null;
  return { room, key, hostDoc: params.get('h') ?? remembered(room) };
}

/** The host document this tab started room `room` with (a reload keeps it; another tab does not). */
function rememberedHostDoc(room: string): string | null {
  try {
    return sessionStorage.getItem(HOST_DOC_KEY + room);
  } catch {
    return null;
  }
}

function rememberHostDoc(room: string, id: string | null): void {
  try {
    if (id === null) {
      sessionStorage.removeItem(HOST_DOC_KEY + room);
    } else {
      sessionStorage.setItem(HOST_DOC_KEY + room, id);
    }
  } catch {
    // Storage blocked: a reload of this page joins as a guest.
  }
}

/** Whether a key pressed in the document changes its text (typing, Enter, deleting), not a shortcut or a move. */
export function editsText(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  if (event.metaKey || event.ctrlKey) return false;
  return event.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab', 'Process'].includes(event.key);
}

export async function bootLive(root: HTMLElement, deps: LiveDeps): Promise<void> {
  const link = parseLiveLink(location.hash, rememberedHostDoc);
  if (!link) throw new Error('this live session link is incomplete');
  if (!deps.graphics) throw new Error('editing is unavailable in this browser: it has neither WebGPU nor WebGL2');
  const key = await importSessionKey(link.key);
  const invite = new URL(`live.html#r=${link.room}&k=${link.key}`, location.href).href;
  // The host's address bar shows the invite link, ready to share; this tab
  // remembers it is the host, so a reload still is.
  const justStarted = new URLSearchParams(location.hash.replace(/^#/, '')).has('h');
  if (link.hostDoc) {
    rememberHostDoc(link.room, link.hostDoc);
    history.replaceState(null, '', invite);
  }

  let host: { vault: Vault; id: string; name: string } | null = null;
  let initial: Snapshot | null = null;
  if (link.hostDoc) {
    const { vault } = await deps.openVault(root);
    const entry = vault.entry(link.hostDoc);
    if (!entry) throw new Error('the document of this session is no longer in the library');
    // A locked document's key never survives the page change: ask for it again.
    if (entry.lock && !vault.isDocOpen(entry.id) && !(await askDocPassphrase(vault, entry.id, entry.name))) {
      location.assign(new URL('./', location.href).href);
      return;
    }
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
  /** When this user last typed into the document while holding the pen. */
  let lastInput = 0;
  const firstSnapshot = new Promise<Snapshot>((resolve) => {
    if (initial) resolve(initial);
    bar.firstSnapshot = resolve;
  });

  const session: LiveSession = new LiveSession(transport, key, {
    host: host !== null,
    name: host ? 'Host' : 'Guest',
    idleMs: AUTO_PEN_IDLE_MS,
    lastInput: () => lastInput,
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
        bar.note(mine ? '' : 'Start typing to take the pen once they pause.');
        if (!autosaver) return;
        if (mine) {
          autosaver.start(bar.reportError, LIVE_AUTOSAVE_MS);
        } else {
          autosaver.stop();
        }
      },
      penBusy: (holder) => bar.note(`${bar.names.get(holder) ?? 'Another participant'} is typing: the pen moves when they pause.`),
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

  // Saves: the pen holder's go to every peer (and the host's library); nobody else saves.
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

  // Typing while someone else holds the pen asks for it: it moves at once if they have paused.
  let askedAt = 0;
  const shield = inputShield(() => !session.holdsPen, () => {
    if (Date.now() - askedAt < AUTO_PEN_RETRY_MS) return;
    askedAt = Date.now();
    bar.note('Asking for the pen…');
    session.requestPen(true).catch(bar.reportError);
  });
  window.addEventListener('keydown', (event) => {
    if (session.holdsPen && editsText(event) && keyGoesToEditor(event.target instanceof Element ? event.target : null)) lastInput = Date.now();
  }, { capture: true });
  bar.onRequestPen = () => session.requestPen().then(() => bar.note('Request sent to the host.'), bar.reportError);
  bar.onTakePen = () => session.grantPen(transport.selfId).catch(bar.reportError);
  bar.onLoadPending = () => {
    session.loadPending();
    bar.showPending(false);
  };
  bar.onSaveCopy = () => saveCopy(session.latest, deps).catch(bar.reportError);
  bar.onLeave = () => {
    if (host) rememberHostDoc(link.room, null);
    session.leave().then(() => location.assign(new URL('./', location.href).href), bar.reportError);
  };

  if (!host) root.replaceChildren(h('main', { class: 'card lock' }, h('p', { class: 'muted' }, 'Waiting for the host’s document…')));
  const [first, loaded] = await Promise.all([firstSnapshot, editorLoad]);
  editor = loaded;
  root.replaceChildren();
  // No app bar here: the canvas takes the whole window, the session bar floats over it.
  document.documentElement.style.setProperty('--appbar', '0px');
  editor.run(assetBase(), first.name, first.bytes);
  session.attachEditor(editor);
  autosaver = new Autosaver(editor, signal);
  if (session.holdsPen) autosaver.start(bar.reportError, LIVE_AUTOSAVE_MS);
  shield.hidden = session.holdsPen;
  document.body.append(shield, bar.el);
  if (host && justStarted) {
    navigator.clipboard.writeText(invite).then(
      () => bar.note('Invite link copied: send it to edit together.'),
      () => bar.note('Send the link in the address bar to edit together.'),
    );
  }
  window.addEventListener('beforeunload', (event) => {
    if (session.holdsPen && autosaver?.dirty) event.preventDefault();
  });
}

/** Guests: stores the current snapshot in their own library (unlocking it first if it is protected). */
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
    await alert('Copy saved', `"${entry.name}" is in your library.`);
  } finally {
    overlay.remove();
  }
}

/** Asks for a locked document's passphrase; false when the host gave up. */
async function askDocPassphrase(vault: Vault, id: string, name: string): Promise<boolean> {
  const values = await form({
    title: `Open "${name}"`,
    text: 'This document is locked with its own passphrase.',
    fields: [{ name: 'secret', label: 'Document passphrase', type: 'password', autocomplete: 'off' }],
    submit: 'Unlock',
    validate: async (v) => {
      await vault.openDoc(id, v.secret ?? '');
      return null;
    },
  });
  return values !== null;
}

const SHIELD_Z = 15;

/** UI the shield never blocks: the session bar, dialogs and overlays (the library's lock screen). */
const APP_UI = '.live-bar, dialog, .overlay';

/** Whether a key pressed with focus on `target` would reach the editor (canvas, body, nothing). */
export function keyGoesToEditor(target: { closest(selectors: string): unknown } | null): boolean {
  return target === null || target.closest(APP_UI) === null;
}

/**
 * Covers the editor while someone else holds the pen: clicks and keys are
 * blocked, the wheel is passed on so the document still scrolls. A blocked
 * key that would change the text calls `typed`.
 */
function inputShield(blocking: () => boolean, typed: () => void): HTMLElement {
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
    if (editsText(event)) typed();
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
      isHost ? null : button('Save a copy in my library', () => this.onSaveCopy()),
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
