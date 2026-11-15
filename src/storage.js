// IndexedDB persistence: books, meta (key/value), highlights.
// v1 → v2: adds a `highlights` store. Old chats/summaries/quizCards stores
// from v1 stay around untouched (harmless) — they could be dropped in a future v3.
import { openDB } from "https://esm.sh/idb@8.0.0";

const DB_NAME = "llm-reader";
const DB_VERSION = 2;

let dbp;
function getDb() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore("books", { keyPath: "hash" });
          d.createObjectStore("meta", { keyPath: "key" });
          // Stores that v1 used; left in place even after the API pivot to avoid
          // forcing users to re-import everything.
          d.createObjectStore("chats", { keyPath: ["bookHash", "id"] });
          d.createObjectStore("summaries", { keyPath: ["bookHash", "chapterIdx"] });
          d.createObjectStore("quizCards", { keyPath: "id" })
            .createIndex("byBookChapter", ["bookHash", "chapterIdx"]);
        }
        if (oldVersion < 2) {
          const hl = d.createObjectStore("highlights", { keyPath: "id" });
          hl.createIndex("byBook", "bookHash");
          hl.createIndex("byBookChapter", ["bookHash", "chapterIdx"]);
        }
      },
    });
  }
  return dbp;
}

// ── Books ────────────────────────────────────────────────────
export async function saveBook(book) {
  const d = await getDb();
  await d.put("books", book);
  await setMeta("lastBookHash", book.hash);
}

export async function getBook(hash) {
  const d = await getDb();
  return d.get("books", hash);
}

export async function listBooks() {
  const d = await getDb();
  const all = await d.getAll("books");
  return all.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

export async function deleteBook(hash) {
  const d = await getDb();
  await d.delete("books", hash);
  await deleteHighlightsForBook(hash);
}

// ── Highlights ───────────────────────────────────────────────
export async function getHighlights(bookHash, chapterIdx = null) {
  const d = await getDb();
  if (chapterIdx == null) {
    return (await d.getAllFromIndex("highlights", "byBook", bookHash))
      .sort(highlightOrder);
  }
  return (await d.getAllFromIndex("highlights", "byBookChapter", [bookHash, chapterIdx]))
    .sort(highlightOrder);
}

export async function getAllHighlightsForBook(bookHash) {
  return getHighlights(bookHash, null);
}

export async function saveHighlight(h) {
  const d = await getDb();
  await d.put("highlights", h);
}

export async function deleteHighlight(id) {
  const d = await getDb();
  await d.delete("highlights", id);
}

export async function deleteHighlightsForBook(bookHash) {
  const d = await getDb();
  const tx = d.transaction("highlights", "readwrite");
  const idx = tx.store.index("byBook");
  let cursor = await idx.openCursor(bookHash);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

function highlightOrder(a, b) {
  if (a.chapterIdx !== b.chapterIdx) return a.chapterIdx - b.chapterIdx;
  if (a.occurrenceIndex !== b.occurrenceIndex) return a.occurrenceIndex - b.occurrenceIndex;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

// ── Meta (key/value) ─────────────────────────────────────────
export async function getMeta(key) {
  const d = await getDb();
  const r = await d.get("meta", key);
  return r?.value;
}

export async function setMeta(key, value) {
  const d = await getDb();
  await d.put("meta", { key, value });
}

export async function getPreferences() {
  return (await getMeta("preferences")) || {};
}

export async function setPreferences(patch) {
  const cur = await getPreferences();
  await setMeta("preferences", { ...cur, ...patch });
}
