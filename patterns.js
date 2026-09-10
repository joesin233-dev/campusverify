/* =========================================================================
   CampusVerify — patterns.js
   -------------------------------------------------------------------------
   Extraction patterns for:
   - Zambian mobile phone numbers
   - Zambian landline numbers
   - Email addresses
   - Bank names
   - Bank account numbers
   - Payment records
   - Payment instructions
   ========================================================================= */


/* =========================================================================
   PHONE NUMBERS
   -------------------------------------------------------------------------
   Supports:

   Mobile:
   0971263550
   0971 263 550
   +260 971 263 550
   +260971263550

   Landline:
   0211233407
   0211 233 407
   +260 211 233 407
   +260211233407
   ========================================================================= */

const PHONE_REGEX =
  /(?:\+?260[\s-]?(?:2\d{2}|[79]\d{2})[\s-]?\d{3}[\s-]?\d{3}|0(?:2\d{2}|[79]\d{2})[\s-]?\d{3}[\s-]?\d{3})/g;


/* =========================================================================
   EMAIL
   ========================================================================= */

const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;


/* =========================================================================
   BANK NAMES
   ========================================================================= */

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


/* =========================================================================
   PHONE NORMALISATION
   ========================================================================= */

function normalisePhone(value) {
  var digits =
    String(value || "")
      .replace(/\D/g, "");

  if (
    digits.indexOf("260") === 0
  ) {
    digits =
      digits.slice(3);
  }

  /*
   * Keep Zambia's domestic leading 0 out of the
   * internal comparison value.
   */
  if (
    digits.indexOf("0") === 0
  ) {
    digits =
      digits.slice(1);
  }

  return digits;
}


/* =========================================================================
   EXTRACT PHONES
   ========================================================================= */

function extractPhones(text) {
  var raw =
    Array.from(
      new Set(
        String(text || "")
          .match(PHONE_REGEX) || []
      )
    );

  var seen = {};

  return raw.filter(
    function (phone) {
      var normalised =
        normalisePhone(phone);

      if (
        seen[normalised]
      ) {
        return false;
      }

      /*
       * Zambian phone numbers after
       * removing country/leading zero:
       *
       * 9 digits.
       */
      if (
        normalised.length !== 9
      ) {
        return false;
      }

      seen[normalised] = true;

      return true;
    }
  );
}


/* =========================================================================
   EXTRACT EMAILS
   ========================================================================= */

function extractEmails(text) {
  return Array.from(
    new Set(
      String(text || "")
        .match(EMAIL_REGEX) || []
    )
  );
}


/* =========================================================================
   EXTRACT BANK NAMES
   ========================================================================= */

function extractBanks(text) {
  var lower =
    String(text || "")
      .toLowerCase();

  return BANK_NAMES.filter(
    function (bank) {
      return (
        lower.indexOf(
          bank.toLowerCase()
        ) !== -1
      );
    }
  );
}


/* =========================================================================
   BANK ACCOUNT NUMBER PATTERNS
   ========================================================================= */

const BANK_ACCOUNT_REGEX =
  /(?:a\/?c|acc(?:ount)?)\s*(?:no\.?|number|#)?\s*[:\-]?\s*((?:\d[\s\-]?){6,16}\d)/gi;


/* =========================================================================
   ACCOUNT NAME
   ========================================================================= */

const ACCOUNT_NAME_REGEX =
  /(?:account\s*name\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


/* =========================================================================
   BRANCH
   ========================================================================= */

const BRANCH_REGEX =
  /(?:branch\s*(?:name)?\s*[:\-]?\s*)([A-Za-z][A-Za-z .&'\-]{2,60}?)(?=\.|(?:a\/?c|acc(?:ount)?|branch)\b|$)/gi;


/* =========================================================================
   PAYMENT INSTRUCTION TRIGGERS
   ========================================================================= */

const PAYMENT_INSTRUCTION_TRIGGERS = [
  "pay to",
  "payment should be made to",
  "payments must be made",
  "make payment to",
  "deposit to",
  "deposit into",
  "pay into",
  "payments can be made",
  "payment can be made",
  "pay via",
  "payment via",
  "bank transfer",
  "bank deposit",
  "use the following account"
];


/* =========================================================================
   EXTRACT PAYMENT INSTRUCTIONS
   ========================================================================= */

function extractPaymentInstructions(text) {
  var source =
    String(text || "");

  var sentences =
    source
      .split(
        /(?<=[.!?])\s+|\n+/
      )
      .map(
        function (part) {
          return part
            .replace(
              /\s+/g,
              " "
            )
            .trim();
        }
      )
      .filter(Boolean);

  var results = [];

  sentences.forEach(
    function (sentence) {
      var lower =
        sentence.toLowerCase();

      var matched =
        PAYMENT_INSTRUCTION_TRIGGERS.some(
          function (trigger) {
            return (
              lower.indexOf(
                trigger
              ) !== -1
            );
          }
        );

      if (
        matched &&
        sentence.length <= 1000
      ) {
        results.push(
          sentence
        );
      }
    }
  );

  return Array.from(
    new Set(results)
  );
}


/* =========================================================================
   EXTRACT PAGE TITLE
   ========================================================================= */

function extractTitle(html) {
  var match =
    String(html || "")
      .match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
      );

  if (!match) {
    return "";
  }

  return match[1]
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* =========================================================================
   STRIP HTML
   ========================================================================= */

function stripTags(html) {
  return String(html || "")
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
   NORMALISE BANK NAME
   ========================================================================= */

function normaliseBankName(value) {
  var lower =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    lower.indexOf("zanaco") !== -1
  ) {
    return "Zanaco";
  }

  if (
    lower.indexOf("indo-zambia") !== -1 ||
    lower.indexOf("indo zambia") !== -1
  ) {
    return "Indo-Zambia Bank";
  }

  if (
    lower.indexOf("access bank") !== -1
  ) {
    return "Access Bank";
  }

  if (
    lower.indexOf("absa") !== -1
  ) {
    return "ABSA";
  }

  if (
    lower.indexOf("stanbic") !== -1
  ) {
    return "Stanbic";
  }

  if (
    lower.indexOf("fnb") !== -1
  ) {
    return "FNB";
  }

  if (
    lower.indexOf("standard chartered") !== -1
  ) {
    return "Standard Chartered";
  }

  if (
    lower.indexOf("first capital") !== -1
  ) {
    return "First Capital";
  }

  if (
    lower.indexOf("atlas mara") !== -1
  ) {
    return "Atlas Mara";
  }

  return String(value || "")
    .trim();
}


/* =========================================================================
   EXTRACT POSSIBLE ACCOUNT NUMBERS
   ========================================================================= */

function extractAccountNumbersFromText(value) {
  var text =
    String(value || "");

  var matches = [];

  var regex =
    /(?:\d[\s\-]?){6,16}\d/g;

  var match;

  while (
    (match = regex.exec(text)) !== null
  ) {
    var raw =
      match[0];

    var digits =
      raw.replace(
        /\D/g,
        ""
      );

    /*
     * Account numbers:
     * - minimum 7 digits
     * - maximum 18 digits
     *
     * This deliberately does NOT treat
     * short values such as 6038 as bank
     * account numbers.
     */
    if (
      digits.length >= 7 &&
      digits.length <= 18
    ) {
      matches.push(
        digits
      );
    }
  }

  return Array.from(
    new Set(matches)
  );
}


/* =========================================================================
   CLEAN TABLE CELL
   ========================================================================= */

function cleanTableCell(cellHtml) {
  return stripTags(
    cellHtml
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


/* =========================================================================
   EXTRACT PAYMENT RECORDS FROM HTML TABLES
   ========================================================================= */

function extractPaymentRecordsFromTables(
  html,
  pageUrl,
  pageTitle,
  addRecord
) {
  if (
    !/<table\b/i.test(
      String(html || "")
    )
  ) {
    return 0;
  }

  var tables =
    String(html || "")
      .match(
        /<table\b[\s\S]*?<\/table>/gi
      ) || [];

  var recordsFound = 0;

  tables.forEach(
    function (tableHtml) {
      var rows =
        tableHtml.match(
          /<tr\b[\s\S]*?<\/tr>/gi
        ) || [];

      if (
        rows.length === 0
      ) {
        return;
      }

      var tableRows = [];

      rows.forEach(
        function (rowHtml) {
          var cells =
            rowHtml.match(
              /<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi
            ) || [];

          var cleaned =
            cells.map(
              cleanTableCell
            );

          if (
            cleaned.length > 0
          ) {
            tableRows.push(
              cleaned
            );
          }
        }
      );

      if (
        tableRows.length === 0
      ) {
        return;
      }


      /* ---------------------------------------------------------------
         Find likely header row.
         --------------------------------------------------------------- */

      var headerIndex = -1;

      for (
        var i = 0;
        i < tableRows.length;
        i++
      ) {
        var joined =
          tableRows[i]
            .join(" ")
            .toLowerCase();

        if (
          /bank|account|branch|payment|currency/.test(
            joined
          )
        ) {
          headerIndex = i;
          break;
        }
      }


      var headers =
        headerIndex >= 0
          ? tableRows[
              headerIndex
            ].map(
              function (value) {
                return value
                  .toLowerCase()
                  .trim();
              }
            )
          : [];


      /* ---------------------------------------------------------------
         Process each row.
         --------------------------------------------------------------- */

      tableRows.forEach(
        function (row, rowIndex) {
          if (
            rowIndex ===
            headerIndex
          ) {
            return;
          }

          var rowText =
            row.join(" ");

          var accounts =
            extractAccountNumbersFromText(
              rowText
            );

          if (
            accounts.length === 0
          ) {
            return;
          }


          /* -----------------------------------------------------------
             Try to determine bank.
             ----------------------------------------------------------- */

          var bankName = "";

          row.forEach(
            function (cell) {
              var normalised =
                normaliseBankName(
                  cell
                );

              if (
                BANK_NAMES.some(
                  function (bank) {
                    return (
                      normalised ===
                      bank
                    );
                  }
                )
              ) {
                bankName =
                  normalised;
              }
            }
          );


          /* -----------------------------------------------------------
             Determine columns.
             ----------------------------------------------------------- */

          var bankIndex = -1;
          var accountIndex = -1;
          var branchIndex = -1;
          var currencyIndex = -1;
          var nameIndex = -1;

          headers.forEach(
            function (
              header,
              index
            ) {
              if (
                /bank/.test(
                  header
                )
              ) {
                bankIndex =
                  index;
              }

              if (
                /account/.test(
                  header
                )
              ) {
                accountIndex =
                  index;
              }

              if (
                /branch/.test(
                  header
                )
              ) {
                branchIndex =
                  index;
              }

              if (
                /currency/.test(
                  header
                )
              ) {
                currencyIndex =
                  index;
              }

              if (
                /account\s*name|name/.test(
                  header
                )
              ) {
                nameIndex =
                  index;
              }
            }
          );


          if (
            bankIndex >= 0 &&
            row[bankIndex]
          ) {
            var headerBank =
              normaliseBankName(
                row[bankIndex]
              );

            if (
              BANK_NAMES.some(
                function (bank) {
                  return (
                    headerBank ===
                    bank
                  );
                }
              )
            ) {
              bankName =
                headerBank;
            }
          }


          var branch =
            branchIndex >= 0
              ? row[branchIndex] || ""
              : "";

          var accountName =
            nameIndex >= 0
              ? row[nameIndex] || ""
              : "";

          var currency =
            currencyIndex >= 0
              ? row[currencyIndex] || ""
              : "";


          accounts.forEach(
            function (
              accountNumber
            ) {
              var context =
                rowText;

              if (
                currency
              ) {
                context +=
                  " Currency: " +
                  currency;
              }

              addRecord({
                accountNumber:
                  accountNumber,

                bankName:
                  bankName,

                accountName:
                  accountName,

                branch:
                  branch,

                context:
                  context,

                source:
                  pageUrl,

                pageTitle:
                  pageTitle
              });

              recordsFound++;
            }
          );
        }
      );
    }
  );

  return recordsFound;
}


/* =========================================================================
   EXTRACT PAYMENT RECORDS
   -------------------------------------------------------------------------
   IMPORTANT:
   This function accepts either:
   - original HTML
   - plain text from PDFs/OCR
   ========================================================================= */

function extractPaymentRecords(
  html,
  pageUrl,
  pageTitle
) {
  var source =
    String(html || "");

  var records = [];

  function addRecord(record) {
    if (
      !record ||
      !record.accountNumber
    ) {
      return;
    }

    var accountNumber =
      String(
        record.accountNumber
      ).replace(
        /\D/g,
        ""
      );

    if (
      accountNumber.length < 7
    ) {
      return;
    }

    var exists =
      records.some(
        function (existing) {
          return (
            existing.accountNumber ===
            accountNumber
          );
        }
      );

    if (exists) {
      return;
    }

    record.accountNumber =
      accountNumber;

    records.push(
      record
    );
  }


  /*
   * Detect whether this is HTML.
   */
  var isHtml =
    /<html\b|<body\b|<table\b|<div\b|<p\b/i.test(
      source
    );


  var text =
    isHtml
      ? stripTags(source)
      : source;


  /* -----------------------------------------------------------------------
     TABLE EXTRACTION
     ----------------------------------------------------------------------- */

  if (isHtml) {
    extractPaymentRecordsFromTables(
      source,
      pageUrl,
      pageTitle,
      addRecord
    );
  }


  /* -----------------------------------------------------------------------
     LABELED ACCOUNT NUMBERS
     ----------------------------------------------------------------------- */

  var accountRegex =
    new RegExp(
      BANK_ACCOUNT_REGEX.source,
      "gi"
    );

  var accountMatch;

  while (
    (accountMatch =
      accountRegex.exec(text)) !== null
  ) {
    var accountNumber =
      String(
        accountMatch[1] || ""
      ).replace(
        /\D/g,
        ""
      );

    if (
      accountNumber.length < 7
    ) {
      continue;
    }


    /*
     * Look around the account number
     * instead of the entire document.
     * This reduces incorrect bank matching.
     */

    var start =
      Math.max(
        0,
        accountMatch.index - 500
      );

    var end =
      Math.min(
        text.length,
        accountMatch.index +
          accountMatch[0].length +
          500
      );

    var context =
      text.slice(
        start,
        end
      );


    var bankName = "";

    BANK_NAMES.forEach(
      function (bank) {
        if (
          context
            .toLowerCase()
            .indexOf(
              bank.toLowerCase()
            ) !== -1 &&
          !bankName
        ) {
          bankName =
            bank;
        }
      }
    );


    var accountName = "";
    var branch = "";


    var accountNameRegex =
      new RegExp(
        ACCOUNT_NAME_REGEX.source,
        "i"
      );

    var accountNameMatch =
      accountNameRegex.exec(
        context
      );

    if (
      accountNameMatch
    ) {
      accountName =
        accountNameMatch[1]
          .trim();
    }


    var branchRegex =
      new RegExp(
        BRANCH_REGEX.source,
        "i"
      );

    var branchMatch =
      branchRegex.exec(
        context
      );

    if (
      branchMatch
    ) {
      branch =
        branchMatch[1]
          .trim();
    }


    addRecord({
      accountNumber:
        accountNumber,

      bankName:
        bankName,

      accountName:
        accountName,

      branch:
        branch,

      context:
        context,

      source:
        pageUrl,

      pageTitle:
        pageTitle
    });
  }


  /* -----------------------------------------------------------------------
     SECONDARY PASS:
     Account-looking numbers near bank names.
     ----------------------------------------------------------------------- */

  BANK_NAMES.forEach(
    function (bank) {
      var lowerBank =
        bank.toLowerCase();

      var lowerText =
        text.toLowerCase();

      var searchStart = 0;

      while (true) {
        var bankIndex =
          lowerText.indexOf(
            lowerBank,
            searchStart
          );

        if (
          bankIndex === -1
        ) {
          break;
        }

        var localStart =
          Math.max(
            0,
            bankIndex - 400
          );

        var localEnd =
          Math.min(
            text.length,
            bankIndex + 800
          );

        var localText =
          text.slice(
            localStart,
            localEnd
          );

        var nearbyAccounts =
          extractAccountNumbersFromText(
            localText
          );

        nearbyAccounts.forEach(
          function (
            accountNumber
          ) {
            addRecord({
              accountNumber:
                accountNumber,

              bankName:
                bank,

              accountName:
                "",

              branch:
                "",

              context:
                localText,

              source:
                pageUrl,

              pageTitle:
                pageTitle
            });
          }
        );

        searchStart =
          bankIndex +
          lowerBank.length;
      }
    }
  );


  return records;
}


/* =========================================================================
   SCAM / SUSPICIOUS PATTERNS
   ========================================================================= */

const SCAM_PATTERNS = [
  "urgent payment",
  "send money immediately",
  "pay immediately",
  "guaranteed admission",
  "guaranteed acceptance",
  "send your password",
  "send your pin",
  "send your otp",
  "one time password",
  "otp code",
  "verification code"
];


/* =========================================================================
   EXPORTS
   ========================================================================= */

module.exports = {
  SCAM_PATTERNS,

  extractPhones,

  extractEmails,

  extractBanks,

  extractPaymentInstructions,

  extractTitle,

  extractPaymentRecords,

  normalisePhone
};
