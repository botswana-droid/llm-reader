// Markdown rendering + TOC + chapter switching
import { marked } from "https://esm.sh/marked@14.1.3";
import DOMPurify from "https://esm.sh/dompurify@3.1.7";

marked.setOptions({ gfm: true, breaks: false });

export function mdToHtml(md) {
  const raw = marked.parse(md);
  return DOMPurify.sanitize(raw);
}

export function renderToc(listEl, chapters, activeIdx, onPick) {
  listEl.innerHTML = "";
  chapters.forEach((ch, i) => {
    const li = document.createElement("li");
    li.textContent = ch.title;
    li.title = ch.title;
    if (i === activeIdx) li.classList.add("active");
    li.addEventListener("click", () => onPick(i));
    listEl.appendChild(li);
  });
}

export function renderChapter(contentEl, chapter) {
  contentEl.innerHTML = mdToHtml(chapter.md);
  contentEl.scrollIntoView({ block: "start" });
  contentEl.parentElement.scrollTop = 0;
}
