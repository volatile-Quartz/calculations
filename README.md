# 📐 草稿纸查看器

编号递增的数学草稿纸归档，每 100 张一卷打包为 zip 发布，浏览器端按需下载、即时预览。

- 在线地址：<https://volatile-quartz.github.io/scratch-paper-archive/>
- 交互：缩略图网格（虚拟滚动）· 编号定位 · 编号段范围浏览（跨包自动串联）· 按月份查看 · 点击放大 · 翻页 / 拖动 / 滚轮缩放 / 旋转

## 架构

```text
┌─ 数据层：GitHub Releases（本仓库）
│    scratch-XXXX-YYYY.zip（每 100 张一卷，包内图片按编号命名）
│
├─ 索引层：sync_index workflow
│    用 HTTP Range 只读每个 zip 尾部的「中央目录」→ 拿到包内真实编号区间
│    → 生成 index.json（按 asset_id 缓存，发布新包时只扫新包）
│
├─ 代理层：Cloudflare Worker（worker/worker.js）
│    流式转发 Release 资源，绕开 Azure Blob 的 CORS 限制
│
└─ 前端：index.html（GitHub Pages）
     读 index.json + calendar.json → 编号段选择 / 月份查看 / 编号定位 / 范围浏览
     → 经 Worker 按需下载 zip → JSZip 解压 → 虚拟滚动网格 → 点击放大
```

## 日常使用

1. **发布草稿纸**：在本仓库发 Release 并上传 zip，命名 `scratch-XXXX-YYYY.zip`
   （每 100 张一卷，如 `scratch-0000-0099.zip`；编号补零到 4 位便于排序）
2. **更新索引**：Actions → Sync Index → Run workflow
   （发布新 Release 时也会自动触发；编号区间靠扫描 zip 中央目录得到，无需解压）
3. **登记月份**（用于「按月份查看」）：在 `calendar.json` 的 `months` 末尾追加一行，
   如 `{"label": "2026.01", "ranges": [[8543, 8580]]}`（多段时写多个 range）
4. **访问**：<https://volatile-quartz.github.io/scratch-paper-archive/>

## 部署 Cloudflare Worker

### 方式一：Cloudflare 网页端（推荐，无需本地环境）

1. 登录 <https://dash.cloudflare.com> → 左侧 **Workers & Pages**（计算 / Workers）→ **Create application**（创建应用程序）
2. 选 **Create Worker**（Hello World 模板），命名如 `calculations-viewer` → **Deploy**
   - ⚠️ 界面里的 **Connect GitHub** 选项**不要选**：那是 Pages 的 Git 集成（把仓库当静态站点构建发布），Worker 不需要连接仓库，直接把代码粘进去即可
3. 部署成功后点 **Edit code**，删掉默认的 Hello World，把 `worker/worker.js` 的全文粘贴进去 → **Deploy**
4. （可选）Settings → **Variables and Secrets** 添加加密变量 `GITHUB_TOKEN`：
   不配置也能运行，但匿名调用 GitHub API 限 60 次/小时，容易被限流
5. 记下分配到的地址：`https://<Worker名>.<账号子域>.workers.dev`
6. **验证**：浏览器打开
   `https://<地址>/zip/volatile-Quartz/scratch-paper-archive/<asset_id>`
   能看到 zip 开始下载，即代理工作正常（`asset_id` 见 `index.json`）
7. 把地址填入 `index.html` 顶部的 `WORKER_URL` 常量并提交

### 方式二：wrangler CLI（本地已有 Node 环境时）

```bash
cd worker
wrangler secret put GITHUB_TOKEN   # 可选
wrangler deploy
```

## 为什么需要 Worker

浏览器直接 fetch GitHub Releases 的 zip 会被 Azure Blob Storage 的 CORS 策略拒绝。
Worker 作为同源代理绕过该限制。Cloudflare Worker 免费档 10 万请求/天，足够日常使用。

## 编号与分卷

图片按递增编号命名（从 0 起），物理上**按编号分卷**：每 100 张一卷，命名 `scratch-XXXX-YYYY.zip`（如 `scratch-0000-0099.zip`），与日期无关——早期无日期的草稿（如 No.0–252）也能整齐归档。前端支持：

- **编号定位**：输入 `7800` 直达该编号的图片；该编号不存在时定位到最近一张
- **范围浏览**：输入 `7600-7700` 列出该段内的所有图片，跨包自动串联
  （单次跨度上限 3000，避免一次加载过多）

## 按月份查看

包内按编号存储、与日期无关；「按月份查看」由仓库根目录的 `calendar.json` 驱动
（月份 → 编号区间对照，同一个月可对应多段区间）。历史上从 2014.03 到 2025.12
（含无日期的早期段 0–252、空月如 2016–2018）已全量登记；
以后每上传一批新草稿，在 `months` 末尾追加一行即可。