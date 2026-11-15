// "Send" tab — picks source + template, composes the payload, copies/downloads it.
import { PROMPT_TEMPLATES, getTemplate } from "./templates.js";
import { composePayload, estimateTokens, formatTokens, suggestedFilename } from "./compose.js";
import { copyToClipboard, downloadAsMarkdown, slug, dateStamp } from "./util.js";
import { getAllHighlightsForBook, getHighlights, getPreferences, setPreferences } from "./storage.js";

export function initSend({ getState, els, toast }) {
  const {
    sourceRadios,           // NodeList of inputs name="send-source"
    highlightsScopeWrap,    // container shown when source = highlights
    highlightsScopeRadios,  // NodeList of inputs name="hl-scope"
    templateSelect,
    customWrap,
    customTextarea,
    tokenLine,
    previewBlock,
    previewText,
    copyBtn,
    downloadBtn,
  } = els;

  let currentSelection = ""; // text last selected in the reader (empty if none)
  let activeBookHash = null;

  // Populate template dropdown
  templateSelect.innerHTML = PROMPT_TEMPLATES
    .map(t => `<option value="${t.id}">${t.label}</option>`)
    .join("");

  // ── State helpers ────────────────────────────────────────
  function selectedSource() {
    for (const r of sourceRadios) if (r.checked) return r.value;
    return "chapter";
  }
  function setSource(value) {
    for (const r of sourceRadios) r.checked = (r.value === value);
    highlightsScopeWrap.hidden = (value !== "highlights");
  }
  function selectedHlScope() {
    for (const r of highlightsScopeRadios) if (r.checked) return r.value;
    return "book";
  }
  function setHlScope(value) {
    for (const r of highlightsScopeRadios) r.checked = (r.value === value);
  }
  function selectedTemplateId() { return templateSelect.value; }
  function getCustomBody() { return customTextarea.value; }

  // Public-ish: what other modules ask when they want to apply the active template
  function getActiveTemplate() {
    return { templateId: selectedTemplateId(), customBody: getCustomBody() };
  }

  // ── Build the current composed payload ───────────────────
  async function buildPayload() {
    const state = getState();
    if (!state.book) return null;

    const source = selectedSource();
    const templateId = selectedTemplateId();
    const customBody = getCustomBody();

    let highlights = null;
    if (source === "highlights") {
      const scope = selectedHlScope();
      highlights = scope === "chapter"
        ? await getHighlights(state.book.hash, state.currentChapter)
        : await getAllHighlightsForBook(state.book.hash);
    }

    return {
      text: composePayload({
        book: state.book,
        source,
        chapterIdx: state.currentChapter,
        selection: source === "selection" ? currentSelection : undefined,
        highlights,
        templateId,
        customBody,
      }),
      source,
      highlightsCount: highlights?.length ?? 0,
    };
  }

  async function refresh() {
    const payload = await buildPayload();
    if (!payload) {
      tokenLine.textContent = "—";
      previewText.textContent = "";
      copyBtn.disabled = true;
      downloadBtn.disabled = true;
      return;
    }
    const tokens = estimateTokens(payload.text);
    const source = payload.source;
    let label = source;
    if (source === "highlights") label = `${payload.highlightsCount} highlight${payload.highlightsCount === 1 ? "" : "s"}`;
    tokenLine.textContent = `${label} · ~${formatTokens(tokens)} tokens`;
    previewText.textContent = payload.text;
    // Disable when there's nothing useful to copy
    const empty = source === "selection" && !currentSelection;
    const noHl = source === "highlights" && payload.highlightsCount === 0;
    copyBtn.disabled = empty || noHl;
    downloadBtn.disabled = empty || noHl;
  }

  // ── Actions ──────────────────────────────────────────────
  async function copyComposed() {
    const payload = await buildPayload();
    if (!payload) return;
    await copyToClipboard(payload.text);
    toast("Copied to clipboard — paste into Claude.ai or ChatGPT.");
  }

  async function downloadComposed() {
    const payload = await buildPayload();
    if (!payload) return;
    const state = getState();
    const fname = suggestedFilename(
      { book: state.book, source: payload.source, chapterIdx: state.currentChapter },
      slug, dateStamp,
    );
    downloadAsMarkdown(fname, payload.text);
    toast("Saved.");
  }

  // Used by the floating selection popover (highlight-to-copy quick action).
  async function copyPassage(selectionText) {
    const state = getState();
    if (!state.book) return;
    const { templateId, customBody } = getActiveTemplate();
    const text = composePayload({
      book: state.book,
      source: "selection",
      chapterIdx: state.currentChapter,
      selection: selectionText,
      templateId,
      customBody,
    });
    await copyToClipboard(text);
    toast("Passage copied — paste into Claude.ai or ChatGPT.");
  }

  // ── Wiring ───────────────────────────────────────────────
  for (const r of sourceRadios) {
    r.addEventListener("change", async () => {
      highlightsScopeWrap.hidden = (selectedSource() !== "highlights");
      await refresh();
      await persist();
    });
  }
  for (const r of highlightsScopeRadios) {
    r.addEventListener("change", async () => { await refresh(); await persist(); });
  }
  templateSelect.addEventListener("change", async () => {
    customWrap.hidden = (selectedTemplateId() !== "custom");
    await refresh();
    await persist();
  });
  customTextarea.addEventListener("input", async () => {
    await refresh();
    await persist();
  });
  copyBtn.addEventListener("click", copyComposed);
  downloadBtn.addEventListener("click", downloadComposed);

  // ── Preferences persistence ──────────────────────────────
  async function persist() {
    await setPreferences({
      source: selectedSource(),
      hlScope: selectedHlScope(),
      templateId: selectedTemplateId(),
      customBody: getCustomBody(),
    });
  }

  async function loadPrefs() {
    const p = await getPreferences();
    if (p.source) setSource(p.source);
    if (p.hlScope) setHlScope(p.hlScope);
    if (p.templateId) templateSelect.value = p.templateId;
    if (p.customBody) customTextarea.value = p.customBody;
    customWrap.hidden = (selectedTemplateId() !== "custom");
    highlightsScopeWrap.hidden = (selectedSource() !== "highlights");
  }

  // ── Public API ───────────────────────────────────────────
  return {
    init: async () => { await loadPrefs(); await refresh(); },
    onBookChange: async (book) => {
      activeBookHash = book?.hash || null;
      currentSelection = "";
      // Selection radio disabled until user selects
      for (const r of sourceRadios) {
        if (r.value === "selection") r.disabled = true;
      }
      await refresh();
    },
    onChapterChange: refresh,
    onSelectionChange: async (text) => {
      currentSelection = text || "";
      const hasSel = !!currentSelection;
      for (const r of sourceRadios) {
        if (r.value === "selection") r.disabled = !hasSel;
      }
      if (!hasSel && selectedSource() === "selection") {
        setSource("chapter");
      }
      // When a selection just appeared, auto-switch source to Selection for convenience
      if (hasSel && selectedSource() !== "selection") {
        // Don't force the switch — let user pick. Just refresh the preview if source already = selection.
      }
      await refresh();
    },
    onHighlightsChange: refresh,
    copyPassage,
    getActiveTemplate,
  };
}
