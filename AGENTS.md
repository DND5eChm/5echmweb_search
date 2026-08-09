# Repository Guidelines
## 项目结构与模块组织
- `server.js` 为 Express 入口，负责内存索引加载与搜索接口。
- `data.js` 按三元组存储文档，启动时整体读入内存，更新后需重启。
- `webhelpsearch.htm` 提供前端入口，新建测试建议集中于未来的 `tests/` 目录。
## 构建、测试与本地开发命令
- `npm install`：安装 Express、Cors、Nodemon 等依赖，首次克隆后立即执行。
- `npm start`：以生产配置运行 `server.js`，默认端口 `13000`，用于验收或部署前检查。
- `npm run dev`：启用 Nodemon 热重载调试，调整端口时同步更新前端引用。
## 编码风格与命名规范
- 坚持 CommonJS 写法，使用两空格缩进、双引号与分号，复杂逻辑写中文注释说明边界。
- 文件命名采用小写中划线（如 `search-cache.js`），函数使用 `camelCase`，常量全大写蛇形。
- 模块职责保持单一，复用工具函数时集中到 `utils/`（新增时遵循同样规范）。
## 测试策略
- 建议引入 Jest，测试文件命名 `*.spec.js` 并放在 `tests/模块名/`。
- 覆盖数据加载解析、搜索匹配、分页与高并发响应时间。
- 预留 `npm test` 指向 Jest，保证本地执行通过后再提交。
## 提交与 PR 要求
- 提交信息采用祈使句，推荐使用 Conventional Commits（例：`feat: improve ranking`）。
- PR 需概述变更、验证步骤、影响范围，并关联需求或缺陷编号。
- 涉及接口或数据格式变更时说明回滚方案并通知前端或运维。
## 性能与并发优化建议
- 保持 `loadSearchData()` 启动时一次性加载，避免并发场景下频繁磁盘 I/O。
- 搜索逻辑使用局部不可变变量，必要时以 `Set`/`Map` 提升匹配效率和 CPU 利用率。
- 大规模数据更新前生成新 `data.js`，通过热重启或双缓冲策略缩短停机时间。
