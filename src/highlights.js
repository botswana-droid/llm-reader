// Persistent text highlights — saving, re-rendering as <mark>, panel UI,
// click-to-copy/remove popover. All matching is done in the rendered DOM
// via (text, occurrenceIndex), not markdown source — survives re-renders.

import {
  getHighlights, getAllHighlightsForBook,
  saveHighlight, deleteHighlight,
} from "./storage.js";
import { composePayload, suggestedFilename } from "./compose.js";
import { copyToClipboard, downloadAsMarkdown, slug, dateStamp } from "./util.js";

// ── DOM range helpers ────────────────────────────────────────

// Build a flat text buffer of the reader's text content, plus a list of
// { node, start } entries so we can map char offsets back to text nodes.
function indexTextNodes(rootEl) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let buf = "";
  let n;
  while ((n = walker.nextNode())) {
    // Skip text inside existing <mark> wrappers so highlight wrapping is idempotent
    // (we wipe marks before re-applying anyway, but this is defensive).
    nodes.push({ node: n, start: buf.length });
    buf += n.nodeValue;
  }
  return { buf, nodes };
}

// Given a flat char offset, find the text node + local offset.
// `forEnd` mode picks the node that *contains* the char at offset-1
// (i.e. treats offset as exclusive) — important when the end position
// lands exactly on the start of the next text node, which would otherwise
// span the Range out of the current element and produce invalid wrapping
// (e.g. <mark> wrapping a whole <p>).
function nodeAt(nodes, offset, forEnd = false) {
  let last = nodes[0];
  for (const n of nodes) {
    if (forEnd ? n.start >= offset : n.start > offset) break;
    last = n;
  }
  return { node: last.node, local: offset - last.start };
}

// Wrap occurrence #`occurrenceIndex` of `text` with <mark> elements.
// The match can span several text nodes (e.g. across paragraphs or a bold
// word), so each text-node slice gets its own <mark> sharing the same
// highlight id. That keeps the DOM valid — a single <mark> around block
// elements like <p> or <li> is not. Returns the match offset, or -1.
function wrapOccurrence(rootEl, text, occurrenceIndex, attrs) {
  if (!text) return -1;
  const { buf, nodes } = indexTextNodes(rootEl);
  let idx = -1;
  for (let i = 0; i <= occurrenceIndex; i++) {
    idx = buf.indexOf(text, idx + 1);
    if (idx < 0) return -1;
  }
  const end = idx + text.length;
  for (const { node, start } of nodes) {
    const len = node.nodeValue.length;
    if (start + len <= idx || start >= end) continue;
    const a = Math.max(idx, start) - start;
    const b = Math.min(end, start + len) - start;
    if (!node.nodeValue.slice(a, b).trim()) continue; // whitespace between blocks
    let target = node;
    if (b < len) target.splitText(b);
    if (a > 0) target = target.splitText(a);
    const mark = document.createElement("mark");
    for (const [k, v] of Object.entries(attrs || {})) mark.setAttribute(k, v);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
  return idx;
}

// Remove our <mark>s for one highlight id (or all of ours when id is omitted).
function unwrapMarks(rootEl, id) {
  const sel = id ? `mark[data-highlight-id="${id}"]` : "mark[data-highlight-id]";
  for (const m of [...rootEl.querySelectorAll(sel)]) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

// Strip all <mark data-highlight-id> wrappers added by us. Leaves any natural
// document <mark> elements alone (none come from our markdown rendering).
function stripMarks(rootEl) { unwrapMarks(rootEl); }

// Compute the occurrenceIndex of `text` in `buf` that contains `globalOffset`.
function occurrenceIndexAt(buf, text, globalOffset) {
  let idx = -1;
  let count = -1;
  while (true) {
    idx = buf.indexOf(text, idx + 1);
    if (idx < 0 || idx > globalOffset) break;
    count++;
    if (idx === globalOffset) return count;
  }
  return count >= 0 ? count : 0;
}

// ── Public API: applying highlights to the reader ───────────

export async function applyToReader(rootEl, bookHash, chapterIdx) {
  if (!rootEl || bookHash == null || chapterIdx == null) return;
  stripMarks(rootEl);
  const highlights = await getHighlights(bookHash, chapterIdx);
  for (const h of highlights) {
    wrapOccurrence(rootEl, h.text, h.occurrenceIndex, {
      "data-highlight-id": h.id,
      "class": "user-highlight",
    });
  }
}

// ── Public API: saving from a selection ─────────────────────

export async function saveFromSelection({ rootEl, bookHash, chapterIdx, getBookTitle }) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  // The anchor node must be inside the reader.
  const anchorEl = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!rootEl.contains(anchorEl)) return null;

  // Measure the selection as offsets into the reader's flat text buffer, and
  // store exactly that slice. (sel.toString() adds/removes newlines between
  // paragraphs, so it can't be found again in the buffer for multi-paragraph
  // selections — that used to make those highlights silently fail.)
  const { buf } = indexTextNodes(rootEl);
  const range = sel.getRangeAt(0);
  let globalStart = offsetInRoot(rootEl, range.startContainer, range.startOffset);
  let globalEnd = offsetInRoot(rootEl, range.endContainer, range.endOffset);
  while (globalStart < globalEnd && /\s/.test(buf[globalStart])) globalStart++;
  while (globalEnd > globalStart && /\s/.test(buf[globalEnd - 1])) globalEnd--;
  const text = buf.slice(globalStart, globalEnd);
  if (text.length < 3) return null;
  const occurrenceIndex = occurrenceIndexAt(buf, text, globalStart);

  // Pick a small context snippet before the selection for human-readable
  // list rendering (not used for matching).
  const ctxStart = Math.max(0, globalStart - 30);
  const contextSnippet = buf.slice(ctxStart, globalStart).replace(/\s+/g, " ").trim();

  const h = {
    id: crypto.randomUUID(),
    bookHash,
    chapterIdx,
    text,
    occurrenceIndex,
    contextSnippet,
    createdAt: Date.now(),
  };
  await saveHighlight(h);
  // Clear the selection so the popover hides naturally
  sel.removeAllRanges();
  return h;
}

// Character offset of a DOM point within rootEl's concatenated text nodes.
// Range.toString() concatenates text-node data, matching indexTextNodes().
function offsetInRoot(rootEl, container, offset) {
  const r = document.createRange();
  r.setStart(rootEl, 0);
  r.setEnd(container, offset);
  return r.toString().length;
}

// ── Mark click → inline popover ─────────────────────────────

// One global popover for highlight marks. Caller wires this up once at app init.
export function initMarkClickPopover({ rootEl, popoverEl, copyBtn, removeBtn, onChange, getCopyContext }) {
  let activeHighlightId = null;

  function hide() {
    popoverEl.hidden = true;
    activeHighlightId = null;
  }

  rootEl.addEventListener("click", (e) => {
    const mark = e.target.closest("mark[data-highlight-id]");
    if (!mark) { hide(); return; }
    const id = mark.getAttribute("data-highlight-id");
    activeHighlightId = id;
    const rect = mark.getBoundingClientRect();
    popoverEl.style.top = `${window.scrollY + rect.bottom + 4}px`;
    popoverEl.style.left = `${rect.left + rect.width / 2}px`;
    popoverEl.hidden = false;
    e.stopPropagation();
  });

  // Hide on outside click
  document.addEventListener("click", (e) => {
    if (popoverEl.hidden) return;
    if (popoverEl.contains(e.target)) return;
    if (e.target.closest("mark[data-highlight-id]")) return;
    hide();
  });

  copyBtn.addEventListener("click", async () => {
    if (!activeHighlightId) return;
    const ctx = await getCopyContext(activeHighlightId);
    if (ctx) {
      await copyToClipboard(ctx.text);
      ctx.onCopied?.();
    }
    hide();
  });

  removeBtn.addEventListener("click", async () => {
    if (!activeHighlightId) return;
    await deleteHighlight(activeHighlightId);
    hide();
    await onChange?.();
  });

  return { hide };
}

// ── Highlights panel ────────────────────────────────────────

export function initPanel({ getState, els, toast, getActiveTemplate, jumpToChapter, onChange }) {
  const { listEl, badgeEl, selectAllBtn, toolbar, toolbarLabel, copySelectedBtn, deleteSelectedBtn, clearSelBtn } = els;

  let highlights = [];
  const selected = new Set();

  function updateBadge(count) {
    if (badgeEl) badgeEl.textContent = count > 0 ? String(count) : "";
  }

  function updateToolbar() {
    const n = selected.size;
    if (n === 0) {
      toolbar.hidden = true;
    } else {
      toolbar.hidden = false;
      toolbarLabel.textContent = `${n} selected`;
    }
  }

  async function refresh() {
    const state = getState();
    if (!state.book) {
      highlights = [];
      render();
      updateBadge(0);
      return;
    }
    highlights = await getAllHighlightsForBook(state.book.hash);
    // Drop selections that no longer exist
    for (const id of [...selected]) {
      if (!highlights.find(h => h.id === id)) selected.delete(id);
    }
    updateToolbar();
    updateBadge(highlights.length);
    render();
  }

  function render() {
    listEl.innerHTML = "";
    const state = getState();
    if (highlights.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hl-empty";
      empty.textContent = "No highlights yet — select text in the reader and click Highlight.";
      listEl.appendChild(empty);
      return;
    }
    // Group by chapter
    const grouped = new Map();
    for (const h of highlights) {
      if (!grouped.has(h.chapterIdx)) grouped.set(h.chapterIdx, []);
      grouped.get(h.chapterIdx).push(h);
    }
    for (const [chapterIdx, items] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
      const chTitle = state.book?.chapters[chapterIdx]?.title || `Chapter ${chapterIdx + 1}`;
      const groupEl = document.createElement("div");
      groupEl.className = "hl-group";
      groupEl.innerHTML = `<div class="hl-group-head">Ch ${chapterIdx + 1} — ${escapeHtml(chTitle)} <span class="subtle">(${items.length})</span></div>`;
      for (const h of items) {
        groupEl.appendChild(renderRow(h));
      }
      listEl.appendChild(groupEl);
    }
  }

  function renderRow(h) {
    const row = document.createElement("div");
    row.className = "hl-row";
    if (selected.has(h.id)) row.classList.add("hl-selected");
    const dateStr = new Date(h.createdAt || 0).toLocaleDateString();
    row.innerHTML = `
      <label class="hl-check"><input type="checkbox" ${selected.has(h.id) ? "checked" : ""}></label>
      <div class="hl-body">
        <div class="hl-quote">${escapeHtml(truncate(h.text, 240))}</div>
        <div class="hl-meta">
          <span class="subtle">${dateStr}</span>
          <button class="hl-action" data-act="goto">Go to</button>
          <button class="hl-action" data-act="copy">Copy</button>
          <button class="hl-action hl-danger" data-act="delete">Delete</button>
        </div>
      </div>
    `;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(h.id); else selected.delete(h.id);
      row.classList.toggle("hl-selected", e.target.checked);
      updateToolbar();
    });
    row.querySelector('[data-act="goto"]').addEventListener("click", () => jumpToChapter(h.chapterIdx, h.id));
    row.querySelector('[data-act="copy"]').addEventListener("click", () => copyOne(h));
    row.querySelector('[data-act="delete"]').addEventListener("click", () => deleteOne(h));
    return row;
  }

  async function copyOne(h) {
    const state = getState();
    if (!state.book) return;
    const { templateId, customBody } = getActiveTemplate();
    const text = composePayload({
      book: state.book,
      source: "highlights",
      highlights: [h],
      templateId,
      customBody,
    });
    await copyToClipboard(text);
    toast("Highlight copied to clipboard.");
  }

  async function deleteOne(h) {
    await deleteHighlight(h.id);
    selected.delete(h.id);
    await refresh();
    // Instant feedback in the reader (a highlight can span several <mark>s).
    unwrapMarks(document, h.id);
    await onChange?.();
  }

  // Bulk actions
  selectAllBtn?.addEventListener("click", () => {
    if (selected.size === highlights.length) {
      selected.clear();
    } else {
      highlights.forEach(h => selected.add(h.id));
    }
    render();
    updateToolbar();
  });

  clearSelBtn?.addEventListener("click", () => {
    selected.clear();
    render();
    updateToolbar();
  });

  copySelectedBtn?.addEventListener("click", async () => {
    const state = getState();
    if (!state.book || selected.size === 0) return;
    const picked = highlights.filter(h => selected.has(h.id));
    const { templateId, customBody } = getActiveTemplate();
    const text = composePayload({
      book: state.book,
      source: "highlights",
      highlights: picked,
      templateId,
      customBody,
    });
    await copyToClipboard(text);
    toast(`${picked.length} highlight${picked.length === 1 ? "" : "s"} copied.`);
  });

  deleteSelectedBtn?.addEventListener("click", async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} highlight${selected.size === 1 ? "" : "s"}?`)) return;
    for (const id of selected) {
      await deleteHighlight(id);
      unwrapMarks(document, id);
    }
    selected.clear();
    await refresh();
    await onChange?.();
  });

  return {
    refresh,
    onBookChange: refresh,
    onChapterChange: () => {/* badge stays book-scoped */},
    copyOne,
    getHighlightById: (id) => highlights.find(h => h.id === id),
  };
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
