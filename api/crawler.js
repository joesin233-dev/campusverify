/* =========================================================================
   CampusVerify — api/crawler.js
   -----------------------------------------------------------------------
   General institutional website crawler

   PURPOSE:
   - Crawl an institution's public official website.
   - Discover useful public pages recursively.
   - Discover official documents/PDFs/images linked from those pages.
   - Extract phones, emails, banks, payment records and instructions.
   - Preserve the official source for every discovered item.
   - Use institution-specific JSON evidence only as a FALLBACK.
   - Never search Google or the wider internet.
   - Never treat a bank-name-only match as proof of an account.
   - Never claim a missing result means fraud.

   IMPORTANT:
   - The live crawler remains the primary evidence source.
   - JSON evidence does NOT replace the crawler.
   - JSON evidence is used to preserve official information that
     automated extraction could not reliably recover.
   - The crawler stays inside the institution's approved host/domain.
   - The crawler ONLY accesses publicly reachable pages/files. It never
     logs in, never bypasses Cloudflare/auth walls, and never touches
     private portals, messages, or private account data.

   NEW IN THIS VERSION:
   - Public image (JPG/PNG/etc) document support via OCR (tesseract.js,
     optional dependency — loaded lazily, degrades gracefully if absent).
   - JS-rendered public page support via a headless browser
     (puppeteer-core + @sparticuz/chromium, optional dependency — loaded
     lazily, only invoked when a page's HTML looks like an empty JS
     shell, degrades gracefully if absent).
   - Discovery of publicly linked <img> documents alongside <a> links.
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
   SETTINGS
   ========================================================================= */

const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGES_PER_INSTITUTION = 250;
const MAX_CRAWL_DEPTH = 15;
const MAX_CRAWL_TIME_MS = 45000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LINKS_PER_PAGE = 500;

// JS-rendering / OCR settings
const JS_RENDER_MIN_TEXT_LENGTH = 200; // below this, HTML is treated as a possible JS shell
const MAX_JS_RENDER_TIME_MS = 15000;


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
  /(?:^|\/)(?:login|signin|sign-in|logon|portal|admin|wp-admin|cpanel|dashboard|logout)(?:\/|$)/i;


/* =========================================================================
   FILE TYPES
   ========================================================================= */

const DOCUMENT_EXTENSIONS =
  /\.(pdf|doc|docx|xls|xlsx|csv|txt)$/i;

const IMAGE_EXTENSIONS =
  /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i;


/* =========================================================================
   CRAWL TIME
   ========================================================================= */

function crawlTimeExceeded(startTime) {
  return (
    Date.now() - startTime >=
    MAX_CRAWL_TIME_MS
  );
}


/* =========================================================================
   OPTIONAL DEPENDENCY LOADERS
   -----------------------------------------------------------------------
   Both OCR and headless rendering are OPTIONAL. If the packages are not
   installed, the crawler falls back to its previous behavior instead of
   crashing. Add "tesseract.js", "puppeteer-core", and "@sparticuz/chromium"
   to package.json to activate them.
   ========================================================================= */

var _tesseractModule = null;
var _tesseractLoadAttempted = false;

function loadTesseract() {
  if (_tesseractLoadAttempted) {
    return _tesseractModule;
  }

  _tesseractLoadAttempted = true;

  try {
    _tesseractModule = require("tesseract.js");

  } catch (e) {
    console.error(
      "CampusVerify: tesseract.js not installed, image OCR disabled:",
      e.message
    );

    _tesseractModule = null;
  }

  return _tesseractModule;
}


var _puppeteerModule = null;
var _chromiumModule = null;
var _browserLoadAttempted = false;

function loadHeadlessBrowser() {
  if (_browserLoadAttempted) {
    return _puppeteerModule
      ? { puppeteer: _puppeteerModule, chromium: _chromiumModule }
      : null;
  }

  _browserLoadAttempted = true;

  try {
    _puppeteerModule = require("puppeteer-core");

    try {
      _chromiumModule = require("@sparticuz/chromium");

    } catch (e) {
      _chromiumModule = null;
    }

    return {
      puppeteer: _puppeteerModule,
      chromium: _chromiumModule
    };

  } catch (e) {
    console.error(
      "CampusVerify: puppeteer-core not installed, JS-rendered page support disabled:",
      e.message
    );

    _puppeteerModule = null;

    return null;
  }
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
      parsed.pathname =
        parsed.pathname.replace(/\/+$/, "");
    }

    return parsed.toString();

  } catch (e) {
    return null;
  }
}


/* =========================================================================
   URL SAFETY
   ========================================================================= */

function isCrawlableUrl(
  url,
  institution
) {
  try {
    var parsed = new URL(url);

    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:"
    ) {
      return false;
    }

    if (
      !isSameInstitutionHost(
        parsed.hostname,
        institution.domain
      )
    ) {
      return false;
    }

    if (
      EXCLUDED_PATH_PATTERNS.test(
        parsed.pathname
      )
    ) {
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

async function fetchWithTimeout(
  url,
  timeoutMs
) {
  var controller =
    new AbortController();

  var timer =
    setTimeout(function () {
      controller.abort();
    }, timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "CampusVerify-Crawler/5.0 (+official institutional verification)"
      }
    });

  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================================
   HEADLESS RENDER (PUBLIC PAGES ONLY)
   -----------------------------------------------------------------------
   Used only as a fallback when a normal fetch returns a near-empty HTML
   shell (typical of client-side-rendered pages). Never used to bypass
   login walls or Cloudflare challenges — if the page requires auth or
   blocks bots, rendering will simply fail or return the same
   challenge/login markup, and the crawler moves on.
   ========================================================================= */

async function renderWithHeadlessBrowser(url) {
  var loaded = loadHeadlessBrowser();

  if (!loaded) {
    return null;
  }

  var puppeteer = loaded.puppeteer;
  var chromium = loaded.chromium;

  var browser = null;

  try {
    var launchOptions;

    if (chromium) {
      launchOptions = {
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true
      };

    } else {
      launchOptions = {
        headless: true
      };
    }

    browser = await puppeteer.launch(launchOptions);

    var page = await browser.newPage();

    page.setDefaultNavigationTimeout(
      MAX_JS_RENDER_TIME_MS
    );

    await page.setUserAgent(
      "CampusVerify-Crawler/5.0 (+official institutional verification)"
    );

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: MAX_JS_RENDER_TIME_MS
    });

    var html = await page.content();

    return html;

  } catch (err) {
    console.error(
      "CampusVerify headless render failed:",
      url,
      err && err.message
    );

    return null;

  } finally {
    if (browser) {
      try {
        await browser.close();

      } catch (e) {}
    }
  }
}


/* =========================================================================
   SAFE RESPONSE READER
   ========================================================================= */

async function readResponseSafely(
  response
) {
  var contentLength =
    response.headers.get(
      "content-length"
    );

  if (
    contentLength &&
    Number(contentLength) >
      MAX_RESPONSE_BYTES
  ) {
    return null;
  }

  var buffer =
    await response.arrayBuffer();

  if (
    buffer.byteLength >
    MAX_RESPONSE_BYTES
  ) {
    return null;
  }

  return Buffer.from(buffer);
}


/* =========================================================================
   CONTENT TYPE
   ========================================================================= */

function getContentType(
  response
) {
  return (
    response.headers.get(
      "content-type"
    ) || ""
  ).toLowerCase();
}


function isPdfResponse(
  response,
  url
) {
  var contentType =
    getContentType(response);

  return (
    contentType.indexOf(
      "application/pdf"
    ) !== -1 ||
    /\.pdf(?:$|\?)/i.test(url)
  );
}


function isImageResponse(
  response,
  url
) {
  var contentType =
    getContentType(response);

  return (
    contentType.indexOf("image/") === 0 ||
    IMAGE_EXTENSIONS.test(url)
  );
}


function isHtmlResponse(
  response
) {
  var contentType =
    getContentType(response);

  return (
    contentType.indexOf(
      "text/html"
    ) !== -1 ||
    contentType.indexOf(
      "application/xhtml+xml"
    ) !== -1
  );
}


/* =========================================================================
   HTML LINK DISCOVERY
   ========================================================================= */

function discoverLinks(
  html,
  pageUrl,
  institution
) {
  var linkRegex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  var found = [];
  var seen = new Set();

  var match;

  while (
    (match = linkRegex.exec(html)) !== null
  ) {
    if (
      found.length >=
      MAX_LINKS_PER_PAGE
    ) {
      break;
    }

    var href =
      (match[1] || "").trim();

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

    var anchorText =
      (match[2] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    var resolved;

    try {
      resolved =
        new URL(
          href,
          pageUrl
        ).toString();

    } catch (e) {
      continue;
    }

    var normalised =
      normaliseUrl(resolved);

    if (!normalised) {
      continue;
    }

    if (
      !isCrawlableUrl(
        normalised,
        institution
      )
    ) {
      continue;
    }

    if (seen.has(normalised)) {
      continue;
    }

    seen.add(normalised);

    var parsed;

    try {
      parsed =
        new URL(normalised);
    } catch (e) {
      continue;
    }

    var pathName =
      parsed.pathname.toLowerCase();

    var score = 0;

    PRIORITY_KEYWORDS.forEach(
      function (keyword) {
        if (
          pathName.indexOf(keyword) !== -1
        ) {
          score += 3;
        }

        if (
          anchorText.indexOf(keyword) !== -1
        ) {
          score += 2;
        }
      }
    );

    if (
      DOCUMENT_EXTENSIONS.test(pathName)
    ) {
      score += 10;
    }

    if (
      IMAGE_EXTENSIONS.test(pathName)
    ) {
      score += 6;
    }

    if (
      /bank|payment|fee|account|finance|registration/i.test(
        pathName
      )
    ) {
      score += 5;
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
   IMAGE LINK DISCOVERY (<img> tags)
   -----------------------------------------------------------------------
   Institutions sometimes publish account/bank details as a scanned
   notice or screenshot embedded via <img> rather than a linked file.
   Only images within the approved institution domain are queued, and
   only ones that look like real image files (not tracking pixels, not
   inline data URIs).
   ========================================================================= */

function discoverImageLinks(
  html,
  pageUrl,
  institution
) {
  var imgRegex =
    /<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;

  var found = [];
  var seen = new Set();

  var match;

  while (
    (match = imgRegex.exec(html)) !== null
  ) {
    if (
      found.length >=
      MAX_LINKS_PER_PAGE
    ) {
      break;
    }

    var src =
      (match[1] || "").trim();

    if (
      !src ||
      /^data:/i.test(src)
    ) {
      continue;
    }

    var resolved;

    try {
      resolved =
        new URL(
          src,
          pageUrl
        ).toString();

    } catch (e) {
      continue;
    }

    var normalised =
      normaliseUrl(resolved);

    if (!normalised) {
      continue;
    }

    if (
      !isCrawlableUrl(
        normalised,
        institution
      )
    ) {
      continue;
    }

    if (seen.has(normalised)) {
      continue;
    }

    seen.add(normalised);

    if (
      !IMAGE_EXTENSIONS.test(normalised)
    ) {
      continue;
    }

    var lower =
      normalised.toLowerCase();

    var score = 0;

    PRIORITY_KEYWORDS.forEach(
      function (keyword) {
        if (
          lower.indexOf(keyword) !== -1
        ) {
          score += 3;
        }
      }
    );

    found.push({
      url: normalised,
      score: score
    });
  }

  return found;
}


/* =========================================================================
   CANONICAL URL
   ========================================================================= */

function extractCanonicalUrl(
  html,
  pageUrl
) {
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
      new URL(
        match[1],
        pageUrl
      ).toString()
    );

  } catch (e) {
    return null;
  }
}


/* =========================================================================
   SITEMAP DISCOVERY
   ========================================================================= */

async function discoverSitemap(
  homepage,
  institution,
  startTime
) {
  if (crawlTimeExceeded(startTime)) {
    return [];
  }

  var base;

  try {
    base =
      new URL(homepage);

  } catch (e) {
    return [];
  }

  var sitemapUrl =
    base.origin +
    "/sitemap.xml";

  if (
    !isCrawlableUrl(
      sitemapUrl,
      institution
    )
  ) {
    return [];
  }

  try {
    var response =
      await fetchWithTimeout(
        sitemapUrl,
        FETCH_TIMEOUT_MS
      );

    if (!response.ok) {
      return [];
    }

    var buffer =
      await readResponseSafely(
        response
      );

    if (!buffer) {
      return [];
    }

    var xml =
      buffer.toString("utf8");

    var urls = [];
    var seen = new Set();

    var regex =
      /<loc>\s*([^<]+)\s*<\/loc>/gi;

    var match;

    while (
      (match = regex.exec(xml)) !== null
    ) {
      var url =
        normaliseUrl(
          match[1].trim()
        );

      if (!url) {
        continue;
      }

      if (
        !isCrawlableUrl(
          url,
          institution
        )
      ) {
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

function addItem(
  list,
  value,
  source,
  seenKey
) {
  if (!value) {
    return;
  }

  var key =
    String(
      seenKey || value
    )
      .trim()
      .toLowerCase();

  if (
    list._seen.has(key)
  ) {
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

function addPaymentRecord(
  list,
  record
) {
  if (
    !record ||
    !record.accountNumber
  ) {
    return;
  }

  var accountNumber =
    String(
      record.accountNumber
    ).replace(/\D/g, "");

  if (!accountNumber) {
    return;
  }

  var existing =
    list.find(function (item) {
      var rec =
        item && item.value
          ? item.value
          : item;

      return (
        rec &&
        String(
          rec.accountNumber || ""
        ).replace(/\D/g, "") ===
          accountNumber
      );
    });

  if (existing) {
    var existingRecord =
      existing.value || existing;

    if (
      !existingRecord.bankName &&
      record.bankName
    ) {
      existingRecord.bankName =
        record.bankName;
    }

    if (
      !existingRecord.accountName &&
      record.accountName
    ) {
      existingRecord.accountName =
        record.accountName;
    }

    if (
      !existingRecord.branch &&
      record.branch
    ) {
      existingRecord.branch =
        record.branch;
    }

    if (
      !existingRecord.context &&
      record.context
    ) {
      existingRecord.context =
        record.context;
    }

    if (
      !existingRecord.source &&
      record.source
    ) {
      existingRecord.source =
        record.source;
    }

    return;
  }

  list.push({
    value: record,
    source: record.source
  });
}


/* =========================================================================
   OFFICIAL JSON EVIDENCE FALLBACK
   -----------------------------------------------------------------------
   The live crawler remains the primary source.
   This loads institution-specific official evidence only as a fallback.
   ========================================================================= */

function loadEvidenceFallback(
  institution
) {
  var filePath =
    path.join(
      __dirname,
      "..",
      "data",
      "evidence",
      institution.id + ".json"
    );

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    var raw =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    var data =
      JSON.parse(raw);

    if (
      !data ||
      !Array.isArray(
        data.evidence
      )
    ) {
      return [];
    }

    return data.evidence;

  } catch (err) {
    console.error(
      "CampusVerify evidence fallback failed:",
      institution.id,
      err.message
    );

    return [];
  }
}


/* =========================================================================
   MERGE OFFICIAL JSON EVIDENCE
   -----------------------------------------------------------------------
   JSON evidence is merged into the same evidence lists used by the live
   crawler. Existing live evidence is never removed or replaced.
   ========================================================================= */

function mergeEvidenceFallback(
  itemLists,
  evidence
) {
  if (!Array.isArray(evidence)) {
    return;
  }

  evidence.forEach(function (item) {
    if (
      !item ||
      !item.type
    ) {
      return;
    }

    /* -----------------------------------------------------------------
       SOURCE RESOLUTION
       -----------------------------------------------------------------
       Supports both shapes seen across evidence files:
       - flat:   item.sourceUrl / item.source (string) / item.sourceTitle
       - nested: item.source = { title, url }  (current unilus.json shape)
       ----------------------------------------------------------------- */

    var sourceUrl =
      (item.source &&
        typeof item.source === "object" &&
        item.source.url) ||
      item.sourceUrl ||
      (typeof item.source === "string"
        ? item.source
        : "") ||
      "";

    var sourceTitle =
      (item.source &&
        typeof item.source === "object" &&
        item.source.title) ||
      item.sourceTitle ||
      "";


    /* -----------------------------------------------------------------
       FLAT SCHEMA (legacy: type "phone" / "email" / "bank")
       ----------------------------------------------------------------- */

    if (
      item.type === "phone" &&
      item.value
    ) {
      addItem(
        itemLists.phones,
        item.value,
        sourceUrl,
        item.value
      );

      return;
    }

    if (
      item.type === "email" &&
      item.value
    ) {
      addItem(
        itemLists.emails,
        item.value,
        sourceUrl,
        item.value
      );

      return;
    }

    if (
      item.type === "bank" &&
      item.value
    ) {
      addItem(
        itemLists.bankNames,
        item.value,
        sourceUrl,
        item.value
      );

      return;
    }


    /* -----------------------------------------------------------------
       CURRENT SCHEMA: type "contact"
       (unilus.json: field "general_phone" / "admissions_phone" /
        "general_email" / "admissions_email")
       ----------------------------------------------------------------- */

    if (item.type === "contact") {
      if (
        (item.field === "general_phone" ||
          item.field === "admissions_phone") &&
        item.value
      ) {
        addItem(
          itemLists.phones,
          item.value,
          sourceUrl,
          item.value
        );
      }

      if (
        (item.field === "general_email" ||
          item.field === "admissions_email") &&
        item.value
      ) {
        addItem(
          itemLists.emails,
          item.value,
          sourceUrl,
          item.value
        );
      }

      return;
    }


    /* -----------------------------------------------------------------
       PAYMENT: bank account (either schema)
       - legacy flat:  item.accountNumber / item.bankName / item.accountName
       - current:      item.account_number / item.bank / item.account_name
       ----------------------------------------------------------------- */

    if (item.type === "payment") {
      var accountNumber =
        item.accountNumber ||
        item.account_number ||
        "";

      if (accountNumber) {
        var bankName =
          item.bankName ||
          item.bank ||
          "";

        var accountName =
          item.accountName ||
          item.account_name ||
          "";

        var branch =
          item.branch || "";

        var context =
          item.context ||
          (item.swift_code
            ? "SWIFT: " + item.swift_code
            : "") ||
          (item.currency
            ? "Currency: " + item.currency
            : "");

        if (bankName) {
          addItem(
            itemLists.bankNames,
            bankName,
            sourceUrl,
            bankName
          );
        }

        addPaymentRecord(
          itemLists.paymentRecords,
          {
            accountNumber:
              accountNumber,

            publishedAccountNumber:
              accountNumber,

            bankName:
              bankName,

            accountName:
              accountName,

            branch:
              branch,

            source:
              sourceUrl,

            pageTitle:
              sourceTitle,

            context:
              context
          }
        );

        return;
      }


      /* -------------------------------------------------------------
         PAYMENT: non-account payment methods (mobile money, bill
         payment services, online portals) — these have no account
         number, so they become readable payment instructions instead.
         ------------------------------------------------------------- */

      if (
        item.field === "payment_service" &&
        item.service
      ) {
        var serviceText =
          "Pay via " +
          (item.bank || "") +
          " " +
          item.service +
          (item.university_identifier
            ? " (" +
              item.university_identifier +
              ")"
            : "");

        serviceText =
          serviceText.replace(
            /\s+/g,
            " "
          ).trim();

        addItem(
          itemLists.paymentInstructions,
          serviceText,
          sourceUrl,
          serviceText.toLowerCase()
        );

        return;
      }

      if (
        item.field === "mobile_payment" &&
        item.provider
      ) {
        var mobileText =
          "Pay via " +
          item.provider +
          (item.ussd
            ? " (" + item.ussd + ")"
            : "") +
          (item.service
            ? " - " + item.service
            : "");

        mobileText =
          mobileText.replace(
            /\s+/g,
            " "
          ).trim();

        addItem(
          itemLists.paymentInstructions,
          mobileText,
          sourceUrl,
          mobileText.toLowerCase()
        );

        return;
      }

      if (
        item.field === "online_payment" &&
        item.portal
      ) {
        var onlineText =
          "Pay online at " +
          item.portal +
          (item.method
            ? " using " + item.method
            : "");

        onlineText =
          onlineText.replace(
            /\s+/g,
            " "
          ).trim();

        addItem(
          itemLists.paymentInstructions,
          onlineText,
          sourceUrl,
          onlineText.toLowerCase()
        );

        return;
      }

      return;
    }


    /* -----------------------------------------------------------------
       PAYMENT RULE (current schema) / PAYMENT INSTRUCTION (legacy)
       ----------------------------------------------------------------- */

    if (
      item.type === "payment_rule" &&
      item.value
    ) {
      addItem(
        itemLists.paymentInstructions,
        item.value,
        sourceUrl,
        item.value.trim().toLowerCase()
      );

      return;
    }

    if (
      item.type ===
        "payment_instruction" &&
      item.value
    ) {
      addItem(
        itemLists.paymentInstructions,
        item.value,
        sourceUrl,
        item.value.trim().toLowerCase()
      );
    }
  });
}


/* =========================================================================
   EXTRACT TEXT FROM HTML
   ========================================================================= */

function htmlToText(
  html
) {
  return html
    .replace(
      /<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* =========================================================================
   PROCESS HTML
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

  var text =
    htmlToText(html);

  extractPhones(
    text
  ).forEach(function (phone) {
    addItem(
      itemLists.phones,
      phone,
      pageUrl,
      phone
    );
  });

  extractEmails(
    text
  ).forEach(function (email) {
    addItem(
      itemLists.emails,
      email,
      pageUrl,
      email
    );
  });

  extractBanks(
    text
  ).forEach(function (bank) {
    addItem(
      itemLists.bankNames,
      bank,
      pageUrl,
      bank
    );
  });

  var pageTitle =
    extractTitle(html);

  extractPaymentRecords(
    text,
    pageUrl,
    pageTitle
  ).forEach(function (record) {
    addPaymentRecord(
      itemLists.paymentRecords,
      record
    );
  });

  extractPaymentInstructions(
    text
  ).forEach(function (instruction) {
    addItem(
      itemLists.paymentInstructions,
      instruction,
      pageUrl,
      instruction
        .trim()
        .toLowerCase()
    );
  });

  var discovered =
    discoverLinks(
      html,
      pageUrl,
      institution
    );

  var imageLinks =
    discoverImageLinks(
      html,
      pageUrl,
      institution
    );

  discovered =
    discovered.concat(
      imageLinks
    );

  var canonical =
    extractCanonicalUrl(
      html,
      pageUrl
    );

  if (
    canonical &&
    isCrawlableUrl(
      canonical,
      institution
    )
  ) {
    discovered.push({
      url: canonical,
      score: 20
    });
  }

  return discovered;
}


/* =========================================================================
   BASIC DOCUMENT TEXT EXTRACTION (FALLBACK ONLY)
   ========================================================================= */

function extractPossibleDocumentText(
  buffer
) {
  if (!buffer) {
    return "";
  }

  var raw =
    buffer.toString("latin1");

  raw =
    raw
      .replace(
        /\\([()\\])/g,
        "$1"
      )
      .replace(
        /\\n/g,
        "\n"
      )
      .replace(
        /\\r/g,
        "\n"
      )
      .replace(
        /\\t/g,
        " "
      );

  var matches =
    raw.match(
      /[\x20-\x7E]{3,}/g
    ) || [];

  return matches
    .join(" ")
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* =========================================================================
   PROCESS DOCUMENT
   -----------------------------------------------------------------------
   PDFs are parsed with pdf-parse first.
   ========================================================================= */

async function processDocument(
  buffer,
  pageUrl,
  itemLists,
  isPdf
) {
  var text = "";
  var parseSuccess = false;
  var parseError = null;
  var pdfPages = null;

  if (isPdf) {
    try {
      var parsed =
        await pdfParse(buffer);

      text =
        (parsed && parsed.text) || "";

      pdfPages =
        parsed && parsed.numpages
          ? parsed.numpages
          : null;

      parseSuccess = true;

    } catch (err) {
      parseError =
        err && err.message
          ? err.message
          : String(err);

      console.error(
        "CampusVerify PDF parse failed, falling back:",
        pageUrl,
        parseError
      );

      text =
        extractPossibleDocumentText(
          buffer
        );
    }

  } else {
    text =
      extractPossibleDocumentText(
        buffer
      );
  }

  text =
    String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "\n");

  var phones =
    extractPhones(text);

  var emails =
    extractEmails(text);

  var banks =
    extractBanks(text);

  var paymentRecords =
    extractPaymentRecords(
      text,
      pageUrl,
      pageUrl.split("/").pop() ||
        "Official document"
    );

  var instructions =
    extractPaymentInstructions(text);


  phones.forEach(function (phone) {
    addItem(
      itemLists.phones,
      phone,
      pageUrl,
      phone
    );
  });


  emails.forEach(function (email) {
    addItem(
      itemLists.emails,
      email,
      pageUrl,
      email
    );
  });


  banks.forEach(function (bank) {
    addItem(
      itemLists.bankNames,
      bank,
      pageUrl,
      bank
    );
  });


  paymentRecords.forEach(
    function (record) {
      addPaymentRecord(
        itemLists.paymentRecords,
        record
      );
    }
  );


  instructions.forEach(
    function (instruction) {
      addItem(
        itemLists.paymentInstructions,
        instruction,
        pageUrl,
        instruction
          .trim()
          .toLowerCase()
      );
    }
  );


  return {
    parsed: isPdf,

    parseSuccess:
      parseSuccess,

    parseError:
      parseError,

    pdfPages:
      pdfPages,

    textLength:
      text.length,

    phonesFound:
      phones.length,

    emailsFound:
      emails.length,

    banksFound:
      banks.length,

    paymentRecordsFound:
      paymentRecords.length,

    instructionsFound:
      instructions.length
  };
}


/* =========================================================================
   PROCESS IMAGE DOCUMENT (OCR)
   -----------------------------------------------------------------------
   Handles publicly reachable JPG/PNG/etc files — e.g. a scanned notice
   or screenshot of bank details published on an official page. Uses
   tesseract.js if available; if not installed, reports ocrAvailable:false
   instead of throwing, and the JSON evidence fallback can still cover
   that item if it exists there.
   ========================================================================= */

async function processImageDocument(
  buffer,
  pageUrl,
  itemLists
) {
  var tesseract =
    loadTesseract();

  if (!tesseract) {
    return {
      parsed: false,
      ocrAvailable: false,
      ocrError: null,
      textLength: 0,
      phonesFound: 0,
      emailsFound: 0,
      banksFound: 0,
      paymentRecordsFound: 0,
      instructionsFound: 0
    };
  }

  var text = "";
  var ocrError = null;

  try {
    var result =
      await tesseract.recognize(
        buffer,
        "eng"
      );

    text =
      (result &&
        result.data &&
        result.data.text) ||
      "";

  } catch (err) {
    ocrError =
      err && err.message
        ? err.message
        : String(err);

    console.error(
      "CampusVerify OCR failed:",
      pageUrl,
      ocrError
    );
  }

  text =
    String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "\n");

  var phones =
    extractPhones(text);

  var emails =
    extractEmails(text);

  var banks =
    extractBanks(text);

  var paymentRecords =
    extractPaymentRecords(
      text,
      pageUrl,
      pageUrl.split("/").pop() ||
        "Official image document"
    );

  var instructions =
    extractPaymentInstructions(text);


  phones.forEach(function (phone) {
    addItem(
      itemLists.phones,
      phone,
      pageUrl,
      phone
    );
  });

  emails.forEach(function (email) {
    addItem(
      itemLists.emails,
      email,
      pageUrl,
      email
    );
  });

  banks.forEach(function (bank) {
    addItem(
      itemLists.bankNames,
      bank,
      pageUrl,
      bank
    );
  });

  paymentRecords.forEach(
    function (record) {
      addPaymentRecord(
        itemLists.paymentRecords,
        record
      );
    }
  );

  instructions.forEach(
    function (instruction) {
      addItem(
        itemLists.paymentInstructions,
        instruction,
        pageUrl,
        instruction
          .trim()
          .toLowerCase()
      );
    }
  );

  return {
    parsed: true,
    ocrAvailable: true,
    ocrError: ocrError,
    textLength: text.length,
    phonesFound: phones.length,
    emailsFound: emails.length,
    banksFound: banks.length,
    paymentRecordsFound:
      paymentRecords.length,
    instructionsFound:
      instructions.length
  };
}


/* =========================================================================
   FETCH + PROCESS ONE URL
   ========================================================================= */

async function fetchPage(
  url,
  institution,
  itemLists,
  pageStatus
) {
  try {
    var parsed =
      new URL(url);

    if (
      !isSameInstitutionHost(
        parsed.hostname,
        institution.domain
      )
    ) {
      return [];
    }

    if (
      EXCLUDED_PATH_PATTERNS.test(
        parsed.pathname
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
      await readResponseSafely(
        response
      );

    if (!buffer) {
      pageStatus.push({
        url: url,
        status: "too_large"
      });

      return [];
    }

    var contentType =
      getContentType(response);

    if (
      isPdfResponse(
        response,
        url
      ) ||
      DOCUMENT_EXTENSIONS.test(
        parsed.pathname
      )
    ) {
      var documentResult =
        await processDocument(
          buffer,
          url,
          itemLists,
          isPdfResponse(
            response,
            url
          )
        );

      pageStatus.push({
        url: url,
        status: "ok",
        type: "document",
        contentType: contentType,

        isPdf:
          documentResult.parsed,

        pdfParsed:
          documentResult.parseSuccess,

        pdfPages:
          documentResult.pdfPages,

        textLength:
          documentResult.textLength,

        phonesFound:
          documentResult.phonesFound,

        emailsFound:
          documentResult.emailsFound,

        banksFound:
          documentResult.banksFound,

        paymentRecordsFound:
          documentResult.paymentRecordsFound,

        instructionsFound:
          documentResult.instructionsFound,

        parseError:
          documentResult.parseError
      });

      return [];
    }

    if (
      isImageResponse(
        response,
        url
      ) ||
      IMAGE_EXTENSIONS.test(
        parsed.pathname
      )
    ) {
      var imageResult =
        await processImageDocument(
          buffer,
          url,
          itemLists
        );

      pageStatus.push({
        url: url,
        status: "ok",
        type: "image",
        contentType: contentType,

        ocrAvailable:
          imageResult.ocrAvailable,

        ocrError:
          imageResult.ocrError,

        textLength:
          imageResult.textLength,

        phonesFound:
          imageResult.phonesFound,

        emailsFound:
          imageResult.emailsFound,

        banksFound:
          imageResult.banksFound,

        paymentRecordsFound:
          imageResult.paymentRecordsFound,

        instructionsFound:
          imageResult.instructionsFound
      });

      return [];
    }

    if (
      !isHtmlResponse(
        response
      )
    ) {
      pageStatus.push({
        url: url,
        status: "skipped",
        type: "non-html",
        contentType: contentType
      });

      return [];
    }

    var html =
      buffer.toString(
        "utf8"
      );

    var jsRendered = false;

    var initialTextLength =
      htmlToText(html).length;

    if (
      initialTextLength <
      JS_RENDER_MIN_TEXT_LENGTH
    ) {
      var renderedHtml =
        await renderWithHeadlessBrowser(
          url
        );

      if (
        renderedHtml &&
        htmlToText(renderedHtml)
          .length > initialTextLength
      ) {
        html = renderedHtml;
        jsRendered = true;
      }
    }

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
      jsRendered: jsRendered,
      linksDiscovered:
        discovered.length
    });

    return discovered;

  } catch (err) {
    var timedOut =
      err &&
      err.name === "AbortError";

    console.error(
      "CampusVerify crawler error:",
      url,
      err &&
        err.message
    );

    pageStatus.push({
      url: url,
      status: timedOut
        ? "timeout"
        : "unreachable"
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

  Object.keys(
    lists
  ).forEach(function (key) {
    lists[key]._seen =
      new Set();
  });

  return lists;
}


/* =========================================================================
   CRAWL ENGINE
   ========================================================================= */

async function crawlInstitution(
  institution,
  homepage,
  startTime
) {
  var itemLists =
    createItemLists();

  var pageStatus = [];

  var queue = [];

  var discovered =
    new Set();

  var visited =
    new Set();


  /* -----------------------------------------------------------------------
     LOAD OFFICIAL FALLBACK EVIDENCE
     ----------------------------------------------------------------------- */

  var fallbackEvidence =
    loadEvidenceFallback(
      institution
    );


  /* -----------------------------------------------------------------------
     QUEUE
     ----------------------------------------------------------------------- */

  function enqueue(
    url,
    depth,
    score
  ) {
    if (!url) {
      return;
    }

    if (
      depth >
      MAX_CRAWL_DEPTH
    ) {
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

    if (
      discovered.has(
        normalised
      )
    ) {
      return;
    }

    if (
      visited.has(
        normalised
      )
    ) {
      return;
    }

    discovered.add(
      normalised
    );

    queue.push({
      url: normalised,
      depth: depth,
      score: score || 0
    });

    queue.sort(function (a, b) {
      if (
        b.score !== a.score
      ) {
        return (
          b.score -
          a.score
        );
      }

      return (
        a.depth -
        b.depth
      );
    });
  }


  /* -----------------------------------------------------------------------
     INITIAL PAGE
     ----------------------------------------------------------------------- */

  enqueue(
    homepage,
    0,
    1000
  );


  /* -----------------------------------------------------------------------
     CONFIGURED SEEDS
     ----------------------------------------------------------------------- */

  (
    institution.seedPages ||
    []
  ).forEach(function (url) {
    enqueue(
      url,
      0,
      900
    );
  });


  /* -----------------------------------------------------------------------
     INSTITUTION SITEMAP
     ----------------------------------------------------------------------- */

  var sitemapUrls =
    await discoverSitemap(
      homepage,
      institution,
      startTime
    );

  sitemapUrls.forEach(
    function (item) {
      enqueue(
        item.url,
        0,
        item.score
      );
    }
  );


  /* -----------------------------------------------------------------------
     MAIN LOOP
     ----------------------------------------------------------------------- */

  while (
    queue.length > 0 &&
    visited.size <
      MAX_PAGES_PER_INSTITUTION &&
    !crawlTimeExceeded(
      startTime
    )
  ) {
    var current =
      queue.shift();

    if (!current) {
      break;
    }

    if (
      visited.has(
        current.url
      )
    ) {
      continue;
    }

    visited.add(
      current.url
    );

    var newLinks =
      await fetchPage(
        current.url,
        institution,
        itemLists,
        pageStatus
      );

    newLinks.forEach(
      function (item) {
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
      }
    );
  }


  /* -----------------------------------------------------------------------
     MERGE OFFICIAL FALLBACK EVIDENCE
     ----------------------------------------------------------------------- */

  mergeEvidenceFallback(
    itemLists,
    fallbackEvidence
  );


  /* -----------------------------------------------------------------------
     STATS
     ----------------------------------------------------------------------- */

  var timeLimitReached =
    crawlTimeExceeded(
      startTime
    );

  var pageLimitReached =
    visited.size >=
    MAX_PAGES_PER_INSTITUTION;

  var pendingLinks =
    queue.length;

  var successfulPages =
    pageStatus.filter(
      function (item) {
        return (
          item.status ===
          "ok"
        );
      }
    );

  var successfulSources =
    successfulPages.map(
      function (item) {
        return item.url;
      }
    );


  var crawlEndedNaturally =
    !timeLimitReached &&
    !pageLimitReached &&
    pendingLinks === 0;


  var failedPages =
    pageStatus.filter(
      function (item) {
        return (
          item.status ===
            "unreachable" ||
          item.status ===
            "timeout" ||
          item.status ===
            "too_large"
        );
      }
    );


  var dataComplete =
    crawlEndedNaturally &&
    failedPages.length === 0;


  var crawlFailed =
    successfulPages.length === 0;


  return {
    items: itemLists,

    pagesCrawled:
      pageStatus,

    sources:
      successfulSources,

    crawlStats: {
      pagesVisited:
        visited.size,

      pagesSuccessful:
        successfulPages.length,

      pagesFailed:
        failedPages.length,

      pagesPending:
        pendingLinks,

      maxPages:
        MAX_PAGES_PER_INSTITUTION,

      maxDepth:
        MAX_CRAWL_DEPTH,

      maxTimeMs:
        MAX_CRAWL_TIME_MS,

      timeLimitReached:
        timeLimitReached,

      pageLimitReached:
        pageLimitReached,

      crawlEndedNaturally:
        crawlEndedNaturally,

      dataComplete:
        dataComplete
    },

    dataComplete:
      dataComplete,

    crawlFailed:
      crawlFailed
  };
}


/* =========================================================================
   API HANDLER
   ========================================================================= */

module.exports =
  async function handler(
    req,
    res
  ) {
    var institutionId =
      req.query.institution;

    if (!institutionId) {
      return res.status(400).json({
        error:
          "Missing institution id"
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


    var homepage =
      institution.homepage ||
      ("https://" +
      institution.domain +
      "/");


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

        officialUrl:
          homepage,

        items:
          result.items,

        sources:
          result.sources,

        pagesCrawled:
          result.pagesCrawled,

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

        officialUrl:
          homepage,

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

          maxPages:
            MAX_PAGES_PER_INSTITUTION,

          maxDepth:
            MAX_CRAWL_DEPTH,

          maxTimeMs:
            MAX_CRAWL_TIME_MS,

          timeLimitReached: false,

          pageLimitReached: false,

          crawlEndedNaturally: false,

          dataComplete: false
        },

        dataComplete:
          false,

        crawlFailed:
          true,

        checkedAt:
          new Date().toISOString()
      });
    }
  };
