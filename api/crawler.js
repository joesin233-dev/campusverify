/* =========================================================================
   CampusVerify — api/crawler.js
   -----------------------------------------------------------------------
   General institutional website crawler (strengthened version)

   PURPOSE:
   - Crawl an institution's public official website.
   - Discover useful public pages recursively.
   - Discover official documents/PDFs linked from those pages.
   - Extract phones, emails, banks, payment records and instructions.
   - Preserve the official source for every discovered item.
   - Never search Google or the wider internet.
   - Never treat a bank-name-only match as proof of an account.
   - Never claim a missing result means fraud.

   CRAWL FLOW:

   Official institution website
            ↓
       Homepage
            ↓
      Discover links
            ↓
    Priority useful pages
            ↓
     Discover more links
            ↓
       Documents/PDFs
            ↓
       Extract evidence
            ↓
     Continue recursively
            ↓
       Safety limits
            ↓
       Evidence result

   IMPORTANT:
   - The crawler stays inside the institution's approved host/domain.
   - It does not follow external websites.
   - It does not use Google.
   - It does not use a hardcoded bank-account database.
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

/* =========================================================================
   SETTINGS
   ========================================================================= */

const FETCH_TIMEOUT_MS = 12000;

/* Maximum URLs processed during one crawl */
const MAX_PAGES_PER_INSTITUTION = 350;

/* Maximum link depth */
const MAX_CRAWL_DEPTH = 18;

/* Maximum total crawl time */
const MAX_CRAWL_TIME_MS = 60000;

/* Maximum response size */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/* Maximum links discovered from one HTML page */
const MAX_LINKS_PER_PAGE = 1000;

/* =========================================================================
   PRIORITY KEYWORDS
   ========================================================================= */

const PRIORITY_KEYWORDS = [
  "contact",
  "contacts",

  "admission",
  "admissions",

  "student",
  "students",
  "student-affairs",
  "student_affairs",
  "studentaffairs",

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

  "registration",
  "register",
  "registration-notice",

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
  "international-student",

  "accommodation",
  "hostel",

  "tuition",
  "school-fees",

  "accounts-office",
  "bursar"
];

/* =========================================================================
   EXCLUDED PATHS
   ========================================================================= */

const EXCLUDED_PATH_PATTERNS =
  /(?:^|/)(?:login|signin|sign-in|logon|portal|admin|wp-admin|cpanel|dashboard|logout)(?:/|$)/i;

/* =========================================================================
   FILE TYPES
   ========================================================================= */

/*
 * More permissive document extension check, allowing query strings.
 */
const DOCUMENT_EXTENSIONS =
  /.(pdf|doc|docx|xls|xlsx|csv|txt)(?:$|?)/i;

/* =========================================================================
   CRAWL TIME
   ========================================================================= */

function crawlTimeExceeded(startTime) {
  return Date.now() - startTime >= MAX_CRAWL_TIME_MS;
}

/* =========================================================================
   URL NORMALISATION
   ========================================================================= */

function normaliseUrl(url) {
  try {
    var parsed = new URL(url);

    parsed.hash = "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid"
    ].forEach(function (param) {
      parsed.searchParams.delete(param);
    });

    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(//+$/, "");
    }

    return parsed.toString();
  } catch (e) {
    return null;
  }
}

/* =========================================================================
   URL SAFETY
   ========================================================================= */

function isCrawlableUrl(url, institution) {
  try {
    var parsed = new URL(url);

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return false;
    }

    if (!isSameInstitutionHost(parsed.hostname, institution.domain)) {
      return false;
    }

    if (EXCLUDED_PATH_PATTERNS.test(parsed.pathname)) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

/* =========================================================================
   FETCH
   ========================================================================= */

async function fetchWithTimeout(url, timeoutMs) {
  var controller = new AbortController();

  var timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "CampusVerify-Crawler/6.0 (+official institutional verification)"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================================
   SAFE RESPONSE READER
   ========================================================================= */

async function readResponseSafely(response) {
  var contentLength = response.headers.get("content-length");

  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    return null;
  }

  var buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    return null;
  }

  return Buffer.from(buffer);
}

/* =========================================================================
   CONTENT TYPE
   ========================================================================= */

function getContentType(response) {
  return (response.headers.get("content-type") || "").toLowerCase();
}

function isPdfResponse(response, url) {
  var contentType = getContentType(response);

  return (
    contentType.indexOf("application/pdf") !== -1 ||
    /.pdf(?:$|?)/i.test(url)
  );
}

function isHtmlResponse(response) {
  var contentType = getContentType(response);

  return (
    contentType.indexOf("text/html") !== -1 ||
    contentType.indexOf("application/xhtml+xml") !== -1
  );
}

/* =========================================================================
   HTML LINK DISCOVERY (STRENGTHENED)
   ========================================================================= */

function discoverLinks(html, pageUrl, institution) {
  /*
   * Match <a> tags with href.
   */
  var linkRegex =
    /<a\b[^>]*hrefs*=s*["']([^"']+)["'][^>]*>([sS]*?)</a>/gi;

  var found = [];
  var seen = new Set();
  var match;

  while ((match = linkRegex.exec(html)) !== null) {
    if (found.length >= MAX_LINKS_PER_PAGE) {
      break;
    }

    var href = (match[1] || "").trim();

    if (!href) {
      continue;
    }

    if (
      /^javascript:/i.test(href) ||
      /^mailto:/i.test(href) ||
      /^tel:/i.test(href) ||
      /^data:/i.test(href)
    ) {
      continue;
    }

    if (href.charAt(0) === "#") {
      continue;
    }

    var anchorText = (match[2] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/s+/g, " ")
      .trim()
      .toLowerCase();

    var resolved;

    try {
      resolved = new URL(href, pageUrl).toString();
    } catch (e) {
      continue;
    }

    var normalised = normaliseUrl(resolved);

    if (!normalised) {
      continue;
    }

    if (!isCrawlableUrl(normalised, institution)) {
      continue;
    }

    if (seen.has(normalised)) {
      continue;
    }

    seen.add(normalised);

    var parsed;

    try {
      parsed = new URL(normalised);
    } catch (e) {
      continue;
    }

    var path = parsed.pathname.toLowerCase();
    var score = 0;

    PRIORITY_KEYWORDS.forEach(function (keyword) {
      if (path.indexOf(keyword) !== -1) {
        score += 3;
      }
      if (anchorText.indexOf(keyword) !== -1) {
        score += 2;
      }
    });

    if (DOCUMENT_EXTENSIONS.test(path)) {
      score += 10;
    }

    if (/bank|payment|fee|account|finance|registration/i.test(path)) {
      score += 5;
    }

    /*
     * Boost links that look like documents even if extension is hidden
     * behind query params.
     */
    if (/download|document|file|pdf/i.test(path)) {
      score += 3;
    }

    found.push({
      url: normalised,
      score: score
    });
  }

  found.sort(function (a, b) {
    return b.score - a.score;
  });

  return found;
}

/* =========================================================================
   CANONICAL URL
   ========================================================================= */

function extractCanonicalUrl(html, pageUrl) {
  var match =
    html.match(
      /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["']/i
    ) ||
    html.match(
      /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["']/i
    );

  if (!match) {
    return null;
  }

  try {
    return normaliseUrl(
      new URL(match[1], pageUrl).toString()
    );
  } catch (e) {
    return null;
  }
}

/* =========================================================================
   SITEMAP DISCOVERY
   ========================================================================= */

async function discoverSitemap(homepage, institution, startTime) {
  if (crawlTimeExceeded(startTime)) {
    return [];
  }

  var base;

  try {
    base = new URL(homepage);
  } catch (e) {
    return [];
  }

  var sitemapUrl = base.origin + "/sitemap.xml";

  if (!isCrawlableUrl(sitemapUrl, institution)) {
    return [];
  }

  try {
    var response = await fetchWithTimeout(sitemapUrl, FETCH_TIMEOUT_MS);

    if (!response.ok) {
      return [];
    }

    var buffer = await readResponseSafely(response);

    if (!buffer) {
      return [];
    }

    var xml = buffer.toString("utf8");

    var urls = [];
    var seen = new Set();
    var regex = /<loc>s*([^<]+)s*</loc>/gi;
    var match;

    while ((match = regex.exec(xml)) !== null) {
      var url = normaliseUrl(match[1].trim());

      if (!url) {
        continue;
      }

      if (!isCrawlableUrl(url, institution)) {
        continue;
      }

      if (seen.has(url)) {
        continue;
      }

      seen.add(url);

      urls.push({
        url: url,
        score: 40
      });

      if (urls.length >= 1000) {
        break;
      }
    }

    return urls;
  } catch (err) {
    return [];
  }
}

/* =========================================================================
   LIST ITEM
   ========================================================================= */

function addItem(list, value, source, seenKey) {
  if (!value) {
    return;
  }

  var key = String(seenKey || value).trim().toLowerCase();

  if (list._seen.has(key)) {
    return;
  }

  list._seen.add(key);

  list.push({
    value: value,
    source: source
  });
}

/* =========================================================================
   PAYMENT RECORD
   ========================================================================= */

function addPaymentRecord(list, record) {
  if (!record || !record.accountNumber) {
    return;
  }

  var accountNumber = String(record.accountNumber).replace(/D/g, "");

  if (!accountNumber) {
    return;
  }

  var existing = list.find(function (item) {
    var rec = item && item.value ? item.value : item;
    return (
      rec &&
      String(rec.accountNumber || "").replace(/D/g, "") === accountNumber
    );
  });

  if (existing) {
    var existingRecord = existing.value || existing;

    if (!existingRecord.bankName && record.bankName) {
      existingRecord.bankName = record.bankName;
    }
    if (!existingRecord.accountName && record.accountName) {
      existingRecord.accountName = record.accountName;
    }
    if (!existingRecord.branch && record.branch) {
      existingRecord.branch = record.branch;
    }
    if (!existingRecord.context && record.context) {
      existingRecord.context = record.context;
    }

    return;
  }

  list.push({
    value: record,
    source: record.source
  });
}

/* =========================================================================
   EXTRACT TEXT FROM HTML
   ========================================================================= */

function htmlToText(html) {
  return html
    .replace(
      /<(script|style|noscript|svg)[sS]*?</\u0001>/gi,
      " "
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/s+/g, " ")
    .trim();
}

/* =========================================================================
   PROCESS HTML
   ========================================================================= */

function processHtmlPage(html, pageUrl, institution, itemLists) {
  if (!html) {
    return [];
  }

  var text = htmlToText(html);

  extractPhones(text).forEach(function (phone) {
    addItem(itemLists.phones, phone, pageUrl, phone);
  });

  extractEmails(text).forEach(function (email) {
    addItem(itemLists.emails, email, pageUrl, email);
  });

  extractBanks(text).forEach(function (bank) {
    addItem(itemLists.bankNames, bank, pageUrl, bank);
  });

  var pageTitle = extractTitle(html);

  extractPaymentRecords(text, pageUrl, pageTitle).forEach(function (record) {
    addPaymentRecord(itemLists.paymentRecords, record);
  });

  extractPaymentInstructions(text).forEach(function (instruction) {
    addItem(
      itemLists.paymentInstructions,
      instruction,
      pageUrl,
      instruction.trim().toLowerCase()
    );
  });

  var discovered = discoverLinks(html, pageUrl, institution);

  var canonical = extractCanonicalUrl(html, pageUrl);

  if (canonical && isCrawlableUrl(canonical, institution)) {
    discovered.push({
      url: canonical,
      score: 20
    });
  }

  return discovered;
}

/* =========================================================================
   BASIC DOCUMENT TEXT EXTRACTION (FALLBACK)
   ========================================================================= */

function extractPossibleDocumentText(buffer) {
  if (!buffer) {
    return "";
  }

  var raw = buffer.toString("latin1");

  raw = raw
    .replace(/\\([()\\])/g, "$1")
    .replace(/\
/g, "
")
    .replace(/\\r/g, "
")
    .replace(/\\t/g, " ");

  var matches = raw.match(/[ -~]{3,}/g) || [];

  return matches.join(" ").replace(/s+/g, " ").trim();
}

/* =========================================================================
   PROCESS DOCUMENT (STRENGTHENED)
   ========================================================================= */

async function processDocument(buffer, pageUrl, itemLists, isPdf) {
  var text = "";

  if (isPdf) {
    try {
      var parsed = await pdfParse(buffer);
      text = (parsed && parsed.text) || "";

      if (!text || text.trim().length < 50) {
        // Very short text: possibly scanned PDF
        console.log(
          "PDF text very short, using raw fallback:",
          pageUrl,
          "length:",
          text ? text.length : 0
        );
        text = extractPossibleDocumentText(buffer) || text;
      }
    } catch (err) {
      console.error(
        "CampusVerify PDF parse failed, using fallback:",
        pageUrl,
        err && err.message
      );
      text = extractPossibleDocumentText(buffer);
    }
  } else {
    text = extractPossibleDocumentText(buffer);
  }

  if (!text || text.trim().length === 0) {
    console.log("No usable text extracted from document:", pageUrl);
    return;
  }

  // Optional debug: log if we see long digit sequences
  if (/d{9,13}/.test(text)) {
    console.log(
      "Document with possible account numbers:",
      pageUrl,
      "sample:",
      text.slice(0, 500)
    );
  }

  extractPhones(text).forEach(function (phone) {
    addItem(itemLists.phones, phone, pageUrl, phone);
  });

  extractEmails(text).forEach(function (email) {
    addItem(itemLists.emails, email, pageUrl, email);
  });

  extractBanks(text).forEach(function (bank) {
    addItem(itemLists.bankNames, bank, pageUrl, bank);
  });

  var title = pageUrl.split("/").pop() || "Official document";

  extractPaymentRecords(text, pageUrl, title).forEach(function (record) {
    addPaymentRecord(itemLists.paymentRecords, record);
  });

  extractPaymentInstructions(text).forEach(function (instruction) {
    addItem(
      itemLists.paymentInstructions,
      instruction,
      pageUrl,
      instruction.trim().toLowerCase()
    );
  });
}

/* =========================================================================
   FETCH + PROCESS ONE URL
   ========================================================================= */

async function fetchPage(url, institution, itemLists, pageStatus) {
  try {
    var parsed = new URL(url);

    if (!isSameInstitutionHost(parsed.hostname, institution.domain)) {
      return [];
    }

    if (EXCLUDED_PATH_PATTERNS.test(parsed.pathname)) {
      return [];
    }

    var response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

    if (!response.ok) {
      pageStatus.push({
        url: url,
        status: "unreachable",
        httpStatus: response.status
      });

      return [];
    }

    var buffer = await readResponseSafely(response);

    if (!buffer) {
      pageStatus.push({
        url: url,
        status: "too_large"
      });

      return [];
    }

    var contentType = getContentType(response);

    if (
      isPdfResponse(response, url) ||
      DOCUMENT_EXTENSIONS.test(parsed.pathname)
    ) {
      console.log("Processing document/PDF:", url);

      await processDocument(
        buffer,
        url,
        itemLists,
        isPdfResponse(response, url)
      );

      pageStatus.push({
        url: url,
        status: "ok",
        type: "document",
        contentType: contentType
      });

      return [];
    }

    if (!isHtmlResponse(response)) {
      pageStatus.push({
        url: url,
        status: "skipped",
        type: "non-html",
        contentType: contentType
      });

      return [];
    }

    var html = buffer.toString("utf8");

    var discovered = processHtmlPage(html, url, institution, itemLists);

    pageStatus.push({
      url: url,
      status: "ok",
      type: "html",
      contentType: contentType,
      linksDiscovered: discovered.length
    });

    return discovered;
  } catch (err) {
    var timedOut = err && err.name === "AbortError";

    console.error(
      "CampusVerify crawler error:",
      url,
      err && err.message
    );

    pageStatus.push({
      url: url,
      status: timedOut ? "timeout" : "unreachable"
    });

    return [];
  }
}

/* =========================================================================
   ITEM LISTS
   ========================================================================= */

function createItemLists() {
  var lists = {
    phones: [],
    emails: [],
    bankNames: [],
    paymentRecords: [],
    paymentInstructions: []
  };

  Object.keys(lists).forEach(function (key) {
    lists[key]._seen = new Set();
  });

  return lists;
}

/* =========================================================================
   CRAWL ENGINE
   ========================================================================= */

async function crawlInstitution(institution, homepage, startTime) {
  var itemLists = createItemLists();
  var pageStatus = [];
  var queue = [];
  var discovered = new Set();
  var visited = new Set();

  function enqueue(url, depth, score) {
    if (!url) {
      return;
    }

    if (depth > MAX_CRAWL_DEPTH) {
      return;
    }

    var normalised = normaliseUrl(url);

    if (!normalised) {
      return;
    }

    if (!isCrawlableUrl(normalised, institution)) {
      return;
    }

    if (discovered.has(normalised)) {
      return;
    }

    if (visited.has(normalised)) {
      return;
    }

    discovered.add(normalised);

    queue.push({
      url: normalised,
      depth: depth,
      score: score || 0
    });

    queue.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.depth - b.depth;
    });
  }

  enqueue(homepage, 0, 1000);

  (institution.seedPages || []).forEach(function (url) {
    enqueue(url, 0, 900);
  });

  var sitemapUrls = await discoverSitemap(homepage, institution, startTime);

  sitemapUrls.forEach(function (item) {
    enqueue(item.url, 0, item.score);
  });

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES_PER_INSTITUTION &&
    !crawlTimeExceeded(startTime)
  ) {
    var current = queue.shift();

    if (!current) {
      break;
    }

    if (visited.has(current.url)) {
      continue;
    }

    visited.add(current.url);

    var newLinks = await fetchPage(
      current.url,
      institution,
      itemLists,
      pageStatus
    );

    newLinks.forEach(function (item) {
      if (!item || !item.url) {
        return;
      }

      enqueue(item.url, current.depth + 1, item.score || 0);
    });
  }

  var timeLimitReached = crawlTimeExceeded(startTime);
  var pageLimitReached = visited.size >= MAX_PAGES_PER_INSTITUTION;
  var pendingLinks = queue.length;

  var successfulPages = pageStatus.filter(function (item) {
    return item.status === "ok";
  });

  var successfulSources = successfulPages.map(function (item) {
    return item.url;
  });

  var crawlEndedNaturally =
    !timeLimitReached && !pageLimitReached && pendingLinks === 0;

  var failedPages = pageStatus.filter(function (item) {
    return (
      item.status === "unreachable" ||
      item.status === "timeout" ||
      item.status === "too_large"
    );
  });

  var dataComplete =
    crawlEndedNaturally && failedPages.length === 0;

  var crawlFailed = successfulPages.length === 0;

  return {
    items: itemLists,
    pagesCrawled: pageStatus,
    sources: successfulSources,
    crawlStats: {
      pagesVisited: visited.size,
      pagesSuccessful: successfulPages.length,
      pagesFailed: failedPages.length,
      pagesPending: pendingLinks,
      maxPages: MAX_PAGES_PER_INSTITUTION,
      maxDepth: MAX_CRAWL_DEPTH,
      maxTimeMs: MAX_CRAWL_TIME_MS,
      timeLimitReached: timeLimitReached,
      pageLimitReached: pageLimitReached,
      crawlEndedNaturally: crawlEndedNaturally,
      dataComplete: dataComplete
    },
    dataComplete: dataComplete,
    crawlFailed: crawlFailed
  };
}

/* =========================================================================
   API HANDLER
   ========================================================================= */

module.exports = async function handler(req, res) {
  var institutionId = req.query.institution;

  if (!institutionId) {
    return res.status(400).json({
      error: "Missing institution id"
    });
  }

  var institution = getInstitutionById(institutionId);

  if (!institution) {
    return res.status(404).json({
      error: "This institution is not supported yet."
    });
  }

  var homepage =
    institution.homepage ||
    "https://" + institution.domain + "/";

  var startTime = Date.now();

  try {
    var result = await crawlInstitution(institution, homepage, startTime);

    return res.status(200).json({
      institutionId: institution.id,
      institutionName: institution.name,
      domain: institution.domain,
      status: institution.status,
      officialUrl: homepage,
      items: result.items,
      pagesCrawled: result.pagesCrawled,
      sources: result.sources,
      crawlStats: result.crawlStats,
      dataComplete: result.dataComplete,
      crawlFailed: result.crawlFailed,
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("CampusVerify crawler fatal error:", err);

    return res.status(500).json({
      error: "The institution website could not be crawled.",
      institutionId: institution.id,
      institutionName: institution.name,
      domain: institution.domain,
      officialUrl: homepage,
      items: {
        phones: [],
        emails: [],
        bankNames: [],
        paymentRecords: [],
        paymentInstructions: []
      },
      sources: [],
      pagesCrawled: [],
      crawlStats: {
        pagesVisited: 0,
        pagesSuccessful: 0,
        pagesFailed: 1,
        pagesPending: 0,
        maxPages: MAX_PAGES_PER_INSTITUTION,
        maxDepth: MAX_CRAWL_DEPTH,
        maxTimeMs: MAX_CRAWL_TIME_MS,
        timeLimitReached: false,
        pageLimitReached: false,
        crawlEndedNaturally: false,
        dataComplete: false
      },
      dataComplete: false,
      crawlFailed: true,
      checkedAt: new Date().toISOString()
    });
  }
};
