/**
 * RECF Knowledge Base Archiver
 * Uses Puppeteer to crawl and save the full RECF v5RC KB site.
 *
 * SETUP:
 *   npm install puppeteer cheerio fs-extra
 *   node recf-archiver.js
 *
 * OUTPUT:
 *   ./recf-archive/  — all pages saved as .html files, assets downloaded
 *   ./recf-archive/index.json — map of all pages crawled
 */

const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");
const https = require("https");
const http = require("http");
const url = require("url");

// ── Config ──────────────────────────────────────────────────────────────────
const START_URL = "https://v5rc-kb.recf.org/hc/en-us";
const BASE_ORIGIN = "https://v5rc-kb.recf.org";
const OUT_DIR = "./recf-archive";
const DELAY_MS = 1500;        // polite delay between pages (ms)
const MAX_PAGES = 2000;       // safety cap
const CONCURRENCY = 1;        // pages at a time (keep at 1 to avoid bans)
// ────────────────────────────────────────────────────────────────────────────

const visited = new Set();
const queue = [START_URL];
const index = [];

function slugify(pageUrl) {
  const parsed = new url.URL(pageUrl);
  let filePath = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
  if (!filePath) filePath = "index";
  filePath = filePath.replace(/[^a-zA-Z0-9/_-]/g, "_");
  if (!filePath.endsWith(".html")) filePath += ".html";
  return filePath;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve) => {
    const proto = fileUrl.startsWith("https") ? https : http;
    fs.ensureDirSync(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    proto
      .get(fileUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          return downloadFile(res.headers.location, destPath).then(resolve);
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      })
      .on("error", () => { file.close(); resolve(); }); // skip on error
  });
}

async function extractLinks(page, pageUrl) {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map((a) => a.href)
  );
  return links
    .map((l) => {
      try {
        const u = new url.URL(l, pageUrl);
        u.hash = "";
        u.search = "";
        return u.href;
      } catch {
        return null;
      }
    })
    .filter(
      (l) =>
        l &&
        l.startsWith(BASE_ORIGIN + "/hc/en-us") &&
        !l.match(/\.(pdf|png|jpg|jpeg|gif|svg|css|js|zip|ico)$/i)
    );
}

async function savePage(page, pageUrl) {
  const filePath = path.join(OUT_DIR, slugify(pageUrl));
  await fs.ensureDir(path.dirname(filePath));

  // Get full rendered HTML
  const html = await page.content();
  const $ = cheerio.load(html);

  // Download and localise assets (images, css)
  const assetPromises = [];
  $("img[src], link[rel=stylesheet][href], script[src]").each((_, el) => {
    const attr = el.tagName === "link" ? "href" : "src";
    const assetUrl = $(el).attr(attr);
    if (!assetUrl || assetUrl.startsWith("data:")) return;

    try {
      const absUrl = new url.URL(assetUrl, pageUrl).href;
      if (!absUrl.startsWith("http")) return;
      const assetPath = path.join(
        OUT_DIR,
        "_assets",
        absUrl.replace(/https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "_")
      );
      const relPath = path.relative(path.dirname(filePath), assetPath);
      $(el).attr(attr, relPath);
      assetPromises.push(downloadFile(absUrl, assetPath));
    } catch {}
  });

  // Rewrite internal links to local .html files
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    try {
      const abs = new url.URL(href, pageUrl);
      if (abs.origin === BASE_ORIGIN && abs.pathname.startsWith("/hc/en-us")) {
        abs.hash = "";
        abs.search = "";
        const localPath = path.relative(
          path.dirname(filePath),
          path.join(OUT_DIR, slugify(abs.href))
        );
        $(el).attr("href", localPath);
      }
    } catch {}
  });

  await Promise.all(assetPromises);
  await fs.writeFile(filePath, $.html(), "utf8");
  console.log(`  ✓ saved → ${filePath}`);
  return filePath;
}

async function run() {
  await fs.ensureDir(OUT_DIR);

  console.log("🚀 Launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 900 });

  // Optional: add cookies here if the site requires auth
  // await page.setCookie({ name: '_session_id', value: 'YOUR_VALUE', domain: 'v5rc-kb.recf.org' });

  let pageCount = 0;

  while (queue.length > 0 && pageCount < MAX_PAGES) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    pageCount++;

    console.log(`\n[${pageCount}] Crawling: ${pageUrl}`);

    try {
      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });

      // Wait for Zendesk content to render
      await page
        .waitForSelector("article, .article-body, main, #main-content", {
          timeout: 8000,
        })
        .catch(() => {}); // continue even if selector not found

      const title = await page.title();
      const savedPath = await savePage(page, pageUrl);
      index.push({ url: pageUrl, title, file: savedPath });

      const links = await extractLinks(page, pageUrl);
      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      console.log(
        `  🔗 found ${links.length} new links | queue: ${queue.length}`
      );
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await browser.close();

  // Write index
  const indexPath = path.join(OUT_DIR, "index.json");
  await fs.writeJson(indexPath, index, { spaces: 2 });

  // Write a simple HTML index page
  const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RECF Archive Index</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}
a{display:block;padding:.3rem 0;color:#0057a8}h1{color:#333}</style></head>
<body><h1>RECF KB Archive — ${new Date().toLocaleDateString()}</h1>
<p>${index.length} pages archived from ${START_URL}</p>
<ul style="list-style:none;padding:0">
${index
  .map(
    (p) =>
      `<li><a href="${path.relative(OUT_DIR, p.file)}">${p.title || p.url}</a></li>`
  )
  .join("\n")}
</ul></body></html>`;
  await fs.writeFile(path.join(OUT_DIR, "INDEX.html"), indexHtml, "utf8");

  console.log(`\n✅ Done! ${index.length} pages archived to ${OUT_DIR}/`);
  console.log(`📄 Open ${OUT_DIR}/INDEX.html to browse the archive.`);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});