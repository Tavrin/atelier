import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function availableChromium() {
  const candidates = [
    process.env.ATELIER_CHROME_BIN,
    process.env.CHROME_BIN,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      : undefined,
    process.platform === "win32"
      ? join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32"
      ? join(
          process.env["PROGRAMFILES(X86)"] || "",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || "",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        )
      : undefined,
    process.platform === "win32"
      ? join(
          process.env["PROGRAMFILES(X86)"] || "",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        )
      : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking platform-appropriate browser locations.
    }
  }
  return undefined;
}

function denseBoardPage() {
  const cards = Array.from(
    { length: 29 },
    (_, index) => `
      <article class="issue-card priority-p2" tabindex="0" role="button">
        <div class="card-meta"><span class="card-id">atelier-${index + 1}</span></div>
        <div class="card-title">Dense ready ticket ${index + 1}</div>
      </article>`,
  ).join("");
  return `<!doctype html>
    <html data-theme="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/atelier.css">
      </head>
      <body>
        <main class="content project-view">
          <div class="view-header"><h1 class="view-title">Atelier</h1></div>
          <div class="banner-stack">
            <div class="main-health-banner-slot">
              <div class="error-banner main-health-failure">Main-health failure</div>
            </div>
          </div>
          <div class="tabs"><div class="tab-list"><button class="tab active">Board</button></div></div>
          <section class="tab-panel project-tab-panel board-tab-panel">
            <section class="project-controls">
              <section class="queue-card"><h2>Ready queue</h2></section>
            </section>
            <section class="board-region">
              <div class="board-filter"><input aria-label="Filter board tickets"><span>29 tickets</span></div>
              <div class="board">
                <section class="column" data-kind="ready">
                  <header class="column-header"><h2 class="column-title">Ready</h2><span class="count">29</span></header>
                  <div class="card-list" tabindex="0" role="region" aria-label="Ready tickets">${cards}</div>
                </section>
              </div>
            </section>
          </section>
          <output id="qa-result" hidden></output>
        </main>
        <script>
          const column = document.querySelector('.column');
          const body = document.querySelector('.card-list');
          const before = body.scrollTop;
          body.scrollTop = 240;
          document.querySelector('#qa-result').textContent = JSON.stringify({
            before,
            after: body.scrollTop,
            columnClientHeight: column.clientHeight,
            columnScrollHeight: column.scrollHeight,
            bodyClientHeight: body.clientHeight,
            bodyScrollHeight: body.scrollHeight,
            columnOverflowY: getComputedStyle(column).overflowY,
            bodyOverflowY: getComputedStyle(body).overflowY
          });
        </script>
      </body>
    </html>`;
}

test("dense board has real browser overflow and movable card-body scroll", async (t) => {
  const browser = await availableChromium();
  assert.ok(
    browser,
    "Chrome, Chromium, or Edge is required for the board overflow regression; set ATELIER_CHROME_BIN to its executable",
  );

  const css = await readFile(new URL("./atelier.css", import.meta.url), "utf8");
  const html = denseBoardPage();
  const profile = await mkdtemp(join(tmpdir(), "atelier-board-browser-"));
  const server = createServer((request, response) => {
    if (request.url === "/atelier.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(css);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });

  const address = server.address();
  const { stdout } = await execFileAsync(
    browser,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "--virtual-time-budget=3000",
      "--dump-dom",
      `http://127.0.0.1:${address.port}`,
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
  );
  const match = stdout.match(/<output id="qa-result" hidden="">([^<]+)<\/output>/);
  assert.ok(match, "browser emitted the board overflow result");
  const result = JSON.parse(match[1]);

  assert.equal(result.before, 0);
  assert.equal(result.columnOverflowY, "hidden");
  assert.equal(result.bodyOverflowY, "auto");
  assert.equal(result.columnScrollHeight, result.columnClientHeight);
  assert.ok(result.bodyScrollHeight > result.bodyClientHeight, "29 cards overflow the bounded body");
  assert.equal(result.after, 240, "the browser moves the card-body scroll position");
});
