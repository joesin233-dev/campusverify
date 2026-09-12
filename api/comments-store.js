/* =========================================================================
   CampusVerify — api/comments-store.js
   -----------------------------------------------------------------------
   Shared helpers for the comment threads attached to verification
   results. Comments are stored in Netlify Blobs — a key/value store
   built into Netlify itself, so no external database account, signup,
   or API key is needed (unlike MongoDB/Supabase/Firebase). Each
   verification target (institution + check type + normalised value)
   gets its own small JSON array of comments.

   This file is not itself a serverless function — it's required by
   api/comments-get.js, api/comments-post.js, and api/comments-flag.js.
   ========================================================================= */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "campusverify-comments";

const MAX_COMMENTS_PER_TARGET = 200;

const MAX_COMMENT_LENGTH = 500;

/*
 * A comment is auto-hidden once it collects this many flags. There is no
 * login system in CampusVerify yet, so this is a simple community
 * moderation signal, not a verified-abuse report — anyone can flag any
 * comment, and there is no per-device limit on how many times someone
 * can flag. If real moderation controls are needed later (an admin
 * login to review/restore hidden comments, per-device flag limits,
 * etc.), that is a separate, larger feature than this MVP covers.
 */
const HIDE_AFTER_FLAGS = 3;

const ALLOWED_TYPES = [
  "phone",
  "email",
  "bank",
  "link"
];

function getCommentsStore() {
  return getStore(STORE_NAME);
}

function normaliseValueForKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9@._+-]/g, "");
}

function buildCommentsKey(
  institutionId,
  type,
  value
) {
  return (
    String(institutionId || "")
      .trim()
      .toLowerCase() +
    "::" +
    String(type || "")
      .trim()
      .toLowerCase() +
    "::" +
    normaliseValueForKey(value)
  );
}

async function loadComments(key) {
  var store = getCommentsStore();

  try {
    var data = await store.get(key, {
      type: "json"
    });

    return Array.isArray(data)
      ? data
      : [];
  } catch (err) {
    console.error(
      "CampusVerify comments-store load failed:",
      key,
      err && err.message
    );

    return [];
  }
}

async function saveComments(
  key,
  comments
) {
  var store = getCommentsStore();

  var trimmed = comments.slice(
    -MAX_COMMENTS_PER_TARGET
  );

  await store.setJSON(
    key,
    trimmed
  );

  return trimmed;
}

function isVisible(comment) {
  return !comment.hidden;
}

function publicShape(comment) {
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt,
    flagCount: comment.flags || 0
  };
}

function sortNewestFirst(comments) {
  return comments
    .slice()
    .sort(function (a, b) {
      return (
        new Date(b.createdAt) -
        new Date(a.createdAt)
      );
    });
}

module.exports = {
  MAX_COMMENT_LENGTH,
  HIDE_AFTER_FLAGS,
  ALLOWED_TYPES,
  buildCommentsKey,
  loadComments,
  saveComments,
  isVisible,
  publicShape,
  sortNewestFirst
};
