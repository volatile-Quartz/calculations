// Cloudflare Worker: GitHub Release Proxy
// 绕过 GitHub Releases 的 Azure CORS，流式代理 zip 文件
// 部署：wrangler deploy
// 环境变量：GITHUB_TOKEN（可选，避免匿名限流）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');

    // 路由：/zip/{repo}/{asset_id_or_name}
    // 示例：/zip/volatile-Quartz/scratch-paper-archive/597809277
    const parts = path.split('/');
    if (parts[0] !== 'zip' || parts.length < 4) {
      return new Response('Usage: /zip/{owner}/{repo}/{asset_id}\n  or  /meta/{owner}/{repo}', { status: 400 });
    }
    const [, owner, repo, assetId] = parts;

    try {
      // 用 GitHub API 下载 asset（带 Accept: application/octet-stream）
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`;
      const headers = {
        'Accept': 'application/octet-stream',
        'User-Agent': 'calc-viewer-worker/1.0',
      };
      if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;

      const resp = await fetch(apiUrl, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return new Response(`GitHub API ${resp.status}: ${body}`, { status: resp.status });
      }

      // 流式转发，保留原始文件名
      const fileName = resp.headers.get('content-disposition') || `attachment; filename="${assetId}.zip"`;
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'application/zip',
          'Content-Length': resp.headers.get('content-length') || '',
          'Content-Disposition': fileName,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (e) {
      return new Response(`Worker error: ${e.message}`, { status: 500 });
    }
  },
};
