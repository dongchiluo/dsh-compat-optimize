/**
 * lib/upstream.js —— 上游接口的「缓存优先」取数层。
 *
 * 取一个 URL 的顺序：
 *   1. **缓存命中**（TTL 内）→ 直接用，**一次网络都不发**；
 *   2. 缓存未命中 / 已过期 → （允许联网时）发一次请求，把响应写回缓存。
 *
 * 为什么要缓存优先到「连一次网络都不发」的程度：
 * 上游一周之内基本不动，而 npm 那个接口的响应体有 294 KB。`notes` 动作如果每次都打网络，
 * 既慢又把「查上游」变成一件有副作用的事（会被限流）。缓存优先让它在大多数时候是纯本地的。
 *
 * ## 「查不到」≠「没有更新」
 *
 * 缓存未命中且不允许联网、或请求失败时，一律返回 `ok: false` 并说明原因 ——
 * 绝不能把「没查到」渲染成「已是最新」。这是本项目的一条硬规矩。
 */

import { readUpstreamCache, writeUpstreamCache, DEFAULT_TTL_MS } from './upstream-cache.js';

/** 上游仓库（GitHub）。 */
export const DEFAULT_REPO = 'deepseek-ai/deepseek-harness';

/** 上游包（npm）。 */
export const DEFAULT_PACKAGE = '@deepseek-ai/dsh';

/**
 * GitHub releases 接口 URL。
 * @param {string} repo
 * @returns {string}
 */
export function githubReleasesUrl(repo = DEFAULT_REPO) {
  return `https://api.github.com/repos/${repo}/releases?per_page=20`;
}

/**
 * npm registry 的包元数据 URL。
 * @param {string} pkg
 * @returns {string}
 */
export function npmPackageUrl(pkg = DEFAULT_PACKAGE) {
  return `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
}

/**
 * 取一个 URL 的文本（缓存优先）。
 *
 * @param {string} url
 * @param {{cacheDir?:string, ttlMs?:number, withNetwork?:boolean, refresh?:boolean,
 *          timeoutMs?:number, headers?:object, now?:number}} opts
 * @returns {Promise<{ok:boolean, text:string, source:'cache'|'network'|'none',
 *                    status:number, error:string|null, url:string, fetchedAt:number}>}
 */
export async function fetchTextCached(url, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();

  if (!opts.refresh && opts.cacheDir) {
    const hit = readUpstreamCache(opts.cacheDir, url, { ttlMs, now });
    if (hit) {
      return {
        ok: hit.ok,
        text: hit.payload,
        source: 'cache',
        status: hit.status,
        error: null,
        url,
        fetchedAt: hit.fetchedAt,
      };
    }
  }

  if (opts.withNetwork === false) {
    return {
      ok: false,
      text: '',
      source: 'none',
      status: 0,
      error: '上游缓存未命中，且本次不允许联网（未开启 withNetwork / --notes 的联网补齐）',
      url,
      fetchedAt: 0,
    };
  }

  try {
    const r = await httpGetText(url, { timeoutMs: opts.timeoutMs ?? 15000, headers: opts.headers });
    if (opts.cacheDir && r.text) {
      writeUpstreamCache(opts.cacheDir, url, r.text, { ttlMs, status: r.status, ok: r.ok, now });
    }
    return {
      ok: r.ok,
      text: r.text,
      source: 'network',
      status: r.status,
      error: r.ok ? null : `HTTP ${r.status}`,
      url,
      fetchedAt: Date.now(),
    };
  } catch (e) {
    return {
      ok: false,
      text: '',
      source: 'none',
      status: 0,
      error: `请求失败：${e?.message ?? e}`,
      url,
      fetchedAt: 0,
    };
  }
}

/**
 * 裸 HTTP GET（取文本）。用 node 内置 fetch，不引任何第三方库。
 * @param {string} url
 * @param {{timeoutMs?:number, headers?:object}} opts
 * @returns {Promise<{ok:boolean, status:number, text:string}>}
 */
export async function httpGetText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-compat-optimize', accept: '*/*', ...(opts.headers ?? {}) },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}
