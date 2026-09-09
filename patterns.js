/* =========================================================================
   CampusVerify — patterns.js (strengthened)
   ========================================================================= */

const PHONE_REGEX = /(?:+?260[s-]?|0)[79]d(?:[s-]?d){7}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}/g;

const BANK_NAMES = [
  "Zanaco",
  "Indo-Zambia Bank",
  "Indo Zambia Bank",
  "Indozambia",
  "Access Bank",
  "ABSA",
  "Stanbic",
  "FNB",
  "Standard Chartered",
  "First Capital",
  "Atlas Mara"
];

function normalisePhone(value) {
  var digits = (value || "").replace(/D/g, "");
  if (digits.indexOf("260") === 0) digits = digits.slice(3);
  if (digits.indexOf("0") === 0) digits = digits.slice(1);
  return digits;
}

function extractPhones(text) {
  var raw = Array.from(new Set((text.match(PHONE_REGEX) || [])));
  var seen = {};
  return raw.filter(function (p) {
    var norm = normalisePhone(p);
    if (seen[norm]) return false;
    seen[norm] = true;
    return norm.length === 9;
  });
}

function extractEmails(text) {
  return Array.from(new Set((text.match(EMAIL_REGEX) || [])));
}

function extractBanks(text) {
  var lower = text.toLowerCase();
  return BANK_NAMES.filter(function (bank) {
    return lower.indexOf(bank.toLowerCase()) !== -1;
  });
}

function stripTags(html) {
  return html
    .replace(/<(script|style)[sS]*?</\u0001>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/s+/g, " ");
}

/*
 * Stronger bank account regexes.
 */

/* Pattern 1: "Account Number: XXX", "A/C: XXX", "Acc No: XXX" */
const BANK_ACCOUNT_REGEX =
  /(?:a/?c|acc(?:ount)?)s*(?:no.?|number|#)?s*[:-]?s*((?:d[s-]?){8,16}d)/gi;

/* Pattern 2: Standalone 8–16 digit numbers near bank/payment keywords */
const STANDALONE_ACCOUNT_REGEX =
  /(?:bank|payment|fee|fees|tuition|deposit|pay|accounts?|bursar)[sS]{0,250}?(d{8,16})/gi;

/* Pattern 3: Table-like: "Account Name ... Account Number ... digits" */
const TABLE_ACCOUNT_REGEX =
  /(?:accounts*name[sS]{0,150}?)(?:accounts*(?:number|no.?)[sS]{0,100}?)(d{8,16})/gi;

const ACCOUNT_NAME_REGEX =
  /(?:accounts*names*[:-]?s*)([A-Za-z][A-Za-z .&'-]{2,80}?)(?=.|(?:a/?c|acc(?:ount)?|branch|accounts*number)\b|$)/gi;

const BRANCH_REGEX =
  /(?:branchs*(?:name)?s*[:-]?s*)([A-Za-z][A-Za-z .&'-]{2,80}?)(?=.|(?:a/?c|acc(?:ount)?|branch)\b|$)/gi;

const PAYMENT_INSTRUCTION_TRIGGERS = [
  "pay to",
  "payment should be made to",
  "payments must be made",
  "make payment to",
  "deposit to"
];

function extractPaymentInstructions(text) {
  var lower = text.toLowerCase();
  var found = [];

  PAYMENT_INSTRUCTION_TRIGGERS.forEach(function (trigger) {
    var idx = lower.indexOf(trigger);
    if (idx !== -1) {
      var start = Math.max(0, idx - 20);
      var snippet = text
        .slice(start, idx + trigger.length + 80)
        .replace(/s+/g, " ")
        .trim();
      found.push(snippet);
    }
  });

  return found;
}

function extractTitle(html) {
  var m = html.match(/<title[^>]*>([sS]*?)</title>/i);
  return m ? m[1].replace(/s+/g, " ").trim() : null;
}

function extractPaymentRecords(html, pageUrl, pageTitle) {
  var text = stripTags(html);
  var records = [];
  var seen = {};
  var m;

  /*
   * Helper to create a record if not already seen.
   */
  function addRecord(accountNumber, context) {
    if (!accountNumber) return;

    var norm = accountNumber.replace(/D/g, "");
    if (!norm || norm.length < 8 || norm.length > 16) return;

    if (seen[norm]) return;
    seen[norm] = true;

    var bankName = null;
    var lowerContext = context.toLowerCase();

    for (var i = 0; i < BANK_NAMES.length; i++) {
      var b = BANK_NAMES[i];
      if (lowerContext.indexOf(b.toLowerCase()) !== -1) {
        bankName = b;
        break;
      }
    }

    ACCOUNT_NAME_REGEX.lastIndex = 0;
    var nameMatch = ACCOUNT_NAME_REGEX.exec(context);
    var accountName = nameMatch
      ? nameMatch[1].trim().replace(/s+/g, " ")
      : null;

    BRANCH_REGEX.lastIndex = 0;
    var branchMatch = BRANCH_REGEX.exec(context);
    var branch = branchMatch
      ? branchMatch[1].trim().replace(/s+/g, " ")
      : null;

    records.push({
      accountNumber: norm,
      bankName: bankName,
      accountName: accountName,
      branch: branch,
      source: pageUrl,
      pageTitle: pageTitle,
      context: context,
      discoveredAt: new Date().toISOString()
    });
  }

  /*
   * Pattern 1: explicit "Account Number" style matches.
   */
  BANK_ACCOUNT_REGEX.lastIndex = 0;
  while ((m = BANK_ACCOUNT_REGEX.exec(text)) !== null) {
    var accountNumber = m[1].replace(/[s-]/g, "");

    var start = Math.max(0, m.index - 250);
    var end = Math.min(text.length, m.index + m[0].length + 250);
    var context = text.slice(start, end).trim();

    addRecord(accountNumber, context);
  }

  /*
   * Pattern 2: standalone digit sequences near bank/payment keywords.
   */
  STANDALONE_ACCOUNT_REGEX.lastIndex = 0;
  while ((m = STANDALONE_ACCOUNT_REGEX.exec(text)) !== null) {
    var accountNumber = m[1];

    var start = Math.max(0, m.index - 250);
    var end = Math.min(text.length, m.index + m[0].length + 250);
    var context = text.slice(start, end).trim();

    addRecord(accountNumber, context);
  }

  /*
   * Pattern 3: table-like structures.
   */
  TABLE_ACCOUNT_REGEX.lastIndex = 0;
  while ((m = TABLE_ACCOUNT_REGEX.exec(text)) !== null) {
    var accountNumber = m[1];

    var start = Math.max(0, m.index - 300);
    var end = Math.min(text.length, m.index + m[0].length + 300);
    var context = text.slice(start, end).trim();

    addRecord(accountNumber, context);
  }

  return records;
}

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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCAM_PATTERNS: SCAM_PATTERNS,
    extractPhones: extractPhones,
    extractEmails: extractEmails,
    extractBanks: extractBanks,
    extractPaymentInstructions: extractPaymentInstructions,
    extractTitle: extractTitle,
    extractPaymentRecords: extractPaymentRecords,
    normalisePhone: normalisePhone
  };
}
