/* =========================================================================
   CampusVerify — patterns.js
   -----------------------------------------------------------------------
   OFFICIAL SCAM PATTERN FILE — Phase 3

   Every pattern below is drawn ONLY from the Stage 1 Evidence Dossier:
     - Alert 1: UNILUS Registration Notice (web.unilus.ac.zm/registation-notice/),
       published Dec 6 2025 — documented fake admission-cancellation SMS,
       urgent payment demands, and fake WhatsApp group impersonation.
     - Alert 2: UNILUS International Student Information page
       (web.unilus.ac.zm/admission-2/) — documented unauthorized-agent /
       fake study-permit-agent fraud.

   No pattern here was invented. If a new scam pattern is documented by
   UNILUS in the future, it should be added here (with its own source
   citation) — never hardcoded into script.js.

   Each pattern has:
     - triggers    -> lowercase substrings to search for in the message
     - category    -> short label shown to the user
     - explanation -> why this phrase is a documented warning sign
     - source      -> exact Stage 1 citation
   ========================================================================= */


/* -------------------------------------------------------------------------
   CRAWLER EXTRACTION RULES
   Used by api/crawler.js to pull structured facts out of an institution's
   raw page text.

   Zambian mobile format (+260 7XXXXXXXX / 07XXXXXXXX),
   generic email pattern, and a list of banks operating in Zambia.
   Add new bank names here as institutions require them — never in
   script.js or the crawler itself.
   ------------------------------------------------------------------------- */


/* Phone numbers in the wild look like:
   0960871744
   0960 871 744
   +260 960 871 744
   260960871744

   One regex over raw page text still finds the digits fine — the real fix
   is NORMALIZING before any comparison happens, so "0960 871 744"
   correctly matches "+260960871744" typed by a student.

   normalisePhone() below is the single source of truth for that —
   used both when extracting from crawled pages and when comparing
   a student's input.
*/

const PHONE_REGEX = /(?:\+?260[\s-]?|0)[79]\d(?:[\s-]?\d){7}/g;

const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const BANK_NAMES = [
  "Zanaco",
  "Indo-Zambia Bank",
  "Access Bank",
  "ABSA",
  "Stanbic",
  "FNB",
  "Standard Chartered",
  "First Capital",
  "Atlas Mara"
];


function normalisePhone(value) {
  var digits = (value || "").replace(/\D/g, "");

  if (digits.indexOf("260") === 0) {
    digits = digits.slice(3);
  }

  if (digits.indexOf("0") === 0) {
    digits = digits.slice(1);
  }

  return digits;
}


function extractPhones(text) {
  var raw = Array.from(
    new Set((text.match(PHONE_REGEX) || []))
  );

  // De-duplicate by normalised form too, but keep the original display text
  var seen = {};

  return raw.filter(function (p) {
    var norm = normalisePhone(p);

    if (seen[norm]) {
      return false;
    }

    seen[norm] = true;

    return norm.length === 9;
  });
}


function extractEmails(text) {
  return Array.from(
    new Set((text.match(EMAIL_REGEX) || []))
  );
}


function extractBanks(text) {
  var lower = text.toLowerCase();

  return BANK_NAMES.filter(function (bank) {
    return lower.indexOf(bank.toLowerCase()) !== -1;
  });
}


/* -------------------------------------------------------------------------
   PAYMENT-DETAIL EXTRACTION

   Extract account numbers, account names, and branch details from
   institution pages.

   The extraction first strips HTML so that information split across
   HTML tags can still be detected correctly.
   ------------------------------------------------------------------------- */


function stripTags(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}


const BANK_ACCOUNT_REGEX =
  /(?:a\/?c|acc(?:ount)?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*((?:\d[\s\-]?){8,16}\d)/gi;


const ACCOUNT_NAME_REGEX =
  /(?:account\s*name\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


const BRANCH_REGEX =
  /(?:branch\s*(?:name)?\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


const PAYMENT_INSTRUCTION_TRIGGERS = [
  "pay to",
  "payment should be made to",
  "payments must be made",
  "make payment to",
  "deposit to"
];


function extractBankAccounts(html) {
  var text = stripTags(html);
  var results = [];
  var m;

  BANK_ACCOUNT_REGEX.lastIndex = 0;

  while ((m = BANK_ACCOUNT_REGEX.exec(text)) !== null) {
    results.push(
      m[1].replace(/[\s\-]/g, "")
    );
  }

  return Array.from(new Set(results));
}


function extractAccountNames(html) {
  var text = stripTags(html);
  var results = [];
  var m;

  ACCOUNT_NAME_REGEX.lastIndex = 0;

  while ((m = ACCOUNT_NAME_REGEX.exec(text)) !== null) {
    results.push(
      m[1].trim().replace(/\s+/g, " ")
    );
  }

  return Array.from(new Set(results));
}


function extractBranches(html) {
  var text = stripTags(html);
  var results = [];
  var m;

  BRANCH_REGEX.lastIndex = 0;

  while ((m = BRANCH_REGEX.exec(text)) !== null) {
    results.push(
      m[1].trim().replace(/\s+/g, " ")
    );
  }

  return Array.from(new Set(results));
}


function extractPaymentInstructions(text) {
  var lower = text.toLowerCase();
  var found = [];

  PAYMENT_INSTRUCTION_TRIGGERS.forEach(function (trigger) {
    var idx = lower.indexOf(trigger);

    if (idx !== -1) {
      // Grab a short surrounding snippet, not the whole page.
      // Enough context to be useful without reproducing the page.

      var start = Math.max(0, idx - 20);

      var snippet = text
        .slice(
          start,
          idx + trigger.length + 80
        )
        .replace(/\s+/g, " ")
        .trim();

      found.push(snippet);
    }
  });

  return found;
}


/* -------------------------------------------------------------------------
   OFFICIAL SCAM PATTERNS
   ------------------------------------------------------------------------- */

const SCAM_PATTERNS = [

  {
    id: "scam-001",

    category: "Fake Admission Cancellation",

    triggers: [
      "admission cancelled",
      "admission has been cancelled",
      "admission is cancelled",
      "your admission has been"
    ],

    explanation:
      "UNILUS's own Registration Notice documented fake SMS messages telling students their admission had been cancelled, in order to pressure an urgent payment.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 1 — UNILUS Registration Notice, Dec 6 2025"
  },


  {
    id: "scam-002",

    category: "Urgent Payment Pressure",

    triggers: [
      "pay immediately",
      "urgent payment",
      "before 10:00",
      "before 10am",
      "before 10 am",
      "failure to pay"
    ],

    explanation:
      "The documented scam messages used artificial deadlines and urgency to pressure a quick payment before the student could verify the message.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 1 — UNILUS Registration Notice, Dec 6 2025"
  },


  {
    id: "scam-003",

    category: "Payment Redirection",

    triggers: [
      "send money to this number",
      "send money to",
      "pay to this number",
      "make payment to",
      "deposit to this account"
    ],

    explanation:
      "UNILUS's warning specifically covers messages directing payment to unofficial numbers or accounts outside its published bank details.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 1 — UNILUS Registration Notice, Dec 6 2025"
  },


  {
    id: "scam-004",

    category: "Fake WhatsApp Group",

    triggers: [
      "join this whatsapp group",
      "official whatsapp group",
      "whatsapp group link",
      "join our whatsapp"
    ],

    explanation:
      "UNILUS warned students to verify WhatsApp groups before joining, since unofficial groups impersonating the university have been documented.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 1 — UNILUS Registration Notice, Dec 6 2025"
  },


  {
    id: "scam-005",

    category: "Unauthorized Agent / Fake Permit Agent",

    triggers: [
      "assist you to obtain",
      "process your permit",
      "agent fee",
      "pay the agent",
      "on your behalf",
      "study permit payment"
    ],

    explanation:
      "UNILUS's International Student Information page specifically warned against unauthorized agents charging for study-permit services or making payments on a student's behalf.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 2 — UNILUS International Student Information page"
  },


  {
    id: "scam-006",

    category: "Impersonating the Accounts Office",

    triggers: [
      "visit the accounts office",
      "call the accounts office",
      "contact accounts office on",
      "accounts office on"
    ],

    explanation:
      "The documented fake SMS examples referenced 'the accounts office' alongside an unofficial contact number to appear legitimate.",

    source:
      "Stage 1 Evidence Dossier, Part 1, Alert 1 — UNILUS Registration Notice, Dec 6 2025"
  }

];


/* -------------------------------------------------------------------------
   EXPORTS
   Works in the browser (script.js) and in Node (api/crawler.js)
   ------------------------------------------------------------------------- */

if (typeof module !== "undefined" && module.exports) {

  module.exports = {

    SCAM_PATTERNS: SCAM_PATTERNS,

    extractPhones: extractPhones,

    extractEmails: extractEmails,

    extractBanks: extractBanks,

    extractBankAccounts: extractBankAccounts,

    extractAccountNames: extractAccountNames,

    extractBranches: extractBranches,

    extractPaymentInstructions: extractPaymentInstructions,

    normalisePhone: normalisePhone

  };

}
