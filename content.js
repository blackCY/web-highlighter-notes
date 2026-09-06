const STORAGE_PREFIX = "web-highlighter-notes:";
const LEVELS = [
  { id: "important", label: "重要", color: "#fecaca" },
  { id: "idea", label: "想法", color: "#bbf7d0" },
  { id: "question", label: "疑问", color: "#bfdbfe" }
];
const IMPORTANT_COLORS = [
  { label: "红色", color: "#fecaca" },
  { label: "绿色", color: "#bbf7d0" },
  { label: "橙色", color: "#fed7aa" }
];
let selectedMedia = null;
let activeAnnotationId = null;
let activeWeight = "normal";
let pendingLevel = null;
let pendingRange = null;
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
      if (!node.nodeValue.trim() || node.parentElement?.closest("#web-notes-toolbar, #web-notes-note-editor, #web-notes-media-toolbar, #web-notes-toast")) return NodeFilter.FILTER_REJECT;
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

async function persist(items) {
  await chrome.storage.local.set({ [pageKey()]: items });
}

async function save(annotation) {
  const items = await annotations();
  items.push(annotation);
  await persist(items);
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

function applyAnnotationStyle(annotation) {
  document.querySelectorAll(`mark[data-web-notes-id="${annotation.id}"]`).forEach((mark) => {
    mark.style.backgroundColor = annotation.color;
  });
}

async function highlightSelection(level, suppliedRange, note = "") {
  const range = suppliedRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");

  const items = await annotations();
  const existingIndex = items.findIndex((item) => item.id === activeAnnotationId);
  if (existingIndex >= 0) {
    const updated = { ...items[existingIndex], level: level.id, color: level.color, weight: activeWeight, note };
    items[existingIndex] = updated;
    await persist(items);
    applyAnnotationStyle(updated);
    showToast(`已更新为「${level.label}」标记`);
  } else {
    const annotation = {
      id: createId(), type: "text", level: level.id, color: level.color, weight: activeWeight,
      quote: range.toString().trim(), selector: selectorFor(range), createdAt: new Date().toISOString(), note
    };
    applyHighlight(range, annotation);
    await save(annotation);
    showToast(`已保存「${level.label}」标记`);
  }

  activeAnnotationId = null;
  window.getSelection()?.removeAllRanges();
  document.getElementById("web-notes-toolbar").hidden = true;
}

function closeNoteEditor() {
  document.getElementById("web-notes-note-editor").hidden = true;
  pendingLevel = null;
  pendingRange = null;
}

async function openNoteEditor(level) {
  const range = currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");
  const existing = (await annotations()).find((item) => item.id === activeAnnotationId);
  pendingLevel = level;
  pendingRange = range;
  const editor = document.getElementById("web-notes-note-editor");
  editor.querySelector("strong").textContent = level.id === "idea" ? "我的想法" : "我的疑问";
  const input = editor.querySelector("textarea");
  input.placeholder = level.id === "idea" ? "写下你的想法…" : "写下你的疑问…";
  input.value = existing?.note || "";
  editor.hidden = false;
  const toolbarBounds = document.getElementById("web-notes-toolbar").getBoundingClientRect();
  position(editor, toolbarBounds.left, toolbarBounds.top - editor.offsetHeight - 10);
  input.focus();
}

function setWeight(weight) {
  activeWeight = weight;
  document.querySelectorAll(".web-notes-weight").forEach((button) => {
    button.classList.toggle("web-notes-weight-active", button.dataset.weight === weight);
  });
}

function levelButton(level, className = "web-notes-level") {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = level.label;
  button.style.background = level.color;
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (level.id === "idea" || level.id === "question") openNoteEditor(level);
    else highlightSelection(level);
  });
  return button;
}

function buildUi() {
  const toolbar = document.createElement("div");
  toolbar.id = "web-notes-toolbar";
  toolbar.hidden = true;

  const importantGroup = document.createElement("div");
  importantGroup.className = "web-notes-important-group";
  importantGroup.append(levelButton(LEVELS[0]));
  const colorMenu = document.createElement("div");
  colorMenu.className = "web-notes-color-menu";
  IMPORTANT_COLORS.forEach((choice) => {
    const button = document.createElement("button");
    button.className = "web-notes-color-choice";
    button.style.backgroundColor = choice.color;
    button.title = `${choice.label}重要标记`;
    button.setAttribute("aria-label", `${choice.label}重要标记`);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      highlightSelection({ id: "important", label: "重要", color: choice.color });
    });
    colorMenu.append(button);
  });
  importantGroup.append(colorMenu);
  toolbar.append(importantGroup);
  toolbar.append(levelButton(LEVELS[1]));
  toolbar.append(levelButton(LEVELS[2]));

  const divider = document.createElement("span");
  divider.className = "web-notes-divider";
  toolbar.append(divider);
  [
    { id: "normal", label: "默认" },
    { id: "bold", label: "加粗" }
  ].forEach((weight) => {
    const button = document.createElement("button");
    button.className = "web-notes-weight";
    button.dataset.weight = weight.id;
    button.textContent = weight.label;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); setWeight(weight.id); });
    toolbar.append(button);
  });
  document.documentElement.append(toolbar);
  setWeight(activeWeight);

  const noteEditor = document.createElement("div");
  noteEditor.id = "web-notes-note-editor";
  noteEditor.className = "web-notes-note-editor";
  noteEditor.hidden = true;
  const title = document.createElement("strong");
  const input = document.createElement("textarea");
  input.maxLength = 2000;
  const actions = document.createElement("div");
  actions.className = "web-notes-note-actions";
  const cancel = document.createElement("button");
  cancel.className = "web-notes-note-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("mousedown", (event) => { event.preventDefault(); closeNoteEditor(); });
  const confirm = document.createElement("button");
  confirm.className = "web-notes-note-confirm";
  confirm.textContent = "保存笔记";
  confirm.addEventListener("mousedown", async (event) => {
    event.preventDefault();
    if (!pendingLevel || !pendingRange) return;
    const level = pendingLevel;
    const range = pendingRange;
    const note = input.value.trim();
    closeNoteEditor();
    await highlightSelection(level, range, note);
  });
  actions.append(cancel, confirm);
  noteEditor.append(title, input, actions);
  document.documentElement.append(noteEditor);

  const mediaToolbar = document.createElement("div");
  mediaToolbar.id = "web-notes-media-toolbar";
  mediaToolbar.hidden = true;
  const mediaButton = document.createElement("button");
  mediaButton.className = "web-notes-media-button";
  mediaButton.textContent = "记录此媒体";
  mediaButton.addEventListener("click", async () => {
    if (!selectedMedia) return;
    const source = selectedMedia.currentSrc || selectedMedia.src || selectedMedia.getAttribute("src") || "";
    const annotation = {
      id: createId(), type: "media", mediaType: selectedMedia.tagName.toLowerCase(), source,
      label: selectedMedia.alt || selectedMedia.getAttribute("aria-label") || selectedMedia.title || "媒体内容",
      documentPath: pathFor(selectedMedia), createdAt: new Date().toISOString(), note: ""
    };
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
  if (event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor")) return;
  if (!range) return (toolbar.hidden = true);
  closeNoteEditor();
  activeAnnotationId = null;
  toolbar.hidden = false;
  position(toolbar, event.clientX, event.clientY + 14);
});

document.addEventListener("click", (event) => {
  const mark = event.target.closest?.("mark.web-notes-highlight");
  if (mark) {
    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    activeAnnotationId = mark.dataset.webNotesId;
    const toolbar = document.getElementById("web-notes-toolbar");
    toolbar.hidden = false;
    position(toolbar, event.clientX, event.clientY + 14);
    return;
  }

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
