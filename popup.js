const STORAGE_PREFIX = "web-highlighter-notes:";
const LEVEL_LABELS = { important: "重要", idea: "想法", question: "疑问", review: "复习" };
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

async function save() { await chrome.storage.local.set({ [currentKey]: pageAnnotations }); }

function render() {
  document.getElementById("empty").hidden = pageAnnotations.length > 0;
  document.getElementById("notes").innerHTML = pageAnnotations.map((annotation, index) => {
    const date = new Date(annotation.createdAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
    const source = annotation.type === "media" ? `<a class="media" href="${escapeHtml(annotation.source)}" target="_blank">${escapeHtml(annotation.label || annotation.mediaType)}</a>` : escapeHtml(annotation.quote);
    const tag = annotation.type === "media" ? "媒体" : LEVEL_LABELS[annotation.level] || "标记";
    return `<article class="entry"><div class="meta"><span class="tag" style="background:${annotation.color || "#e2e8f0"}">${tag}</span><time>${date}</time></div><div class="quote">${source}</div><textarea class="note" data-index="${index}" placeholder="添加自己的笔记…">${escapeHtml(annotation.note || "")}</textarea></article>`;
  }).join("");
  document.querySelectorAll("textarea.note").forEach((input) => input.addEventListener("change", async () => { pageAnnotations[Number(input.dataset.index)].note = input.value.trim(); await save(); }));
}

function markdown() {
  const title = currentTab.title || "未命名网页";
  const lines = [`# ${escapeMarkdown(title)}`, "", `- 原文标题：${escapeMarkdown(title)}`, `- 原文网址：${currentTab.url}`, `- 导出时间：${new Date().toLocaleString("zh-CN")}`, "", "## 标记与笔记", ""];
  if (!pageAnnotations.length) lines.push("暂无记录。");
  pageAnnotations.forEach((annotation, index) => {
    const kind = annotation.type === "media" ? `媒体（${annotation.mediaType}）` : `${LEVEL_LABELS[annotation.level] || "标记"}文字`;
    lines.push(`### ${index + 1}. ${kind}`, "");
    lines.push(annotation.type === "media" ? mediaMarkdown(annotation) : `> ${escapeMarkdown(annotation.quote)}`);
    if (annotation.note) lines.push(`- 笔记：${escapeMarkdown(annotation.note)}`);
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
      body: JSON.stringify({ filename: exportFilename(), content: markdown() })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    alert(`已导出到项目 exports 目录：${result.filename}`);
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
