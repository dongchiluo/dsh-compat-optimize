/**
 * lib/upstream-cache.js —— 上游响应（GitHub Release / npm registry）的磁盘缓存。
 *
 * 为什么要缓存上游：`action=notes` 要打两个远端接口，npm 那个的响应体有 294 KB。
 * 每次重下 + 重解析，既慢又费配额，而上游一周之内基本不动。
 *
 * ## 磁盘格式（与主插件 lib/cache.js 一致，两边互不失效）
 *
 * - 路径：`<cacheDir>/upstream/<sha1(url)>.json`
 * - 内容：`{"formatVersion":1,"url":"...","fetchedAt":N,"ttlMs":N,"status":N,"ok":true,"payload":"<原始响应文本>"}`
 *
 * ## 判活
 *
 * TTL（默认 6 小时 = 21600000 ms）。`Date.now() - fetchedAt` 必须落在 `[0, ttlMs]` ——
 * 负数（时钟被往回调过）也算失效：宁可回源也不给一份来路不明的旧数据。
 *
 * `now` 是可注入的：自检要能验证「TTL 到点就失效」，不能靠真的等 6 小时。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 缓存格式版本（与主插件保持一致）。 */
export const CACHE_FORMAT_VERSION = 1;

/** 默认上游缓存 TTL：6 小时。 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** sha1 十六进制摘要。 */
export function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/**
 * 上游缓存文件路径。
 * @param {string} cacheDir
 * @param {string} url
 * @returns {string}
 */
export function upstreamCachePath(cacheDir, url) {
  return path.join(cacheDir, 'upstream', `${sha1(url)}.json`);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读上游缓存（TTL 内才算命中）。
 *
 * @param {string} cacheDir
 * @param {string} url
 * @param {{ttlMs?:number, now?:number}} [opts]
 * @returns {{payload:string, status:number, ok:boolean, fetchedAt:number, ttlMs:number}|null}
 */
export function readUpstreamCache(cacheDir, url, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!cacheDir || !url) return null;
  const c = readJsonFile(upstreamCachePath(cacheDir, url));
  if (!c || c.formatVersion !== CACHE_FORMAT_VERSION) return null;
  if (c.url !== url) return null;
  const age = now - (c.fetchedAt ?? 0);
  if (!Number.isFinite(age) || age < 0 || age > ttlMs) return null;
  return {
    payload: typeof c.payload === 'string' ? c.payload : '',
    status: c.status ?? 0,
    ok: c.ok !== false,
    fetchedAt: c.fetchedAt ?? 0,
    ttlMs: c.ttlMs ?? ttlMs,
  };
}

/**
 * 写上游缓存（best-effort）。
 *
 * @param {string} cacheDir
 * @param {string} url
 * @param {string} payload 原始响应文本
 * @param {{ttlMs?:number, status?:number, ok?:boolean, now?:number}} [opts]
 * @returns {boolean}
 */
export function writeUpstreamCache(cacheDir, url, payload, { ttlMs = DEFAULT_TTL_MS, status = 0, ok = true, now = Date.now() } = {}) {
  if (!cacheDir || !url || typeof payload !== 'string') return false;
  return writeJsonFile(upstreamCachePath(cacheDir, url), {
    formatVersion: CACHE_FORMAT_VERSION,
    url,
    fetchedAt: now,
    ttlMs,
    status,
    ok,
    payload,
  });
}

/**
 * 列出上游缓存条目（给 `status` 看新鲜度用）。
 * @param {string} cacheDir
 * @returns {{url:string, fetchedAt:number, ageMs:number, ttlMs:number, bytes:number, fresh:boolean}[]}
 */
export function listUpstreamCache(cacheDir, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const out = [];
  try {
    for (const name of fs.readdirSync(path.join(cacheDir, 'upstream'))) {
      const p = path.join(cacheDir, 'upstream', name);
      const c = readJsonFile(p);
      if (!c) continue;
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch { /* 读不到就当 0 */ }
      const age = now - (c.fetchedAt ?? 0);
      out.push({
        url: c.url ?? '',
        fetchedAt: c.fetchedAt ?? 0,
        ageMs: age,
        ttlMs: c.ttlMs ?? ttlMs,
        bytes,
        fresh: age >= 0 && age <= (c.ttlMs ?? ttlMs),
        status: c.status ?? 0,
        ok: c.ok !== false,
      });
    }
  } catch { /* 目录不存在 = 没有缓存 */ }
  return out;
}
