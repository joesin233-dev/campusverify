/* =========================================================================
   CampusVerify v3.4 — script.js
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
   - Report Centre requires an identified institution.
   - Institution-specific reporting contacts are loaded from:
       data/reporting/<institution-id>.json
   ========================================================================= */

(function () {
  "use strict";

  /* =======================================================================
     STATE
     ======================================================================= */

  var currentInstitutionId = null;

  var crawlCache = {};
  var crawlInFlight = {};

  var reportingCache = {};
  var reportingInFlight = {};

  var activeCheckType = "phone";
  var activeFilter = "all";

  /*
   * Information from the most recent verification.
   *
   * This allows an "Unable to fully verify" result to send the student
   * directly to the Report Centre with the checked information already
   * filled in.
   */
  var lastVerification = {
    type: null,
    value: "",
    institutionId: null
  };

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

  function getOfficialSiteUrl(inst) {
    if (!inst) {
      return null;
    }

    if (inst.homepage) {
      return inst.homepage;
    }

    if (!inst.domain) {
      return null;
    }

    return /^https?:\/\//i.test(inst.domain)
      ? inst.domain
      : "https://" + inst.domain + "/";
  }

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

    if (visitSiteBtn) {
      var officialSiteUrl =
        getOfficialSiteUrl(inst);

      if (officialSiteUrl) {
        visitSiteBtn.href =
          officialSiteUrl;

        visitSiteBtn.target = "_blank";
        visitSiteBtn.rel = "noopener";
      }
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

    /*
     * Clear any previous verification when switching institution.
     */
    lastVerification = {
      type: null,
      value: "",
      institutionId: inst.id
    };

    hideResultCard();

    /*
     * Begin crawling immediately so the data is ready when the student
     * presses "Verify Something Now".
     */
    crawlInstitution(
      currentInstitutionId
    ).then(function () {
      renderInfoBody();
      renderReportChannels();
      renderReportInstitutionContacts();
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

        lastVerification = {
          type: null,
          value: "",
          institutionId: null
        };

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
        renderReportInstitutionContacts();
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
      (
        data.pagesCrawled &&
        data.pagesCrawled.length
      ) ||
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
        institution
          ? (
              getOfficialSiteUrl(
                institution
              ) || ""
            )
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

  function showReportAccessMessage() {
    var existing =
      $("report-access-warning");

    if (existing) {
      existing.hidden = false;

      existing.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

      return;
    }

    if (identifyError) {
      identifyError.textContent =
        "Please enter the institution website first.";

      identifyError.hidden = false;
    }

    if (stepIdentify) {
      stepIdentify.hidden = false;

      stepIdentify.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }
  }

  function showPage(pageName) {
    /*
     * Report Centre is institution-specific.
     *
     * Do not allow a report to be opened before an institution has been
     * identified.
     */
    if (
      pageName === "report" &&
      !currentInstitutionId
    ) {
      pages.forEach(
        function (page) {
          page.hidden =
            page.dataset.page !==
            "verify";
        }
      );

      tabs.forEach(
        function (tab) {
          tab.classList.toggle(
            "is-active",
            tab.dataset.goto ===
              "verify"
          );
        }
      );

      showReportAccessMessage();

      return;
    }

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
      renderReportInstitutionContacts();
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

  /*
   * NOTE: this function is called from the "bank/payment" result branch
   * further down (on an exact payment-record match), but it did not
   * exist anywhere in the original file — calling it would throw a
   * runtime error the first time someone verified a matching bank
   * detail. Added here (purely additive, nothing else changed) so a
   * successful bank/payment verification renders instead of crashing.
   */
  function renderPaymentEvidence(
    checkedValue,
    matchItem,
    checkedAt
  ) {
    var rec =
      unwrapRecord(matchItem);

    if (!rec) {
      renderEvidence(
        checkedValue,
        "Found",
        (matchItem && matchItem.source) ||
          null,
        checkedAt
      );

      return;
    }

    var extra = "";

    if (rec.bankName) {
      extra +=
        "<p><strong>Bank:</strong> " +
        escapeHtml(rec.bankName) +
        "</p>";
    }

    if (rec.accountName) {
      extra +=
        "<p><strong>Account name:</strong> " +
        escapeHtml(rec.accountName) +
        "</p>";
    }

    if (
      rec.publishedAccountNumber ||
      rec.accountNumber
    ) {
      extra +=
        "<p><strong>Account number:</strong> " +
        escapeHtml(
          rec.publishedAccountNumber ||
            rec.accountNumber
        ) +
        "</p>";
    }

    if (rec.branch) {
      extra +=
        "<p><strong>Branch:</strong> " +
        escapeHtml(rec.branch) +
        "</p>";
    }

    renderEvidence(
      checkedValue,
      "Found",
      rec.source ||
        (matchItem && matchItem.source) ||
        null,
      checkedAt,
      extra
    );
  }

  /* =======================================================================
     QUICK EVIDENCE (instant check against the static evidence file)
     -----------------------------------------------------------------------
     data/evidence/<institutionId>.json is the trusted, pre-published
     institutional evidence file — the SAME file the crawler loads as its
     baseline. Fetching it directly from the browser is effectively
     instant (a small static JSON file, no live crawling), so a student
     checking something already published there does not have to wait
     for the full website crawl to finish.

     This is intentionally a SUBSET of the crawler's own evidence-merge
     logic: just enough to run an exact match on phones/emails/bank
     payment records. It is only ever used to confirm a POSITIVE match
     early. A miss here proves nothing by itself — if it's not found
     here, verification falls through to the full live crawl exactly as
     before, so "not found" / "unable to verify" / Report Centre behavior
     is completely unchanged.
     ======================================================================= */

  var quickEvidenceCache = {};
  var quickEvidenceInFlight = {};

  function normaliseQuickEvidence(raw) {
    var items = {
      phones: [],
      emails: [],
      bankNames: [],
      paymentRecords: []
    };

    var list =
      raw && Array.isArray(raw.evidence)
        ? raw.evidence
        : [];

    list.forEach(function (item) {
      if (!item || !item.type) {
        return;
      }

      var sourceUrl =
        (
          item.source &&
          typeof item.source === "object" &&
          item.source.url
        ) ||
        item.sourceUrl ||
        (
          typeof item.source === "string"
            ? item.source
            : ""
        ) ||
        "";

      if (item.type === "contact") {
        var field =
          String(item.field || "").toLowerCase();

        if (
          item.value &&
          (
            field.indexOf("phone") !== -1 ||
            field.indexOf("telephone") !== -1 ||
            field.indexOf("mobile") !== -1 ||
            field.indexOf("tel") !== -1
          )
        ) {
          items.phones.push({
            value: item.value,
            source: sourceUrl
          });
        }

        if (
          item.value &&
          (
            field.indexOf("email") !== -1 ||
            field.indexOf("mail") !== -1
          )
        ) {
          items.emails.push({
            value: item.value,
            source: sourceUrl
          });
        }

        return;
      }

      if (item.type === "phone" && item.value) {
        items.phones.push({
          value: item.value,
          source: sourceUrl
        });
        return;
      }

      if (item.type === "email" && item.value) {
        items.emails.push({
          value: item.value,
          source: sourceUrl
        });
        return;
      }

      if (item.type === "payment") {
        var accountNumber =
          item.accountNumber ||
          item.account_number ||
          "";

        if (accountNumber) {
          items.paymentRecords.push({
            value: {
              accountNumber: accountNumber,
              publishedAccountNumber:
                accountNumber,
              bankName:
                item.bankName ||
                item.bank ||
                "",
              accountName:
                item.accountName ||
                item.account_name ||
                "",
              branch: item.branch || "",
              source: sourceUrl
            },
            source: sourceUrl
          });
        }
      }
    });

    return items;
  }

  function loadQuickEvidence(institutionId) {
    if (!institutionId) {
      return Promise.resolve(null);
    }

    if (quickEvidenceCache[institutionId]) {
      return Promise.resolve(
        quickEvidenceCache[institutionId]
      );
    }

    if (quickEvidenceInFlight[institutionId]) {
      return quickEvidenceInFlight[institutionId];
    }

    var url =
      "/data/evidence/" +
      encodeURIComponent(institutionId) +
      ".json";

    var req =
      fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store"
      })
        .then(function (res) {
          if (!res.ok) {
            throw new Error(
              "evidence_http_" + res.status
            );
          }

          return res.json();
        })
        .then(function (raw) {
          var normalised =
            normaliseQuickEvidence(raw);

          quickEvidenceCache[institutionId] =
            normalised;

          delete quickEvidenceInFlight[
            institutionId
          ];

          return normalised;
        })
        .catch(function () {
          delete quickEvidenceInFlight[
            institutionId
          ];

          /*
           * Fail silently: this is purely an optimisation. If the file
           * can't be fetched for any reason, verification simply
           * proceeds on the normal full-crawl path exactly as before.
           */
          return null;
        });

    quickEvidenceInFlight[institutionId] = req;

    return req;
  }

  /*
   * Tries to answer immediately from the static evidence file. Returns
   * true if it rendered a FOUND result, false otherwise. Never
   * short-circuits "not found" or "unable to verify" — only positive
   * matches, since the quick evidence is a subset of the full crawl.
   */
  function tryQuickMatch(
    value,
    institution,
    quickItems
  ) {
    if (!quickItems) {
      return false;
    }

    var institutionLabel =
      (institution && institution.name) ||
      "the institution";

    if (activeCheckType === "phone") {
      var quickPhone =
        findPhoneMatch(value, quickItems.phones);

      if (quickPhone) {
        renderResult(
          "found",
          "🟢 Found on official source",
          "This phone number was found on " +
            escapeHtml(institutionLabel) +
            "'s official published records."
        );

        renderEvidence(
          value,
          "Found",
          quickPhone.source,
          new Date().toISOString()
        );

        logVerification(false);

        return true;
      }

      return false;
    }

    if (activeCheckType === "email") {
      var quickEmail =
        findEmailMatch(value, quickItems.emails);

      if (quickEmail) {
        renderResult(
          "found",
          "🟢 Found on official source",
          "This email address was found on " +
            escapeHtml(institutionLabel) +
            "'s official published records."
        );

        renderEvidence(
          value,
          "Found",
          quickEmail.source,
          new Date().toISOString()
        );

        logVerification(false);

        return true;
      }

      return false;
    }

    if (activeCheckType === "bank") {
      var quickPayment =
        findPaymentRecordMatch(
          value,
          quickItems.paymentRecords
        );

      if (quickPayment) {
        renderResult(
          "found",
          "🟢 Published by Institution",
          "This payment detail matches an account record publicly published by " +
            escapeHtml(institutionLabel) +
            "."
        );

        renderPaymentEvidence(
          value,
          quickPayment,
          new Date().toISOString()
        );

        logVerification(false);

        return true;
      }

      return false;
    }

    /*
     * "link" is not fast-pathed here — matching the official domain is
     * already instant with no evidence file needed (see findLinkMatch),
     * and it still runs inside the normal flow below.
     */
    return false;
  }

  /* =======================================================================
     REPORT CTA
     ======================================================================= */

  function rememberVerification(
    type,
    value
  ) {
    lastVerification = {
      type: type || null,
      value: safeText(value).trim(),
      institutionId:
        currentInstitutionId
    };
  }

  function addReportCentreButton() {
    if (!resultCard) {
      return;
    }

    if (
      resultCard.querySelector(
        "[data-action='go-report']"
      )
    ) {
      return;
    }

    var wrapper =
      document.createElement("div");

    wrapper.className =
      "report-result-cta";

    wrapper.innerHTML =
      "<button type=\"button\" class=\"btn btn-primary\" data-action=\"go-report\">" +
      "Go to Report Centre" +
      "</button>" +

      "<p class=\"notice-soft\" style=\"margin-top:10px;\">" +
      "You can prepare a report and contact the institution using its official reporting channels." +
      "</p>";

    resultCard.appendChild(
      wrapper
    );

    var button =
      wrapper.querySelector(
        "[data-action='go-report']"
      );

    if (button) {
      button.addEventListener(
        "click",
        function () {
          openReportCentreFromVerification();
        }
      );
    }
  }

  function openReportCentreFromVerification() {
    if (!currentInstitutionId) {
      showPage("report");
      return;
    }

    prefillReportFromVerification();

    showPage("report");

    var form =
      $("report-form");

    if (form) {
      setTimeout(
        function () {
          form.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        },
        100
      );
    }
  }

  function prefillReportFromVerification() {
    if (!lastVerification.value) {
      return;
    }

    var value =
      lastVerification.value;

    var phoneEl =
      $("report-phone");

    var emailEl =
      $("report-email");

    var bankEl =
      $("report-bank");

    var descEl =
      $("report-description");

    if (
      lastVerification.type ===
      "phone"
    ) {
      if (phoneEl) {
        phoneEl.value =
          value;
      }
    }

    if (
      lastVerification.type ===
      "email"
    ) {
      if (emailEl) {
        emailEl.value =
          value;
      }
    }

    if (
      lastVerification.type ===
      "bank"
    ) {
      if (bankEl) {
        bankEl.value =
          value;
      }
    }

    if (
      lastVerification.type ===
      "link"
    ) {
      if (descEl) {
        descEl.value =
          descEl.value.trim()
            ? descEl.value
            : "Suspicious website or link checked by CampusVerify:\n" +
              value;
      }
    }

    if (
      lastVerification.type ===
      "other"
    ) {
      if (descEl) {
        descEl.value =
          descEl.value.trim()
            ? descEl.value
            : "Suspicious message checked by CampusVerify:\n\n" +
              value;
      }
    }
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

    rememberVerification(
      activeCheckType,
      value
    );

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

    if (incomplete) {
      addReportCentreButton();
    }
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

      rememberVerification(
        activeCheckType,
        msg
      );

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

    rememberVerification(
      activeCheckType,
      value
    );

    /*
     * STEP 1 — instant check against the static evidence file.
     * If it's an exact match, show it right away without waiting on
     * the live crawl at all. If not, fall through to the normal full
     * crawl-based verification below — completely unchanged.
     */
    loadQuickEvidence(
      currentInstitutionId
    ).then(function (quickItems) {
      var quickMatched =
        tryQuickMatch(
          value,
          institution,
          quickItems
        );

      if (quickMatched) {
        return;
      }

      runFullVerification(
        value,
        institution
      );
    });
  }

  /*
   * STEP 2 — the original full-crawl verification, unchanged, just
   * pulled into its own function so it can be called either directly
   * or after the quick-evidence check above finds nothing.
   */
  function runFullVerification(
    value,
    institution
  ) {
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

          addReportCentreButton();

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

            addReportCentreButton();

            logVerification(true);

            return;
          }

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

          if (incomplete) {
            addReportCentreButton();
          }

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

            if (incomplete) {
              addReportCentreButton();
            }
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

  /* =======================================================================
     REPORTING JSON LOADER
     ======================================================================= */

  /*
   * Each supported institution can have its own reporting file:
   *
   * data/reporting/unilus.json
   * data/reporting/zcas.json
   * data/reporting/unza.json
   *
   * The loader reads the institution-specific file.
   */

  function normaliseReportingData(data) {
    data = data || {};

    var contacts = [];

    /* ---------------------------------------------------------------------
       STANDARD CATEGORY FORMAT

       Example:

       contacts: [
         {
           category: "Accounts Department",
           purpose: "...",
           phones: [
             {
               number: "+260 975 884 829",
               type: "phone"
             }
           ],
           emails: [
             "accounts@unilus.ac.zm"
           ]
         }
       ]
       --------------------------------------------------------------------- */

    if (Array.isArray(data.contacts)) {
      data.contacts.forEach(function (group) {
        if (!group) {
          return;
        }

        var category =
          safeText(
            group.category ||
            group.department ||
            group.group ||
            group.name ||
            "Official Contact"
          ).trim();

        var purpose =
          safeText(
            group.purpose ||
            ""
          ).trim();

        var hours =
          safeText(
            group.hours ||
            ""
          ).trim();

        var groupSource =
          safeText(
            group.source ||
            group.sourceUrl ||
            ""
          ).trim();

        /*
         * PHONE NUMBERS
         */
        if (Array.isArray(group.phones)) {
          group.phones.forEach(function (phone) {
            if (!phone) {
              return;
            }

            var number =
              typeof phone === "string"
                ? phone
                : (
                    phone.number ||
                    phone.value ||
                    phone.phone ||
                    ""
                  );

            number =
              safeText(number).trim();

            if (!number) {
              return;
            }

            contacts.push({
              category: category,
              purpose: purpose,
              hours: hours,
              type: "phone",
              value: number,
              label: "Phone",
              source:
                (
                  typeof phone === "object" &&
                  (
                    phone.source ||
                    phone.sourceUrl
                  )
                ) ||
                groupSource ||
                ""
            });
          });
        }

        /*
         * EMAIL ADDRESSES
         */
        if (Array.isArray(group.emails)) {
          group.emails.forEach(function (email) {
            if (!email) {
              return;
            }

            var address =
              typeof email === "string"
                ? email
                : (
                    email.email ||
                    email.value ||
                    ""
                  );

            address =
              safeText(address).trim();

            if (!address) {
              return;
            }

            contacts.push({
              category: category,
              purpose: purpose,
              hours: hours,
              type: "email",
              value: address,
              label: "Email",
              source:
                (
                  typeof email === "object" &&
                  (
                    email.source ||
                    email.sourceUrl
                  )
                ) ||
                groupSource ||
                ""
            });
          });
        }

        /*
         * ALSO SUPPORT SIMPLE DIRECT PHONE / EMAIL FIELDS.
         */
        if (group.phone) {
          contacts.push({
            category: category,
            purpose: purpose,
            hours: hours,
            type: "phone",
            value: safeText(
              group.phone
            ).trim(),
            label: "Phone",
            source: groupSource
          });
        }

        if (group.email) {
          contacts.push({
            category: category,
            purpose: purpose,
            hours: hours,
            type: "email",
            value: safeText(
              group.email
            ).trim(),
            label: "Email",
            source: groupSource
          });
        }

        /*
         * GENERIC SINGLE VALUE.
         */
        if (
          group.value &&
          !group.phones &&
          !group.emails &&
          !group.phone &&
          !group.email
        ) {
          contacts.push({
            category: category,
            purpose: purpose,
            hours: hours,
            type:
              group.type ||
              "other",
            value: safeText(
              group.value
            ).trim(),
            label:
              group.label ||
              "Official Contact",
            source: groupSource
          });
        }
      });
    }

    /* ---------------------------------------------------------------------
       REPORTING CONTACTS ALTERNATIVE FORMAT
       --------------------------------------------------------------------- */

    if (
      Array.isArray(
        data.reportingContacts
      )
    ) {
      data.reportingContacts.forEach(
        function (contact) {
          if (!contact) {
            return;
          }

          /*
           * If this object contains phones/emails, flatten them.
           */
          if (
            Array.isArray(
              contact.phones
            ) ||
            Array.isArray(
              contact.emails
            )
          ) {
            var category =
              safeText(
                contact.category ||
                contact.department ||
                contact.name ||
                "Official Contact"
              ).trim();

            var purpose =
              safeText(
                contact.purpose ||
                ""
              ).trim();

            var hours =
              safeText(
                contact.hours ||
                ""
              ).trim();

            if (
              Array.isArray(
                contact.phones
              )
            ) {
              contact.phones.forEach(
                function (phone) {
                  var number =
                    typeof phone === "string"
                      ? phone
                      : (
                          phone &&
                          (
                            phone.number ||
                            phone.value ||
                            phone.phone
                          )
                        );

                  number =
                    safeText(
                      number
                    ).trim();

                  if (!number) {
                    return;
                  }

                  contacts.push({
                    category:
                      category,
                    purpose:
                      purpose,
                    hours:
                      hours,
                    type:
                      "phone",
                    value:
                      number,
                    label:
                      "Phone",
                    source:
                      contact.source ||
                      contact.sourceUrl ||
                      ""
                  });
                }
              );
            }

            if (
              Array.isArray(
                contact.emails
              )
            ) {
              contact.emails.forEach(
                function (email) {
                  var address =
                    typeof email === "string"
                      ? email
                      : (
                          email &&
                          (
                            email.email ||
                            email.value
                          )
                        );

                  address =
                    safeText(
                      address
                    ).trim();

                  if (!address) {
                    return;
                  }

                  contacts.push({
                    category:
                      category,
                    purpose:
                      purpose,
                    hours:
                      hours,
                    type:
                      "email",
                    value:
                      address,
                    label:
                      "Email",
                    source:
                      contact.source ||
                      contact.sourceUrl ||
                      ""
                  });
                }
              );
            }

            return;
          }

          /*
           * Simple:
           *
           * {
           *   category: "...",
           *   type: "phone",
           *   value: "..."
           * }
           */

          var value =
            safeText(
              contact.value ||
              contact.phone ||
              contact.email ||
              ""
            ).trim();

          if (!value) {
            return;
          }

          contacts.push({
            category:
              safeText(
                contact.category ||
                contact.department ||
                contact.group ||
                contact.name ||
                "Official Contact"
              ).trim(),

            purpose:
              safeText(
                contact.purpose ||
                ""
              ).trim(),

            hours:
              safeText(
                contact.hours ||
                ""
              ).trim(),

            type:
              contact.type ||
              contact.kind ||
              "",

            value:
              value,

            label:
              contact.label ||
              contact.name ||
              contact.title ||
              (
                contact.type === "email"
                  ? "Email"
                  : "Phone"
              ),

            source:
              contact.source ||
              contact.sourceUrl ||
              ""
          });
        }
      );
    }

    /* ---------------------------------------------------------------------
       CATEGORY-BASED ALTERNATIVE FORMAT
       --------------------------------------------------------------------- */

    if (
      Array.isArray(
        data.categories
      )
    ) {
      data.categories.forEach(
        function (category) {
          if (!category) {
            return;
          }

          var categoryName =
            safeText(
              category.category ||
              category.name ||
              category.title ||
              "Official Contact"
            ).trim();

          var purpose =
            safeText(
              category.purpose ||
              ""
            ).trim();

          var hours =
            safeText(
              category.hours ||
              ""
            ).trim();

          var source =
            safeText(
              category.source ||
              category.sourceUrl ||
              ""
            ).trim();

          /*
           * categories[].contacts
           */
          if (
            Array.isArray(
              category.contacts
            )
          ) {
            category.contacts.forEach(
              function (contact) {
                if (!contact) {
                  return;
                }

                var value =
                  safeText(
                    contact.value ||
                    contact.phone ||
                    contact.email ||
                    contact.number ||
                    ""
                  ).trim();

                if (!value) {
                  return;
                }

                contacts.push({
                  category:
                    categoryName,
                  purpose:
                    purpose ||
                    safeText(
                      contact.purpose ||
                      ""
                    ).trim(),
                  hours:
                    hours,
                  type:
                    contact.type ||
                    "",
                  value:
                    value,
                  label:
                    contact.label ||
                    contact.name ||
                    (
                      contact.type === "email"
                        ? "Email"
                        : "Phone"
                    ),
                  source:
                    contact.source ||
                    contact.sourceUrl ||
                    source
                });
              }
            );
          }

          /*
           * categories[].phones
           */
          if (
            Array.isArray(
              category.phones
            )
          ) {
            category.phones.forEach(
              function (phone) {
                var number =
                  typeof phone === "string"
                    ? phone
                    : (
                        phone &&
                        (
                          phone.number ||
                          phone.value ||
                          phone.phone
                        )
                      );

                number =
                  safeText(
                    number
                  ).trim();

                if (!number) {
                  return;
                }

                contacts.push({
                  category:
                    categoryName,
                  purpose:
                    purpose,
                  hours:
                    hours,
                  type:
                    "phone",
                  value:
                    number,
                  label:
                    "Phone",
                  source:
                    source
                });
              }
            );
          }

          /*
           * categories[].emails
           */
          if (
            Array.isArray(
              category.emails
            )
          ) {
            category.emails.forEach(
              function (email) {
                var address =
                  typeof email === "string"
                    ? email
                    : (
                        email &&
                        (
                          email.email ||
                          email.value
                        )
                      );

                address =
                  safeText(
                    address
                  ).trim();

                if (!address) {
                  return;
                }

                contacts.push({
                  category:
                    categoryName,
                  purpose:
                    purpose,
                  hours:
                    hours,
                  type:
                    "email",
                  value:
                    address,
                  label:
                    "Email",
                  source:
                    source
                });
              }
            );
          }
        }
      );
    }

    /* ---------------------------------------------------------------------
       WEBSITE / SOURCE INFORMATION
       --------------------------------------------------------------------- */

    var website =
      data.website ||
      data.officialWebsite ||
      data.officialUrl ||
      "";

    var source =
      data.source ||
      data.sourceUrl ||
      "";

    return {
      contacts:
        contacts,

      website:
        website,

      source:
        source,

      sourceStatus:
        data.sourceStatus ||
        "",

      notes:
        data.notes ||
        "",

      description:
        data.description ||
        "",

      reportingChannels:
        Array.isArray(
          data.reportingChannels
        )
          ? data.reportingChannels
          : []
    };
  }

  function loadReportingData(
    institutionId
  ) {
    if (!institutionId) {
      return Promise.resolve(null);
    }

    if (
      reportingCache[
        institutionId
      ]
    ) {
      return Promise.resolve(
        reportingCache[
          institutionId
        ]
      );
    }

    if (
      reportingInFlight[
        institutionId
      ]
    ) {
      return reportingInFlight[
        institutionId
      ];
    }

    var url =
      "/data/reporting/" +
      encodeURIComponent(
        institutionId
      ) +
      ".json";

    var req =
      fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      })
        .then(function (res) {
          if (!res.ok) {
            throw new Error(
              "reporting_http_" +
              res.status
            );
          }

          return res.json();
        })
        .then(function (data) {
          var normalised =
            normaliseReportingData(
              data
            );

          reportingCache[
            institutionId
          ] = normalised;

          delete reportingInFlight[
            institutionId
          ];

          return normalised;
        })
        .catch(function () {
          delete reportingInFlight[
            institutionId
          ];

          var empty = {
            contacts: [],
            website: "",
            source: "",
            sourceStatus: "unavailable",
            notes: "",
            description: "",
            reportingChannels: []
          };

          reportingCache[
            institutionId
          ] = empty;

          return empty;
        });

    reportingInFlight[
      institutionId
    ] = req;

    return req;
  }

  /* =======================================================================
     REPORTING CONTACT HELPERS
     ======================================================================= */

  function getContactValue(
    contact
  ) {
    if (!contact) {
      return "";
    }

    return safeText(
      contact.value ||
      contact.phone ||
      contact.email ||
      contact.address ||
      contact.number ||
      ""
    ).trim();
  }

  function getContactType(
    contact
  ) {
    if (!contact) {
      return "";
    }

    var explicit =
      safeText(
        contact.type ||
        contact.kind ||
        ""
      ).toLowerCase();

    if (
      explicit === "phone" ||
      explicit === "telephone" ||
      explicit === "mobile"
    ) {
      return "phone";
    }

    if (
      explicit === "email" ||
      explicit === "e-mail"
    ) {
      return "email";
    }

    var value =
      getContactValue(
        contact
      );

    if (
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(
        value
      )
    ) {
      return "email";
    }

    if (
      /(?:\+?260|0)\s*[\d\s()-]{7,}/.test(
        value
      )
    ) {
      return "phone";
    }

    return explicit || "other";
  }

  function getContactLabel(
    contact
  ) {
    if (!contact) {
      return "Official contact";
    }

    return safeText(
      contact.label ||
      contact.name ||
      contact.title ||
      contact.department ||
      "Official contact"
    );
  }

  function getContactCategory(
    contact
  ) {
    if (!contact) {
      return "Official Contact";
    }

    return safeText(
      contact.category ||
      contact.department ||
      contact.group ||
      contact.label ||
      "Official Contact"
    ).trim() || "Official Contact";
  }

  function normalisePhoneForWhatsApp(
    value
  ) {
    var digits =
      safeText(value)
        .replace(/\D/g, "");

    if (!digits) {
      return "";
    }

    /*
     * Convert Zambian local numbers such as 0972... to 260972...
     */
    if (
      digits.length === 10 &&
      digits.charAt(0) === "0"
    ) {
      return "260" +
        digits.slice(1);
    }

    /*
     * Already international Zambian number.
     */
    if (
      digits.indexOf("260") === 0
    ) {
      return digits;
    }

    /*
     * Do not guess the country for arbitrary future institutions.
     */
    if (
      safeText(value).trim().charAt(0) === "+"
    ) {
      return digits;
    }

    return "";
  }

  function buildContactActions(
    contact
  ) {
    var value =
      getContactValue(
        contact
      );

    var type =
      getContactType(
        contact
      );

    if (!value) {
      return "";
    }

    var actions = "";

    if (type === "phone") {
      var telValue =
        value.replace(
          /[^+\d]/g,
          ""
        );

      if (telValue) {
        actions +=
          "<a class=\"btn btn-ghost btn-small\" href=\"tel:" +
          escapeHtml(
            telValue
          ) +
          "\">Call</a>";
      }

      var whatsappNumber =
        normalisePhoneForWhatsApp(
          value
        );

      if (whatsappNumber) {
        actions +=
          "<a class=\"btn btn-ghost btn-small\" href=\"https://wa.me/" +
          escapeHtml(
            whatsappNumber
          ) +
          "\" target=\"_blank\" rel=\"noopener\">WhatsApp</a>";
      }
    }

    if (type === "email") {
      actions +=
        "<a class=\"btn btn-ghost btn-small\" href=\"mailto:" +
        escapeHtml(
          value
        ) +
        "\">Email</a>";
    }

    return actions;
  }

  /* =======================================================================
     REPORT TEXT
     ======================================================================= */

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
          inst
            ? (
                getOfficialSiteUrl(
                  inst
                ) ||
                "Not provided"
              )
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

  /* =======================================================================
     GENERATE REPORT
     ======================================================================= */

  function generateReport(
    event
  ) {
    event.preventDefault();

    /*
     * A report must always belong to a known institution.
     */
    if (!currentInstitutionId) {
      if (reportEmptyWarning) {
        reportEmptyWarning.textContent =
          "Please enter the institution website first.";

        reportEmptyWarning.hidden =
          false;
      }

      showPage("verify");

      return;
    }

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
        reportEmptyWarning.textContent =
          "Please describe what you want to report or provide the suspicious phone, email, or bank detail.";

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

    /*
     * Clearing the report does NOT clear the identified institution.
     */
  }

  /* =======================================================================
     REPORTING CHANNELS
     ======================================================================= */

  function renderReportChannels() {
    var container =
      $("report-channels");

    if (!container) {
      return;
    }

    var inst =
      getCurrentInstitution();

    if (!inst) {
      container.innerHTML =
        "<p class=\"empty-state\">Please enter the institution website first.</p>";

      return;
    }

    var links =
      (
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
                l.name ||
                l.url
              ) +
              "</a>"
            );
          }
        )
        .join("") ||

      "<p class=\"empty-state\">No external reporting channel has been configured for this institution yet.</p>";
  }

  /* =======================================================================
     INSTITUTION-SPECIFIC REPORTING CONTACTS
     ======================================================================= */

  function renderReportInstitutionContacts() {
    var container =
      $("report-institution-contacts");

    if (!container) {
      return;
    }

    if (!currentInstitutionId) {
      container.innerHTML =
        "<p class=\"empty-state\">Please enter the institution website first.</p>";

      return;
    }

    container.innerHTML =
      "<p class=\"empty-state\">Loading official reporting contacts…</p>";

    var requestedInstitutionId =
      currentInstitutionId;

    loadReportingData(
      requestedInstitutionId
    ).then(
      function (reporting) {
        /*
         * Prevent an old request from rendering contacts for the wrong
         * institution if the user changes institution while loading.
         */
        if (
          currentInstitutionId !==
          requestedInstitutionId
        ) {
          return;
        }

        reporting =
          reporting || {
            contacts: []
          };

        var contacts =
          Array.isArray(
            reporting.contacts
          )
            ? reporting.contacts
            : [];

        if (!contacts.length) {
          container.innerHTML =
            "<p class=\"empty-state\">No institution-specific reporting contacts are configured yet.</p>";

          return;
        }

        /*
         * Group contacts by category.
         *
         * For your UNILUS JSON this creates:
         *
         * Accounts Department
         * Admissions
         * Undergraduate Admissions
         * Postgraduate Admissions
         * Customer Service / General Enquiries
         * Leopards Hill Campus
         * Silverest Campus
         * Alternative Admissions Contacts
         */
        var groups = {};

        contacts.forEach(
          function (contact) {
            if (!contact) {
              return;
            }

            var value =
              getContactValue(
                contact
              );

            if (!value) {
              return;
            }

            var category =
              getContactCategory(
                contact
              );

            if (!groups[category]) {
              groups[category] = [];
            }

            groups[category].push(
              contact
            );
          }
        );

        var categoryNames =
          Object.keys(
            groups
          );

        if (!categoryNames.length) {
          container.innerHTML =
            "<p class=\"empty-state\">No usable official reporting contacts are configured yet.</p>";

          return;
        }

        var html = "";

        /*
         * Small heading explaining what these are.
         */
        html +=
          "<p class=\"notice notice-soft\">" +
          "Use the contact category that matches your issue. These details come from CampusVerify's institution-specific reporting configuration." +
          "</p>";

        categoryNames.forEach(
          function (category) {
            html +=
              "<div class=\"report-contact-group\">" +

              "<h3>" +
              escapeHtml(
                category
              ) +
              "</h3>";

            groups[category].forEach(
              function (contact) {
                var value =
                  getContactValue(
                    contact
                  );

                var label =
                  getContactLabel(
                    contact
                  );

                var type =
                  getContactType(
                    contact
                  );

                var purpose =
                  safeText(
                    contact.purpose ||
                    ""
                  ).trim();

                var hours =
                  safeText(
                    contact.hours ||
                    ""
                
