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
let pendingAnnotationId = null;
let toolbarRange = null;
let contextMenuRange = null;
let toastTimer;
let mediaToolbarTimer;
let cachedAnnotations = null;
let restoreTimer;
let noteActionQueue = Promise.resolve();
const mediaBadges = new Map();
const textNoteBadges = new Map();
const textTypeBadges = new Map();

const pageUrl = () => {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  return url.href;
};

function pageFavicon() {
  const icon = [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')]
    .map((link) => link.href)
    .find(Boolean);
  return icon || new URL("/favicon.ico", location.href).href;
}
const createId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function elementFor(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function locatorFor(element) {
  const idElement = element?.closest?.("[id]");
  if (idElement?.id) return { type: "id", value: idElement.id };
  const classElement = [element, ...(element?.parents || [])].find((candidate) => candidate?.classList?.length);
  const classNames = classElement ? [...classElement.classList].filter((className) => !className.startsWith("web-notes-")) : [];
  if (classElement && classNames.length) return { type: "class", tagName: classElement.tagName.toLowerCase(), classNames };
  return { type: "tag", tagName: element?.tagName?.toLowerCase() || "body" };
}

function rootForRange(range) {
  const commonElement = elementFor(range.commonAncestorContainer) || document.body;
  return commonElement.closest("[id]") || [commonElement, ...commonElement.parents].find((element) => element.classList?.length) || commonElement;
}

function textOffset(root, container, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

function contextForRange(range, root) {
  const text = root.textContent || "";
  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  return { start, end, prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80) };
}

function selectorFor(range) {
  const root = rootForRange(range);
  const context = contextForRange(range, root);
  const selectedText = (root.textContent || "").slice(context.start, context.end);
  const leadingWhitespace = selectedText.match(/^\s*/)[0].length;
  const trailingWhitespace = selectedText.match(/\s*$/)[0].length;
  const start = context.start + leadingWhitespace;
  const end = context.end - trailingWhitespace;
  const text = root.textContent || "";
  return {
    anchor: locatorFor(root),
    start,
    end,
    prefix: text.slice(Math.max(0, start - 80), start),
    suffix: text.slice(end, end + 80),
    order: [...document.querySelectorAll("*")].indexOf(root)
  };
}

function rootsForLocator(locator) {
  if (!locator) return [];
  if (locator.type === "id") {
    const element = document.getElementById(locator.value);
    return element ? [element] : [];
  }
  if (locator.type === "class" && locator.classNames?.length) {
    return [...document.getElementsByClassName(locator.classNames[0])].filter((element) => (
      (!locator.tagName || element.tagName.toLowerCase() === locator.tagName)
      && locator.classNames.every((className) => element.classList.contains(className))
    ));
  }
  return locator.tagName ? [...document.getElementsByTagName(locator.tagName)] : [];
}

function commonPrefixLength(left, right) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[left.length - index - 1] === right[right.length - index - 1]) index += 1;
  return index;
}

function bestTextMatch(text, expectedText, selector) {
  const contextScore = (index) => {
    const prefix = text.slice(Math.max(0, index - (selector.prefix || "").length), index);
    const suffix = text.slice(index + expectedText.length, index + expectedText.length + (selector.suffix || "").length);
    return commonSuffixLength(selector.prefix || "", prefix) + commonPrefixLength(selector.suffix || "", suffix);
  };
  const expectedContextLength = (selector.prefix || "").length + (selector.suffix || "").length;
  if (text.slice(selector.start, selector.start + expectedText.length) === expectedText
    && (!expectedContextLength || contextScore(selector.start) === expectedContextLength)) return selector.start;
  const matches = [];
  for (let index = text.indexOf(expectedText); index >= 0; index = text.indexOf(expectedText, index + 1)) matches.push(index);
  if (!matches.length) return -1;
  return matches.reduce((best, index) => {
    const score = contextScore(index);
    const distance = Math.abs(index - (selector.start || 0));
    if (!best || score > best.score || (score === best.score && distance < best.distance)) return { index, score, distance };
    return best;
  }, null).index;
}

function textNodeAtOffset(root, textOffsetValue) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = textOffsetValue;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (remaining <= node.nodeValue.length) return { node, offset: remaining };
    remaining -= node.nodeValue.length;
  }
  return null;
}

function rangeForText(root, selector, quote) {
  const text = root.textContent || "";
  const expectedText = quote || text.slice(selector.start, selector.end);
  if (!expectedText) return null;
  const start = bestTextMatch(text, expectedText, selector);
  if (start < 0) return null;
  const startPoint = textNodeAtOffset(root, start);
  const endPoint = textNodeAtOffset(root, start + expectedText.length);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function textNodesIn(range) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim() || node.parentElement?.closest("script, style, noscript, template, textarea, input, select, option, [contenteditable], #web-notes-toolbar, #web-notes-note-editor, #web-notes-media-toolbar, #web-notes-media-badges, #web-notes-text-note-badges, #web-notes-text-type-badges, #web-notes-toast")) return NodeFilter.FILTER_REJECT;
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
    if (start >= end) continue;
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

function highlightDuplicateRange(range) {
  const selectedText = range.toString().trim();
  return [...document.querySelectorAll("mark.web-notes-highlight")].find((mark) => (
    range.intersectsNode(mark) && selectedText === mark.textContent.trim()
  )) || null;
}

function sameAnnotationRange(left, right) {
  if (!left || !right || left.quote !== right.quote) return false;
  if (!(["text", "heading"].includes(left.type) && ["text", "heading"].includes(right.type))) return false;
  const leftSelector = left.selector || {};
  const rightSelector = right.selector || {};
  return leftSelector.start === rightSelector.start
    && leftSelector.end === rightSelector.end
    && leftSelector.order === rightSelector.order
    && JSON.stringify(leftSelector.anchor || null) === JSON.stringify(rightSelector.anchor || null);
}

async function annotations() {
  if (cachedAnnotations) return cachedAnnotations;
  const response = await githubNotesRequest("GET_GITHUB_NOTES", { pageUrl: pageUrl(), pageTitle: document.title });
  cachedAnnotations = response?.annotations || [];
  return cachedAnnotations;
}

async function persist(items, changedAnnotations = [], deletedAnnotationIds = []) {
  const notes = await githubNotesRequest("SAVE_GITHUB_NOTES", {
    pageUrl: pageUrl(), pageTitle: document.title, pageFavicon: pageFavicon(), annotations: items, changedAnnotations, deletedAnnotationIds
  });
  cachedAnnotations = notes.annotations;
  return cachedAnnotations;
}

async function githubNotesRequest(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "GitHub 笔记请求失败");
  return response.data;
}

async function save(annotation) {
  const items = await annotations();
  await persist([...items, annotation], [annotation]);
}

function showToast(message) {
  const toast = document.getElementById("web-notes-toast");
  toast.textContent = message;
  toast.classList.add("web-notes-toast-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("web-notes-toast-visible"), 1800);
}

function hideMarkdownPreview() {
  document.getElementById("web-notes-markdown-preview")?.setAttribute("hidden", "");
}

function escapePreviewHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function previewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function renderMarkdownInline(value) {
  const tokens = [];
  const token = (html) => `@@WEB_NOTES_PREVIEW_${tokens.push(html) - 1}@@`;
  let source = String(value || "");
  source = source.replace(/<span style="([^"]+)">([\s\S]*?)<\/span>/g, (_match, style, content) => {
    const safeStyle = /^[#\w\s:;(),.%+-]+$/.test(style) ? style : "";
    return token(`<span${safeStyle ? ` style="${safeStyle}"` : ""}>${renderMarkdownInline(content)}</span>`);
  });
  source = source.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_match, label, url) => {
    const safeUrl = previewUrl(url);
    return token(safeUrl ? `<img src="${escapePreviewHtml(safeUrl)}" alt="${escapePreviewHtml(label)}">` : escapePreviewHtml(label));
  });
  source = source.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_match, label, url) => {
    const safeUrl = previewUrl(url);
    return token(safeUrl ? `<a href="${escapePreviewHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapePreviewHtml(label)}</a>` : escapePreviewHtml(label));
  });
  source = escapePreviewHtml(source)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\\([\\`*_[\]<>])/g, "$1");
  return source.replace(/@@WEB_NOTES_PREVIEW_(\d+)@@/g, (_match, index) => tokens[Number(index)] || "");
}

function renderMarkdownPreview(markdown) {
  return String(markdown || "").split(/\r?\n/).map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) return `<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`;
    const item = line.match(/^(\s*)-\s+(.+)$/);
    if (item) return `<div class="web-notes-markdown-list" style="padding-left:${Math.min(48, item[1].length * 12)}px">• ${renderMarkdownInline(item[2])}</div>`;
    if (!line.trim()) return "<div class=\"web-notes-markdown-gap\"></div>";
    return `<p>${renderMarkdownInline(line)}</p>`;
  }).join("");
}

function showMarkdownPreview(markdown) {
  let preview = document.getElementById("web-notes-markdown-preview");
  if (!preview) {
    preview = document.createElement("aside");
    preview.id = "web-notes-markdown-preview";
    preview.setAttribute("aria-label", "Markdown 预览");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Markdown 预览";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", hideMarkdownPreview);
    const content = document.createElement("div");
    content.id = "web-notes-markdown-preview-content";
    header.append(title, close);
    preview.append(header, content);
    document.documentElement.append(preview);
  }
  preview.querySelector("#web-notes-markdown-preview-content").innerHTML = renderMarkdownPreview(markdown);
  preview.hidden = false;
}

function locateAnnotation(annotationId) {
  return annotations().then(async (items) => {
    const annotation = items.find((item) => item.id === annotationId);
    if (!annotation) return showToast("未找到此笔记");
    let target = annotation.type === "media"
      ? mediaForAnnotation(annotation)
      : document.querySelector(`mark[data-web-notes-id="${annotation.id}"]`);
    if (!target && annotation.type !== "media") {
      await restore();
      target = document.querySelector(`mark[data-web-notes-id="${annotation.id}"]`);
    }
    if (!target) return showToast("网页中暂时无法定位此笔记");
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    target.classList.add("web-notes-locate-target");
    setTimeout(() => target.classList.remove("web-notes-locate-target"), 1600);
  });
}

function showNoteError(error) {
  console.warn("Web Highlighter Notes 操作失败：", error);
  if (/Extension context invalidated/i.test(error.message)) {
    showToast("扩展已更新，请刷新当前网页后再操作");
    return;
  }
  showToast(`笔记操作失败：${error.message}`);
}

function runNoteAction(action) {
  noteActionQueue = noteActionQueue.catch(() => {}).then(action).catch(showNoteError);
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
  mark.classList.remove("web-notes-heading-highlight");
  if (isHeading) {
    delete mark.dataset.webNotesHeading;
    mark.style.backgroundColor = "#c4b5fd";
    mark.style.fontWeight = "inherit";
    mark.style.textDecorationLine = "none";
    mark.style.textDecorationThickness = "";
    mark.style.textUnderlineOffset = "";
    mark.style.fontSize = "inherit";
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
  const noteButton = document.getElementById("web-notes-add-note");
  if (noteButton) noteButton.hidden = !visible;
  if (!visible) hideDeleteConfirmation();
}

function hideDeleteConfirmation() {
  const confirmation = document.getElementById("web-notes-delete-confirm");
  if (confirmation) confirmation.hidden = true;
}

function showDeleteConfirmation() {
  if (!activeAnnotationId) return;
  const confirmation = document.getElementById("web-notes-delete-confirm");
  const button = document.getElementById("web-notes-delete");
  if (!confirmation || !button) return;
  confirmation.hidden = false;
  const bounds = button.getBoundingClientRect();
  position(confirmation, bounds.right - confirmation.offsetWidth, bounds.top - confirmation.offsetHeight - 8);
}

function removeAnnotationMarks(annotationId) {
  document.querySelectorAll(`mark[data-web-notes-id="${annotationId}"]`).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
}

async function deleteActiveAnnotation() {
  if (!activeAnnotationId) return;
  const items = await annotations();
  const annotation = items.find((item) => item.id === activeAnnotationId);
  if (!annotation) return;
  const deletedAnnotationIds = items.filter((item) => sameAnnotationRange(item, annotation)).map((item) => item.id);
  await persist(items.filter((item) => !deletedAnnotationIds.includes(item.id)), [], deletedAnnotationIds);
  deletedAnnotationIds.forEach(removeAnnotationMarks);
  const updatedItems = await annotations();
  renderTextNoteBadges(updatedItems);
  renderTextTypeBadges(updatedItems);
  activeAnnotationId = null;
  toolbarRange = null;
  window.getSelection()?.removeAllRanges();
  hideDeleteConfirmation();
  setDeleteAvailability(false);
  document.getElementById("web-notes-toolbar").hidden = true;
  showToast(deletedAnnotationIds.length > 1 ? "已删除重复笔记" : "已删除笔记");
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
  const savedElement = rootsForLocator(annotation.locator)[0];
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
  const badgesByMedia = new Map();
  items.filter((annotation) => annotation.type === "media").forEach((annotation) => {
    const media = mediaForAnnotation(annotation);
    if (!media) return;
    const existing = badgesByMedia.get(media);
    if (existing) {
      mediaBadges.set(annotation.id, existing);
      return;
    }
    const badge = document.createElement("span");
    badge.className = "web-notes-media-badge";
    badge.textContent = "已记录";
    badge.title = "此媒体已保存为网页笔记";
    container.append(badge);
    const entry = { badge, media };
    badgesByMedia.set(media, entry);
    mediaBadges.set(annotation.id, entry);
  });
  positionMediaBadges();
}

function mediaAnnotationsFor(media) {
  const annotationIds = new Set([...mediaBadges.entries()]
    .filter(([, entry]) => entry.media === media)
    .map(([annotationId]) => annotationId));
  return cachedAnnotations?.filter((annotation) => (
    annotation.type === "media" && (annotationIds.has(annotation.id) || mediaForAnnotation(annotation) === media)
  )) || [];
}

function hideMediaToolbar() {
  clearTimeout(mediaToolbarTimer);
  selectedMedia?.classList.remove("web-notes-media-selected");
  selectedMedia = null;
  const toolbar = document.getElementById("web-notes-media-toolbar");
  if (toolbar) toolbar.hidden = true;
}

function showMediaToolbar(media) {
  clearTimeout(mediaToolbarTimer);
  selectedMedia?.classList.remove("web-notes-media-selected");
  selectedMedia = media;
  media.classList.add("web-notes-media-selected");
  const toolbar = document.getElementById("web-notes-media-toolbar");
  const button = document.getElementById("web-notes-media-action");
  const annotations = mediaAnnotationsFor(media);
  button.dataset.annotationIds = annotations.map((annotation) => annotation.id).join(",");
  button.textContent = annotations.length ? "删除此媒体" : "记录此媒体";
  button.classList.toggle("web-notes-media-delete", annotations.length > 0);
  const bounds = media.getBoundingClientRect();
  toolbar.hidden = false;
  position(toolbar, bounds.left + 8, bounds.top + 8);
}

function scheduleHideMediaToolbar() {
  clearTimeout(mediaToolbarTimer);
  mediaToolbarTimer = setTimeout(hideMediaToolbar, 160);
}

async function highlightSelection(level, suppliedRange, note = null) {
  const range = suppliedRange || toolbarRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");

  const items = await annotations();
  const existingIndex = items.findIndex((item) => item.id === activeAnnotationId);
  const isPersonalNote = level.id === "idea" || level.id === "question";
  if (existingIndex < 0 && highlightDuplicateRange(range)) {
    return showToast("选中的文字已有笔记，请点击高亮后再修改");
  }
  if (existingIndex >= 0) {
    const existing = items[existingIndex];
    const notes = { ...personalNotes(existing) };
    if (isPersonalNote && note !== null) notes[level.id] = note;
    const isLegacyPersonalNote = !Object.hasOwn(existing, "personalNotes") && (existing.level === "idea" || existing.level === "question");
    const updated = {
      ...existing, level: level.id, color: level.color, weight: activeWeight, personalNotes: notes,
      note: isPersonalNote && note !== null ? (isLegacyPersonalNote ? "" : existing.note) : (isLegacyPersonalNote ? "" : note ?? existing.note),
      badgeTypes: mergedBadgeTypes(existing, level.badgeType || level.id)
    };
    await persist(items.map((item, index) => index === existingIndex ? updated : item), [updated]);
    applyAnnotationStyle(updated);
    const savedItems = await annotations();
    renderTextNoteBadges(savedItems);
    renderTextTypeBadges(savedItems);
    showToast(`已更新为「${level.label}」标记`);
  } else {
    const annotation = {
      id: createId(), type: "text", level: level.id, color: level.color, weight: activeWeight,
      badgeTypes: [level.badgeType || level.id], quote: range.toString().trim(), selector: selectorFor(range),
      createdAt: new Date().toISOString(), note: isPersonalNote ? "" : note ?? "",
      personalNotes: isPersonalNote && note ? { [level.id]: note } : {}
    };
    await save(annotation);
    applyHighlight(range, annotation);
    renderTextNoteBadges(await annotations());
    renderTextTypeBadges(await annotations());
    showToast(`已保存「${level.label}」标记`);
  }

  activeAnnotationId = null;
  toolbarRange = null;
  window.getSelection()?.removeAllRanges();
  setDeleteAvailability(false);
  document.getElementById("web-notes-toolbar").hidden = true;
}

async function markHeading(headingLevel, suppliedRange) {
  const range = suppliedRange || toolbarRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记为标题的文字");
  const items = await annotations();
  const existingIndex = items.findIndex((item) => item.id === activeAnnotationId);
  if (existingIndex < 0 && highlightDuplicateRange(range)) {
    return showToast("选中的文字已有笔记，请点击高亮后再修改");
  }
  if (existingIndex >= 0) {
    const updated = {
      ...items[existingIndex], type: "heading", headingLevel, level: "heading", color: "transparent",
      badgeTypes: mergedBadgeTypes(items[existingIndex], `h${headingLevel}`)
    };
    await persist(items.map((item, index) => index === existingIndex ? updated : item), [updated]);
    applyAnnotationStyle(updated);
    const savedItems = await annotations();
    renderTextNoteBadges(savedItems);
    renderTextTypeBadges(savedItems);
    showToast(`已标记为 H${headingLevel}`);
  } else {
    const annotation = {
      id: createId(), type: "heading", headingLevel, level: "heading", color: "transparent", weight: "normal",
      badgeTypes: [`h${headingLevel}`], quote: range.toString().trim(), selector: selectorFor(range),
      createdAt: new Date().toISOString(), note: ""
    };
    await save(annotation);
    applyHighlight(range, annotation);
    const savedItems = await annotations();
    renderTextNoteBadges(savedItems);
    renderTextTypeBadges(savedItems);
    showToast(`已标记为 H${headingLevel}`);
  }
  activeAnnotationId = null;
  toolbarRange = null;
  window.getSelection()?.removeAllRanges();
  document.getElementById("web-notes-toolbar").hidden = true;
}

function closeNoteEditor() {
  document.getElementById("web-notes-note-editor").hidden = true;
  pendingLevel = null;
  pendingRange = null;
  pendingAnnotationId = null;
}

async function openNoteEditor(level, suppliedRange) {
  const range = suppliedRange || toolbarRange || currentSelectionRange();
  if (!range || !range.toString().trim()) return showToast("请先选择要标记的文字");
  const existing = (await annotations()).find((item) => item.id === activeAnnotationId);
  pendingLevel = level;
  pendingRange = range;
  pendingAnnotationId = null;
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

async function openAnnotationNoteEditor() {
  if (!activeAnnotationId) return;
  const annotation = (await annotations()).find((item) => item.id === activeAnnotationId);
  if (!annotation) return;
  pendingLevel = null;
  pendingRange = null;
  pendingAnnotationId = annotation.id;
  const editor = document.getElementById("web-notes-note-editor");
  editor.querySelector("strong").textContent = "我的备注";
  const input = editor.querySelector("textarea");
  input.placeholder = "写下你的备注…";
  input.value = annotation.note || "";
  editor.hidden = false;
  const toolbarBounds = document.getElementById("web-notes-toolbar").getBoundingClientRect();
  position(editor, toolbarBounds.left, toolbarBounds.top - editor.offsetHeight - 10);
  input.focus();
}

async function updateAnnotationNote(annotationId, note) {
  const items = await annotations();
  const index = items.findIndex((item) => item.id === annotationId);
  if (index < 0) return;
  const updated = { ...items[index], note };
  await persist(items.map((item, itemIndex) => itemIndex === index ? updated : item), [updated]);
  renderTextNoteBadges(await annotations());
  showToast(note ? "已保存备注" : "已清除备注");
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
  await persist(items, [items[index]]);
  applyAnnotationStyle(items[index]);
  renderTextTypeBadges(items);
  showToast(weight === "bold" ? "已设为加粗" : "已恢复默认字重");
}

async function recordWithWeight(weight, suppliedRange) {
  const range = suppliedRange || toolbarRange || currentSelectionRange();
  await setWeight(weight);
  if (activeAnnotationId) {
    activeAnnotationId = null;
    toolbarRange = null;
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
    const range = toolbarRange;
    runNoteAction(() => (level.id === "idea" || level.id === "question")
      ? openNoteEditor(level, range)
      : highlightSelection(level, range));
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
      const range = toolbarRange;
      runNoteAction(() => highlightSelection({ id: "important", label: "重要", color: choice.color }, range));
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
  headingButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const range = toolbarRange;
    runNoteAction(() => markHeading(1, range));
  });
  const headingMenu = document.createElement("div");
  headingMenu.className = "web-notes-heading-menu";
  HEADING_LEVELS.forEach((headingLevel) => {
    const button = document.createElement("button");
    button.className = "web-notes-heading-choice";
    button.textContent = `H${headingLevel}`;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const range = toolbarRange;
      runNoteAction(() => markHeading(headingLevel, range));
    });
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
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const range = toolbarRange;
      runNoteAction(() => recordWithWeight(weight.id, range));
    });
    toolbar.append(button);
  });
  const addNoteButton = document.createElement("button");
  addNoteButton.id = "web-notes-add-note";
  addNoteButton.className = "web-notes-weight";
  addNoteButton.textContent = "备注";
  addNoteButton.hidden = true;
  addNoteButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    runNoteAction(openAnnotationNoteEditor);
  });
  toolbar.append(addNoteButton);
  const deleteButton = document.createElement("button");
  deleteButton.id = "web-notes-delete";
  deleteButton.className = "web-notes-delete";
  deleteButton.textContent = "删除笔记";
  deleteButton.hidden = true;
  deleteButton.addEventListener("mousedown", (event) => { event.preventDefault(); });
  deleteButton.addEventListener("click", showDeleteConfirmation);
  toolbar.append(deleteButton);
  document.documentElement.append(toolbar);
  setWeight(activeWeight);

  const deleteConfirmation = document.createElement("div");
  deleteConfirmation.id = "web-notes-delete-confirm";
  deleteConfirmation.hidden = true;
  const deleteMessage = document.createElement("span");
  deleteMessage.textContent = "删除此笔记？";
  const deleteCancel = document.createElement("button");
  deleteCancel.className = "web-notes-delete-cancel";
  deleteCancel.textContent = "取消";
  deleteCancel.addEventListener("mousedown", (event) => { event.preventDefault(); });
  deleteCancel.addEventListener("click", hideDeleteConfirmation);
  const deleteConfirm = document.createElement("button");
  deleteConfirm.className = "web-notes-delete-confirm-action";
  deleteConfirm.textContent = "确认删除";
  deleteConfirm.addEventListener("mousedown", (event) => { event.preventDefault(); });
  deleteConfirm.addEventListener("click", () => {
    hideDeleteConfirmation();
    runNoteAction(deleteActiveAnnotation);
  });
  deleteConfirmation.append(deleteMessage, deleteCancel, deleteConfirm);
  document.documentElement.append(deleteConfirmation);

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
  const savePendingNote = () => {
    const annotationId = pendingAnnotationId;
    if (annotationId) {
      const note = input.value.trim();
      closeNoteEditor();
      runNoteAction(() => updateAnnotationNote(annotationId, note));
      return;
    }
    if (!pendingLevel || !pendingRange) return;
    const level = pendingLevel;
    const range = pendingRange;
    const note = input.value.trim();
    closeNoteEditor();
    runNoteAction(() => highlightSelection(level, range, note));
  };
  confirm.addEventListener("mousedown", (event) => {
    event.preventDefault();
    savePendingNote();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    savePendingNote();
  });
  actions.append(cancel, confirm);
  noteEditor.append(title, input, actions);
  document.documentElement.append(noteEditor);

  const mediaToolbar = document.createElement("div");
  mediaToolbar.id = "web-notes-media-toolbar";
  mediaToolbar.hidden = true;
  const mediaButton = document.createElement("button");
  mediaButton.id = "web-notes-media-action";
  mediaButton.className = "web-notes-media-button";
  mediaButton.textContent = "记录此媒体";
  mediaButton.addEventListener("click", () => runNoteAction(async () => {
    if (!selectedMedia) return;
    const existingAnnotationIds = new Set(mediaButton.dataset.annotationIds.split(",").filter(Boolean));
    if (existingAnnotationIds.size) {
      const items = await annotations();
      const deletedAnnotationIds = items.filter((item) => existingAnnotationIds.has(item.id)).map((item) => item.id);
      if (!deletedAnnotationIds.length) return hideMediaToolbar();
      await persist(items.filter((item) => !existingAnnotationIds.has(item.id)), [], deletedAnnotationIds);
      await renderMediaBadges(await annotations());
      hideMediaToolbar();
      showToast(deletedAnnotationIds.length > 1 ? "已删除重复媒体记录" : "已删除媒体记录");
      return;
    }
    if (mediaAnnotationsFor(selectedMedia).length) {
      showMediaToolbar(selectedMedia);
      return showToast("此媒体已记录");
    }
    const source = selectedMedia.currentSrc || selectedMedia.src || selectedMedia.getAttribute("src") || "";
    const annotation = {
      id: createId(), type: "media", mediaType: selectedMedia.tagName.toLowerCase(), source,
      label: selectedMedia.alt || selectedMedia.getAttribute("aria-label") || selectedMedia.title || "媒体内容",
      locator: locatorFor(selectedMedia), createdAt: new Date().toISOString(), note: ""
    };
    await save(annotation);
    await renderMediaBadges(await annotations());
    hideMediaToolbar();
    showToast("已保存媒体记录");
  }));
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
    if (document.querySelector(`mark[data-web-notes-id="${annotation.id}"]`)) continue;
    const roots = rootsForLocator(annotation.selector?.anchor);
    if (!roots.includes(document.body)) roots.push(document.body);
    const range = roots
      .map((root) => rangeForText(root, annotation.selector, annotation.quote))
      .find(Boolean);
    if (range) applyHighlight(range, annotation);
  }
  renderTextNoteBadges(items);
  renderTextTypeBadges(items);
  renderMediaBadges(items);
}

function scheduleRestore(mutations) {
  if (!cachedAnnotations?.some((annotation) => (
    ((annotation.type === "text" || annotation.type === "heading") && !document.querySelector(`mark[data-web-notes-id="${annotation.id}"]`))
    || (annotation.type === "media" && !mediaBadges.has(annotation.id))
  ))) return;
  const hasPageContentChange = mutations.some((mutation) => [...mutation.addedNodes].some((node) => {
    const element = elementFor(node);
    return !element?.closest?.("[id^='web-notes-']") && Boolean(node.nodeType === Node.TEXT_NODE ? node.nodeValue?.trim() : element?.textContent?.trim() || element?.matches?.("img, video, audio"));
  }));
  if (!hasPageContentChange) return;
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    restore().catch((error) => console.warn("Web Highlighter Notes 恢复失败：", error));
  }, 300);
}

document.addEventListener("mouseup", (event) => {
  const range = currentSelectionRange();
  const toolbar = document.getElementById("web-notes-toolbar");
  if (event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor, #web-notes-delete-confirm")) return;
  if (!event.target.closest?.("#web-notes-media-toolbar, img, video, audio")) hideMediaToolbar();
  if (!range || event.detail > 1) {
    toolbarRange = null;
    return (toolbar.hidden = true);
  }
  closeNoteEditor();
  activeAnnotationId = null;
  toolbarRange = range;
  setDeleteAvailability(false);
  toolbar.hidden = false;
  position(toolbar, event.clientX, event.clientY + 14);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor, #web-notes-delete-confirm")) {
    closeNoteEditor();
    hideDeleteConfirmation();
  }
  const mark = event.target.closest?.("mark.web-notes-highlight");
  if (mark) {
    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toolbarRange = range.cloneRange();
    activeAnnotationId = mark.dataset.webNotesId;
    setDeleteAvailability(true);
    runNoteAction(async () => {
      const annotation = (await annotations()).find((item) => item.id === activeAnnotationId);
      await setWeight(annotation?.weight || "normal", false);
      const toolbar = document.getElementById("web-notes-toolbar");
      toolbar.hidden = false;
      position(toolbar, event.clientX, event.clientY + 14);
    });
    return;
  }

  if (event.target.closest?.("#web-notes-media-toolbar")) return;
  if (!event.target.closest?.("img, video, audio")) hideMediaToolbar();
}, true);

document.addEventListener("dblclick", (event) => {
  if (event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor")) return;
  toolbarRange = null;
  closeNoteEditor();
  setDeleteAvailability(false);
  document.getElementById("web-notes-toolbar").hidden = true;
});

document.addEventListener("contextmenu", (event) => {
  if (event.target.closest?.("#web-notes-toolbar, #web-notes-note-editor, #web-notes-media-toolbar")) return;
  contextMenuRange = currentSelectionRange();
});

document.addEventListener("mouseover", (event) => {
  if (event.buttons) return;
  const media = event.target.closest?.("img, video, audio");
  if (!media || media === selectedMedia) return;
  showMediaToolbar(media);
});

document.addEventListener("mouseout", (event) => {
  if (!event.target.closest?.("img, video, audio, #web-notes-media-toolbar")) return;
  if (event.relatedTarget?.closest?.("img, video, audio, #web-notes-media-toolbar")) return;
  scheduleHideMediaToolbar();
});

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
  if (event.key === "Escape") {
    hideMediaToolbar();
    hideDeleteConfirmation();
    hideMarkdownPreview();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_MARKDOWN_PREVIEW") {
    showMarkdownPreview(message.markdown);
    return;
  }
  if (message.type === "LOCATE_ANNOTATION") {
    runNoteAction(() => locateAnnotation(message.annotationId));
    return;
  }
  if (message.type === "HIGHLIGHT_SELECTION") {
    const range = contextMenuRange || currentSelectionRange();
    contextMenuRange = null;
    if (message.level.weight) activeWeight = message.level.weight;
    runNoteAction(() => {
      if (message.level.id === "heading") return markHeading(message.level.headingLevel || 1, range);
      return message.level.id === "idea" || message.level.id === "question"
        ? openNoteEditor(message.level, range)
        : highlightSelection(message.level, range);
    });
  }
});

buildUi();
restore().catch((error) => console.warn("Web Highlighter Notes 初始恢复失败：", error));
new MutationObserver(scheduleRestore).observe(document.documentElement, { childList: true, subtree: true });
