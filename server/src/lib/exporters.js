import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

// ── Excel ────────────────────────────────────────────────────────────────────
// sheets: [{ name, aoa }] where aoa is an array-of-arrays (rows of cells).
//
// Built with exceljs. SheetJS (xlsx@0.18.5) carried two unfixable high-severity
// advisories — prototype pollution and a ReDoS — with no patched release. The
// output is unchanged: the same rows, in the same order, one sheet per entry.

// Excel rejects these characters in a sheet name, and caps it at 31 chars.
function sheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`).replace(/[*?:\\/[\]]/g, '-').slice(0, 31);
  return cleaned.trim() || `Sheet${index + 1}`;
}

export async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Audix Solutions & Co.';
  wb.created = new Date();
  sheets.forEach(({ name, aoa }, i) => {
    const ws = wb.addWorksheet(sheetName(name, i));
    // A null or undefined cell must stay blank, not become the text "null".
    ws.addRows((aoa || []).map((row) => row.map((cell) => (cell == null ? '' : cell))));
  });
  // Node returns a Buffer here; res.send() takes it directly.
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// blocks: [{ title, columns:[...], rows:[[...]], note? }]
// Fixed-column table layout using absolute cell positioning. Kept deliberately
// simple (no underline / manual strokes) so coordinates never go NaN.
export function buildPdf({ title, subtitle, blocks, banner }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;

    doc.fontSize(16).font('Helvetica-Bold').text('Audix Solutions & Co.');
    doc.fontSize(13).font('Helvetica').text(title);
    if (subtitle) doc.fontSize(9).fillColor('#555').text(subtitle).fillColor('#000');
    // PROVISIONAL stamp — a variance export from an open audit must carry it.
    if (banner) {
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#b45309').text(banner);
      doc.fillColor('#000').font('Helvetica');
    }
    doc.moveDown(0.5);

    for (const block of blocks) {
      const cols = block.columns;
      // normalise widths to sum to content width
      const raw = block.widths || cols.map(() => contentW / cols.length);
      const sum = raw.reduce((a, b) => a + b, 0) || 1;
      const widths = raw.map((w) => (w / sum) * contentW);

      if (doc.y + 40 > bottom) doc.addPage();
      doc.moveDown(0.4).fontSize(11).font('Helvetica-Bold').text(block.title);
      doc.moveDown(0.2);

      const drawRow = (cells, bold) => {
        doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        const y = doc.y;
        let maxH = 0;
        cells.forEach((cell, i) => {
          maxH = Math.max(maxH, doc.heightOfString(String(cell ?? ''), { width: widths[i] - 4 }));
        });
        if (y + maxH > bottom) { doc.addPage(); }
        const rowY = doc.y;
        let x = left;
        cells.forEach((cell, i) => {
          doc.text(String(cell ?? ''), x + 2, rowY, { width: widths[i] - 4 });
          x += widths[i];
        });
        doc.y = rowY + maxH + 3;
      };

      drawRow(cols, true);
      for (const r of block.rows) drawRow(r, false);
      if (!block.rows.length) { doc.fontSize(8).font('Helvetica-Oblique').fillColor('#888').text('  (none)').fillColor('#000'); }
      if (block.note) doc.moveDown(0.3).fontSize(7).font('Helvetica-Oblique').fillColor('#666').text(block.note).fillColor('#000').font('Helvetica');
    }
    doc.end();
  });
}
