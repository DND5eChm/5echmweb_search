#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MiB
const ROOT = path.resolve(__dirname, "");
const SOURCE_FILE = path.join(ROOT, "data.js");
const OUTPUT_DIR = path.join(ROOT, "data_chunks");
const MANIFEST_FILE = path.join(OUTPUT_DIR, "manifest.json");

function normalizeLineEndings(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\r/g, "\n")
    .replace(/\r/g, "\n");
}

function readSourceArray() {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error(`找不到源文件: ${SOURCE_FILE}`);
  }
  const content = fs.readFileSync(SOURCE_FILE, "utf-8");
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(`${content}; contents;`, {
    filename: "data.js",
  });
  const raw = script.runInContext(sandbox, { timeout: 10000 });
  if (!Array.isArray(raw)) {
    throw new Error("data.js 中的 contents 不是数组");
  }
  return raw;
}

function groupEntries(rawArray) {
  const entries = [];
  for (let i = 0; i + 2 < rawArray.length; i += 3) {
    const content = normalizeLineEndings(String(rawArray[i] || ""));
    const title = String(rawArray[i + 1] || "");
    const pathValue = String(rawArray[i + 2] || "").replace(/\\/g, "/");
    entries.push({ content, title, path: pathValue });
  }
  return entries;
}

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function writeChunks(entries) {
  ensureCleanDir(OUTPUT_DIR);
  const manifest = [];
  let chunkIndex = 0;
  let currentEntries = [];
  let currentSize = 2; // for the surrounding [ ]

  const flush = () => {
    if (!currentEntries.length) return;
    const fileName = `chunk-${String(chunkIndex).padStart(3, "0")}.json`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    const payload = `[${currentEntries.join(",")}]`;
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > MAX_CHUNK_BYTES) {
      throw new Error(
        `单个块写入超出限制: ${fileName} 大小 ${payloadBytes} 字节`
      );
    }
    fs.writeFileSync(filePath, payload);
    manifest.push(fileName);
    chunkIndex += 1;
    currentEntries = [];
    currentSize = 2;
  };

  entries.forEach((entry, idx) => {
    const entryJson = JSON.stringify(entry);
    const entryBytes = Buffer.byteLength(entryJson);
    if (entryBytes > MAX_CHUNK_BYTES) {
      throw new Error(`第 ${idx} 个条目超过 10MiB，无法拆分，请检查数据`);
    }

    const separatorBytes = currentEntries.length > 0 ? 1 : 0; // comma
    if (currentSize + separatorBytes + entryBytes > MAX_CHUNK_BYTES) {
      flush();
    }

    currentEntries.push(entryJson);
    currentSize += separatorBytes + entryBytes;
  });

  flush();

  fs.writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      { chunks: manifest, generatedAt: new Date().toISOString() },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`拆分完成，共生成 ${manifest.length} 个文件`);
}

function main() {
  try {
    const rawArray = readSourceArray();
    const entries = groupEntries(rawArray);
    console.log(`读取到 ${entries.length} 条记录，开始拆分...`);
    writeChunks(entries);
  } catch (error) {
    console.error("拆分失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
