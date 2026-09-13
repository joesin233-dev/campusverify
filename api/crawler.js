/* =========================================================================
   CampusVerify — api/crawler.js
   -----------------------------------------------------------------------
   High-Performance General Institutional Website Crawler & Evidence Extractor
   ========================================================================= */

const {
  getInstitutionById,
  isSameInstitutionHost
} = require("../institutions.js");

const {
  extractPhones,
  extractEmails,
  extractBanks,
  extractPaymentRecords,
  extractTitle,
  extractPaymentInstructions
} = require("../patterns.js");

const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");

/* =========================================================================
   SETTINGS — OPTIMIZED FOR HIGH SPEED & ACCURACY
   ========================================================================= */

const FETCH_TIMEOUT_MS = 5000;              // Reduced timeout for fast failure recovery
const MAX_PAGES_PER_INSTITUTION = 60;       // Targeted depth for verified information
const MAX_CRAWL_DEPTH = 3;                  // Target institutional evidence is rarely > 3 clicks deep
const MAX_CRAWL_TIME_MS = 25000;            // Keep safely under serverless/gateway timeouts
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;  // 5MB max payload limit
const MAX_LINKS_PER_PAGE = 300;
const MAX_SITEMAP_URLS = 500;
const MAX_CONCURRENT_REQUESTS = 8;          // Parallel request concurrency limit
const MAX_JS_RENDER_TIME_MS = 8000;

/* =========================================================================
   PRIORITY KEYWORDS
   ========================================================================= */

const PRIORITY_KEYWORDS = [
  "contact", "contacts", "admission", "admissions", "student", "students",
  "account", "accounts", "finance", "financial", "fee", "fees", "payment",
  "payments", "bank", "banking", "bank-details", "registration", "notice",
  "announcement", "prospectus", "download", "documents", "pdf", "tuition",
  "bursar", "cashier", "billing"
];

const EXCLUDED_PATH_PATTERNS =
  /(?:^|\/)(?:login|signin|sign-in|logon|authenticate|admin|wp-admin|cpanel|dashboard|logout)(?:\/|$)/i;

const DOCUMENT_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|csv|txt)$/i;

function crawlTimeExceeded(startTime) {
  return Date.now() - startTime >= MAX_CRAWL_TIME_MS;
}

/* =========================================================================
   PARALLEL CONCURRENCY HELPER
   ========================================================================= */

async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = new Set();
  
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

/* =========================================================================
   OPTIONAL HEADLESS BROWSER (FAST CONFIG)
   ========================================================================= */

var _puppeteerModule = null;
var _chromiumModule = null;
var _browserLoadAttempted = false;

function loadHeadlessBrowser() {
  if (_browserLoadAttempted) {
    return _puppeteerModule ? { puppeteer: _puppeteerModule, chromium: _chromiumModule } : null;
  }
  _browserLoadAttempted = true;

  try {
    _puppeteerModule = require("puppeteer-core");
    try {
      _chromiumModule = require("@sparticuz/chromium");
    } catch (e) {
      _chromiumModule = null;
    }
    return { puppeteer: _puppeteerModule, chromium: _chromiumModule };
  } catch (e) {
    return null;
  }
}

async function renderWithHeadlessBrowser(url) {
  const loaded = loadHeadlessBrowser();
  if (!loaded) return null;

  let browser = null;
  try {
    const launchOptions = loaded.chromium
      ? {
          args: [...loaded.chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
          executablePath: await loaded.chromium.executablePath(),
          headless: true
        }
      : { headless: true };

    browser = await loaded.puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Abort images, stylesheets, and fonts to accelerate loading
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    page.setDefaultNavigationTimeout(MAX_JS_RENDER_TIME_MS);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: MAX_JS_RENDER_TIME_MS });

    return await page.content();
  } catch (err) {
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

/* =========================================================================
   URL HELPERS & FETCH ENGINE
   ========================================================================= */

function normaliseUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"].forEach(p => parsed.searchParams.delete(p));
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

function isCrawlableUrl(url, institution) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (!isSameInstitutionHost(parsed.hostname, institution.domain)) return false;
    if (EXCLUDED_PATH_PATTERNS.test(parsed.pathname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "CampusVerify-Crawler/6.0 (+official institutional verification)",
        "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"
      }
    });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseSafely(response) {
  if (!response) return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) return null;

  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) return null;
    return Buffer.from(buffer);
  } catch (e) {
    return null;
  }
}

/* =========================================================================
   LINK & SITEMAP DISCOVERY
   ========================================================================= */

function discoverLinks(html, pageUrl, institution) {
  const found = [];
  const seen = new Set();
  const linkRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    if (found.length >= MAX_LINKS_PER_PAGE) break;
    const href = (match[1] || "").trim();
    if (!href || /^(javascript|mailto|tel|data|#)/i.test(href)) continue;

    try {
      const resolved = new URL(href, pageUrl).toString();
      const normalised = normaliseUrl(resolved);
      if (normalised && isCrawlableUrl(normalised, institution) && !seen.has(normalised)) {
        seen.add(normalised);
        
        let score = 0;
        const lower = normalised.toLowerCase();
        PRIORITY_KEYWORDS.forEach(kw => {
          if (lower.includes(kw)) score += 3;
        });
        if (DOCUMENT_EXTENSIONS.test(lower)) score += 10;

        found.push({ url: normalised, score });
      }
    } catch (e) {}
  }

  return found.sort((a, b) => b.score - a.score);
}

async function discoverSitemap(homepage, institution, startTime) {
  if (crawlTimeExceeded(startTime)) return [];

  let base;
  try { base = new URL(homepage); } catch (e) { return []; }

  const candidates = [
    `${base.origin}/sitemap.xml`,
    `${base.origin}/sitemap_index.xml`
  ];

  const discoveredUrls = [];
  const seenUrls = new Set();

  await mapConcurrent(candidates, 2, async (sitemapUrl) => {
    if (crawlTimeExceeded(startTime)) return;
    const res = await fetchWithTimeout(sitemapUrl, FETCH_TIMEOUT_MS);
    if (!res || !res.ok) return;

    const buffer = await readResponseSafely(res);
    if (!buffer) return;

    const xml = buffer.toString("utf8");
    const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
    let match;

    while ((match = locRegex.exec(xml)) !== null) {
      const url = normaliseUrl(match[1].trim());
      if (url && isCrawlableUrl(url, institution) && !seenUrls.has(url)) {
        seenUrls.add(url);
        
        let score = 20;
        const lower = url.toLowerCase();
        PRIORITY_KEYWORDS.forEach(kw => { if (lower.includes(kw)) score += 4; });
        
        discoveredUrls.push({ url, score });
        if (discoveredUrls.length >= MAX_SITEMAP_URLS) break;
      }
    }
  });

  return discoveredUrls;
}

/* =========================================================================
   STATIC JSON FALLBACK EVIDENCE LOADER
   ========================================================================= */

function loadStaticEvidence(institutionId) {
  try {
    const dataPath = path.join(__dirname, `../data/${institutionId}.json`);
    if (fs.existsSync(dataPath)) {
      const content = fs.readFileSync(dataPath, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    // Fail gracefully if JSON doesn't exist
  }
  return null;
}

/* =========================================================================
   PAGE PROCESSOR & CRAWLER CORE
   ========================================================================= */

async function crawlPage(target, institution) {
  let response = await fetchWithTimeout(target.url);
  let html = "";
  let isPdf = false;
  let buffer = null;

  if (response && response.ok) {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    isPdf = contentType.includes("application/pdf") || /\.pdf(?:$|\?)/i.test(target.url);
    buffer = await readResponseSafely(response);
  }

  // Fallback to Headless Browser if raw fetch returns empty HTML or fails
  if (!buffer && !isPdf) {
    const renderedHtml = await renderWithHeadlessBrowser(target.url);
    if (renderedHtml) {
      html = renderedHtml;
    } else {
      return null;
    }
  } else if (buffer) {
    if (isPdf) {
      try {
        const pdfData = await pdfParse(buffer);
        html = pdfData.text || "";
      } catch (e) {
        return null;
      }
    } else {
      html = buffer.toString("utf8");
    }
  }

  const cleanText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const links = isPdf ? [] : discoverLinks(html, target.url, institution);

  return {
    url: target.url,
    title: extractTitle(html) || target.url,
    text: cleanText,
    html: html,
    links: links,
    isPdf: isPdf
  };
}

async function runCrawler(institutionId) {
  const startTime = Date.now();
  const institution = getInstitutionById(institutionId);
  if (!institution) throw new Error("Invalid Institution ID");

  // 1. Initialize result structure with local static JSON fallback evidence
  const staticData = loadStaticEvidence(institutionId) || {};
  const extracted = {
    institutionId: institution.id,
    institutionName: institution.name,
    domain: institution.domain,
    crawledAt: new Date().toISOString(),
    phones: staticData.phones || [],
    emails: staticData.emails || [],
    banks: staticData.banks || [],
    paymentRecords: staticData.paymentRecords || [],
    instructions: staticData.instructions || [],
    crawledPages: []
  };

  const visited = new Set();
  const queue = [{ url: institution.website, score: 100, depth: 0 }];

  // 2. Queue Sitemap links
  const sitemapUrls = await discoverSitemap(institution.website, institution, startTime);
  sitemapUrls.forEach(item => queue.push({ ...item, depth: 1 }));

  // Helper sets to avoid duplicates
  const seenPhones = new Set(extracted.phones.map(p => p.number || p));
  const seenEmails = new Set(extracted.emails.map(e => e.email || e));
  const seenAccounts = new Set(extracted.banks.map(b => b.accountNumber));

  // 3. Parallel Batch Execution Loop
  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES_PER_INSTITUTION &&
    !crawlTimeExceeded(startTime)
  ) {
    queue.sort((a, b) => b.score - a.score);

    const batch = [];
    while (queue.length > 0 && batch.length < MAX_CONCURRENT_REQUESTS) {
      const next = queue.shift();
      if (!visited.has(next.url) && next.depth <= MAX_CRAWL_DEPTH) {
        visited.add(next.url);
        batch.push(next);
      }
    }

    if (batch.length === 0) break;

    const pageResults = await mapConcurrent(batch, MAX_CONCURRENT_REQUESTS, target =>
      crawlPage(target, institution)
    );

    for (const page of pageResults) {
      if (!page) continue;

      extracted.crawledPages.push({
        url: page.url,
        title: page.title
      });

      // Extract Evidence Patterns
      const foundPhones = extractPhones(page.text, page.url);
      const foundEmails = extractEmails(page.text, page.url);
      const foundBanks = extractBanks(page.text, page.url);
      const foundPayments = extractPaymentRecords(page.text, page.url);
      const foundInstructions = extractPaymentInstructions(page.text, page.url);

      // Merge Phones
      foundPhones.forEach(p => {
        const num = typeof p === "string" ? p : p.number;
        if (num && !seenPhones.has(num)) {
          seenPhones.add(num);
          extracted.phones.push(p);
        }
      });

      // Merge Emails
      foundEmails.forEach(e => {
        const emailStr = typeof e === "string" ? e : e.email;
        if (emailStr && !seenEmails.has(emailStr)) {
          seenEmails.add(emailStr);
          extracted.emails.push(e);
        }
      });

      // Merge Bank Accounts
      foundBanks.forEach(b => {
        if (b.accountNumber && !seenAccounts.has(b.accountNumber)) {
          seenAccounts.add(b.accountNumber);
          extracted.banks.push(b);
        }
      });

      // Merge Payments & Instructions
      if (foundPayments.length > 0) extracted.paymentRecords.push(...foundPayments);
      if (foundInstructions.length > 0) extracted.instructions.push(...foundInstructions);

      // Enqueue discovered child links
      if (page.links) {
        page.links.forEach(link => {
          if (!visited.has(link.url)) {
            queue.push({ ...link, depth: (batch[0]?.depth || 0) + 1 });
          }
        });
      }
    }
  }

  return extracted;
}

module.exports = {
  runCrawler
};
