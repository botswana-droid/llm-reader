// Orchestrator: wires up modules, manages app state, handles file picking,
// library, tab switching, selection popover, mark-click popover.
import { parseEpub } from "./epub.js";
// pdf.js is ~1.7 MB, so it loads only when a PDF is opened.
const loadPdfParser = () => import("./pdf.js").then(m => m.parsePdf);
import { renderToc, renderChapter } from "./reader.js";
import {
  saveBook, getBook, listBooks, deleteBook, getMeta, setMeta,
} from "./storage.js";
import { initSend } from "./send.js";
import {
  initPanel as initHighlightsPanel,
  initMarkClickPopover,
  applyToReader as applyHighlightsToReader,
  saveFromSelection as saveHighlightFromSelection,
} from "./highlights.js";
import { composePayload } from "./compose.js";
import { copyToClipboard } from "./util.js";

const state = {
  book: null,
  currentChapter: 0,
};

// ── Element refs ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  welcome: $("welcome"),
  welcomeClose: $("welcome-close"),
  welcomePick: $("welcome-pick"),
  recentSection: $("recent-section"),
  recentBooks: $("recent-books"),
  app: $("app"),
  openBtn: $("open-btn"),
  bookTitle: $("book-title"),
  bookAuthor: $("book-author"),
  tocList: $("toc-list"),
  readerContent: $("reader-content"),
  readerPanel: document.querySelector(".reader-panel"),
  tabs: document.querySelectorAll(".tab"),
  tabPanels: document.querySelectorAll(".tab-content"),
  // Send tab
  sourceRadios: document.querySelectorAll('input[name="send-source"]'),
  highlightsScopeWrap: $("hl-scope-wrap"),
  highlightsScopeRadios: document.querySelectorAll('input[name="hl-scope"]'),
  templateSelect: $("template-select"),
  customWrap: $("custom-wrap"),
  customTextarea: $("custom-textarea"),
  tokenLine: $("token-line"),
  previewBlock: document.querySelector(".preview-block"),
  previewText: $("preview-text"),
  copyBtn: $("copy-btn"),
  downloadBtn: $("download-btn"),
  // Highlights tab
  hlBadge: $("hl-badge"),
  hlList: $("hl-list"),
  hlSelectAllBtn: $("hl-select-all-btn"),
  hlToolbar: $("hl-toolbar"),
  hlToolbarLabel: $("hl-toolbar-label"),
  hlCopySelectedBtn: $("hl-copy-selected-btn"),
  hlDeleteSelectedBtn: $("hl-delete-selected-btn"),
  hlClearSelBtn: $("hl-clear-sel-btn"),
  // Overlays
  highlightPopover: $("highlight-popover"),
  popoverCopyBtn: $("popover-copy-btn"),
  popoverHighlightBtn: $("popover-highlight-btn"),
  markPopover: $("mark-popover"),
  markCopyBtn: $("mark-copy-btn"),
  markRemoveBtn: $("mark-remove-btn"),
  fileInput: $("file-input"),
  toast: $("toast"),
};

// ── Toast helper ─────────────────────────────────────────────
let toastTimer;
function toast(msg, ms = 2400) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

// ── Library / welcome screen ─────────────────────────────────
async function showLibrary() {
  await renderRecentBooks();
  els.welcomeClose.hidden = !state.book;
  els.welcome.hidden = false;
}
function hideLibrary() { els.welcome.hidden = true; }

els.openBtn.addEventListener("click", showLibrary);
els.welcomeClose.addEventListener("click", hideLibrary);

// ── File handling ────────────────────────────────────────────
els.welcomePick.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) await openFile(file);
  e.target.value = "";
});

// Drag & drop anywhere
window.addEventListener("dragover", (e) => { e.preventDefault(); });
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && fileKind(file)) await openFile(file);
  else if (file) toast("Only EPUB and PDF files are supported.");
});

function fileKind(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".epub") || file.type === "application/epub+zip") return "epub";
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  return null;
}

async function openFile(file) {
  const kind = fileKind(file);
  if (!kind) { toast("Only EPUB and PDF files are supported.", 4000); return; }
  const label = kind.toUpperCase();
  toast(`Parsing ${label}…`, 60000);
  try {
    const book = kind === "pdf"
      ? await (await loadPdfParser())(file, (p, n) => toast(`Reading PDF… page ${p} of ${n}`, 60000))
      : await parseEpub(file);
    await saveBook(book);
    hideLibrary();
    await loadBook(book);
    toast(`Loaded ${book.chapters.length} ${kind === "pdf" ? "sections" : "chapters"}.`);
  } catch (e) {
    console.error(e);
    toast(`Couldn't open this ${label}: ${e.message}`, 6000);
  }
}

// ── Book loading ─────────────────────────────────────────────
async function loadBook(book) {
  state.book = book;
  state.currentChapter = Math.min((await getMeta(`pos:${book.hash}`)) ?? 0, book.chapters.length - 1);
  await setMeta("lastBookHash", book.hash); // so the last-opened book (not just last-imported) reopens on boot
  els.welcome.hidden = true;
  els.app.hidden = false;
  els.bookTitle.textContent = book.title;
  els.bookAuthor.textContent = book.author;
  renderToc(els.tocList, book.chapters, state.currentChapter, switchChapter);
  await renderActiveChapter();
  await send.onBookChange(book);
  await highlights.onBookChange();
}

async function renderActiveChapter() {
  if (!state.book) return;
  const ch = state.book.chapters[state.currentChapter];
  if (!ch) return;
  renderChapter(els.readerContent, ch);
  await applyHighlightsToReader(els.readerContent, state.book.hash, state.currentChapter);
  els.readerPanel.scrollTop = 0;
}

async function switchChapter(idx, scrollToHighlightId = null) {
  if (!state.book) return;
  state.currentChapter = idx;
  await setMeta(`pos:${state.book.hash}`, idx);
  renderToc(els.tocList, state.book.chapters, idx, switchChapter);
  await renderActiveChapter();
  await send.onChapterChange();
  if (scrollToHighlightId) {
    const mark = els.readerContent.querySelector(`mark[data-highlight-id="${scrollToHighlightId}"]`);
    if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── Tabs ─────────────────────────────────────────────────────
els.tabs.forEach(t => {
  t.addEventListener("click", () => {
    els.tabs.forEach(x => x.classList.toggle("active", x === t));
    const which = t.dataset.tab;
    els.tabPanels.forEach(p => { p.hidden = p.dataset.panel !== which; });
  });
});

function switchToTab(which) {
  els.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === which));
  els.tabPanels.forEach(p => { p.hidden = p.dataset.panel !== which; });
}

// ── Selection popover (text selected in the reader) ─────────
let lastSelectionText = "";
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    els.highlightPopover.hidden = true;
    if (lastSelectionText) {
      lastSelectionText = "";
      send.onSelectionChange(null);
    }
    return;
  }
  const text = sel.toString().trim();
  if (text.length < 3) {
    els.highlightPopover.hidden = true;
    return;
  }
  const anchorEl = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!els.readerContent.contains(anchorEl)) {
    els.highlightPopover.hidden = true;
    return;
  }
  lastSelectionText = text;
  send.onSelectionChange(text);
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  // Popover is position:fixed; flip below the selection if there's no room above.
  const top = rect.top > 52 ? rect.top - 44 : rect.bottom + 8;
  els.highlightPopover.style.top = `${top}px`;
  els.highlightPopover.style.left = `${rect.left + rect.width / 2}px`;
  els.highlightPopover.hidden = false;
});

els.popoverCopyBtn.addEventListener("click", async () => {
  if (!lastSelectionText) return;
  await send.copyPassage(lastSelectionText);
  els.highlightPopover.hidden = true;
  window.getSelection()?.removeAllRanges();
});

els.popoverHighlightBtn.addEventListener("click", async () => {
  if (!state.book || !lastSelectionText) return;
  const h = await saveHighlightFromSelection({
    rootEl: els.readerContent,
    bookHash: state.book.hash,
    chapterIdx: state.currentChapter,
  });
  els.highlightPopover.hidden = true;
  if (!h) { toast("Couldn't save that highlight."); return; }
  await applyHighlightsToReader(els.readerContent, state.book.hash, state.currentChapter);
  await highlights.refresh();
  await send.onHighlightsChange();
  toast("Highlight saved.");
});

// ── Mark click popover (click an existing <mark>) ───────────
initMarkClickPopover({
  rootEl: els.readerContent,
  popoverEl: els.markPopover,
  copyBtn: els.markCopyBtn,
  removeBtn: els.markRemoveBtn,
  onChange: async () => {
    if (!state.book) return;
    await applyHighlightsToReader(els.readerContent, state.book.hash, state.currentChapter);
    await highlights.refresh();
    await send.onHighlightsChange();
  },
  getCopyContext: async (highlightId) => {
    if (!state.book) return null;
    const h = highlights.getHighlightById(highlightId);
    if (!h) return null;
    const { templateId, customBody } = send.getActiveTemplate();
    const text = composePayload({
      book: state.book,
      source: "highlights",
      highlights: [h],
      templateId,
      customBody,
    });
    return { text, onCopied: () => toast("Highlight copied.") };
  },
});

// ── Recent books on welcome ─────────────────────────────────
async function renderRecentBooks() {
  const books = await listBooks();
  if (books.length === 0) { els.recentSection.hidden = true; return; }
  els.recentSection.hidden = false;
  els.recentBooks.innerHTML = "";
  for (const b of books) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="recent-meta">
        <span class="recent-title">${escapeHtml(b.title)}</span>
        ${b.author ? `<span class="recent-author">${escapeHtml(b.author)}</span>` : ""}
      </div>
      <span class="recent-chapters">${b.format === "pdf" ? "PDF · " : ""}${b.chapters.length} ch</span>
      <button class="recent-delete" title="Remove from library" data-hash="${b.hash}">×</button>
    `;
    li.addEventListener("click", async (e) => {
      if (e.target.classList.contains("recent-delete")) return;
      const full = await getBook(b.hash);
      if (full) { hideLibrary(); await loadBook(full); }
    });
    li.querySelector(".recent-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${b.title}" from library? Highlights for it will be deleted too.`)) return;
      await deleteBook(b.hash);
      if (state.book?.hash === b.hash) {
        state.book = null;
        els.app.hidden = true;
      }
      await renderRecentBooks();
    });
    els.recentBooks.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ── Init modules ─────────────────────────────────────────────
const getState = () => state;

const send = initSend({
  getState,
  els: {
    sourceRadios: els.sourceRadios,
    highlightsScopeWrap: els.highlightsScopeWrap,
    highlightsScopeRadios: els.highlightsScopeRadios,
    templateSelect: els.templateSelect,
    customWrap: els.customWrap,
    customTextarea: els.customTextarea,
    tokenLine: els.tokenLine,
    previewBlock: els.previewBlock,
    previewText: els.previewText,
    copyBtn: els.copyBtn,
    downloadBtn: els.downloadBtn,
  },
  toast,
});

const highlights = initHighlightsPanel({
  getState,
  els: {
    listEl: els.hlList,
    badgeEl: els.hlBadge,
    selectAllBtn: els.hlSelectAllBtn,
    toolbar: els.hlToolbar,
    toolbarLabel: els.hlToolbarLabel,
    copySelectedBtn: els.hlCopySelectedBtn,
    deleteSelectedBtn: els.hlDeleteSelectedBtn,
    clearSelBtn: els.hlClearSelBtn,
  },
  toast,
  onChange: () => send.onHighlightsChange(),
  getActiveTemplate: () => send.getActiveTemplate(),
  jumpToChapter: async (chapterIdx, highlightId) => {
    switchToTab("send"); // Reader is now visible
    await switchChapter(chapterIdx, highlightId);
  },
});

// ── Boot ────────────────────────────────────────────────────
(async function boot() {
  await send.init();
  await renderRecentBooks();
  const lastHash = await getMeta("lastBookHash");
  if (lastHash) {
    const last = await getBook(lastHash);
    if (last) await loadBook(last);
  }
})();
