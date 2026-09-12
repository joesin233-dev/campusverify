/* =========================================================================
   CampusVerify — api/comments-get.js
   -----------------------------------------------------------------------
   Returns the visible (non-hidden) comments for one verification target.

   GET /api/comments-get?institution=unilus&type=phone&value=0971263550
   ========================================================================= */

const {
  getInstitutionById
} = require("../institutions.js");

const {
  ALLOWED_TYPES,
  buildCommentsKey,
  loadComments,
  isVisible,
  publicShape,
  sortNewestFirst
} = require("./comments-store.js");

module.exports = async function handler(
  req,
  res
) {
  var institutionId =
    req.query.institution;

  var type =
    req.query.type;

  var value =
    req.query.value;

  if (
    !institutionId ||
    !type ||
    !value
  ) {
    return res.status(400).json({
      error:
        "Missing institution, type, or value"
    });
  }

  var institution =
    getInstitutionById(
      institutionId
    );

  if (!institution) {
    return res.status(404).json({
      error:
        "This institution is not supported yet."
    });
  }

  if (
    ALLOWED_TYPES.indexOf(type) === -1
  ) {
    return res.status(400).json({
      error:
        "Unsupported comment type"
    });
  }

  try {
    var key =
      buildCommentsKey(
        institutionId,
        type,
        value
      );

    var comments =
      await loadComments(key);

    var visible =
      sortNewestFirst(
        comments.filter(isVisible)
      ).map(publicShape);

    return res.status(200).json({
      comments: visible
    });

  } catch (err) {
    console.error(
      "CampusVerify comments-get failed:",
      err
    );

    /*
     * Comments are a nice-to-have layered on top of verification, not a
     * core safety feature — fail soft with an empty list rather than a
     * hard error so the rest of the page keeps working.
     */
    return res.status(200).json({
      comments: [],
      error:
        "Comments are temporarily unavailable."
    });
  }
};
