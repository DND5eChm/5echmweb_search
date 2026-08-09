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

## GitHub Webhook 配置

1. 确保服务已启动，并通过公网域名、反向代理或内网穿透暴露服务。GitHub 无法访问 `localhost`。

   默认回调地址：

   ```text
   https://你的域名/webhook
   ```

   反向代理目标：

   ```text
   http://127.0.0.1:13000/webhook
   ```

2. 设置 Webhook 密钥。Windows 可在 `start.cmd` 的 `call npm start` 前加入：

   ```cmd
   set GITHUB_WEBHOOK_SECRET=替换为随机密钥
   call npm start
   ```

   也可通过系统环境变量 `GITHUB_WEBHOOK_SECRET` 设置。密钥不要提交到 Git 仓库。

3. 打开 GitHub 仓库：`Settings` → `Webhooks` → `Add webhook`。

4. 填写表单：

   - `Payload URL`：填写 `https://你的域名/webhook`。
   - `Content type`：选择 `application/json`。
   - `Secret`：填写与 `GITHUB_WEBHOOK_SECRET` 完全相同的密钥。
   - `Which events would you like to receive?`：选择 `Just the push event`。
   - `Active`：保持勾选。

5. 点击 `Add webhook`。GitHub 推送代码后，服务会校验签名、获取远程 `data.js` SHA，并在索引变化时自动下载和重载。

6. 可在 Webhook 详情页的 `Recent Deliveries` 中查看请求。成功响应为 HTTP `200`，失败请求会显示错误响应并可使用 `Redeliver` 重试。

未配置 `GITHUB_WEBHOOK_SECRET` 时仍会接收请求，但不会校验签名，不建议用于公网服务。
