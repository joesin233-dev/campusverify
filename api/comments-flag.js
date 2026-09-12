/* =========================================================================
   CampusVerify — api/comments-flag.js
   -----------------------------------------------------------------------
   Flags a comment. A comment is auto-hidden once it collects
   HIDE_AFTER_FLAGS flags (see comments-store.js for the current
   threshold and its limitations — this is community moderation, not an
   admin review system).

   POST /api/comments-flag
   body: { institution, type, value, commentId }
   ========================================================================= */

const {
  getInstitutionById
} = require("../institutions.js");

const {
  ALLOWED_TYPES,
  HIDE_AFTER_FLAGS,
  buildCommentsKey,
  loadComments,
  saveComments,
  isVisible,
  publicShape,
  sortNewestFirst
} = require("./comments-store.js");

module.exports = async function handler(
  req,
  res
) {
  if (
    req.method &&
    req.method !== "POST"
  ) {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  var body =
    req.body || {};

  var institutionId =
    body.institution;

  var type =
    body.type;

  var value =
    body.value;

  var commentId =
    body.commentId;

  if (
    !institutionId ||
    !type ||
    !value ||
    !commentId
  ) {
    return res.status(400).json({
      error:
        "Missing institution, type, value, or commentId"
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

    var target =
      comments.find(
        function (c) {
          return (
            c.id === commentId
          );
        }
      );

    if (!target) {
      return res.status(404).json({
        error:
          "Comment not found"
      });
    }

    target.flags =
      (target.flags || 0) + 1;

    if (
      target.flags >=
      HIDE_AFTER_FLAGS
    ) {
      target.hidden = true;
    }

    var saved =
      await saveComments(
        key,
        comments
      );

    var visible =
      sortNewestFirst(
        saved.filter(isVisible)
      ).map(publicShape);

    return res.status(200).json({
      comments: visible
    });

  } catch (err) {
    console.error(
      "CampusVerify comments-flag failed:",
      err
    );

    return res.status(500).json({
      error:
        "Could not flag this comment right now."
    });
  }
};
