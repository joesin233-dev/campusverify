import { getInstitutionById } from "../institutions.js";
import {
  extractPhones,
  extractEmails,
  extractBankAccounts,
  extractPaymentRecords,
  extractPaymentInstructions,
} from "../patterns.js";
import pdfParse from "pdf-parse";
import fs from "fs";
import path from "path";

/*
|--------------------------------------------------------------------------
| SPEED / CRAWL SETTINGS
|--------------------------------------------------------------------------
*/

const FETCH_TIMEOUT_MS = 7000;
const SITEMAP_TIMEOUT_MS = 2500;

const MAX_PAGES_PER_INSTITUTION = 300;
const MAX_CRAWL_DEPTH = 15;
const MAX_CRAWL_TIME_MS = 20000;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LINKS_PER_PAGE = 700;

const MAX_SITEMAP_URLS = 2000;
const MAX_SITEMAPS = 10;

const JS_RENDER_MIN_TEXT_LENGTH = 100;
const MAX_JS_RENDER_TIME_MS = 6000;

/*
 * NEW:
 * Crawl several independent pages at the same time.
 * This is the main speed improvement.
 */
const CRAWL_CONCURRENCY = 5;


/*
|--------------------------------------------------------------------------
| PRIORITY KEYWORDS
|--------------------------------------------------------------------------
*/

const PRIORITY_KEYWORDS = [
  "contact",
  "contacts",
  "admission",
  "admissions",
  "student",
  "students",
  "student-affairs",
  "student_affairs",
  "student affairs",
  "account",
  "accounts",
  "finance",
  "financial",
  "fee",
  "fees",
  "payment",
  "payments",
  "bank",
  "banking",
  "bank-details",
  "bank_details",
  "bank details",
  "registration",
  "register",
  "notice",
  "notices",
  "announcement",
  "announcements",
  "news",
  "prospectus",
  "download",
  "downloads",
  "document",
  "documents",
  "pdf",
  "international",
  "accommodation",
  "hostel",
  "tuition",
  "school-fees",
  "school_fees",
  "school fees",
  "accounts-office",
  "accounts_office",
  "accounts office",
  "bursar",
  "cashier",
  "billing",
  "invoice",
];


/*
|--------------------------------------------------------------------------
| EXCLUDED PATHS
|--------------------------------------------------------------------------
*/

const EXCLUDED_PATH_PATTERNS =
  /(?:^|\/)(?:login|signin|sign-in|logon|authenticate|authentication|admin|wp-admin|cpanel|dashboard|logout)(?:\/|$)/i;


/*
|--------------------------------------------------------------------------
| DOCUMENT TYPES
|--------------------------------------------------------------------------
*/

const DOCUMENT_EXTENSIONS =
  /\.(?:pdf|doc|docx|xls|xlsx|csv|txt)$/i;

const IMAGE_EXTENSIONS =
  /\.(?:jpg|jpeg|png|gif|bmp|webp|tiff)$/i;


/*
|--------------------------------------------------------------------------
| OPTIONAL OCR / BROWSER LOADERS
|--------------------------------------------------------------------------
*/

let tesseractModule = null;
let puppeteerModule = null;
let chromiumModule = null;

async function loadTesseract() {
  if (tesseractModule) return tesseractModule;

  try {
    tesseractModule = await import("tesseract.js");
    return tesseractModule;
  } catch {
    return null;
  }
}

async function loadPuppeteer() {
  if (puppeteerModule) return puppeteerModule;

  try {
    puppeteerModule = await import("puppeteer-core");
    return puppeteerModule;
  } catch {
    return null;
  }
}

async function loadChromium() {
  if (chromiumModule) return chromiumModule;

  try {
    chromiumModule = await import("@sparticuz/chromium");
    return chromiumModule;
  } catch {
    return null;
  }
}


/*
|--------------------------------------------------------------------------
| TIME
|--------------------------------------------------------------------------
*/

function crawlTimeExceeded(startTime) {
  return Date.now() - startTime >= MAX_CRAWL_TIME_MS;
}


/*
|--------------------------------------------------------------------------
| NORMALIZATION
|--------------------------------------------------------------------------
*/

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);

    url.hash = "";

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ];

    trackingParams.forEach((param) => {
      url.searchParams.delete(param);
    });

    let result = url.toString();

    if (result.endsWith("/")) {
      result = result.slice(0, -1);
    }

    return result;
  } catch {
    return null;
  }
}

function normalizeAccount(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}


/*
|--------------------------------------------------------------------------
| URL SAFETY
|--------------------------------------------------------------------------
*/

function isSafeUrl(url, institution) {
  try {
    const target = new URL(url);
    const base = new URL(institution.website);

    if (!["http:", "https:"].includes(target.protocol)) {
      return false;
    }

    if (target.hostname !== base.hostname) {
      return false;
    }

    if (EXCLUDED_PATH_PATTERNS.test(target.pathname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}


/*
|--------------------------------------------------------------------------
| FETCH
|--------------------------------------------------------------------------
*/

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}


/*
|--------------------------------------------------------------------------
| HEADLESS BROWSER
|--------------------------------------------------------------------------
|
| Faster than the previous version:
| - domcontentloaded instead of networkidle2
| - blocks images/fonts/media
| - shorter timeout
|--------------------------------------------------------------------------
*/

async function renderWithHeadlessBrowser(url) {
  const puppeteer = await loadPuppeteer();

  if (!puppeteer) {
    return null;
  }

  let chromium = await loadChromium();

  try {
    const puppeteerApi = puppeteer.default || puppeteer;

    let executablePath = process.env.CHROME_EXECUTABLE_PATH;

    if (!executablePath && chromium) {
      const chromiumApi = chromium.default || chromium;

      if (chromiumApi.executablePath) {
        executablePath = await chromiumApi.executablePath();
      }
    }

    if (!executablePath) {
      return null;
    }

    const browser = await puppeteerApi.launch({
      args: chromium
        ? (chromium.default || chromium).args || []
        : [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
          ],
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();

      await page.setRequestInterception(true);

      page.on("request", (request) => {
        const resourceType = request.resourceType();

        if (
          resourceType === "image" ||
          resourceType === "font" ||
          resourceType === "media"
        ) {
          request.abort().catch(() => {});
          return;
        }

        request.continue().catch(() => {});
      });

      await page.setUserAgent(
        "CampusVerify-Crawler/6.0 (+official institutional verification)"
      );

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: MAX_JS_RENDER_TIME_MS,
      });

      /*
       * Give client-side JavaScript a short chance to populate content.
       * Much faster than waiting for every network request.
       */
      await new Promise((resolve) => setTimeout(resolve, 300));

      const html = await page.content();

      await page.close();

      return html;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}


/*
|--------------------------------------------------------------------------
| HTML TEXT
|--------------------------------------------------------------------------
*/

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}


/*
|--------------------------------------------------------------------------
| LINK DISCOVERY
|--------------------------------------------------------------------------
*/

function scoreUrl(url) {
  const lower = url.toLowerCase();

  let score = 0;

  for (const keyword of PRIORITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      score += 10;
    }
  }

  if (DOCUMENT_EXTENSIONS.test(lower)) {
    score += 25;
  }

  if (
    lower.includes("bank") ||
    lower.includes("payment") ||
    lower.includes("fee") ||
    lower.includes("account") ||
    lower.includes("finance")
  ) {
    score += 20;
  }

  if (
    lower.includes("contact") ||
    lower.includes("admission") ||
    lower.includes("student") ||
    lower.includes("registration")
  ) {
    score += 15;
  }

  return score;
}

function extractLinks(html, pageUrl, institution) {
  const links = [];
  const seen = new Set();

  const anchorRegex =
    /<a\b[^>]*?(?:href|data-href|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    if (links.length >= MAX_LINKS_PER_PAGE) {
      break;
    }

    const normalized = normalizeUrl(match[1], pageUrl);

    if (!normalized) continue;
    if (!isSafeUrl(normalized, institution)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);

    links.push({
      url: normalized,
      score: scoreUrl(normalized),
    });
  }

  links.sort((a, b) => b.score - a.score);

  return links;
}


/*
|--------------------------------------------------------------------------
| IMAGE DISCOVERY
|--------------------------------------------------------------------------
*/

function extractImageLinks(html, pageUrl, institution) {
  const links = [];
  const seen = new Set();

  const imageRegex =
    /<(?:img|source)\b[^>]*?(?:src|data-src|srcset)\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while ((match = imageRegex.exec(html)) !== null) {
    const raw = match[1];

    if (!raw) continue;

    const firstSource = raw.split(",")[0].trim().split(" ")[0];

    const normalized = normalizeUrl(firstSource, pageUrl);

    if (!normalized) continue;
    if (!isSafeUrl(normalized, institution)) continue;
    if (!IMAGE_EXTENSIONS.test(normalized)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    links.push(normalized);
  }

  return links;
}


/*
|--------------------------------------------------------------------------
| EMBEDDED DOCUMENTS
|--------------------------------------------------------------------------
*/

function extractEmbeddedDocuments(html, pageUrl, institution) {
  const results = [];
  const seen = new Set();

  const regex =
    /<(?:iframe|embed|object|source)\b[^>]*?(?:src|data)\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const normalized = normalizeUrl(match[1], pageUrl);

    if (!normalized) continue;
    if (!isSafeUrl(normalized, institution)) continue;
    if (!DOCUMENT_EXTENSIONS.test(normalized)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}


/*
|--------------------------------------------------------------------------
| CANONICAL
|--------------------------------------------------------------------------
*/

function extractCanonical(html, pageUrl, institution) {
  const match = html.match(
    /<link\b[^>]*?rel=["']canonical["'][^>]*?href=["']([^"']+)["']/i
  );

  if (!match) {
    return null;
  }

  const normalized = normalizeUrl(match[1], pageUrl);

  if (!normalized) {
    return null;
  }

  if (!isSafeUrl(normalized, institution)) {
    return null;
  }

  return normalized;
}


/*
|--------------------------------------------------------------------------
| SITEMAPS
|--------------------------------------------------------------------------
*/

async function fetchText(url, timeoutMs = SITEMAP_TIMEOUT_MS) {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            "CampusVerify-Crawler/6.0 (+official institutional verification)",
          Accept: "text/plain,application/xml,text/xml,*/*",
        },
      },
      timeoutMs
    );

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

async function discoverRobotsSitemaps(institution) {
  const base = new URL(institution.website);

  const robotsUrl = `${base.origin}/robots.txt`;

  const robots = await fetchText(
    robotsUrl,
    SITEMAP_TIMEOUT_MS
  );

  if (!robots) {
    return [];
  }

  const results = [];

  for (const line of robots.split(/\r?\n/)) {
    if (!/^sitemap\s*:/i.test(line)) {
      continue;
    }

    const value = line.replace(/^sitemap\s*:/i, "").trim();

    const normalized = normalizeUrl(
      value,
      institution.website
    );

    if (!normalized) continue;

    if (!isSafeUrl(normalized, institution)) continue;

    if (!results.includes(normalized)) {
      results.push(normalized);
    }
  }

  return results;
}

function extractSitemapUrls(xml, institution) {
  const urls = [];

  const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;

  let match;

  while ((match = locRegex.exec(xml)) !== null) {
    const normalized = normalizeUrl(
      match[1].trim(),
      institution.website
    );

    if (!normalized) continue;

    if (!isSafeUrl(normalized, institution)) continue;

    urls.push(normalized);

    if (urls.length >= MAX_SITEMAP_URLS) {
      break;
    }
  }

  return urls;
}

async function discoverSitemap(institution) {
  const base = new URL(institution.website);

  const candidates = [
    `${base.origin}/sitemap.xml`,
    `${base.origin}/sitemap_index.xml`,
  ];

  const robotsSitemaps = await discoverRobotsSitemaps(
    institution
  );

  for (const url of robotsSitemaps) {
    if (!candidates.includes(url)) {
      candidates.push(url);
    }
  }

  const sitemapQueue = candidates.slice(
    0,
    MAX_SITEMAPS
  );

  const visitedSitemaps = new Set();
  const discoveredUrls = new Set();

  while (
    sitemapQueue.length > 0 &&
    visitedSitemaps.size < MAX_SITEMAPS &&
    discoveredUrls.size < MAX_SITEMAP_URLS
  ) {
    const sitemapUrl = sitemapQueue.shift();

    if (visitedSitemaps.has(sitemapUrl)) {
      continue;
    }

    visitedSitemaps.add(sitemapUrl);

    const xml = await fetchText(
      sitemapUrl,
      SITEMAP_TIMEOUT_MS
    );

    if (!xml) {
      continue;
    }

    const urls = extractSitemapUrls(
      xml,
      institution
    );

    for (const url of urls) {
      if (discoveredUrls.size >= MAX_SITEMAP_URLS) {
        break;
      }

      if (url.toLowerCase().endsWith(".xml")) {
        if (
          !visitedSitemaps.has(url) &&
          !sitemapQueue.includes(url) &&
          sitemapQueue.length < MAX_SITEMAPS
        ) {
          sitemapQueue.push(url);
        }

        continue;
      }

      discoveredUrls.add(url);
    }
  }

  return Array.from(discoveredUrls);
}


/*
|--------------------------------------------------------------------------
| EVIDENCE STORAGE
|--------------------------------------------------------------------------
*/

function addItem(items, item) {
  if (!item) return;

  const value = normalizeText(item.value);

  if (!value) return;

  const type = item.type || "unknown";

  const key = `${type}:${value.toLowerCase()}`;

  const existing = items.find(
    (entry) =>
      `${entry.type}:${normalizeText(entry.value).toLowerCase()}` ===
      key
  );

  if (existing) {
    if (!existing.source && item.source) {
      existing.source = item.source;
    }

    if (!existing.context && item.context) {
      existing.context = item.context;
    }

    if (
      item.confidence !== undefined &&
      existing.confidence === undefined
    ) {
      existing.confidence = item.confidence;
    }

    return;
  }

  items.push({
    ...item,
    value,
  });
}

function addPaymentRecord(items, record) {
  if (!record) return;

  const normalized = {
    ...record,
  };

  if (normalized.account) {
    normalized.account = normalizeAccount(
      normalized.account
    );
  }

  const existing = items.find((item) => {
    if (item.type !== "payment") {
      return false;
    }

    return (
      normalizeAccount(item.account) ===
        normalizeAccount(normalized.account) &&
      normalizeText(item.bank).toLowerCase() ===
        normalizeText(normalized.bank).toLowerCase() &&
      normalizeText(item.service).toLowerCase() ===
        normalizeText(normalized.service).toLowerCase()
    );
  });

  if (existing) {
    for (const [key, value] of Object.entries(normalized)) {
      if (
        (existing[key] === undefined ||
          existing[key] === null ||
          existing[key] === "") &&
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        existing[key] = value;
      }
    }

    return;
  }

  items.push({
    type: "payment",
    ...normalized,
  });
}


/*
|--------------------------------------------------------------------------
| JSON FALLBACK
|--------------------------------------------------------------------------
*/

function loadEvidenceFallback(institution) {
  try {
    const filePath = path.join(
      process.cwd(),
      "data",
      "evidence",
      `${institution.id}.json`
    );

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(
      filePath,
      "utf8"
    );

    return JSON.parse(raw);
  } catch {
    return null;
  }
}


/*
|--------------------------------------------------------------------------
| MERGE FALLBACK
|--------------------------------------------------------------------------
*/

function mergeEvidenceFallback(
  items,
  fallback,
  institution
) {
  if (!fallback) {
    return {
      matched: 0,
      fallbackLoaded: false,
    };
  }

  let matched = 0;

  function addFallback(type, value, extra = {}) {
    if (!value) return;

    const before = items.length;

    addItem(items, {
      type,
      value,
      source:
        extra.source ||
        fallback.source ||
        institution.website,
      context:
        extra.context ||
        "Institutional evidence record",
      confidence:
        extra.confidence !== undefined
          ? extra.confidence
          : 0.9,
      fallback: true,
    });

    if (items.length > before) {
      matched++;
    }
  }

  const phones =
    fallback.phones ||
    fallback.phoneNumbers ||
    [];

  for (const phone of phones) {
    addFallback("phone", phone);
  }

  const emails =
    fallback.emails ||
    fallback.emailAddresses ||
    [];

  for (const email of emails) {
    addFallback("email", email);
  }

  const banks =
    fallback.bankAccounts ||
    fallback.accounts ||
    fallback.bank ||
    [];

  if (Array.isArray(banks)) {
    for (const account of banks) {
      if (typeof account === "string") {
        addFallback("bank", account);
      } else if (account) {
        addFallback(
          "bank",
          account.account ||
            account.number ||
            account.value,
          {
            ...account,
          }
        );
      }
    }
  }

  const contacts =
    fallback.contacts ||
    [];

  if (Array.isArray(contacts)) {
    for (const contact of contacts) {
      if (typeof contact === "string") {
        addFallback("contact", contact);
      } else if (contact) {
        addFallback(
          "contact",
          contact.value ||
            contact.name ||
            contact.phone ||
            contact.email,
          contact
        );
      }
    }
  }

  const payments =
    fallback.payments ||
    fallback.paymentRecords ||
    [];

  if (Array.isArray(payments)) {
    for (const payment of payments) {
      addPaymentRecord(items, {
        ...payment,
        fallback: true,
        source:
          payment.source ||
          fallback.source ||
          institution.website,
      });
    }
  }

  const paymentRules =
    fallback.paymentRules ||
    fallback.payment_rules ||
    [];

  if (Array.isArray(paymentRules)) {
    for (const rule of paymentRules) {
      addFallback(
        "payment_rule",
        typeof rule === "string"
          ? rule
          : rule.value || rule.text,
        typeof rule === "object"
          ? rule
          : {}
      );
    }
  }

  const instructions =
    fallback.paymentInstructions ||
    fallback.payment_instructions ||
    [];

  if (Array.isArray(instructions)) {
    for (const instruction of instructions) {
      addFallback(
        "payment_instruction",
        typeof instruction === "string"
          ? instruction
          : instruction.value || instruction.text,
        typeof instruction === "object"
          ? instruction
          : {}
      );
    }
  }

  return {
    matched,
    fallbackLoaded: true,
  };
}


/*
|--------------------------------------------------------------------------
| HTML PAGE PROCESSING
|--------------------------------------------------------------------------
*/

function processHtmlPage(
  html,
  pageUrl,
  institution,
  itemLists,
  precomputedText
) {
  const text =
    precomputedText !== undefined
      ? precomputedText
      : htmlToText(html);

  const source = pageUrl;

  const phones = extractPhones(text) || [];

  for (const phone of phones) {
    addItem(itemLists.items, {
      type: "phone",
      value: phone,
      source,
      context: text,
      confidence: 0.95,
    });
  }

  const emails = extractEmails(text) || [];

  for (const email of emails) {
    addItem(itemLists.items, {
      type: "email",
      value: email,
      source,
      context: text,
      confidence: 0.95,
    });
  }

  const banks =
    extractBankAccounts(text) || [];

  for (const bank of banks) {
    if (typeof bank === "string") {
      addItem(itemLists.items, {
        type: "bank",
        value: bank,
        source,
        context: text,
        confidence: 0.9,
      });
    } else if (bank) {
      addItem(itemLists.items, {
        type: "bank",
        value:
          bank.value ||
          bank.account ||
          bank.number,
        source:
          bank.source ||
          source,
        context:
          bank.context ||
          text,
        confidence:
          bank.confidence !== undefined
            ? bank.confidence
            : 0.9,
      });
    }
  }

  /*
   * IMPORTANT:
   * Payment records use ORIGINAL HTML because tables
   * can contain structure that disappears in plain text.
   */
  const payments =
    extractPaymentRecords(html) || [];

  for (const payment of payments) {
    addPaymentRecord(
      itemLists.items,
      {
        ...payment,
        source:
          payment.source ||
          source,
        confidence:
          payment.confidence !== undefined
            ? payment.confidence
            : 0.9,
      }
    );
  }

  const instructions =
    extractPaymentInstructions(text) || [];

  for (const instruction of instructions) {
    if (typeof instruction === "string") {
      addItem(itemLists.items, {
        type: "payment_instruction",
        value: instruction,
        source,
        context: text,
        confidence: 0.85,
      });
    } else if (instruction) {
      addItem(itemLists.items, {
        type: "payment_instruction",
        value:
          instruction.value ||
          instruction.text ||
          instruction.instruction,
        source:
          instruction.source ||
          source,
        context:
          instruction.context ||
          text,
        confidence:
          instruction.confidence !== undefined
            ? instruction.confidence
            : 0.85,
      });
    }
  }

  const links = extractLinks(
    html,
    pageUrl,
    institution
  );

  const images = extractImageLinks(
    html,
    pageUrl,
    institution
  );

  const embeddedDocuments =
    extractEmbeddedDocuments(
      html,
      pageUrl,
      institution
    );

  const canonical =
    extractCanonical(
      html,
      pageUrl,
      institution
    );

  return {
    links,
    images,
    embeddedDocuments,
    canonical,
    textLength: text.length,
  };
}


/*
|--------------------------------------------------------------------------
| DOCUMENT TEXT
|--------------------------------------------------------------------------
*/

function extractPossibleDocumentText(buffer) {
  try {
    return buffer
      .toString("utf8")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}


/*
|--------------------------------------------------------------------------
| DOCUMENT PROCESSING
|--------------------------------------------------------------------------
*/

async function processDocument(
  buffer,
  pageUrl,
  institution,
  itemLists
) {
  let text = "";

  try {
    const parsed = await pdfParse(buffer);

    text = normalizeText(
      parsed.text || ""
    );
  } catch {
    text = extractPossibleDocumentText(
      buffer
    );
  }

  if (!text) {
    return;
  }

  const source = pageUrl;

  const phones = extractPhones(text) || [];

  for (const phone of phones) {
    addItem(itemLists.items, {
      type: "phone",
      value: phone,
      source,
      context: text,
      confidence: 0.9,
    });
  }

  const emails = extractEmails(text) || [];

  for (const email of emails) {
    addItem(itemLists.items, {
      type: "email",
      value: email,
      source,
      context: text,
      confidence: 0.9,
    });
  }

  const banks =
    extractBankAccounts(text) || [];

  for (const bank of banks) {
    if (typeof bank === "string") {
      addItem(itemLists.items, {
        type: "bank",
        value: bank,
        source,
        context: text,
        confidence: 0.85,
      });
    } else if (bank) {
      addItem(itemLists.items, {
        type: "bank",
        value:
          bank.value ||
          bank.account ||
          bank.number,
        source:
          bank.source ||
          source,
        context:
          bank.context ||
          text,
        confidence:
          bank.confidence !== undefined
            ? bank.confidence
            : 0.85,
      });
    }
  }

  const payments =
    extractPaymentRecords(text) || [];

  for (const payment of payments) {
    addPaymentRecord(
      itemLists.items,
      {
        ...payment,
        source:
          payment.source ||
          source,
      }
    );
  }

  const instructions =
    extractPaymentInstructions(text) || [];

  for (const instruction of instructions) {
    if (typeof instruction === "string") {
      addItem(itemLists.items, {
        type: "payment_instruction",
        value: instruction,
        source,
        context: text,
        confidence: 0.8,
      });
    } else if (instruction) {
      addItem(itemLists.items, {
        type: "payment_instruction",
        value:
          instruction.value ||
          instruction.text ||
          instruction.instruction,
        source:
          instruction.source ||
          source,
        context:
          instruction.context ||
          text,
        confidence:
          instruction.confidence !== undefined
            ? instruction.confidence
            : 0.8,
      });
    }
  }
}


/*
|--------------------------------------------------------------------------
| IMAGE / OCR
|--------------------------------------------------------------------------
*/

async function processImageDocument(
  buffer,
  pageUrl,
  institution,
  itemLists
) {
  const tesseract = await loadTesseract();

  if (!tesseract) {
    return;
  }

  try {
    const api =
      tesseract.default || tesseract;

    const result =
      await api.recognize(
        buffer,
        "eng"
      );

    const text =
      normalizeText(
        result?.data?.text || ""
      );

    if (!text) {
      return;
    }

    const source = pageUrl;

    const phones =
      extractPhones(text) || [];

    for (const phone of phones) {
      addItem(itemLists.items, {
        type: "phone",
        value: phone,
        source,
        context: text,
        confidence: 0.75,
      });
    }

    const emails =
      extractEmails(text) || [];

    for (const email of emails) {
      addItem(itemLists.items, {
        type: "email",
        value: email,
        source,
        context: text,
        confidence: 0.75,
      });
    }

    const banks =
      extractBankAccounts(text) || [];

    for (const bank of banks) {
      if (typeof bank === "string") {
        addItem(itemLists.items, {
          type: "bank",
          value: bank,
          source,
          context: text,
          confidence: 0.7,
        });
      } else if (bank) {
        addItem(itemLists.items, {
          type: "bank",
          value:
            bank.value ||
            bank.account ||
            bank.number,
          source:
            bank.source ||
            source,
          context:
            bank.context ||
            text,
          confidence:
            bank.confidence !== undefined
              ? bank.confidence
              : 0.7,
        });
      }
    }

    const payments =
      extractPaymentRecords(text) || [];

    for (const payment of payments) {
      addPaymentRecord(
        itemLists.items,
        {
          ...payment,
          source:
            payment.source ||
            source,
        }
      );
    }

    const instructions =
      extractPaymentInstructions(text) || [];

    for (const instruction of instructions) {
      addItem(itemLists.items, {
        type: "payment_instruction",
        value:
          typeof instruction === "string"
            ? instruction
            : instruction?.value ||
              instruction?.text ||
              instruction?.instruction,
        source,
        context: text,
        confidence: 0.7,
      });
    }
  } catch {
    return;
  }
}


/*
|--------------------------------------------------------------------------
| FETCH PAGE
|--------------------------------------------------------------------------
*/

async function fetchPage(
  url,
  institution,
  itemLists,
  pageStatus
) {
  try {
    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "CampusVerify-Crawler/6.0 (+official institutional verification)",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,image/*,*/*;q=0.8",
          },
        },
        FETCH_TIMEOUT_MS
      );

    if (!response.ok) {
      pageStatus.push({
        url,
        status: response.status,
        ok: false,
      });

      return [];
    }

    const finalUrl =
      normalizeUrl(
        response.url || url,
        institution.website
      );

    if (
      finalUrl &&
      !isSafeUrl(finalUrl, institution)
    ) {
      pageStatus.push({
        url,
        status: "redirected_external",
        ok: false,
      });

      return [];
    }

    const contentType =
      (
        response.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();

    const contentLengthHeader =
      response.headers.get(
        "content-length"
      );

    if (
      contentLengthHeader &&
      Number(contentLengthHeader) >
        MAX_RESPONSE_BYTES
    ) {
      pageStatus.push({
        url,
        status: "too_large",
        ok: false,
      });

      return [];
    }

    const arrayBuffer =
      await response.arrayBuffer();

    if (
      arrayBuffer.byteLength >
      MAX_RESPONSE_BYTES
    ) {
      pageStatus.push({
        url,
        status: "too_large",
        ok: false,
      });

      return [];
    }

    const buffer =
      Buffer.from(arrayBuffer);

    /*
     * PDF / documents
     */
    if (
      contentType.includes("pdf") ||
      DOCUMENT_EXTENSIONS.test(
        finalUrl || url
      )
    ) {
      await processDocument(
        buffer,
        finalUrl || url,
        institution,
        itemLists
      );

      pageStatus.push({
        url,
        finalUrl: finalUrl || url,
        status: 200,
        ok: true,
        type: "document",
      });

      return [];
    }

    /*
     * Images
     */
    if (
      contentType.startsWith("image/") ||
      IMAGE_EXTENSIONS.test(
        finalUrl || url
      )
    ) {
      await processImageDocument(
        buffer,
        finalUrl || url,
        institution,
        itemLists
      );

      pageStatus.push({
        url,
        finalUrl: finalUrl || url,
        status: 200,
        ok: true,
        type: "image",
      });

      return [];
    }

    /*
     * HTML
     */
    const html =
      buffer.toString("utf8");

    let pageHtml = html;

    let pageText =
      htmlToText(html);

    let jsRendered = false;

    /*
     * Only use browser rendering when
     * the normal HTML contains very little text.
     *
     * This avoids wasting seconds on normal pages.
     */
    if (
      pageText.length <
      JS_RENDER_MIN_TEXT_LENGTH
    ) {
      const rendered =
        await renderWithHeadlessBrowser(
          finalUrl || url
        );

      if (rendered) {
        const renderedText =
          htmlToText(rendered);

        if (
          renderedText.length >
          pageText.length
        ) {
          pageHtml = rendered;
          pageText = renderedText;
          jsRendered = true;
        }
      }
    }

    const result =
      processHtmlPage(
        pageHtml,
        finalUrl || url,
        institution,
        itemLists,
        pageText
      );

    pageStatus.push({
      url,
      finalUrl: finalUrl || url,
      status: 200,
      ok: true,
      type: "html",
      textLength: result.textLength,
      jsRendered,
    });

    const newLinks = [];

    for (const link of result.links) {
      newLinks.push(link);
    }

    for (const doc of result.embeddedDocuments) {
      newLinks.push({
        url: doc,
        score: scoreUrl(doc) + 20,
      });
    }

    for (const image of result.images) {
      newLinks.push({
        url: image,
        score: scoreUrl(image) + 5,
      });
    }

    if (result.canonical) {
      newLinks.push({
        url: result.canonical,
        score:
          scoreUrl(result.canonical) + 10,
      });
    }

    return newLinks;
  } catch (error) {
    pageStatus.push({
      url,
      status:
        error?.name === "AbortError"
          ? "timeout"
          : "error",
      ok: false,
    });

    return [];
  }
}


/*
|--------------------------------------------------------------------------
| ITEM LISTS
|--------------------------------------------------------------------------
*/

function createItemLists() {
  return {
    items: [],
  };
}


/*
|--------------------------------------------------------------------------
| CRAWL INSTITUTION
|--------------------------------------------------------------------------
*/

async function crawlInstitution(
  institution
) {
  const startTime = Date.now();

  const itemLists =
    createItemLists();

  const pageStatus = [];

  const queue = [];

  const discovered =
    new Set();

  const visited =
    new Set();

  /*
   * Load stored evidence FIRST.
   *
   * Live crawling still happens afterward.
   */
  const fallback =
    loadEvidenceFallback(
      institution
    );

  const fallbackStats =
    mergeEvidenceFallback(
      itemLists.items,
      fallback,
      institution
    );

  function enqueue(
    url,
    depth,
    score = 0
  ) {
    const normalized =
      normalizeUrl(
        url,
        institution.website
      );

    if (!normalized) {
      return;
    }

    if (
      !isSafeUrl(
        normalized,
        institution
      )
    ) {
      return;
    }

    if (
      depth > MAX_CRAWL_DEPTH
    ) {
      return;
    }

    if (
      discovered.has(normalized) ||
      visited.has(normalized)
    ) {
      return;
    }

    discovered.add(normalized);

    queue.push({
      url: normalized,
      depth,
      score,
    });

    /*
     * Keep important pages at the front.
     */
    queue.sort(
      (a, b) =>
        b.score - a.score ||
        a.depth - b.depth
    );
  }


  /*
   * Homepage
   */
  enqueue(
    institution.website,
    0,
    1000
  );


  /*
   * Seed pages if institution provides them.
   */
  const seedPages =
    institution.seedPages ||
    institution.pages ||
    [];

  if (Array.isArray(seedPages)) {
    for (const seed of seedPages) {
      const seedUrl =
        typeof seed === "string"
          ? seed
          : seed?.url;

      if (seedUrl) {
        enqueue(
          seedUrl,
          1,
          900
        );
      }
    }
  }


  /*
   * Sitemap discovery.
   *
   * This is still performed before the main crawl
   * so sitemap pages remain part of the same crawl
   * behavior.
   */
  const sitemapUrls =
    await discoverSitemap(
      institution
    );

  for (const sitemapUrl of sitemapUrls) {
    enqueue(
      sitemapUrl,
      1,
      scoreUrl(sitemapUrl)
    );
  }


  /*
   * NEW CONCURRENT CRAWL
   *
   * Five workers process pages at the same time.
   *
   * The workers stay alive while another worker is
   * fetching a page and may discover more links.
   */
  let activeWorkers = 0;

  async function crawlWorker() {
    while (
      !crawlTimeExceeded(
        startTime
      ) &&
      visited.size <
        MAX_PAGES_PER_INSTITUTION
    ) {
      let current = null;

      /*
       * Get next page.
       *
       * This section is synchronous before the
       * first await, so workers cannot take the
       * same queue item.
       */
      while (
        queue.length > 0
      ) {
        const candidate =
          queue.shift();

        if (
          visited.has(
            candidate.url
          )
        ) {
          continue;
        }

        current = candidate;
        break;
      }

      /*
       * If there is currently no work but another
       * worker is fetching a page, wait briefly.
       * That worker may discover new URLs.
       */
      if (!current) {
        if (
          activeWorkers > 0 &&
          !crawlTimeExceeded(
            startTime
          )
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                10
              )
          );

          continue;
        }

        return;
      }

      if (
        visited.size >=
        MAX_PAGES_PER_INSTITUTION
      ) {
        return;
      }

      if (
        crawlTimeExceeded(
          startTime
        )
      ) {
        return;
      }

      visited.add(
        current.url
      );

      activeWorkers++;

      try {
        const newLinks =
          await fetchPage(
            current.url,
            institution,
            itemLists,
            pageStatus
          );

        /*
         * Add newly discovered pages.
         */
        for (const link of newLinks) {
          if (
            crawlTimeExceeded(
              startTime
            )
          ) {
            break;
          }

          enqueue(
            link.url,
            current.depth + 1,
            link.score || 0
          );
        }
      } finally {
        activeWorkers--;
      }
    }
  }


  /*
   * Start workers.
   */
  const workers = [];

  for (
    let i = 0;
    i < CRAWL_CONCURRENCY;
    i++
  ) {
    workers.push(
      crawlWorker()
    );
  }

  await Promise.all(
    workers
  );


  /*
   * Final results.
   */
  const items =
    itemLists.items;

  const liveEvidenceCount =
    items.filter(
      (item) =>
        !item.fallback
    ).length;

  const fallbackEvidenceCount =
    items.filter(
      (item) =>
        item.fallback
    ).length;

  const crawlStats = {
    durationMs:
      Date.now() - startTime,

    pagesDiscovered:
      discovered.size,

    pagesCrawled:
      visited.size,

    queueRemaining:
      queue.length,

    liveEvidence:
      liveEvidenceCount,

    fallbackEvidence:
      fallbackEvidenceCount,

    concurrency:
      CRAWL_CONCURRENCY,

    timedOut:
      crawlTimeExceeded(
        startTime
      ),
  };


  return {
    items,

    /*
     * Keep evidence alias for existing code.
     */
    evidence: items,

    pagesCrawled:
      visited.size,

    sources:
      pageStatus,

    fallbackStats,

    crawlStats,

    /*
     * Existing-style status flags.
     */
    dataComplete:
      items.length > 0,

    crawlFailed:
      visited.size === 0 &&
      items.length === 0,
  };
}


/*
|--------------------------------------------------------------------------
| API HANDLER
|--------------------------------------------------------------------------
*/

export default async function handler(
  req,
  res
) {
  try {
    const institutionId =
      req.query?.institution ||
      req.query?.institutionId ||
      req.body?.institution ||
      req.body?.institutionId;

    if (!institutionId) {
      return res.status(400).json({
        error:
          "Missing institution ID",
      });
    }

    const institution =
      getInstitutionById(
        institutionId
      );

    if (!institution) {
      return res.status(404).json({
        error:
          "Institution not found",
      });
    }

    /*
     * Emergency fallback is loaded separately
     * so the API can still return evidence if
     * the live crawl encounters a fatal error.
     */
    const emergencyFallback =
      loadEvidenceFallback(
        institution
      );

    try {
      const result =
        await crawlInstitution(
          institution
        );

      return res.status(200).json({
        institution: {
          id:
            institution.id,
          name:
            institution.name,
          website:
            institution.website,
        },

        ...result,
      });
    } catch (crawlError) {
      const emergencyItems = [];

      mergeEvidenceFallback(
        emergencyItems,
        emergencyFallback,
        institution
      );

      return res.status(200).json({
        institution: {
          id:
            institution.id,
          name:
            institution.name,
          website:
            institution.website,
        },

        items:
          emergencyItems,

        evidence:
          emergencyItems,

        pagesCrawled: 0,

        sources: [],

        fallbackStats: {
          matched:
            emergencyItems.length,
          fallbackLoaded:
            emergencyItems.length > 0,
        },

        crawlStats: {
          durationMs: 0,
          pagesDiscovered: 0,
          pagesCrawled: 0,
          queueRemaining: 0,
          liveEvidence: 0,
          fallbackEvidence:
            emergencyItems.length,
          concurrency:
            CRAWL_CONCURRENCY,
          timedOut: false,
        },

        dataComplete:
          emergencyItems.length > 0,

        crawlFailed: true,

        warning:
          "Live crawl failed; institutional fallback evidence returned.",
      });
    }
  } catch (error) {
    return res.status(500).json({
      error:
        "Crawler failed",
      message:
        error?.message ||
        "Unknown crawler error",
    });
  }
}
