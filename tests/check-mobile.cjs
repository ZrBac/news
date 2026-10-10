const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(process.env.NEWS_TEST_SITE || "_site");
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://local").pathname;
  const file = path.resolve(
    root,
    "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname),
  );
  if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
  try {
    const body = await fs.readFile(file);
    const type = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    response
      .writeHead(200, {
        "Content-Type": type[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    NEWS_TEST_SITE: root,
    NEWS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NEWS_LEGACY_SAFARI: "1",
  };
  try {
    for (const name of [
      "indexed-news-browser.cjs",
      "news-loading-browser.cjs",
      "news-pages-browser.cjs",
      "pwa-browser.cjs",
      "guide-download-browser.cjs",
      "offline-recovery-browser.cjs",
    ]) {
      console.log("Checking " + name);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, name)], {
          env,
          stdio: "inherit",
        });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(name + " timed out"));
        }, 120000);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(name + " failed: " + code));
        });
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
