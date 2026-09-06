const LEVELS = [
  { id: "important", label: "重要", color: "#fde68a" },
  { id: "idea", label: "想法", color: "#bbf7d0" },
  { id: "question", label: "疑问", color: "#bfdbfe" },
  { id: "review", label: "复习", color: "#fbcfe8" }
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "web-notes-root", title: "保存为网页笔记", contexts: ["selection"] });
    LEVELS.forEach((level) => {
      chrome.contextMenus.create({
        id: `web-notes-${level.id}`,
        parentId: "web-notes-root",
        title: `${level.label}标记`,
        contexts: ["selection"]
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.menuItemId.startsWith("web-notes-")) return;
  const levelId = info.menuItemId.replace("web-notes-", "");
  const level = LEVELS.find((item) => item.id === levelId);
  if (level) chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_SELECTION", level });
});
