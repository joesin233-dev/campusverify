// api/crawler.js — minimal test version

module.exports = async function handler(req, res) {
  var institutionId = req.query.institution;

  if (!institutionId) {
    return res.status(400).json({
      error: "Missing institution id"
    });
  }

  // Temporary dummy response — just to confirm the function runs
  return res.status(200).json({
    ok: true,
    institutionId: institutionId,
    message: "Crawler function is running. Real crawl not implemented in this test version."
  });
};
