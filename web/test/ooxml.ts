// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Word, Excel and PowerPoint packages built in-test, each holding `text`.

const enc = new TextEncoder();

/** A zip of stored (uncompressed) entries: all an OOXML reader needs. */
export function zip(files: Record<string, string>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = enc.encode(name);
    const data = enc.encode(text);
    const crc = Bun.hash.crc32(data);
    const header = (size: number, sig: number) => {
      const b = new DataView(new ArrayBuffer(size));
      b.setUint32(0, sig, true);
      return b;
    };
    const lh = header(30, 0x04034b50);
    lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, path.length, true);
    const ch = header(46, 0x02014b50);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, path.length, true);
    ch.setUint32(42, offset, true);
    local.push(new Uint8Array(lh.buffer), path, data);
    central.push(new Uint8Array(ch.buffer), path);
    offset += 30 + path.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

const contentTypes = (overrides: Record<string, string>) =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  Object.entries(overrides).map(([part, type]) => `<Override PartName="/${part}" ContentType="${CT}.${type}"/>`).join('') +
  '</Types>';

const rels = (entries: [id: string, type: string, target: string][]) =>
  `${XML}<Relationships xmlns="${PKG_REL}">` +
  entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${DOC_REL}/${type}" Target="${target}"/>`).join('') +
  '</Relationships>';

export function minimalDocx(text: string): Uint8Array {
  return zip({
    '[Content_Types].xml': contentTypes({ 'word/document.xml': 'wordprocessingml.document.main+xml' }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml':
      `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

export function minimalXlsx(text: string): Uint8Array {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip({
    '[Content_Types].xml': contentTypes({
      'xl/workbook.xml': 'spreadsheetml.sheet.main+xml',
      'xl/worksheets/sheet1.xml': 'spreadsheetml.worksheet+xml',
    }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml':
      `${XML}<workbook xmlns="${main}" xmlns:r="${DOC_REL}">` +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']]),
    'xl/worksheets/sheet1.xml':
      `${XML}<worksheet xmlns="${main}"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><v>42</v></c></row>` +
      '</sheetData></worksheet>',
  });
}

export function minimalPptx(text: string): Uint8Array {
  const ns =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:r="${DOC_REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const tree = (shapes: string) =>
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `${shapes}</p:spTree></p:cSld>`;
  const textBox =
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return zip({
    '[Content_Types].xml': contentTypes({
      'ppt/presentation.xml': 'presentationml.presentation.main+xml',
      'ppt/slides/slide1.xml': 'presentationml.slide+xml',
      'ppt/slideLayouts/slideLayout1.xml': 'presentationml.slideLayout+xml',
      'ppt/slideMasters/slideMaster1.xml': 'presentationml.slideMaster+xml',
    }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml':
      `${XML}<p:presentation ${ns}>` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
    ]),
    'ppt/slideMasters/slideMaster1.xml':
      `${XML}<p:sldMaster ${ns}>${tree('')}` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
      'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `${XML}<p:sldLayout ${ns}>${tree('')}</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': `${XML}<p:sld ${ns}>${tree(textBox)}</p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  });
}
