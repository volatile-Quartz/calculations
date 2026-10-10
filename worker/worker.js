// Cloudflare Worker: GitHub Release Proxy  v1.2
// 绕过 GitHub Releases 的 Azure CORS
//   /zip/{owner}/{repo}/{asset_id}   整包流式代理（原行为，保留作回退）
//   /range/{owner}/{repo}/{asset_id} 按需读取：解析 CDN 直链后透传 Range 请求
//                                    （浏览器端远程解 zip 只取单张图片用）
// 部署：Cloudflare 网页端粘贴本文件全部内容 → Deploy（或 wrangler deploy）
// 环境变量：GITHUB_TOKEN（可选，避免匿名限流）

// CDN 直链缓存（签名 URL 约 30 分钟内有效；过期靠 403 触发重解析）
const CDN_CACHE = new Map();

function passthrough(up) {
  const h = {};
  for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition', 'ETag', 'Last-Modified']) {
    const v = up.headers.get(k);
    if (v) h[k] = v;
  }
  if (!h['Accept-Ranges']) h['Accept-Ranges'] = 'bytes';
  h['Access-Control-Allow-Origin'] = '*';
  if (!h['Cache-Control']) h['Cache-Control'] = 'public, max-age=86400';
  return new Response(up.body, { status: up.status, headers: h });
}

async function apiAssetUrl(owner, repo, assetId, env) {
  const headers = {
    'Accept': 'application/octet-stream',
    'User-Agent': 'calc-viewer-worker/1.2',
  };
  if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
    { headers, redirect: 'manual' }
  );
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('Location');
    if (loc) return { cdn: loc, resp: null };
  }
  return { cdn: null, resp: r };
}

// Range 路由：最多尝试 2 次（直链过期 403 时重解析一次）
async function handleRange(request, env, owner, repo, assetId) {
  const key = `${owner}/${repo}/${assetId}`;
  const range = request.headers.get('Range');

  for (let attempt = 0; attempt < 2; attempt++) {
    let cdn = CDN_CACHE.get(key);
    if (cdn && cdn.exp < Date.now()) { CDN_CACHE.delete(key); cdn = null; }
    if (!cdn) {
      const { cdn: url, resp } = await apiAssetUrl(owner, repo, assetId, env);
      if (url) {
        cdn = { url, exp: Date.now() + 30 * 60 * 1000 };
        CDN_CACHE.set(key, cdn);
      } else if (resp) {
        if (resp.status >= 200 && resp.status < 300) return passthrough(resp); // 未重定向，整包兜底
        return new Response(`GitHub API ${resp.status}: ${await resp.text()}`, { status: resp.status });
      }
    }
    const up = await fetch(cdn.url, range ? { headers: { Range: range } } : {});
    if (up.status === 403) { CDN_CACHE.delete(key); cdn = null; continue; } // 签名过期，重解析
    return passthrough(up);
  }
  return new Response('upstream 403 after retry', { status: 502 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');
    const parts = path.split('/');
    const route = parts[0];

    if ((route !== 'zip' && route !== 'range') || parts.length < 4) {
      return new Response(
        'Usage: /zip/{owner}/{repo}/{asset_id}    (full download)\n  or: /range/{owner}/{repo}/{asset_id}  (HTTP Range passthrough)',
        { status: 400 }
      );
    }
    const [, owner, repo, assetId] = parts;

    try {
      if (route === 'range') return await handleRange(request, env, owner, repo, assetId);

      // ---- 整包代理（原 v1.0 行为） ----
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`;
      const headers = {
        'Accept': 'application/octet-stream',
        'User-Agent': 'calc-viewer-worker/1.2',
      };
      if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;

      const resp = await fetch(apiUrl, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return new Response(`GitHub API ${resp.status}: ${body}`, { status: resp.status });
      }

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
