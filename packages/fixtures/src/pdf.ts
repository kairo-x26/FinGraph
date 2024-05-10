import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'field'; label: string; value: string }
  | { kind: 'table'; columns: string[]; rows: string[][]; widths?: number[] }
  | { kind: 'spacer' }
  | { kind: 'pagebreak' };

const PAGE = { width: 612, height: 792, margin: 56 };

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Renders simple text blocks to a real, text-extractable PDF. */
export async function renderPdf(blocks: Block[], meta: { title: string; author?: string; created?: Date }) {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setAuthor(meta.author ?? 'FinGraph fixtures');
  doc.setProducer('FinGraph fixtures');
  doc.setCreationDate(meta.created ?? new Date());
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.14);

  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const contentWidth = PAGE.width - PAGE.margin * 2;
  const ensure = (h: number) => {
    if (y - h < PAGE.margin) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - PAGE.margin;
    }
  };
  const line = (text: string, font: PDFFont, size: number, x = PAGE.margin) => {
    ensure(size + 4);
    page.drawText(text, { x, y: y - size, size, font, color: ink });
    y -= size + 4;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'title':
        for (const l of wrap(b.text, bold, 16, contentWidth)) line(l, bold, 16);
        y -= 8;
        break;
      case 'heading':
        y -= 6;
        for (const l of wrap(b.text, bold, 12, contentWidth)) line(l, bold, 12);
        break;
      case 'para':
        for (const l of wrap(b.text, regular, 10, contentWidth)) line(l, regular, 10);
        y -= 4;
        break;
      case 'field': {
        const label = `${b.label}: `;
        const lw = bold.widthOfTextAtSize(label, 10);
        const lines = wrap(b.value, regular, 10, contentWidth - lw);
        ensure(14 * lines.length);
        page.drawText(label, { x: PAGE.margin, y: y - 10, size: 10, font: bold, color: ink });
        lines.forEach((l, i) => page.drawText(l, { x: PAGE.margin + lw, y: y - 10 - i * 14, size: 10, font: regular, color: ink }));
        y -= 14 * lines.length;
        break;
      }
      case 'table': {
        const widths = b.widths ?? b.columns.map(() => contentWidth / b.columns.length);
        const row = (cells: string[], font: PDFFont) => {
          ensure(14);
          let x = PAGE.margin;
          cells.forEach((c, i) => {
            page.drawText(c, { x, y: y - 9, size: 9, font, color: ink });
            x += widths[i]!;
          });
          y -= 14;
        };
        row(b.columns, bold);
        for (const r of b.rows) row(r, regular);
        y -= 6;
        break;
      }
      case 'spacer':
        y -= 12;
        break;
      case 'pagebreak':
        page = doc.addPage([PAGE.width, PAGE.height]);
        y = PAGE.height - PAGE.margin;
        break;
    }
  }
  return Buffer.from(await doc.save());
}
