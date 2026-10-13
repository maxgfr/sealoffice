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
 * Escape and the browser's cancel resolve to `cancelValue`.
 */
export function modal<T>(
  title: string,
  build: (close: (value: T) => void, body: HTMLElement) => void,
  cancelValue: T,
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
      close(cancelValue);
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
    const el = h(
      'form',
      { class: 'form', novalidate: true },
      options.text ? h('p', {}, options.text) : null,
      ...inputs.map((i) => i.row),
      error,
      h('div', { class: 'actions' }, button('Cancel', () => close(null)), submit),
    );
    el.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(inputs.map(({ field, input }) => [field.name, input.value]));
      submit.disabled = true;
      error.textContent = '';
      Promise.resolve(options.validate?.(values) ?? null)
        .then((message) => {
          if (message) {
            error.textContent = message;
          } else {
            close(values);
          }
        })
        .catch((e: unknown) => {
          error.textContent = errorMessage(e);
        })
        .finally(() => {
          submit.disabled = false;
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
export function pickLocalFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, class: 'hidden' });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
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
