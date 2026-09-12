const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const test = require("node:test");
const vm = require("node:vm");

const SETTINGS_KEY = "web-highlighter-notes-github-settings";

async function backgroundHarness() {
  const settings = {
    [SETTINGS_KEY]: {
      repository: "blackCY/web-highlighter-notes",
      branch: "main",
      directory: "notes",
      token: "test-token"
    }
  };
  let storedContent = null;
  let storedSha = null;
  let revision = 0;
  let conflictsRemaining = 0;
  let downloadOptions;
  let lastWritePath;
  let installedListener;
  const menuItems = [];
  const context = {
    URL,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    chrome: {
      storage: { local: { get: async (key) => ({ [key]: settings[key] }) } },
      downloads: { download: async (options) => { downloadOptions = options; return 7; } },
      runtime: { onInstalled: { addListener(listener) { installedListener = listener; } }, onMessage: { addListener() {} } },
      contextMenus: { removeAll(callback) { callback(); }, create(item) { menuItems.push(item); }, onClicked: { addListener() {} } }
    },
    fetch: async (url, options = {}) => {
      if (url.includes("/branches/main")) return { ok: true, status: 200, json: async () => ({ name: "main" }) };
      if (!options.method) {
        if (!storedContent) return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
        return { ok: true, status: 200, json: async () => ({ sha: storedSha, content: storedContent }) };
      }
      if (options.method === "PUT") {
        lastWritePath = decodeURIComponent(new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
        if (conflictsRemaining > 0) {
          conflictsRemaining -= 1;
          return { ok: false, status: 422, json: async () => ({ message: "sha does not match" }) };
        }
        const body = JSON.parse(options.body);
        if (storedContent && body.sha !== storedSha) return { ok: false, status: 422, json: async () => ({ message: "sha does not match" }) };
        storedContent = body.content;
        storedSha = `sha-${++revision}`;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (options.method === "DELETE") {
        if (conflictsRemaining > 0) {
          conflictsRemaining -= 1;
          storedSha = `sha-${++revision}`;
          return { ok: false, status: 422, json: async () => ({ message: "sha does not match" }) };
        }
        const body = JSON.parse(options.body);
        if (body.sha !== storedSha) return { ok: false, status: 422, json: async () => ({ message: "sha does not match" }) };
        storedContent = null;
        storedSha = null;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${options.method}`);
    }
  };
  const source = await readFile("background.js", "utf8");
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__test = { decodeBase64, deleteGithubNotes, downloadMarkdown, legacyNotesPath, notesFromMarkdown, notesPath, verifyGithubSettings, writeGithubNotes, readGithubNotes };`, context);
  return {
    api: context.__test,
    setConflicts: (count) => { conflictsRemaining = count; },
    markdown: () => context.__test.decodeBase64(storedContent),
    download: () => downloadOptions,
    lastWritePath: () => lastWritePath,
    menuItems: () => menuItems,
    runInstall: () => installedListener()
  };
}

async function multiFileDeletionHarness() {
  const settings = {
    [SETTINGS_KEY]: { repository: "blackCY/web-highlighter-notes", branch: "main", directory: "notes", token: "test-token" }
  };
  const files = new Map();
  const requestPath = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const context = {
    URL,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    chrome: {
      storage: { local: { get: async (key) => ({ [key]: settings[key] }) } },
      downloads: { download: async () => 1 },
      runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
      contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } }
    },
    fetch: async (url, options = {}) => {
      const path = requestPath(url);
      const file = files.get(path);
      if (!options.method) {
        if (!file) return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
        return { ok: true, status: 200, json: async () => file };
      }
      if (options.method === "DELETE") {
        const body = JSON.parse(options.body);
        if (!file || file.sha !== body.sha) return { ok: false, status: 422, json: async () => ({ message: "sha does not match" }) };
        files.delete(path);
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${options.method}`);
    }
  };
  const source = await readFile("background.js", "utf8");
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__test = { deleteGithubNotes, notePaths };`, context);
  return {
    api: context.__test,
    addFile: (path, sha) => files.set(path, { sha, content: btoa("unused") }),
    filePaths: () => [...files.keys()]
  };
}

async function locatorHarness() {
  const source = await readFile("content.js", "utf8");
  const helperSource = source.slice(0, source.indexOf("function textNodeAtOffset"));
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nglobalThis.__test = { bestTextMatch };`, context);
  return context.__test;
}

async function highlightHarness() {
  const source = await readFile("content.js", "utf8");
  const helperSource = source.slice(0, source.indexOf("async function annotations"));
  const marks = [{ id: "first", textContent: "AAAA" }, { id: "second", textContent: "AA" }];
  const context = {
    URL,
    document: { querySelectorAll: () => marks },
    Node: { ELEMENT_NODE: 1 }
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nglobalThis.__test = { highlightDuplicateRange, sameAnnotationRange };`, context);
  return context.__test;
}

async function markStyleHarness() {
  const source = await readFile("content.js", "utf8");
  const helperSource = source.slice(0, source.indexOf("function applyAnnotationStyle"));
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nglobalThis.__test = { applyMarkStyle };`, context);
  return context.__test;
}

async function contentPersistenceHarness({ fail = false } = {}) {
  const source = await readFile("content.js", "utf8");
  const helperSource = source.slice(0, source.indexOf("function showToast"));
  const requests = [];
  const context = {
    URL,
    location: { href: "https://example.com/article?tracking=1#section" },
    document: { title: "测试页面", querySelectorAll: () => [] },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          requests.push(message);
          if (fail) return { ok: false, error: "网络暂时不可用" };
          return { ok: true, data: { annotations: message.annotations } };
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nglobalThis.__test = { save, setCachedAnnotations: (items) => { cachedAnnotations = items; }, cachedAnnotationIds: () => cachedAnnotations.map((item) => item.id) };`, context);
  return { api: context.__test, requests };
}

async function popupHarness() {
  const source = await readFile("popup.js", "utf8");
  const helperSource = source.slice(0, source.indexOf('document.getElementById("export")'));
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nglobalThis.__test = { annotationSearchText, orderedAnnotationEntries, exportFilename, markdown, setCurrentTab: (tab) => { currentTab = tab; }, setPageAnnotations: (items) => { pageAnnotations = items; } };`, context);
  return context.__test;
}

function annotation(id, quote, order = 1) {
  return { id, type: "text", level: "important", quote, createdAt: "2026-09-12T00:00:00.000Z", selector: { order, start: 0 } };
}

test("GitHub sync merges stale-tab additions and preserves remote edits during deletion", async () => {
  const { api, setConflicts } = await backgroundHarness();
  const pageUrl = "https://example.com/article";
  const alpha = annotation("alpha", "第一条", 1);
  const betaOld = annotation("beta", "第二条旧版本", 2);
  const betaNew = annotation("beta", "第二条新版本", 2);

  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [alpha], changedAnnotations: [alpha] });
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [betaOld], changedAnnotations: [betaOld] });
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [alpha, betaNew], changedAnnotations: [betaNew] });
  setConflicts(1);
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [betaOld], changedAnnotations: [], deletedAnnotationIds: ["alpha"] });

  const notes = await api.readGithubNotes(pageUrl);
  assert.deepEqual(Array.from(notes.annotations, (item) => item.id), ["beta"]);
  assert.equal(notes.annotations[0].quote, "第二条新版本");
});

test("GitHub saves retry multiple stale file versions without using cached reads", async () => {
  const { api, setConflicts } = await backgroundHarness();
  const pageUrl = "https://example.com/article";
  const item = annotation("media", "媒体保存冲突");
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [item], changedAnnotations: [item] });
  setConflicts(2);
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [item], changedAnnotations: [item] });
  const notes = await api.readGithubNotes(pageUrl);
  assert.equal(notes.annotations[0].id, "media");
  assert.match(await readFile("background.js", "utf8"), /cache: "no-store"/);
});

test("whole-page deletion retries a stale GitHub file version", async () => {
  const { api, setConflicts } = await backgroundHarness();
  const pageUrl = "https://example.com/article";
  const item = annotation("first", "需要清除的记录");
  await api.writeGithubNotes({ pageUrl, pageTitle: "测试", annotations: [item], changedAnnotations: [item] });
  setConflicts(1);
  await api.deleteGithubNotes(pageUrl);
  assert.equal(await api.readGithubNotes(pageUrl), null);
});

test("force deletion clears both current and legacy GitHub note files", async () => {
  const { api, addFile, filePaths } = await multiFileDeletionHarness();
  const pageUrl = "https://example.com/article";
  const [currentPath, legacyPath] = api.notePaths({ repository: "blackCY/web-highlighter-notes", branch: "main", directory: "notes", token: "test-token" }, pageUrl);
  addFile(currentPath, "current-sha");
  addFile(legacyPath, "legacy-sha");

  const result = await api.deleteGithubNotes(pageUrl);

  assert.equal(result.deletedCount, 2);
  assert.deepEqual(Array.from(filePaths()), []);
});

test("Markdown metadata supports special characters and legacy JSON files", async () => {
  const { api, markdown } = await backgroundHarness();
  const special = { ...annotation("special", "文本 --> <script>"), note: "备注 --> 也不能截断", personalNotes: { idea: "包含 --> 与中文" } };
  const following = { ...annotation("following", "第二条", 2), level: "note", color: "#e5e7eb" };
  await api.writeGithubNotes({
    pageUrl: "https://example.com", pageTitle: "标题 -->", pageFavicon: "https://static.example/favicon.png",
    annotations: [special, following], changedAnnotations: [special, following]
  });

  const notes = await api.readGithubNotes("https://example.com");
  assert.equal(notes.annotations[0].note, special.note);
  assert.equal(notes.pageTitle, "标题 -->");
  assert.equal(notes.pageUrl, "https://example.com/");
  assert.equal(notes.pageFavicon, "https://static.example/favicon.png");
  assert.match(markdown(), /笔记：备注/);
  assert.match(markdown(), /<span style="background-color: #dc2626;[^>]*"><strong>文本 --&gt; &lt;script&gt;<\/strong><\/span>/);
  assert.doesNotMatch(markdown(), /\[重要\]/);
  assert.match(markdown(), /^---\ntitle: "标题 -->"\nsource_url: "https:\/\/example\.com\/"\nfavicon: "https:\/\/static\.example\/favicon\.png"\nupdated_at: /);
  assert.doesNotMatch(markdown(), /^# 标题 --\\>$/m);
  assert.doesNotMatch(markdown(), /^- 原文网址：|^- 最近更新：/m);
  assert.match(markdown(), /备注 --\\> 也不能截断\n- \[笔记\] 第二条/);
  assert.doesNotMatch(markdown(), /备注 --\\> 也不能截断\n\n- \[笔记\] 第二条/);
  const legacy = `---\ntitle: "Front Matter 标题"\nsource_url: "https://front-matter.example/article"\nfavicon: "https://front-matter.example/icon.png"\nupdated_at: "2026-09-12T12:00:00.000Z"\n---\n<!-- web-highlighter-notes-data\n${JSON.stringify({ version: 1, pageUrl: "https://legacy.example", pageTitle: "旧标题", annotations: [special] })}\nweb-highlighter-notes-data -->\n`;
  const restored = api.notesFromMarkdown(legacy);
  assert.equal(restored.pageUrl, "https://front-matter.example/article");
  assert.equal(restored.pageTitle, "Front Matter 标题");
  assert.equal(restored.pageFavicon, "https://front-matter.example/icon.png");
  assert.equal(restored.updatedAt, "2026-09-12T12:00:00.000Z");
});

test("heading annotations persist to GitHub without a generated footer", async () => {
  const { api, markdown } = await backgroundHarness();
  const heading = {
    ...annotation("heading", "章节标题"), type: "heading", level: "heading", color: "transparent",
    headingLevel: 3, badgeTypes: ["h3"]
  };

  await api.writeGithubNotes({ pageUrl: "https://example.com/article", pageTitle: "页面标题", annotations: [heading], changedAnnotations: [heading] });

  const notes = await api.readGithubNotes("https://example.com/article");
  assert.equal(notes.annotations[0].type, "heading");
  assert.equal(notes.annotations[0].headingLevel, 3);
  assert.match(markdown(), /^### 章节标题$/m);
  assert.doesNotMatch(markdown(), /此文件由 Web Highlighter Notes 自动维护/);
});

test("GitHub settings are verified and Markdown exports use browser downloads", async () => {
  const { api, download } = await backgroundHarness();
  await api.verifyGithubSettings({ repository: "blackCY/web-highlighter-notes", branch: "main", directory: "notes", token: "test-token" });
  const result = await api.downloadMarkdown({ filename: "example.md", content: "# 测试\n" });
  assert.equal(result.downloadId, 7);
  assert.equal(download().filename, "web-highlighter-notes/example.md");
  assert.match(download().url, /^data:text\/markdown;charset=utf-8,/);
  assert.equal(download().saveAs, false);

  const chineseResult = await api.downloadMarkdown({ filename: "网页标题：测试.md", content: "# 测试\n" });
  assert.equal(chineseResult.filename, "网页标题：测试.md");
  assert.equal(download().filename, "web-highlighter-notes/网页标题：测试.md");
});

test("Markdown exports use the current page title as the filename", async () => {
  const popup = await popupHarness();
  popup.setCurrentTab({ title: "网页标题：测试", url: "https://www.example.com/article" });
  assert.equal(popup.exportFilename(), "网页标题：测试.md");
});

test("downloaded Markdown starts with notes and keeps entries compact", async () => {
  const popup = await popupHarness();
  popup.setCurrentTab({ title: "网页标题", url: "https://example.com/article" });
  popup.setPageAnnotations([
    annotation("first", "第一条", 1),
    annotation("second", "第二条", 2)
  ]);
  assert.equal(popup.markdown(), "- <span style=\"background-color: #dc2626; color: #ffffff; font-size: 1em; padding: 1px 4px; border-radius: 3px;\">第一条</span>\n- <span style=\"background-color: #dc2626; color: #ffffff; font-size: 1em; padding: 1px 4px; border-radius: 3px;\">第二条</span>");
});

test("extension popup lists notes without per-note editing controls", async () => {
  const [html, source] = await Promise.all([readFile("popup.html", "utf8"), readFile("popup.js", "utf8")]);
  assert.doesNotMatch(html, /textarea class="note"/);
  assert.doesNotMatch(source, /note-save/);
  assert.match(await readFile("content.js", "utf8"), /function openAnnotationNoteEditor/);
});

test("page toolbars stay visible with a loading state while notes sync", async () => {
  const [source, css] = await Promise.all([readFile("content.js", "utf8"), readFile("content.css", "utf8")]);
  assert.match(source, /function setToolbarSaving\(isSaving\)/);
  assert.match(source, /setToolbarSaving\(true\);/);
  assert.match(source, /appendSavingIndicator\(toolbar\)/);
  assert.match(source, /appendSavingIndicator\(mediaToolbar\)/);
  assert.match(css, /\.web-notes-saving-spinner/);
  assert.match(css, /@keyframes web-notes-saving-spin/);
});

test("extension popup shows a fixed-height loading skeleton for the note list", async () => {
  const [html, css, source, content] = await Promise.all([readFile("popup.html", "utf8"), readFile("popup.css", "utf8"), readFile("popup.js", "utf8"), readFile("content.js", "utf8")]);
  assert.match(html, /id="notes-skeleton"/);
  assert.match(css, /#notes-list \{ height: 220px; overflow-y: auto; \}/);
  assert.match(css, /#notes-list > \[hidden\] \{ display: none !important; \}/);
  assert.match(source, /function setNotesLoading\(isLoading\)/);
  assert.match(source, /NOTES_LOADING_MINIMUM_DURATION = 180/);
  assert.match(source, /async function currentPageAnnotations\(\)/);
  assert.match(content, /message\.type === "GET_PAGE_ANNOTATIONS"/);
});

test("extension popup provides protected GitHub Token viewing and copying controls", async () => {
  const [html, source] = await Promise.all([readFile("popup.html", "utf8"), readFile("popup.js", "utf8")]);
  assert.match(html, /id="github-token" type="password"/);
  assert.match(html, /id="toggle-github-token"/);
  assert.match(html, /id="copy-github-token"/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /input\.type = visible \? "password" : "text"/);
});

test("extension popup opens a right-side Markdown preview in the current page", async () => {
  const [html, popup, content, css] = await Promise.all([
    readFile("popup.html", "utf8"), readFile("popup.js", "utf8"), readFile("content.js", "utf8"), readFile("content.css", "utf8")
  ]);
  assert.match(html, /id="preview-markdown"/);
  assert.match(popup, /type: "SHOW_MARKDOWN_PREVIEW", markdown: markdown\(\)/);
  assert.match(content, /function showMarkdownPreview\(markdown\)/);
  assert.match(content, /function renderMarkdownPreview\(markdown\)/);
  assert.match(content, /message\.type === "SHOW_MARKDOWN_PREVIEW"/);
  assert.match(css, /#web-notes-markdown-preview/);
});

test("extension popup can locate each note in the current page", async () => {
  const [popup, content, css] = await Promise.all([readFile("popup.js", "utf8"), readFile("content.js", "utf8"), readFile("content.css", "utf8")]);
  assert.match(popup, /class="locate-note"/);
  assert.match(popup, /type: "LOCATE_ANNOTATION"/);
  assert.match(content, /function locateAnnotation\(annotationId\)/);
  assert.match(content, /message\.type === "LOCATE_ANNOTATION"/);
  assert.match(css, /\.web-notes-locate-target/);
});

test("recorded media switches the page action to deletion", async () => {
  const [source, css] = await Promise.all([readFile("content.js", "utf8"), readFile("content.css", "utf8")]);
  assert.match(source, /function mediaAnnotationsFor\(media\)/);
  assert.match(source, /button\.textContent = annotations\.length \? "删除此媒体" : "记录此媒体"/);
  assert.match(source, /const badgesByMedia = new Map\(\)/);
  assert.match(source, /已删除重复媒体记录/);
  assert.match(source, /deletedAnnotationIds/);
  assert.match(css, /\.web-notes-media-delete/);
});

test("new notes use page-title filenames while retaining legacy paths", async () => {
  const { api, lastWritePath } = await backgroundHarness();
  const settings = { repository: "blackCY/web-highlighter-notes", branch: "main", directory: "notes", token: "test-token" };
  const pageUrl = "https://docs.example.com/articles/intro?utm=campaign#top";
  const titlePath = api.notesPath(settings, pageUrl, "文档首页：入门指南");
  const normalizedTitlePath = api.notesPath(settings, "https://docs.example.com/articles/intro", "文档首页：入门指南");
  assert.equal(titlePath, "notes/文档首页：入门指南.md");
  assert.equal(api.notesPath(settings, pageUrl), "notes/docs.example.com.md");
  assert.match(api.legacyNotesPath(settings, pageUrl), /^notes\/[a-f0-9]{16}\.md$/);
  const item = annotation("title-path", "标题文件名");
  await api.writeGithubNotes({ pageUrl, pageTitle: "文档首页：入门指南", annotations: [item], changedAnnotations: [item] });
  assert.equal(lastWritePath(), normalizedTitlePath);
});

test("context menu provides separate normal and bold note actions", async () => {
  const harness = await backgroundHarness();
  harness.runInstall();
  const ids = harness.menuItems().map((item) => item.id);
  assert.ok(ids.includes("web-notes-note-normal"));
  assert.ok(ids.includes("web-notes-note-bold"));
  const headingLevels = [1, 2, 3, 4, 5, 6];
  assert.ok(ids.includes("web-notes-heading-root"));
  headingLevels.forEach((level) => assert.ok(ids.includes(`web-notes-heading-${level}`)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(harness.menuItems().find((item) => item.id === "web-notes-note-normal").title, "默认笔记");
});

test("text recovery scores duplicate quotes by context before falling back to position", async () => {
  const { bestTextMatch } = await locatorHarness();
  const quote = "重复摘录";
  const text = "开头 重复摘录 旧内容发生变化后，仍应选择这里的 重复摘录 结尾";
  const laterIndex = text.lastIndexOf(quote);
  const selector = { start: laterIndex + 3, prefix: "旧内容发生变化后，仍应选择这里的 ", suffix: " 结尾" };
  assert.equal(bestTextMatch(text, quote, selector), laterIndex);
  const duplicateText = "重复摘录 中间 重复摘录";
  const secondIndex = duplicateText.lastIndexOf(quote);
  assert.equal(bestTextMatch(duplicateText, quote, { start: secondIndex + 2, prefix: "", suffix: "" }), secondIndex);
  const reorderedText = "重复摘录 与目标无关 前文目标 重复摘录 后文";
  assert.equal(bestTextMatch(reorderedText, quote, { start: 0, prefix: "前文目标 ", suffix: " 后文" }), reorderedText.lastIndexOf(quote));
});

test("heading highlights keep page typography unchanged", async () => {
  const { applyMarkStyle } = await markStyleHarness();
  const removedClasses = [];
  const mark = { classList: { remove: (value) => removedClasses.push(value) }, dataset: { webNotesHeading: "2" }, style: {} };

  applyMarkStyle(mark, { type: "heading", headingLevel: 2 });

  assert.deepEqual(removedClasses, ["web-notes-heading-highlight"]);
  assert.equal(mark.dataset.webNotesHeading, undefined);
  assert.equal(mark.style.backgroundColor, "#c4b5fd");
  assert.equal(mark.style.fontWeight, "inherit");
  assert.equal(mark.style.fontSize, "inherit");
  assert.equal(mark.style.textDecorationLine, "none");
});

test("popup orders annotations by page position while retaining source indexes for edits", async () => {
  const popup = await popupHarness();
  popup.setPageAnnotations([
    { id: "bottom", quote: "底部", selector: { order: 9, start: 0 }, createdAt: "2026-09-12T00:00:00.000Z" },
    { id: "media", type: "media", source: "https://example.com/image.png", selector: { order: 2, start: 5 }, createdAt: "2026-09-12T00:00:30.000Z" },
    { id: "top", quote: "顶部", selector: { order: 2, start: 10 }, createdAt: "2026-09-12T00:01:00.000Z" }
  ]);
  const entries = popup.orderedAnnotationEntries();
  assert.deepEqual(Array.from(entries, ({ annotation, index }) => [annotation.id, index]), [["media", 1], ["top", 2], ["bottom", 0]]);
  assert.match(popup.annotationSearchText({ quote: "摘录", personalNotes: { idea: "可搜索的想法" } }), /可搜索的想法/);
});

test("media notes store a selector and repair legacy media ordering", async () => {
  const source = await readFile("content.js", "utf8");
  assert.match(source, /function mediaPositionSelector\(media\)/);
  assert.match(source, /async function migrateMediaPositions\(items\)/);
  assert.match(source, /selector: mediaPositionSelector\(selectedMedia\)/);
  assert.match(source, /const items = await migrateMediaPositions\(await annotations\(\)\);/);
});

test("GitHub Markdown keeps media at its saved page position", async () => {
  const { api, markdown } = await backgroundHarness();
  const media = {
    id: "media", type: "media", mediaType: "img", source: "https://example.com/image.png", label: "配图",
    selector: { order: 2, start: 5 }, createdAt: "2026-09-12T00:00:00.000Z"
  };
  const text = { ...annotation("text", "后面的文字", 2), selector: { order: 2, start: 10 } };

  await api.writeGithubNotes({ pageUrl: "https://example.com/article", pageTitle: "页面", annotations: [text, media], changedAnnotations: [text, media] });

  assert.ok(markdown().indexOf("![配图](https://example.com/image.png)") < markdown().indexOf("后面的文字"));
});

test("only duplicate selections are blocked while contained ranges remain recordable", async () => {
  const { highlightDuplicateRange, sameAnnotationRange } = await highlightHarness();
  assert.equal(highlightDuplicateRange({ toString: () => "AA", intersectsNode: (mark) => mark.id === "second" }).id, "second");
  assert.equal(highlightDuplicateRange({ toString: () => "AA", intersectsNode: (mark) => mark.id === "first" }), null);
  assert.equal(highlightDuplicateRange({ toString: () => "AAAA", intersectsNode: () => false }), null);
  const outer = { ...annotation("outer", "AAAA"), selector: { anchor: { type: "id", value: "article" }, order: 5, start: 8, end: 12 } };
  const duplicate = { ...outer, id: "duplicate", weight: "bold" };
  const nested = { ...annotation("nested", "AA"), selector: { anchor: { type: "id", value: "article" }, order: 5, start: 9, end: 11 } };
  assert.equal(sameAnnotationRange(outer, duplicate), true);
  assert.equal(sameAnnotationRange(outer, nested), false);
});

test("failed GitHub saves do not leave unsynced annotations in the page cache", async () => {
  const { api, requests } = await contentPersistenceHarness({ fail: true });
  api.setCachedAnnotations([annotation("saved", "已经同步")]);

  await assert.rejects(api.save(annotation("unsynced", "保存失败")), /网络暂时不可用/);

  assert.deepEqual(Array.from(api.cachedAnnotationIds()), ["saved"]);
  assert.deepEqual(Array.from(requests[0].annotations, (item) => item.id), ["saved", "unsynced"]);
});
