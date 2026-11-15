# LLM Reader

A tiny single-page tool for reading EPUBs and PDFs and sending bits of them to Claude.ai
or ChatGPT for explanation, summarisation, or Q&A. No API key needed — you
copy chapters or highlights to the clipboard and paste into whichever LLM app
you already pay for.

## What it does

1. **Open an EPUB** → parses chapters into clean Markdown, persisted in IndexedDB.
2. **Read it** in a clean reading view with a chapter sidebar.
3. **Highlight what matters** — select any passage, click `Highlight`, and it's saved (yellow `<mark>` in the reader, listed in the Highlights tab).
4. **Send it to your LLM** — the Send tab composes a clipboard-ready payload:
   - Source: current chapter / whole book / current selection / your highlights.
   - Prompt template: Summarize, Key ideas, Quiz me, Explain, Discuss, Custom, or None.
   - One click `Copy to clipboard` → switch to Claude.ai or ChatGPT → paste.
   - Or `Download .md` to save the same payload as a file.

## How to run

**Open <https://botswana-droid.github.io/llm-reader/> in Chrome.** That's it: it's hosted on
GitHub Pages, so there's no local server to start or stop.

For an app-like window with its own Dock icon: in Chrome, ⋮ → Cast, save and share →
Install page as app.

Books and highlights are stored in the browser's IndexedDB for that web address, so they
stay on the device and browser you used. Nothing is uploaded.

### Local development

```bash
cd ~/Code/llm-reader
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://localhost:8765
```

`--bind 127.0.0.1` keeps the server reachable from this Mac only; without it, anyone on
the same network can browse the folder. (`file://` won't work — browsers block ES module
imports from local files.) Note that `localhost` and the GitHub Pages site have separate
libraries, because IndexedDB is per-origin.

## Typical workflow

1. **Open an EPUB**. It parses + appears in your library; the last book auto-loads on next visit.
2. **Read a chapter the old-fashioned way.** No AI in your face.
3. **Highlight passages** as you go — saved instantly, visible in yellow.
4. When you want help: **Send tab → pick a source + a prompt template → Copy**. Switch to Claude.ai or ChatGPT, paste.
5. Repeat the Send copy with the same template + a different chapter without retyping the prompt.

The Highlights tab shows everything you've saved across the book. Multi-select highlights and bulk-copy them with a prompt to ask Claude to "find the through-line" across what struck you.

## Files

```
index.html           - layout, popovers, app shell
styles.css           - all styling (light/dark via prefers-color-scheme)
src/main.js          - orchestrator, state, file picking, selection popover
src/epub.js          - JSZip + OPF/NCX parse + turndown → markdown
src/pdf.js           - pdf.js text extraction → markdown sections
vendor/pdfjs/        - pdf.js 4.10.38 (Apache-2.0), self-hosted so its worker is same-origin
src/reader.js        - marked + DOMPurify rendering, TOC
src/templates.js     - prompt template strings (Summarize, Quiz, …)
src/compose.js       - composes the clipboard / download payload
src/send.js          - Send tab UI + copy/download actions
src/highlights.js    - persistent highlights, <mark> wrapping, panel UI
src/storage.js       - IndexedDB wrappers (books, highlights, meta)
src/util.js          - download / clipboard / slug helpers
```

pdf.js is self-hosted in `vendor/`; the other libraries load from [esm.sh](https://esm.sh) on first run and are then cached by the browser.

## Tradeoffs to know about

- **EPUB parser is best-effort** — handles standard EPUB 2 / EPUB 3 with OPF + NCX or nav doc. Heavily DRM'd or non-standard files may fail.
- **PDF support is text extraction, not a page viewer.** Sections come from the PDF's bookmarks (or 10-page blocks when it has none). Running headers, footers and page numbers are stripped, hyphenated line breaks are rejoined, and larger text becomes headings. Multi-column layouts, tables and forms come out as plain prose, and scanned PDFs with no text layer can't be opened (no OCR).
- **Highlights match by `(text, occurrenceIndex)`** — if the same exact phrase appears multiple times in a chapter, we record which occurrence you picked. Re-rendering is robust to that, but if you reflow markdown drastically (e.g. re-parse the EPUB with a different parser version) the indices could shift.
- **No syncing** — books and highlights live in this browser's IndexedDB. Use the Download buttons to take things elsewhere.
