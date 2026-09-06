const STORAGE_PREFIX = "web-highlighter-notes:";
const LEVEL_LABELS = { important: "重要", idea: "想法", question: "疑问", note: "笔记" };
let currentTab;
let currentKey;
let pageAnnotations = [];

const escapeHtml = (text) => String(text).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const escapeMarkdown = (text) => String(text).replace(/[\\`*_[\]<>]/g, "\\$&");

function mediaMarkdown(annotation) {
  const label = escapeMarkdown(annotation.label || "媒体内容");
  const url = String(annotation.source || "").replace(/ /g, "%20").replace(/\)/g, "\\)");
  if (annotation.mediaType === "img") return `![${label}](${url})`;
  const typeLabel = annotation.mediaType === "video" ? "视频" : "音频";
  return `[${typeLabel}：${label}](${url})`;
}

function annotationPosition(annotation) {
  const path = annotation.selector?.startPath || annotation.documentPath;
  if (!path) return null;
  return [...path, annotation.selector?.startOffset || 0];
}

function annotationsInPageOrder() {
  return [...pageAnnotations].sort((left, right) => {
    const leftPosition = annotationPosition(left);
    const rightPosition = annotationPosition(right);
    if (leftPosition && rightPosition) {
      const length = Math.max(leftPosition.length, rightPosition.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (leftPosition[index] ?? -1) - (rightPosition[index] ?? -1);
        if (difference) return difference;
      }
    } else if (leftPosition) {
      return -1;
    } else if (rightPosition) {
      return 1;
    }
    return new Date(left.createdAt) - new Date(right.createdAt);
  });
}

function textMarkdown(annotation) {
  const content = escapeMarkdown(annotation.quote);
  const weightedContent = annotation.weight === "bold" ? `**${content}**` : content;
  const backgroundColors = {
    idea: "#15803d",
    question: "#2563eb"
  };
  const importantColors = {
    "#fecaca": "#dc2626",
    "#bbf7d0": "#16a34a",
    "#fed7aa": "#ea580c",
    "#fde68a": "#dc2626"
  };
  const backgroundColor = annotation.level === "important"
    ? importantColors[annotation.color] || "#dc2626"
    : backgroundColors[annotation.level];
  if (!backgroundColor) return weightedContent;
  return `<span style="background-color: ${backgroundColor}; color: #ffffff; font-size: 1em; padding: 1px 4px; border-radius: 3px;">${weightedContent}</span>`;
}

function annotationNoteMarkdown(annotation) {
  if (!annotation.note) return null;
  if (annotation.level === "idea" || annotation.level === "question") {
    const prefix = annotation.level === "idea" ? "我的想法" : "我的疑问";
    return `  - <span style="background-color: #0284c7; color: #ffffff; padding: 1px 4px; border-radius: 3px;">${prefix}：${escapeMarkdown(annotation.note)}</span>`;
  }
  return `  - 笔记：${escapeMarkdown(annotation.note)}`;
}

async function save() { await chrome.storage.local.set({ [currentKey]: pageAnnotations }); }

function render() {
  document.getElementById("empty").hidden = pageAnnotations.length > 0;
  document.getElementById("notes").innerHTML = pageAnnotations.map((annotation, index) => {
    const date = new Date(annotation.createdAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
    const source = annotation.type === "media" ? `<a class="media" href="${escapeHtml(annotation.source)}" target="_blank">${escapeHtml(annotation.label || annotation.mediaType)}</a>` : escapeHtml(annotation.quote);
    const tag = annotation.type === "media" ? "媒体" : `${LEVEL_LABELS[annotation.level] || "标记"}${annotation.weight === "bold" ? " · 加粗" : ""}`;
    return `<article class="entry"><div class="meta"><span class="tag" style="background:${annotation.color || "#e2e8f0"}">${tag}</span><time>${date}</time></div><div class="quote">${source}</div><textarea class="note" data-index="${index}" placeholder="添加自己的笔记…">${escapeHtml(annotation.note || "")}</textarea></article>`;
  }).join("");
  document.querySelectorAll("textarea.note").forEach((input) => input.addEventListener("change", async () => { pageAnnotations[Number(input.dataset.index)].note = input.value.trim(); await save(); }));
}

function markdown() {
  const title = currentTab.title || "未命名网页";
  const lines = [`# ${escapeMarkdown(title)}`, "", `- 原文标题：${escapeMarkdown(title)}`, `- 原文网址：${currentTab.url}`, `- 导出时间：${new Date().toLocaleString("zh-CN")}`, "", "## 标记与笔记", ""];
  if (!pageAnnotations.length) lines.push("暂无记录。");
  annotationsInPageOrder().forEach((annotation) => {
    lines.push(`- ${annotation.type === "media" ? mediaMarkdown(annotation) : textMarkdown(annotation)}`);
    const note = annotationNoteMarkdown(annotation);
    if (note) lines.push(note);
    lines.push("");
  });
  return lines.join("\n");
}

function exportFilename() {
  const now = new Date();
  const timestamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("") + "-" + [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  const siteName = new URL(currentTab.url).hostname.replace(/^www\./, "") || "web-notes";
  return `${siteName}-${timestamp}.md`;
}

document.getElementById("export").addEventListener("click", async () => {
  try {
    const response = await fetch("http://127.0.0.1:3517/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: exportFilename(), content: markdown(), pageUrl: currentTab.url })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    alert(`${result.action === "updated" ? "已更新" : "已新增"}项目 exports 目录中的笔记：${result.filename}`);
  } catch (error) {
    alert(`无法导出到项目目录。请先在项目根目录运行 npm run exporter。\n\n${error.message}`);
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("确定清除当前页面的所有标记和笔记吗？")) return;
  await chrome.storage.local.remove(currentKey);
  pageAnnotations = [];
  render();
  chrome.tabs.reload(currentTab.id);
});

(async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentKey = `${STORAGE_PREFIX}${currentTab.url.split("#")[0]}`;
  document.getElementById("page-title").textContent = currentTab.title || currentTab.url;
  const data = await chrome.storage.local.get(currentKey);
  pageAnnotations = data[currentKey] || [];
  render();
})();
