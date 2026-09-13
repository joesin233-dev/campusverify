/* =========================================================================
   CampusVerify — api/crawler.js v7.0 FAST
   -------------------------------------------------------------------------
   JSON evidence FIRST.
   Live fallback = maximum 5 official pages.
   No sitemap crawling.
   No Puppeteer.
   No OCR.
   No deep crawl.
   ========================================================================= */

const { getInstitutionById, isSameInstitutionHost } = require("../institutions.js");

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

/* ========================================================================
   FAST SETTINGS
   ======================================================================== */

const FETCH_TIMEOUT_MS = 3000;
const MAX_LIVE_PAGES = 5;
const MAX_CRAWL_TIME_MS = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LINKS_PER_PAGE = 80;

const PRIORITY_KEYWORDS = [
  "contact",
  "contacts",
  "admission",
  "admissions",
  "student",
  "students",
  "accounts",
  "account",
  "finance",
  "fees",
  "fee",
  "payment",
  "payments",
  "bank",
  "banking",
  "bank-details",
  "registration",
  "notice",
  "notices",
  "announcement",
  "announcements",
  "prospectus",
  "download",
  "document",
  "documents",
  "pdf",
  "tuition",
  "school-fees",
  "accounts-office",
  "bursar",
  "cashier"
];

const EXCLUDED_PATHS =
  /\/(?:login|signin|sign-in|logon|authenticate|authentication|admin|wp-admin|cpanel|dashboard|logout)(?:\/|$)/i;

const DOCUMENT_EXTENSIONS =
  /\.(pdf|txt|csv|doc|docx|xls|xlsx)$/i;

/* ========================================================================
   BASIC HELPERS
   ======================================================================== */

function crawlTimeExceeded(startTime) {
  return Date.now() - startTime >= MAX_CRAWL_TIME_MS;
}

function safeText(value) {
  return value === null || value === undefined
    ? ""
    : String(value);
}

function normaliseTextValue(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseAccountNumber(value) {
  return safeText(value).replace(/\D/g, "");
}

function normaliseUrl(value) {
  try {
    const url = new URL(value);

    url.hash = "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid"
    ].forEach((key) => {
      url.searchParams.delete(key);
    });

    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function isCrawlableUrl(url, institution) {
  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return false;
    }

    if (!isSameInstitutionHost(
      parsed.hostname,
      institution
    )) {
      return false;
    }

    if (
      EXCLUDED_PATHS.test(
        parsed.pathname
      )
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/* ========================================================================
   FETCH
   ======================================================================== */

async function fetchWithTimeout(
  url,
  timeout = FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "CampusVerify/7.0 Official-Site-Verifier",
        "Accept":
          "text/html,application/xhtml+xml,application/pdf,text/plain,*/*"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseSafely(response) {
  const length =
    Number(
      response.headers.get(
        "content-length"
      ) || 0
    );

  if (
    length &&
    length > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "response_too_large"
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (
    buffer.length >
    MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "response_too_large"
    );
  }

  return buffer;
}

function isPdf(response, url) {
  const type =
    safeText(
      response.headers.get(
        "content-type"
      )
    ).toLowerCase();

  return (
    type.includes("application/pdf") ||
    /\.pdf(?:$|\?)/i.test(url)
  );
}

function isHtml(response, url) {
  const type =
    safeText(
      response.headers.get(
        "content-type"
      )
    ).toLowerCase();

  return (
    type.includes("text/html") ||
    type.includes("application/xhtml") ||
    (!type &&
      !DOCUMENT_EXTENSIONS.test(url))
  );
}

/* ========================================================================
   ITEM HELPERS
   ======================================================================== */

function addItem(list, value, source) {
  if (!value) {
    return;
  }

  const clean =
    safeText(value).trim();

  if (!clean) {
    return;
  }

  const key =
    normaliseTextValue(clean);

  if (
    !list.some(
      (item) =>
        normaliseTextValue(
          item && item.value
        ) === key
    )
  ) {
    list.push({
      value: clean,
      source: source || null
    });
  }
}

function addPaymentRecord(
  list,
  record,
  source
) {
  if (!record) {
    return;
  }

  const accountNumber =
    normaliseAccountNumber(
      record.accountNumber ||
      record.publishedAccountNumber ||
      ""
    );

  if (!accountNumber) {
    return;
  }

  const existing =
    list.find(
      (item) => {
        const r =
          item && item.value
            ? item.value
            : item;

        return (
          normaliseAccountNumber(
            r &&
              (
                r.accountNumber ||
                r.publishedAccountNumber
              )
          ) === accountNumber
        );
      }
    );

  const cleaned = {
    accountNumber:
      accountNumber,

    publishedAccountNumber:
      accountNumber,

    bankName:
      safeText(
        record.bankName
      ).trim(),

    accountName:
      safeText(
        record.accountName
      ).trim(),

    branch:
      safeText(
        record.branch
      ).trim(),

    context:
      safeText(
        record.context
      ).trim(),

    pageTitle:
      safeText(
        record.pageTitle
      ).trim(),

    source:
      record.source ||
      source ||
      null,

    evidenceSource:
      record.evidenceSource ||
      "official_source"
  };

  if (!existing) {
    list.push({
      value: cleaned,
      source:
        cleaned.source
    });

    return;
  }

  const old =
    existing.value || existing;

  [
    "bankName",
    "accountName",
    "branch",
    "context",
    "pageTitle",
    "source"
  ].forEach((field) => {
    if (
      !old[field] &&
      cleaned[field]
    ) {
      old[field] =
        cleaned[field];
    }
  });
}

/* ========================================================================
   HTML TEXT
   ======================================================================== */

function htmlToText(html) {
  return safeText(html)
    .replace(
      /<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi,
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

/* ========================================================================
   LINK DISCOVERY
   ======================================================================== */

function scoreUrl(url, anchorText) {
  const combined =
    (
      safeText(url) +
      " " +
      safeText(anchorText)
    ).toLowerCase();

  let score = 0;

  PRIORITY_KEYWORDS.forEach(
    (keyword) => {
      if (
        combined.includes(keyword)
      ) {
        score += 10;
      }
    }
  );

  if (
    DOCUMENT_EXTENSIONS.test(url)
  ) {
    score += 15;
  }

  if (
    /payment|bank|fee|account/i.test(
      combined
    )
  ) {
    score += 25;
  }

  if (
    /contact|admission|finance/i.test(
      combined
    )
  ) {
    score += 20;
  }

  return score;
}

function discoverLinks(
  html,
  baseUrl,
  institution
) {
  const results = [];
  const seen = new Set();

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match = regex.exec(html)) &&
    results.length <
      MAX_LINKS_PER_PAGE
  ) {
    const href =
      safeText(match[1]).trim();

    const anchorText =
      htmlToText(
        match[2]
      ).slice(0, 300);

    if (
      !href ||
      href.startsWith("#") ||
      /^javascript:/i.test(href) ||
      /^mailto:/i.test(href) ||
      /^tel:/i.test(href)
    ) {
      continue;
    }

    let absolute;

    try {
      absolute =
        new URL(
          href,
          baseUrl
        ).toString();
    } catch {
      continue;
    }

    const normalised =
      normaliseUrl(
        absolute
      );

    if (
      !normalised ||
      seen.has(normalised)
    ) {
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

    seen.add(normalised);

    results.push({
      url: normalised,
      score:
        scoreUrl(
          normalised,
          anchorText
        )
    });
  }

  return results.sort(
    (a, b) =>
      b.score - a.score
  );
}

/* ========================================================================
   JSON EVIDENCE
   ======================================================================== */

function createItemLists() {
  return {
    phones: [],
    emails: [],
    bankNames: [],
    paymentRecords: [],
    paymentInstructions: []
  };
}

function loadEvidenceFallback(
  institution
) {
  const empty = {
    exists: false,
    valid: false,
    data: null,
    error: null
  };

  if (!institution) {
    return empty;
  }

  const filePath =
    path.join(
      process.cwd(),
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
      return empty;
    }

    const raw =
      fs.readFileSync(
        filePath,
        "utf8"
      );

    const parsed =
      JSON.parse(raw);

    return {
      exists: true,
      valid: true,
      data: parsed,
      error: null
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      data: null,
      error:
        error.message
    };
  }
}

function mergeEvidenceFallback(
  lists,
  fallback
) {
  const stats = {
    loaded: false,
    valid: false,
    phones: 0,
    emails: 0,
    banks: 0,
    payments: 0,
    instructions: 0,
    sources: 0
  };

  if (
    !fallback ||
    !fallback.valid ||
    !fallback.data
  ) {
    return stats;
  }

  stats.loaded = true;
  stats.valid = true;

  const evidence =
    Array.isArray(
      fallback.data.evidence
    )
      ? fallback.data.evidence
      : [];

  evidence.forEach(
    (item) => {
      if (!item) {
        return;
      }

      const source =
        item.source ||
        item.sourceUrl ||
        null;

      const type =
        normaliseTextValue(
          item.type ||
          item.kind ||
          ""
        );

      if (
        type === "phone"
      ) {
        const before =
          lists.phones.length;

        addItem(
          lists.phones,
          item.phone ||
          item.value,
          source
        );

        if (
          lists.phones.length >
          before
        ) {
          stats.phones++;
        }

        return;
      }

      if (
        type === "email"
      ) {
        const before =
          lists.emails.length;

        addItem(
          lists.emails,
          item.email ||
          item.value,
          source
        );

        if (
          lists.emails.length >
          before
        ) {
          stats.emails++;
        }

        return;
      }

      if (
        type === "bank"
      ) {
        const before =
          lists.bankNames.length;

        addItem(
          lists.bankNames,
          item.bank ||
          item.bankName ||
          item.value,
          source
        );

        if (
          lists.bankNames.length >
          before
        ) {
          stats.banks++;
        }

        return;
      }

      if (
        type === "contact"
      ) {
        const phone =
          item.phone ||
          item.telephone ||
          item.mobile ||
          item.tel;

        const email =
          item.email ||
          item.mail;

        if (phone) {
          const before =
            lists.phones.length;

          addItem(
            lists.phones,
            phone,
            source
          );

          if (
            lists.phones.length >
            before
          ) {
            stats.phones++;
          }
        }

        if (email) {
          const before =
            lists.emails.length;

          addItem(
            lists.emails,
            email,
            source
          );

          if (
            lists.emails.length >
            before
          ) {
            stats.emails++;
          }
        }

        return;
      }

      if (
        type === "payment" ||
        type === "payment_record"
      ) {
        const before =
          lists.paymentRecords.length;

        addPaymentRecord(
          lists.paymentRecords,
          {
            accountNumber:
              item.accountNumber ||
              item.publishedAccountNumber,

            publishedAccountNumber:
              item.publishedAccountNumber ||
              item.accountNumber,

            bankName:
              item.bankName ||
              item.bank,

            accountName:
              item.accountName,

            branch:
              item.branch,

            context:
              item.context,

            pageTitle:
              item.pageTitle,

            source:
              source,

            evidenceSource:
              "json_fallback"
          },
          source
        );

        if (
          lists.paymentRecords.length >
          before
        ) {
          stats.payments++;
        }

        return;
      }

      if (
        type === "payment_instruction" ||
        type === "payment_rule" ||
        type === "payment_service" ||
        type === "mobile_payment" ||
        type === "online_payment"
      ) {
        const value =
          item.value ||
          item.instruction ||
          item.description ||
          item.text;

        if (value) {
          const before =
            lists.paymentInstructions.length;

          addItem(
            lists.paymentInstructions,
            value,
            source
          );

          if (
            lists.paymentInstructions.length >
            before
          ) {
            stats.instructions++;
          }
        }
      }
    }
  );

  /*
   * Also support top-level arrays in the evidence JSON.
   */
  const data =
    fallback.data;

  if (
    Array.isArray(data.phones)
  ) {
    data.phones.forEach(
      (item) => {
        addItem(
          lists.phones,
          typeof item === "string"
            ? item
            : item.value ||
              item.phone,
          item.source ||
            item.sourceUrl
        );
      }
    );
  }

  if (
    Array.isArray(data.emails)
  ) {
    data.emails.forEach(
      (item) => {
        addItem(
          lists.emails,
          typeof item === "string"
            ? item
            : item.value ||
              item.email,
          item.source ||
            item.sourceUrl
        );
      }
    );
  }

  return stats;
}

/* ========================================================================
   EXTRACT EVIDENCE
   ======================================================================== */

function extractEvidenceFromText(
  text,
  source,
  lists
) {
  const content =
    safeText(text);

  if (!content.trim()) {
    return;
  }

  try {
    (extractPhones(content) || [])
      .forEach((value) => {
        addItem(
          lists.phones,
          value,
          source
        );
      });
  } catch {}

  try {
    (extractEmails(content) || [])
      .forEach((value) => {
        addItem(
          lists.emails,
          value,
          source
        );
      });
  } catch {}

  try {
    (extractBanks(content) || [])
      .forEach((value) => {
        addItem(
          lists.bankNames,
          value,
          source
        );
      });
  } catch {}

  try {
    (
      extractPaymentRecords(
        content
      ) || []
    ).forEach((record) => {
      addPaymentRecord(
        lists.paymentRecords,
        record,
        source
      );
    });
  } catch {}

  try {
    (
      extractPaymentInstructions(
        content
      ) || []
    ).forEach((instruction) => {
      if (
        instruction
      ) {
        addItem(
          lists.paymentInstructions,
          typeof instruction === "string"
            ? instruction
            : instruction.value ||
              instruction.text,
          source
        );
      }
    });
  } catch {}
}

/* ========================================================================
   PROCESS HTML
   ======================================================================== */

function processHtmlPage(
  html,
  url,
  institution,
  lists
) {
  const text =
    htmlToText(html);

  extractEvidenceFromText(
    text,
    url,
    lists
  );

  let title = "";

  try {
    title =
      extractTitle(html) ||
      "";
  } catch {}

  const links =
    discoverLinks(
      html,
      url,
      institution
    );

  return {
    title,
    textLength:
      text.length,
    links
  };
}

/* ========================================================================
   PROCESS PDF
   ======================================================================== */

async function processPdfPage(
  buffer,
  url,
  lists
) {
  try {
    const parsed =
      await pdfParse(
        buffer
      );

    const text =
      safeText(
        parsed.text
      );

    extractEvidenceFromText(
      text,
      url,
      lists
    );

    return {
      title:
        "",
      textLength:
        text.length,
      links: []
    };
  } catch {
    return {
      title: "",
      textLength: 0,
      links: []
    };
  }
}

/* ========================================================================
   FETCH + PROCESS ONE PAGE
   ======================================================================== */

async function fetchPage(
  url,
  institution,
  lists,
  startTime
) {
  if (
    crawlTimeExceeded(
      startTime
    )
  ) {
    return {
      ok: false,
      url,
      error:
        "crawl_timeout"
    };
  }

  if (
    !isCrawlableUrl(
      url,
      institution
    )
  ) {
    return {
      ok: false,
      url,
      error:
        "not_official_domain"
    };
  }

  try {
    const response =
      await fetchWithTimeout(
        url
      );

    const finalUrl =
      normaliseUrl(
        response.url ||
        url
      );

    if (
      !isCrawlableUrl(
        finalUrl,
        institution
      )
    ) {
      return {
        ok: false,
        url,
        error:
          "redirected_official_domain"
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        url,
        status:
          response.status,
        error:
          "http_" +
          response.status
      };
    }

    const buffer =
      await readResponseSafely(
        response
      );

    let result = {
      title: "",
      textLength: 0,
      links: []
    };

    if (
      isPdf(
        response,
        finalUrl
      )
    ) {
      result =
        await processPdfPage(
          buffer,
          finalUrl,
          lists
        );
    } else if (
      isHtml(
        response,
        finalUrl
      )
    ) {
      result =
        processHtmlPage(
          buffer.toString(
            "utf8"
          ),
          finalUrl,
          institution,
          lists
        );
    }

    return {
      ok: true,
      url: finalUrl,
      title:
        result.title,
      textLength:
        result.textLength,
      links:
        result.links || []
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error:
        error &&
        error.message
          ? error.message
          : "fetch_failed"
    };
  }
}

/* ========================================================================
   SOURCE COLLECTION
   ======================================================================== */

function addSource(
  sources,
  source
) {
  const clean =
    safeText(source).trim();

  if (
    !clean ||
    sources.includes(clean)
  ) {
    return;
  }

  sources.push(clean);
}

function addJsonSources(
  sources,
  lists
) {
  [
    lists.phones,
    lists.emails,
    lists.bankNames,
    lists.paymentRecords,
    lists.paymentInstructions
  ].forEach((list) => {
    list.forEach((item) => {
      if (!item) {
        return;
      }

      const source =
        item.source ||
        (
          item.value &&
          item.value.source
        );

      if (source) {
        addSource(
          sources,
          source
        );
      }
    });
  });
}

/* ========================================================================
   QUICK LIVE CHECK
   ======================================================================== */

async function quickLiveCheck(
  institution,
  homepage,
  lists,
  sources
) {
  const started =
    Date.now();

  const visited =
    new Set();

  const pages =
    [];

  const errors =
    [];

  let documentsFound = 0;

  /*
   * FIRST BATCH:
   * homepage + institution seed pages.
   *
   * This gives us the homepage plus the most useful pages immediately.
   */
  const initial =
    [];

  function addInitial(url) {
    const normalised =
      normaliseUrl(url);

    if (
      !normalised ||
      visited.has(normalised) ||
      initial.includes(normalised) ||
      initial.length >= 3
    ) {
      return;
    }

    if (
      isCrawlableUrl(
        normalised,
        institution
      )
    ) {
      initial.push(
        normalised
      );
    }
  }

  addInitial(homepage);

  if (
    Array.isArray(
      institution.seedPages
    )
  ) {
    institution.seedPages.forEach(
      addInitial
    );
  }

  /*
   * Homepage is always first.
   */
  const firstResults =
    await Promise.all(
      initial.map(
        (url) => {
          visited.add(url);

          return fetchPage(
            url,
            institution,
            lists,
            started
          );
        }
      )
    );

  const discovered =
    [];

  firstResults.forEach(
    (result) => {
      pages.push({
        url:
          result.url,
        ok:
          result.ok,
        title:
          result.title || "",
        error:
          result.error || null
      });

      if (result.ok) {
        addSource(
          sources,
          result.url
        );

        if (
          DOCUMENT_EXTENSIONS.test(
            result.url
          )
        ) {
          documentsFound++;
        }

        (
          result.links || []
        ).forEach(
          (link) => {
            if (
              !visited.has(
                link.url
              )
            ) {
              discovered.push(
                link
              );
            }
          }
        );
      } else {
        errors.push({
          url:
            result.url,
          error:
            result.error
        });
      }
    }
  );

  /*
   * SECOND BATCH:
   * only the best discovered official pages.
   */
  const unique =
    [];

  discovered
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .forEach(
      (link) => {
        if (
          unique.length >=
          MAX_LIVE_PAGES -
            pages.length
        ) {
          return;
        }

        if (
          visited.has(
            link.url
          )
        ) {
          return;
        }

        visited.add(
          link.url
        );

        unique.push(
          link.url
        );
      }
    );

  if (
    unique.length &&
    !crawlTimeExceeded(
      started
    )
  ) {
    const secondResults =
      await Promise.all(
        unique.map(
          (url) =>
            fetchPage(
              url,
              institution,
              lists,
              started
            )
        )
      );

    secondResults.forEach(
      (result) => {
        pages.push({
          url:
            result.url,
          ok:
            result.ok,
          title:
            result.title || "",
          error:
            result.error || null
        });

        if (result.ok) {
          addSource(
            sources,
            result.url
          );

          if (
            DOCUMENT_EXTENSIONS.test(
              result.url
            )
          ) {
            documentsFound++;
          }
        } else {
          errors.push({
            url:
              result.url,
            error:
              result.error
          });
        }
      }
    );
  }

  return {
    pages,
    documentsFound,
    errors,
    elapsedMs:
      Date.now() - started,
    timedOut:
      crawlTimeExceeded(
        started
      )
  };
}

/* ========================================================================
   MATCH REQUESTED VALUE
   ======================================================================== */

function getRequestedValue(
  req
) {
  const q =
    req.query || {};

  return safeText(
    q.value ||
    q.q ||
    q.search ||
    q.number ||
    q.email ||
    q.account ||
    q.accountNumber ||
    ""
  ).trim();
}

function getRequestedType(
  req
) {
  const q =
    req.query || {};

  return normaliseTextValue(
    q.type ||
    q.kind ||
    q.check ||
    ""
  );
}

function phoneDigits(
  value
) {
  return safeText(
    value
  ).replace(/\D/g, "");
}

function phonesMatch(
  a,
  b
) {
  const x =
    phoneDigits(a);

  const y =
    phoneDigits(b);

  if (!x || !y) {
    return false;
  }

  if (x === y) {
    return true;
  }

  /*
   * Zambia local/international equivalent:
   * 0972xxxxxx <-> 260972xxxxxx
   */
  if (
    x.length === 10 &&
    x.startsWith("0") &&
    y ===
      "260" +
      x.slice(1)
  ) {
    return true;
  }

  if (
    y.length === 10 &&
    y.startsWith("0") &&
    x ===
      "260" +
      y.slice(1)
  ) {
    return true;
  }

  return false;
}

function findRequestedEvidence(
  lists,
  value,
  type
) {
  const clean =
    safeText(value).trim();

  if (!clean) {
    return null;
  }

  const requestedType =
    normaliseTextValue(
      type
    );

  /*
   * PHONE
   */
  if (
    requestedType === "phone" ||
    requestedType === "telephone" ||
    requestedType === "mobile"
  ) {
    return (
      lists.phones.find(
        (item) =>
          phonesMatch(
            clean,
            item.value
          )
      ) || null
    );
  }

  /*
   * EMAIL
   */
  if (
    requestedType === "email"
  ) {
    const target =
      normaliseTextValue(
        clean
      );

    return (
      lists.emails.find(
        (item) =>
          normaliseTextValue(
            item.value
          ) === target
      ) || null
    );
  }

  /*
   * BANK / ACCOUNT
   */
  if (
    requestedType === "bank" ||
    requestedType === "account" ||
    requestedType === "payment"
  ) {
    const digits =
      normaliseAccountNumber(
        clean
      );

    if (digits) {
      const payment =
        lists.paymentRecords.find(
          (item) => {
            const record =
              item.value ||
              item;

            return (
              normaliseAccountNumber(
                record.accountNumber ||
                record.publishedAccountNumber
              ) === digits
            );
          }
        );

      if (payment) {
        return payment;
      }
    }

    const bank =
      normaliseTextValue(
        clean
      );

    return (
      lists.bankNames.find(
        (item) => {
          const value =
            normaliseTextValue(
              item.value
            );

          return (
            value === bank ||
            value.includes(bank) ||
            bank.includes(value)
          );
        }
      ) || null
    );
  }

  /*
   * UNKNOWN TYPE:
   * search all evidence.
   */
  const target =
    normaliseTextValue(
      clean
    );

  const phone =
    lists.phones.find(
      (item) =>
        phonesMatch(
          clean,
          item.value
        )
    );

  if (phone) {
    return phone;
  }

  const email =
    lists.emails.find(
      (item) =>
        normaliseTextValue(
          item.value
        ) === target
    );

  if (email) {
    return email;
  }

  const digits =
    normaliseAccountNumber(
      clean
    );

  if (digits) {
    const payment =
      lists.paymentRecords.find(
        (item) => {
          const record =
            item.value ||
            item;

          return (
            normaliseAccountNumber(
              record.accountNumber ||
              record.publishedAccountNumber
            ) === digits
          );
        }
      );

    if (payment) {
      return payment;
    }
  }

  return null;
}

/* ========================================================================
   MAIN CRAWLER
   ======================================================================== */

async function crawlInstitution(
  institution
) {
  const startTime =
    Date.now();

  const lists =
    createItemLists();

  const sources =
    [];

  const fallback =
    loadEvidenceFallback(
      institution
    );

  const fallbackStats =
    mergeEvidenceFallback(
      lists,
      fallback
    );

  addJsonSources(
    sources,
    lists
  );

  /*
   * JSON is trusted as the institution-specific evidence baseline.
   */
  const requestedValue =
    arguments.length > 1
      ? arguments[1]
      : "";

  const liveResult =
    {
      pages: [],
      documentsFound: 0,
      errors: [],
      elapsedMs: 0,
      timedOut: false
    };

  return {
    lists,
    sources,
    fallback,
    fallbackStats,
    liveResult,
    startTime
  };
}

/* ========================================================================
   API HANDLER
   ======================================================================== */

module.exports = async function handler(
  req,
  res
) {
  try {
    const institutionId =
      safeText(
        req.query &&
        req.query.institution
      ).trim();

    if (!institutionId) {
      return res.status(400).json({
        error:
          "Missing institution parameter."
      });
    }

    const institution =
      getInstitutionById(
        institutionId
      );

    if (!institution) {
      return res.status(404).json({
        error:
          "Institution not found."
      });
    }

    const officialUrl =
      institution.homepage ||
      (
        /^https?:\/\//i.test(
          institution.domain || ""
        )
          ? institution.domain
          : "https://" +
            institution.domain +
            "/"
      );

    const lists =
      createItemLists();

    const sources =
      [];

    /* ---------------------------------------------------------------
       1. LOAD JSON FIRST
       --------------------------------------------------------------- */

    const fallback =
      loadEvidenceFallback(
        institution
      );

    const fallbackStats =
      mergeEvidenceFallback(
        lists,
        fallback
      );

    addJsonSources(
      sources,
      lists
    );

    const requestedValue =
      getRequestedValue(req);

    const requestedType =
      getRequestedType(req);

    const jsonMatch =
      requestedValue
        ? findRequestedEvidence(
            lists,
            requestedValue,
            requestedType
          )
        : null;

    /*
     * EXACT JSON MATCH:
     * return immediately.
     */
    if (jsonMatch) {
      const response = {
        institutionId:
          institution.id,

        institutionName:
          institution.name,

        domain:
          institution.domain,

        officialUrl:

          officialUrl,

        items:
          lists,

        evidence:
          lists,

        sources:
          sources,

        pagesCrawled:
          [],

        fallbackStats:
          fallbackStats,

        crawlStats: {
          mode:
            "json-first",

          pagesCrawled:
            0,

          maxPages:
            MAX_LIVE_PAGES,

          elapsedMs:
            Date.now() -
            startTime,

          liveCheck:
            false,

          jsonUsed:
            true,

          jsonMatch:
            true,

          errors:
            0
        },

        verificationStatus:
          "verified",

        verificationSource:
          "json",

        dataComplete:
          true,

        crawlFailed:
          false,

        checkedAt:
          new Date().toISOString()
      };

      return res
        .status(200)
        .json(response);
    }

    /*
     * ---------------------------------------------------------------
     * 2. NO REQUESTED VALUE
     *
     * Existing script.js asks for the whole evidence set.
     * Do NOT crawl here.
     *
     * JSON response is immediate.
     * ---------------------------------------------------------------
     */

    if (!requestedValue) {
      return res
        .status(200)
        .json({
          institutionId:
            institution.id,

          institutionName:
            institution.name,

          domain:
            institution.domain,

          officialUrl:
            officialUrl,

          items:
            lists,

          evidence:
            lists,

          sources:
            sources,

          pagesCrawled:
            [],

          fallbackStats:
            fallbackStats,

          crawlStats: {
            mode:
              "json-first",

            pagesCrawled:
              0,

            maxPages:
              MAX_LIVE_PAGES,

            elapsedMs:
              Date.now() -
              startTime,

            liveCheck:
              false,

            jsonUsed:
              true,

            jsonMatch:
              false,

            errors:
              0
          },

          verificationStatus:
            fallback.valid
              ? "ready"
              : "incomplete",

          verificationSource:
            "json",

          dataComplete:
            !!fallback.valid,

          crawlFailed:
            false,

          checkedAt:
            new Date().toISOString()
        });
    }

    /*
     * ---------------------------------------------------------------
     * 3. JSON DID NOT MATCH
     *
     * Quick live fallback.
     *
     * Maximum 5 pages.
     * ---------------------------------------------------------------
     */

    const live =
      await quickLiveCheck(
        institution,
        officialUrl,
        lists,
        sources
      );

    const liveMatch =
      findRequestedEvidence(
        lists,
        requestedValue,
        requestedType
      );

    const successfulPages =
      live.pages.filter(
        (page) =>
          page.ok
      ).length;

    const crawlFailed =
      successfulPages === 0;

    /*
     * Important:
     * A completed quick search is a completed verification attempt.
     *
     * We do NOT make dataComplete false merely because one random page
     * failed.
     */
    const dataComplete =
      fallback.valid ||
      !live.timedOut ||
      successfulPages > 0;

    return res
      .status(200)
      .json({
        institutionId:
          institution.id,

        institutionName:
          institution.name,

        domain:
          institution.domain,

        officialUrl:
          officialUrl,

        items:
          lists,

        evidence:
          lists,

        sources:
          sources,

        pagesCrawled:
          live.pages,

        fallbackStats:
          fallbackStats,

        crawlStats: {
          mode:
            "json-first-fast-live",

          pagesCrawled:
            live.pages.length,

          maxPages:
            MAX_LIVE_PAGES,

          elapsedMs:
            live.elapsedMs,

          maxTimeMs:
            MAX_CRAWL_TIME_MS,

          liveCheck:
            true,

          jsonUsed:
            fallback.valid,

          jsonMatch:
            false,

          liveMatch:
            !!liveMatch,

          documentsFound:
            live.documentsFound,

          errors:
            live.errors.length,

          timedOut:
            live.timedOut
        },

        verificationStatus:
          liveMatch
            ? "verified"
            : "not_found",

        verificationSource:
          liveMatch
            ? "official_live_source"
            : "not_found",

        dataComplete:
          dataComplete,

        crawlFailed:
          crawlFailed,

        checkedAt:
          new Date().toISOString()
      });

  } catch (error) {
    console.error(
      "CampusVerify fast crawler error:",
      error
    );

    return res
      .status(200)
      .json({
        institutionId:
          safeText(
            req.query &&
            req.query.institution
          ),

        institutionName:
          "",

        domain:
          "",

        officialUrl:
          "",

        items: {
          phones: [],
          emails: [],
          bankNames: [],
          paymentRecords: [],
          paymentInstructions: []
        },

        evidence: {
          phones: [],
          emails: [],
          bankNames: [],
          paymentRecords: [],
          paymentInstructions: []
        },

        sources: [],

        pagesCrawled: [],

        fallbackStats: {
          loaded: false,
          valid: false,
          phones: 0,
          emails: 0,
          banks: 0,
          payments: 0,
          instructions: 0,
          sources: 0
        },

        crawlStats: {
          mode:
            "error",
          pagesCrawled:
            0,
          errors:
            1
        },

        verificationStatus:
          "incomplete",

        verificationSource:
          "none",

        dataComplete:
          false,

        crawlFailed:
          true,

        checkedAt:
          new Date().toISOString()
      });
  }
};
