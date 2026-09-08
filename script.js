/* =========================================================================
   CampusVerify v3.1 — script.js
   -----------------------------------------------------------------------
   New in v3: the flow starts with the student pasting their institution's
   OFFICIAL WEBSITE, not picking from a list. getInstitutionByUrl() (in
   institutions.js) matches it against the whitelist — nothing is fetched
   or trusted until that match succeeds.

   v3.1 payment verification:
   - Bank account, account name and branch are linked together in
     paymentRecords.
   - A bank account is considered published only when the actual account
     record was found on the institution's official source.
   - A bank-name-only match does NOT prove that a specific account belongs
     to the institution.
   - Every payment record retains its source URL, title and context.
   ========================================================================= */

(function () {
  "use strict";

  var currentInstitutionId = null;
  var crawlCache = {};
  var crawlInFlight = {};

  /* ---------- Step 1: identify institution from URL ---------- */

  var identifyForm = document.getElementById("identify-form");
  var identifyInput = document.getElementById("identify-url-input");
  var identifyError = document.getElementById("identify-error");
  var identifiedCard = document.getElementById("institution-identified-card");
  var identifiedName = document.getElementById("institution-identified-name");
  var stepIdentify = document.getElementById("step-identify");
  var stepChooseType = document.getElementById("step-choose-type");
  var changeInstitutionBtn = document.getElementById("change-institution-btn");

  var identifiedDomain = document.getElementById("institution-identified-domain");
  var visitSiteBtn = document.getElementById("visit-official-site-btn");
  var verifyNowBtn = document.getElementById("verify-something-now-btn");
  var statusBadge = document.getElementById("institution-status-badge");

  var STATUS_BADGE_TEXT = {
    partner: "✓ CampusVerify Partner Institution",
    pilot: "✓ CampusVerify Pilot Institution"
  };

  function setInstitution(inst) {
    currentInstitutionId = inst.id;

    identifiedName.textContent = inst.name;
    identifiedDomain.textContent = inst.domain;

    visitSiteBtn.href = "https://" + inst.domain;

    statusBadge.textContent =
      STATUS_BADGE_TEXT[inst.status] ||
      "✓ CampusVerify Supported Institution";

    identifiedCard.hidden = false;
    stepIdentify.hidden = true;

    // stays hidden until "Verify Something Now" is pressed
    stepChooseType.hidden = true;

    identifyError.hidden = true;

    hideResultCard();

    crawlInstitution(currentInstitutionId).then(function () {
      renderInfoBody();
    });
  }

  if (verifyNowBtn) {
    verifyNowBtn.addEventListener("click", function () {
      stepChooseType.hidden = false;
      stepChooseType.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  if (identifyForm) {
    identifyForm.addEventListener("submit", function (event) {
      event.preventDefault();

      var raw = identifyInput.value.trim();

      if (!raw) {
        identifyError.textContent =
          "Please enter your institution's website first.";
        identifyError.hidden = false;
        return;
      }

      var candidate =
        /^https?:\/\//i.test(raw) ? raw : "https://" + raw;

      var parsedOk = true;

      try {
        new URL(candidate);
      } catch (e) {
        parsedOk = false;
      }

      if (!parsedOk) {
        identifyError.textContent =
          "That doesn't look like a valid website address. Try something like https://www.unilus.ac.zm";
        identifyError.hidden = false;
        return;
      }

      var inst = getInstitutionByUrl(raw);

      if (!inst) {
        identifyError.textContent =
          "CampusVerify doesn't support this institution yet. Only licensed/pilot institutions can be checked.";
        identifyError.hidden = false;
        return;
      }

      setInstitution(inst);
    });
  }

  if (changeInstitutionBtn) {
    changeInstitutionBtn.addEventListener("click", function () {
      currentInstitutionId = null;

      identifiedCard.hidden = true;
      stepChooseType.hidden = true;
      stepIdentify.hidden = false;

      identifyInput.value = "";

      hideResultCard();
    });
  }

  /* ---------- Crawl (per institution, cached) ---------- */

  function crawlInstitution(institutionId) {
    if (crawlCache[institutionId]) {
      return Promise.resolve(crawlCache[institutionId]);
    }

    if (crawlInFlight[institutionId]) {
      return crawlInFlight[institutionId];
    }

    var statusEl = document.getElementById("crawl-status");

    if (statusEl) {
      statusEl.textContent = "Checking official pages live…";
    }

    var req = fetch(
      "/api/crawler?institution=" +
      encodeURIComponent(institutionId)
    )
      .then(function (res) {
        if (!res.ok) {
          throw new Error("crawler_unavailable");
        }

        return res.json();
      })
      .then(function (data) {
        crawlCache[institutionId] = data;
        delete crawlInFlight[institutionId];

        if (statusEl) {
          statusEl.textContent = data.crawlFailed
            ? "Could not reach this institution's official pages right now. Try again shortly."
            : "Last checked " +
              new Date(data.checkedAt).toLocaleString() +
              (data.dataComplete
                ? ""
                : " (some pages were unreachable — result may be incomplete)");
        }

        return data;
      })
      .catch(function () {
        delete crawlInFlight[institutionId];

        /*
         * IMPORTANT:
         * This fallback matches the v3.3 crawler response structure.
         */
        var institution = getInstitutionById(institutionId);

        var fallback = {
          institutionId: institutionId,
          institutionName: institution ? institution.name : "",
          domain: institution ? institution.domain : "",
          items: {
            phones: [],
            emails: [],
            bankNames: [],
            paymentRecords: [],
            paymentInstructions: []
          },
          sources: [],
          pagesCrawled: [],
          dataComplete: false,
          crawlFailed: true,
          checkedAt: new Date().toISOString()
        };

        if (statusEl) {
          statusEl.textContent =
            "Could not reach the verification service. Try again shortly.";
        }

        return fallback;
      });

    crawlInFlight[institutionId] = req;

    return req;
  }

  /* ---------- Navigation ---------- */

  var pages = document.querySelectorAll(".page");
  var tabs = document.querySelectorAll(".tab");
  var gotoButtons = document.querySelectorAll("[data-goto]");

  function showPage(pageName) {
    pages.forEach(function (page) {
      page.hidden = page.dataset.page !== pageName;
    });

    tabs.forEach(function (tab) {
      tab.classList.toggle(
        "is-active",
        tab.dataset.goto === pageName
      );
    });

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });

    if (pageName === "info") {
      renderInfoBody();
    }
  }

  gotoButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      showPage(btn.dataset.goto);
    });
  });

  /* ---------- Step 2: verification type tiles ---------- */

  var typeTiles = document.querySelectorAll(".verify-type-tile");
  var verifyInput = document.getElementById("verify-input");
  var verifyMessageInput =
    document.getElementById("verify-message-input");
  var verifyMessageLabel =
    document.getElementById("verify-message-label");

  var verifyInputLabel =
    verifyInput ? verifyInput.previousElementSibling : null;

  var activeCheckType = "phone";

  var typeMeta = {
    phone: {
      label: "Phone number",
      placeholder: "e.g. 0972 832 671",
      isFreeText: false
    },

    email: {
      label: "Email address",
      placeholder: "e.g. name@example.com",
      isFreeText: false
    },

    bank: {
      label: "Bank name or account detail",
      placeholder: "e.g. Zanaco, or account number",
      isFreeText: false
    },

    link: {
      label: "Website or link",
      placeholder: "e.g. https://unilus-payments.com",
      isFreeText: false
    },

    other: {
      label: "Paste the message or information to check",
      placeholder: "Paste the SMS, WhatsApp, or email message here",
      isFreeText: true
    }
  };

  typeTiles.forEach(function (tile) {
    tile.addEventListener("click", function () {
      typeTiles.forEach(function (t) {
        t.classList.remove("is-active");
      });

      tile.classList.add("is-active");

      activeCheckType = tile.dataset.type;

      hideResultCard();

      var meta = typeMeta[activeCheckType];

      verifyInput.hidden = meta.isFreeText;

      if (verifyInputLabel) {
        verifyInputLabel.hidden = meta.isFreeText;
      }

      verifyMessageInput.hidden = !meta.isFreeText;
      verifyMessageLabel.hidden = !meta.isFreeText;

      if (!meta.isFreeText) {
        verifyInputLabel.textContent = meta.label;
        verifyInput.placeholder = meta.placeholder;
      } else {
        verifyMessageLabel.textContent = meta.label;
        verifyMessageInput.placeholder = meta.placeholder;
      }
    });
  });

  /* ---------- Matching helpers ---------- */

  /*
   * v3.1:
   * Crawler data is now:
   *
   * paymentRecords: [
   *   {
   *     value: {
   *       accountNumber,
   *       bankName,
   *       accountName,
   *       branch,
   *       source,
   *       pageTitle,
   *       context,
   *       discoveredAt
   *     },
   *     source
   *   }
   * ]
   *
   * The helper below supports both the new structure and a direct
   * record object, which makes the frontend more tolerant.
   */

  function findPaymentRecordMatch(inputValue, paymentRecords) {
    var v = (inputValue || "").trim();

    var digits = v.replace(/\D/g, "");

    if (!v) {
      return null;
    }

    return (paymentRecords || []).find(function (item) {
      var rec = item && item.value ? item.value : item;

      if (!rec) {
        return false;
      }

      /*
       * Account number match.
       *
       * Formatting such as:
       * 001-203-0001876
       * 0012030001876
       *
       * is treated as the same number.
       */
      if (digits && rec.accountNumber) {
        var recordDigits =
          String(rec.accountNumber).replace(/\D/g, "");

        if (recordDigits === digits) {
          return true;
        }
      }

      /*
       * Account name match.
       *
       * Only attempt this when the input contains no digits.
       */
      if (!digits && rec.accountName) {
        var recordName =
          String(rec.accountName).trim().toLowerCase();

        var inputName = v.toLowerCase();

        if (recordName === inputName) {
          return true;
        }

        if (recordName.indexOf(inputName) !== -1) {
          return true;
        }

        if (inputName.indexOf(recordName) !== -1) {
          return true;
        }
      }

      return false;
    }) || null;
  }

  function findBankNameMatch(inputValue, paymentRecords, bankNameItems) {
    var v = (inputValue || "").trim().toLowerCase();

    if (!v) {
      return null;
    }

    /*
     * First check linked payment records.
     *
     * This lets CampusVerify explain that the bank appears in an
     * institution-published payment record without falsely claiming
     * that the user's bank-name input proves a particular account.
     */
    var paymentMatch = (paymentRecords || []).find(function (item) {
      var rec = item && item.value ? item.value : item;

      if (!rec || !rec.bankName) {
        return false;
      }

      var bank = String(rec.bankName).trim().toLowerCase();

      return (
        bank === v ||
        bank.indexOf(v) !== -1 ||
        v.indexOf(bank) !== -1
      );
    });

    if (paymentMatch) {
      return paymentMatch;
    }

    /*
     * Fallback to the crawler's bankNames list.
     */
    return (bankNameItems || []).find(function (item) {
      var bank = String(item.value || "").trim().toLowerCase();

      return (
        bank === v ||
        bank.indexOf(v) !== -1 ||
        v.indexOf(bank) !== -1
      );
    }) || null;
  }

  function findPhoneMatch(inputValue, phoneItems) {
    var inNorm = normalisePhone(inputValue);

    if (inNorm.length !== 9) {
      return null;
    }

    return (phoneItems || []).find(function (item) {
      return normalisePhone(item.value) === inNorm;
    }) || null;
  }

  function findEmailMatch(inputValue, emailItems) {
    var v = (inputValue || "").trim().toLowerCase();

    return (emailItems || []).find(function (item) {
      return String(item.value || "").toLowerCase() === v;
    }) || null;
  }

  function findLinkMatch(inputValue, sources, institution) {
    var v =
      (inputValue || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");

    var officialDomain =
      institution && institution.domain
        ? institution.domain.toLowerCase()
        : "";

    if (
      officialDomain &&
      (v === officialDomain ||
        v.endsWith("." + officialDomain))
    ) {
      return {
        value: inputValue,
        source: "https://" + institution.domain + "/"
      };
    }

    var srcMatch = (sources || []).find(function (s) {
      return (
        s
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .indexOf(v) === 0
      );
    });

    return srcMatch
      ? {
          value: inputValue,
          source: srcMatch
        }
      : null;
  }

  /* ---------- Scam message scanning ---------- */

  function scanMessage(rawMessage) {
    var lower = (rawMessage || "").toLowerCase();
    var matches = [];

    SCAM_PATTERNS.forEach(function (pattern) {
      var trigger = pattern.triggers.find(function (t) {
        return lower.indexOf(t) !== -1;
      });

      if (trigger) {
        matches.push({
          category: pattern.category,
          explanation: pattern.explanation,
          source: pattern.source
        });
      }
    });

    return matches;
  }

  /* ---------- Evidence-based result rendering ---------- */

  var resultCard = document.getElementById("result-card");
  var evidenceCard = document.getElementById("evidence-card");

  function hideResultCard() {
    if (resultCard) {
      resultCard.hidden = true;
      resultCard.innerHTML = "";
    }

    if (evidenceCard) {
      evidenceCard.hidden = true;
      evidenceCard.innerHTML = "";
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c];
    });
  }

  var resultClassMap = {
    found: "result-card--success",
    partial: "result-card--warning",
    notfound: "result-card--warning",
    clean: "result-card--neutral",
    flagged: "result-card--warning"
  };

  function renderResult(kind, titleHtml, bodyHtml) {
    resultCard.className =
      "result-card " + resultClassMap[kind];

    resultCard.innerHTML =
      "<strong>" +
      titleHtml +
      "</strong><p>" +
      bodyHtml +
      "</p>";

    resultCard.hidden = false;
  }

  function renderEvidence(
    checkedValue,
    resultLabel,
    source,
    checkedAt
  ) {
    var sourceLink = source
      ? "<a href=\"" +
        escapeHtml(source) +
        "\" target=\"_blank\" rel=\"noopener\" class=\"btn btn-ghost btn-small\">View Source</a>"
      : "";

    evidenceCard.innerHTML =
      "<span class=\"notice-tag\">Verification Evidence</span>" +
      "<p><strong>Information checked:</strong> " +
      escapeHtml(checkedValue) +
      "</p>" +
      "<p><strong>Result:</strong> " +
      escapeHtml(resultLabel) +
      "</p>" +
      "<p><strong>Last checked:</strong> " +
      new Date(checkedAt).toLocaleString() +
      "</p>" +
      (sourceLink
        ? "<p>" + sourceLink + "</p>"
        : "");

    evidenceCard.hidden = false;
  }

  /*
   * Extra evidence renderer for payment records.
   *
   * This is used when an actual institution-published account is found,
   * so the student can see exactly what CampusVerify found.
   */
  function renderPaymentEvidence(
    checkedValue,
    paymentRecord,
    checkedAt
  ) {
    var rec =
      paymentRecord && paymentRecord.value
        ? paymentRecord.value
        : paymentRecord;

    if (!rec) {
      renderEvidence(
        checkedValue,
        "Found",
        null,
        checkedAt
      );
      return;
    }

    var source =
      rec.source ||
      paymentRecord.source ||
      null;

    var details = "";

    if (rec.bankName) {
      details +=
        "<p><strong>Bank:</strong> " +
        escapeHtml(rec.bankName) +
        "</p>";
    }

    if (rec.accountNumber) {
      details +=
        "<p><strong>Account number:</strong> " +
        escapeHtml(rec.accountNumber) +
        "</p>";
    }

    if (rec.accountName) {
      details +=
        "<p><strong>Account name:</strong> " +
        escapeHtml(rec.accountName) +
        "</p>";
    }

    if (rec.branch) {
      details +=
        "<p><strong>Branch:</strong> " +
        escapeHtml(rec.branch) +
        "</p>";
    }

    if (rec.pageTitle) {
      details +=
        "<p><strong>Page/document:</strong> " +
        escapeHtml(rec.pageTitle) +
        "</p>";
    }

    if (rec.context) {
      details +=
        "<p><strong>Published context:</strong> " +
        escapeHtml(rec.context) +
        "</p>";
    }

    var sourceLink = source
      ? "<p><a href=\"" +
        escapeHtml(source) +
        "\" target=\"_blank\" rel=\"noopener\" class=\"btn btn-ghost btn-small\">View Official Source</a></p>"
      : "";

    evidenceCard.innerHTML =
      "<span class=\"notice-tag\">Verification Evidence</span>" +
      "<p><strong>Information checked:</strong> " +
      escapeHtml(checkedValue) +
      "</p>" +
      "<p><strong>Result:</strong> Published by Institution</p>" +
      details +
      "<p><strong>Last checked:</strong> " +
      new Date(checkedAt).toLocaleString() +
      "</p>" +
      sourceLink;

    evidenceCard.hidden = false;
  }

  /* ---------- Stats ---------- */

  function loadStats() {
    try {
      return (
        JSON.parse(
          localStorage.getItem("cv-stats")
        ) || {
          total: 0,
          flagged: 0,
          reports: 0
        }
      );
    } catch (e) {
      return {
        total: 0,
        flagged: 0,
        reports: 0
      };
    }
  }

  function saveStats(stats) {
    try {
      localStorage.setItem(
        "cv-stats",
        JSON.stringify(stats)
      );
    } catch (e) {}
  }

  function logVerification(flagged) {
    var s = loadStats();

    s.total++;

    if (flagged) {
      s.flagged++;
    }

    saveStats(s);
    renderImpactStats();
  }

  function logReport() {
    var s = loadStats();

    s.reports++;

    saveStats(s);
    renderImpactStats();
  }

  function renderImpactStats() {
    var s = loadStats();

    var totalEl =
      document.getElementById("impact-total");

    var flaggedEl =
      document.getElementById("impact-flagged");

    var reportsEl =
      document.getElementById("impact-reports");

    if (totalEl) {
      totalEl.textContent = s.total;
    }

    if (flaggedEl) {
      flaggedEl.textContent = s.flagged;
    }

    if (reportsEl) {
      reportsEl.textContent = s.reports;
    }
  }

  /* ---------- Verify form submit ---------- */

  var verifyForm =
    document.querySelectorAll(".check-form")[1];

  var verifyEmptyWarning =
    document.getElementById(
      "verify-empty-warning"
    );

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var typeCheckForm =
        document.querySelector(
          "#step-choose-type .check-form"
        );

      if (!typeCheckForm) {
        return;
      }

      typeCheckForm.addEventListener(
        "submit",
        function (event) {
          event.preventDefault();

          hideResultCard();

          verifyEmptyWarning.hidden = true;

          if (!currentInstitutionId) {
            return;
          }

          var institution =
            getInstitutionById(
              currentInstitutionId
            );

          var meta =
            typeMeta[activeCheckType];

          /* ---------- Free-text scam check ---------- */

          if (meta.isFreeText) {
            var msg =
              verifyMessageInput.value.trim();

            if (!msg) {
              verifyEmptyWarning.hidden = false;
              return;
            }

            var matches =
              scanMessage(msg);

            if (matches.length) {
              var items =
                matches
                  .map(function (m) {
                    return (
                      "<li><strong>" +
                      escapeHtml(m.category) +
                      ":</strong> " +
                      escapeHtml(
                        m.explanation
                      ) +
                      "</li>"
                    );
                  })
                  .join("");

              resultCard.className =
                "result-card result-card--warning";

              resultCard.innerHTML =
                "<strong>🔴 Scam indicators found</strong>" +
                "<ul class=\"result-list\">" +
                items +
                "</ul>";

              resultCard.hidden = false;

              renderEvidence(
                msg.slice(0, 80) +
                  (msg.length > 80
                    ? "…"
                    : ""),
                "Documented scam pattern(s) matched",
                null,
                new Date().toISOString()
              );

              logVerification(true);
            } else {
              renderResult(
                "clean",
                "🟡 No documented pattern matched",
                "This doesn't guarantee the message is safe — CampusVerify only checks against documented scam patterns, not every possible scam. Always verify unfamiliar requests directly."
              );

              logVerification(false);
            }

            return;
          }

          /* ---------- Normal verification ---------- */

          var value =
            verifyInput.value.trim();

          if (!value) {
            verifyEmptyWarning.hidden = false;
            return;
          }

          crawlInstitution(
            currentInstitutionId
          ).then(function (data) {
            if (data.crawlFailed) {
              renderResult(
                "partial",
                "🟡 Unable to check right now",
                "CampusVerify couldn't reach " +
                  escapeHtml(
                    data.institutionName ||
                      institution.name
                  ) +
                  "'s official pages at this moment. This is not a result — please try again shortly."
              );

              return;
            }

            var incomplete =
              !data.dataComplete;

            var items =
              data.items || {};

            /* ---------- PHONE ---------- */

            if (
              activeCheckType === "phone"
            ) {
              var phoneMatch =
                findPhoneMatch(
                  value,
                  items.phones
                );

              if (phoneMatch) {
                renderResult(
                  "found",
                  "🟢 Found on official source",
                  "This phone number was found on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official website."
                );

                renderEvidence(
                  value,
                  "Found",
                  phoneMatch.source,
                  data.checkedAt
                );
              } else {
                renderResult(
                  incomplete
                    ? "partial"
                    : "notfound",
                  incomplete
                    ? "🟡 Unable to fully verify"
                    : "🔴 Not found on official sources",
                  (incomplete
                    ? "Some pages couldn't be checked, so this isn't complete. "
                    : "") +
                    "CampusVerify could not find this on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official sources. This isn't automatic proof of fraud — confirm directly before proceeding."
                );

                renderEvidence(
                  value,
                  incomplete
                    ? "Incomplete"
                    : "Not found",
                  null,
                  data.checkedAt
                );
              }

              logVerification(
                !phoneMatch
              );
            }

            /* ---------- EMAIL ---------- */

            else if (
              activeCheckType === "email"
            ) {
              var emailMatch =
                findEmailMatch(
                  value,
                  items.emails
                );

              if (emailMatch) {
                renderResult(
                  "found",
                  "🟢 Found on official source",
                  "This email address was found on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official website."
                );

                renderEvidence(
                  value,
                  "Found",
                  emailMatch.source,
                  data.checkedAt
                );
              } else {
                renderResult(
                  incomplete
                    ? "partial"
                    : "notfound",
                  incomplete
                    ? "🟡 Unable to fully verify"
                    : "🔴 Not found on official sources",
                  (incomplete
                    ? "Some pages couldn't be checked, so this isn't complete. "
                    : "") +
                    "CampusVerify could not find this on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official sources. This isn't automatic proof of fraud — confirm directly before proceeding."
                );

                renderEvidence(
                  value,
                  incomplete
                    ? "Incomplete"
                    : "Not found",
                  null,
                  data.checkedAt
                );
              }

              logVerification(
                !emailMatch
              );
            }

            /* ---------- BANK ---------- */

            else if (
              activeCheckType === "bank"
            ) {
              /*
               * IMPORTANT:
               *
               * We do NOT use a hardcoded bank-account list.
               *
               * CampusVerify checks the live paymentRecords returned
               * by the crawler.
               *
               * Actual account number/name match:
               *     = published evidence
               *
               * Bank-name-only match:
               *     = bank mentioned by institution, but does NOT prove
               *       that the user's specific account is legitimate.
               */

              var paymentMatch =
                findPaymentRecordMatch(
                  value,
                  items.paymentRecords
                );

              var bankNameMatch =
                !paymentMatch
                  ? findBankNameMatch(
                      value,
                      items.paymentRecords,
                      items.bankNames
                    )
                  : null;

              if (paymentMatch) {
                /*
                 * ACTUAL PUBLISHED PAYMENT RECORD
                 */
                renderResult(
                  "found",
                  "🟢 Published by Institution",
                  "This payment detail matches an account record publicly published on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official website."
                );

                renderPaymentEvidence(
                  value,
                  paymentMatch,
                  data.checkedAt
                );

                /*
                 * A published account is not suspicious simply because
                 * an external payment gateway accepts or rejects it.
                 */
                logVerification(false);
              }

              else if (bankNameMatch) {
                /*
                 * BANK NAME ONLY
                 *
                 * Do not claim the account is verified.
                 */
                var bankRecord =
                  bankNameMatch.value
                    ? bankNameMatch.value
                    : bankNameMatch;

                var bankSource =
                  bankRecord.source ||
                  bankNameMatch.source ||
                  null;

                renderResult(
                  "partial",
                  "🟡 Bank mentioned, account not confirmed",
                  escapeHtml(
                    data.institutionName
                  ) +
                    " publicly mentions this bank, but CampusVerify did not find the specific account number or account name you entered in its published payment records. Confirm the exact payment details directly with the institution before paying."
                );

                renderEvidence(
                  value,
                  "Bank mentioned, specific payment detail not confirmed",
                  bankSource,
                  data.checkedAt
                );

                logVerification(true);
              }

              else {
                /*
                 * NOTHING FOUND
                 */
                renderResult(
                  incomplete
                    ? "partial"
                    : "notfound",
                  incomplete
                    ? "🟡 Unable to fully verify"
                    : "🟡 Not found in published payment details",
                  (incomplete
                    ? "Some official pages could not be checked, so CampusVerify cannot make a complete determination. "
                    : "") +
                    "CampusVerify did not find this specific payment detail in the publicly available payment information it checked on " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    ". This does not automatically mean the account is fraudulent. Confirm directly with the institution before paying."
                );

                renderEvidence(
                  value,
                  incomplete
                    ? "Incomplete — not all official pages were checked"
                    : "Not found in published payment details",
                  null,
                  data.checkedAt
                );

                logVerification(true);
              }
            }

            /* ---------- LINK ---------- */

            else if (
              activeCheckType === "link"
            ) {
              var linkMatch =
                findLinkMatch(
                  value,
                  data.sources,
                  institution
                );

              if (linkMatch) {
                renderResult(
                  "found",
                  "🟢 Found on official source",
                  "This matches " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official website or a page CampusVerify checked there."
                );

                renderEvidence(
                  value,
                  "Found",
                  linkMatch.source,
                  data.checkedAt
                );
              } else {
                renderResult(
                  "notfound",
                  "🔴 Not found on official sources",
                  "This doesn't match " +
                    escapeHtml(
                      data.institutionName
                    ) +
                    "'s official domain or any page CampusVerify has checked. This isn't automatic proof it's fake — confirm directly before proceeding."
                );

                renderEvidence(
                  value,
                  "Not found",
                  null,
                  data.checkedAt
                );
              }

              logVerification(
                !linkMatch
              );
            }
          });
        }
      );
    }
  );

  /* ---------- Info page ---------- */

  var infoSearchInput,
    filterChips,
    activeFilter = "all",
    infoListEl,
    infoEmptyEl;

  function renderInfoBody() {
    var noInstEl =
      document.getElementById(
        "info-no-institution"
      );

    var bodyEl =
      document.getElementById(
        "info-body"
      );

    var nameEl =
      document.getElementById(
        "info-institution-name"
      );

    if (!noInstEl || !bodyEl) {
      return;
    }

    if (!currentInstitutionId) {
      noInstEl.hidden = false;
      bodyEl.hidden = true;
      return;
    }

    noInstEl.hidden = true;
    bodyEl.hidden = false;

    infoSearchInput =
      document.getElementById(
        "info-search"
      );

    filterChips =
      document.querySelectorAll(".chip");

    infoListEl =
      document.getElementById(
        "info-list"
      );

    infoEmptyEl =
      document.getElementById(
        "info-empty"
      );

    var institution =
      getInstitutionById(
        currentInstitutionId
      );

    if (nameEl && institution) {
      nameEl.textContent =
        institution.name;
    }

    infoListEl.innerHTML =
      "<p class=\"empty-state\">Loading live data…</p>";

    crawlInstitution(
      currentInstitutionId
    ).then(function (data) {
      var items = [];

      var it =
        data.items || {};

      /* Phones */
      (it.phones || []).forEach(
        function (p) {
          items.push({
            type: "contact",
            label: "Phone",
            value: p.value,
            source: p.source
          });
        }
      );

      /* Emails */
      (it.emails || []).forEach(
        function (e) {
          items.push({
            type: "contact",
            label: "Email",
            value: e.value,
            source: e.source
          });
        }
      );

      /*
       * Payment records:
       *
       * Instead of displaying account number, account name and branch
       * as unrelated lists, display each complete payment record.
       */
      (it.paymentRecords || []).forEach(
        function (item) {
          var rec =
            item && item.value
              ? item.value
              : item;

          if (!rec) {
            return;
          }

          var source =
            rec.source ||
            item.source ||
            null;

          if (rec.accountNumber) {
            items.push({
              type: "bank",
              label: "Account number",
              value: String(
                rec.accountNumber
              ),
              source: source
            });
          }

          if (rec.bankName) {
            items.push({
              type: "bank",
              label: "Bank",
              value: String(
                rec.bankName
              ),
              source: source
            });
          }

          if (rec.accountName) {
            items.push({
              type: "bank",
              label: "Account name",
              value: String(
                rec.accountName
              ),
              source: source
            });
          }

          if (rec.branch) {
            items.push({
              type: "bank",
              label: "Branch",
              value: String(
                rec.branch
              ),
              source: source
            });
          }
        }
      );

      /*
       * Bank names found independently on official pages.
       *
       * Avoid duplicates where possible because a paymentRecord may
       * already contain the same bank.
       */
      (it.bankNames || []).forEach(
        function (b) {
          var alreadyListed =
            items.some(function (existing) {
              return (
                existing.type === "bank" &&
                existing.label === "Bank" &&
                existing.value.toLowerCase() ===
                  String(
                    b.value || ""
                  ).toLowerCase()
              );
            });

          if (!alreadyListed) {
            items.push({
              type: "bank",
              label: "Bank",
              value: b.value,
              source: b.source
            });
          }
        }
      );

      /*
       * Official pages checked by the crawler.
       */
      (data.sources || []).forEach(
        function (s) {
          items.push({
            type: "link",
            label: "Official page",
            value: s,
            source: s
          });
        }
      );

      var query =
        (
          (infoSearchInput &&
            infoSearchInput.value) ||
          ""
        ).toLowerCase();

      var visible =
        items.filter(function (item) {
          var itemValue =
            String(
              item.value || ""
            ).toLowerCase();

          var matchesFilter =
            activeFilter === "all" ||
            item.type === activeFilter;

          var matchesQuery =
            !query ||
            itemValue.indexOf(query) !== -1;

          return (
            matchesFilter &&
            matchesQuery
          );
        });

      if (!items.length) {
        infoListEl.innerHTML =
          "<p class=\"empty-state\">" +
          (data.crawlFailed
            ? "Could not reach this institution's official pages right now."
            : "Nothing found on this institution's approved pages right now.") +
          "</p>";

        infoEmptyEl.hidden = true;
        return;
      }

      infoEmptyEl.hidden =
        visible.length !== 0;

      infoListEl.innerHTML =
        visible
          .map(function (item) {
            return (
              "<div class=\"info-card\">" +
              "<span class=\"info-card-title\">" +
              escapeHtml(
                item.label
              ) +
              "</span>" +
              "<span class=\"info-card-detail\">" +
              escapeHtml(
                item.value
              ) +
              "</span>" +
              (
                item.source
                  ? "<a href=\"" +
                    escapeHtml(
                      item.source
                    ) +
                    "\" target=\"_blank\" rel=\"noopener\" class=\"info-card-source-link\">View Source</a>"
                  : ""
              ) +
              "</div>"
            );
          })
          .join("");
    });
  }

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var s =
        document.getElementById(
          "info-search"
        );

      if (s) {
        s.addEventListener(
          "input",
          renderInfoBody
        );
      }

      document
        .querySelectorAll(".chip")
        .forEach(function (chip) {
          chip.addEventListener(
            "click",
            function () {
              document
                .querySelectorAll(
                  ".chip"
                )
                .forEach(function (c) {
                  c.classList.remove(
                    "is-active"
                  );
                });

              chip.classList.add(
                "is-active"
              );

              activeFilter =
                chip.dataset.filter;

              renderInfoBody();
            }
          );
        });
    }
  );

  /* ---------- Report centre ---------- */

  var reportForm =
    document.getElementById(
      "report-form"
    );

  var reportSummary =
    document.getElementById(
      "report-summary"
    );

  var reportActions =
    document.getElementById(
      "report-actions"
    );

  var reportEmptyWarning =
    document.getElementById(
      "report-empty-warning"
    );

  var reportCopyBtn =
    document.getElementById(
      "report-copy-btn"
    );

  var reportClearBtn =
    document.getElementById(
      "report-clear-btn"
    );

  function buildReportText() {
    var desc =
      document
        .getElementById(
          "report-description"
        )
        .value.trim();

    var phone =
      document
        .getElementById(
          "report-phone"
        )
        .value.trim();

    var email =
      document
        .getElementById(
          "report-email"
        )
        .value.trim();

    var bank =
      document
        .getElementById(
          "report-bank"
        )
        .value.trim();

    var inst =
      currentInstitutionId
        ? getInstitutionById(
            currentInstitutionId
          )
        : null;

    return [
      "CampusVerify — Suspicious Activity Report",
      "Institution: " +
        (inst
          ? inst.name
          : "Not identified — verify a website first"),
      "Prepared: " +
        new Date().toLocaleString(),
      "",
      "Description: " +
        (desc || "Not provided"),
      "Phone involved: " +
        (phone || "Not provided"),
      "Email involved: " +
        (email || "Not provided"),
      "Bank account involved: " +
        (bank || "Not provided")
    ].join("\n");
  }

  function generateReport(event) {
    event.preventDefault();

    var desc =
      document
        .getElementById(
          "report-description"
        )
        .value.trim();

    var phone =
      document
        .getElementById(
          "report-phone"
        )
        .value.trim();

    var email =
      document
        .getElementById(
          "report-email"
        )
        .value.trim();

    var bank =
      document
        .getElementById(
          "report-bank"
        )
        .value.trim();

    if (
      !desc &&
      !phone &&
      !email &&
      !bank
    ) {
      reportEmptyWarning.hidden =
        false;
      return;
    }

    reportEmptyWarning.hidden = true;

    var text =
      buildReportText();

    reportSummary.textContent =
      text;

    reportSummary.hidden = false;
    reportActions.hidden = false;

    logReport();
  }

  function copyReport() {
    var text =
      reportSummary.textContent;

    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(text)
        .catch(function () {});
    }

    var confirmEl =
      document.createElement("p");

    confirmEl.className =
      "notice notice-soft";

    confirmEl.textContent =
      "Copied to clipboard.";

    reportActions.parentNode.insertBefore(
      confirmEl,
      reportActions.nextSibling
    );

    setTimeout(function () {
      confirmEl.remove();
    }, 1800);
  }

  function clearReportForm() {
    reportForm.reset();

    reportSummary.hidden = true;
    reportActions.hidden = true;
  }

  function renderReportChannels() {
    var container =
      document.getElementById(
        "report-channels"
      );

    if (!container) {
      return;
    }

    var inst =
      currentInstitutionId
        ? getInstitutionById(
            currentInstitutionId
          )
        : null;

    var links =
      (inst &&
        inst.reportingLinks) ||
      [];

    container.innerHTML =
      links
        .map(function (l) {
          return (
            "<a class=\"info-card info-card-link\" href=\"" +
            escapeHtml(l.url) +
            "\" target=\"_blank\" rel=\"noopener\">" +
            escapeHtml(l.label) +
            "</a>"
          );
        })
        .join("") ||
      "<p class=\"empty-state\">Identify your institution on the Verify page to see its reporting channels.</p>";
  }

  if (reportForm) {
    reportForm.addEventListener(
      "submit",
      generateReport
    );
  }

  if (reportCopyBtn) {
    reportCopyBtn.addEventListener(
      "click",
      copyReport
    );
  }

  if (reportClearBtn) {
    reportClearBtn.addEventListener(
      "click",
      clearReportForm
    );
  }

  /* ---------- Settings ---------- */

  function loadPreferences() {
    try {
      return (
        JSON.parse(
          localStorage.getItem(
            "cv-prefs"
          )
        ) || {}
      );
    } catch (e) {
      return {};
    }
  }

  function savePreferences(prefs) {
    try {
      localStorage.setItem(
        "cv-prefs",
        JSON.stringify(prefs)
      );
    } catch (e) {}
  }

  function applyPreferences(
    prefs
  ) {
    document.documentElement.classList.toggle(
      "dark-mode",
      !!prefs.darkMode
    );

    document.documentElement.classList.toggle(
      "large-text",
      !!prefs.largeText
    );

    document.documentElement.classList.toggle(
      "reduced-motion",
      !!prefs.reducedMotion
    );

    var d =
      document.getElementById(
        "setting-dark-mode"
      );

    var l =
      document.getElementById(
        "setting-large-text"
      );

    var m =
      document.getElementById(
        "setting-reduced-motion"
      );

    if (d) {
      d.checked = !!prefs.darkMode;
    }

    if (l) {
      l.checked = !!prefs.largeText;
    }

    if (m) {
      m.checked =
        !!prefs.reducedMotion;
    }
  }

  function handleToggleChange(
    key,
    el
  ) {
    var p =
      loadPreferences();

    p[key] = el.checked;

    savePreferences(p);
    applyPreferences(p);
  }

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var darkToggle =
        document.getElementById(
          "setting-dark-mode"
        );

      var textToggle =
        document.getElementById(
          "setting-large-text"
        );

      var motionToggle =
        document.getElementById(
          "setting-reduced-motion"
        );

      if (darkToggle) {
        darkToggle.addEventListener(
          "change",
          function () {
            handleToggleChange(
              "darkMode",
              darkToggle
            );
          }
        );
      }

      if (textToggle) {
        textToggle.addEventListener(
          "change",
          function () {
            handleToggleChange(
              "largeText",
              textToggle
            );
          }
        );
      }

      if (motionToggle) {
        motionToggle.addEventListener(
          "change",
          function () {
            handleToggleChange(
              "reducedMotion",
              motionToggle
            );
          }
        );
      }

      var resetBtn =
        document.getElementById(
          "settings-reset-btn"
        );

      if (resetBtn) {
        resetBtn.addEventListener(
          "click",
          function () {
            savePreferences({});
            applyPreferences({});

            var confirmEl =
              document.getElementById(
                "settings-reset-confirm"
              );

            confirmEl.hidden = false;

            setTimeout(
              function () {
                confirmEl.hidden = true;
              },
              1800
            );
          }
        );
      }

      var countEl =
        document.getElementById(
          "settings-institution-count"
        );

      if (countEl) {
        countEl.textContent =
          INSTITUTIONS.length;
      }

      renderImpactStats();
      applyPreferences(
        loadPreferences()
      );
      renderReportChannels();
    }
  );
})();
