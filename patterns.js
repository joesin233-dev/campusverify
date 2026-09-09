/* =========================================================================
   CampusVerify — patterns.js
   ========================================================================= */

const PHONE_REGEX = /(?:\+?260[\s-]?|0)[79]\d(?:[\s-]?\d){7}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

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
    new Set(
      (text.match(PHONE_REGEX) || [])
    )
  );

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
    new Set(
      (text.match(EMAIL_REGEX) || [])
    )
  );
}

function extractBanks(text) {
  var lower = text.toLowerCase();

  return BANK_NAMES.filter(function (bank) {
    return lower.indexOf(
      bank.toLowerCase()
    ) !== -1;
  });
}


/* =========================================================================
   PAYMENT / BANK ACCOUNT EXTRACTION
   ========================================================================= */

/*
   Account numbers can have different lengths.

   Example official UNILUS accounts:
   0012030001876
   0012031000719
   0010221013161
   0012030002029
   1071643

   The previous regex effectively required longer numbers and could therefore
   miss 7-digit institutional accounts such as 1071643.

   We now allow 7–17 digits while still requiring an account-related label.
*/

const BANK_ACCOUNT_REGEX =
  /(?:a\/?c|acc(?:ount)?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*((?:\d[\s\-]?){6,16}\d)/gi;


/*
   Account names are only extracted when an explicit "Account Name" label
   exists. This prevents a bank name alone from being treated as proof of
   an account.
*/

const ACCOUNT_NAME_REGEX =
  /(?:account\s*name\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


/*
   Branch is only extracted when an explicit branch label exists.
*/

const BRANCH_REGEX =
  /(?:branch\s*(?:name)?\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


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

  PAYMENT_INSTRUCTION_TRIGGERS.forEach(
    function (trigger) {

      var idx = lower.indexOf(trigger);

      if (idx !== -1) {

        var start = Math.max(
          0,
          idx - 20
        );

        var snippet =
          text
            .slice(
              start,
              idx + trigger.length + 80
            )
            .replace(/\s+/g, " ")
            .trim();

        found.push(snippet);
      }
    }
  );

  return found;
}


/* =========================================================================
   TITLE EXTRACTION
   ========================================================================= */

function extractTitle(html) {
  var m =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  return m
    ? m[1]
        .replace(/\s+/g, " ")
        .trim()
    : null;
}


/* =========================================================================
   HTML → TEXT
   ========================================================================= */

function stripTags(html) {
  return html
    .replace(
      /<(script|style)[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    );
}


/* =========================================================================
   PAYMENT RECORD EXTRACTION
   ========================================================================= */

function extractPaymentRecords(
  html,
  pageUrl,
  pageTitle
) {

  var text =
    stripTags(html);

  var records = [];
  var seen = {};
  var m;

  BANK_ACCOUNT_REGEX.lastIndex = 0;

  while (
    (m = BANK_ACCOUNT_REGEX.exec(text)) !== null
  ) {

    var accountNumber =
      m[1]
        .replace(/[\s\-]/g, "");

    /*
       Prevent duplicate account numbers from the same page.
    */

    if (seen[accountNumber]) {
      continue;
    }

    seen[accountNumber] = true;


    /*
       Capture nearby text so we can identify the bank,
       account name and branch associated with the account.
    */

    var start =
      Math.max(
        0,
        m.index - 200
      );

    var end =
      Math.min(
        text.length,
        m.index + m[0].length + 200
      );

    var context =
      text
        .slice(start, end)
        .trim();


    /*
       Find bank name in the surrounding context.
    */

    var bankName =
      BANK_NAMES.filter(
        function (b) {

          return (
            context
              .toLowerCase()
              .indexOf(
                b.toLowerCase()
              ) !== -1
          );

        }
      )[0] || null;


    /*
       Find account name.
    */

    ACCOUNT_NAME_REGEX.lastIndex = 0;

    var nameMatch =
      ACCOUNT_NAME_REGEX.exec(
        context
      );

    var accountName =
      nameMatch
        ? nameMatch[1]
            .trim()
            .replace(/\s+/g, " ")
        : null;


    /*
       Find branch.
    */

    BRANCH_REGEX.lastIndex = 0;

    var branchMatch =
      BRANCH_REGEX.exec(
        context
      );

    var branch =
      branchMatch
        ? branchMatch[1]
            .trim()
            .replace(/\s+/g, " ")
        : null;


    /*
       Store the complete auditable payment record.
    */

    records.push({

      accountNumber:
        accountNumber,

      bankName:
        bankName,

      accountName:
        accountName,

      branch:
        branch,

      source:
        pageUrl,

      pageTitle:
        pageTitle,

      context:
        context,

      discoveredAt:
        new Date().toISOString()

    });
  }

  return records;
}


/* =========================================================================
   SCAM DETECTION
   ========================================================================= */

const SCAM_PATTERNS = [

  {
    id: "scam-001",

    category:
      "Fake Admission Cancellation",

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

    category:
      "Urgent Payment Pressure",

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

    category:
      "Payment Redirection",

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

    category:
      "Fake WhatsApp Group",

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

    category:
      "Unauthorized Agent / Fake Permit Agent",

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

    category:
      "Impersonating the Accounts Office",

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


/* =========================================================================
   NODE.JS EXPORTS
   ========================================================================= */

if (
  typeof module !== "undefined" &&
  module.exports
) {

  module.exports = {

    SCAM_PATTERNS:
      SCAM_PATTERNS,

    extractPhones:
      extractPhones,

    extractEmails:
      extractEmails,

    extractBanks:
      extractBanks,

    extractPaymentInstructions:
      extractPaymentInstructions,

    extractTitle:
      extractTitle,

    extractPaymentRecords:
      extractPaymentRecords,

    normalisePhone:
      normalisePhone

  };
}
