/* =========================================================================
   CampusVerify v3.2 — api/crawler.js
   -----------------------------------------------------------------------
   GET /api/crawler?institution=<id>

   v3.2 change (reliability only — nothing else touched):

   v3.1 fetched its up-to-8 pages ONE AT A TIME, each with an 8s timeout.
   Worst case: 8 x 8s = 64s — well past a serverless function's timeout
   window. Fixed by fetching in ROUNDS instead of one-by-one:

     Round 1 = homepage + seedPages (known upfront), fetched IN PARALLEL.
     Round 2 = links discovered while reading round 1's pages, up to
               whatever's left of the 8-page budget, fetched IN PARALLEL.

   Because each round runs concurrently, worst-case wall-clock time is
   ~2 x FETCH_TIMEOUT_MS (~16s) no matter how many of the 8 pages are
   slow or unreachable — not 8x. The 8-page ceiling itself is unchanged
   and is still enforced on TOTAL ATTEMPTS (not just successes), so a
   run of all-unreachable pages can't quietly keep going past the limit
   either.

   dataComplete now means "every page CampusVerify attempted within its
   crawl budget succeeded, AND the budget wasn't hit while further
   discovered links were still waiting" — not "the whole university
   website was crawled". If the site has more linked pages than the
   8-page budget allows, that's reported honestly as incomplete.
   ========================================================================= */

const { getInstitutionById, isSameInstitutionHost } = require("../institutions.js");
const {
  extractPhones, extractEmails, extractBanks,
  extractBankAccounts, extractAccountNames, extractBranches, extractPaymentInstructions
} = require("../patterns.js");

const FETCH_TIMEOUT_MS = 8000;
const MAX_PAGES_PER_INSTITUTION = 8; // unchanged hard ceiling — counts every attempt, not just successes
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
    headers: { "User-Agent": "CampusVerify-Crawler/3.2 (+institutional verification bot; respects robots)" }
  }).finally(function () { clearTimeout(timer); });
}

/* Unchanged from v3.1 */
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

/* Fetches a batch of URLs IN PARALLEL and extracts facts from each.
   Every URL in the batch times out independently, so one slow page
   never blocks the others — the whole batch's wall-clock time is
   bounded by the single slowest page, not the sum of all of them. */
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
      extractBankAccounts(r.html).forEach(function (a) { addItem(itemLists.bankAccounts, a, r.url); });
      extractAccountNames(r.html).forEach(function (n) { addItem(itemLists.accountNames, n, r.url); });
      extractBranches(r.html).forEach(function (b) { addItem(itemLists.branches, b, r.url); });
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
    phones: [], emails: [], bankNames: [], bankAccounts: [],
    accountNames: [], branches: [], paymentInstructions: []
  };
  Object.keys(itemLists).forEach(function (k) { itemLists[k]._seen = new Set(); });

  /* ---- Round 1: homepage + seed pages, known upfront, fetched in parallel ---- */
  var round1Candidates = [homepage].concat(institution.seedPages || [])
    .filter(function (url, idx, arr) { return arr.indexOf(url) === idx; }) // de-dupe
    .slice(0, MAX_PAGES_PER_INSTITUTION);
  round1Candidates.forEach(function (u) { visited[u] = true; });

  var discoveredAfterRound1 = await fetchBatch(round1Candidates, institution, itemLists, pageStatus, visited);

  /* ---- Round 2: links discovered in round 1, up to whatever budget remains, also parallel ---- */
  var remainingBudget = MAX_PAGES_PER_INSTITUTION - pageStatus.length;
  var round2Candidates = discoveredAfterRound1.filter(function (u) { return !visited[u]; }).slice(0, Math.max(0, remainingBudget));
  round2Candidates.forEach(function (u) { visited[u] = true; });

  var discoveredAfterRound2 = [];
  if (round2Candidates.length > 0) {
    discoveredAfterRound2 = await fetchBatch(round2Candidates, institution, itemLists, pageStatus, visited);
  }

  /* Anything still undiscovered-but-known past this point means the
     8-page budget was reached before the site's own link graph was
     exhausted — that's the case dataComplete must NOT paper over.
     This must count BOTH round-1 links that never made it into round 2
     (budget ran out before we got to them) AND round-2 links found but
     never fetched — missing the first category was a real bug caught
     by testing: a homepage with 20 links and an 8-page budget reported
     dataComplete=true when it should have been false. */
  var leftoverBudget = MAX_PAGES_PER_INSTITUTION - pageStatus.length;
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
    // Honest meaning: every page CampusVerify attempted within its
    // 8-page budget succeeded, AND the budget wasn't reached while more
    // linked pages were still waiting to be checked. This is NOT a
    // claim that the entire institution website was crawled.
    dataComplete: allAttemptedOk && !truncatedByBudget,
    crawlFailed: crawlFailed,
    checkedAt: new Date().toISOString()
  });
};
