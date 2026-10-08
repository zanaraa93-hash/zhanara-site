const brand = require("../../core/pdf/brand");
const { PAGE, renderPdf } = require("../../core/pdf/document");
const { PRICE_ON_REQUEST, formatPdfPrice, typeLabel } = require("../../core/pdf/format");
const { fitText } = require("../../core/pdf/text");

const C = brand.colors;
const PAGE_W = PAGE.width;
const PAGE_H = PAGE.height;
const MARGIN = 40;
const CONTENT_TOP = MARGIN + 34;
const CONTENT_BOTTOM = PAGE_H - MARGIN - 22;
const COLS = 2;
const ROWS = 2;
const GAP = 18;
const CARD_W = (PAGE_W - MARGIN * 2 - GAP * (COLS - 1)) / COLS;
const CARD_H = (CONTENT_BOTTOM - CONTENT_TOP - GAP * (ROWS - 1)) / ROWS;
const CARD_PAD = 12;
const PHOTO_H = 162;
const PER_PAGE = COLS * ROWS;

function centered(doc, text, y, { font, size, color, spacing = 0 }) {
  doc.font(font).fontSize(size).fillColor(color);
  // Character spacing is added after every glyph, including the last one.
  const width = doc.widthOfString(text, { characterSpacing: spacing }) - spacing;
  doc.text(text, (PAGE_W - width) / 2, y, { lineBreak: false, characterSpacing: spacing });
}

function drawCover(doc, { dateLabel, countLabel }) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.night);

  doc.save();
  doc.circle(PAGE_W * 0.86, PAGE_H * 0.1, 210).fillOpacity(0.07).fill(C.gold);
  doc.circle(PAGE_W * 0.08, PAGE_H * 0.92, 240).fillOpacity(0.06).fill(C.rose);
  doc.restore();

  doc.save();
  doc.roundedRect(28, 28, PAGE_W - 56, PAGE_H - 56, 14).lineWidth(0.8).strokeOpacity(0.4).stroke(C.gold);
  doc.restore();

  const mono = 72;
  const monoX = (PAGE_W - mono) / 2;
  const monoY = 236;
  doc.save();
  doc.roundedRect(monoX, monoY, mono, mono, 15).lineWidth(1).fillAndStroke(C.night2, C.gold);
  doc.restore();
  doc.font("serif").fontSize(46).fillColor(C.gold);
  doc.text("Ж", monoX, monoY + (mono - doc.currentLineHeight()) / 2 + 2, { width: mono, align: "center", lineBreak: false });

  centered(doc, brand.name, 338, { font: "serif", size: 62, color: C.cream });
  centered(doc, brand.tagline.toUpperCase(), 418, { font: "sans-bold", size: 10, color: C.gold, spacing: 5 });
  doc.moveTo(PAGE_W / 2 - 34, 450).lineTo(PAGE_W / 2 + 34, 450).lineWidth(0.8).stroke(C.gold);
  centered(doc, "Каталог товаров", 470, { font: "serif", size: 34, color: C.goldLight });
  centered(doc, `${dateLabel} · ${countLabel}`, 528, { font: "sans", size: 10.5, color: C.creamMuted });

  centered(doc, brand.contacts.join("   ·   "), PAGE_H - 86, { font: "sans", size: 8.5, color: C.creamMuted });
}

function drawPageHeader(doc, dateLabel) {
  doc.font("sans-bold").fontSize(8).fillColor(C.ink);
  doc.text(`${brand.name.toUpperCase()} · ${brand.tagline.toUpperCase()}`, MARGIN, MARGIN, {
    lineBreak: false,
    characterSpacing: 1.6,
  });
  doc.font("sans").fontSize(8).fillColor(C.muted);
  doc.text(`Каталог товаров · ${dateLabel}`, MARGIN, MARGIN, { width: PAGE_W - MARGIN * 2, align: "right", lineBreak: false });
  doc.moveTo(MARGIN, MARGIN + 17).lineTo(PAGE_W - MARGIN, MARGIN + 17).lineWidth(0.8).stroke(C.gold);
}

function drawPageFooter(doc, page, total) {
  const y = PAGE_H - MARGIN - 4;
  doc.moveTo(MARGIN, y - 8).lineTo(PAGE_W - MARGIN, y - 8).lineWidth(0.5).stroke(C.line);
  doc.font("sans").fontSize(7.5).fillColor(C.muted);
  doc.text(`${brand.name} · ${brand.tagline}`, MARGIN, y, { lineBreak: false });
  doc.text(`стр. ${page} из ${total}`, MARGIN, y, { width: PAGE_W - MARGIN * 2, align: "right", lineBreak: false });
}

function drawPlaceholder(doc, box) {
  doc.font("serif").fontSize(48).fillColor(C.placeholder);
  const lineH = doc.currentLineHeight();
  const top = box.y + (box.h - lineH - 16) / 2;
  doc.text("Ж", box.x, top, { width: box.w, align: "center", lineBreak: false });
  doc.font("sans").fontSize(8).fillColor(C.muted);
  doc.text("Фото недоступно", box.x, top + lineH + 2, { width: box.w, align: "center", lineBreak: false });
}

// Returns false when the photo could not be embedded, so a placeholder is drawn instead.
function drawPhoto(doc, photo, box) {
  doc.save();
  doc.roundedRect(box.x, box.y, box.w, box.h, 7).fill(C.photo);
  doc.restore();
  if (photo) {
    doc.save();
    try {
      doc.roundedRect(box.x, box.y, box.w, box.h, 7).clip();
      // "fit" keeps the proportions and never crops: the free space stays photo-background.
      doc.image(photo, box.x + 6, box.y + 6, { fit: [box.w - 12, box.h - 12], align: "center", valign: "center" });
      return true;
    } catch {
      // Falls through to the placeholder below.
    } finally {
      doc.restore();
    }
  }
  drawPlaceholder(doc, box);
  return false;
}

function drawPrice(doc, item, x, y, width) {
  const label = formatPdfPrice(item.price, item.currency);
  const onRequest = label === PRICE_ON_REQUEST;
  let size = onRequest ? 11 : 15;
  doc.font(onRequest ? "sans" : "sans-bold").fontSize(size);
  while (size > 7 && doc.widthOfString(label) > width) {
    size -= 0.5;
    doc.fontSize(size);
  }
  const lineH = doc.currentLineHeight();
  doc.fillColor(onRequest ? C.muted : C.ink);
  doc.text(label, x, y + (20 - lineH) / 2, { width, height: lineH + 0.5, ellipsis: true });
}

function drawCard(doc, item, photo, x, y, onPhotoFailed) {
  doc.save();
  doc.roundedRect(x, y, CARD_W, CARD_H, 10).lineWidth(0.8).fillAndStroke(C.card, C.line);
  doc.restore();

  const photoBox = { x: x + CARD_PAD, y: y + CARD_PAD, w: CARD_W - CARD_PAD * 2, h: PHOTO_H };
  if (!drawPhoto(doc, photo, photoBox) && photo) onPhotoFailed(item, "изображение не удалось встроить");
  const title = fitText(item.title, "serif");
  const description = fitText(item.description, "sans");

  const textX = x + CARD_PAD + 2;
  const textW = CARD_W - (CARD_PAD + 2) * 2;
  let cursor = photoBox.y + PHOTO_H + 14;

  doc.font("sans-bold").fontSize(7.5).fillColor(C.goldDeep);
  doc.text(typeLabel(item.type).toUpperCase(), textX, cursor, { lineBreak: false, characterSpacing: 1.4 });
  cursor += 15;

  doc.font("serif").fontSize(17).fillColor(C.ink);
  const titleLine = doc.currentLineHeight(true);
  if (title) {
    const titleH = Math.min(doc.heightOfString(title, { width: textW }), titleLine * 2);
    doc.text(title, textX, cursor, { width: textW, height: titleLine * 2 + 1, ellipsis: true });
    cursor += titleH + 6;
  }

  const priceY = y + CARD_H - CARD_PAD - 20;
  doc.moveTo(textX, priceY - 8).lineTo(textX + textW, priceY - 8).lineWidth(0.6).stroke(C.line);
  drawPrice(doc, item, textX, priceY, textW);

  if (description) {
    const lineGap = 1.6;
    doc.font("sans").fontSize(8.8).fillColor(C.text);
    const descLine = doc.currentLineHeight() + lineGap;
    const lines = Math.floor((priceY - 14 - cursor) / descLine);
    if (lines >= 1) {
      doc.text(description, textX, cursor, { width: textW, height: lines * descLine + 1, ellipsis: true, lineGap });
    }
  }
}

// job: { items: [{ title, description, price, currency, type, image }], uploadsDir, dateLabel, countLabel, generatedAt }
// Photos are read one at a time while drawing, so only one is held in memory besides the PDF itself.
function render({ items, uploadsDir, dateLabel, countLabel, generatedAt }, { loadImage = async () => ({ buffer: null }), warn = () => {} } = {}) {
  const photoWarning = (item, reason) => warn(`фото «${item.title}» заменено заглушкой: ${reason}`);
  const loadPhoto = async (item) => {
    const loaded = await loadImage(item.image, uploadsDir);
    if (loaded.error) photoWarning(item, loaded.error);
    return loaded.buffer || null;
  };

  return renderPdf({ title: `Каталог товаров — ${brand.name}`, subject: "Каталог товаров", creationDate: generatedAt }, async (doc) => {
    drawCover(doc, { dateLabel, countLabel });

    for (const [index, item] of items.entries()) {
      const slot = index % PER_PAGE;
      if (slot === 0) {
        doc.addPage({ size: "A4", margin: 0 });
        drawPageHeader(doc, dateLabel);
      }
      const col = slot % COLS;
      const row = Math.floor(slot / COLS);
      const photo = await loadPhoto(item);
      drawCard(doc, item, photo, MARGIN + col * (CARD_W + GAP), CONTENT_TOP + row * (CARD_H + GAP), photoWarning);
    }

    const { start, count } = doc.bufferedPageRange();
    for (let i = start + 1; i < start + count; i += 1) {
      doc.switchToPage(i);
      drawPageFooter(doc, i + 1, count);
    }
  });
}

module.exports = { render, PER_PAGE };
