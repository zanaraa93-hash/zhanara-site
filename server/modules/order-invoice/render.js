const brand = require("../../core/pdf/brand");
const { PAGE, renderPdf } = require("../../core/pdf/document");
const { fitText, fitParagraphs } = require("../../core/pdf/text");

const C = brand.colors;
const M = 40;
const W = PAGE.width - M * 2;
const FOOTER_Y = PAGE.height - M - 6;
const BOTTOM = FOOTER_Y - 16;
const PAD_X = 6;
const PAD_Y = 7;
const HEADER_ROW_H = 24;
const MIN_AMOUNT_SIZE = 6.5;

const COLUMNS = [
  { key: "n", label: "№", width: 28, align: "center" },
  { key: "title", label: "Наименование", width: W - 28 - 54 - 102 - 112, align: "left" },
  { key: "qty", label: "Кол-во", width: 54, align: "center" },
  { key: "price", label: "Цена", width: 102, align: "right" },
  { key: "sum", label: "Сумма", width: 112, align: "right" },
];

function columnX(key) {
  let x = M;
  for (const column of COLUMNS) {
    if (column.key === key) return x;
    x += column.width;
  }
  return x;
}

// Shrinks a one-line value (an amount) until it fits; past the minimum size it wraps.
function fitSize(doc, text, size, width) {
  doc.fontSize(size);
  while (size > MIN_AMOUNT_SIZE && doc.widthOfString(text) > width) {
    size -= 0.5;
    doc.fontSize(size);
  }
  return size;
}

function measureRow(doc, row) {
  const cells = {};
  const titleW = COLUMNS[1].width - PAD_X * 2;
  doc.font("sans-bold").fontSize(9.5);
  const title = row.title || "—";
  const titleH = doc.heightOfString(title, { width: titleW });
  doc.font("sans").fontSize(7.5);
  const typeH = doc.heightOfString(row.type, { width: titleW });
  cells.title = { text: title, height: titleH + 2 + typeH };

  for (const column of COLUMNS) {
    if (column.key === "title") continue;
    const width = column.width - PAD_X * 2;
    const font = column.key === "sum" ? "sans-bold" : "sans";
    doc.font(font);
    const size = fitSize(doc, row[column.key], 9.5, width);
    cells[column.key] = { text: row[column.key], font, size, height: doc.heightOfString(row[column.key], { width }) };
  }
  const height = Math.max(...Object.values(cells).map((cell) => cell.height)) + PAD_Y * 2;
  return { cells, height, type: row.type };
}

function drawTableHeader(doc, y) {
  doc.rect(M, y, W, HEADER_ROW_H).fill(C.night);
  doc.font("sans-bold").fontSize(7.5).fillColor(C.gold);
  for (const column of COLUMNS) {
    doc.text(column.label.toUpperCase(), columnX(column.key) + PAD_X, y + 8, {
      width: column.width - PAD_X * 2,
      align: column.align,
      lineBreak: false,
      characterSpacing: 0.8,
    });
  }
  return y + HEADER_ROW_H;
}

function drawRow(doc, measured, y, shaded) {
  if (shaded) doc.rect(M, y, W, measured.height).fill(C.photo);
  doc.moveTo(M, y + measured.height).lineTo(M + W, y + measured.height).lineWidth(0.5).stroke(C.line);

  const titleX = columnX("title") + PAD_X;
  const titleW = COLUMNS[1].width - PAD_X * 2;
  doc.font("sans-bold").fontSize(9.5).fillColor(C.ink);
  doc.text(measured.cells.title.text, titleX, y + PAD_Y, { width: titleW });
  doc.font("sans").fontSize(7.5).fillColor(C.muted);
  doc.text(measured.type, titleX, doc.y + 2, { width: titleW });

  for (const column of COLUMNS) {
    if (column.key === "title") continue;
    const cell = measured.cells[column.key];
    doc.font(cell.font).fontSize(cell.size).fillColor(column.key === "sum" ? C.ink : C.text);
    doc.text(cell.text, columnX(column.key) + PAD_X, y + PAD_Y, { width: column.width - PAD_X * 2, align: column.align });
  }
  return y + measured.height;
}

function drawMonogram(doc, x, y, size) {
  doc.save();
  doc.roundedRect(x, y, size, size, size * 0.2).lineWidth(0.8).fillAndStroke(C.night, C.gold);
  doc.restore();
  doc.font("serif").fontSize(size * 0.62).fillColor(C.gold);
  doc.text("Ж", x, y + (size - doc.currentLineHeight()) / 2 + 1, { width: size, align: "center", lineBreak: false });
}

function drawFirstHeader(doc, invoice) {
  drawMonogram(doc, M, M, 44);
  doc.font("serif").fontSize(26).fillColor(C.ink);
  doc.text(brand.name, M + 56, M - 2, { lineBreak: false });
  doc.font("sans-bold").fontSize(7.5).fillColor(C.goldDeep);
  doc.text(brand.tagline.toUpperCase(), M + 57, M + 30, { lineBreak: false, characterSpacing: 2.4 });

  const rightW = 240;
  const rightX = M + W - rightW;
  doc.font("sans-bold").fontSize(17).fillColor(C.ink);
  doc.text("СЧЁТ-ФАКТУРА", rightX, M, { width: rightW, align: "right", lineBreak: false, characterSpacing: 1.2 });
  doc.font("sans").fontSize(9.5).fillColor(C.text);
  doc.text(`№ ${invoice.number}`, rightX, M + 25, { width: rightW, align: "right", lineBreak: false });
  if (invoice.date) {
    doc.text(`от ${invoice.date}`, rightX, M + 38, { width: rightW, align: "right", lineBreak: false });
  }
  const lineY = M + 62;
  doc.moveTo(M, lineY).lineTo(M + W, lineY).lineWidth(1).stroke(C.gold);
  return lineY + 18;
}

function drawContinuationHeader(doc, invoice) {
  doc.font("sans-bold").fontSize(8).fillColor(C.ink);
  doc.text(`${brand.name.toUpperCase()} · ${brand.tagline.toUpperCase()}`, M, M, { lineBreak: false, characterSpacing: 1.6 });
  doc.font("sans").fontSize(8).fillColor(C.muted);
  doc.text(`Счёт-фактура № ${invoice.number}${invoice.date ? ` от ${invoice.date}` : ""}`, M, M, {
    width: W,
    align: "right",
    lineBreak: false,
  });
  doc.moveTo(M, M + 17).lineTo(M + W, M + 17).lineWidth(0.8).stroke(C.gold);
  return M + 32;
}

function blockLabel(doc, text, x, y, width) {
  doc.font("sans-bold").fontSize(7.5).fillColor(C.goldDeep);
  doc.text(text.toUpperCase(), x, y, { width, lineBreak: false, characterSpacing: 1.4 });
  return y + 15;
}

function drawParties(doc, invoice, y) {
  const colW = (W - 24) / 2;
  let left = y;
  let right = y;
  const { name, phone } = invoice.client;
  if (name || phone) {
    left = blockLabel(doc, "Клиент", M, left, colW);
    if (name) {
      doc.font("serif").fontSize(15).fillColor(C.ink);
      doc.text(name, M, left, { width: colW });
      left = doc.y + 2;
    }
    if (phone) {
      doc.font("sans").fontSize(9.5).fillColor(C.text);
      doc.text(`Телефон: ${phone}`, M, left, { width: colW });
      left = doc.y;
    }
  }

  const rightX = M + colW + 24;
  const facts = [
    invoice.date && ["Дата заказа", invoice.date],
    invoice.status && ["Статус заказа", invoice.status],
  ].filter(Boolean);
  if (facts.length) {
    right = blockLabel(doc, "Заказ", rightX, right, colW);
    for (const [label, value] of facts) {
      doc.font("sans").fontSize(9.5).fillColor(C.muted);
      doc.text(`${label}: `, rightX, right, { width: colW, continued: true });
      doc.fillColor(C.text).text(value);
      right = doc.y + 1;
    }
  }
  return Math.max(left, right) + 20;
}

function measureTotals(doc, invoice) {
  return 16 + Math.max(1, invoice.totals.length) * 22 + (invoice.hasPriceOnRequest ? 18 : 0);
}

function drawTotals(doc, invoice, y) {
  const boxW = 250;
  const boxX = M + W - boxW;
  const lines = invoice.totals.length ? invoice.totals : [{ label: "Итого", amount: "по запросу" }];
  const boxH = 12 + lines.length * 22;
  doc.save();
  doc.roundedRect(boxX, y, boxW, boxH, 6).fill(C.night);
  doc.restore();
  let lineY = y + 9;
  for (const line of lines) {
    doc.font("sans").fontSize(9.5).fillColor(C.creamMuted);
    doc.text(`${line.label}:`, boxX + 14, lineY + 3, { width: 100, lineBreak: false });
    doc.font("sans-bold");
    const size = fitSize(doc, line.amount, 13, boxW - 130);
    doc.fontSize(size).fillColor(C.goldLight);
    doc.text(line.amount, boxX + 114, lineY + (13 - size) / 2 + 1, { width: boxW - 128, align: "right", lineBreak: false });
    lineY += 22;
  }
  let bottom = y + boxH;
  if (invoice.hasPriceOnRequest) {
    doc.font("sans").fontSize(8).fillColor(C.muted);
    doc.text("Позиции с ценой «по запросу» в итог не включены.", M, bottom + 6, { width: W, align: "right" });
    bottom = doc.y;
  }
  return bottom + 16;
}

function detailBlocks(invoice) {
  const { task, deadline, reference } = invoice.details;
  return [
    task && { label: "Задача", text: fitParagraphs(task, "sans") },
    deadline && { label: "Когда нужно", text: deadline },
    reference && { label: "Референс", text: fitText(reference, "sans") },
  ].filter((block) => block && block.text);
}

function measureDetail(doc, block) {
  doc.font("sans").fontSize(9.5);
  return 15 + doc.heightOfString(block.text, { width: W, lineGap: 1.5 }) + 10;
}

function drawFooters(doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    doc.moveTo(M, FOOTER_Y - 8).lineTo(M + W, FOOTER_Y - 8).lineWidth(0.5).stroke(C.line);
    doc.font("sans").fontSize(7.5).fillColor(C.muted);
    doc.text(`${brand.name} · ${brand.contacts.join(" · ")}`, M, FOOTER_Y, { width: W - 70, lineBreak: false });
    doc.text(`стр. ${i - start + 1} из ${count}`, M, FOOTER_Y, { width: W, align: "right", lineBreak: false });
  }
}

// job: { invoice } built by model.js from the stored order.
function render({ invoice, generatedAt }) {
  const safe = {
    ...invoice,
    client: { name: fitText(invoice.client.name, "serif"), phone: fitText(invoice.client.phone, "sans") },
    rows: invoice.rows.map((row) => ({ ...row, title: fitText(row.title, "sans-bold") })),
  };

  return renderPdf(
    { title: `Счёт-фактура № ${safe.number} — ${brand.name}`, subject: "Счёт-фактура по заказу", creationDate: generatedAt },
    (doc) => {
      let y = drawFirstHeader(doc, safe);
      y = drawParties(doc, safe, y);

      const newPage = () => {
        doc.addPage({ size: "A4", margin: 0 });
        return drawContinuationHeader(doc, safe);
      };

      y = drawTableHeader(doc, y);
      safe.rows.forEach((row, index) => {
        const measured = measureRow(doc, row);
        if (y + measured.height > BOTTOM) y = drawTableHeader(doc, newPage());
        y = drawRow(doc, measured, y, index % 2 === 1);
      });

      y += 14;
      if (y + measureTotals(doc, safe) > BOTTOM) y = newPage();
      y = drawTotals(doc, safe, y);

      const blocks = detailBlocks(safe);
      if (blocks.length) {
        if (y + 30 + measureDetail(doc, blocks[0]) > BOTTOM) y = newPage();
        doc.font("serif").fontSize(15).fillColor(C.ink);
        doc.text("Детали заказа", M, y, { lineBreak: false });
        y += 26;
        for (const block of blocks) {
          if (y + measureDetail(doc, block) > BOTTOM) y = newPage();
          y = blockLabel(doc, block.label, M, y, W);
          doc.font("sans").fontSize(9.5).fillColor(C.text);
          doc.text(block.text, M, y, { width: W, lineGap: 1.5 });
          y = doc.y + 10;
        }
      }

      drawFooters(doc);
    }
  );
}

module.exports = { render };
