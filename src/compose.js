// Builds the composed Markdown payload for clipboard / download.
// All copy/download paths funnel through here so the format stays consistent.

import { getTemplate } from "./templates.js";

const SEP = "\n\n---\n\n";

// Approx tokens for English prose: 4 chars per token.
export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function header(book, chapter, chapterIdx, totalChapters, suffix = "") {
  const chPart = chapter
    ? `Chapter ${chapterIdx + 1} of ${totalChapters}: ${chapter.title}`
    : "";
  const lines = [
    `# ${book.title}${chPart ? " — " + chPart : ""}`,
    book.author ? `*${book.author}*` : "",
    suffix,
  ].filter(Boolean);
  return lines.join("\n");
}

function quoteBlock(text) {
  return text.split("\n").map(l => "> " + l).join("\n");
}

function promptPrefix(templateId, customBody) {
  if (templateId === "none") return "";
  const t = getTemplate(templateId);
  const body = templateId === "custom" ? (customBody || "").trim() : (t.body || "").trim();
  return body || "";
}

/**
 * Build the composed Markdown text.
 *
 * @param {Object} params
 * @param {Object} params.book           - { title, author, chapters: [{ title, md }] }
 * @param {string} params.source         - "chapter" | "book" | "selection" | "highlights"
 * @param {number} [params.chapterIdx]   - required for source = chapter / selection
 * @param {string} [params.selection]    - required for source = selection
 * @param {Array}  [params.highlights]   - required for source = highlights; each { chapterIdx, text }
 * @param {string} [params.highlightsScope] - "book" | "chapter" — only affects nothing here (caller filters); kept for tagging
 * @param {string} params.templateId     - one of PROMPT_TEMPLATES ids
 * @param {string} [params.customBody]   - prompt body when templateId = "custom"
 * @returns {string} the composed markdown
 */
export function composePayload({
  book, source, chapterIdx, selection, highlights,
  templateId = "none", customBody = "",
}) {
  const prefix = promptPrefix(templateId, customBody);
  const total = book.chapters.length;

  let head = "";
  let body = "";

  switch (source) {
    case "book": {
      head = header(book, null, 0, total);
      body = book.chapters
        .map((c, i) => `## Chapter ${i + 1}: ${c.title}\n\n${c.md}`)
        .join("\n\n---\n\n");
      break;
    }
    case "chapter": {
      const ch = book.chapters[chapterIdx];
      head = header(book, ch, chapterIdx, total);
      body = ch?.md || "";
      break;
    }
    case "selection": {
      const ch = book.chapters[chapterIdx];
      head = header(book, ch, chapterIdx, total, "*Excerpt*");
      body = quoteBlock((selection || "").trim());
      break;
    }
    case "highlights": {
      head = header(book, null, 0, total, `*${highlights.length} highlight${highlights.length === 1 ? "" : "s"}*`);
      // Group by chapter, preserving chapter order
      const grouped = new Map();
      for (const h of highlights) {
        if (!grouped.has(h.chapterIdx)) grouped.set(h.chapterIdx, []);
        grouped.get(h.chapterIdx).push(h);
      }
      const chunks = [];
      const sortedChapters = [...grouped.keys()].sort((a, b) => a - b);
      for (const ci of sortedChapters) {
        const chTitle = book.chapters[ci]?.title || `Chapter ${ci + 1}`;
        const items = grouped.get(ci).map(h => quoteBlock(h.text.trim())).join("\n\n");
        chunks.push(`## Ch ${ci + 1} — ${chTitle}\n\n${items}`);
      }
      body = chunks.join("\n\n");
      break;
    }
    default:
      throw new Error("Unknown source: " + source);
  }

  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(head);
  if (body) parts.push(body);
  return parts.join(SEP) + "\n";
}

export function suggestedFilename({ book, source, chapterIdx }, slugFn, dateStampFn) {
  const base = slugFn(book.title);
  const stamp = dateStampFn();
  if (source === "book") return `${base}-book-${stamp}.md`;
  if (source === "chapter" && book.chapters[chapterIdx]) {
    return `${base}-ch${chapterIdx + 1}-${slugFn(book.chapters[chapterIdx].title, 40)}.md`;
  }
  if (source === "selection") return `${base}-excerpt-${stamp}.md`;
  if (source === "highlights") return `${base}-highlights-${stamp}.md`;
  return `${base}-${stamp}.md`;
}
