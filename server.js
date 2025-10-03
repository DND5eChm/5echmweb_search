const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const vm = require("vm");

const MIN_TOKEN_LENGTH = 2;
const CACHE_MAX_ENTRIES = 120;
const CACHE_TTL = 5 * 60 * 1000;
const PREVIEW_MAX_LENGTH = 600;
const MAX_PAGE_SIZE = 100;

let searchData = [];
let tokenIndex = new Map();
const queryCache = new Map();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 13000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 加载并解析 data.js
function loadSearchData() {
  try {
    resetInMemoryStructures();

    const dataPath = path.join(__dirname, "data.js");
    const content = fs.readFileSync(dataPath, "utf-8");

    const sandbox = {};
    vm.createContext(sandbox);
    const script = new vm.Script(`${content}; contents;`, {
      filename: "data.js",
    });
    const rawContents = script.runInContext(sandbox, { timeout: 5000 });

    if (Array.isArray(rawContents)) {
      for (let i = 0; i < rawContents.length; i += 3) {
        if (i + 2 < rawContents.length) {
          const rawContent = rawContents[i] || "";
          const rawTitle = rawContents[i + 1] || "";
          const rawPath = rawContents[i + 2] || "";

          const normalizedContent = normalizeLineEndings(String(rawContent));
          const normalizedTitle = normalizeLineEndings(String(rawTitle)).trim();
          const sanitizedPath = String(rawPath).replace(/\\\\/g, "/");

          const record = {
            content: normalizedContent,
            title: normalizedTitle,
            path: sanitizedPath,
            titleLower: normalizedTitle.toLowerCase(),
            contentLower: normalizedContent.toLowerCase(),
          };

          const docIndex = searchData.length;
          searchData.push(record);
          indexDocumentTokens(docIndex, record.titleLower, record.contentLower);
        }
      }
    }
    console.log(`已加载 ${searchData.length} 条数据`);
  } catch (error) {
    console.error("加载数据失败:", error);
  }
}

function resetInMemoryStructures() {
  searchData = [];
  tokenIndex = new Map();
  queryCache.clear();
}

function indexDocumentTokens(docIndex, titleLower, contentLower) {
  const tokens = extractTokens(`${titleLower} ${contentLower}`);
  tokens.forEach((token) => {
    let bucket = tokenIndex.get(token);
    if (!bucket) {
      bucket = new Set();
      tokenIndex.set(token, bucket);
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

function buildCacheKey(keywordsLower, isTitleOnly, baseIndexesSet) {
  const basePart = baseIndexesSet
    ? Array.from(baseIndexesSet).sort((a, b) => a - b).join(",")
    : "";
  return `${isTitleOnly ? 1 : 0}|${keywordsLower.join(" ")}|${basePart}`;
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

function collectCandidateIndexes(keywordsLower, baseIndexesSet) {
  let candidateSet = null;
  let usedIndexedKeyword = false;

  for (const keyword of keywordsLower) {
    if (keyword.length < MIN_TOKEN_LENGTH) {
      continue;
    }
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

  const keywords = keyword
    .trim()
    .split(/\s+/)
    .filter((k) => k.length > 0);
  if (keywords.length === 0) {
    return res.json({
      results: [],
      total: 0,
      page: pageNum,
      totalPages: 0,
      pageSize: size,
    });
  }

  const keywordsLower = keywords.map((kw) => kw.toLowerCase());
  const isTitleOnly = titleOnly === "true";

  const cacheKey = buildCacheKey(keywordsLower, isTitleOnly, baseIndexesSet);
  const cachedResults = getCachedResults(cacheKey);
  if (cachedResults) {
    return res.json(paginateResults(cachedResults, pageNum, size));
  }

  const candidateSet = collectCandidateIndexes(keywordsLower, baseIndexesSet);
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

  const results = [];

  for (let i = 0; i < searchSpace.length; i += 1) {
    const index = searchSpace[i];
    const item = searchData[index];
    if (!item) {
      continue;
    }

    let titleRank = 1;
    let contentRank = 1;
    let titleHits = 0;
    let contentHits = 0;
    let matched = false;

    for (let k = 0; k < keywordsLower.length; k += 1) {
      const kwLower = keywordsLower[k];
      const titleOccurrences = countOccurrences(item.titleLower, kwLower);
      if (titleOccurrences > 0) {
        matched = true;
        titleHits += titleOccurrences;
        titleRank *= titleOccurrences + 1;
      }

      if (!isTitleOnly) {
        const contentOccurrences = countOccurrences(
          item.contentLower,
          kwLower
        );
        if (contentOccurrences > 0) {
          matched = true;
          contentHits += contentOccurrences;
          contentRank *= contentOccurrences + 1;
        }
      }
    }

    if (!matched) {
      continue;
    }

    const totalRank =
      Math.round(Math.pow(titleRank, 1 / keywordsLower.length) * 20) +
      (isTitleOnly
        ? 0
        : Math.round(Math.pow(contentRank, 1 / keywordsLower.length)));

    const sourcePath = extractSourcePath(item.path);
    const displayTitle = buildDisplayTitle(item.title, sourcePath);
    const preview = buildPreview(item.content, keywords);

    results.push({
      index,
      title: displayTitle,
      rawTitle: item.title,
      path: item.path,
      sourcePath,
      rank: totalRank,
      preview,
      content: item.content,
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

// 获取内容详情
app.get("/api/content/:index", (req, res) => {
  const index = parseInt(req.params.index);

  if (index >= 0 && index < searchData.length) {
    const { content, title, path: docPath } = searchData[index];
    return res.json({ content, title, path: docPath });
  }
  res.status(404).json({ error: "内容未找到" });
});

// 启动服务器前加载数据
loadSearchData();

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
