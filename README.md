# 📐 草稿纸查看器

编号递增的数学草稿纸图片归档，按年/月 zip 发布，浏览器端按需下载预览。

## 架构

```
┌─ 数据层：本仓库 GitHub Releases
│   calculations-YYYY-MM.zip（按月发布）
│
├─ 索引层：sync_index workflow
│   扫 Releases → 生成 index.json → commit 进仓库
│
├─ 代理层：Cloudflare Worker（可选但推荐）
│   绕开 GitHub Releases 的 Azure CORS 限制
│
└─ 前端：index.html（GitHub Pages）
    fetch index.json → 选月份 → fetch zip（经 Worker 代理）
    → JSZip 解压 → 网格缩略图 → 点击放大 → 翻页/编号跳转
```

## 使用

1. **发布草稿纸**：在本仓库发 Release，每个 zip 命名 `calculations-YYYY-MM.zip`
2. **更新索引**：Run Workflow → Sync Index（或 Release 发布时自动触发）
3. **配置 Worker**（绕 CORS 必需）：
   ```bash
   cd worker
   wrangler secret put GITHUB_TOKEN   # 有 public_repo 权限的 token
   wrangler deploy
   ```
4. **填入 Worker URL**：编辑 `index.html` 里的 `WORKER_URL` 常量
5. **访问**：`https://volatile-quartz.github.io/calculations/`

## 为什么需要 Worker

浏览器直接 fetch GitHub Releases 的 zip 会被 Azure Blob Storage 的 CORS 策略拒绝。
Worker 作为服务端代理绕过了这个限制。Cloudflare Worker 免费档（10 万请求/天）足够日常使用。
