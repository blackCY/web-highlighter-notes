const LEVEL_LABELS = { important: "重要", idea: "想法", question: "疑问", note: "笔记", heading: "标题" };
const GITHUB_SETTINGS_KEY = "web-highlighter-notes-github-settings";
const DEFAULT_GITHUB_SETTINGS = { repository: "blackCY/web-highlighter-notes", branch: "main", directory: "notes", token: "" };
let currentTab;
let pageAnnotations = [];
let filterQuery = "";
let loadError = "";

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
  if (Number.isInteger(annotation.selector?.order)) return [annotation.selector.order, annotation.selector.start || 0];
  const path = annotation.selector?.startPath || annotation.documentPath;
  if (!path) return null;
  return [...path, annotation.selector?.startOffset || 0];
}

function compareAnnotationsInPageOrder(left, right) {
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
}

function orderedAnnotationEntries() {
  return pageAnnotations
    .map((annotation, index) => ({ annotation, index }))
    .sort((left, right) => compareAnnotationsInPageOrder(left.annotation, right.annotation));
}

function annotationsInPageOrder() {
  return orderedAnnotationEntries().map(({ annotation }) => annotation);
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

function personalNotes(annotation) {
  if (Object.hasOwn(annotation, "personalNotes")) return annotation.personalNotes || {};
  if ((annotation.level === "idea" || annotation.level === "question") && annotation.note) {
    return { [annotation.level]: annotation.note };
  }
  return {};
}

function annotationSearchText(annotation) {
  return [annotation.quote, annotation.label, annotation.source, annotation.note, ...Object.values(personalNotes(annotation))]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
}

function annotationNoteMarkdown(annotation) {
  const notes = personalNotes(annotation);
  const children = [];
  if (notes.idea) children.push(`  - <span style="background-color: #0284c7; color: #ffffff; padding: 1px 4px; border-radius: 3px;">我的想法：${escapeMarkdown(notes.idea)}</span>`);
  if (notes.question) children.push(`  - <span style="background-color: #0284c7; color: #ffffff; padding: 1px 4px; border-radius: 3px;">我的疑问：${escapeMarkdown(notes.question)}</span>`);
  const isLegacyPersonalNote = !Object.hasOwn(annotation, "personalNotes") && (annotation.level === "idea" || annotation.level === "question");
  if (annotation.note && !isLegacyPersonalNote) children.push(`  - 笔记：${escapeMarkdown(annotation.note)}`);
  return children;
}

function pageUrl() {
  const url = new URL(currentTab.url);
  url.hash = "";
  url.search = "";
  return url.href;
}

async function githubNotesRequest(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "GitHub 笔记请求失败");
  return response.data;
}

async function exportMarkdown() {
  return githubNotesRequest("DOWNLOAD_MARKDOWN", { filename: exportFilename(), content: markdown() });
}

async function loadGithubSettings() {
  const stored = await chrome.storage.local.get(GITHUB_SETTINGS_KEY);
  const settings = { ...DEFAULT_GITHUB_SETTINGS, ...(stored[GITHUB_SETTINGS_KEY] || {}) };
  document.getElementById("github-repository").value = settings.repository;
  document.getElementById("github-branch").value = settings.branch;
  document.getElementById("github-directory").value = settings.directory;
  document.getElementById("github-token").value = settings.token;
  document.getElementById("github-status").textContent = settings.token ? "GitHub 笔记同步已配置。" : "请粘贴仅授权此仓库 Contents 读写权限的 Token。";
}

function githubStatus(message) {
  document.getElementById("github-status").textContent = message;
}

function render() {
  const normalizedQuery = filterQuery.trim().toLocaleLowerCase();
  const visibleAnnotations = orderedAnnotationEntries()
    .filter(({ annotation }) => !normalizedQuery || annotationSearchText(annotation).includes(normalizedQuery));
  const empty = document.getElementById("empty");
  empty.hidden = visibleAnnotations.length > 0;
  empty.textContent = loadError || (pageAnnotations.length && normalizedQuery ? "没有匹配的笔记。" : "这个页面还没有记录。");
  document.getElementById("notes").innerHTML = visibleAnnotations.map(({ annotation, index }) => {
    const date = new Date(annotation.createdAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
    const source = annotation.type === "media" ? `<a class="media" href="${escapeHtml(annotation.source)}" target="_blank">${escapeHtml(annotation.label || annotation.mediaType)}</a>` : escapeHtml(annotation.quote);
    const tag = annotation.type === "media" ? "媒体" : annotation.type === "heading" ? `H${annotation.headingLevel}` : `${LEVEL_LABELS[annotation.level] || "标记"}${annotation.weight === "bold" ? " · 加粗" : ""}`;
    return `<article class="entry"><div class="meta"><span class="tag" style="background:${annotation.color || "#e2e8f0"}">${tag}</span><time>${date}</time><button class="locate-note" data-annotation-id="${escapeHtml(annotation.id)}" type="button">定位</button></div><div class="quote">${source}</div></article>`;
  }).join("");
}

function markdown() {
  const title = currentTab.title || "未命名网页";
  const orderedAnnotations = annotationsInPageOrder();
  const hasHeadings = orderedAnnotations.some((annotation) => annotation.type === "heading");
  const lines = [`# ${escapeMarkdown(title)}`, "", `- 原文标题：${escapeMarkdown(title)}`, `- 原文网址：${pageUrl()}`, `- 导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
  if (!hasHeadings) lines.push("## 标记与笔记", "");
  if (!pageAnnotations.length) lines.push("暂无记录。");
  orderedAnnotations.forEach((annotation) => {
    if (annotation.type === "heading") {
      lines.push(`${"#".repeat(Math.max(1, Math.min(6, annotation.headingLevel || 1)))} ${escapeMarkdown(annotation.quote)}`, "");
      return;
    }
    lines.push(`- ${annotation.type === "media" ? mediaMarkdown(annotation) : textMarkdown(annotation)}`);
    lines.push(...annotationNoteMarkdown(annotation));
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
  const button = document.getElementById("export");
  button.disabled = true;
  try {
    await exportMarkdown();
    button.textContent = "已下载";
    setTimeout(() => { button.textContent = "导出 Markdown"; }, 1600);
  } catch (error) {
    alert(`无法下载 Markdown。\n\n${error.message}`);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("preview-markdown").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: "SHOW_MARKDOWN_PREVIEW", markdown: markdown() });
  } catch (error) {
    alert(`无法打开 Markdown 预览。\n\n${error.message}`);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("notes").addEventListener("click", async (event) => {
  const button = event.target.closest(".locate-note");
  if (!button) return;
  button.disabled = true;
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: "LOCATE_ANNOTATION", annotationId: button.dataset.annotationId });
  } catch (error) {
    alert(`无法定位笔记。\n\n${error.message}`);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("sync").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在刷新…";
  try {
    const notes = await githubNotesRequest("GET_GITHUB_NOTES", { pageUrl: pageUrl(), pageTitle: currentTab.title });
    pageAnnotations = notes?.annotations || [];
    loadError = "";
    render();
    await chrome.tabs.reload(currentTab.id);
  } catch (error) {
    alert(`无法从 GitHub 刷新笔记。\n\n${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "从 GitHub 刷新";
  }
});

document.getElementById("github-toggle").addEventListener("click", async () => {
  const settings = document.getElementById("github-settings");
  settings.hidden = !settings.hidden;
  if (!settings.hidden) await loadGithubSettings();
});

document.getElementById("toggle-github-token").addEventListener("click", (event) => {
  const input = document.getElementById("github-token");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  event.currentTarget.textContent = visible ? "显示" : "隐藏";
  event.currentTarget.setAttribute("aria-pressed", String(!visible));
});

document.getElementById("copy-github-token").addEventListener("click", async (event) => {
  const input = document.getElementById("github-token");
  const token = input.value.trim();
  if (!token) {
    githubStatus("没有可复制的 Token。");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(token);
    } else {
      input.focus();
      input.select();
      if (!document.execCommand("copy")) throw new Error("浏览器拒绝访问剪贴板");
    }
    const button = event.currentTarget;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = "复制"; }, 1600);
  } catch (error) {
    githubStatus(`无法复制 Token：${error.message}`);
  }
});

document.getElementById("save-github").addEventListener("click", async () => {
  const status = document.getElementById("github-status");
  const button = document.getElementById("save-github");
  const settings = {
    repository: document.getElementById("github-repository").value.trim(),
    branch: document.getElementById("github-branch").value.trim(),
    directory: document.getElementById("github-directory").value.trim(),
    token: document.getElementById("github-token").value.trim()
  };
  if (!settings.token) {
    status.textContent = "请填写 GitHub Token。";
    return;
  }
  button.disabled = true;
  status.textContent = "正在验证仓库、分支和 Token…";
  try {
    await githubNotesRequest("VERIFY_GITHUB_SETTINGS", { settings });
    await chrome.storage.local.set({ [GITHUB_SETTINGS_KEY]: settings });
    status.textContent = "验证通过并已保存。刷新网页后即可从 GitHub 恢复笔记。";
  } catch (error) {
    status.textContent = `无法保存 GitHub 配置：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

async function forceDeletePageNotes() {
  const button = document.getElementById("confirm-force-delete");
  const cancel = document.getElementById("cancel-force-delete");
  button.disabled = true;
  cancel.disabled = true;
  button.textContent = "正在删除…";
  try {
    const result = await githubNotesRequest("DELETE_GITHUB_NOTES", { pageUrl: pageUrl(), pageTitle: currentTab.title });
    pageAnnotations = [];
    render();
    document.getElementById("force-delete-confirm").hidden = true;
    await chrome.tabs.reload(currentTab.id);
    alert(`已从 GitHub 删除 ${result.deletedCount || 0} 个笔记文件。`);
  } catch (error) {
    alert(`无法强制删除 GitHub 笔记。\n\n${error.message}`);
  } finally {
    button.disabled = false;
    cancel.disabled = false;
    button.textContent = "再次确认删除";
  }
}

document.getElementById("force-delete").addEventListener("click", () => {
  document.getElementById("force-delete-confirm").hidden = false;
});

document.getElementById("cancel-force-delete").addEventListener("click", () => {
  document.getElementById("force-delete-confirm").hidden = true;
});

document.getElementById("confirm-force-delete").addEventListener("click", () => {
  forceDeletePageNotes();
});

document.getElementById("filter").addEventListener("input", (event) => {
  filterQuery = event.target.value;
  render();
});

(async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  document.getElementById("page-title").textContent = currentTab.title || currentTab.url;
  try {
    const notes = await githubNotesRequest("GET_GITHUB_NOTES", { pageUrl: pageUrl(), pageTitle: currentTab.title });
    pageAnnotations = notes?.annotations || [];
  } catch (error) {
    loadError = `请先打开 GitHub 配置并保存 Token。${error.message}`;
  }
  render();
})();
