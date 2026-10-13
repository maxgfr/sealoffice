// SPDX-License-Identifier: AGPL-3.0-only
// Inline SVG icons, built node by node (the CSP's Trusted Types forbid markup
// strings). File icons are a generic coloured page with the format's label.
import { extension } from './importer';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string>, ...children: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

/** The family a file name belongs to, for colour and label. */
export type FileFamily = 'docx' | 'xlsx' | 'pptx' | 'other';

export function fileFamily(name: string): FileFamily {
  const ext = extension(name);
  if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) return 'docx';
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'csv'].includes(ext)) return 'xlsx';
  if (['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(ext)) return 'pptx';
  return 'other';
}

/** A page with a folded corner, coloured by family, labelled DOCX / XLSX / PPTX. */
export function fileIcon(nameOrFamily: string, size = 40): SVGElement {
  const family: FileFamily = ['docx', 'xlsx', 'pptx', 'other'].includes(nameOrFamily)
    ? (nameOrFamily as FileFamily)
    : fileFamily(nameOrFamily);
  const label = family === 'other' ? (extension(nameOrFamily).toUpperCase().slice(0, 4) || 'FILE') : family.toUpperCase();
  return svg('svg', {
    class: `file-icon ${family}`,
    viewBox: '0 0 40 48',
    width: String(size),
    height: String(Math.round(size * 1.2)),
    'aria-hidden': 'true',
    focusable: 'false',
  },
  svg('path', { class: 'file-page', d: 'M4 2h22l10 10v32a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z' }),
  svg('path', { class: 'file-fold', d: 'M26 2v8a2 2 0 0 0 2 2h8z' }),
  svg('rect', { class: 'file-band', x: '2', y: '27', width: '34', height: '12', rx: '1' }),
  textNode(label));
}

function textNode(label: string): SVGElement {
  const text = svg('text', { class: 'file-label', x: '19', y: '36.2', 'text-anchor': 'middle' });
  text.textContent = label;
  return text;
}

const PATHS: Record<string, string[]> = {
  back: ['M15 18l-6-6 6-6'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  list: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  open: ['M12 4v12', 'M7 9l5-5 5 5', 'M4 20h16'],
  plus: ['M12 5v14', 'M5 12h14'],
  share: ['M12 4v11', 'M8 8l4-4 4 4', 'M5 13v6h14v-6'],
  download: ['M12 4v11', 'M8 11l4 4 4-4', 'M5 19h14'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1L7 17', 'M17 7l2.1-2.1'],
};

/** A 24 × 24 stroke icon by name (see PATHS). */
export function icon(name: keyof typeof PATHS, size = 18): SVGElement {
  return svg('svg', {
    class: `icon icon-${name}`,
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': name === 'more' ? '3' : '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, ...(PATHS[name] ?? []).map((d) => svg('path', { d })));
}
