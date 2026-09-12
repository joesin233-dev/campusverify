/* =========================================================================
   CampusVerify — api/comments-post.js
   -----------------------------------------------------------------------
   Adds a new comment to one verification target's shared thread.

   POST /api/comments-post
   body: { institution, type, value, text }
   ========================================================================= */

const {
  getInstitutionById
} = require("../institutions.js");

const {
  MAX_COMMENT_LENGTH,
  ALLOWED_TYPES,
  buildCommentsKey,
  loadComments,
  saveComments,
  isVisible,
  publicShape,
  sortNewestFirst
} = require("./comments-store.js");

function generateId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}

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

  var text =
    typeof body.text === "string"
      ? body.text.trim()
      : "";

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

  if (!text) {
    return res.status(400).json({
      error:
        "Comment text is required"
    });
  }

  if (text.length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({
      error:
        "Comment is too long (max " +
        MAX_COMMENT_LENGTH +
        " characters)"
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

    var comment = {
      id: generateId(),
      text: text,
      createdAt:
        new Date().toISOString(),
      flags: 0,
      hidden: false
    };

    comments.push(comment);

    var saved =
      await saveComments(
        key,
        comments
      );

    var visible =
      sortNewestFirst(
        saved.filter(isVisible)
      ).map(publicShape);

    return res.status(201).json({
      comments: visible
    });

  } catch (err) {
    console.error(
      "CampusVerify comments-post failed:",
      err
    );

    return res.status(500).json({
      error:
        "Could not save your comment right now. Please try again."
    });
  }
};
