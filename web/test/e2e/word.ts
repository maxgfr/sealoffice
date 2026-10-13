// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of Word's formatting and editing keys against the built dist/:
// a new document gets one paragraph per case, each case presses its shortcut the way
// a Mac user would (⌘ on a Mac, Ctrl elsewhere), and the saved word/document.xml is
// checked. Bold and italic are also checked on screen: the bold sample line must
// gain ink, the italic one must change. Run with `bun run test:e2e:word` after
// `scripts/build.sh`. SHOTS=<dir> saves screenshots; HEADED=1 shows the browser.
import type { Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Check, DIST, SHOTS, WORD, docxXml, downloadOriginal, editorShown, goHome, hasWebGpu, launch, readClipboard, serve, shot,
  typeInEditor, waitHome,
} from './lib';

const MAC = process.platform === 'darwin';
/** Word moves by word with ⌥ on a Mac, Ctrl elsewhere. */
const WORD_MOD = MAC ? 'Alt' : 'Control';
const M = 'ControlOrMeta';
const SAMPLE = 'Rendering sample: the quick brown fox jumps over the lazy dog';

interface Para {
  xml: string;
  text: string;
  /** Paragraph properties. */
  ppr: string;
  /** Properties of each run that holds text. */
  runs: string[];
}

function paragraphs(xml: string): Para[] {
  return (xml.match(/<w:p(?=[ >])[\s\S]*?<\/w:p>/g) ?? []).map((p) => {
    const runs = (p.match(/<w:r(?=[ >])[\s\S]*?<\/w:r>/g) ?? []).filter((r) => /<w:t[ >]/.test(r));
    return {
      xml: p,
      text: [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
      ppr: /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? '',
      runs: runs.map((r) => /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(r)?.[0] ?? ''),
    };
  });
}

const on = (tag: string): RegExp => new RegExp(`<w:${tag}(?: w:val="(?:1|true|on)")?/>`);
const BOLD = on('b');
const ITALIC = on('i');
const every = (p: Para | undefined, re: RegExp): boolean => !!p && p.runs.length > 0 && p.runs.every((r) => re.test(r));
const none = (p: Para | undefined, re: RegExp): boolean => !!p && p.runs.length > 0 && !p.runs.some((r) => re.test(r));
/** Half-points of each text run: its own w:sz, else the document default. */
const sizes = (p: Para | undefined, base: number): number[] =>
  p?.runs.map((r) => Number(/<w:sz w:val="(\d+)"\/>/.exec(r)?.[1] ?? base)) ?? [];
const jc = (p: Para | undefined): string => /<w:jc w:val="([^"]+)"\/>/.exec(p?.ppr ?? '')?.[1] ?? '';

interface Doc {
  paras: Para[];
  /** Default run size, in half-points. */
  base: number;
  /** The paragraph whose text starts with `marker`. */
  get(marker: string): Para | undefined;
  /** Whether case `name` passed. */
  passed(name: string): boolean;
}

interface Case {
  name: string;
  /** Typed as is; `\n` makes a paragraph. Each line starts with its marker. */
  text: string;
  /** Run with the caret at the end of the case's last line. */
  act?: (page: Page) => Promise<void>;
  check: (doc: Doc) => [boolean, string];
}

const press = async (page: Page, ...keys: string[]): Promise<void> => {
  for (const key of keys) await page.keyboard.press(key);
};
/** The case's last line selected, then `keys`. */
const onLine = (...keys: string[]) => (page: Page): Promise<void> => press(page, 'End', 'Shift+Home', ...keys);
/** The editor writes the clipboard asynchronously (navigator.clipboard.writeText): give it a moment, as a person would. */
const clipboardSettles = (page: Page): Promise<void> => page.waitForTimeout(300);
const describe = (p: Para | undefined): string => (p ? `${JSON.stringify(p.text)} ${p.runs.join('')}${p.ppr}` : 'missing');

const CASES: Case[] = [
  { name: 'bold', text: 'p01 bold', act: onLine(`${M}+KeyB`), check: (d) => [every(d.get('p01'), BOLD), `⌘B writes <w:b/> (${describe(d.get('p01'))})`] },
  { name: 'italic', text: 'p02 italic', act: onLine(`${M}+KeyI`), check: (d) => [every(d.get('p02'), ITALIC), `⌘I writes <w:i/> (${describe(d.get('p02'))})`] },
  {
    name: 'underline', text: 'p03 underline', act: onLine(`${M}+KeyU`),
    check: (d) => [every(d.get('p03'), /<w:u w:val="single"\/>/), `⌘U writes <w:u w:val="single"/> (${describe(d.get('p03'))})`],
  },
  {
    name: 'superscript', text: 'p04 superscript', act: onLine(`${M}+Shift+Equal`),
    check: (d) => [every(d.get('p04'), /<w:vertAlign w:val="superscript"\/>/), `⌘⇧= writes superscript (${describe(d.get('p04'))})`],
  },
  {
    name: 'subscript', text: 'p05 subscript', act: onLine(`${M}+Equal`),
    check: (d) => [every(d.get('p05'), /<w:vertAlign w:val="subscript"\/>/), `⌘= writes subscript (${describe(d.get('p05'))})`],
  },
  { name: 'caps', text: 'p06 caps', act: onLine(`${M}+Shift+KeyA`), check: (d) => [every(d.get('p06'), on('caps')), `⌘⇧A writes <w:caps/> (${describe(d.get('p06'))})`] },
  { name: 'center', text: 'p07 center', act: (p) => press(p, `${M}+KeyE`), check: (d) => [jc(d.get('p07')) === 'center', `⌘E centers (${describe(d.get('p07'))})`] },
  { name: 'right', text: 'p08 right', act: (p) => press(p, `${M}+KeyR`), check: (d) => [jc(d.get('p08')) === 'right', `⌘R aligns right (${describe(d.get('p08'))})`] },
  { name: 'justify', text: 'p09 justify', act: (p) => press(p, `${M}+KeyJ`), check: (d) => [jc(d.get('p09')) === 'both', `⌘J justifies (${describe(d.get('p09'))})`] },
  {
    name: 'left', text: 'p10 left', act: (p) => press(p, `${M}+KeyE`, `${M}+KeyL`),
    check: (d) => [d.passed('center') && ['', 'left', 'start'].includes(jc(d.get('p10'))), `⌘L after ⌘E aligns left again (${describe(d.get('p10'))})`],
  },
  {
    name: 'grow', text: 'p11 grow', act: onLine(`${M}+Shift+Period`),
    check: (d) => {
      const s = sizes(d.get('p11'), d.base);
      return [s.length > 0 && s.every((v) => v > d.base), `⌘⇧> grows the font past ${d.base / 2} pt (${s.map((v) => v / 2).join(', ')} pt)`];
    },
  },
  {
    name: 'shrink', text: 'p12 shrink', act: onLine(`${M}+Shift+Comma`),
    check: (d) => {
      const s = sizes(d.get('p12'), d.base);
      return [s.length > 0 && s.every((v) => v < d.base), `⌘⇧< shrinks the font below ${d.base / 2} pt (${s.map((v) => v / 2).join(', ')} pt)`];
    },
  },
  {
    name: 'clear', text: 'p13 clear', act: onLine(`${M}+KeyB`, `${M}+KeyI`, `${M}+Backslash`),
    check: (d) => [d.passed('bold') && none(d.get('p13'), BOLD) && none(d.get('p13'), ITALIC), `⌘\\ clears bold and italic (${describe(d.get('p13'))})`],
  },
  {
    name: 'undo', text: 'p14 undo', act: onLine(`${M}+KeyB`, `${M}+KeyZ`),
    check: (d) => [d.passed('bold') && none(d.get('p14'), BOLD) && d.get('p14')?.text === 'p14 undo', `⌘Z undoes ⌘B (${describe(d.get('p14'))})`],
  },
  {
    name: 'redo', text: 'p15 redo', act: onLine(`${M}+KeyB`, `${M}+KeyZ`, `${M}+Shift+KeyZ`),
    check: (d) => [every(d.get('p15'), BOLD), `⌘⇧Z redoes ⌘B (${describe(d.get('p15'))})`],
  },
  {
    name: 'copy', text: 'p16 copy', act: async (p) => {
      await onLine(`${M}+KeyC`, 'End')(p);
      await clipboardSettles(p);
      await p.keyboard.type(' ');
      await press(p, `${M}+KeyV`);
    },
    check: (d) => [d.get('p16')?.text === 'p16 copy p16 copy', `⌘C then ⌘V copies the line (${describe(d.get('p16'))})`],
  },
  {
    name: 'cut', text: 'p17 cutme', act: async (p) => {
      await onLine(`${M}+KeyX`)(p);
      await clipboardSettles(p);
      await p.keyboard.type('p17 cut ');
      await press(p, `${M}+KeyV`);
    },
    check: (d) => [d.get('p17')?.text === 'p17 cut p17 cutme', `⌘X cuts the line, ⌘V pastes it back (${describe(d.get('p17'))})`],
  },
  {
    name: 'paragraph', text: 'p18 before\np18 after',
    check: (d) => [d.paras.some((p) => p.text === 'p18 before') && d.paras.some((p) => p.text === 'p18 after'), 'Enter starts a new paragraph'],
  },
  {
    name: 'word left', text: 'p19 alpha beta gamma', act: async (p) => {
      await press(p, 'End', `${WORD_MOD}+ArrowLeft`);
      await p.keyboard.type('X');
    },
    check: (d) => [d.get('p19')?.text === 'p19 alpha beta Xgamma', `${MAC ? '⌥←' : 'Ctrl+←'} moves back one word (${describe(d.get('p19'))})`],
  },
  {
    name: 'line start', text: 'p20 line start', act: async (p) => {
      await press(p, 'End', `${M}+ArrowLeft`);
      await p.keyboard.type('Y');
    },
    check: (d) => [d.get('Yp20')?.text === 'Yp20 line start', `${MAC ? '⌘←' : 'Ctrl+←'} goes to the line start (${describe(d.get('Yp20'))})`],
  },
];

/**
 * Ink of the first text line on the page in three screenshots: dark pixels in `a`
 * and `b`, and pixels whose darkness differs between `b` and `c`. The page is the
 * widest white run across the middle of the view; the line, the first band of rows
 * with dark pixels below the page's top edge.
 */
async function ink(page: Page, a: Buffer, b: Buffer, c: Buffer): Promise<{ band: number[]; darkA: number; darkB: number; changed: number }> {
  return page.evaluate(async (pngs) => {
    const decode = async (b64: string): Promise<ImageData> => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [ia, ib, ic] = (await Promise.all(pngs.map(decode))) as [ImageData, ImageData, ImageData];
    const { width, height } = ia;
    const lum = (img: ImageData, x: number, y: number): number => {
      const i = (y * width + x) * 4;
      return 0.299 * (img.data[i] ?? 0) + 0.587 * (img.data[i + 1] ?? 0) + 0.114 * (img.data[i + 2] ?? 0);
    };
    const white = (x: number, y: number): boolean => lum(ia, x, y) > 250;
    const dark = (img: ImageData, x: number, y: number): boolean => lum(img, x, y) < 160;
    const mid = Math.floor(height * 0.75);
    let best = [0, 0];
    for (let x = 0, start = -1; x <= width; x++) {
      if (x < width && white(x, mid)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start > best[1]! - best[0]!) best = [start, x];
        start = -1;
      }
    }
    const x0 = best[0]! + 4;
    const x1 = best[1]! - 4;
    let top = mid;
    while (top > 0 && white(x0, top - 1)) top--;
    const rowDark = (y: number): boolean => {
      for (let x = x0; x < x1; x++) if (dark(ia, x, y)) return true;
      return false;
    };
    let y0 = top;
    while (y0 < height && !rowDark(y0)) y0++;
    let y1 = y0;
    while (y1 < height && rowDark(y1)) y1++;
    y0 = Math.max(top, y0 - 2);
    y1 = Math.min(height, y1 + 2);
    let darkA = 0;
    let darkB = 0;
    let changed = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (dark(ia, x, y)) darkA++;
        if (dark(ib, x, y)) darkB++;
        if (dark(ib, x, y) !== dark(ic, x, y)) changed++;
      }
    }
    return { band: [x0, y0, x1, y1], darkA, darkB, changed };
  }, [a, b, c].map((png) => png.toString('base64')));
}

async function main(): Promise<number> {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`${DIST} has no build; run scripts/build.sh first`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const server = serve();
  const origin = `http://localhost:${server.port}`;
  const check = new Check();
  const pageErrors: string[] = [];
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`  console.error: ${m.text().slice(0, 200)}`);
    });
    await page.goto(`${origin}/`);
    const gpu = await hasWebGpu(page);
    check.ok(gpu, 'WebGPU adapter available');
    if (!gpu) return 1;
    console.log(`  keys: ${MAC ? 'Mac (⌘, ⌥)' : 'Ctrl'}`);

    await waitHome(page);
    await page.getByRole('button', { name: 'Word document', exact: true }).click();
    await editorShown(page);

    // On screen: the sample line, then the caret one line below it, out of the way.
    await typeInEditor(page, SAMPLE);
    await press(page, 'Enter');
    await page.keyboard.type('render caret line', { delay: 30 });
    const settle = (): Promise<void> => page.waitForTimeout(800);
    await settle();
    const before = await page.screenshot();
    await press(page, 'ArrowUp', 'End', 'Shift+Home', `${M}+KeyB`, 'ArrowDown');
    await settle();
    const bold = await page.screenshot();
    await press(page, 'ArrowUp', 'End', 'Shift+Home', `${M}+KeyI`, 'ArrowDown');
    await settle();
    const italic = await page.screenshot();
    await shot(page, 'word-01-render');
    const seen = await ink(page, before, bold, italic);
    console.log(`  sample line at ${seen.band.join(',')}`);
    check.ok(seen.darkA > 500 && seen.darkB >= seen.darkA * 1.1,
      `bold shows on screen: the sample line gains ink (${seen.darkA} → ${seen.darkB} dark px, ${((seen.darkB / Math.max(1, seen.darkA) - 1) * 100).toFixed(1)} %)`);
    check.ok(seen.changed > 0, `italic shows on screen: the sample line changes (${seen.changed} px)`);

    // One paragraph per case, typed first so no case inherits another's format,
    // then each case from the last one up.
    await press(page, 'End');
    for (const c of CASES) {
      for (const line of c.text.split('\n')) {
        await press(page, 'Enter');
        await page.keyboard.type(line, { delay: 20 });
      }
    }
    for (const c of [...CASES].reverse()) {
      if (c.act) {
        await c.act(page);
        await page.waitForTimeout(300);
      }
      for (let i = 0; i < c.text.split('\n').length; i++) await press(page, 'ArrowUp');
    }
    await shot(page, 'word-02-cases');

    // Select all and copy: the clipboard holds the whole document.
    await press(page, `${M}+KeyA`, `${M}+KeyC`);
    await page.waitForTimeout(300);
    const all = await readClipboard(page).catch((e) => `(clipboard: ${String(e)})`);
    check.ok(all.includes(SAMPLE) && all.includes('p01 bold') && all.includes('line start'),
      `⌘A then ⌘C copies the whole document (${JSON.stringify(all.slice(0, 80))}…)`);
    await press(page, 'ArrowDown');

    await goHome(page);
    const path = await downloadOriginal(page, WORD);
    const xml = docxXml(path);
    const styles = docxXml(path, 'word/styles.xml');
    const base = Number(/<w:docDefaults>[\s\S]*?<w:sz w:val="(\d+)"\/>/.exec(styles)?.[1] ?? 20);
    const paras = paragraphs(xml);
    const results = new Map<string, boolean>();
    const doc: Doc = {
      paras,
      base,
      get: (marker) => paras.find((p) => p.text.startsWith(marker)),
      passed: (name) => results.get(name) ?? false,
    };
    for (const c of CASES) {
      const [ok, what] = c.check(doc);
      results.set(c.name, ok);
      check.ok(ok, what);
    }
    check.ok(every(doc.get('Rendering'), BOLD) && every(doc.get('Rendering'), ITALIC), `the sample line is saved bold and italic (${describe(doc.get('Rendering'))})`);
    check.ok(pageErrors.length === 0, `no uncaught errors (${pageErrors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop(true);
  }
  if (check.failures.length > 0) {
    console.log(`word: ${check.failures.length} failure(s)`);
    return 1;
  }
  console.log('word: PASS');
  return 0;
}

process.exit(await main());
