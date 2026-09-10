/* =========================================================================
   CampusVerify — api/crawler.js
   -----------------------------------------------------------------------
   General institutional website crawler

   PRIMARY:
   - Crawl the institution's official public website.
   - Discover HTML pages, PDFs, documents and images.
   - Extract phones, emails, banks, payment records and instructions.

   FALLBACK:
   - Load data/evidence/<institutionId>.json after crawling.
   - JSON evidence fills gaps when the live crawler cannot recover an
     officially published item.
   - Live crawler evidence is never removed or replaced.

   IMPORTANT:
   - Never search Google or the wider internet.
   - Never log in or bypass authentication.
   - Never claim missing information means fraud.
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

const JS_RENDER_MIN_TEXT_LENGTH = 200;
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
  return Date.now() - startTime >= MAX_CRAWL_TIME_MS;
}


/* =========================================================================
   OPTIONAL OCR
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


/* =========================================================================
   OPTIONAL HEADLESS BROWSER
   ========================================================================= */

var _puppeteerModule = null;
var _chromiumModule = null;
var _browserLoadAttempted = false;

function loadHeadlessBrowser() {
  if (_browserLoadAttempted) {
    return _puppeteerModule
      ? {
          puppeteer: _puppeteerModule,
          chromium: _chromiumModule
        }
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
      "CampusVerify: puppeteer-core not installed, JS rendering disabled:",
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

function isCrawlableUrl(url, institution) {
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
          "CampusVerify-Crawler/5.0 (+official institutional verification)"
      }
    });

  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================================
   HEADLESS RENDER
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
        executablePath:
          await chromium.executablePath(),
        headless: true
      };
    } else {
      launchOptions = {
        headless: true
      };
    }

    browser =
      await puppeteer.launch(
        launchOptions
      );

    var page =
      await browser.newPage();

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

    return await page.content();

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

async function readResponseSafely(response) {
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

function getContentType(response) {
  return (
    response.headers.get(
      "content-type"
    ) || ""
  ).toLowerCase();
}

function isPdfResponse(response, url) {
  var contentType =
    getContentType(response);

  return (
    contentType.indexOf(
      "application/pdf"
    ) !== -1 ||
    /\.pdf(?:$|\?)/i.test(url)
  );
}

function isImageResponse(response, url) {
  var contentType =
    getContentType(response);

  return (
    contentType.indexOf("image/") === 0 ||
    IMAGE_EXTENSIONS.test(url)
  );
}

function isHtmlResponse(response) {
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
        .replace(
          /<[^>]+>/g,
          " "
        )
        .replace(
          /\s+/g,
          " "
        )
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
      DOCUMENT_EXTENSIONS.test(
        pathName
      )
    ) {
      score += 10;
    }

    if (
      IMAGE_EXTENSIONS.test(
        pathName
      )
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
   IMAGE LINK DISCOVERY
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
      !IMAGE_EXTENSIONS.test(
        normalised
      )
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
   EMBEDDED DOCUMENT DISCOVERY
   -----------------------------------------------------------------------
   Finds PDFs/documents referenced by iframe/object/embed elements.
   ========================================================================= */

function discoverEmbeddedDocuments(
  html,
  pageUrl,
  institution
) {
  var found = [];
  var seen = new Set();

  var patterns = [
    /<iframe\b[^>]*src\s*=\s*["']([^"']+)["']/gi,
    /<object\b[^>]*data\s*=\s*["']([^"']+)["']/gi,
    /<embed\b[^>]*src\s*=\s*["']([^"']+)["']/gi
  ];

  patterns.forEach(function (regex) {
    var match;

    while (
      (match = regex.exec(html)) !== null
    ) {
      var src =
        (match[1] || "").trim();

      if (!src) {
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

      if (
        seen.has(normalised)
      ) {
        continue;
      }

      seen.add(normalised);

      var lower =
        normalised.toLowerCase();

      if (
        DOCUMENT_EXTENSIONS.test(
          lower
        ) ||
        lower.indexOf("pdf") !== -1
      ) {
        found.push({
          url: normalised,
          score: 15
        });
      }
    }
  });

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
  if (
    crawlTimeExceeded(
      startTime
    )
  ) {
    return [];
  }

  var base;

  try {
    base =
      new URL(homepage);
  } catch (e) {
    return [];
  }

  var sitemapCandidates = [
    base.origin + "/sitemap.xml",
    base.origin + "/sitemap_index.xml"
  ];

  var urls = [];
  var seen = new Set();

  for (
    var s = 0;
    s < sitemapCandidates.length;
    s++
  ) {
    if (
      crawlTimeExceeded(
        startTime
      )
    ) {
      break;
    }

    var sitemapUrl =
      sitemapCandidates[s];

    if (
      !isCrawlableUrl(
        sitemapUrl,
        institution
      )
    ) {
      continue;
    }

    try {
      var response =
        await fetchWithTimeout(
          sitemapUrl,
          FETCH_TIMEOUT_MS
        );

      if (!response.ok) {
        continue;
      }

      var buffer =
        await readResponseSafely(
          response
        );

      if (!buffer) {
        continue;
      }

      var xml =
        buffer.toString("utf8");

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

        if (
          seen.has(url)
        ) {
          continue;
        }

        seen.add(url);

        urls.push({
          url: url,
          score: 40
        });

        if (
          urls.length >=
          1000
        ) {
          break;
        }
      }

    } catch (err) {
      continue;
    }
  }

  return urls;
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
   OFFICIAL JSON FALLBACK
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
    if (
      !fs.existsSync(
        filePath
      )
    ) {
      console.error(
        "CampusVerify: evidence file not found:",
        filePath
      );

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
      console.error(
        "CampusVerify: invalid evidence file:",
        filePath
      );

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
   IMPORTANT:
   Supports ALL contact field names used in unilus.json.
   ========================================================================= */

function mergeEvidenceFallback(
  itemLists,
  evidence
) {
  var fallbackStats = {
    totalEvidenceItems: 0,
    phonesAdded: 0,
    emailsAdded: 0,
    banksAdded: 0,
    paymentRecordsAdded: 0,
    paymentInstructionsAdded: 0
  };

  if (!Array.isArray(evidence)) {
    return fallbackStats;
  }

  evidence.forEach(function (item) {
    if (
      !item ||
      !item.type
    ) {
      return;
    }

    fallbackStats.totalEvidenceItems++;

    var sourceUrl =
      (
        item.source &&
        typeof item.source === "object" &&
        item.source.url
      ) ||
      item.sourceUrl ||
      (
        typeof item.source === "string"
          ? item.source
          : ""
      ) ||
      "";

    var sourceTitle =
      (
        item.source &&
        typeof item.source === "object" &&
        item.source.title
      ) ||
      item.sourceTitle ||
      "";


    /* -----------------------------------------------------------------
       PHONE
       ----------------------------------------------------------------- */

    if (
      item.type === "phone" &&
      item.value
    ) {
      var beforePhone =
        itemLists.phones.length;

      addItem(
        itemLists.phones,
        item.value,
        sourceUrl,
        item.value
      );

      if (
        itemLists.phones.length >
        beforePhone
      ) {
        fallbackStats.phonesAdded++;
      }

      return;
    }


    /* -----------------------------------------------------------------
       EMAIL
       ----------------------------------------------------------------- */

    if (
      item.type === "email" &&
      item.value
    ) {
      var beforeEmail =
        itemLists.emails.length;

      addItem(
        itemLists.emails,
        item.value,
        sourceUrl,
        item.value
      );

      if (
        itemLists.emails.length >
        beforeEmail
      ) {
        fallbackStats.emailsAdded++;
      }

      return;
    }


    /* -----------------------------------------------------------------
       BANK NAME
       ----------------------------------------------------------------- */

    if (
      item.type === "bank" &&
      item.value
    ) {
      var beforeBank =
        itemLists.bankNames.length;

      addItem(
        itemLists.bankNames,
        item.value,
        sourceUrl,
        item.value
      );

      if (
        itemLists.bankNames.length >
        beforeBank
      ) {
        fallbackStats.banksAdded++;
      }

      return;
    }


    /* -----------------------------------------------------------------
       CONTACT
       -----------------------------------------------------------------
       Accept any *_phone or *_email field.
       This allows:
       general_phone
       admissions_phone
       accounts_phone
       general_email
       admissions_email
       accounts_email
       accommodation_email
       international_email
       ict_email
       administration_email
       registrar_email
       accountant_email
       etc.
       ----------------------------------------------------------------- */

    if (
      item.type === "contact"
    ) {
      var field =
        String(
          item.field || ""
        ).toLowerCase();

      if (
        item.value &&
        (
          field.indexOf("phone") !== -1 ||
          field.indexOf("telephone") !== -1 ||
          field.indexOf("mobile") !== -1
        )
      ) {
        var beforeContactPhone =
          itemLists.phones.length;

        addItem(
          itemLists.phones,
          item.value,
          sourceUrl,
          item.value
        );

        if (
          itemLists.phones.length >
          beforeContactPhone
        ) {
          fallbackStats.phonesAdded++;
        }
      }

      if (
        item.value &&
        field.indexOf("email") !== -1
      ) {
        var beforeContactEmail =
          itemLists.emails.length;

        addItem(
          itemLists.emails,
          item.value,
          sourceUrl,
          item.value
        );

        if (
          itemLists.emails.length >
          beforeContactEmail
        ) {
          fallbackStats.emailsAdded++;
        }
      }

      return;
    }


    /* -----------------------------------------------------------------
       PAYMENT
       ----------------------------------------------------------------- */

    if (
      item.type === "payment"
    ) {
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
          item.branch ||
          "";

        var context =
          item.context ||
          (
            item.swift_code
              ? "SWIFT: " +
                item.swift_code
              : ""
          ) ||
          (
            item.currency
              ? "Currency: " +
                item.currency
              : ""
          );

        if (bankName) {
          var beforePaymentBank =
            itemLists.bankNames.length;

          addItem(
            itemLists.bankNames,
            bankName,
            sourceUrl,
            bankName
          );

          if (
            itemLists.bankNames.length >
            beforePaymentBank
          ) {
            fallbackStats.banksAdded++;
          }
        }

        var beforePayment =
          itemLists.paymentRecords.length;

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

        if (
          itemLists.paymentRecords.length >
          beforePayment
        ) {
          fallbackStats.paymentRecordsAdded++;
        }

        return;
      }


      /* -------------------------------------------------------------
         PAYMENT SERVICE
         ------------------------------------------------------------- */

      if (
        item.field ===
          "payment_service" &&
        item.service
      ) {
        var serviceText =
          "Pay via " +
          (item.bank || "") +
          " " +
          item.service +
          (
            item.university_identifier
              ? " (" +
                item.university_identifier +
                ")"
              : ""
          );

        serviceText =
          serviceText
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        var beforeService =
          itemLists.paymentInstructions.length;

        addItem(
          itemLists.paymentInstructions,
          serviceText,
          sourceUrl,
          serviceText.toLowerCase()
        );

        if (
          itemLists.paymentInstructions.length >
          beforeService
        ) {
          fallbackStats.paymentInstructionsAdded++;
        }

        return;
      }


      /* -------------------------------------------------------------
         MOBILE PAYMENT
         ------------------------------------------------------------- */

      if (
        item.field ===
          "mobile_payment" &&
        item.provider
      ) {
        var mobileText =
          "Pay via " +
          item.provider +
          (
            item.ussd
              ? " (" +
                item.ussd +
                ")"
              : ""
          ) +
          (
            item.service
              ? " - " +
                item.service
              : ""
          );

        mobileText =
          mobileText
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        var beforeMobile =
          itemLists.paymentInstructions.length;

        addItem(
          itemLists.paymentInstructions,
          mobileText,
          sourceUrl,
          mobileText.toLowerCase()
        );

        if (
          itemLists.paymentInstructions.length >
          beforeMobile
        ) {
          fallbackStats.paymentInstructionsAdded++;
        }

        return;
      }


      /* -------------------------------------------------------------
         ONLINE PAYMENT
         ------------------------------------------------------------- */

      if (
        item.field ===
          "online_payment" &&
        item.portal
      ) {
        var onlineText =
          "Pay online at " +
          item.portal +
          (
            item.method
              ? " using " +
                item.method
              : ""
          );

        onlineText =
          onlineText
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        var beforeOnline =
          itemLists.paymentInstructions.length;

        addItem(
          itemLists.paymentInstructions,
          onlineText,
          sourceUrl,
          onlineText.toLowerCase()
        );

        if (
          itemLists.paymentInstructions.length >
          beforeOnline
        ) {
          fallbackStats.paymentInstructionsAdded++;
        }

        return;
      }

      return;
    }


    /* -----------------------------------------------------------------
       PAYMENT RULE
       ----------------------------------------------------------------- */

    if (
      item.type === "payment_rule" &&
      item.value
    ) {
      var beforeRule =
        itemLists.paymentInstructions.length;

      addItem(
        itemLists.paymentInstructions,
        item.value,
        sourceUrl,
        item.value
          .trim()
          .toLowerCase()
      );

      if (
        itemLists.paymentInstructions.length >
        beforeRule
      ) {
        fallbackStats.paymentInstructionsAdded++;
      }

      return;
    }


    /* -----------------------------------------------------------------
       PAYMENT INSTRUCTION
       ----------------------------------------------------------------- */

    if (
      item.type ===
        "payment_instruction" &&
      item.value
    ) {
      var beforeInstruction =
        itemLists.paymentInstructions.length;

      addItem(
        itemLists.paymentInstructions,
        item.value,
        sourceUrl,
        item.value
          .trim()
          .toLowerCase()
      );

      if (
        itemLists.paymentInstructions.length >
        beforeInstruction
      ) {
        fallbackStats.paymentInstructionsAdded++;
      }
    }
  });

  return fallbackStats;
}


/* =========================================================================
   HTML → TEXT
   ========================================================================= */

function htmlToText(html) {
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
   -----------------------------------------------------------------------
   IMPORTANT FIX:
   extractPaymentRecords() receives ORIGINAL HTML, not flattened text.
   This allows patterns.js to use its table parser.
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


  /* ---------------------------------------------------------------
     FIXED:
     Pass HTML rather than text.
     --------------------------------------------------------------- */

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

  var embeddedDocuments =
    discoverEmbeddedDocuments(
      html,
      pageUrl,
      institution
    );

  discovered =
    discovered
      .concat(imageLinks)
      .concat(embeddedDocuments);


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
   BASIC DOCUMENT TEXT EXTRACTION
   ========================================================================= */

function extractPossibleDocumentText(
  buffer
) {
  if (!buffer) {
    return "";
  }

  var raw =
    buffer.toString(
      "latin1"
    );

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
        parsed &&
        parsed.numpages
          ? parsed.numpages
          : null;

      parseSuccess = true;

    } catch (err) {
      parseError =
        err && err.message
          ? err.message
          : String(err);

      console.error(
        "CampusVerify PDF parse failed, using fallback extraction:",
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
      .replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /\r/g,
        "\n"
      );

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
    extractPaymentInstructions(
      text
    );


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
   PROCESS IMAGE DOCUMENT
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
      (
        result &&
        result.data &&
        result.data.text
      ) || "";

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
      .replace(
        /\u00a0/g,
        " "
      )
      .replace(
        /\r/g,
        "\n"
      );

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
    extractPaymentInstructions(
      text
    );


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
        httpStatus:
          response.status
      });

      return [];
    }


    /* ---------------------------------------------------------------
       Make sure a redirect did not leave the approved institution host.
       --------------------------------------------------------------- */

    try {
      var finalUrl =
        response.url || url;

      var finalParsed =
        new URL(finalUrl);

      if (
        !isSameInstitutionHost(
          finalParsed.hostname,
          institution.domain
        )
      ) {
        pageStatus.push({
          url: url,
          status: "redirected_external",
          finalUrl: finalUrl
        });

        return [];
      }
    } catch (e) {}


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


    /* ---------------------------------------------------------------
       PDF / DOCUMENT
       --------------------------------------------------------------- */

    if (
      isPdfResponse(
        response,
        url
      ) ||
      (
        DOCUMENT_EXTENSIONS.test(
          parsed.pathname
        ) &&
        !isHtmlResponse(
          response
        )
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
        contentType:
          contentType,
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


    /* ---------------------------------------------------------------
       IMAGE
       --------------------------------------------------------------- */

    if (
      isImageResponse(
        response,
        url
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
        contentType:
          contentType,
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


    /* ---------------------------------------------------------------
       NON HTML
       --------------------------------------------------------------- */

    if (
      !isHtmlResponse(
        response
      )
    ) {
      pageStatus.push({
        url: url,
        status: "skipped",
        type: "non-html",
        contentType:
          contentType
      });

      return [];
    }


    /* ---------------------------------------------------------------
       HTML
       --------------------------------------------------------------- */

    var html =
      buffer.toString(
        "utf8"
      );

    var jsRendered = false;

    var initialTextLength =
      htmlToText(
        html
      ).length;

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
        htmlToText(
          renderedHtml
        ).length >
          initialTextLength
      ) {
        html =
          renderedHtml;

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
      contentType:
        contentType,
      jsRendered:
        jsRendered,
      linksDiscovered:
        discovered.length
    });

    return discovered;

  } catch (err) {
    var timedOut =
      err &&
      err.name ===
        "AbortError";

    console.error(
      "CampusVerify crawler error:",
      url,
      err &&
        err.message
    );

    pageStatus.push({
      url: url,
      status:
        timedOut
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
     LOAD JSON FALLBACK
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
      url:
        normalised,
      depth:
        depth,
      score:
        score || 0
    });

    queue.sort(
      function (a, b) {
        if (
          b.score !==
          a.score
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
      }
    );
  }


  /* -----------------------------------------------------------------------
     HOMEPAGE
     ----------------------------------------------------------------------- */

  enqueue(
    homepage,
    0,
    1000
  );


  /* -----------------------------------------------------------------------
     SEED PAGES
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
     SITEMAP
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
     MAIN CRAWL
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
     JSON FALLBACK
     ----------------------------------------------------------------------- */

  var fallbackStats =
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
    items:
      itemLists,

    pagesCrawled:
      pageStatus,

    sources:
      successfulSources,

    fallbackStats:
      fallbackStats,

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
        dataComplete,

      fallbackEvidenceItems:
        fallbackStats.totalEvidenceItems,

      fallbackPhonesAdded:
        fallbackStats.phonesAdded,

      fallbackEmailsAdded:
        fallbackStats.emailsAdded,

      fallbackBanksAdded:
        fallbackStats.banksAdded,

      fallbackPaymentRecordsAdded:
        fallbackStats.paymentRecordsAdded,

      fallbackPaymentInstructionsAdded:
        fallbackStats.paymentInstructionsAdded
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
      (
        "https://" +
        institution.domain +
        "/"
      );

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

        fallbackStats:
          result.fallbackStats,

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

        fallbackStats: {
          totalEvidenceItems: 0,
          phonesAdded: 0,
          emailsAdded: 0,
          banksAdded: 0,
          paymentRecordsAdded: 0,
          paymentInstructionsAdded: 0
        },

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

          timeLimitReached:
            false,

          pageLimitReached:
            false,

          crawlEndedNaturally:
            false,

          dataComplete:
            false
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
