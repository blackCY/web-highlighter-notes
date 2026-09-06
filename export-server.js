const http = require("node:http");
const { execFile } = require("node:child_process");
const { mkdir, readdir, readFile, writeFile } = require("node:fs/promises");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 3517);
const defaultExportsDirectory = path.join(__dirname, "exports");
const configPath = path.join(__dirname, ".exporter-config.json");
let configuredExportsDirectory;

function send(response, status, data) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(data));
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 5 * 1024 * 1024) throw new Error("导出内容超过 5 MB 限制");
  }
  return body ? JSON.parse(body) : {};
}

async function exportsDirectory() {
  if (configuredExportsDirectory) return configuredExportsDirectory;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof config.directory === "string" && config.directory.trim()) {
      configuredExportsDirectory = path.resolve(config.directory);
      return configuredExportsDirectory;
    }
  } catch { /* Use the project default when no saved configuration exists. */ }
  configuredExportsDirectory = defaultExportsDirectory;
  return configuredExportsDirectory;
}

async function setExportsDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("请输入有效的导出目录");
  const resolvedDirectory = path.resolve(directory.trim());
  await mkdir(resolvedDirectory, { recursive: true });
  configuredExportsDirectory = resolvedDirectory;
  await writeFile(configPath, `${JSON.stringify({ directory: resolvedDirectory }, null, 2)}\n`, "utf8");
  return resolvedDirectory;
}

async function chooseExportsDirectory() {
  if (process.platform !== "darwin") throw new Error("当前系统请手动输入保存目录的绝对路径");
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", "POSIX path of (choose folder with prompt \"选择网页笔记导出文件夹\")"]);
  return setExportsDirectory(stdout.trim());
}

async function existingExportFilename(pageUrl, directory) {
  const sourceLine = `- 原文网址：${pageUrl}`;
  const files = await readdir(directory, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".md")) continue;
    const exportedContent = await readFile(path.join(directory, file.name), "utf8");
    if (exportedContent.includes(sourceLine)) return file.name;
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, {});

  try {
    if (request.method === "GET" && request.url === "/settings") {
      return send(response, 200, { directory: await exportsDirectory(), defaultDirectory: defaultExportsDirectory });
    }
    if (request.method === "POST" && request.url === "/settings") {
      const { directory } = await requestBody(request);
      return send(response, 200, { directory: await setExportsDirectory(directory) });
    }
    if (request.method === "POST" && request.url === "/choose-directory") {
      return send(response, 200, { directory: await chooseExportsDirectory() });
    }
    if (request.method !== "POST" || request.url !== "/export") return send(response, 404, { error: "Not found" });

    const { filename, content, pageUrl } = await requestBody(request);
    const safeFilename = path.basename(String(filename)).replace(/[^\w.-]/g, "-");
    if (!safeFilename.endsWith(".md") || !content || !pageUrl) throw new Error("无效的导出内容");
    const directory = await exportsDirectory();
    await mkdir(directory, { recursive: true });
    const existingFilename = await existingExportFilename(String(pageUrl), directory);
    const targetFilename = existingFilename || safeFilename;
    const outputPath = path.join(directory, targetFilename);
    await writeFile(outputPath, String(content), "utf8");
    send(response, 200, { filename: targetFilename, path: outputPath, action: existingFilename ? "updated" : "created" });
  } catch (error) {
    send(response, 400, { error: error.message || "无法保存文件" });
  }
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`Markdown export service listening on http://127.0.0.1:${port}`);
  console.log(`Exports are written to ${await exportsDirectory()}`);
});
