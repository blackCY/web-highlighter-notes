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
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];
let selectedMedia = null;
let activeAnnotationId = null;
let activeWeight = "normal";
let pendingLevel = null;
let pendingRange = null;
let toastTimer;
const mediaBadges = new Map();
const textNoteBadges = new Map();
const textTypeBadges = new Map();

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
      if (!node.nodeValue.trim() || node.parentElement?.closest("#web-notes-toolbar, #web-notes-note-editor, #web-notes-media-toolbar, #web-notes-media-badges, #web-notes-text-note-badges, #web-notes-text-type-badges, #web-notes-toast")) return NodeFilter.FILTER_REJECT;
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
    applyMarkStyle(mark, annotation);
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

function applyMarkStyle(mark, annotation) {
  const isHeading = annotation.type === "heading";
  mark.classList.toggle("web-notes-heading-highlight", isHeading);
  if (isHeading) {
    const headingLevel = Math.max(1, Math.min(6, annotation.headingLevel || 1));
    mark.dataset.webNotesHeading = headingLevel;
    mark.style.backgroundColor = "transparent";
    mark.style.fontWeight = "700";
    mark.style.textDecorationLine = "none";
    mark.style.fontSize = `${Math.max(1.05, 2 - headingLevel * 0.12)}em`;
    return;
  }
  delete mark.dataset.webNotesHeading;
  mark.style.backgroundColor = annotation.color;
  mark.style.fontWeight = annotation.weight === "bold" ? "700" : "inherit";
  mark.style.textDecorationLine = "underline";
  mark.style.textDecorationThickness = annotation.weight === "bold" ? "3px" : "1px";
  mark.style.textUnderlineOffset = "2px";
  mark.style.fontSize = "inherit";
}

function applyAnnotationStyle(annotation) {
  document.querySelectorAll(`mark[data-web-notes-id="${annotation.id}"]`).forEach((mark) => applyMarkStyle(mark, annotation));
}

function setDeleteAvailability(visible) {
  const button = document.getElementById("web-notes-delete");
  if (button) button.hidden = !visible;
}

function removeAnnotationMarks(annotationId) {
  document.querySelectorAll(`mark[data-web-notes-id="${annotationId}"]`).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
}

async function deleteActiveAnnotation() {
  if (!activeAnnotationId) return;
  if (!confirm("确定删除这条笔记吗？此操作会移除网页标记和本地记录。")) return;
  const items = await annotations();
  const annotation = items.find((item) => item.id === activeAnnotationId);
  if (!annotation) return;
  await persist(items.filter((item) => item.id !== activeAnnotationId));
  removeAnnotationMarks(annotation.id);
  const updatedItems = await annotations();
  renderTextNoteBadges(updatedItems);
  renderTextTypeBadges(updatedItems);
  activeAnnotationId = null;
  window.getSelection()?.removeAllRanges();
  setDeleteAvailability(false);
  document.getElementById("web-notes-toolbar").hidden = true;
  showToast("已删除笔记");
}

function annotationBadgeTypes(annotation) {
  if (annotation.badgeTypes?.length) return [...new Set(annotation.badgeTypes)];
  if (annotation.type === "heading") return [`h${annotation.headingLevel}`];
  if (annotation.level === "note") return [annotation.weight === "bold" ? "bold" : "normal"];
  return [annotation.level];
}

function mergedBadgeTypes(annotation, type) {
  return [...new Set([...annotationBadgeTypes(annotation), type])];
}

function personalNotes(annotation) {
  if (Object.hasOwn(annotation, "personalNotes")) return annotation.personalNotes || {};
  if ((annotation.level === "idea" || annotation.level === "question") && annotation.note) {
    return { [annotation.level]: annotation.note };
  }
  return {};
}

function annotationNoteLabels(annotation) {
  const personal = personalNotes(annotation);
  const labels = [];
  if (personal.idea) labels.push(`我的想法：${personal.idea}`);
  if (personal.question) labels.push(`我的疑问：${personal.question}`);
  const isLegacyPersonalNote = !Object.hasOwn(annotation, "personalNotes") && (annotation.level === "idea" || annotation.level === "question");
  if (annotation.note && !isLegacyPersonalNote) labels.push(`我的笔记：${annotation.note}`);
  return labels;
}

function positionTextNoteBadges() {
  for (const { badges, mark } of textNoteBadges.values()) {
    const bounds = mark.getBoundingClientRect();
    const visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom >= 0 && bounds.right >= 0 && bounds.top <= window.innerHeight && bounds.left <= window.innerWidth;
    badges.forEach((badge) => { badge.hidden = !visible; });
    if (!visible) continue;
    let top = bounds.bottom + 6;
    badges.forEach((badge) => {
      badge.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - badge.offsetWidth - 8))}px`;
      badge.style.top = `${Math.max(8, Math.min(top, window.innerHeight - badge.offsetHeight - 8))}px`;
      top += badge.offsetHeight + 4;
    });
  }
}

function renderTextNoteBadges(items) {
  const container = document.getElementById("web-notes-text-note-badges");
  container.replaceChildren();
  textNoteBadges.clear();
  items.filter((annotation) => annotation.type === "text").forEach((annotation) => {
    const labels = annotationNoteLabels(annotation);
    if (!labels.length) return;
    const marks = [...document.querySelectorAll(`mark[data-web-notes-id="${annotation.id}"]`)];
    const mark = marks.at(-1);
    if (!mark) return;
    const badges = labels.map((label) => {
      const badge = document.createElement("span");
      badge.className = "web-notes-text-note-badge";
      badge.textContent = label;
      container.append(badge);
      return badge;
    });
    textNoteBadges.set(annotation.id, { badges, mark });
  });
  positionTextNoteBadges();
}

function annotationTypeBadge(annotation, type) {
  if (/^h[1-6]$/.test(type)) return { label: type.toUpperCase(), color: "#7c3aed" };
  if (type === "important") {
    const colors = { "#fecaca": "#dc2626", "#bbf7d0": "#16a34a", "#fed7aa": "#ea580c" };
    return { label: "重要", color: colors[annotation.color] || "#dc2626" };
  }
  if (type === "idea") return { label: "想法", color: "#15803d" };
  if (type === "question") return { label: "疑问", color: "#2563eb" };
  return { label: type === "bold" ? "加粗" : "默认", color: "#64748b" };
}

function positionTextTypeBadges() {
  for (const { badges, mark } of textTypeBadges.values()) {
    const bounds = mark.getBoundingClientRect();
    const visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom >= 0 && bounds.right >= 0 && bounds.top <= window.innerHeight && bounds.left <= window.innerWidth;
    badges.forEach((badge) => { badge.hidden = !visible; });
    if (!visible) continue;
    let top = bounds.top - 6;
    [...badges].reverse().forEach((badge) => {
      top -= badge.offsetHeight;
      badge.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - badge.offsetWidth - 8))}px`;
      badge.style.top = `${Math.max(8, top)}px`;
      top -= 4;
    });
  }
}

function renderTextTypeBadges(items) {
  const container = document.getElementById("web-notes-text-type-badges");
  container.replaceChildren();
  textTypeBadges.clear();
  items.filter((annotation) => annotation.type === "text" || annotation.type === "heading").forEach((annotation) => {
    const marks = [...document.querySelectorAll(`mark[data-web-notes-id="${annotation.id}"]`)];
    const mark = marks[0];
    if (!mark) return;
    const badges = annotationBadgeTypes(annotation).map((type) => {
      const badgeType = annotationTypeBadge(annotation, type);
      const badge = document.createElement("span");
      badge.className = "web-notes-text-type-badge";
      badge.textContent = badgeType.label;
      badge.style.backgroundColor = badgeType.color;
      container.append(badge);
      return badge;
    });
    textTypeBadges.set(annotation.id, { badges, mark });
  });
  positionTextTypeBadges();
}

function mediaForAnnotation(annotation) {
  const savedElement = nodeFor(annotation.documentPath);
  if (savedElement?.matches?.("img, video, audio")) return savedElement;
  return [...document.querySelectorAll("img, video, audio")].find((media) => {
    const source = media.currentSrc || media.src || media.getAttribute("src") || "";
    return source === annotation.source;
  });
}

function positionMediaBadges() {
  for (const { badge, media } of mediaBadges.values()) {
    const bounds = media.getBoundingClientRect();
    const visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom >= 0 && bounds.right >= 0 && bounds.top <= window.innerHeight && bounds.left <= window.innerWidth;
    badge.hidden = !visible;
    if (!visible) continue;
    badge.style.left = `${Math.max(8, bounds.left + 8)}px`;
    badge.style.top = `${Math.max(8, bounds.top + 8)}px`;
  }
}

function renderMediaBadges(items) {
  const container = document.getElementById("web-notes-media-badges");
  container.replaceChildren();
  mediaBadges.clear();
  items.filter((annotation) => annotation.type === "media").forEach((annotation) => {
    const media = mediaForAnnotation(annotation);
    if (!media) return;
    const badge = document.createElement("span");
    badge.className = "web-notes-media-badge";
    badge.textContent = "已记录";
    badge.title = "此媒体已保存为网页笔记";
    container.append(badge);
    mediaBadges.set(annotation.id, { badge, media });
  });
  positionMediaBadges();
}

function hideMediaToolbar() {
  selectedMedia?.classList.remove("web-notes-media-selected");
  selectedMedia = null;
  const toolbar = document.getElementById("web-notes-media-toolbar");
  if (toolbar) toolbar.hidden = true;
}

async function highlightSelection(level, suppliedRange, note = null) {
  const range = suppliedRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");

  const items = await annotations();
  const existingIndex = items.findIndex((item) => item.id === activeAnnotationId);
  const isPersonalNote = level.id === "idea" || level.id === "question";
  if (existingIndex >= 0) {
    const existing = items[existingIndex];
    const notes = personalNotes(existing);
    if (isPersonalNote && note !== null) notes[level.id] = note;
    const isLegacyPersonalNote = !Object.hasOwn(existing, "personalNotes") && (existing.level === "idea" || existing.level === "question");
    const updated = {
      ...existing, level: level.id, color: level.color, weight: activeWeight, personalNotes: notes,
      note: isPersonalNote && note !== null ? (isLegacyPersonalNote ? "" : existing.note) : (isLegacyPersonalNote ? "" : note ?? existing.note),
      badgeTypes: mergedBadgeTypes(existing, level.badgeType || level.id)
    };
    items[existingIndex] = updated;
    await persist(items);
    applyAnnotationStyle(updated);
    renderTextNoteBadges(items);
    renderTextTypeBadges(items);
    showToast(`已更新为「${level.label}」标记`);
  } else {
    const annotation = {
      id: createId(), type: "text", level: level.id, color: level.color, weight: activeWeight,
      badgeTypes: [level.badgeType || level.id], quote: range.toString().trim(), selector: selectorFor(range),
      createdAt: new Date().toISOString(), note: isPersonalNote ? "" : note ?? "",
      personalNotes: isPersonalNote && note ? { [level.id]: note } : {}
    };
    applyHighlight(range, annotation);
    await save(annotation);
    renderTextNoteBadges(await annotations());
    renderTextTypeBadges(await annotations());
    showToast(`已保存「${level.label}」标记`);
  }

  activeAnnotationId = null;
  window.getSelection()?.removeAllRanges();
  setDeleteAvailability(false);
  document.getElementById("web-notes-toolbar").hidden = true;
}

async function markHeading(headingLevel) {
  const range = currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记为标题的文字");
  const items = await annotations();
  const existingIndex = items.findIndex((item) => item.id === activeAnnotationId);
  if (existingIndex >= 0) {
    const updated = {
      ...items[existingIndex], type: "heading", headingLevel, level: "heading", color: "transparent",
      badgeTypes: mergedBadgeTypes(items[existingIndex], `h${headingLevel}`)
    };
    items[existingIndex] = updated;
    await persist(items);
    applyAnnotationStyle(updated);
    renderTextNoteBadges(items);
    renderTextTypeBadges(items);
    showToast(`已标记为 H${headingLevel}`);
  } else {
    const annotation = {
      id: createId(), type: "heading", headingLevel, level: "heading", color: "transparent", weight: "normal",
      badgeTypes: [`h${headingLevel}`], quote: range.toString().trim(), selector: selectorFor(range),
      createdAt: new Date().toISOString(), note: ""
    };
    applyHighlight(range, annotation);
    await save(annotation);
    const savedItems = await annotations();
    renderTextNoteBadges(savedItems);
    renderTextTypeBadges(savedItems);
    showToast(`已标记为 H${headingLevel}`);
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
  input.value = existing ? personalNotes(existing)[level.id] || "" : "";
  editor.hidden = false;
  const toolbarBounds = document.getElementById("web-notes-toolbar").getBoundingClientRect();
  position(editor, toolbarBounds.left, toolbarBounds.top - editor.offsetHeight - 10);
  input.focus();
}

async function setWeight(weight, updateActiveAnnotation = true) {
  activeWeight = weight;
  document.querySelectorAll(".web-notes-weight").forEach((button) => {
    button.classList.toggle("web-notes-weight-active", button.dataset.weight === weight);
  });
  if (!updateActiveAnnotation || !activeAnnotationId) return;
  const items = await annotations();
  const index = items.findIndex((item) => item.id === activeAnnotationId);
  if (index < 0) return;
  items[index] = { ...items[index], weight, badgeTypes: mergedBadgeTypes(items[index], weight) };
  await persist(items);
  applyAnnotationStyle(items[index]);
  renderTextTypeBadges(items);
  showToast(weight === "bold" ? "已设为加粗" : "已恢复默认字重");
}

async function recordWithWeight(weight) {
  const range = currentSelectionRange();
  await setWeight(weight);
  if (activeAnnotationId) {
    activeAnnotationId = null;
    window.getSelection()?.removeAllRanges();
    setDeleteAvailability(false);
    document.getElementById("web-notes-toolbar").hidden = true;
    return;
  }
  if (!range || !range.toString().trim()) return showToast("请先选择要记录的文字");
  await highlightSelection({ id: "note", label: "笔记", color: "#e5e7eb", badgeType: weight }, range);
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

  const headingGroup = document.createElement("div");
  headingGroup.className = "web-notes-heading-group";
  const headingButton = document.createElement("button");
  headingButton.className = "web-notes-level web-notes-heading-trigger";
  headingButton.textContent = "标题";
  headingButton.addEventListener("mousedown", (event) => { event.preventDefault(); markHeading(1); });
  const headingMenu = document.createElement("div");
  headingMenu.className = "web-notes-heading-menu";
  HEADING_LEVELS.forEach((headingLevel) => {
    const button = document.createElement("button");
    button.className = "web-notes-heading-choice";
    button.textContent = `H${headingLevel}`;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); markHeading(headingLevel); });
    headingMenu.append(button);
  });
  headingGroup.append(headingButton, headingMenu);
  toolbar.append(headingGroup);

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
    button.addEventListener("mousedown", (event) => { event.preventDefault(); recordWithWeight(weight.id); });
    toolbar.append(button);
  });
  const deleteButton = document.createElement("button");
  deleteButton.id = "web-notes-delete";
  deleteButton.className = "web-notes-delete";
  deleteButton.textContent = "删除笔记";
  deleteButton.hidden = true;
  deleteButton.addEventListener("mousedown", (event) => { event.preventDefault(); deleteActiveAnnotation(); });
  toolbar.append(deleteButton);
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
    await renderMediaBadges(await annotations());
    hideMediaToolbar();
    showToast("已保存媒体记录");
  });
  mediaToolbar.append(mediaButton);
  document.documentElement.append(mediaToolbar);

  const mediaBadgesContainer = document.createElement("div");
  mediaBadgesContainer.id = "web-notes-media-badges";
  document.documentElement.append(mediaBadgesContainer);

  const textNoteBadgesContainer = document.createElement("div");
  textNoteBadgesContainer.id = "web-notes-text-note-badges";
  document.documentElement.append(textNoteBadgesContainer);

  const textTypeBadgesContainer = document.createElement("div");
  textTypeBadgesContainer.id = "web-notes-text-type-badges";
  document.documentElement.append(textTypeBadgesContainer);

  const toast = document.createElement("div");
  toast.id = "web-notes-toast";
  document.documentElement.append(toast);
}

async function restore() {
  const items = await annotations();
  for (const annotation of items) {
    if (annotation.type !== "text" && annotation.type !== "heading") continue;
    const range = rangeFor(annotation.selector);
    if (range && range.toString().trim() === annotation.quote) applyHighlight(range, annotation);
  }
  renderTextNoteBadges(items);
  renderTextTypeBadges(items);
  renderMediaBadges(items);
}

document.addEventListener("mouseup", (event) => {
  const range = currentSelectionRange();
  const toolbar = document.getElementById("web-notes-toolbar");
  if (event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor")) return;
  if (!event.target.closest?.("#web-notes-media-toolbar, img, video, audio")) hideMediaToolbar();
  if (!range) return (toolbar.hidden = true);
  closeNoteEditor();
  activeAnnotationId = null;
  setDeleteAvailability(false);
  toolbar.hidden = false;
  position(toolbar, event.clientX, event.clientY + 14);
});

document.addEventListener("click", async (event) => {
  if (!event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor")) closeNoteEditor();
  const mark = event.target.closest?.("mark.web-notes-highlight");
  if (mark) {
    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    activeAnnotationId = mark.dataset.webNotesId;
    setDeleteAvailability(true);
    const annotation = (await annotations()).find((item) => item.id === activeAnnotationId);
    await setWeight(annotation?.weight || "normal", false);
    const toolbar = document.getElementById("web-notes-toolbar");
    toolbar.hidden = false;
    position(toolbar, event.clientX, event.clientY + 14);
    return;
  }

  if (event.target.closest?.("#web-notes-media-toolbar")) return;
  const media = event.target.closest?.("img, video, audio");
  if (!media) {
    hideMediaToolbar();
    return;
  }
  selectedMedia?.classList.remove("web-notes-media-selected");
  selectedMedia = media;
  media.classList.add("web-notes-media-selected");
  const toolbar = document.getElementById("web-notes-media-toolbar");
  toolbar.hidden = false;
  position(toolbar, event.clientX + 12, event.clientY + 12);
}, true);

window.addEventListener("scroll", () => {
  positionMediaBadges();
  positionTextNoteBadges();
  positionTextTypeBadges();
  hideMediaToolbar();
}, true);
window.addEventListener("resize", () => {
  positionMediaBadges();
  positionTextNoteBadges();
  positionTextTypeBadges();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideMediaToolbar();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "UPDATE_ANNOTATION_NOTE") {
    (async () => {
      const items = await annotations();
      const index = items.findIndex((item) => item.id === message.annotationId);
      if (index < 0) return;
      items[index] = { ...items[index], note: String(message.note || "") };
      await persist(items);
      renderTextNoteBadges(items);
    })();
    return;
  }
  if (message.type === "HIGHLIGHT_SELECTION") highlightSelection(message.level);
});

buildUi();
restore();
