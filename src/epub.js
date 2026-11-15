// EPUB → { hash, title, author, chapters: [{title, md}], fullMd }
// Uses JSZip to unzip, parses OPF/NCX manually, converts XHTML → MD via turndown.
//
// Chapter model: one chapter per *top-level* nav entry. Spine files that fall
// within a chapter's range (in spine order) are concatenated, so books that
// pack a whole chapter into one XHTML file with multiple fragment-only nav
// sub-entries get the correct chapter-level title (e.g. "Master Your Emotional
// Self") instead of the last sub-entry ("Step Three").
import JSZip from "https://esm.sh/jszip@3.10.1";
import TurndownService from "https://esm.sh/turndown@7.2.0";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
});

turndown.addRule("dropEmptyImages", {
  filter: (node) => node.nodeName === "IMG" && !node.getAttribute("alt"),
  replacement: () => "",
});

turndown.addRule("dropSvg", {
  filter: "svg",
  replacement: () => "",
});

export async function parseEpub(file) {
  const buf = await file.arrayBuffer();
  const hash = await hashBuffer(buf);

  const zip = await JSZip.loadAsync(buf);
  const opfPath = await findOpfPath(zip);
  const opfDir = dirOf(opfPath);
  const opfXml = await zip.file(opfPath).async("string");
  const opf = new DOMParser().parseFromString(opfXml, "application/xml");

  const title = textOf(opf, "metadata title") || file.name.replace(/\.epub$/i, "");
  const author = textOf(opf, "metadata creator") || "";

  // Build manifest map: id → { fullPath, mediaType }. fullPath is from zip root.
  const manifest = {};
  for (const item of opf.querySelectorAll("manifest > item")) {
    const href = item.getAttribute("href");
    manifest[item.getAttribute("id")] = {
      fullPath: joinPath(opfDir, href),
      mediaType: item.getAttribute("media-type"),
    };
  }

  // Spine: ordered list of HTML spine items with their full paths
  const spine = [...opf.querySelectorAll("spine > itemref")]
    .map(it => it.getAttribute("idref"))
    .map(id => manifest[id])
    .filter(m => m && /html|xhtml|xml/.test(m.mediaType || ""));

  // Top-level nav entries: [{ title, fullPath, fragment? }]
  const navEntries = await loadTopLevelNav(zip, opf, opfDir, manifest);

  // Group spine files into chapters
  const chapterGroups = groupSpineByNav(spine, navEntries);

  // Convert each group to a chapter (concatenated markdown)
  const chapters = [];
  for (const group of chapterGroups) {
    let combined = "";
    for (const item of group.spineItems) {
      const f = zip.file(item.fullPath);
      if (!f) continue;
      const html = await f.async("string");
      const md = htmlToMarkdown(html);
      if (md.length < 20) continue;
      combined += (combined ? "\n\n" : "") + md;
    }
    if (combined.length < 40) continue;
    chapters.push({ title: group.title, md: combined });
  }

  // Concatenate into one big markdown for the prompt cache
  const fullMd = chapters
    .map(c => `# ${c.title}\n\n${c.md}`)
    .join("\n\n---\n\n");

  return {
    hash,
    title: title.trim(),
    author: author.trim(),
    chapters,
    fullMd,
    addedAt: Date.now(),
  };
}

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, link, meta").forEach(n => n.remove());
  const bodyHtml = doc.body?.innerHTML ?? html;
  return turndown.turndown(bodyHtml).trim();
}

// Group spine items into chapters using top-level nav entries.
// Each top-level nav entry marks the start of a chapter (in spine order).
// Spine items before the first nav entry become a "Front matter" chapter.
function groupSpineByNav(spine, navEntries) {
  if (!spine.length) return [];

  if (!navEntries.length) {
    // No usable TOC → fall back to one chapter per spine item, using first heading or filename.
    return spine.map((item, i) => ({
      title: titleFromPath(item.fullPath) || `Section ${i + 1}`,
      spineItems: [item],
    }));
  }

  // Map full path → first spine index that matches
  const spineIdxByPath = new Map();
  spine.forEach((s, i) => {
    if (!spineIdxByPath.has(s.fullPath)) spineIdxByPath.set(s.fullPath, i);
  });

  // Each nav entry → spine index where it starts. Dedupe (multiple top-level entries on same file → first wins).
  const starts = [];
  const seenIdx = new Set();
  for (const e of navEntries) {
    const idx = spineIdxByPath.get(e.fullPath);
    if (idx === undefined) continue;
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);
    starts.push({ idx, title: e.title });
  }
  starts.sort((a, b) => a.idx - b.idx);

  if (starts.length === 0) {
    // Nav exists but didn't line up with spine; fall back as if no nav.
    return spine.map((item, i) => ({
      title: titleFromPath(item.fullPath) || `Section ${i + 1}`,
      spineItems: [item],
    }));
  }

  const groups = [];

  // Anything before the first nav start = front matter
  if (starts[0].idx > 0) {
    groups.push({
      title: "Front matter",
      spineItems: spine.slice(0, starts[0].idx),
    });
  }

  // One group per nav top-level entry, spanning to the next entry's start (or spine end)
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].idx;
    const to = i + 1 < starts.length ? starts[i + 1].idx : spine.length;
    groups.push({
      title: starts[i].title,
      spineItems: spine.slice(from, to),
    });
  }

  return groups;
}

// Walk the EPUB3 nav doc or EPUB2 NCX. Returns top-level entries only.
// Each: { title, fullPath } (fragment stripped — chapters are file-level).
async function loadTopLevelNav(zip, opf, opfDir, manifest) {
  // EPUB3 nav
  const navItem = [...opf.querySelectorAll("manifest > item")]
    .find(i => (i.getAttribute("properties") || "").split(/\s+/).includes("nav"));
  if (navItem) {
    const navFullPath = joinPath(opfDir, navItem.getAttribute("href"));
    const navDir = dirOf(navFullPath);
    const navHtml = await zip.file(navFullPath)?.async("string");
    if (navHtml) {
      const entries = parseEpub3Nav(navHtml, navDir);
      if (entries.length) return entries;
    }
  }

  // EPUB2 NCX
  const spineEl = opf.querySelector("spine");
  const ncxId = spineEl?.getAttribute("toc");
  if (ncxId && manifest[ncxId]) {
    const ncxFullPath = manifest[ncxId].fullPath;
    const ncxDir = dirOf(ncxFullPath);
    const ncxXml = await zip.file(ncxFullPath)?.async("string");
    if (ncxXml) {
      const entries = parseNcx(ncxXml, ncxDir);
      if (entries.length) return entries;
    }
  }

  return [];
}

function parseEpub3Nav(html, navDir) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Prefer <nav epub:type="toc"> — but namespaces are inconsistent in EPUBs.
  const allNavs = [...doc.querySelectorAll("nav")];
  const tocNav = allNavs.find(n => {
    const t = (n.getAttribute("epub:type")
              || n.getAttributeNS("http://www.idpf.org/2007/ops", "type")
              || "").toLowerCase();
    return t.includes("toc");
  }) || allNavs[0];
  if (!tocNav) return [];

  // Top-level <ol> directly under the nav element
  const topOl = [...tocNav.children].find(c => c.tagName === "OL");
  if (!topOl) return [];

  const entries = [];
  for (const li of topOl.children) {
    if (li.tagName !== "LI") continue;
    // Get the <a> that's a direct child (or wrapped in a span). Skip <a>s deeper inside a child <ol>.
    const a = directChildAnchor(li);
    if (!a) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    const title = (a.textContent || "").trim();
    if (!title) continue;
    const fullPath = joinPath(navDir, stripFragment(href));
    entries.push({ title, fullPath });
  }
  return entries;
}

function directChildAnchor(li) {
  for (const c of li.children) {
    if (c.tagName === "A") return c;
    if (c.tagName === "SPAN") {
      const a = [...c.children].find(x => x.tagName === "A");
      if (a) return a;
    }
  }
  return null;
}

function parseNcx(xml, ncxDir) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const navMap = doc.querySelector("navMap");
  if (!navMap) return [];
  const entries = [];
  for (const np of navMap.children) {
    if ((np.localName || np.tagName) !== "navPoint") continue;
    const label = directChild(np, "navLabel");
    const text = label ? directChild(label, "text") : null;
    const content = directChild(np, "content");
    const title = text?.textContent.trim();
    const src = content?.getAttribute("src");
    if (title && src) {
      entries.push({ title, fullPath: joinPath(ncxDir, stripFragment(src)) });
    }
  }
  return entries;
}

function directChild(el, localName) {
  for (const c of el.children) {
    if ((c.localName || c.tagName) === localName) return c;
  }
  return null;
}

async function findOpfPath(zip) {
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (!container) throw new Error("Not a valid EPUB: missing META-INF/container.xml");
  const doc = new DOMParser().parseFromString(container, "application/xml");
  const root = doc.querySelector("rootfile");
  if (!root) throw new Error("Not a valid EPUB: no rootfile in container.xml");
  return root.getAttribute("full-path");
}

function textOf(opf, selector) {
  const [parent, tag] = selector.split(" ");
  const md = opf.querySelector(parent);
  if (!md) return "";
  for (const child of md.children) {
    const local = child.localName || child.tagName.split(":").pop();
    if (local === tag) return child.textContent;
  }
  return "";
}

function titleFromPath(p) {
  const name = p.split("/").pop().replace(/\.[^.]+$/, "");
  return name.replace(/[-_]+/g, " ").replace(/^\d+\s*/, "");
}

function stripFragment(href) { return href.split("#")[0]; }

function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

// Join two path parts and normalize ../ and ./ segments. Result is a path from zip root.
function joinPath(base, rel) {
  if (!rel) return base;
  if (rel.startsWith("/")) return normalizePath(rel.slice(1));
  return normalizePath((base || "") + rel);
}

function normalizePath(p) {
  const segs = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { segs.pop(); continue; }
    segs.push(s);
  }
  return segs.join("/");
}

async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
