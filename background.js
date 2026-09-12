const LEVELS = [
  { id: "important", label: "重要", menuLabel: "重要标记", color: "#fecaca", weight: "normal" },
  { id: "idea", label: "想法", menuLabel: "想法标记", color: "#bbf7d0", weight: "normal" },
  { id: "question", label: "疑问", menuLabel: "疑问标记", color: "#bfdbfe", weight: "normal" },
  { id: "note", label: "默认笔记", menuLabel: "默认笔记", color: "#e5e7eb", badgeType: "normal" },
  { id: "note", label: "加粗笔记", menuLabel: "加粗笔记", color: "#e5e7eb", badgeType: "bold", weight: "bold" }
];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];
const GITHUB_SETTINGS_KEY = "web-highlighter-notes-github-settings";
const GITHUB_API_URL = "https://api.github.com";
const NOTES_DATA_START = "<!-- web-highlighter-notes-data";
const NOTES_DATA_END = "web-highlighter-notes-data -->";
const LEVEL_LABELS = { important: "重要", idea: "想法", question: "疑问", note: "笔记", heading: "标题" };
const DEFAULT_GITHUB_SETTINGS = {
  repository: "blackCY/web-highlighter-notes",
  branch: "main",
  directory: "notes",
  token: ""
};
const noteOperations = new Map();

function canonicalPageUrl(value) {
  const pageUrl = new URL(String(value));
  pageUrl.hash = "";
  pageUrl.search = "";
  return pageUrl.href;
}

function fileHash(value) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const character of value) {
    const code = character.codePointAt(0);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(String(value).replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function escapeMarkdown(value) {
  return String(value || "").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function fallbackFavicon(pageUrl) {
  const page = new URL(pageUrl);
  return `${page.origin}/favicon.ico`;
}

function normalizedFavicon(value, pageUrl) {
  try {
    const favicon = new URL(String(value || fallbackFavicon(pageUrl)), pageUrl);
    if (favicon.protocol === "http:" || favicon.protocol === "https:") return favicon.href;
  } catch {}
  return fallbackFavicon(pageUrl);
}

function frontMatterValue(value) {
  return JSON.stringify(String(value || ""));
}

function frontMatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) return [];
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    try {
      return [[key, JSON.parse(rawValue)]];
    } catch {
      return [[key, rawValue.replace(/^['"]|['"]$/g, "")]];
    }
  }));
}

function personalNotes(annotation) {
  if (Object.hasOwn(annotation, "personalNotes")) return annotation.personalNotes || {};
  if ((annotation.level === "idea" || annotation.level === "question") && annotation.note) return { [annotation.level]: annotation.note };
  return {};
}

function annotationPosition(annotation) {
  if (Number.isInteger(annotation.selector?.order)) return [annotation.selector.order, annotation.selector.start || 0];
  return [Number.MAX_SAFE_INTEGER, new Date(annotation.createdAt || 0).getTime()];
}

function annotationsInPageOrder(annotations) {
  return [...annotations].sort((left, right) => {
    const leftPosition = annotationPosition(left);
    const rightPosition = annotationPosition(right);
    return leftPosition[0] - rightPosition[0] || leftPosition[1] - rightPosition[1];
  });
}

function annotationMarkdown(annotation) {
  if (annotation.type === "heading") return `${"#".repeat(Math.max(1, Math.min(6, annotation.headingLevel || 1)))} ${escapeMarkdown(annotation.quote)}`;
  if (annotation.type === "media") {
    const label = escapeMarkdown(annotation.label || "媒体内容");
    const source = String(annotation.source || "").replace(/ /g, "%20").replace(/\)/g, "\\)");
    const media = annotation.mediaType === "img" ? `![${label}](${source})` : `[${annotation.mediaType === "video" ? "视频" : "音频"}：${label}](${source})`;
    return `- [媒体] ${media}`;
  }
  const quote = annotation.level === "important"
    ? `<span style="background-color: #dc2626; color: #ffffff; font-size: 1em; padding: 1px 4px; border-radius: 3px;"><strong>${escapeHtml(annotation.quote)}</strong></span>`
    : `${annotation.weight === "bold" ? "**" : ""}${escapeMarkdown(annotation.quote)}${annotation.weight === "bold" ? "**" : ""}`;
  const lines = [annotation.level === "important" ? `- ${quote}` : `- [${LEVEL_LABELS[annotation.level] || "标记"}] ${quote}`];
  const notes = personalNotes(annotation);
  if (notes.idea) lines.push(`  - 我的想法：${escapeMarkdown(notes.idea)}`);
  if (notes.question) lines.push(`  - 我的疑问：${escapeMarkdown(notes.question)}`);
  if (annotation.note && !((annotation.level === "idea" || annotation.level === "question") && !Object.hasOwn(annotation, "personalNotes"))) {
    lines.push(`  - 笔记：${escapeMarkdown(annotation.note)}`);
  }
  return lines.join("\n");
}

function notesMarkdown({ pageUrl, pageTitle, pageFavicon, annotations }) {
  const updatedAt = new Date().toISOString();
  const title = String(pageTitle || "未命名网页");
  const favicon = normalizedFavicon(pageFavicon, pageUrl);
  const payload = encodeBase64(JSON.stringify({ version: 1, pageUrl, pageTitle: title, pageFavicon: favicon, updatedAt, annotations }));
  return `${[
    "---",
    `title: ${frontMatterValue(title)}`,
    `source_url: ${frontMatterValue(pageUrl)}`,
    `favicon: ${frontMatterValue(favicon)}`,
    `updated_at: ${frontMatterValue(updatedAt)}`,
    "---",
    "",
    NOTES_DATA_START,
    payload,
    NOTES_DATA_END,
    "",
    `# ${escapeMarkdown(title)}`,
    "",
    "## 标记与笔记",
    "",
    ...(annotationsInPageOrder(annotations).flatMap((annotation) => [annotationMarkdown(annotation), ""]))
  ].join("\n")}\n`;
}

function notesFromMarkdown(content) {
  const metadata = frontMatter(content);
  const start = content.indexOf(NOTES_DATA_START);
  const end = content.indexOf(NOTES_DATA_END);
  if (start < 0 || end < 0 || end <= start) throw new Error("GitHub 笔记文件格式无效");
  const payload = content.slice(start + NOTES_DATA_START.length, end).trim();
  let notes;
  try {
    notes = JSON.parse(payload);
  } catch {
    notes = JSON.parse(decodeBase64(payload));
  }
  if (!Array.isArray(notes.annotations)) throw new Error("GitHub 笔记文件缺少标记数据");
  return {
    ...notes,
    pageUrl: metadata.source_url || notes.pageUrl,
    pageTitle: metadata.title || notes.pageTitle,
    pageFavicon: metadata.favicon || notes.pageFavicon,
    updatedAt: metadata.updated_at || notes.updatedAt
  };
}

async function githubSettings() {
  const stored = await chrome.storage.local.get(GITHUB_SETTINGS_KEY);
  return { ...DEFAULT_GITHUB_SETTINGS, ...(stored[GITHUB_SETTINGS_KEY] || {}) };
}

async function verifyGithubSettings(settings) {
  const validated = validatedGithubSettings(settings);
  await githubRequest(validated, `/repos/${validated.repository}/branches/${encodeURIComponent(validated.branch)}`);
}

function validatedGithubSettings(settings) {
  if (!settings.token.trim()) throw new Error("请先在扩展弹窗的 GitHub 配置中填写访问令牌");
  if (!/^[^/\s]+\/[^/\s]+$/.test(settings.repository)) throw new Error("GitHub 仓库格式应为 owner/repository");
  if (!/^[\w./-]+$/.test(settings.branch)) throw new Error("GitHub 分支名称无效");
  if (!/^[\w./-]*$/.test(settings.directory) || settings.directory.split("/").includes("..")) throw new Error("GitHub 笔记目录无效");
  return settings;
}

function notesDirectory(settings) {
  return settings.directory.replace(/^\/+|\/+$/g, "");
}

function notesFilename(pageUrl, pageTitle = "") {
  const hostname = new URL(pageUrl).hostname.replace(/[^\w.-]/g, "-") || "web-notes";
  const title = String(pageTitle).replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "").slice(0, 80);
  return `${title || hostname}.md`;
}

function notesPath(settings, pageUrl, pageTitle = "") {
  return [notesDirectory(settings), notesFilename(pageUrl, pageTitle)].filter(Boolean).join("/");
}

function numberedNotesPath(settings, pageUrl, pageTitle, number) {
  const filename = notesFilename(pageUrl, pageTitle);
  const numbered = number > 1 ? `${filename.slice(0, -3)}-${number}.md` : filename;
  return [notesDirectory(settings), numbered].filter(Boolean).join("/");
}

function legacyTitleNotesPath(settings, pageUrl, pageTitle = "") {
  const filename = `${notesFilename(pageUrl, pageTitle).slice(0, -3)}-${fileHash(pageUrl)}.md`;
  return [notesDirectory(settings), filename].filter(Boolean).join("/");
}

function legacyHostnameNotesPath(settings, pageUrl) {
  const hostname = new URL(pageUrl).hostname.replace(/[^\w.-]/g, "-") || "web-notes";
  return [notesDirectory(settings), `${hostname}-${fileHash(pageUrl)}.md`].filter(Boolean).join("/");
}

function legacyNotesPath(settings, pageUrl) {
  const filename = `${fileHash(pageUrl)}.md`;
  return [notesDirectory(settings), filename].filter(Boolean).join("/");
}

function notePaths(settings, pageUrl, pageTitle = "") {
  return [...new Set([
    notesPath(settings, pageUrl, pageTitle),
    legacyTitleNotesPath(settings, pageUrl, pageTitle),
    legacyHostnameNotesPath(settings, pageUrl),
    legacyNotesPath(settings, pageUrl)
  ])];
}

async function downloadMarkdown({ filename, content }) {
  const safeFilename = String(filename || "web-notes.md")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  if (!safeFilename.endsWith(".md") || !content) throw new Error("无效的 Markdown 导出内容");
  const downloadId = await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(String(content))}`,
    filename: `web-highlighter-notes/${safeFilename}`,
    saveAs: false
  });
  return { downloadId, filename: safeFilename };
}

async function githubRequest(settings, requestPath, options = {}) {
  const response = await fetch(`${GITHUB_API_URL}${requestPath}`, {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || "GitHub 请求失败");
    error.status = response.status;
    throw error;
  }
  return result;
}

async function githubFile(settings, pageUrl, pageTitle) {
  const paths = notePaths(settings, pageUrl, pageTitle);
  for (const path of paths) {
    try {
      const file = await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(settings.branch)}`);
      return { path, sha: file.sha, content: decodeBase64(file.content) };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const matchingFiles = await githubFilesMatchingPageUrl(settings, pageUrl);
  if (matchingFiles.length) return matchingFiles[0];
  return { path: paths[0], sha: null, content: null };
}

async function githubFileAtPath(settings, path) {
  try {
    const file = await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(settings.branch)}`);
    return { path, sha: file.sha, content: decodeBase64(file.content) };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function githubFilesMatchingPageUrl(settings, pageUrl) {
  const directory = notesDirectory(settings);
  if (!directory) return [];
  try {
    const files = await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(directory).replace(/%2F/g, "/")}?ref=${encodeURIComponent(settings.branch)}`);
    if (!Array.isArray(files)) return [];
    const matchingFiles = [];
    for (const item of files.filter((item) => item.type === "file" && item.name.endsWith(".md"))) {
      try {
        const file = await githubFileAtPath(settings, item.path);
        if (file && canonicalPageUrl(notesFromMarkdown(file.content).pageUrl) === canonicalPageUrl(pageUrl)) matchingFiles.push(file);
      } catch (error) {
        console.warn("Web Highlighter Notes 旧笔记检查失败：", error);
      }
    }
    return matchingFiles;
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function githubWriteTarget(settings, pageUrl, pageTitle, sourceFile) {
  for (let number = 1; number <= 99; number += 1) {
    const path = numberedNotesPath(settings, pageUrl, pageTitle, number);
    const file = sourceFile.path === path && sourceFile.content ? sourceFile : await githubFileAtPath(settings, path);
    if (!file) return { path, file: null };
    if (file.content && canonicalPageUrl(notesFromMarkdown(file.content).pageUrl) === canonicalPageUrl(pageUrl)) return { path, file };
  }
  throw new Error("同名网页笔记过多，无法分配文件名");
}

async function readGithubNotes(pageUrl, pageTitle) {
  const settings = validatedGithubSettings(await githubSettings());
  const file = await githubFile(settings, pageUrl, pageTitle);
  return file.content ? notesFromMarkdown(file.content) : null;
}

function mergedAnnotations(remoteAnnotations, changedAnnotations, deletedAnnotationIds) {
  const deletedIds = new Set(deletedAnnotationIds || []);
  const annotationsById = new Map(remoteAnnotations.filter((annotation) => !deletedIds.has(annotation.id)).map((annotation) => [annotation.id, annotation]));
  changedAnnotations.forEach((annotation) => annotationsById.set(annotation.id, annotation));
  return [...annotationsById.values()];
}

async function writeGithubNotes({ pageUrl, pageTitle, pageFavicon, annotations, changedAnnotations, deletedAnnotationIds }) {
  const settings = validatedGithubSettings(await githubSettings());
  const normalizedPageUrl = canonicalPageUrl(pageUrl);
  if (!Array.isArray(annotations)) throw new Error("无效的笔记数据");
  const changed = Array.isArray(changedAnnotations) ? changedAnnotations : annotations;
  const deleted = Array.isArray(deletedAnnotationIds) ? deletedAnnotationIds : [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await githubFile(settings, normalizedPageUrl, pageTitle);
    const remoteNotes = file.content ? notesFromMarkdown(file.content) : { annotations: [] };
    const merged = mergedAnnotations(remoteNotes.annotations, changed, deleted);
    const resolvedTitle = String(pageTitle || remoteNotes.pageTitle || "");
    const resolvedFavicon = normalizedFavicon(pageFavicon || remoteNotes.pageFavicon, normalizedPageUrl);
    const target = await githubWriteTarget(settings, normalizedPageUrl, resolvedTitle, file);
    const targetPath = target.path;
    const body = {
      message: `notes: update ${new URL(normalizedPageUrl).hostname}`,
      content: encodeBase64(notesMarkdown({ pageUrl: normalizedPageUrl, pageTitle: resolvedTitle, pageFavicon: resolvedFavicon, annotations: merged })),
      branch: settings.branch
    };
    if (target.file?.sha) body.sha = target.file.sha;
    try {
      await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(targetPath).replace(/%2F/g, "/")}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (file.sha && file.path !== targetPath) {
        try {
          await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(file.path).replace(/%2F/g, "/")}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: `notes: rename ${new URL(normalizedPageUrl).hostname}`, sha: file.sha, branch: settings.branch })
          });
        } catch (error) {
          console.warn("Web Highlighter Notes 旧文件清理失败：", error);
        }
      }
      return { ...remoteNotes, pageUrl: normalizedPageUrl, pageTitle: resolvedTitle, pageFavicon: resolvedFavicon, annotations: merged };
    } catch (error) {
      if (attempt < 2 && (error.status === 409 || error.status === 422)) continue;
      throw error;
    }
  }
}

function runNoteOperation(pageUrl, operation) {
  const previous = noteOperations.get(pageUrl) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  noteOperations.set(pageUrl, current);
  return current.finally(() => {
    if (noteOperations.get(pageUrl) === current) noteOperations.delete(pageUrl);
  });
}

async function deleteGithubNotes(pageUrl, pageTitle) {
  const settings = validatedGithubSettings(await githubSettings());
  const normalizedPageUrl = canonicalPageUrl(pageUrl);
  let deletedCount = 0;
  const paths = new Set(notePaths(settings, normalizedPageUrl, pageTitle));
  (await githubFilesMatchingPageUrl(settings, normalizedPageUrl)).forEach((file) => paths.add(file.path));
  for (const path of paths) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let file;
      try {
        file = await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(settings.branch)}`);
      } catch (error) {
        if (error.status === 404) break;
        throw error;
      }
      try {
        await githubRequest(settings, `/repos/${settings.repository}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: `notes: delete ${new URL(normalizedPageUrl).hostname}`, sha: file.sha, branch: settings.branch })
        });
        deletedCount += 1;
        break;
      } catch (error) {
        if (attempt === 0 && (error.status === 409 || error.status === 422)) continue;
        throw error;
      }
    }
  }
  return { deletedCount };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "web-notes-root", title: "保存为网页笔记", contexts: ["selection"] });
    LEVELS.forEach((level) => {
      chrome.contextMenus.create({
        id: `web-notes-${level.id}-${level.headingLevel || level.weight || "normal"}`,
        parentId: "web-notes-root",
        title: level.menuLabel,
        contexts: ["selection"]
      });
    });
    chrome.contextMenus.create({ id: "web-notes-heading-root", parentId: "web-notes-root", title: "标题", contexts: ["selection"] });
    HEADING_LEVELS.forEach((headingLevel) => {
      chrome.contextMenus.create({
        id: `web-notes-heading-${headingLevel}`,
        parentId: "web-notes-heading-root",
        title: `H${headingLevel}`,
        contexts: ["selection"]
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.menuItemId.startsWith("web-notes-")) return;
  const levelKey = info.menuItemId.replace("web-notes-", "");
  const headingLevel = Number(levelKey.replace("heading-", ""));
  const level = HEADING_LEVELS.includes(headingLevel)
    ? { id: "heading", label: "标题", color: "transparent", weight: "normal", headingLevel }
    : LEVELS.find((item) => `${item.id}-${item.weight || "normal"}` === levelKey);
  if (level) chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_SELECTION", level }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const actions = {
    GET_GITHUB_NOTES: () => runNoteOperation(canonicalPageUrl(message.pageUrl), () => readGithubNotes(canonicalPageUrl(message.pageUrl), message.pageTitle)),
    SAVE_GITHUB_NOTES: () => runNoteOperation(canonicalPageUrl(message.pageUrl), () => writeGithubNotes(message)),
    DELETE_GITHUB_NOTES: () => runNoteOperation(canonicalPageUrl(message.pageUrl), () => deleteGithubNotes(message.pageUrl, message.pageTitle)),
    VERIFY_GITHUB_SETTINGS: () => verifyGithubSettings(message.settings),
    DOWNLOAD_MARKDOWN: () => downloadMarkdown(message)
  };
  const action = actions[message.type];
  if (!action) return;
  action().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message || "GitHub 笔记操作失败" }));
  return true;
});
