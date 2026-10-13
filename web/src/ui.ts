// SPDX-License-Identifier: AGPL-3.0-only
// Small DOM helpers and modal dialogs. Text goes in with textContent only.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((event: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') {
      el.addEventListener(key.replace(/^on/, ''), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child) el.append(child);
  }
  return el;
}

export function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: className, onclick: onClick }, label);
}

let dialogCount = 0;

/**
 * Shows a modal dialog built by `build`; `close(value)` settles it.
 * Escape and the browser's cancel resolve to `cancelValue`, unless
 * `dismissible` is false (the dialog then closes only through `close`).
 */
export function modal<T>(
  title: string,
  build: (close: (value: T) => void, body: HTMLElement) => void,
  cancelValue: T,
  dismissible = true,
): Promise<T> {
  return new Promise((resolve) => {
    const titleId = `dialog-title-${++dialogCount}`;
    const body = h('div', { class: 'dialog-body' });
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId }, h('h2', { id: titleId }, title), body);
    let settled = false;
    const close = (value: T): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (dismissible) close(cancelValue);
    });
    build(close, body);
    document.body.append(dialog);
    dialog.showModal();
  });
}

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'number';
  value?: string;
  autocomplete?: string;
}

/**
 * A form dialog; resolves to the field values, or null when cancelled.
 * `validate` returns an error message to keep the dialog open.
 */
export function form(options: {
  title: string;
  text?: string;
  fields: Field[];
  submit: string;
  danger?: boolean;
  /** A checkbox that must be ticked before the form can be submitted. */
  acknowledge?: string;
  /** Keeps the submit button disabled until it returns true for the typed values. */
  ready?: (values: Record<string, string>) => boolean;
  /** Extra controls under the buttons; `close` cancels the form first. */
  aside?: (close: () => void) => HTMLElement;
  validate?: (values: Record<string, string>) => string | null | Promise<string | null>;
}): Promise<Record<string, string> | null> {
  return modal<Record<string, string> | null>(options.title, (close, body) => {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const inputs = options.fields.map((field) => {
      const id = `field-${dialogCount}-${field.name}`;
      const input = h('input', {
        id,
        name: field.name,
        type: field.type ?? 'text',
        autocomplete: field.autocomplete ?? 'off',
        spellcheck: 'false',
        required: true,
      });
      if (field.value !== undefined) input.value = field.value;
      return { field, input, row: h('label', { class: 'field', for: id }, h('span', {}, field.label), input) };
    });
    const submit = h('button', { type: 'submit', class: options.danger ? 'danger' : 'primary' }, options.submit);
    const values = (): Record<string, string> => Object.fromEntries(inputs.map(({ field, input }) => [field.name, input.value]));
    let ack: HTMLLabelElement | null = null;
    const blocked = (): boolean =>
      (ack !== null && !ack.querySelector('input')?.checked) || (options.ready !== undefined && !options.ready(values()));
    if (options.acknowledge) {
      const id = `field-${dialogCount}-acknowledge`;
      const box = h('input', { id, type: 'checkbox', name: 'acknowledge' });
      box.addEventListener('change', () => {
        submit.disabled = blocked();
      });
      ack = h('label', { class: 'field', for: id }, box, h('span', {}, options.acknowledge));
    }
    for (const { input } of inputs) {
      input.addEventListener('input', () => {
        submit.disabled = blocked();
      });
    }
    submit.disabled = blocked();
    const el = h(
      'form',
      { class: 'form', novalidate: true },
      options.text ? h('p', {}, options.text) : null,
      ...inputs.map((i) => i.row),
      ack,
      error,
      h('div', { class: 'actions' }, button('Cancel', () => close(null)), submit),
      options.aside?.(() => close(null)) ?? null,
    );
    el.addEventListener('submit', (event) => {
      event.preventDefault();
      if (blocked()) return;
      const typed = values();
      submit.disabled = true;
      error.textContent = '';
      Promise.resolve(options.validate?.(typed) ?? null)
        .then((message) => {
          if (message) {
            error.textContent = message;
          } else {
            close(typed);
          }
        })
        .catch((e: unknown) => {
          error.textContent = errorMessage(e);
        })
        .finally(() => {
          submit.disabled = blocked();
        });
    });
    body.append(el);
    queueMicrotask(() => inputs[0]?.input.focus());
  }, null);
}

export function confirm(title: string, text: string, ok: string, danger = false): Promise<boolean> {
  return modal(title, (close, body) => {
    const okButton = button(ok, () => close(true), danger ? 'danger' : 'primary');
    body.append(h('p', {}, text), h('div', { class: 'actions' }, button('Cancel', () => close(false)), okButton));
    queueMicrotask(() => okButton.focus());
  }, false);
}

export function alert(title: string, text: string): Promise<void> {
  return modal<void>(title, (close, body) => {
    const ok = button('OK', () => close(), 'primary');
    body.append(h('p', {}, text), h('div', { class: 'actions' }, ok));
    queueMicrotask(() => ok.focus());
  }, undefined);
}

/** Asks for one file from disk; null when the user cancels. */
export async function pickLocalFile(accept: string): Promise<File | null> {
  return (await pickLocalFiles(accept, false))[0] ?? null;
}

/** Asks for files from disk; empty when the user cancels. */
export function pickLocalFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, class: 'hidden', multiple });
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** `text` for matching: lower case, accents removed ("Été" → "ete"). */
export function searchKey(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A labelled <select>; `onChange` gets the chosen value. */
export function select(
  label: string,
  options: [value: string, text: string][],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const el = h('select', { 'aria-label': label });
  el.append(...options.map(([v, t]) => h('option', { value: v }, t)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "just now", "5 min ago", "yesterday", or the date for older times. */
export function formatRelative(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** One entry of a menu: an action, or a submenu with `items`. Null entries are skipped. */
export interface MenuItem {
  label: string;
  action?: () => void;
  items?: (MenuItem | null)[];
  danger?: boolean;
  disabled?: boolean;
}

/** The menus open right now, outermost first. */
const openMenus: { el: HTMLElement; anchor: HTMLElement }[] = [];

function closeMenusFrom(depth: number, refocus: boolean): void {
  const closing = openMenus.splice(depth);
  for (const menu of closing.reverse()) {
    menu.el.remove();
    menu.anchor.setAttribute('aria-expanded', 'false');
  }
  if (refocus) closing[closing.length - 1]?.anchor.focus();
}

/** Closes every open menu. */
export function closeMenus(): void {
  closeMenusFrom(0, false);
}

let menuListeners = false;

/** Outside clicks and resizes close the menus; installed with the first menu. */
function listenForMenuDismissal(): void {
  if (menuListeners) return;
  menuListeners = true;
  document.addEventListener('pointerdown', (event) => {
    if (openMenus.length === 0) return;
    const target = event.target instanceof Node ? event.target : null;
    if (target && openMenus.some((m) => m.el.contains(target) || m.anchor.contains(target))) return;
    closeMenus();
  }, { capture: true });
  window.addEventListener('resize', () => closeMenus());
}

/**
 * Opens a menu of `items` next to `anchor` (below it, or to its right for a
 * submenu). Arrow keys move, Enter/Space activate, Escape closes, → opens a
 * submenu and ← closes it.
 */
function openMenu(anchor: HTMLElement, items: (MenuItem | null)[], depth: number, label: string): void {
  listenForMenuDismissal();
  closeMenusFrom(depth, false);
  const el = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (!item) continue;
    const submenu = item.items;
    const entry = h('button', {
      type: 'button',
      role: 'menuitem',
      tabindex: '-1',
      class: item.danger ? 'danger-link' : '',
      'aria-haspopup': submenu ? 'menu' : false,
      'aria-expanded': submenu ? 'false' : false,
    }, h('span', {}, item.label), submenu ? h('span', { class: 'menu-arrow', 'aria-hidden': 'true' }, '▸') : null);
    entry.disabled = item.disabled === true;
    const activate = (): void => {
      if (submenu) {
        openMenu(entry, submenu, depth + 1, item.label);
        return;
      }
      closeMenus();
      item.action?.();
    };
    entry.addEventListener('click', activate);
    entry.addEventListener('keydown', (event) => {
      if (submenu && event.key === 'ArrowRight') {
        event.preventDefault();
        activate();
      }
    });
    buttons.push(entry);
    el.append(entry);
  }
  el.addEventListener('keydown', (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number): void => {
      event.preventDefault();
      enabled[(to + enabled.length) % enabled.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(enabled.length - 1);
    else if (event.key === 'Escape' || (event.key === 'ArrowLeft' && depth > 0)) {
      event.preventDefault();
      event.stopPropagation();
      closeMenusFrom(depth, true);
    } else if (event.key === 'Tab') {
      closeMenus();
    }
  });
  document.body.append(el);
  openMenus.push({ el, anchor });
  anchor.setAttribute('aria-expanded', 'true');
  // Fixed position next to the anchor, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = depth > 0 ? rect.right + 2 : rect.right - width;
  let top = depth > 0 ? rect.top - 4 : rect.bottom + 4;
  if (depth > 0 && left + width > window.innerWidth - 8) left = rect.left - width - 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  if (top + height > window.innerHeight - 8) top = Math.max(8, (depth > 0 ? rect.bottom : rect.top - 4) - height);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  buttons.find((b) => !b.disabled)?.focus();
}

/** A button opening a keyboard-accessible menu; `items` is called on each open. */
export function menuButton(
  content: Child | Child[],
  label: string,
  items: () => (MenuItem | null)[],
  className = '',
): HTMLButtonElement {
  const el = h('button', { type: 'button', class: className, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label },
    ...(Array.isArray(content) ? content : [content]));
  const open = (): void => {
    const already = openMenus.findIndex((m) => m.anchor === el);
    if (already >= 0) {
      closeMenusFrom(already, false);
      return;
    }
    openMenu(el, items(), 0, label);
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!openMenus.some((m) => m.anchor === el)) open();
    }
  });
  return el;
}
