/**
 * lib/warm.js —— 缓存预热。
 *
 * ## 为什么值得单独做一个预热
 *
 * 体检最贵的一步是解析 app.asar 的头（4.76 MB JSON，50–60 ms/次）。
 * 预热把这一步**提前**做掉，体检本体就只剩读小文件 + 判版本 —— 毫秒级。
 * 对 CLI 来说这意味着「体检可以是零等待的前置动作」；对宿主工具来说，
 * 一次预热之后，同一天里所有体检都走磁盘缓存。
 *
 * ## 预热写的是**共享缓存**
 *
 * 写入的是 `<cacheDir>/` 下与主插件**同一份**格式的缓存文件，
 * 所以预热一次，主插件 `compat_check` 也一起受益（反之亦然）。
 *
 * ## 预热上游是**可选**的
 *
 * 默认**不联网**：预热上游会发两个请求（GitHub + npm，npm 那个 294 KB），
 * 没人要求时不该偷偷发。`withNetwork: true` / `--warm --network` 才开。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  readAsarHeaderCache,
  readAsarEntryCache,
  sha1,
  statOf,
  writeAsarHeaderCache,
  writeAsarEntryCache,
} from './asar-cache.js';
import { normalizeInstallDir, readAsarFileWithHeader, readAsarHeader } from './asar-reader.js';
import { findInstallDir } from './fallback-check.js';
import { DEFAULT_PACKAGE, DEFAULT_REPO, fetchTextCached, githubReleasesUrl, npmPackageUrl } from './upstream.js';
import { DEFAULT_TTL_MS } from './upstream-cache.js';

/** 体检会读到的 asar 内文件（宿主检测全用得上）。 */
export const WARM_ENTRIES = [
  'dsh/node_modules/@deepseek-ai/dsh/package.json',
  'dsh/node_modules/@deepseek-ai/dsh-desktop-runtime/package.json',
  'dsh/package.json',
  'dsh/node_modules/@deepseek-ai/dsh-tools/package.json',
  'dsh/node_modules/@deepseek-ai/cordis/package.json',
  'dsh/node_modules/@deepseek-ai/schemastery/package.json',
];

/**
 * 找到要预热的 app.asar 路径。
 * @param {string} [installDir]
 * @returns {{asarPath:string|null, installDir:string|null}}
 */
export function resolveAsarPath(installDir) {
  const dir = findInstallDir(installDir);
  if (!dir) return { asarPath: null, installDir: null };
  const candidate = path.join(dir, 'resources', 'app.asar');
  try {
    if (fs.existsSync(candidate)) return { asarPath: candidate, installDir: dir };
  } catch { /* 读不到就当没有 */ }
  return { asarPath: null, installDir: dir };
}

/**
 * 预热 asar 头缓存 + 条目缓存（可选顺带预热上游）。
 *
 * @param {{installDir?:string, cacheDir:string, withNetwork?:boolean,
 *          repo?:string, pkg?:string, ttlMs?:number, refresh?:boolean}} opts
 * @returns {Promise<{
 *   ok:boolean, asarPath:string, installDir:string|null,
 *   header:{cached:boolean, parsed:boolean, bytes:number, valid:boolean},
 *   entries:{path:string, cached:boolean, bytes:number}[],
 *   upstream:{url:string, ok:boolean, source:string, bytes:number}[],
 *   elapsedMs:number, warnings:string[]
 * }>}
 */
export async function warmCaches(opts = {}) {
  const started = Date.now();
  const warnings = [];
  const cacheDir = opts.cacheDir;
  const { asarPath, installDir } = resolveAsarPath(opts.installDir);

  const result = {
    ok: true,
    asarPath: asarPath ?? '',
    installDir,
    header: { cached: false, parsed: false, bytes: 0, valid: false },
    entries: [],
    upstream: [],
    elapsedMs: 0,
    warnings,
  };

  if (!asarPath) {
    result.ok = false;
    result.warnings.push('找不到 app.asar（给个 --install-dir 指向 DSH 安装目录试试）');
    result.elapsedMs = Date.now() - started;
    return result;
  }

  const stat = statOf(asarPath);
  if (!stat) {
    result.ok = false;
    result.warnings.push(`app.asar 不存在或读不到：${asarPath}`);
    result.elapsedMs = Date.now() - started;
    return result;
  }

  /* --- 头缓存 --- */
  let header = null;
  let dataOffset = 0;
  const cached = opts.refresh ? null : readAsarHeaderCache(asarPath, { cacheDir });
  if (cached && cached.hit) {
    header = cached.header;
    dataOffset = cached.dataOffset;
    result.header.cached = true;
    result.header.valid = true;
  } else {
    try {
      const parsed = readAsarHeader(asarPath);
      header = parsed.header;
      dataOffset = parsed.dataOffset;
      writeAsarHeaderCache(asarPath, header, { cacheDir, stat, dataOffset });
      result.header.parsed = true;
      result.header.valid = true;
    } catch (e) {
      result.ok = false;
      result.warnings.push(`解析 asar 头失败：${e?.message ?? e}`);
      result.elapsedMs = Date.now() - started;
      return result;
    }
  }
  try {
    result.header.bytes = fs.statSync(path.join(cacheDir, 'asar-header', `${sha1(path.resolve(asarPath))}.json`)).size;
  } catch { /* 读不到就当 0 */ }

  /* --- 条目缓存 --- */
  for (const inner of WARM_ENTRIES) {
    const entry = { path: inner, cached: false, bytes: 0 };
    const already = opts.refresh ? null : readAsarEntryCache(asarPath, inner, { cacheDir, stat });
    if (already) {
      entry.cached = true;
      entry.bytes = already.length;
    } else if (header) {
      const buf = readAsarFileWithHeader(asarPath, header, dataOffset, inner);
      if (buf && buf.length) {
        writeAsarEntryCache(asarPath, inner, buf, { cacheDir, stat });
        entry.cached = true;
        entry.bytes = buf.length;
      } else {
        entry.cached = false;
      }
    }
    result.entries.push(entry);
  }

  /* --- 上游（可选，默认不联网） --- */
  if (opts.withNetwork) {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    for (const url of [githubReleasesUrl(opts.repo ?? DEFAULT_REPO), npmPackageUrl(opts.pkg ?? DEFAULT_PACKAGE)]) {
      const r = await fetchTextCached(url, { cacheDir, ttlMs, withNetwork: true, refresh: opts.refresh });
      result.upstream.push({ url, ok: r.ok, source: r.source, bytes: r.text?.length ?? 0 });
      if (!r.ok) result.warnings.push(`上游预热失败（${url}）：${r.error}`);
    }
  }

  result.elapsedMs = Date.now() - started;
  return result;
}
