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

   Examples:
   0012030001876
   0012031000719
   0010221013161
   0012030002029
   1071643
   001-1071643
*/

const BANK_ACCOUNT_REGEX =
  /(?:a\/?c|acc(?:ount)?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*((?:\d[\s\-]?){6,16}\d)/gi;


/*
   Account names are only extracted when an explicit
   "Account Name" label exists.
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

/*
   Convert a bank label into our standard bank name.

   This also handles tables that write "INDO" instead of
   "Indo-Zambia Bank".
*/

function normaliseBankName(value) {

  var text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!text) {
    return null;
  }

  if (
    text.indexOf("indo-zambia") !== -1 ||
    text === "indo" ||
    text.indexOf("indo bank") !== -1
  ) {
    return "Indo-Zambia Bank";
  }

  for (var i = 0; i < BANK_NAMES.length; i++) {

    if (
      text.indexOf(
        BANK_NAMES[i].toLowerCase()
      ) !== -1
    ) {
      return BANK_NAMES[i];
    }
  }

  return null;
}


/*
   Extract account-number-looking values from one piece of text.
*/

function extractAccountNumbersFromText(value) {

  var text = String(value || "");
  var matches = [];
  var regex = /(?:\d[\s\-]?){6,16}\d/g;
  var m;

  while ((m = regex.exec(text)) !== null) {

    var raw = m[0];

    var cleaned = raw
      .replace(/[\s\-]/g, "");

    if (
      cleaned.length >= 7 &&
      cleaned.length <= 17
    ) {
      matches.push({
        raw: raw,
        value: cleaned
      });
    }
  }

  return matches;
}


/*
   Extract a value from a table cell.
*/

function cleanTableCell(cellHtml) {

  return stripTags(cellHtml)
    .replace(/\s+/g, " ")
    .trim();
}


/*
   IMPORTANT:
   Many institutional websites publish bank information
   as an HTML table.

   Example:

   Bank            ABSA        INDO
   Branch          Head Office INDO
   Account Name    University  University
   Account Number  001-107...  001203...

   After stripTags(), the column relationship disappears.

   This function reads the actual table structure before
   flattening it, so each account stays attached to the
   correct bank column.
*/

function extractPaymentRecordsFromTables(
  html,
  pageUrl,
  pageTitle,
  addRecord
) {

  if (!/<table\b/i.test(html)) {
    return 0;
  }

  var tables =
    html.match(
      /<table\b[\s\S]*?<\/table>/gi
    ) || [];

  var count = 0;

  tables.forEach(function (tableHtml) {

    var rowMatches =
      tableHtml.match(
        /<tr\b[\s\S]*?<\/tr>/gi
      ) || [];

    var rows = [];

    rowMatches.forEach(function (rowHtml) {

      var cellMatches =
        rowHtml.match(
          /<t[dh]\b[\s\S]*?<\/t[dh]>/gi
        ) || [];

      if (!cellMatches.length) {
        return;
      }

      var cells = cellMatches.map(
        cleanTableCell
      );

      rows.push(cells);
    });


    /*
       Find the bank row.

       We look for a row containing known
       bank names or an INDO abbreviation.
    */

    var bankRow = null;

    rows.forEach(function (row) {

      if (bankRow) {
        return;
      }

      var banksFound = row.some(
        function (cell) {
          return !!normaliseBankName(cell);
        }
      );

      if (banksFound) {
        bankRow = row;
      }
    });


    /*
       Find the Account Number row.
    */

    var accountRow = null;

    rows.forEach(function (row) {

      if (accountRow) {
        return;
      }

      var firstCell =
        String(row[0] || "")
          .toLowerCase();

      if (
        firstCell.indexOf("account number") !== -1 ||
        firstCell.indexOf("account no") !== -1 ||
        firstCell === "a/c" ||
        firstCell.indexOf("a/c number") !== -1
      ) {
        accountRow = row;
      }
    });


    /*
       If we have both rows, pair them by column.
    */

    if (
      bankRow &&
      accountRow
    ) {

      for (
        var column = 1;
        column < accountRow.length;
        column++
      ) {

        var accountCell =
          accountRow[column] || "";

        var accountValues =
          extractAccountNumbersFromText(
            accountCell
          );

        if (!accountValues.length) {
          continue;
        }

        var bankCell =
          bankRow[column] || "";

        var bankName =
          normaliseBankName(
            bankCell
          );


        /*
           If the bank cell is empty, don't guess.
        */

        if (!bankName) {
          continue;
        }


        /*
           Find the account name and branch
           from the same column where possible.
        */

        var accountName = null;
        var branch = null;

        rows.forEach(function (row) {

          var label =
            String(row[0] || "")
              .toLowerCase();

          var value =
            row[column] || "";

          if (
            label.indexOf("account name") !== -1
          ) {
            accountName = value || null;
          }

          if (
            label === "branch" ||
            label.indexOf("branch name") !== -1
          ) {
            branch = value || null;
          }
        });


        accountValues.forEach(
          function (account) {

            addRecord(
              account.value,
              bankName,
              accountName,
              branch,
              account.raw,
              stripTags(
                accountCell
              )
            );

            count++;
          }
        );
      }
    }
  });

  return count;
}


/*
   Main payment-record extractor.

   Strategy:

   1. Read real HTML tables when available.
      This preserves bank/account relationships.

   2. For PDFs and plain extracted text,
      associate an account with the nearest bank
      in the relevant text section.

   3. NEVER select a bank simply because it appears
      somewhere inside a large 200-character window.
*/

function extractPaymentRecords(
  html,
  pageUrl,
  pageTitle
) {

  var isHtml =
    /<html\b|<body\b|<table\b|<div\b|<p\b/i.test(
      String(html || "")
    );

  var text =
    stripTags(html);

  var records = [];
  var seen = {};


  /*
     Store a complete auditable payment record.
  */

  function addRecord(
    accountNumber,
    bankName,
    accountName,
    branch,
    publishedAccountNumber,
    context
  ) {

    var cleaned =
      String(accountNumber || "")
        .replace(/[\s\-]/g, "")
        .trim();

    if (!cleaned) {
      return;
    }

    /*
       Keep duplicate records out.
    */

    var key =
      cleaned +
      "|" +
      String(bankName || "").toLowerCase();

    if (seen[key]) {
      return;
    }

    seen[key] = true;


    records.push({

      accountNumber:
        cleaned,

      /*
         Preserve the exact published formatting
         when we have it.
      */

      publishedAccountNumber:
        publishedAccountNumber ||
        cleaned,

      bankName:
        bankName || null,

      accountName:
        accountName || null,

      branch:
        branch || null,

      source:
        pageUrl,

      pageTitle:
        pageTitle,

      context:
        context || "",

      discoveredAt:
        new Date().toISOString()

    });
  }


  /* =======================================================================
     STEP 1 — REAL HTML TABLES
     ======================================================================= */

  if (isHtml) {

    extractPaymentRecordsFromTables(
      html,
      pageUrl,
      pageTitle,
      addRecord
    );
  }


  /* =======================================================================
     STEP 2 — TEXT / PDF EXTRACTION
     ======================================================================= */

  /*
     If the table parser found nothing, use the extracted
     text representation.

     This is especially important for PDF documents.
  */

  if (records.length === 0) {

    BANK_ACCOUNT_REGEX.lastIndex = 0;

    var m;

    while (
      (m = BANK_ACCOUNT_REGEX.exec(text)) !== null
    ) {

      var publishedAccount =
        m[1];

      var accountNumber =
        publishedAccount
          .replace(/[\s\-]/g, "");


      /*
         Look backwards for the nearest bank.

         This is deliberately different from the old
         200-character "first bank found" logic.
      */

      var before =
        text.slice(
          0,
          m.index
        );

      var bankMatches = [];

      var bankRegex =
        /Zanaco|Indo-Zambia Bank|Access Bank|ABSA|Stanbic|FNB|Standard Chartered|First Capital|Atlas Mara/gi;

      var bankMatch;

      while (
        (bankMatch =
          bankRegex.exec(before)) !== null
      ) {

        bankMatches.push({
          name:
            normaliseBankName(
              bankMatch[0]
            ),

          index:
            bankMatch.index
        });
      }


      var bankName = null;

      if (bankMatches.length) {

        bankName =
          bankMatches[
            bankMatches.length - 1
          ].name;
      }


      /*
         Context is kept for auditing, but is NOT used
         to choose the bank.
      */

      var start =
        Math.max(
          0,
          m.index - 200
        );

      var end =
        Math.min(
          text.length,
          m.index +
          m[0].length +
          200
        );

      var context =
        text
          .slice(
            start,
            end
          )
          .trim();


      /*
         Extract account name.
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
         Extract branch.
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


      addRecord(
        accountNumber,
        bankName,
        accountName,
        branch,
        publishedAccount,
        context
      );
    }
  }


  /* =======================================================================
     STEP 3 — SECONDARY TEXT PASS
     ======================================================================= */

  /*
     Some PDF/table extraction engines produce:

       Account Number 001-1071643 0012031000719

     instead of repeating "Account Number".

     If the first pass only found one account, inspect
     the immediate Account Number section for additional
     account-number-looking values.

     We do NOT run this globally because that could
     accidentally treat phone numbers or unrelated
     numbers as bank accounts.
  */

  var accountLabelRegex =
    /(?:account\s+number|account\s+no\.?|a\/c\s+number|a\/c\s+no\.?)/gi;

  var labelMatch;

  while (
    (labelMatch =
      accountLabelRegex.exec(text)) !== null
  ) {

    var sectionStart =
      labelMatch.index +
      labelMatch[0].length;

    var sectionEnd =
      Math.min(
        text.length,
        sectionStart + 180
      );

    var section =
      text.slice(
        sectionStart,
        sectionEnd
      );


    /*
       Stop at obvious next-field labels.
    */

    var stopMatch =
      section.search(
        /\b(?:swift\s+code|currency|sort\s+code|branch\s+code|student\s+number)\b/i
      );

    if (stopMatch !== -1) {
      section =
        section.slice(
          0,
          stopMatch
        );
    }


    var accountValues =
      extractAccountNumbersFromText(
        section
      );

    if (accountValues.length <= 1) {
      continue;
    }


    /*
       Try to determine bank columns from the
       surrounding text.

       We use the order of bank names in the
       nearest relevant area rather than the global
       BANK_NAMES array order.
    */

    var surroundingStart =
      Math.max(
        0,
        labelMatch.index - 300
      );

    var surrounding =
      text.slice(
        surroundingStart,
        labelMatch.index
      );

    var surroundingBanks = [];

    var surroundingBankRegex =
      /Zanaco|Indo-Zambia Bank|Access Bank|ABSA|Stanbic|FNB|Standard Chartered|First Capital|Atlas Mara/gi;

    var sb;

    while (
      (sb =
        surroundingBankRegex.exec(
          surrounding
        )) !== null
    ) {

      surroundingBanks.push(
        normaliseBankName(
          sb[0]
        )
      );
    }


    /*
       If there are exactly as many bank names
       as account numbers, pair them by order.
    */

    if (
      surroundingBanks.length ===
      accountValues.length
    ) {

      accountValues.forEach(
        function (account, index) {

          addRecord(
            account.value,
            surroundingBanks[index],
            null,
            null,
            account.raw,
            text.slice(
              surroundingStart,
              Math.min(
                text.length,
                sectionStart + 180
              )
            ).trim()
          );
        }
      );
    }
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
