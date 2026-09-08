/* =========================================================================
   CampusVerify v3.3 — api/crawler.js
   -----------------------------------------------------------------------
   GET /api/crawler?institution=<id>

   v3.3 change: bank account, account name, and branch are no longer
   extracted as three separate unlinked lists. extractPaymentRecords()
   (in patterns.js) returns one linked record per account — with bank
   name, account name, branch, source URL, page title, and surrounding
   context all attached together. This replaces the old bankAccounts,
   accountNames, and branches arrays with a single paymentRecords array.
   ========================================================================= */

const { getInstitutionById, isSameInstitutionHost } = require("../institutions.js");
const {
  extractPhones, extractEmails, extractBanks,
  extractPaymentRecords, extractTitle, extractPaymentInstructions
} = require("../patterns.js");

const FETCH_TIMEOUT_MS = 8000;
const MAX_PAGES_PER_INSTITUTION = 8;
const PRIORITY_KEYWORDS = [
  "contact", "admission", "student-affairs", "student_affairs", "studentaffairs",
  "account", "finance", "fee", "payment", "bank", "registration", "notice", "support", "department"
];
const EXCLUDED_PATH_PATTERNS = /login|signin|sign-in|logon|portal|admin|wp-admin|cpanel|dashboard|account\/(login|register)/i;

function fetchWithTimeout(url, ms) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, ms);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "CampusVerify-Crawler/3.3 (+institutional verification bot; respects robots)" }
  }).finally(function () { clearTimeout(timer); });
}

function discoverLinks(html, pageUrl, baseDomain) {
  var linkRegex = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var found = [];
  var seen = {};
  var m;
  while ((m = linkRegex.exec(html)) !== null) {
    var href = m[1].trim();
    var anchorText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    var resolved;
    try { resolved = new URL(href, pageUrl).toString(); } catch (e) { continue; }
    var parsed;
    try { parsed = new URL(resolved); } catch (e) { continue; }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    if (!isSameInstitutionHost(parsed.hostname, baseDomain)) continue;
    if (EXCLUDED_PATH_PATTERNS.test(parsed.pathname)) continue;
    if (seen[resolved]) continue;
    seen[resolved] = true;
    var score = PRIORITY_KEYWORDS.some(function (kw) {
      return parsed.pathname.toLowerCase().indexOf(kw) !== -1 || anchorText.indexOf(kw) !== -1;
    }) ? 1 : 0;
    found.push({ url: resolved, score: score });
  }
  found.sort(function (a, b) { return b.score - a.score; });
  return found.map(function (f) { return f.url; });
}

function addItem(list, value, source, seenKey) {
  if (!value) return;
  var key = seenKey || value;
  if (list._seen.has(key)) return;
  list._seen.add(key);
  list.push({ value: value, source: source });
}

async function fetchBatch(urls, institution, itemLists, pageStatus, visited) {
  var results = await Promise.allSettled(urls.map(async function (url) {
    var parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return { url: url, status: "unreachable", html: null }; }
    if (!isSameInstitutionHost(parsedUrl.hostname, institution.domain)) return { url: url, status: "unreachable", html: null };
    if (EXCLUDED_PATH_PATTERNS.test(parsedUrl.pathname)) return { url: url, status: "unreachable", html: null };

    try {
      var pageRes = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (!pageRes.ok) return { url: url, status: "unreachable", html: null };
      var html = await pageRes.text();
      return { url: url, status: "ok", html: html };
    } catch (err) {
      var isTimeout = err && err.name === "AbortError";
      console.error("CampusVerify crawler error for", url, ":", err && err.message);
      return { url: url, status: isTimeout ? "timeout" : "unreachable", html: null };
    }
  }));

  var newlyDiscovered = [];
  results.forEach(function (settled) {
    var r = settled.status === "fulfilled" ? settled.value : { url: "unknown", status: "unreachable", html: null };
    pageStatus.push({ url: r.url, status: r.status });

    if (r.status === "ok" && r.html) {
      extractPhones(r.html).forEach(function (p) { addItem(itemLists.phones, p, r.url); });
      extractEmails(r.html).forEach(function (e) { addItem(itemLists.emails, e, r.url); });
      extractBanks(r.html).forEach(function (b) { addItem(itemLists.bankNames, b, r.url); });

      var pageTitle = extractTitle(r.html);
      extractPaymentRecords(r.html, r.url, pageTitle).forEach(function (rec) {
        addItem(itemLists.paymentRecords, rec, r.url, rec.accountNumber);
      });

      extractPaymentInstructions(r.html).forEach(function (p) { addItem(itemLists.paymentInstructions, p, r.url, p.slice(0, 40)); });

      discoverLinks(r.html, r.url, institution.domain).forEach(function (link) {
        if (!visited[link]) newlyDiscovered.push(link);
      });
    }
  });
  return newlyDiscovered;
}

module.exports = async function handler(req, res) {
  var institutionId = req.query.institution;
  if (!institutionId) {
    return res.status(400).json({ error: "Missing institution id" });
  }

  var institution = getInstitutionById(institutionId);
  if (!institution) {
    return res.status(404).json({ error: "This institution is not supported yet." });
  }

  var homepage = "https://" + institution.domain + "/";
  var visited = {};
  var pageStatus = [];
  var itemLists = {
    phones: [], emails: [], bankNames: [], paymentRecords: [], paymentInstructions: []
  };
  Object.keys(itemLists).forEach(function (k) { itemLists[k]._seen = new Set(); });

  var round1Candidates = [homepage].concat(institution.seedPages || [])
    .filter(function (url, idx, arr) { return arr.indexOf(url) === idx; })
    .slice(0, MAX_PAGES_PER_INSTITUTION);
  round1Candidates.forEach(function (u) { visited[u] = true; });

  var discoveredAfterRound1 = await fetchBatch(round1Candidates, institution, itemLists, pageStatus, visited);

  var remainingBudget = MAX_PAGES_PER_INSTITUTION - pageStatus.length;
  var round2Candidates = discoveredAfterRound1.filter(function (u) { return !visited[u]; }).slice(0, Math.max(0, remainingBudget));
  round2Candidates.forEach(function (u) { visited[u] = true; });

  var discoveredAfterRound2 = [];
  if (round2Candidates.length > 0) {
    discoveredAfterRound2 = await fetchBatch(round2Candidates, institution, itemLists, pageStatus, visited);
  }

  var unusedFromRound1 = discoveredAfterRound1.filter(function (u) { return !visited[u]; });
  var stillPendingLinks = unusedFromRound1.concat(discoveredAfterRound2.filter(function (u) { return !visited[u]; }));
  var truncatedByBudget = stillPendingLinks.length > 0;

  var okSources = pageStatus.filter(function (p) { return p.status === "ok"; }).map(function (p) { return p.url; });
  var allAttemptedOk = pageStatus.length > 0 && pageStatus.every(function (p) { return p.status === "ok"; });
  var crawlFailed = okSources.length === 0;

  return res.status(200).json({
    institutionId: institution.id,
    institutionName: institution.name,
    domain: institution.domain,
    status: institution.status,
    items: itemLists,
    pagesCrawled: pageStatus,
    sources: okSources,
    dataComplete: allAttemptedOk && !truncatedByBudget,
    crawlFailed: crawlFailed,
    checkedAt: new Date().toISOString()
  });
};
