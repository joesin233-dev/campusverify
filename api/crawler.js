/* =========================================================================
   CampusVerify — api/crawler.js
   -----------------------------------------------------------------------
   General institutional website crawler

   FLOW:
   Institution website
        ↓
   Homepage / seed pages
        ↓
   Discover public links
        ↓
   Crawl discovered pages
        ↓
   Discover more links
        ↓
   Continue until no useful links remain
        ↓
   Extract phones, emails, banks, payment records and instructions

   IMPORTANT:
   - Crawls the institution's own website only.
   - Does NOT search Google or the wider internet.
   - Follows public HTTP/HTTPS links belonging to the institution.
   - Can follow official subdomains when isSameInstitutionHost()
     considers them part of the institution.
   - Includes safety limits so a huge/infinite website cannot consume
     unlimited resources.
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


/* =========================================================================
   CRAWLER SETTINGS
   ========================================================================= */

/*
 * These are SAFETY limits, not the normal number of pages.
 *
 * The crawler will continue until:
 *   1. There are no more pages to discover, OR
 *   2. one of these safety limits is reached.
 */

const FETCH_TIMEOUT_MS = 10000;

/* Maximum number of pages allowed in one crawl */
const MAX_PAGES_PER_INSTITUTION = 250;

/* Prevent extremely deep/infinite link chains */
const MAX_CRAWL_DEPTH = 15;

/* Overall crawl time safety limit */
const MAX_CRAWL_TIME_MS = 45000;

/* Maximum size of one downloaded response */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB

/* Maximum number of links collected from one page */
const MAX_LINKS_PER_PAGE = 500;


/* =========================================================================
   LINK PRIORITY
   ========================================================================= */

const PRIORITY_KEYWORDS = [
  "contact",
  "admission",
  "student",
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
  "registration",
  "register",
  "notice",
  "announcement",
  "news",
  "support",
  "department",
  "faculty",
  "prospectus",
  "download",
  "document",
  "documents",
  "pdf",
  "international",
  "accommodation"
];


/* =========================================================================
   PATHS WE SHOULD NOT CRAWL
   ========================================================================= */

const EXCLUDED_PATH_PATTERNS =
  /login|signin|sign-in|logon|portal|admin|wp-admin|cpanel|dashboard|account\/(login|register)|logout|cart|checkout/i;


/* =========================================================================
   FILE TYPES
   ========================================================================= */

/*
 * HTML pages are the main crawling targets.
 *
 * PDFs/documents are also discovered because universities commonly publish
 * payment information inside prospectuses, fee schedules and notices.
 */
const DOCUMENT_EXTENSIONS =
  /\.(pdf|doc|docx|xls|xlsx|csv|txt)$/i;


/* =========================================================================
   TIME
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

    /*
     * Remove fragments:
     *
     * https://site.com/fees#bank
     * becomes
     * https://site.com/fees
     */
    parsed.hash = "";

    /*
     * Remove common tracking parameters.
     *
     * This prevents the crawler from treating:
     *
     * ?utm_source=x
     * ?utm_campaign=y
     *
     * as completely different pages.
     */
    var trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid"
    ];

    trackingParams.forEach(function (param) {
      parsed.searchParams.delete(param);
    });

    /*
     * Remove trailing slash except for homepage.
     */
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
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

    if (!/^https?:$/.test(parsed.protocol)) {
      return false;
    }

    /*
     * VERY IMPORTANT:
     *
     * Never leave the institution's website.
     */
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

async function fetchWithTimeout(url, ms) {
  var controller = new AbortController();

  var timer = setTimeout(function () {
    controller.abort();
  }, ms);

  try {
    return await fetch(url, {
      signal: controller.signal,

      headers: {
        "User-Agent":
          "CampusVerify-Crawler/4.0 (+institutional verification crawler)"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================================
   READ RESPONSE SAFELY
   ========================================================================= */

async function readResponseSafely(response) {
  /*
   * If content length is known and already too large, don't download it.
   */
  var contentLength = response.headers.get("content-length");

  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    return null;
  }

  /*
   * ArrayBuffer lets us enforce a maximum response size.
   */
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
  return (
    response.headers.get("content-type") || ""
  ).toLowerCase();
}


function isPdfResponse(response, url) {
  var contentType = getContentType(response);

  return (
    contentType.indexOf("application/pdf") !== -1 ||
    /\.pdf$/i.test(url)
  );
}


function isHtmlResponse(response, url) {
  var contentType = getContentType(response);

  return (
    contentType.indexOf("text/html") !== -1 ||
    contentType.indexOf("application/xhtml+xml") !== -1 ||
    (!contentType && !DOCUMENT_EXTENSIONS.test(url))
  );
}


/* =========================================================================
   HTML LINK DISCOVERY
   ========================================================================= */

function discoverLinks(html, pageUrl, institution) {
  var linkRegex =
    /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  var found = [];
  var seen = {};

  var m;

  while ((m = linkRegex.exec(html)) !== null) {
    if (found.length >= MAX_LINKS_PER_PAGE) {
      break;
    }

    var href = (m[1] || "").trim();

    if (!href) {
      continue;
    }

    /*
     * Ignore JavaScript, mailto, tel and other non-web links.
     */
    if (
      /^javascript:/i.test(href) ||
      /^mailto:/i.test(href) ||
      /^tel:/i.test(href) ||
      /^#/.test(href)
    ) {
      continue;
    }

    var anchorText =
      (m[2] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
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

    if (seen[normalised]) {
      continue;
    }

    seen[normalised] = true;

    var lowerPath = "";

    try {
      lowerPath = new URL(normalised).pathname.toLowerCase();
    } catch (e) {}

    /*
     * Give useful pages a higher queue priority.
     */
    var score = 0;

    PRIORITY_KEYWORDS.forEach(function (keyword) {
      if (
        lowerPath.indexOf(keyword) !== -1 ||
        anchorText.indexOf(keyword) !== -1
      ) {
        score += 1;
      }
    });

    /*
     * Documents containing official information are particularly useful.
     */
    if (DOCUMENT_EXTENSIONS.test(lowerPath)) {
      score += 3;
    }

    found.push({
      url: normalised,
      score: score
    });
  }

  /*
   * Highest-value pages first.
   */
  found.sort(function (a, b) {
    return b.score - a.score;
  });

  return found;
}


/* =========================================================================
   META / CANONICAL URL
   ========================================================================= */

function extractCanonicalUrl(html, pageUrl) {
  var match =
    html.match(
      /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i
    ) ||
    html.match(
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i
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
   ADD ITEM
   ========================================================================= */

function addItem(list, value, source, seenKey) {
  if (!value) {
    return;
  }

  var key = seenKey || value;

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
   ADD PAYMENT RECORD
   ========================================================================= */

function addPaymentRecord(list, record) {
  if (!record || !record.accountNumber) {
    return;
  }

  var accountNumber =
    String(record.accountNumber)
      .replace(/\D/g, "");

  if (!accountNumber) {
    return;
  }

  /*
   * Same account number appearing on several official pages should not
   * create hundreds of duplicate records.
   */
  var existing = list.find(function (item) {
    var rec = item && item.value ? item.value : item;

    return (
      rec &&
      String(rec.accountNumber || "")
        .replace(/\D/g, "") === accountNumber
    );
  });

  if (existing) {
    /*
     * If another page contains richer information, preserve it.
     */
    var existingRecord =
      existing.value || existing;

    if (!existingRecord.bankName && record.bankName) {
      existingRecord.bankName = record.bankName;
    }

    if (!existingRecord.accountName && record.accountName) {
      existingRecord.accountName = record.accountName;
    }

    if (!existingRecord.branch && record.branch) {
      existingRecord.branch = record.branch;
    }

    return;
  }

  list.push({
    value: record,
    source: record.source
  });
}


/* =========================================================================
   PDF TEXT EXTRACTION — BASIC
   ========================================================================= */

/*
 * This is intentionally conservative.
 *
 * A PDF can contain compressed/binary data, so simply converting the entire
 * PDF into UTF-8 is NOT a full PDF parser.
 *
 * However, many simple text PDFs contain readable text fragments. We inspect
 * those fragments so that some published payment details can still be found.
 *
 * For full PDF extraction later, a dedicated PDF parser can be added without
 * changing the crawler architecture.
 */
function extractPossiblePdfText(buffer) {
  if (!buffer) {
    return "";
  }

  var raw = buffer.toString("latin1");

  /*
   * Pull out reasonably readable sequences.
   */
  var matches =
    raw.match(
      /[\x20-\x7E]{4,}/g
    ) || [];

  return matches
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}


/* =========================================================================
   PROCESS HTML PAGE
   ========================================================================= */

function processHtmlPage(
  html,
  pageUrl,
  institution,
  itemLists
) {
  if (!html) {
    return [];
  }

  extractPhones(html).forEach(function (phone) {
    addItem(
      itemLists.phones,
      phone,
      pageUrl
    );
  });

  extractEmails(html).forEach(function (email) {
    addItem(
      itemLists.emails,
      email,
      pageUrl
    );
  });

  extractBanks(html).forEach(function (bank) {
    addItem(
      itemLists.bankNames,
      bank,
      pageUrl
    );
  });

  var pageTitle = extractTitle(html);

  extractPaymentRecords(
    html,
    pageUrl,
    pageTitle
  ).forEach(function (record) {
    addPaymentRecord(
      itemLists.paymentRecords,
      record
    );
  });

  extractPaymentInstructions(html).forEach(function (instruction) {
    addItem(
      itemLists.paymentInstructions,
      instruction,
      pageUrl,
      instruction.slice(0, 80)
    );
  });

  /*
   * Discover additional pages.
   */
  var discovered = discoverLinks(
    html,
    pageUrl,
    institution
  );

  /*
   * Canonical URL is useful to know, but only if it belongs to the
   * institution.
   */
  var canonical = extractCanonicalUrl(
    html,
    pageUrl
  );

  if (
    canonical &&
    isCrawlableUrl(canonical, institution)
  ) {
    discovered.push({
      url: canonical,
      score: 1
    });
  }

  return discovered;
}


/* =========================================================================
   PROCESS PDF / DOCUMENT
   ========================================================================= */

function processDocument(
  buffer,
  pageUrl,
  itemLists
) {
  var text = extractPossiblePdfText(buffer);

  if (!text) {
    return;
  }

  extractPhones(text).forEach(function (phone) {
    addItem(
      itemLists.phones,
      phone,
      pageUrl
    );
  });

  extractEmails(text).forEach(function (email) {
    addItem(
      itemLists.emails,
      email,
      pageUrl
    );
  });

  extractBanks(text).forEach(function (bank) {
    addItem(
      itemLists.bankNames,
      bank,
      pageUrl
    );
  });

  extractPaymentRecords(
    text,
    pageUrl,
    pageUrl.split("/").pop() || "Official document"
  ).forEach(function (record) {
    addPaymentRecord(
      itemLists.paymentRecords,
      record
    );
  });

  extractPaymentInstructions(text).forEach(function (instruction) {
    addItem(
      itemLists.paymentInstructions,
      instruction,
      pageUrl,
      instruction.slice(0, 80)
    );
  });
}


/* =========================================================================
   FETCH ONE URL
   ========================================================================= */

async function fetchPage(
  url,
  institution,
  itemLists,
  pageStatus
) {
  try {
    var parsedUrl = new URL(url);

    if (
      !isSameInstitutionHost(
        parsedUrl.hostname,
        institution.domain
      )
    ) {
      return [];
    }

    if (
      EXCLUDED_PATH_PATTERNS.test(
        parsedUrl.pathname
      )
    ) {
      return [];
    }

    var response =
      await fetchWithTimeout(
        url,
        FETCH_TIMEOUT_MS
      );

    if (!response.ok) {
      pageStatus.push({
        url: url,
        status: "unreachable",
        httpStatus: response.status
      });

      return [];
    }

    var buffer =
      await readResponseSafely(response);

    if (!buffer) {
      pageStatus.push({
        url: url,
        status: "too_large"
      });

      return [];
    }

    var contentType =
      getContentType(response);

    /*
     * PDF / document handling
     */
    if (
      isPdfResponse(response, url) ||
      DOCUMENT_EXTENSIONS.test(parsedUrl.pathname)
    ) {
      processDocument(
        buffer,
        url,
        itemLists
      );

      pageStatus.push({
        url: url,
        status: "ok",
        type: "document",
        contentType: contentType
      });

      return [];
    }

    /*
     * Only process HTML pages as crawlable pages.
     */
    if (!isHtmlResponse(response, url)) {
      pageStatus.push({
        url: url,
        status: "skipped",
        type: "non-html",
        contentType: contentType
      });

      return [];
    }

    var html =
      buffer.toString("utf8");

    var discovered =
      processHtmlPage(
        html,
        url,
        institution,
        itemLists
      );

    pageStatus.push({
      url: url,
      status: "ok",
      type: "html",
      contentType: contentType,
      linksDiscovered: discovered.length
    });

    return discovered;

  } catch (err) {
    var isTimeout =
      err &&
      err.name === "AbortError";

    console.error(
      "CampusVerify crawler error for",
      url,
      ":",
      err && err.message
    );

    pageStatus.push({
      url: url,
      status: isTimeout
        ? "timeout"
        : "unreachable"
    });

    return [];
  }
}


/* =========================================================================
   CREATE ITEM LISTS
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
   CRAWL INSTITUTION
   ========================================================================= */

async function crawlInstitution(
  institution,
  homepage,
  startTime
) {
  var itemLists =
    createItemLists();

  var pageStatus = [];

  /*
   * Queue entries contain:
   *
   * {
   *   url,
   *   depth,
   *   score
   * }
   */
  var queue = [];

  /*
   * discovered = URLs that have already been placed into the queue.
   *
   * This is separate from visited so that we don't enqueue the same page
   * thousands of times while processing many pages.
   */
  var discovered = new Set();

  var visited = new Set();


  /* -----------------------------------------------------------------------
     ADD URL TO QUEUE
     ----------------------------------------------------------------------- */

  function enqueue(
    url,
    depth,
    score
  ) {
    if (!url) {
      return;
    }

    if (depth > MAX_CRAWL_DEPTH) {
      return;
    }

    var normalised =
      normaliseUrl(url);

    if (!normalised) {
      return;
    }

    if (
      !isCrawlableUrl(
        normalised,
        institution
      )
    ) {
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

    /*
     * Keep the most important pages near the front.
     */
    queue.sort(function (a, b) {
      if (a.depth !== b.depth) {
        /*
         * Prefer useful high-priority pages, but don't completely prevent
         * deeper pages from being crawled.
         */
        return (
          (b.score - a.score) ||
          (a.depth - b.depth)
        );
      }

      return b.score - a.score;
    });
  }


  /* -----------------------------------------------------------------------
     INITIAL URLS
     ----------------------------------------------------------------------- */

  enqueue(
    homepage,
    0,
    100
  );

  /*
   * Institution seed pages remain useful.
   *
   * They are not required for the crawler to work.
   */
  (institution.seedPages || []).forEach(function (url) {
    enqueue(
      url,
      0,
      90
    );
  });


  /* -----------------------------------------------------------------------
     MAIN CRAWLING LOOP
     ----------------------------------------------------------------------- */

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES_PER_INSTITUTION &&
    !crawlTimeExceeded(startTime)
  ) {
    /*
     * Remove first URL from priority queue.
     */
    var current =
      queue.shift();

    if (!current) {
      break;
    }

    if (visited.has(current.url)) {
      continue;
    }

    visited.add(current.url);

    /*
     * Crawl the page.
     */
    var discoveredLinks =
      await fetchPage(
        current.url,
        institution,
        itemLists,
        pageStatus
      );

    /*
     * Every newly discovered link gets added to the queue.
     */
    discoveredLinks.forEach(function (item) {
      if (
        !item ||
        !item.url
      ) {
        return;
      }

      enqueue(
        item.url,
        current.depth + 1,
        item.score || 0
      );
    });
  }


  /* -----------------------------------------------------------------------
     CRAWL STATUS
     ----------------------------------------------------------------------- */

  var timeLimitReached =
    crawlTimeExceeded(startTime);

  var pageLimitReached =
    visited.size >=
    MAX_PAGES_PER_INSTITUTION;

  var depthLimitedLinks =
    queue.filter(function (item) {
      return item.depth >=
        MAX_CRAWL_DEPTH;
    }).length;

  var pendingLinks =
    queue.length;

  var okSources =
    pageStatus
      .filter(function (item) {
        return item.status === "ok";
      })
      .map(function (item) {
        return item.url;
      });


  /*
   * dataComplete means:
   *
   * We reached the end naturally.
   *
   * If the safety page/time limit stopped us while there were still pages
   * waiting, dataComplete becomes false.
   */
  var stoppedBySafetyLimit =
    timeLimitReached ||
    pageLimitReached;

  var dataComplete =
    !stoppedBySafetyLimit &&
    pendingLinks === 0 &&
    depthLimitedLinks === 0;


  var crawlFailed =
    okSources.length === 0;


  return {
    items: itemLists,

    pagesCrawled: pageStatus,

    sources: okSources,

    crawlStats: {
      pagesVisited: visited.size,

      pagesSuccessful: okSources.length,

      pagesPending: pendingLinks,

      maxPages: MAX_PAGES_PER_INSTITUTION,

      maxDepth: MAX_CRAWL_DEPTH,

      maxTimeMs: MAX_CRAWL_TIME_MS,

      timeLimitReached: timeLimitReached,

      pageLimitReached: pageLimitReached,

      dataComplete: dataComplete
    },

    dataComplete: dataComplete,

    crawlFailed: crawlFailed
  };
}


/* =========================================================================
   API HANDLER
   ========================================================================= */

module.exports = async function handler(
  req,
  res
) {
  var institutionId =
    req.query.institution;

  if (!institutionId) {
    return res.status(400).json({
      error: "Missing institution id"
    });
  }


  var institution =
    getInstitutionById(
      institutionId
    );

  if (!institution) {
    return res.status(404).json({
      error:
        "This institution is not supported yet."
    });
  }


  /*
   * Start from the institution's configured domain.
   */
  var homepage =
    "https://" +
    institution.domain +
    "/";


  var startTime =
    Date.now();


  try {
    var result =
      await crawlInstitution(
        institution,
        homepage,
        startTime
      );


    return res.status(200).json({
      institutionId:
        institution.id,

      institutionName:
        institution.name,

      domain:
        institution.domain,

      status:
        institution.status,

      items:
        result.items,

      pagesCrawled:
        result.pagesCrawled,

      sources:
        result.sources,

      crawlStats:
        result.crawlStats,

      dataComplete:
        result.dataComplete,

      crawlFailed:
        result.crawlFailed,

      checkedAt:
        new Date().toISOString()
    });

  } catch (err) {
    console.error(
      "CampusVerify crawler fatal error:",
      err
    );

    return res.status(500).json({
      error:
        "The institution website could not be crawled.",

      institutionId:
        institution.id,

      institutionName:
        institution.name,

      domain:
        institution.domain,

      dataComplete:
        false,

      crawlFailed:
        true,

      checkedAt:
        new Date().toISOString()
    });
  }
};
