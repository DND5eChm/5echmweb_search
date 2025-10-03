const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 加载并解析数据文件
let searchData = [];

function ingestEntry(rawContent, rawTitle, rawPath) {
    searchData.push({
        content: normalizeLineEndings(String(rawContent || '')),
        title: String(rawTitle || ''),
        path: String(rawPath || '').replace(/\\+/g, '/').replace(/\\\\/g, '/')
    });
}

function loadFromChunks(chunkDir) {
    try {
        if (!fs.existsSync(chunkDir)) {
            return false;
        }
        const manifestPath = path.join(chunkDir, 'manifest.json');
        let chunkFiles = [];
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (manifest && Array.isArray(manifest.chunks)) {
                chunkFiles = manifest.chunks;
            }
        }
        if (!chunkFiles.length) {
            chunkFiles = fs.readdirSync(chunkDir).filter(name => name.endsWith('.json'));
        }
        chunkFiles.sort();
        chunkFiles.forEach(file => {
            const fullPath = path.join(chunkDir, file);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
                data.forEach(entry => {
                    if (Array.isArray(entry)) {
                        ingestEntry(entry[0], entry[1], entry[2]);
                    } else if (entry && typeof entry === 'object') {
                        ingestEntry(entry.content, entry.title, entry.path);
                    }
                });
            }
        });
        return searchData.length > 0;
    } catch (error) {
        console.error('加载分块数据失败:', error);
        return false;
    }
}

function loadFromLegacy(dataPath) {
    try {
        const content = fs.readFileSync(dataPath, 'utf-8');
        const sandbox = {};
        vm.createContext(sandbox);
        const script = new vm.Script(`${content}; contents;`, { filename: 'data.js' });
        const rawContents = script.runInContext(sandbox, { timeout: 5000 });
        if (Array.isArray(rawContents)) {
            for (let i = 0; i + 2 < rawContents.length; i += 3) {
                ingestEntry(rawContents[i], rawContents[i + 1], rawContents[i + 2]);
            }
        }
    } catch (error) {
        console.error('加载 data.js 失败:', error);
    }
}

function loadSearchData() {
    searchData = [];
    const chunkDir = path.join(__dirname, 'data_chunks');
    const loadedFromChunks = loadFromChunks(chunkDir);
    if (!loadedFromChunks) {
        const dataPath = path.join(__dirname, 'data.js');
        loadFromLegacy(dataPath);
    }
    console.log(`已加载 ${searchData.length} 条数据`);
}

function normalizeLineEndings(text) {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\n\r/g, '\n')
        .replace(/\r/g, '\n');
}

function buildPreview(text, keywords, maxLength = 600) {
    if (!text) return '';
    const normalized = normalizeLineEndings(text);
    const lower = normalized.toLowerCase();

    let bestIndex = -1;
    let bestKeywordLength = 0;

    keywords.forEach(kw => {
        if (!kw) return;
        const idx = lower.indexOf(kw.toLowerCase());
        if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
            bestIndex = idx;
            bestKeywordLength = kw.length;
        }
    });

    if (bestIndex === -1) {
        const truncated = normalized.slice(0, maxLength);
        return normalized.length > maxLength ? truncated + '…' : truncated;
    }

    const halfWindow = Math.max((maxLength - bestKeywordLength) / 2, 0);
    const start = Math.max(0, Math.floor(bestIndex - halfWindow));
    const end = Math.min(normalized.length, Math.ceil(start + maxLength));

    let snippet = normalized.slice(start, end);
    if (start > 0) {
        snippet = '…' + snippet;
    }
    if (end < normalized.length) {
        snippet = snippet + '…';
    }
    return snippet;
}

function extractSourcePath(rawPath) {
    if (!rawPath) {
        return '';
    }
    return rawPath
        .replace(/\\+/g, '/')
        .replace(/^topics\//i, '');
}

function buildDisplayTitle(rawTitle, sourcePath) {
    if (rawTitle) {
        const normalized = normalizeLineEndings(rawTitle).trim();
        if (normalized) {
            const firstLine = normalized.split('\n')[0].trim();
            if (firstLine) {
                return firstLine;
            }
        }
    }
    if (sourcePath) {
        const last = sourcePath.split('/').pop() || '';
        return last.replace(/\.(html?|htm)$/i, '') || '未命名页面';
    }
    return '未命名页面';
}

// 搜索 API
app.get('/api/search', (req, res) => {
    const { keyword, titleOnly = 'false', page = 1, pageSize = 20, baseIndexes = '' } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const size = Math.max(parseInt(pageSize, 10) || 20, 1);

    if (!keyword) {
        return res.json({ results: [], total: 0, page: pageNum, totalPages: 0, pageSize: size });
    }

    let baseIndexesSet = null;
    if (typeof baseIndexes === 'string' && baseIndexes.trim().length > 0) {
        baseIndexesSet = new Set(
            baseIndexes
                .split(',')
                .map(idx => parseInt(idx, 10))
                .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < searchData.length)
        );

        if (baseIndexesSet.size === 0) {
            return res.json({ results: [], total: 0, page: pageNum, totalPages: 0, pageSize: size });
        }
    }

    // 将关键词分割成多个词
    const keywords = keyword.trim().split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 0) {
        return res.json({ results: [], total: 0, page: pageNum, totalPages: 0, pageSize: size });
    }
    const isTitleOnly = titleOnly === 'true';

    // 搜索并计算相关度
    const results = [];

    searchData.forEach((item, index) => {
        if (baseIndexesSet && !baseIndexesSet.has(index)) {
            return;
        }

        let titleRank = 1;
        let contentRank = 1;
        let titleHits = 0;
        let contentHits = 0;

        keywords.forEach(kw => {
            const regex = new RegExp(kw, 'gi');

            const titleMatches = item.title.match(regex);
            if (titleMatches) {
                titleHits += titleMatches.length;
                titleRank *= (titleMatches.length + 1);
            }

            if (!isTitleOnly) {
                const contentMatches = item.content.match(regex);
                if (contentMatches) {
                    contentHits += contentMatches.length;
                    contentRank *= (contentMatches.length + 1);
                }
            }
        });

        if (titleHits === 0 && contentHits === 0) {
            return;
        }

        const totalRank = Math.round(Math.pow(titleRank, 1 / keywords.length) * 20) +
                         (isTitleOnly ? 0 : Math.round(Math.pow(contentRank, 1 / keywords.length)));

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
            content: normalizeLineEndings(item.content)
        });
    });

    // 按相关度排序
    results.sort((a, b) => b.rank - a.rank);

    // 分页
    const total = results.length;
    const totalPages = Math.ceil(total / size);
    const start = (pageNum - 1) * size;
    const paginatedResults = results.slice(start, start + size);

    res.json({
        results: paginatedResults,
        total,
        page: pageNum,
        totalPages,
        pageSize: size
    });
});

// 获取内容详情
app.get('/api/content/:index', (req, res) => {
    const index = parseInt(req.params.index);

    if (index >= 0 && index < searchData.length) {
        res.json(searchData[index]);
    } else {
        res.status(404).json({ error: '内容未找到' });
    }
});

// 启动服务器前加载数据
loadSearchData();

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
