/**
 * RECF Knowledge Base Archiver
 * Exhaustively crawls every article, category, and section on:
 *   https://viqrc-kb.recf.org/hc/en-us
 *
 * SETUP:
 *   npm install puppeteer cheerio fs-extra
 *   node viqrc-archiver.js
 *
 * OUTPUT:
 *   ./viqrc-archive/         — all pages as .html files, assets downloaded
 *   ./viqrc-archive/INDEX.html — browse the full archive offline
 *   ./viqrc-archive/index.json — machine-readable page list
 */

const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ── Config ───────────────────────────────────────────────────────────────────
const START_URL        = "https://viqrc-kb.recf.org/hc/en-us";
const BASE_ORIGIN      = "https://viqrc-kb.recf.org";
const ALLOWED_PREFIX   = "/hc/en-us";           // only crawl under this path
const OUT_DIR          = "./viqrc-archive";
const DELAY_MS         = 1200;                  // delay between pages (ms)
const MAX_PAGES        = 5000;                  // safety cap
const PAGE_TIMEOUT     = 30000;                 // navigation timeout (ms)

// Zendesk API — used to seed ALL article/section/category IDs up front
// so we don't miss anything that isn't linked from the nav
const ZENDESK_API_BASE = "https://viqrc-kb.recf.org/api/v2/help_center/en-us";
// ─────────────────────────────────────────────────────────────────────────────

const visited  = new Set();
const queue    = [];
const index    = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAllowed(href) {
  try {
    const u = new URL(href);
    return (
      u.origin === BASE_ORIGIN &&
      u.pathname.startsWith(ALLOWED_PREFIX) &&
      !u.pathname.match(/\.(pdf|png|jpg|jpeg|gif|svg|css|js|zip|ico|woff|woff2|ttf)$/i)
    );
  } catch { return false; }
}

function normalise(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    return u.href;
  } catch { return null; }
}

function slugify(pageUrl) {
  const u = new URL(pageUrl);
  let p = u.pathname.replace(/^\//, "").replace(/\/$/, "") || "index";
  p = p.replace(/[^a-zA-Z0-9/_-]/g, "_");
  if (!p.endsWith(".html")) p += ".html";
  return p;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enqueue(href) {
  if (href && isAllowed(href) && !visited.has(href) && !queue.includes(href)) {
    queue.push(href);
  }
}

// Download a single asset file
function downloadAsset(assetUrl, destPath) {
  return new Promise((resolve) => {
    if (fs.existsSync(destPath)) return resolve();
    fs.ensureDirSync(path.dirname(destPath));
    const proto = assetUrl.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(assetUrl, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        fs.removeSync(destPath);
        return downloadAsset(res.headers.location, destPath).then(resolve);
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", () => { file.close(); fs.removeSync(destPath); resolve(); });
  });
}

// ── Zendesk API seed ─────────────────────────────────────────────────────────
// Pull every article/section/category URL from the API so nothing is missed
// even if it isn't reachable through normal navigation links.

async function fetchJson(apiUrl) {
  return new Promise((resolve, reject) => {
    https.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function seedFromApi() {
  console.log("📡 Seeding URLs from Zendesk API...");
  const endpoints = ["articles", "sections", "categories"];
  let total = 0;

  for (const ep of endpoints) {
    let pageUrl = `${ZENDESK_API_BASE}/${ep}.json?per_page=100`;
    while (pageUrl) {
      try {
        const data = await fetchJson(pageUrl);
        const items = data[ep] || [];
        for (const item of items) {
          const html_url = item.html_url;
          if (html_url) {
            const norm = normalise(html_url, BASE_ORIGIN);
            if (norm) { enqueue(norm); total++; }
          }
        }
        pageUrl = data.next_page || null;
        await sleep(300);
      } catch (err) {
        console.warn(`  ⚠ API ${ep} failed: ${err.message} — continuing with crawl only`);
        break;
      }
    }
  }

  console.log(`  ✓ API seeded ${total} URLs (articles + sections + categories)`);
}

// ── Page save ────────────────────────────────────────────────────────────────

async function savePage(page, pageUrl) {
  const filePath = path.join(OUT_DIR, slugify(pageUrl));
  await fs.ensureDir(path.dirname(filePath));

  const html = await page.content();
  const $    = cheerio.load(html);

  // Download and rewrite assets
  const assetJobs = [];
  $("img[src], link[rel=stylesheet][href], script[src]").each((_, el) => {
    const attr     = el.tagName === "link" ? "href" : "src";
    const assetSrc = $(el).attr(attr);
    if (!assetSrc || assetSrc.startsWith("data:")) return;
    try {
      const absUrl   = new URL(assetSrc, pageUrl).href;
      if (!absUrl.startsWith("http")) return;
      const assetKey = absUrl.replace(/https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const destPath = path.join(OUT_DIR, "_assets", assetKey);
      const relPath  = path.relative(path.dirname(filePath), destPath);
      $(el).attr(attr, relPath);
      assetJobs.push(downloadAsset(absUrl, destPath));
    } catch {}
  });

  // Rewrite internal links → local .html paths
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const norm = normalise(href, pageUrl);
    if (norm && isAllowed(norm)) {
      const local = path.relative(
        path.dirname(filePath),
        path.join(OUT_DIR, slugify(norm))
      );
      $(el).attr("href", local);
    }
  });

  await Promise.all(assetJobs);
  await fs.writeFile(filePath, $.html(), "utf8");
  return filePath;
}

// ── Main crawl ───────────────────────────────────────────────────────────────

async function run() {
  await fs.ensureDir(OUT_DIR);

  // Seed start URL
  enqueue(START_URL);

  // Seed from Zendesk API (gets articles not linked in the nav)
  await seedFromApi();

  console.log(`\n🚀 Launching browser... (${queue.length} URLs in queue)\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 900 });

  // Uncomment if the site requires a login session:
  // await page.setCookie({
  //   name: '_zendesk_session', value: 'YOUR_COOKIE_VALUE',
  //   domain: 'viqrc-kb.recf.org'
  // });

  let pageCount = 0;

  while (queue.length > 0 && pageCount < MAX_PAGES) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    pageCount++;

    process.stdout.write(`[${pageCount}/${pageCount + queue.length}] ${pageUrl} ... `);

    try {
      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT });

      // Wait for Zendesk article content to render
      await page.waitForSelector(
        "article, .article-body, .section-list, main, #main-content",
        { timeout: 8000 }
      ).catch(() => {});

      const title   = await page.title();
      const savedAt = await savePage(page, pageUrl);
      index.push({ url: pageUrl, title, file: savedAt });

      // Discover new links from the rendered page
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]")).map((a) => a.href)
      );
      let newLinks = 0;
      for (const link of links) {
        const norm = normalise(link, pageUrl);
        if (norm && isAllowed(norm) && !visited.has(norm) && !queue.includes(norm)) {
          queue.push(norm);
          newLinks++;
        }
      }

      console.log(`✓  (+${newLinks} links | queue: ${queue.length})`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await browser.close();

  // Write JSON index
  await fs.writeJson(path.join(OUT_DIR, "index.json"), index, { spaces: 2 });

  // Write browsable HTML index grouped by section
  const bySection = {};
  for (const p of index) {
    const parts = new URL(p.url).pathname.split("/").filter(Boolean);
    // pathname: hc / en-us / [type] / [id-slug]
    const section = parts[2] || "other";
    if (!bySection[section]) bySection[section] = [];
    bySection[section].push(p);
  }

  const htmlIndex = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>RECF KB Archive — ${new Date().toLocaleDateString()}</title>
<style>
  body { font-family: sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1   { color: #0057a8; }
  h2   { color: #444; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; text-transform: capitalize; }
  a    { color: #0057a8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  li   { padding: .2rem 0; }
  .meta { color: #888; font-size: .85rem; }
  ul   { padding-left: 1.2rem; }
</style></head>
<body>
<h1>RECF KB Archive</h1>
<p class="meta">Archived <strong>${index.length} pages</strong> on ${new Date().toLocaleString()}<br>
Source: <a href="${START_URL}">${START_URL}</a></p>
${Object.entries(bySection)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([section, pages]) => `
<h2>${section.replace(/-/g, " ")} <span style="font-weight:normal;font-size:.8em;color:#888">(${pages.length})</span></h2>
<ul>
${pages
  .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
  .map((p) => `  <li><a href="${path.relative(OUT_DIR, p.file)}">${p.title || p.url}</a></li>`)
  .join("\n")}
</ul>`).join("\n")}
</body></html>`;

  await fs.writeFile(path.join(OUT_DIR, "INDEX.html"), htmlIndex, "utf8");

  console.log(`\n✅ Done! ${index.length} pages archived → ${OUT_DIR}/`);
  console.log(`📄 Open ${OUT_DIR}/INDEX.html to browse offline.`);

  if (pageCount >= MAX_PAGES) {
    console.warn(`⚠  Hit MAX_PAGES cap (${MAX_PAGES}). Raise it in config if articles were cut off.`);
  }
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});