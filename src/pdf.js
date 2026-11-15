// PDF → { hash, title, author, chapters: [{title, md}], fullMd, format: "pdf" }
// Same book shape as epub.js, so the reader, highlights and Send tab work unchanged.
//
// Approach: extract the text layer with pdf.js and rebuild it as Markdown.
// - Chapters come from the PDF outline (bookmarks): one chapter per top-level
//   entry, spanning to the next entry's page. No outline → fixed page blocks.
// - Lines are rebuilt from text-item positions; a vertical gap bigger than the
//   normal line spacing starts a new paragraph. Hyphenated line breaks are joined.
// - Running headers/footers (same text on many pages) and bare page numbers are dropped.
// - Lines set noticeably larger than body text become headings.
// Limits: layout-heavy PDFs (multi-column, tables, forms) come out as plain prose,
// and scanned PDFs with no text layer can't be read (no OCR).
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const PAGES_PER_BLOCK = 10; // chapter size when the PDF has no outline

export async function parsePdf(file, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  const hash = await hashBuffer(buf);
  // pdf.js takes ownership of the buffer it's given, so hand it a copy.
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;

  const meta = await pdf.getMetadata().catch(() => ({}));
  const info = meta?.info || {};
  const title = cleanMetaString(info.Title) || file.name.replace(/\.pdf$/i, "");
  const author = cleanMetaString(info.Author);

  // 1. Extract every page as an array of lines with font size + position.
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items));
    page.cleanup();
    if (p % 5 === 0 || p === pdf.numPages) onProgress(p, pdf.numPages);
  }

  const totalChars = pages.reduce((n, lines) => n + lines.reduce((m, l) => m + l.text.length, 0), 0);
  if (totalChars < 200) {
    throw new Error("This PDF has no readable text layer (it's probably a scan). OCR isn't supported yet.");
  }

  // 2. Drop running headers/footers and page numbers.
  stripRepeatedLines(pages);

  // 3. Body font size = most common line height, weighted by text length.
  const bodySize = dominantSize(pages);

  // 4. Chapter ranges from the outline, else fixed blocks.
  const ranges = (await outlineRanges(pdf)) || blockRanges(pdf.numPages);

  const chapters = [];
  for (const r of ranges) {
    const md = pagesToMarkdown(pages.slice(r.from, r.to), bodySize);
    if (md.length < 40) continue;
    chapters.push({ title: r.title, md });
  }
  if (!chapters.length) throw new Error("Couldn't extract any text from this PDF.");

  const fullMd = chapters.map(c => `# ${c.title}\n\n${c.md}`).join("\n\n---\n\n");
  await pdf.destroy();

  return { hash, title: title.trim(), author: author.trim(), chapters, fullMd, format: "pdf", addedAt: Date.now() };
}

// ── Text items → lines ───────────────────────────────────────
function itemsToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue; // marked-content items
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 0;
    const sameLine = cur && Math.abs(y - cur.y) < Math.max(2, size * 0.4);
    if (!sameLine) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { text: "", y, x, size, lastEnd: x };
    }
    // Insert a space when items on one line are separated by a visible gap.
    if (cur.text && !cur.text.endsWith(" ") && !it.str.startsWith(" ") && x - cur.lastEnd > size * 0.15) {
      cur.text += " ";
    }
    cur.text += it.str;
    cur.size = Math.max(cur.size, size);
    cur.lastEnd = x + (it.width || 0);
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines.map(l => ({ text: l.text.replace(/\s+/g, " ").trim(), y: l.y, size: l.size }));
}

function stripRepeatedLines(pages) {
  if (pages.length < 4) return;
  const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").trim();
  const counts = new Map();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(l => norm(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.3);
  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i];
    const n = lines.length;
    pages[i] = lines.filter((l, j) => {
      const atEdge = j < 2 || j >= n - 2;
      if (!atEdge) return true;
      if (/^[\divxlc\s\-–—|.]+$/i.test(l.text) && l.text.length <= 12) return false; // page numbers
      return (counts.get(norm(l.text)) || 0) < threshold;
    });
  }
}

function dominantSize(pages) {
  const weight = new Map();
  for (const lines of pages) for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    weight.set(k, (weight.get(k) || 0) + l.text.length);
  }
  let best = 10, bestW = -1;
  for (const [k, w] of weight) if (w > bestW) { best = k; bestW = w; }
  return best;
}

// ── Lines → Markdown ─────────────────────────────────────────
function pagesToMarkdown(pages, bodySize) {
  const blocks = [];
  let para = "";
  const flush = () => { if (para.trim()) blocks.push(escapeMd(para.trim())); para = ""; };

  for (const lines of pages) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const prev = lines[i - 1];
      const isHeading = l.size >= bodySize * 1.25 && l.text.length < 120 && /\p{L}/u.test(l.text);
      if (isHeading) {
        flush();
        const level = l.size >= bodySize * 1.7 ? "##" : "###";
        // Merge a heading that wraps onto a second line.
        const last = blocks[blocks.length - 1];
        if (prev && last?.startsWith(level + " ") && Math.abs(prev.size - l.size) < 0.5 && (prev.y - l.y) < l.size * 1.8) {
          blocks[blocks.length - 1] = last + " " + escapeMd(l.text);
        } else {
          blocks.push(`${level} ${escapeMd(l.text)}`);
        }
        continue;
      }
      const gap = prev ? prev.y - l.y : 0;
      const lineHeight = Math.max(l.size, bodySize) * 1.15;
      if (prev && (gap > lineHeight * 1.45 || gap < 0)) flush(); // paragraph gap or new column
      if (!para) para = l.text;
      else if (/[A-Za-z]-$/.test(para) && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text; // de-hyphenate
      else para += " " + l.text;
    }
    // A page break ends a paragraph only if the page's last line looks finished.
    if (/[.!?:"”)]$/.test(para.trim())) flush();
  }
  flush();
  return blocks.join("\n\n");
}

// Stop extracted text from being read as Markdown syntax.
function escapeMd(t) {
  return t
    .replace(/([\\`*_[\]<>])/g, "\\$1")
    .replace(/^(#{1,6}\s)/, "\\$1")
    .replace(/^([-+]\s)/, "\\$1")
    .replace(/^(\d+)([.)]\s)/, "$1\\$2");
}

// ── Chapter ranges ───────────────────────────────────────────
async function outlineRanges(pdf) {
  let outline;
  try { outline = await pdf.getOutline(); } catch { return null; }
  if (!outline?.length) return null;

  const starts = [];
  for (const item of outline) {
    const pageIdx = await destToPageIndex(pdf, item.dest);
    const title = (item.title || "").trim();
    if (pageIdx == null || !title) continue;
    starts.push({ idx: pageIdx, title });
  }
  // Keep the first entry per page, in page order.
  starts.sort((a, b) => a.idx - b.idx);
  const dedup = starts.filter((s, i) => i === 0 || s.idx !== starts[i - 1].idx);
  if (dedup.length < 2) return null;

  const ranges = [];
  if (dedup[0].idx > 0) ranges.push({ title: "Front matter", from: 0, to: dedup[0].idx });
  dedup.forEach((s, i) => {
    ranges.push({ title: s.title, from: s.idx, to: i + 1 < dedup.length ? dedup[i + 1].idx : pdf.numPages });
  });
  return ranges;
}

async function destToPageIndex(pdf, dest) {
  try {
    const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d[0]) return null;
    return typeof d[0] === "number" ? d[0] : await pdf.getPageIndex(d[0]);
  } catch { return null; }
}

function blockRanges(numPages) {
  const ranges = [];
  for (let from = 0; from < numPages; from += PAGES_PER_BLOCK) {
    const to = Math.min(numPages, from + PAGES_PER_BLOCK);
    ranges.push({ title: to - from === 1 ? `Page ${from + 1}` : `Pages ${from + 1}–${to}`, from, to });
  }
  return ranges;
}

// ── Helpers ──────────────────────────────────────────────────
function cleanMetaString(s) {
  if (!s || typeof s !== "string") return "";
  const t = s.replace(/\0/g, "").trim();
  // Many PDFs carry junk titles from the authoring tool.
  if (/^(untitled|microsoft word|document\d*|\S+\.(docx?|pdf|indd))/i.test(t)) return "";
  return t;
}

async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
