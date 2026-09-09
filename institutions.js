/* =========================================================================
   CampusVerify v3.1 — institutions.js
   -----------------------------------------------------------------------
   WHITELIST OF SUPPORTED INSTITUTIONS

   domain: the institution's official base domain, e.g. "unilus.ac.zm".
   The crawler and getInstitutionByUrl() both treat any hostname equal to
   this OR a subdomain of it (web.unilus.ac.zm, portal.unilus.ac.zm, etc.)
   as belonging to the same institution. A student typing "web.unilus.ac.zm"
   is not rejected just because the configured base domain is
   "unilus.ac.zm" — that was a real bug in v3, fixed here.

   homepage: OPTIONAL. The actual working URL the crawler should start
   crawling from. Use this when the bare base domain doesn't itself serve
   a working site (dead SSL cert, no server, redirects elsewhere) but a
   subdomain does — e.g. unilus.ac.zm's certificate is expired, but
   web.unilus.ac.zm works fine. If omitted, the crawler falls back to
   "https://" + domain + "/".

   seedPages: pages the crawler always starts from IN ADDITION to the
   homepage, so known-important pages (contact/fees) are covered even if
   the site doesn't link to them prominently. The crawler still discovers
   further pages on its own from the homepage — this list is a head
   start, not a hard ceiling. Can include direct PDF links too, on any
   subdomain of "domain" — useful when a document with real published
   evidence (e.g. bank details) lives somewhere the crawler wouldn't
   otherwise reach in time.

   status: "supported" | "pilot" | "partner"
     - "supported" (default): CampusVerify has crawled this institution's
       public pages. No formal relationship implied.
     - "pilot" / "partner": ONLY set this when that relationship is a
       real, confirmed fact — never as a default or aspiration. Getting
       this wrong means falsely implying an agreement to a student.
   ========================================================================= */

const INSTITUTIONS = [
  {
    id: "unilus",
    name: "University of Lusaka (UNILUS)",
    shortName: "UNILUS",
    domain: "unilus.ac.zm",
    homepage: "https://web.unilus.ac.zm/",
    status: "supported",
    seedPages: [
      "https://web.unilus.ac.zm/contact-us/",
      "https://web.unilus.ac.zm/registation-notice/",
      "https://web.unilus.ac.zm/fees/",
      "https://www.unilus.ac.zm/Documents/JUNE_JULY%202025%20APPLICANTS.pdf",
      "https://web.unilus.ac.zm/wp-content/uploads/2025/12/UNDERGRADUATE-FEES-ZMW.pdf",
      "https://web.unilus.ac.zm/wp-content/uploads/2025/12/BACHELOR-OF-SCIENCE-IN-NURSING-USD-FEES-UNILUS-2026.pdf"
    ],
    reportingLinks: [
      { label: "ZICTA Cyber Complaints Portal", url: "https://www.zicta.zm/cyber-complaints" }
    ],
    addedDate: "2026-09-07"
  }

  /* To add an institution: give it an id, name, official base domain,
     status: "supported" (the honest default), and a couple of seedPages
     to help the crawler get started. Nothing else needs to change.
     Only add a "homepage" field if the bare domain doesn't itself work
     (dead cert, no server) but a subdomain like www./web. does. If a
     specific important document (fees/bank-details PDF) is known and
     might not be found in time by normal crawling, add its direct URL
     to seedPages too. */
];

function getInstitutionById(id) {
  return INSTITUTIONS.find(function (inst) { return inst.id === id; }) || null;
}

/* True if hostname IS baseDomain, or is a subdomain of it
   (web.unilus.ac.zm belongs to unilus.ac.zm; evilunilus.ac.zm does not —
   this checks a dot boundary, not a plain string suffix, on purpose). */
function isSameInstitutionHost(hostname, baseDomain) {
  if (!hostname || !baseDomain) return false;
  var h = hostname.toLowerCase().replace(/^www\./, "");
  var b = baseDomain.toLowerCase().replace(/^www\./, "");
  return h === b || h.endsWith("." + b);
}

/* Identify an institution from a URL the student typed in, e.g.
   "https://web.unilus.ac.zm/contact-us" or "unilus.ac.zm". Matches by
   host-or-subdomain against the whitelist only — never fetches
   anything, never accepts a domain not already on the list. */
function getInstitutionByUrl(rawInput) {
  if (!rawInput) return null;
  var candidate = rawInput.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;

  var hostname;
  try { hostname = new URL(candidate).hostname; } catch (e) { return null; }

  return INSTITUTIONS.find(function (inst) {
    return isSameInstitutionHost(hostname, inst.domain);
  }) || null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INSTITUTIONS: INSTITUTIONS,
    getInstitutionById: getInstitutionById,
    getInstitutionByUrl: getInstitutionByUrl,
    isSameInstitutionHost: isSameInstitutionHost
  };
}
