const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const vm = require("vm");
const crypto = require("crypto");
const config = require("./config");
const { createDataUpdater } = require("./data-updater");

const MIN_TOKEN_LENGTH = 2;
const ASCII_TOKEN_REGEX = /^[a-z0-9]+$/;
const CACHE_MAX_ENTRIES = 120;
const CACHE_TTL = 5 * 60 * 1000;
const PREVIEW_MAX_LENGTH = 600;
const MAX_PAGE_SIZE = 100;
const DEFAULT_CATEGORY = "未分类";
const DATA_JS_PATH = config.dataPath || path.join(__dirname, "data.js");

let searchData = [];
let tokenIndex = new Map();
const queryCache = new Map();
let categories = new Set();

const app = express();
const PORT = config.port;

// 中间件
app.use(cors());
app.use(
  express.json({
    limit: "10mb",
    verify: (request, response, body) => {
      request.rawBody = Buffer.from(body);
    },
  })
);
app.use((request, response, next) => {
  if (request.path === "/config.js" || request.path === "/data-updater.js") {
    return response.sendStatus(404);
  }
  return next();
});
app.use(express.static(__dirname));

// 加载并解析 data.js
function loadSearchData() {
  try {
    const content = fs.readFileSync(DATA_JS_PATH, "utf-8");

    const sandbox = {};
    vm.createContext(sandbox);
    const script = new vm.Script(`${content}; contents;`, {
      filename: "data.js",
    });
    const rawContents = script.runInContext(sandbox, { timeout: 5000 });

    const nextSearchData = [];
    const nextTokenIndex = new Map();
    const nextCategories = new Set([DEFAULT_CATEGORY]);

    if (Array.isArray(rawContents)) {
      for (let i = 0; i < rawContents.length; i += 3) {
        if (i + 2 < rawContents.length) {
          const rawContent = rawContents[i] || "";
          const rawTitle = rawContents[i + 1] || "";
          const rawPath = rawContents[i + 2] || "";

          const normalizedContent = normalizeLineEndings(String(rawContent));
          const normalizedTitle = normalizeLineEndings(String(rawTitle)).trim();
          const sanitizedPath = String(rawPath).replace(/\\+/g, "/");
          const category = extractCategory(sanitizedPath);

          const record = {
            content: normalizedContent,
            title: normalizedTitle,
            path: sanitizedPath,
            titleLower: normalizedTitle.toLowerCase(),
            contentLower: normalizedContent.toLowerCase(),
            category,
          };

          const docIndex = nextSearchData.length;
          nextSearchData.push(record);
          indexDocumentTokens(
            docIndex,
            record.titleLower,
            record.contentLower,
            nextTokenIndex
          );
          nextCategories.add(category);
        }
      }
    }
    searchData = nextSearchData;
    tokenIndex = nextTokenIndex;
    categories = nextCategories;
    queryCache.clear();
    console.log(`已加载 ${searchData.length} 条数据`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("本地 data.js 不存在，启动时自动下载");
    } else {
      console.error("加载数据失败:", error);
    }
    return false;
  }
}

function indexDocumentTokens(docIndex, titleLower, contentLower, targetIndex = tokenIndex) {
  const tokens = extractTokens(`${titleLower} ${contentLower}`);
  tokens.forEach((token) => {
    let bucket = targetIndex.get(token);
    if (!bucket) {
      bucket = new Set();
      targetIndex.set(token, bucket);
    }
    bucket.add(docIndex);
  });
}

function extractTokens(text) {
  if (!text) {
    return [];
  }
  const pieces = text
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= MIN_TOKEN_LENGTH);
  return [...new Set(pieces)];
}

function normalizeLineEndings(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\r/g, "\n")
    .replace(/\r/g, "\n");
}

function countOccurrences(source, keyword) {
  if (!source || !keyword) {
    return 0;
  }
  let count = 0;
  let startIndex = 0;
  while (true) {
    const idx = source.indexOf(keyword, startIndex);
    if (idx === -1) {
      break;
    }
    count += 1;
    startIndex = idx + keyword.length;
  }
  return count;
}

function buildPreview(text, keywords, maxLength = PREVIEW_MAX_LENGTH) {
  if (!text) return "";
  const normalized = normalizeLineEndings(text);
  const lower = normalized.toLowerCase();

  let bestIndex = -1;
  let bestKeywordLength = 0;

  keywords.forEach((kw) => {
    if (!kw) return;
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestKeywordLength = kw.length;
    }
  });

  if (bestIndex === -1) {
    const truncated = normalized.slice(0, maxLength);
    return normalized.length > maxLength ? truncated + "…" : truncated;
  }

  const halfWindow = Math.max((maxLength - bestKeywordLength) / 2, 0);
  const start = Math.max(0, Math.floor(bestIndex - halfWindow));
  const end = Math.min(normalized.length, Math.ceil(start + maxLength));

  let snippet = normalized.slice(start, end);
  if (start > 0) {
    snippet = "…" + snippet;
  }
  if (end < normalized.length) {
    snippet = snippet + "…";
  }
  return snippet;
}

function extractSourcePath(rawPath) {
  if (!rawPath) {
    return "";
  }
  return rawPath.replace(/\\+/g, "/").replace(/^topics\//i, "");
}

function extractCategory(sanitizedPath) {
  if (!sanitizedPath) {
    return DEFAULT_CATEGORY;
  }
  const normalized = sanitizedPath.replace(/^topics\//i, "").trim();
  if (!normalized) {
    return DEFAULT_CATEGORY;
  }
  const parts = normalized.split("/");
  const category = parts[0] ? parts[0].trim() : "";
  return category || DEFAULT_CATEGORY;
}

function buildDisplayTitle(rawTitle, sourcePath) {
  if (rawTitle) {
    const normalized = normalizeLineEndings(rawTitle).trim();
    if (normalized) {
      const firstLine = normalized.split("\n")[0].trim();
      if (firstLine) {
        return firstLine;
      }
    }
  }
  if (sourcePath) {
    const last = sourcePath.split("/").pop() || "";
    return last.replace(/\.(html?|htm)$/i, "") || "未命名页面";
  }
  return "未命名页面";
}

function parseSearchKeywords(rawKeyword) {
  if (!rawKeyword) {
    return [];
  }
  const groups = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(rawKeyword)) !== null) {
    const token = (match[1] || match[2] || "").trim();
    if (!token) {
      continue;
    }
    const orParts = token
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (orParts.length > 0) {
      groups.push(orParts);
    }
  }
  return groups;
}

function buildCacheKey(keywordSignatureParts, isTitleOnly, baseIndexesSet, category) {
  const basePart = baseIndexesSet
    ? Array.from(baseIndexesSet).sort((a, b) => a - b).join(",")
    : "";
  return `${isTitleOnly ? 1 : 0}|${keywordSignatureParts.join(" ")}|${basePart}|${
    category || ""
  }`;
}

function getCachedResults(cacheKey) {
  const entry = queryCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    queryCache.delete(cacheKey);
    return null;
  }
  queryCache.delete(cacheKey);
  queryCache.set(cacheKey, entry);
  return entry.results;
}

function setCachedResults(cacheKey, results) {
  queryCache.set(cacheKey, { results, timestamp: Date.now() });
  if (queryCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = queryCache.keys().next().value;
    if (oldestKey) {
      queryCache.delete(oldestKey);
    }
  }
}

function collectCandidateIndexes(keywordGroupsLower, baseIndexesSet) {
  let candidateSet = null;
  let usedIndexedKeyword = false;

  for (const group of keywordGroupsLower) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }
    const asciiCandidates = group.filter(
      (keyword) =>
        keyword.length >= MIN_TOKEN_LENGTH && ASCII_TOKEN_REGEX.test(keyword)
    );
    if (asciiCandidates.length !== 1) {
      continue;
    }

    const keyword = asciiCandidates[0];
    const bucket = tokenIndex.get(keyword);
    if (!bucket || bucket.size === 0) {
      continue;
    }
    usedIndexedKeyword = true;

    let filteredBucket;
    if (baseIndexesSet) {
      filteredBucket = new Set();
      bucket.forEach((idx) => {
        if (baseIndexesSet.has(idx)) {
          filteredBucket.add(idx);
        }
      });
    } else {
      filteredBucket = new Set(bucket);
    }

    if (!candidateSet) {
      candidateSet = filteredBucket;
    } else {
      const intersection = new Set();
      filteredBucket.forEach((idx) => {
        if (candidateSet.has(idx)) {
          intersection.add(idx);
        }
      });
      candidateSet = intersection;
    }

    if (candidateSet.size === 0) {
      break;
    }
  }

  if (!usedIndexedKeyword) {
    return baseIndexesSet ? new Set(baseIndexesSet) : null;
  }

  return candidateSet || new Set();
}

function paginateResults(sortedResults, pageNum, pageSize) {
  const total = sortedResults.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (pageNum - 1) * pageSize;
  const paginatedResults = sortedResults.slice(start, start + pageSize);
  return {
    results: paginatedResults,
    total,
    page: pageNum,
    totalPages,
    pageSize,
  };
}

// 搜索 API
app.get("/api/search", (req, res) => {
  const {
    keyword,
    titleOnly = "false",
    page = 1,
    pageSize = 20,
    baseIndexes = "",
    category = "",
  } = req.query;

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), MAX_PAGE_SIZE);

  if (!keyword) {
    return res.json({
      results: [],
      total: 0,
      page: pageNum,
      totalPages: 0,
      pageSize: size,
    });
  }

  let baseIndexesSet = null;
  if (typeof baseIndexes === "string" && baseIndexes.trim().length > 0) {
    baseIndexesSet = new Set(
      baseIndexes
        .split(",")
        .map((idx) => parseInt(idx, 10))
        .filter(
          (idx) => Number.isInteger(idx) && idx >= 0 && idx < searchData.length
        )
    );

    if (baseIndexesSet.size === 0) {
      return res.json({
        results: [],
        total: 0,
        page: pageNum,
        totalPages: 0,
        pageSize: size,
      });
    }
  }

  const keywordGroups = parseSearchKeywords(keyword);
  const previewKeywords = keywordGroups.flat();
  if (keywordGroups.length === 0) {
    return res.json({
      results: [],
      total: 0,
      page: pageNum,
      totalPages: 0,
      pageSize: size,
    });
  }

  const keywordGroupsLower = keywordGroups.map((group) =>
    group.map((token) => token.toLowerCase())
  );
  const cacheKeyParts = keywordGroupsLower.map((group) => group.join("|"));
  const isTitleOnly = titleOnly === "true";
  const rawCategory =
    typeof category === "string" ? category.trim() : "";
  const categoryFilter =
    rawCategory && rawCategory.toLowerCase() !== "all" ? rawCategory : "";

  const cacheKey = buildCacheKey(
    cacheKeyParts,
    isTitleOnly,
    baseIndexesSet,
    categoryFilter
  );
  const cachedResults = getCachedResults(cacheKey);
  if (cachedResults) {
    return res.json(paginateResults(cachedResults, pageNum, size));
  }

  const candidateSet = collectCandidateIndexes(
    keywordGroupsLower,
    baseIndexesSet
  );
  if (candidateSet && candidateSet.size === 0) {
    setCachedResults(cacheKey, []);
    return res.json(paginateResults([], pageNum, size));
  }

  let searchSpace;
  if (candidateSet) {
    searchSpace = Array.from(candidateSet);
  } else if (baseIndexesSet) {
    searchSpace = Array.from(baseIndexesSet);
  } else {
    searchSpace = searchData.map((_, idx) => idx);
  }

  if (categoryFilter) {
    searchSpace = searchSpace.filter((idx) => {
      const doc = searchData[idx];
      return doc && doc.category === categoryFilter;
    });
    if (searchSpace.length === 0) {
      setCachedResults(cacheKey, []);
      return res.json(paginateResults([], pageNum, size));
    }
  }

  const results = [];

  for (let i = 0; i < searchSpace.length; i += 1) {
    const index = searchSpace[i];
    const item = searchData[index];
    if (!item) {
      continue;
    }

    let titleRank = 1;
    let contentRank = 1;
    let matchedAllKeywords = true;

    for (let g = 0; g < keywordGroupsLower.length; g += 1) {
      const group = keywordGroupsLower[g];
      let bestTitleOccurrences = 0;
      let bestContentOccurrences = 0;

      for (let t = 0; t < group.length; t += 1) {
        const kwLower = group[t];
        if (!kwLower) {
          continue;
        }

        const titleOccurrences = countOccurrences(item.titleLower, kwLower);
        if (titleOccurrences > bestTitleOccurrences) {
          bestTitleOccurrences = titleOccurrences;
        }

        if (!isTitleOnly) {
          const contentOccurrences = countOccurrences(
            item.contentLower,
            kwLower
          );
          if (contentOccurrences > bestContentOccurrences) {
            bestContentOccurrences = contentOccurrences;
          }
        }
      }

      const keywordMatched = isTitleOnly
        ? bestTitleOccurrences > 0
        : bestTitleOccurrences > 0 || bestContentOccurrences > 0;

      if (!keywordMatched) {
        matchedAllKeywords = false;
        break;
      }

      if (bestTitleOccurrences > 0) {
        titleRank *= bestTitleOccurrences + 1;
      }
      if (!isTitleOnly && bestContentOccurrences > 0) {
        contentRank *= bestContentOccurrences + 1;
      }
    }

    if (!matchedAllKeywords) {
      continue;
    }

    const groupCount = keywordGroupsLower.length || 1;
    const totalRank =
      Math.round(Math.pow(titleRank, 1 / groupCount) * 20) +
      (isTitleOnly
        ? 0
        : Math.round(Math.pow(contentRank, 1 / groupCount)));

    const sourcePath = extractSourcePath(item.path);
    const displayTitle = buildDisplayTitle(item.title, sourcePath);
    const preview = buildPreview(item.content, previewKeywords);

    results.push({
      index,
      title: displayTitle,
      rawTitle: item.title,
      path: item.path,
      sourcePath,
      rank: totalRank,
      preview,
      content: item.content,
      category: item.category,
    });
  }

  results.sort((a, b) => {
    if (b.rank !== a.rank) {
      return b.rank - a.rank;
    }
    return a.index - b.index;
  });

  setCachedResults(cacheKey, results);

  res.json(paginateResults(results, pageNum, size));
});

// 获取过滤选项
app.get("/api/filters", (req, res) => {
  const sortedCategories = Array.from(categories);
  sortedCategories.sort((a, b) =>
    a.localeCompare(b, "zh-Hans", { sensitivity: "base" })
  );
  res.json({
    categories: sortedCategories,
    defaultCategory: DEFAULT_CATEGORY,
  });
});

// 获取内容详情
app.get("/api/content/:index", (req, res) => {
  const index = parseInt(req.params.index);

  if (index >= 0 && index < searchData.length) {
    const { content, title, path: docPath } = searchData[index];
    return res.json({ content, title, path: docPath });
  }
  res.status(404).json({ error: "内容未找到" });
});

function verifyGithubWebhookSignature(request) {
  if (!config.webhookSecret) {
    return true;
  }
  const signature = request.get("x-hub-signature-256") || "";
  const expected = `sha256=${crypto
    .createHmac("sha256", config.webhookSecret)
    .update(request.rawBody || Buffer.alloc(0))
    .digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

const dataUpdater = createDataUpdater({
  dataPath: DATA_JS_PATH,
  githubFileUrl: config.githubFileUrl,
  githubApiUrl: config.githubApiUrl,
  downloadUrl: config.downloadUrl,
  githubToken: config.githubToken,
  updateIntervalMs: config.updateIntervalMs,
  reload: loadSearchData,
});

// GitHub Webhook 标准入口。收到事件后立即执行 SHA 检查与更新。
app.post(config.webhookPath, async (req, res) => {
  if (!verifyGithubWebhookSignature(req)) {
    return res.status(401).json({ error: "Webhook 签名无效" });
  }

  const event = req.get("x-github-event") || "unknown";
  try {
    const result = await dataUpdater.checkForUpdate("webhook");
    return res.status(200).json({
      ok: true,
      event,
      delivery: req.get("x-github-delivery") || "",
      updated: Boolean(result && result.updated),
    });
  } catch (error) {
    console.error(`Webhook 更新 data.js 失败: ${error.message}`);
    return res.status(500).json({ ok: false, error: "data.js 更新失败" });
  }
});

function startServer() {
  app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
  });
}

// 本地索引缺失时，先完成首次下载尝试，再启动服务，避免空索引运行。
const initialLoadSucceeded = loadSearchData();
const initialUpdate = Promise.resolve().then(() => dataUpdater.start());
if (initialLoadSucceeded) {
  initialUpdate.catch((error) =>
    console.error(`启动时更新 data.js 失败: ${error.message}`)
  );
  startServer();
} else {
  initialUpdate
    .catch((error) =>
      console.error(`启动时更新 data.js 失败: ${error.message}`)
    )
    .finally(startServer);
}
