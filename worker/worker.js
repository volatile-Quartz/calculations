// Cloudflare Worker: GitHub Release Proxy  v1.2.2
// 绕过 GitHub Releases 的 Azure CORS
//   /zip/{owner}/{repo}/{asset_id}   整包流式代理（原行为，保留作回退）
//   /range/{owner}/{repo}/{asset_id}?bytes=start-end
//                                    按需读取：解析 CDN 直链后透传 Range 请求
//                                    （浏览器端远程解 zip 只取单张图片用；
//                                     用 query 传区间避免 CORS 预检）
// 部署：Cloudflare 网页端粘贴本文件全部内容 → Deploy（或 wrangler deploy）
// 环境变量：GITHUB_TOKEN（可选，避免匿名限流）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Max-Age': '86400',
  // 关键：Content-Range 不在浏览器 CORS 默认可读头白名单里，
  // 不暴露的话前端拿不到「包大小」（remoteSize 会误判失败回退整包）
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Content-Disposition, Accept-Ranges',
};

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

function err(status, message) {
  return new Response(message, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
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
  // 区间优先从 query 读（避免 CORS 预检）；也兼容标准 Range 头
  const range = new URL(request.url).searchParams.get('bytes')
    ? `bytes=${new URL(request.url).searchParams.get('bytes')}`
    : request.headers.get('Range');

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
    // CORS 预检（理论上 query 方案不会触发，但兜个底）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '');
    const parts = path.split('/');
    const route = parts[0];

    if ((route !== 'zip' && route !== 'range') || parts.length < 4) {
      return err(400, 'Usage: /zip/{owner}/{repo}/{asset_id}    (full download)\n  or: /range/{owner}/{repo}/{asset_id}?bytes=start-end  (HTTP Range passthrough)');
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
        return err(resp.status, `GitHub API ${resp.status}: ${body}`);
      }

      const fileName = resp.headers.get('content-disposition') || `attachment; filename="${assetId}.zip"`;
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'application/zip',
          'Content-Length': resp.headers.get('content-length') || '',
          'Content-Disposition': fileName,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': CORS['Access-Control-Expose-Headers'],
        },
      });
    } catch (e) {
      return err(500, `Worker error: ${e.message}`);
    }
  },
};
