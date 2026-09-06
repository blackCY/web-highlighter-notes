const STORAGE_PREFIX = "web-highlighter-notes:";
const LEVELS = [
  { id: "important", label: "重要", color: "#fde68a" },
  { id: "idea", label: "想法", color: "#bbf7d0" },
  { id: "question", label: "疑问", color: "#bfdbfe" },
  { id: "review", label: "复习", color: "#fbcfe8" }
];
let selectedMedia = null;
let toastTimer;

const pageKey = () => `${STORAGE_PREFIX}${location.href.split("#")[0]}`;
const createId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function pathFor(node) {
  const path = [];
  let current = node;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current ? path : null;
}

function nodeFor(path) {
  return path?.reduce((node, index) => node?.childNodes[index], document.body) || null;
}

function selectorFor(range) {
  return {
    startPath: pathFor(range.startContainer), startOffset: range.startOffset,
    endPath: pathFor(range.endContainer), endOffset: range.endOffset
  };
}

function rangeFor(selector) {
  const start = nodeFor(selector.startPath);
  const end = nodeFor(selector.endPath);
  if (!start || !end) return null;
  try {
    const range = document.createRange();
    range.setStart(start, Math.min(selector.startOffset, start.nodeValue?.length ?? start.childNodes.length));
    range.setEnd(end, Math.min(selector.endOffset, end.nodeValue?.length ?? end.childNodes.length));
    return range;
  } catch { return null; }
}

function textNodesIn(range) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim() || node.parentElement?.closest("#web-notes-toolbar, #web-notes-media-toolbar, #web-notes-toast")) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function applyHighlight(range, annotation) {
  for (const node of textNodesIn(range)) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (start >= end || node.parentElement?.closest("mark.web-notes-highlight")) continue;
    const piece = document.createRange();
    piece.setStart(node, start);
    piece.setEnd(node, end);
    const mark = document.createElement("mark");
    mark.className = "web-notes-highlight";
    mark.dataset.webNotesId = annotation.id;
    mark.style.backgroundColor = annotation.color;
    piece.surroundContents(mark);
  }
}

async function annotations() {
  const data = await chrome.storage.local.get(pageKey());
  return data[pageKey()] || [];
}

async function save(annotation) {
  const items = await annotations();
  items.push(annotation);
  await chrome.storage.local.set({ [pageKey()]: items });
}

function showToast(message) {
  const toast = document.getElementById("web-notes-toast");
  toast.textContent = message;
  toast.classList.add("web-notes-toast-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("web-notes-toast-visible"), 1800);
}

function position(toolbar, x, y) {
  toolbar.style.left = `${Math.max(8, Math.min(x, window.innerWidth - toolbar.offsetWidth - 8))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(y, window.innerHeight - toolbar.offsetHeight - 8))}px`;
}

function currentSelectionRange() {
  const selection = window.getSelection();
  return selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null;
}

async function highlightSelection(level, suppliedRange) {
  const range = suppliedRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");
  const annotation = { id: createId(), type: "text", level: level.id, color: level.color, quote: range.toString().trim(), selector: selectorFor(range), createdAt: new Date().toISOString(), note: "" };
  applyHighlight(range, annotation);
  await save(annotation);
  window.getSelection()?.removeAllRanges();
  document.getElementById("web-notes-toolbar").hidden = true;
  showToast(`已保存「${level.label}」标记`);
}

function buildUi() {
  const toolbar = document.createElement("div");
  toolbar.id = "web-notes-toolbar";
  toolbar.hidden = true;
  LEVELS.forEach((level) => {
    const button = document.createElement("button");
    button.className = "web-notes-level";
    button.textContent = level.label;
    button.style.background = level.color;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); highlightSelection(level); });
    toolbar.append(button);
  });
  document.documentElement.append(toolbar);

  const mediaToolbar = document.createElement("div");
  mediaToolbar.id = "web-notes-media-toolbar";
  mediaToolbar.hidden = true;
  const mediaButton = document.createElement("button");
  mediaButton.className = "web-notes-media-button";
  mediaButton.textContent = "记录此媒体";
  mediaButton.addEventListener("click", async () => {
    if (!selectedMedia) return;
    const source = selectedMedia.currentSrc || selectedMedia.src || selectedMedia.getAttribute("src") || "";
    const annotation = { id: createId(), type: "media", mediaType: selectedMedia.tagName.toLowerCase(), source, label: selectedMedia.alt || selectedMedia.getAttribute("aria-label") || selectedMedia.title || "媒体内容", createdAt: new Date().toISOString(), note: "" };
    await save(annotation);
    selectedMedia.classList.remove("web-notes-media-selected");
    selectedMedia = null;
    mediaToolbar.hidden = true;
    showToast("已保存媒体记录");
  });
  mediaToolbar.append(mediaButton);
  document.documentElement.append(mediaToolbar);

  const toast = document.createElement("div");
  toast.id = "web-notes-toast";
  document.documentElement.append(toast);
}

async function restore() {
  for (const annotation of await annotations()) {
    if (annotation.type !== "text") continue;
    const range = rangeFor(annotation.selector);
    if (range && range.toString().trim() === annotation.quote) applyHighlight(range, annotation);
  }
}

document.addEventListener("mouseup", (event) => {
  const range = currentSelectionRange();
  const toolbar = document.getElementById("web-notes-toolbar");
  if (!range || event.target.closest?.("#web-notes-toolbar")) return (toolbar.hidden = true);
  toolbar.hidden = false;
  position(toolbar, event.clientX, event.clientY + 14);
});

document.addEventListener("click", (event) => {
  const media = event.target.closest?.("img, video, audio");
  if (!media || event.target.closest("#web-notes-media-toolbar")) return;
  selectedMedia?.classList.remove("web-notes-media-selected");
  selectedMedia = media;
  media.classList.add("web-notes-media-selected");
  const toolbar = document.getElementById("web-notes-media-toolbar");
  toolbar.hidden = false;
  position(toolbar, event.clientX + 12, event.clientY + 12);
}, true);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "HIGHLIGHT_SELECTION") highlightSelection(message.level);
});

buildUi();
restore();
