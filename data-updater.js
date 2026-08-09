const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_USER_AGENT = "5echmweb-search-data-updater";

function gitBlobSha(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto
    .createHash("sha1")
    .update(Buffer.concat([header, buffer]))
    .digest("hex");
}

function githubContentApiUrl(fileUrl) {
  const source = decodeURIComponent(String(fileUrl));
  const embedded = source.match(
    /https?:\/\/(?:github\.com|raw\.githubusercontent\.com|api\.github\.com)\/[^\s?#]+/i
  );
  const parsed = new URL(embedded ? embedded[0] : fileUrl);
  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch (error) {
        return part;
      }
    });

  if (parsed.hostname === "api.github.com" && parts.includes("contents")) {
    return parsed.toString();
  }

  let owner;
  let repository;
  let ref;
  let filePath;
  if (parsed.hostname === "github.com") {
    const blobIndex = parts.indexOf("blob");
    if (blobIndex >= 2 && blobIndex + 2 < parts.length) {
      owner = parts[0];
      repository = parts[1];
      let refStart = blobIndex + 1;
      if (parts[refStart] === "refs" && refStart + 2 < parts.length) {
        refStart += 2;
      }
      ref = parts[refStart];
      filePath = parts.slice(refStart + 1).join("/");
    }
  } else if (parsed.hostname === "raw.githubusercontent.com") {
    if (parts.length >= 4) {
      owner = parts[0];
      repository = parts[1];
      let refStart = 2;
      if (parts[refStart] === "refs" && refStart + 2 < parts.length) {
        refStart += 2;
      }
      ref = parts[refStart];
      filePath = parts.slice(refStart + 1).join("/");
    }
  }

  if (!owner || !repository || !ref || !filePath) {
    throw new Error(
      "无法从 githubFileUrl 推导仓库文件。请配置 GITHUB_CONTENT_API_URL，或填写 GitHub blob/raw 地址"
    );
  }

  const apiUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repository
    )}/contents/${filePath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`
  );
  apiUrl.searchParams.set("ref", ref);
  return apiUrl.toString();
}

function requestBuffer(url, options = {}, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error("下载重定向次数过多"));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.request(
      parsed,
      {
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, parsed).toString();
          requestBuffer(nextUrl, options, redirectCount + 1).then(resolve, reject);
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let body = Buffer.concat(chunks);
          try {
            const encoding = String(response.headers["content-encoding"] || "")
              .toLowerCase()
              .split(",")[0]
              .trim();
            if (encoding === "gzip") body = zlib.gunzipSync(body);
            if (encoding === "deflate") body = zlib.inflateSync(body);
            if (encoding === "br") body = zlib.brotliDecompressSync(body);
          } catch (error) {
            reject(new Error(`响应解压失败: ${error.message}`));
            return;
          }
          if (status < 200 || status >= 300) {
            const detail = body.toString("utf8").slice(0, 300);
            reject(new Error(`请求失败（HTTP ${status}）${detail ? `: ${detail}` : ""}`));
            return;
          }
          resolve({ body, headers: response.headers, url: parsed.toString() });
        });
      }
    );
    request.setTimeout(options.timeoutMs || 30000, () => {
      request.destroy(new Error("请求超时"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function requestJson(url, options = {}) {
  const response = await requestBuffer(url, options);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    throw new Error(`GitHub API 返回无效 JSON: ${error.message}`);
  }
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) return -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

// 只提取 data.js，支持 ZIP 常见的 stored/deflate 两种压缩方式。
function extractDataJsFromZip(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error("ZIP 文件缺少目录结束标记");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  let selected = null;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) {
      throw new Error("ZIP 中央目录内容不完整");
    }
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP 中央目录格式无效");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString(flags & 0x800 ? "utf8" : "utf8");
    const normalizedName = name.replace(/\\/g, "/");
    if (!selected && /(^|\/)data\.js$/i.test(normalizedName)) {
      selected = {
        flags,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (!selected) {
    throw new Error("ZIP 文件中未找到 data.js");
  }
  if (selected.localHeaderOffset + 30 > buffer.length) {
    throw new Error("ZIP data.js 本地目录无效");
  }
  const localOffset = selected.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("ZIP data.js 本地目录格式无效");
  }
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + selected.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error("ZIP data.js 内容不完整");
  }
  if (flagsHasEncrypted(selected)) {
    throw new Error("不支持加密 ZIP");
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  let result;
  if (selected.compressionMethod === 0) {
    result = compressed;
  } else if (selected.compressionMethod === 8) {
    result = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`不支持 ZIP 压缩方式: ${selected.compressionMethod}`);
  }
  if (selected.uncompressedSize !== result.length) {
    throw new Error("ZIP data.js 解压后大小不匹配");
  }
  return result;
}

function flagsHasEncrypted(entry) {
  return Boolean(entry.flags & 0x1);
}

function isZipDownload(downloadUrl, body, headers = {}) {
  try {
    const pathname = new URL(downloadUrl).pathname.toLowerCase();
    if (pathname.endsWith(".zip")) return true;
  } catch (error) {
    // URL 校验在 requestBuffer 中完成。
  }
  const disposition = String(headers["content-disposition"] || "").toLowerCase();
  if (/filename\*?=.*\.zip(?:["';]|$)/i.test(disposition)) return true;
  return body.length >= 4 && body.readUInt32LE(0) === 0x04034b50;
}

function embeddedRawUrl(value) {
  const source = decodeURIComponent(String(value));
  const match = source.match(
    /https?:\/\/raw\.githubusercontent\.com\/[^\s?#]+/i
  );
  return match ? match[0] : null;
}

function installDataFile(dataPath, content) {
  const directory = path.dirname(dataPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${dataPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content);
    fs.renameSync(temporaryPath, dataPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function createDataUpdater(options) {
  const {
    dataPath,
    githubFileUrl,
    githubApiUrl = "",
    downloadUrl,
    githubToken = "",
    updateIntervalMs = 0,
    reload,
    logger = console,
  } = options;
  let updateInFlight = null;
  let intervalHandle = null;
  let watcher = null;
  let watchTimer = null;
  let installedSha = null;

  function readLocalSha() {
    if (!fs.existsSync(dataPath)) return null;
    return gitBlobSha(fs.readFileSync(dataPath));
  }

  function restoreLocalZip() {
    if (fs.existsSync(dataPath)) return false;
    const candidates = [
      `${dataPath}.zip`,
      dataPath.replace(/\.js$/i, ".zip"),
    ].filter((candidate, index, list) => list.indexOf(candidate) === index);

    for (const archivePath of candidates) {
      if (!fs.existsSync(archivePath)) continue;
      try {
        const archive = fs.readFileSync(archivePath);
        const content = extractDataJsFromZip(archive);
        installDataFile(dataPath, content);
        installedSha = gitBlobSha(content);
        if (typeof reload === "function") reload();
        logger.log(`已从本地 ${path.basename(archivePath)} 解压 data.js`);
        return true;
      } catch (error) {
        logger.warn(`本地 ZIP 解压失败（${path.basename(archivePath)}）: ${error.message}`);
      }
    }
    return false;
  }

  async function getRemoteSha() {
    const apiUrl = githubApiUrl || githubContentApiUrl(githubFileUrl);
    logger.log(`获取远程 data.js SHA: ${apiUrl}`);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": DEFAULT_USER_AGENT,
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    const payload = await requestJson(apiUrl, { headers, timeoutMs: 3000 });
    if (!payload || typeof payload.sha !== "string") {
      throw new Error("GitHub API 响应缺少 data.js sha");
    }
    return payload.sha;
  }

  async function downloadData() {
    async function downloadFrom(url) {
      const startedAt = Date.now();
      logger.log(`开始下载索引: ${url}`);
      const response = await requestBuffer(url, {
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        timeoutMs: 15000,
      });
      const content = isZipDownload(response.url || url, response.body, response.headers)
        ? extractDataJsFromZip(response.body)
        : response.body;
      logger.log(`索引下载完成: ${url}（${content.length} bytes，${Date.now() - startedAt} ms）`);
      return content;
    }

    const fallbackUrl = embeddedRawUrl(downloadUrl);
    try {
      return await downloadFrom(downloadUrl);
    } catch (error) {
      if (!fallbackUrl || fallbackUrl === downloadUrl) throw error;
      logger.warn(`下载代理失败，回退 raw GitHub 地址: ${error.message}`);
      return downloadFrom(fallbackUrl);
    }
  }

  // 先比 Git blob SHA，再下载并原子替换，避免并发请求覆盖文件。
  async function checkForUpdate(reason = "manual") {
    if (updateInFlight) return updateInFlight;
    updateInFlight = (async () => {
      restoreLocalZip();
      const localSha = readLocalSha();
      if (!localSha) {
        logger.log(`本地 data.js 不存在，开始下载索引（${reason}）`);
      }
      const initialDownload = localSha
        ? null
        : downloadData().then(
            (content) => ({ content }),
            (error) => ({ error })
          );
      let remoteSha = null;
      try {
        remoteSha = await getRemoteSha();
      } catch (error) {
        if (localSha) {
          logger.warn(`获取远程 data.js sha 失败（${reason}）: ${error.message}`);
          return { updated: false, reason: "remote-error", localSha };
        }
        logger.warn(`本地 data.js 不存在，GitHub sha 获取失败，继续尝试下载: ${error.message}`);
      }

      if (localSha && remoteSha && localSha === remoteSha) {
        return { updated: false, reason: "unchanged", sha: localSha };
      }

      let content;
      if (initialDownload) {
        const result = await initialDownload;
        if (result.error) throw result.error;
        content = result.content;
      } else {
        content = await downloadData();
      }
      const downloadedSha = gitBlobSha(content);
      if (remoteSha && downloadedSha !== remoteSha) {
        throw new Error(`下载 data.js sha 不匹配（期望 ${remoteSha}，实际 ${downloadedSha}）`);
      }
      installDataFile(dataPath, content);
      installedSha = downloadedSha;
      if (typeof reload === "function") reload();
      logger.log(`已更新 data.js（${reason}，sha ${downloadedSha}）`);
      return { updated: true, sha: downloadedSha };
    })().finally(() => {
      updateInFlight = null;
    });
    return updateInFlight;
  }

  function watchDataFile() {
    const directory = path.dirname(dataPath);
    fs.mkdirSync(directory, { recursive: true });
    watcher = fs.watch(directory, (eventType, filename) => {
      if (filename && path.basename(filename.toString()) !== path.basename(dataPath)) {
        return;
      }
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try {
          if (!fs.existsSync(dataPath) || typeof reload !== "function") return;
          const currentSha = readLocalSha();
          if (installedSha && currentSha === installedSha) {
            installedSha = null;
            return;
          }
          installedSha = null;
          reload();
        } catch (error) {
          logger.error(`手动替换 data.js 后重载失败: ${error.message}`);
        }
      }, 300);
    });
    watcher.on("error", (error) => logger.error(`data.js 文件监测失败: ${error.message}`));
  }

  function start() {
    watchDataFile();
    if (updateIntervalMs > 0) {
      intervalHandle = setInterval(() => {
        checkForUpdate("interval").catch((error) =>
          logger.error(`定时更新 data.js 失败: ${error.message}`)
        );
      }, updateIntervalMs);
      intervalHandle.unref?.();
    }
    return checkForUpdate("startup");
  }

  function stop() {
    if (intervalHandle) clearInterval(intervalHandle);
    if (watchTimer) clearTimeout(watchTimer);
    if (watcher) watcher.close();
  }

  return {
    checkForUpdate,
    start,
    stop,
    getRemoteSha,
    readLocalSha,
  };
}

module.exports = {
  createDataUpdater,
  extractDataJsFromZip,
  getGithubContentApiUrl: githubContentApiUrl,
  gitBlobSha,
};
