import { strFromU8, unzipSync } from 'fflate';
import type { OcrProvider } from './ocr';

export interface Cell {
  text: string;
  /** Offset into the page text. */
  start: number;
  end: number;
  x: number;
}

export interface Line {
  text: string;
  start: number;
  end: number;
  /** [x, y, width, height] in PDF points from the bottom-left, when known. */
  bbox: [number, number, number, number] | null;
  cells: Cell[];
}

export interface ParsedPage {
  page_no: number;
  text: string;
  lines: Line[];
  width: number | null;
  height: number | null;
  ocr: boolean;
  ocr_confidence: number | null;
  /** True when the page has no extractable text and no OCR was available. */
  needs_ocr: boolean;
}

export interface ParsedTable {
  page_no: number;
  header: string[];
  rows: { cells: string[]; start: number; end: number }[];
}

export interface ParsedDocument {
  parser: string;
  parser_version: string;
  pages: ParsedPage[];
  tables: ParsedTable[];
  metadata: Record<string, unknown>;
}

const CELL_GAP = 9;

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Assembles positioned text items into lines and cells and records character offsets. */
export function buildPage(pageNo: number, items: Item[], size: { width: number | null; height: number | null }): ParsedPage {
  const visible = items.filter((i) => i.str.trim().length > 0);
  // group items into lines by baseline (top to bottom)
  const rows: Item[][] = [];
  for (const it of [...visible].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0]!.y - it.y) <= 2);
    if (row) row.push(it);
    else rows.push([it]);
  }
  let text = '';
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    // merge items into cells separated by visible gaps
    const groups: Item[][] = [];
    for (const it of row) {
      const g = groups[groups.length - 1];
      const prev = g?.[g.length - 1];
      if (g && prev && it.x - (prev.x + prev.w) < CELL_GAP) g.push(it);
      else groups.push([it]);
    }
    if (lines.length) text += '\n';
    const lineStart = text.length;
    const cells: Cell[] = [];
    groups.forEach((g, gi) => {
      if (gi > 0) text += '  ';
      const start = text.length;
      let cellText = '';
      g.forEach((it, ii) => {
        const prev = g[ii - 1];
        if (prev && it.x - (prev.x + prev.w) > 1 && !cellText.endsWith(' ') && !it.str.startsWith(' ')) cellText += ' ';
        cellText += it.str;
      });
      cellText = cellText.replace(/\s+/g, ' ').trim();
      text += cellText;
      cells.push({ text: cellText, start, end: text.length, x: g[0]!.x });
    });
    const minX = Math.min(...row.map((r) => r.x));
    const maxX = Math.max(...row.map((r) => r.x + r.w));
    const h = Math.max(...row.map((r) => r.h));
    lines.push({ text: text.slice(lineStart), start: lineStart, end: text.length, bbox: [minX, row[0]!.y, maxX - minX, h], cells });
  }
  return { page_no: pageNo, text, lines, ...size, ocr: false, ocr_confidence: null, needs_ocr: text.trim().length === 0 };
}

/** Splits plain text into pages (form feeds) and lines with offsets. */
export function textPages(raw: string, splitCells = false): ParsedPage[] {
  const pages = raw.replace(/\r\n?/g, '\n').split('\f');
  return pages.map((p, i) => {
    let offset = 0;
    const lines: Line[] = [];
    for (const l of p.split('\n')) {
      const start = offset;
      const cells: Cell[] = [];
      if (splitCells) {
        let cursor = start;
        for (const part of l.split(',')) {
          cells.push({ text: part.trim(), start: cursor, end: cursor + part.length, x: cells.length });
          cursor += part.length + 1;
        }
      }
      lines.push({ text: l, start, end: start + l.length, bbox: null, cells });
      offset += l.length + 1;
    }
    return { page_no: i + 1, text: p, lines, width: null, height: null, ocr: false, ocr_confidence: null, needs_ocr: false };
  });
}

/**
 * Finds tables: runs of two or more lines that have three or more cells whose
 * left edges line up with the header row.
 */
export function detectTables(pages: ParsedPage[]): ParsedTable[] {
  const tables: ParsedTable[] = [];
  for (const page of pages) {
    let i = 0;
    while (i < page.lines.length) {
      const header = page.lines[i]!;
      if (header.cells.length >= 3) {
        const rows: ParsedTable['rows'] = [];
        let j = i + 1;
        while (j < page.lines.length) {
          const row = page.lines[j]!;
          if (row.cells.length < 2) break;
          const aligned = row.cells.every((c) => header.cells.some((h) => Math.abs(h.x - c.x) <= 6));
          if (!aligned) break;
          // map cells onto header columns
          const cells = header.cells.map((h) => row.cells.find((c) => Math.abs(h.x - c.x) <= 6)?.text ?? '');
          rows.push({ cells, start: row.start, end: row.end });
          j++;
        }
        if (rows.length) {
          tables.push({ page_no: page.page_no, header: header.cells.map((c) => c.text), rows });
          i = j;
          continue;
        }
      }
      i++;
    }
  }
  return tables;
}

async function parsePdf(data: Buffer, ocr: OcrProvider | null): Promise<ParsedDocument> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const pages: ParsedPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Item[] = (content.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
      .filter((it) => typeof it.str === 'string' && it.transform)
      .map((it) => ({ str: it.str!, x: it.transform![4]!, y: it.transform![5]!, w: it.width ?? 0, h: it.height ?? 0 }));
    const built = buildPage(n, items, { width: viewport.width, height: viewport.height });
    if (built.needs_ocr && ocr) {
      const image = await ocr.renderPdfPage?.(data, n);
      if (image) {
        const r = await ocr.recognize(image);
        const p = textPages(r.text)[0]!;
        pages.push({ ...p, page_no: n, width: viewport.width, height: viewport.height, ocr: true, ocr_confidence: r.confidence, needs_ocr: false });
        continue;
      }
    }
    pages.push(built);
  }
  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  return {
    parser: 'pdfjs',
    parser_version: '1.0',
    pages,
    tables: detectTables(pages),
    metadata: { title: info.Title ?? null, producer: info.Producer ?? null, page_count: pdf.numPages },
  };
}

function parseDocx(data: Buffer): ParsedDocument {
  const files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === 'word/document.xml' });
  const xml = strFromU8(files['word/document.xml']!);
  const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>/g)]
      .map((t) => (t[0] === '<w:tab/>' ? '\t' : decodeXml(t[1] ?? '')))
      .join(''),
  );
  const pages = textPages(paragraphs.join('\n'));
  return { parser: 'docx-xml', parser_version: '1.0', pages, tables: [], metadata: { paragraphs: paragraphs.length } };
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function parseDocument(data: Buffer, mime: string, ocr: OcrProvider | null): Promise<ParsedDocument> {
  switch (mime) {
    case 'application/pdf':
      return parsePdf(data, ocr);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return parseDocx(data);
    case 'text/plain':
      return { parser: 'text', parser_version: '1.0', pages: textPages(data.toString('utf8')), tables: [], metadata: {} };
    case 'text/csv': {
      const pages = textPages(data.toString('utf8'), true);
      const lines = pages[0]!.lines.filter((l) => l.text.trim());
      const [head, ...rest] = lines;
      const tables: ParsedTable[] = head
        ? [{ page_no: 1, header: head.cells.map((c) => c.text), rows: rest.map((l) => ({ cells: l.cells.map((c) => c.text), start: l.start, end: l.end })) }]
        : [];
      return { parser: 'csv', parser_version: '1.0', pages, tables, metadata: { rows: rest.length } };
    }
    case 'image/png':
    case 'image/jpeg': {
      if (!ocr) {
        return {
          parser: 'image',
          parser_version: '1.0',
          pages: [{ page_no: 1, text: '', lines: [], width: null, height: null, ocr: false, ocr_confidence: null, needs_ocr: true }],
          tables: [],
          metadata: {},
        };
      }
      const r = await ocr.recognize(data);
      const page = textPages(r.text)[0]!;
      return {
        parser: `ocr:${ocr.name}`,
        parser_version: ocr.version,
        pages: [{ ...page, ocr: true, ocr_confidence: r.confidence }],
        tables: [],
        metadata: {},
      };
    }
    default:
      throw new Error(`no parser for ${mime}`);
  }
}
