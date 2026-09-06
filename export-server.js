const http = require("node:http");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const port = 3517;
const exportsDirectory = path.join(__dirname, "exports");

function send(response, status, data) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  return JSON.parse(body);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return send(response, 204, {});
  if (request.method !== "POST" || request.url !== "/export") return send(response, 404, { error: "Not found" });

  try {
    const { filename, content } = await requestBody(request);
    const safeFilename = path.basename(String(filename)).replace(/[^\w.-]/g, "-");
    if (!safeFilename.endsWith(".md") || !content) throw new Error("无效的导出内容");
    await mkdir(exportsDirectory, { recursive: true });
    const outputPath = path.join(exportsDirectory, safeFilename);
    await writeFile(outputPath, String(content), "utf8");
    send(response, 200, { filename: safeFilename, path: outputPath });
  } catch (error) {
    send(response, 400, { error: error.message || "无法保存文件" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Markdown export service listening on http://127.0.0.1:${port}`);
  console.log(`Exports are written to ${exportsDirectory}`);
});
