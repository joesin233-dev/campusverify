/* =========================================================================
   CampusVerify v3.2 — script.js
   -----------------------------------------------------------------------
   Website-first institution verification frontend.

   Core principles:
   - Student starts by entering an institution website.
   - institutions.js decides whether the institution is supported.
   - crawler.js checks the institution's approved official website.
   - Evidence comes from publicly available institutional sources.
   - Bank-name-only matches NEVER prove a specific account is legitimate.
   - A specific payment record is considered institution-published only when
     the actual record was found in an official source.
   - "Not found" is NOT automatically treated as fraud.
   - Incomplete crawling is clearly disclosed to the student.

   Compatible with the upgraded crawler response:
   {
     institutionId,
     institutionName,
     domain,
     officialUrl,
     items: {
       phones,
       emails,
       bankNames,
       paymentRecords,
       paymentInstructions
     },
     sources,
     pagesCrawled,
     crawlStats,
     dataComplete,
     crawlFailed,
     checkedAt
   }
   ========================================================================= */

(function () {
  "use strict";

  /* =======================================================================
     STATE
     ======================================================================= */

  var currentInstitutionId = null;

  var crawlCache = {};
  var crawlInFlight = {};

  var activeCheckType = "phone";
  var activeFilter = "all";

  /* =======================================================================
     DOM HELPERS
     ======================================================================= */

  function $(id) {
    return document.getElementById(id);
  }

  function safeText(value) {
    return value === null || value === undefined
      ? ""
      : String(value);
  }

  function escapeHtml(str) {
    return safeText(str).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c];
    });
  }

  function normaliseUrl(value) {
    return safeText(value)
      .trim()
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function isValidHttpUrl(value) {
    try {
      var url = new URL(value);

      return (
        url.protocol === "http:" ||
        url.protocol === "https:"
      );
    } catch (e) {
      return false;
    }
  }

  /* =======================================================================
     STEP 1 — IDENTIFY INSTITUTION
     ======================================================================= */

  var identifyForm = $("identify-form");
  var identifyInput = $("identify-url-input");
  var identifyError = $("identify-error");

  var identifiedCard = $("institution-identified-card");
  var identifiedName = $("institution-identified-name");
  var identifiedDomain = $("institution-identified-domain");

  var stepIdentify = $("step-identify");
  var stepChooseType = $("step-choose-type");

  var changeInstitutionBtn =
    $("change-institution-btn");

  var visitSiteBtn =
    $("visit-official-site-btn");

  var verifyNowBtn =
    $("verify-something-now-btn");

  var statusBadge =
    $("institution-status-badge");

  var STATUS_BADGE_TEXT = {
    partner: "✓ CampusVerify Partner Institution",
    pilot: "✓ CampusVerify Pilot Institution"
  };

  function getCurrentInstitution() {
    if (!currentInstitutionId) {
      return null;
    }

    if (typeof getInstitutionById !== "function") {
      return null;
    }

    return getInstitutionById(
      currentInstitutionId
    );
  }

  function setInstitution(inst) {
    if (!inst) {
      return;
    }

    currentInstitutionId = inst.id;

    if (identifiedName) {
      identifiedName.textContent =
        inst.name || "Institution";
    }

    if (identifiedDomain) {
      identifiedDomain.textContent =
        inst.domain || "";
    }

    if (visitSiteBtn && inst.domain) {
      visitSiteBtn.href =
        /^https?:\/\//i.test(inst.domain)
          ? inst.domain
          : "https://" + inst.domain;

      visitSiteBtn.target = "_blank";
      visitSiteBtn.rel = "noopener";
    }

    if (statusBadge) {
      statusBadge.textContent =
        STATUS_BADGE_TEXT[inst.status] ||
        "✓ CampusVerify Supported Institution";
    }

    if (identifiedCard) {
      identifiedCard.hidden = false;
    }

    if (stepIdentify) {
      stepIdentify.hidden = true;
    }

    if (stepChooseType) {
      stepChooseType.hidden = true;
    }

    if (identifyError) {
      identifyError.hidden = true;
    }

    hideResultCard();

    /*
     * Begin crawling immediately so the data is ready when the student
     * presses "Verify Something Now".
     */
    crawlInstitution(
      currentInstitutionId
    ).then(function () {
      renderInfoBody();
    });
  }

  if (verifyNowBtn) {
    verifyNowBtn.addEventListener(
      "click",
      function () {
        if (stepChooseType) {
          stepChooseType.hidden = false;

          stepChooseType.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }
      }
    );
  }

  if (identifyForm) {
    identifyForm.addEventListener(
      "submit",
      function (event) {
        event.preventDefault();

        var raw =
          identifyInput
            ? identifyInput.value.trim()
            : "";

        if (!raw) {
          if (identifyError) {
            identifyError.textContent =
              "Please enter your institution's website first.";
            identifyError.hidden = false;
          }

          return;
        }

        var candidate =
          /^https?:\/\//i.test(raw)
            ? raw
            : "https://" + raw;

        if (!isValidHttpUrl(candidate)) {
          if (identifyError) {
            identifyError.textContent =
              "That doesn't look like a valid website address. Try something like https://www.unilus.ac.zm";
            identifyError.hidden = false;
          }

          return;
        }

        /*
         * IMPORTANT:
         *
         * The frontend does not automatically trust or crawl an arbitrary
         * website. institutions.js must approve the institution first.
         */
        var inst =
          typeof getInstitutionByUrl === "function"
            ? getInstitutionByUrl(raw)
            : null;

        if (!inst) {
          if (identifyError) {
            identifyError.textContent =
              "CampusVerify doesn't support this institution yet. Only licensed or pilot institutions can be checked.";
            identifyError.hidden = false;
          }

          return;
        }

        setInstitution(inst);
      }
    );
  }

  if (changeInstitutionBtn) {
    changeInstitutionBtn.addEventListener(
      "click",
      function () {
        currentInstitutionId = null;

        if (identifiedCard) {
          identifiedCard.hidden = true;
        }

        if (stepChooseType) {
          stepChooseType.hidden = true;
        }

        if (stepIdentify) {
          stepIdentify.hidden = false;
        }

        if (identifyInput) {
          identifyInput.value = "";
        }

        hideResultCard();
        renderInfoBody();
        renderReportChannels();
      }
    );
  }

  /* =======================================================================
     CRAWLER
     ======================================================================= */

  function updateCrawlStatus(data) {
    var statusEl =
      $("crawl-status");

    if (!statusEl) {
      return;
    }

    if (!data) {
      statusEl.textContent =
        "Verification service unavailable.";
      return;
    }

    if (data.crawlFailed) {
      statusEl.textContent =
        "Could not reach this institution's official pages right now. Try again shortly.";
      return;
    }

    var checkedText =
      data.checkedAt
        ? new Date(
            data.checkedAt
          ).toLocaleString()
        : "just now";

    var stats =
      data.crawlStats || {};

    var pageCount =
      stats.pagesCrawled ||
      data.pagesCrawled &&
      data.pagesCrawled.length ||
      0;

    var message =
      "Last checked " +
      checkedText;

    if (pageCount) {
      message +=
        " • " +
        pageCount +
        " official page" +
        (pageCount === 1 ? "" : "s") +
        " checked";
    }

    if (!data.dataComplete) {
      message +=
        " • Some pages were unreachable, so results may be incomplete.";
    }

    statusEl.textContent = message;
  }

  function createFallbackCrawl(institutionId) {
    var institution =
      typeof getInstitutionById === "function"
        ? getInstitutionById(
            institutionId
          )
        : null;

    return {
      institutionId:
        institutionId,

      institutionName:
        institution
          ? institution.name
          : "",

      domain:
        institution
          ? institution.domain
          : "",

      officialUrl:
        institution && institution.domain
          ? "https://" +
            institution.domain +
            "/"
          : "",

      items: {
        phones: [],
        emails: [],
        bankNames: [],
        paymentRecords: [],
        paymentInstructions: []
      },

      sources: [],
      pagesCrawled: [],

      crawlStats: {
        pagesCrawled: 0,
        documentsFound: 0,
        errors: 1
      },

      dataComplete: false,
      crawlFailed: true,

      checkedAt:
        new Date().toISOString()
    };
  }

  function crawlInstitution(institutionId) {
    if (!institutionId) {
      return Promise.resolve(
        createFallbackCrawl("")
      );
    }

    if (crawlCache[institutionId]) {
      updateCrawlStatus(
        crawlCache[institutionId]
      );

      return Promise.resolve(
        crawlCache[institutionId]
      );
    }

    if (crawlInFlight[institutionId]) {
      return crawlInFlight[
        institutionId
      ];
    }

    var statusEl =
      $("crawl-status");

    if (statusEl) {
      statusEl.textContent =
        "Checking official pages live…";
    }

    var requestUrl =
      "/api/crawler?institution=" +
      encodeURIComponent(
        institutionId
      );

    var req =
      fetch(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      })
        .then(function (res) {
          if (!res.ok) {
            throw new Error(
              "crawler_http_" +
              res.status
            );
          }

          return res.json();
        })

        .then(function (data) {
          /*
           * Defensive normalisation.
           *
           * This prevents an unexpected backend response from breaking
           * the verification UI.
           */

          data =
            data || {};

          data.items =
            data.items || {};

          data.items.phones =
            Array.isArray(
              data.items.phones
            )
              ? data.items.phones
              : [];

          data.items.emails =
            Array.isArray(
              data.items.emails
            )
              ? data.items.emails
              : [];

          data.items.bankNames =
            Array.isArray(
              data.items.bankNames
            )
              ? data.items.bankNames
              : [];

          data.items.paymentRecords =
            Array.isArray(
              data.items.paymentRecords
            )
              ? data.items.paymentRecords
              : [];

          data.items.paymentInstructions =
            Array.isArray(
              data.items.paymentInstructions
            )
              ? data.items.paymentInstructions
              : [];

          data.sources =
            Array.isArray(data.sources)
              ? data.sources
              : [];

          data.pagesCrawled =
            Array.isArray(
              data.pagesCrawled
            )
              ? data.pagesCrawled
              : [];

          data.crawlStats =
            data.crawlStats || {};

          data.checkedAt =
            data.checkedAt ||
            new Date().toISOString();

          crawlCache[institutionId] =
            data;

          delete crawlInFlight[
            institutionId
          ];

          updateCrawlStatus(data);

          return data;
        })

        .catch(function () {
          delete crawlInFlight[
            institutionId
          ];

          var fallback =
            createFallbackCrawl(
              institutionId
            );

          crawlCache[institutionId] =
            fallback;

          updateCrawlStatus(
            fallback
          );

          return fallback;
        });

    crawlInFlight[institutionId] =
      req;

    return req;
  }

  /* =======================================================================
     NAVIGATION
     ======================================================================= */

  var pages =
    document.querySelectorAll(
      ".page"
    );

  var tabs =
    document.querySelectorAll(
      ".tab"
    );

  var gotoButtons =
    document.querySelectorAll(
      "[data-goto]"
    );

  function showPage(pageName) {
    pages.forEach(
      function (page) {
        page.hidden =
          page.dataset.page !==
          pageName;
      }
    );

    tabs.forEach(
      function (tab) {
        tab.classList.toggle(
          "is-active",
          tab.dataset.goto ===
            pageName
        );
      }
    );

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });

    if (pageName === "info") {
      renderInfoBody();
    }

    if (pageName === "report") {
      renderReportChannels();
    }
  }

  gotoButtons.forEach(
    function (btn) {
      btn.addEventListener(
        "click",
        function () {
          showPage(
            btn.dataset.goto
          );
        }
      );
    }
  );

  /* =======================================================================
     VERIFICATION TYPE TILES
     ======================================================================= */

  var typeTiles =
    document.querySelectorAll(
      ".verify-type-tile"
    );

  var verifyInput =
    $("verify-input");

  var verifyMessageInput =
    $("verify-message-input");

  var verifyMessageLabel =
    $("verify-message-label");

  var verifyInputLabel =
    verifyInput
      ? verifyInput.previousElementSibling
      : null;

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
      placeholder:
        "Paste the SMS, WhatsApp, or email message here",
      isFreeText: true
    }
  };

  function activateCheckType(type) {
    if (!typeMeta[type]) {
      type = "phone";
    }

    activeCheckType = type;

    typeTiles.forEach(
      function (tile) {
        tile.classList.toggle(
          "is-active",
          tile.dataset.type ===
            activeCheckType
        );
      }
    );

    var meta =
      typeMeta[
        activeCheckType
      ];

    hideResultCard();

    if (verifyInput) {
      verifyInput.hidden =
        meta.isFreeText;

      verifyInput.value = "";

      if (!meta.isFreeText) {
        verifyInput.placeholder =
          meta.placeholder;
      }
    }

    if (verifyInputLabel) {
      verifyInputLabel.hidden =
        meta.isFreeText;

      if (!meta.isFreeText) {
        verifyInputLabel.textContent =
          meta.label;
      }
    }

    if (verifyMessageInput) {
      verifyMessageInput.hidden =
        !meta.isFreeText;

      verifyMessageInput.value = "";

      if (meta.isFreeText) {
        verifyMessageInput.placeholder =
          meta.placeholder;
      }
    }

    if (verifyMessageLabel) {
      verifyMessageLabel.hidden =
        !meta.isFreeText;

      if (meta.isFreeText) {
        verifyMessageLabel.textContent =
          meta.label;
      }
    }
  }

  typeTiles.forEach(
    function (tile) {
      tile.addEventListener(
        "click",
        function () {
          activateCheckType(
            tile.dataset.type
          );
        }
      );
    }
  );

  /* =======================================================================
     PAYMENT RECORD HELPERS
     ======================================================================= */

  function unwrapRecord(item) {
    if (
      item &&
      item.value &&
      typeof item.value === "object"
    ) {
      return item.value;
    }

    return item || null;
  }

  function normaliseAccountNumber(value) {
    return safeText(value)
      .replace(/\D/g, "");
  }

  function normaliseName(value) {
    return safeText(value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function findPaymentRecordMatch(
    inputValue,
    paymentRecords
  ) {
    var v =
      safeText(inputValue).trim();

    if (!v) {
      return null;
    }

    var digits =
      normaliseAccountNumber(v);

    var inputName =
      normaliseName(v);

    return (
      (paymentRecords || []).find(
        function (item) {
          var rec =
            unwrapRecord(item);

          if (!rec) {
            return false;
          }

          /*
           * ACCOUNT NUMBER
           */

          if (
            digits &&
            rec.accountNumber
          ) {
            var recordDigits =
              normaliseAccountNumber(
                rec.accountNumber
              );

            if (
              recordDigits &&
              recordDigits === digits
            ) {
              return true;
            }
          }

          /*
           * ACCOUNT NAME
           *
           * Only compare names when the user input doesn't look like
           * an account number.
           */

          if (
            !/\d/.test(v) &&
            rec.accountName
          ) {
            var recordName =
              normaliseName(
                rec.accountName
              );

            if (
              recordName ===
              inputName
            ) {
              return true;
            }

            /*
             * Allow a slightly broader match for institution account
             * names, but avoid accepting tiny strings.
             */
            if (
              inputName.length >= 5 &&
              (
                recordName.indexOf(
                  inputName
                ) !== -1 ||
                inputName.indexOf(
                  recordName
                ) !== -1
              )
            ) {
              return true;
            }
          }

          return false;
        }
      ) || null
    );
  }

  function findBankNameMatch(
    inputValue,
    paymentRecords,
    bankNameItems
  ) {
    var v =
      normaliseName(inputValue);

    if (!v) {
      return null;
    }

    var paymentMatch =
      (paymentRecords || []).find(
        function (item) {
          var rec =
            unwrapRecord(item);

          if (
            !rec ||
            !rec.bankName
          ) {
            return false;
          }

          var bank =
            normaliseName(
              rec.bankName
            );

          return (
            bank === v ||
            bank.indexOf(v) !== -1 ||
            v.indexOf(bank) !== -1
          );
        }
      );

    if (paymentMatch) {
      return paymentMatch;
    }

    return (
      (bankNameItems || []).find(
        function (item) {
          var bank =
            normaliseName(
              item && item.value
            );

          return (
            bank === v ||
            bank.indexOf(v) !== -1 ||
            v.indexOf(bank) !== -1
          );
        }
      ) || null
    );
  }

  /* =======================================================================
     PHONE / EMAIL / LINK MATCHING
     ======================================================================= */

  function findPhoneMatch(
    inputValue,
    phoneItems
  ) {
    if (
      typeof normalisePhone !==
      "function"
    ) {
      return null;
    }

    var inNorm =
      normalisePhone(
        inputValue
      );

    if (
      !inNorm ||
      inNorm.length !== 9
    ) {
      return null;
    }

    return (
      (phoneItems || []).find(
        function (item) {
          return (
            normalisePhone(
              item &&
                item.value
            ) === inNorm
          );
        }
      ) || null
    );
  }

  function findEmailMatch(
    inputValue,
    emailItems
  ) {
    var v =
      normaliseName(inputValue);

    if (!v) {
      return null;
    }

    return (
      (emailItems || []).find(
        function (item) {
          return (
            normaliseName(
              item &&
                item.value
            ) === v
          );
        }
      ) || null
    );
  }

  function findLinkMatch(
    inputValue,
    sources,
    institution
  ) {
    var raw =
      safeText(inputValue)
        .trim();

    if (!raw) {
      return null;
    }

    var candidate =
      /^https?:\/\//i.test(raw)
        ? raw
        : "https://" + raw;

    var candidateHost = "";

    try {
      candidateHost =
        new URL(
          candidate
        ).hostname
          .toLowerCase()
          .replace(/^www\./, "");
    } catch (e) {
      candidateHost =
        raw
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0];
    }

    var officialDomain =
      institution &&
      institution.domain
        ? institution.domain
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0]
        : "";

    /*
     * Official domain check.
     */

    if (
      officialDomain &&
      (
        candidateHost ===
          officialDomain ||
        candidateHost.endsWith(
          "." + officialDomain
        )
      )
    ) {
      return {
        value: raw,
        source:
          "https://" +
          officialDomain +
          "/"
      };
    }

    /*
     * Exact source / source-host check.
     */

    var srcMatch =
      (sources || []).find(
        function (source) {
          var src =
            safeText(source)
              .trim();

          if (!src) {
            return false;
          }

          try {
            var srcUrl =
              new URL(src);

            var srcHost =
              srcUrl.hostname
                .toLowerCase()
                .replace(/^www\./, "");

            /*
             * A link should match an actual crawled source, not merely
             * contain the same characters somewhere in a URL.
             */
            return (
              normaliseUrl(src) ===
                normaliseUrl(
                  raw
                ) ||
              (
                candidateHost &&
                srcHost ===
                  candidateHost &&
                normaliseUrl(raw)
                  .startsWith(
                    normaliseUrl(
                      src
                    )
                  )
              )
            );
          } catch (e) {
            return (
              normaliseUrl(src) ===
              normaliseUrl(raw)
            );
          }
        }
      );

    return srcMatch
      ? {
          value: raw,
          source: srcMatch
        }
      : null;
  }

  /* =======================================================================
     SCAM MESSAGE SCANNING
     ======================================================================= */

  function scanMessage(rawMessage) {
    var lower =
      safeText(rawMessage)
        .toLowerCase();

    var matches = [];

    if (
      typeof SCAM_PATTERNS !==
      "undefined" &&
      Array.isArray(
        SCAM_PATTERNS
      )
    ) {
      SCAM_PATTERNS.forEach(
        function (pattern) {
          var triggers =
            Array.isArray(
              pattern.triggers
            )
              ? pattern.triggers
              : [];

          var trigger =
            triggers.find(
              function (t) {
                return (
                  lower.indexOf(
                    safeText(t)
                      .toLowerCase()
                  ) !== -1
                );
              }
            );

          if (trigger) {
            matches.push({
              category:
                pattern.category,
              explanation:
                pattern.explanation,
              source:
                pattern.source
            });
          }
        }
      );
    }

    return matches;
  }

  /* =======================================================================
     RESULTS
     ======================================================================= */

  var resultCard =
    $("result-card");

  var evidenceCard =
    $("evidence-card");

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

  var resultClassMap = {
    found:
      "result-card--success",

    partial:
      "result-card--warning",

    notfound:
      "result-card--warning",

    clean:
      "result-card--neutral",

    flagged:
      "result-card--warning"
  };

  function renderResult(
    kind,
    titleHtml,
    bodyHtml
  ) {
    if (!resultCard) {
      return;
    }

    resultCard.className =
      "result-card " +
      (
        resultClassMap[kind] ||
        resultClassMap.partial
      );

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
    checkedAt,
    extraHtml
  ) {
    if (!evidenceCard) {
      return;
    }

    var sourceLink =
      source
        ? "<a href=\"" +
          escapeHtml(source) +
          "\" target=\"_blank\" rel=\"noopener\" class=\"btn btn-ghost btn-small\">View Official Source</a>"
        : "";

    evidenceCard.innerHTML =
      "<span class=\"notice-tag\">Verification Evidence</span>" +

      "<p><strong>Information checked:</strong> " +
      escapeHtml(
        checkedValue
      ) +
      "</p>" +

      "<p><strong>Result:</strong> " +
      escapeHtml(
        resultLabel
      ) +
      "</p>" +

      (
        extraHtml ||
        ""
      ) +

      (
        checkedAt
          ? "<p><strong>Last checked:</strong> " +
            escapeHtml(
              new Date(
                checkedAt
              ).toLocaleString()
            ) +
            "</p>"
          : ""
      ) +

      (
        sourceLink
          ? "<p>" +
            sourceLink +
            "</p>"
          : ""
      );

    evidenceCard.hidden = false;
  }

  /* =======================================================================
     PAYMENT EVIDENCE
     ======================================================================= */

  function renderPaymentEvidence(
    checkedValue,
    paymentRecord,
    checkedAt
  ) {
    var rec =
      unwrapRecord(
        paymentRecord
      );

    if (!rec) {
      renderEvidence(
        checkedValue,
        "Published by Institution",
        null,
        checkedAt
      );

      return;
    }

    var source =
      rec.source ||
      (
        paymentRecord &&
        paymentRecord.source
      ) ||
      null;

    var details = "";

    if (rec.bankName) {
      details +=
        "<p><strong>Bank:</strong> " +
        escapeHtml(
          rec.bankName
        ) +
        "</p>";
    }

    if (rec.accountNumber) {
      details +=
        "<p><strong>Account number:</strong> " +
        escapeHtml(
          rec.accountNumber
        ) +
        "</p>";
    }

    if (rec.accountName) {
      details +=
        "<p><strong>Account name:</strong> " +
        escapeHtml(
          rec.accountName
        ) +
        "</p>";
    }

    if (rec.branch) {
      details +=
        "<p><strong>Branch:</strong> " +
        escapeHtml(
          rec.branch
        ) +
        "</p>";
    }

    if (rec.pageTitle) {
      details +=
        "<p><strong>Page/document:</strong> " +
        escapeHtml(
          rec.pageTitle
        ) +
        "</p>";
    }

    if (rec.context) {
      details +=
        "<p><strong>Published context:</strong> " +
        escapeHtml(
          rec.context
        ) +
        "</p>";
    }

    renderEvidence(
      checkedValue,
      "Published by Institution",
      source,
      checkedAt,
      details
    );
  }

  /* =======================================================================
     STATS
     ======================================================================= */

  function loadStats() {
    try {
      return (
        JSON.parse(
          localStorage.getItem(
            "cv-stats"
          )
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

  function logVerification(
    flagged
  ) {
    var s =
      loadStats();

    s.total++;

    if (flagged) {
      s.flagged++;
    }

    saveStats(s);

    renderImpactStats();
  }

  function logReport() {
    var s =
      loadStats();

    s.reports++;

    saveStats(s);

    renderImpactStats();
  }

  function renderImpactStats() {
    var s =
      loadStats();

    var totalEl =
      $("impact-total");

    var flaggedEl =
      $("impact-flagged");

    var reportsEl =
      $("impact-reports");

    if (totalEl) {
      totalEl.textContent =
        s.total;
    }

    if (flaggedEl) {
      flaggedEl.textContent =
        s.flagged;
    }

    if (reportsEl) {
      reportsEl.textContent =
        s.reports;
    }
  }

  /* =======================================================================
     VERIFICATION FORM
     ======================================================================= */

  var verifyEmptyWarning =
    $("verify-empty-warning");

  function renderNotFoundResult(
    data,
    institution,
    value,
    category
  ) {
    var incomplete =
      !data.dataComplete;

    var institutionName =
      data.institutionName ||
      (
        institution &&
        institution.name
      ) ||
      "the institution";

    renderResult(
      incomplete
        ? "partial"
        : "notfound",

      incomplete
        ? "🟡 Unable to fully verify"
        : "🔴 Not found on official sources",

      (
        incomplete
          ? "Some official pages could not be checked, so this isn't a complete result. "
          : ""
      ) +

      "CampusVerify could not find this " +
      escapeHtml(
        category
      ) +
      " on " +
      escapeHtml(
        institutionName
      ) +
      "'s official sources. This isn't automatic proof of fraud — confirm directly with the institution before proceeding."
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

  function submitVerification(
    event
  ) {
    event.preventDefault();

    hideResultCard();

    if (verifyEmptyWarning) {
      verifyEmptyWarning.hidden =
        true;
    }

    if (!currentInstitutionId) {
      renderResult(
        "partial",
        "🟡 Institution not identified",
        "Please identify your institution using its official website before checking information."
      );

      return;
    }

    var institution =
      getCurrentInstitution();

    var meta =
      typeMeta[
        activeCheckType
      ];

    if (!meta) {
      return;
    }

    /* ---------------------------------------------------------------------
       FREE TEXT / SCAM CHECK
       --------------------------------------------------------------------- */

    if (meta.isFreeText) {
      var msg =
        verifyMessageInput
          ? verifyMessageInput.value.trim()
          : "";

      if (!msg) {
        if (verifyEmptyWarning) {
          verifyEmptyWarning.hidden =
            false;
        }

        return;
      }

      var matches =
        scanMessage(msg);

      if (matches.length) {
        var items =
          matches
            .map(
              function (m) {
                return (
                  "<li><strong>" +
                  escapeHtml(
                    m.category
                  ) +
                  ":</strong> " +
                  escapeHtml(
                    m.explanation
                  ) +
                  "</li>"
                );
              }
            )
            .join("");

        if (resultCard) {
          resultCard.className =
            "result-card result-card--warning";

          resultCard.innerHTML =
            "<strong>🔴 Scam indicators found</strong>" +
            "<ul class=\"result-list\">" +
            items +
            "</ul>";

          resultCard.hidden =
            false;
        }

        renderEvidence(
          msg.slice(0, 80) +
            (
              msg.length > 80
                ? "…"
                : ""
            ),

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

    /* ---------------------------------------------------------------------
       NORMAL VERIFICATION
       --------------------------------------------------------------------- */

    var value =
      verifyInput
        ? verifyInput.value.trim()
        : "";

    if (!value) {
      if (verifyEmptyWarning) {
        verifyEmptyWarning.hidden =
          false;
      }

      return;
    }

    crawlInstitution(
      currentInstitutionId
    ).then(
      function (data) {
        if (
          !data ||
          data.crawlFailed
        ) {
          renderResult(
            "partial",
            "🟡 Unable to check right now",
            "CampusVerify couldn't reach " +
              escapeHtml(
                (
                  data &&
                  data.institutionName
                ) ||
                (
                  institution &&
                  institution.name
                ) ||
                "the institution"
              ) +
              "'s official pages at this moment. This is not a result — please try again shortly."
          );

          return;
        }

        var items =
          data.items || {};

        var incomplete =
          !data.dataComplete;

        /* -----------------------------------------------------------------
           PHONE
           ----------------------------------------------------------------- */

        if (
          activeCheckType ===
          "phone"
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
            renderNotFoundResult(
              data,
              institution,
              value,
              "phone number"
            );
          }

          logVerification(
            !phoneMatch
          );

          return;
        }

        /* -----------------------------------------------------------------
           EMAIL
           ----------------------------------------------------------------- */

        if (
          activeCheckType ===
          "email"
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
            renderNotFoundResult(
              data,
              institution,
              value,
              "email address"
            );
          }

          logVerification(
            !emailMatch
          );

          return;
        }

        /* -----------------------------------------------------------------
           BANK / PAYMENT
           ----------------------------------------------------------------- */

        if (
          activeCheckType ===
          "bank"
        ) {
          /*
           * FIRST:
           *
           * Search for an actual payment record.
           */

          var paymentMatch =
            findPaymentRecordMatch(
              value,
              items.paymentRecords
            );

          /*
           * SECOND:
           *
           * If no exact account/payment record exists, determine whether
           * the institution at least mentions the bank.
           */

          var bankNameMatch =
            !paymentMatch
              ? findBankNameMatch(
                  value,
                  items.paymentRecords,
                  items.bankNames
                )
              : null;

          if (paymentMatch) {
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
             * A legitimate published account is not marked suspicious merely
             * because an external payment gateway accepts or rejects it.
             */
            logVerification(false);

            return;
          }

          if (bankNameMatch) {
            var bankRecord =
              unwrapRecord(
                bankNameMatch
              );

            var bankSource =
              (
                bankRecord &&
                bankRecord.source
              ) ||
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
              data.checkedAt,
              bankRecord &&
              bankRecord.accountNumber
                ? "<p><strong>Published account associated with this bank:</strong> " +
                  escapeHtml(
                    bankRecord.accountNumber
                  ) +
                  "</p>"
                : ""
            );

            /*
             * This is intentionally treated as a warning/partial result,
             * not proof of fraud.
             */
            logVerification(true);

            return;
          }

          /*
           * NOTHING FOUND.
           */

          renderResult(
            incomplete
              ? "partial"
              : "notfound",

            incomplete
              ? "🟡 Unable to fully verify"
              : "🟡 Not found in published payment details",

            (
              incomplete
                ? "Some official pages could not be checked, so CampusVerify cannot make a complete determination. "
                : ""
            ) +

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

          return;
        }

        /* -----------------------------------------------------------------
           LINK
           ----------------------------------------------------------------- */

        if (
          activeCheckType ===
          "link"
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
              incomplete
                ? "partial"
                : "notfound",

              incomplete
                ? "🟡 Unable to fully verify"
                : "🔴 Not found on official sources",

              (
                incomplete
                  ? "Some official pages could not be checked, so this isn't a complete result. "
                  : ""
              ) +

              "This doesn't match " +
                escapeHtml(
                  data.institutionName
                ) +
                "'s official domain or any page CampusVerify has checked. This isn't automatic proof it's fake — confirm directly before proceeding."
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
            !linkMatch
          );
        }
      }
    );
  }

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var typeCheckForm =
        document.querySelector(
          "#step-choose-type .check-form"
        );

      if (typeCheckForm) {
        typeCheckForm.addEventListener(
          "submit",
          submitVerification
        );
      }
    }
  );

  /* =======================================================================
     INFO PAGE
     ======================================================================= */

  var infoSearchInput = null;
  var filterChips = null;
  var infoListEl = null;
  var infoEmptyEl = null;

  function renderInfoBody() {
    var noInstEl =
      $("info-no-institution");

    var bodyEl =
      $("info-body");

    var nameEl =
      $("info-institution-name");

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
      $("info-search");

    filterChips =
      document.querySelectorAll(
        ".chip"
      );

    infoListEl =
      $("info-list");

    infoEmptyEl =
      $("info-empty");

    var institution =
      getCurrentInstitution();

    if (
      nameEl &&
      institution
    ) {
      nameEl.textContent =
        institution.name;
    }

    if (!infoListEl) {
      return;
    }

    infoListEl.innerHTML =
      "<p class=\"empty-state\">Loading live data…</p>";

    crawlInstitution(
      currentInstitutionId
    ).then(
      function (data) {
        var items = [];

        var it =
          data.items || {};

        /* ---------------------------------------------------------------
           Phones
           --------------------------------------------------------------- */

        (
          it.phones || []
        ).forEach(
          function (p) {
            items.push({
              type: "contact",
              label: "Phone",
              value:
                p.value,
              source:
                p.source
            });
          }
        );

        /* ---------------------------------------------------------------
           Emails
           --------------------------------------------------------------- */

        (
          it.emails || []
        ).forEach(
          function (e) {
            items.push({
              type: "contact",
              label: "Email",
              value:
                e.value,
              source:
                e.source
            });
          }
        );

        /* ---------------------------------------------------------------
           Payment records
           --------------------------------------------------------------- */

        (
          it.paymentRecords ||
          []
        ).forEach(
          function (item) {
            var rec =
              unwrapRecord(
                item
              );

            if (!rec) {
              return;
            }

            var source =
              rec.source ||
              item.source ||
              null;

            if (
              rec.accountNumber
            ) {
              items.push({
                type: "bank",
                label:
                  "Account number",
                value:
                  String(
                    rec.accountNumber
                  ),
                source:
                  source
              });
            }

            if (
              rec.bankName
            ) {
              items.push({
                type: "bank",
                label:
                  "Bank",
                value:
                  String(
                    rec.bankName
                  ),
                source:
                  source
              });
            }

            if (
              rec.accountName
            ) {
              items.push({
                type: "bank",
                label:
                  "Account name",
                value:
                  String(
                    rec.accountName
                  ),
                source:
                  source
              });
            }

            if (
              rec.branch
            ) {
              items.push({
                type: "bank",
                label:
                  "Branch",
                value:
                  String(
                    rec.branch
                  ),
                source:
                  source
              });
            }

            if (
              rec.pageTitle
            ) {
              items.push({
                type: "document",
                label:
                  "Payment source",
                value:
                  String(
                    rec.pageTitle
                  ),
                source:
                  source
              });
            }
          }
        );

        /* ---------------------------------------------------------------
           Independent bank names
           --------------------------------------------------------------- */

        (
          it.bankNames || []
        ).forEach(
          function (b) {
            var bankValue =
              String(
                b.value || ""
              );

            if (!bankValue) {
              return;
            }

            var alreadyListed =
              items.some(
                function (
                  existing
                ) {
                  return (
                    existing.type ===
                      "bank" &&
                    existing.label ===
                      "Bank" &&
                    normaliseName(
                      existing.value
                    ) ===
                      normaliseName(
                        bankValue
                      )
                  );
                }
              );

            if (!alreadyListed) {
              items.push({
                type:
                  "bank",
                label:
                  "Bank",
                value:
                  bankValue,
                source:
                  b.source
              });
            }
          }
        );

        /* ---------------------------------------------------------------
           Payment instructions
           --------------------------------------------------------------- */

        (
          it.paymentInstructions ||
          []
        ).forEach(
          function (instruction) {
            var value =
              instruction &&
              instruction.value
                ? instruction.value
                : instruction;

            if (!value) {
              return;
            }

            items.push({
              type:
                "payment",
              label:
                "Payment instruction",
              value:
                String(
                  value
                ),
              source:
                instruction &&
                instruction.source
                  ? instruction.source
                  : null
            });
          }
        );

        /* ---------------------------------------------------------------
           Official pages
           --------------------------------------------------------------- */

        (
          data.sources || []
        ).forEach(
          function (source) {
            items.push({
              type:
                "link",
              label:
                "Official page",
              value:
                source,
              source:
                source
            });
          }
        );

        var query =
          (
            infoSearchInput &&
            infoSearchInput.value
          ) || "";

        query =
          query
            .toLowerCase()
            .trim();

        var visible =
          items.filter(
            function (item) {
              var itemValue =
                String(
                  item.value ||
                    ""
                ).toLowerCase();

              var matchesFilter =
                activeFilter ===
                  "all" ||
                item.type ===
                  activeFilter;

              var matchesQuery =
                !query ||
                itemValue.indexOf(
                  query
                ) !== -1;

              return (
                matchesFilter &&
                matchesQuery
              );
            }
          );

        if (!items.length) {
          infoListEl.innerHTML =
            "<p class=\"empty-state\">" +
            (
              data.crawlFailed
                ? "Could not reach this institution's official pages right now."
                : "Nothing found on this institution's approved pages right now."
            ) +
            "</p>";

          if (infoEmptyEl) {
            infoEmptyEl.hidden =
              true;
          }

          return;
        }

        if (infoEmptyEl) {
          infoEmptyEl.hidden =
            visible.length !== 0;
        }

        infoListEl.innerHTML =
          visible
            .map(
              function (item) {
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
              }
            )
            .join("");
      }
    );
  }

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var s =
        $("info-search");

      if (s) {
        s.addEventListener(
          "input",
          renderInfoBody
        );
      }

      document
        .querySelectorAll(
          ".chip"
        )
        .forEach(
          function (chip) {
            chip.addEventListener(
              "click",
              function () {
                document
                  .querySelectorAll(
                    ".chip"
                  )
                  .forEach(
                    function (
                      c
                    ) {
                      c.classList.remove(
                        "is-active"
                      );
                    }
                  );

                chip.classList.add(
                  "is-active"
                );

                activeFilter =
                  chip.dataset.filter ||
                  "all";

                renderInfoBody();
              }
            );
          }
        );
    }
  );

  /* =======================================================================
     REPORT CENTRE
     ======================================================================= */

  var reportForm =
    $("report-form");

  var reportSummary =
    $("report-summary");

  var reportActions =
    $("report-actions");

  var reportEmptyWarning =
    $("report-empty-warning");

  var reportCopyBtn =
    $("report-copy-btn");

  var reportClearBtn =
    $("report-clear-btn");

  function buildReportText() {
    var descEl =
      $("report-description");

    var phoneEl =
      $("report-phone");

    var emailEl =
      $("report-email");

    var bankEl =
      $("report-bank");

    var desc =
      descEl
        ? descEl.value.trim()
        : "";

    var phone =
      phoneEl
        ? phoneEl.value.trim()
        : "";

    var email =
      emailEl
        ? emailEl.value.trim()
        : "";

    var bank =
      bankEl
        ? bankEl.value.trim()
        : "";

    var inst =
      getCurrentInstitution();

    var data =
      currentInstitutionId
        ? crawlCache[
            currentInstitutionId
          ]
        : null;

    return [
      "CampusVerify — Suspicious Activity Report",

      "Institution: " +
        (
          inst
            ? inst.name
            : "Not identified — verify a website first"
        ),

      "Official website: " +
        (
          inst &&
          inst.domain
            ? "https://" +
              inst.domain
            : "Not provided"
        ),

      "Prepared: " +
        new Date().toLocaleString(),

      "",

      "Description: " +
        (
          desc ||
          "Not provided"
        ),

      "Phone involved: " +
        (
          phone ||
          "Not provided"
        ),

      "Email involved: " +
        (
          email ||
          "Not provided"
        ),

      "Bank account involved: " +
        (
          bank ||
          "Not provided"
        ),

      "",

      "CampusVerify crawl status: " +
        (
          data
            ? (
                data.dataComplete
                  ? "Complete"
                  : "Incomplete"
              )
            : "Not available"
        )
    ].join("\n");
  }

  function generateReport(
    event
  ) {
    event.preventDefault();

    var descEl =
      $("report-description");

    var phoneEl =
      $("report-phone");

    var emailEl =
      $("report-email");

    var bankEl =
      $("report-bank");

    var desc =
      descEl
        ? descEl.value.trim()
        : "";

    var phone =
      phoneEl
        ? phoneEl.value.trim()
        : "";

    var email =
      emailEl
        ? emailEl.value.trim()
        : "";

    var bank =
      bankEl
        ? bankEl.value.trim()
        : "";

    if (
      !desc &&
      !phone &&
      !email &&
      !bank
    ) {
      if (reportEmptyWarning) {
        reportEmptyWarning.hidden =
          false;
      }

      return;
    }

    if (reportEmptyWarning) {
      reportEmptyWarning.hidden =
        true;
    }

    var text =
      buildReportText();

    if (reportSummary) {
      reportSummary.textContent =
        text;

      reportSummary.hidden =
        false;
    }

    if (reportActions) {
      reportActions.hidden =
        false;
    }

    logReport();
  }

  function copyReport() {
    if (!reportSummary) {
      return;
    }

    var text =
      reportSummary.textContent;

    if (
      navigator.clipboard &&
      navigator.clipboard.writeText
    ) {
      navigator.clipboard
        .writeText(text)
        .catch(
          function () {}
        );
    }

    var confirmEl =
      document.createElement(
        "p"
      );

    confirmEl.className =
      "notice notice-soft";

    confirmEl.textContent =
      "Copied to clipboard.";

    if (
      reportActions &&
      reportActions.parentNode
    ) {
      reportActions.parentNode.insertBefore(
        confirmEl,
        reportActions.nextSibling
      );
    }

    setTimeout(
      function () {
        if (
          confirmEl &&
          confirmEl.remove
        ) {
          confirmEl.remove();
        }
      },
      1800
    );
  }

  function clearReportForm() {
    if (reportForm) {
      reportForm.reset();
    }

    if (reportSummary) {
      reportSummary.hidden =
        true;
    }

    if (reportActions) {
      reportActions.hidden =
        true;
    }

    if (reportEmptyWarning) {
      reportEmptyWarning.hidden =
        true;
    }
  }

  function renderReportChannels() {
    var container =
      $("report-channels");

    if (!container) {
      return;
    }

    var inst =
      getCurrentInstitution();

    var links =
      (
        inst &&
        Array.isArray(
          inst.reportingLinks
        )
          ? inst.reportingLinks
          : []
      );

    container.innerHTML =
      links
        .map(
          function (l) {
            if (
              !l ||
              !l.url
            ) {
              return "";
            }

            return (
              "<a class=\"info-card info-card-link\" href=\"" +
              escapeHtml(
                l.url
              ) +
              "\" target=\"_blank\" rel=\"noopener\">" +
              escapeHtml(
                l.label ||
                l.url
              ) +
              "</a>"
            );
          }
        )
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

  /* =======================================================================
     SETTINGS
     ======================================================================= */

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

  function savePreferences(
    prefs
  ) {
    try {
      localStorage.setItem(
        "cv-prefs",
        JSON.stringify(
          prefs
        )
      );
    } catch (e) {}
  }

  function applyPreferences(
    prefs
  ) {
    prefs =
      prefs || {};

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
      $("setting-dark-mode");

    var l =
      $("setting-large-text");

    var m =
      $("setting-reduced-motion");

    if (d) {
      d.checked =
        !!prefs.darkMode;
    }

    if (l) {
      l.checked =
        !!prefs.largeText;
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
    if (!el) {
      return;
    }

    var p =
      loadPreferences();

    p[key] =
      el.checked;

    savePreferences(p);

    applyPreferences(p);
  }

  document.addEventListener(
    "DOMContentLoaded",
    function () {
      var darkToggle =
        $("setting-dark-mode");

      var textToggle =
        $("setting-large-text");

      var motionToggle =
        $("setting-reduced-motion");

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
        $("settings-reset-btn");

      if (resetBtn) {
        resetBtn.addEventListener(
          "click",
          function () {
            savePreferences(
              {}
            );

            applyPreferences(
              {}
            );

            var confirmEl =
              $("settings-reset-confirm");

            if (confirmEl) {
              confirmEl.hidden =
                false;

              setTimeout(
                function () {
                  confirmEl.hidden =
                    true;
                },
                1800
              );
            }
          }
        );
      }

      var countEl =
        $("settings-institution-count");

      if (
        countEl &&
        typeof INSTITUTIONS !==
          "undefined" &&
        Array.isArray(
          INSTITUTIONS
        )
      ) {
        countEl.textContent =
          INSTITUTIONS.length;
      }

      renderImpactStats();

      applyPreferences(
        loadPreferences()
      );

      renderReportChannels();

      /*
       * Make sure the initial verification tile state is consistent with
       * the HTML even if no tile has been clicked yet.
       */
      activateCheckType(
        activeCheckType
      );
    }
  );
})();
