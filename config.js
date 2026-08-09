const path = require("path");

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const updateIntervalMs = readNonNegativeInteger(
  process.env.DATA_UPDATE_INTERVAL_MS,
  6 * 60 * 60 * 1000
);
const port = readPositiveInteger(process.env.PORT, 13000);

module.exports = {
  port,
  webhookPath: process.env.WEBHOOK_PATH || "/webhook",
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  dataPath: process.env.DATA_JS_PATH || path.join(__dirname, "data.js"),
  githubFileUrl:
    process.env.GITHUB_DATA_URL ||
    "https://raw.githubusercontent.com/DND5eChm/5echmweb_search/refs/heads/index/data.js",
  githubApiUrl: process.env.GITHUB_CONTENT_API_URL || "",
  downloadUrl:
    process.env.DATA_DOWNLOAD_URL ||
    "https://sealchat-update.aivu.top/https://raw.githubusercontent.com/DND5eChm/5echmweb_search/refs/heads/index/data.js.zip",
  updateIntervalMs,
};
