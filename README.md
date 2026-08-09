# 5echmweb-search

用于 DND 不全书的现代化搜索。服务启动时加载本地 `data.js`，并通过 GitHub REST API
比较远程文件 SHA；发现变化后自动下载、替换并重载索引。
本地 `data.js` 不存在时，启动会立即下载索引并自动加载。
若目录已有 `data.js.zip` 或 `data.zip`，启动会先自动解压其中的 `data.js`。
本地索引缺失时，服务会在首次下载尝试结束后再监听端口。

## 配置

编辑 [config.js](config.js)，或使用同名环境变量覆盖：

- `config.js` 中的 `updateIntervalMs` 或环境变量 `DATA_UPDATE_INTERVAL_MS`：自动检查周期，默认 6 小时。
- `GITHUB_DATA_URL`：GitHub 文件页面、raw 地址或其加速代理地址，默认 `https://github.com/DND5eChm/5echmweb_search/blob/main/data.js`。
- `GITHUB_CONTENT_API_URL`：可选，直接指定 GitHub `Get repository content` API 地址，便于自建 GitHub API 代理。
- `DATA_DOWNLOAD_URL`：下载直链，默认 `https://sealchat-update.silverdragon.workers.dev/https://raw.githubusercontent.com/DND5eChm/5echmweb_search/refs/heads/main/data.js`。地址以 `.zip` 结尾时自动提取其中的 `data.js`。
- `DATA_JS_PATH`：本地索引路径，默认仓库根目录 `data.js`。
- `PORT`：搜索服务与 Webhook 共用端口，默认 `13000`。
- `WEBHOOK_PATH`：GitHub Webhook 子路由，默认 `/webhook`。
- `GITHUB_WEBHOOK_SECRET`：可选。设置后校验 `x-hub-signature-256`。
- `GITHUB_TOKEN`：可选。用于 GitHub API 认证，避免匿名 API 限流。

服务也监测 `data.js` 所在目录。手动替换文件后，索引会在文件稳定后自动重载。

## 运行

```bash
npm install
npm start
```

Windows 可双击 `start.cmd` 启动；首次运行前执行 `npm install`。

GitHub Webhook 使用 `POST /webhook`，保留 GitHub 标准请求头（`x-github-event`、
`x-github-delivery`、`x-hub-signature-256`）。收到请求后立即执行 SHA 检查与更新。
