/**
 * lib/notes.js —— 查上游 DSH 的版本，和本机版本对账。
 *
 * 与主插件 `compat_check action=notes` 的差别只有两处，且都是往「更省」的方向：
 *   1. **缓存优先**：TTL 内直接用磁盘缓存，**一次网络都不发**；
 *   2. **不联网也能出结论**：缓存未命中且不允许联网时，明确报「读不到」——
 *      绝不把「查不到」说成「没有更新」（这是本项目的一条硬规矩）。
 *
 * 上游版本同时从两个来源取（GitHub Release + npm registry），
 * 两个都读到才算「有结论」；只读到一边也会如实说明是哪一边读到的。
 */

import { loadMainPlugin, isUsable } from './main-plugin.js';
import { detectDshLite } from './fallback-check.js';
import { compareVersions } from './semver-lite.js';
import { DEFAULT_PACKAGE, DEFAULT_REPO, fetchTextCached, githubReleasesUrl, npmPackageUrl } from './upstream.js';
import { DEFAULT_TTL_MS } from './upstream-cache.js';

/**
 * 跑一次上游对账。
 *
 * @param {{installDir?:string, cacheDir:string, withNetwork?:boolean, refresh?:boolean,
 *          repo?:string, pkg?:string, ttlMs?:number, now?:number}} opts
 * @returns {Promise<{
 *   ok:boolean, installed:string, latest:string, behind:boolean, status:string,
 *   summary:string, sources:object[], warnings:string[], elapsedMs:number, notes:string
 * }>}
 */
export async function runUpstreamNotes(opts = {}) {
  const started = Date.now();
  const warnings = [];
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const repo = opts.repo ?? DEFAULT_REPO;
  const pkg = opts.pkg ?? DEFAULT_PACKAGE;

  /* --- 本机版本 --- */
  const installed = await detectInstalledVersion(opts);

  /* --- 上游两个来源 --- */
  const sources = [];
  const gh = await fetchTextCached(githubReleasesUrl(repo), {
    cacheDir: opts.cacheDir,
    ttlMs,
    withNetwork: opts.withNetwork,
    refresh: opts.refresh,
  });
  sources.push({
    name: 'github',
    url: gh.url,
    ok: gh.ok,
    source: gh.source,
    error: gh.error,
    version: gh.ok ? parseGithubVersion(gh.text) : '',
    bytes: gh.text?.length ?? 0,
  });

  const npm = await fetchTextCached(npmPackageUrl(pkg), {
    cacheDir: opts.cacheDir,
    ttlMs,
    withNetwork: opts.withNetwork,
    refresh: opts.refresh,
  });
  sources.push({
    name: 'npm',
    url: npm.url,
    ok: npm.ok,
    source: npm.source,
    error: npm.error,
    version: npm.ok ? parseNpmVersion(npm.text) : '',
    bytes: npm.text?.length ?? 0,
  });

  for (const s of sources) {
    if (!s.ok) warnings.push(`${s.name} 读不到：${s.error ?? '未知原因'}`);
  }

  const versions = sources.filter((s) => s.ok && s.version).map((s) => s.version);
  const latest = versions[0] ?? '';
  const anyOk = versions.length > 0;

  let status = 'unknown';
  let behind = false;
  if (anyOk && installed) {
    const cmp = compareVersions(installed, latest);
    behind = cmp < 0;
    status = behind ? 'behind' : 'up-to-date';
  } else if (anyOk) {
    status = 'installed-unknown';
  } else {
    status = 'unknown';
  }

  const summary = anyOk
    ? `本机 DSH ${installed || '（认不出）'} · 上游最新 ${latest} · ${status === 'behind' ? '落后，建议升级' : status === 'up-to-date' ? '已是最新' : '比不了（认不出本机版本）'}`
    : `上游两个来源都没读到${opts.withNetwork === false ? '（未允许联网）' : ''} —— **读不到 ≠ 没有更新**`;

  return {
    ok: anyOk,
    installed,
    latest,
    behind,
    status,
    summary,
    sources,
    warnings,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 认出本机 DSH 版本（优先用主插件的 detectDsh + 缓存；主插件不可用则用自实现的）。
 * @param {object} opts
 * @returns {Promise<string>}
 */
async function detectInstalledVersion(opts) {
  const main = await loadMainPlugin({ mainPluginDir: opts.mainPluginDir });
  if (isUsable(main)) {
    try {
      const h = main.modules.host.detectDsh({
        installDir: opts.installDir,
        pluginsDir: opts.pluginsDir,
        cacheDir: opts.cacheDir,
      });
      if (h.dshVersion) return h.dshVersion;
    } catch { /* 落到自实现 */ }
  }
  try {
    return detectDshLite({ installDir: opts.installDir, cacheDir: opts.cacheDir }).dshVersion ?? '';
  } catch {
    return '';
  }
}

/**
 * 从 GitHub releases 响应里取最新版本号。
 *
 * tag 的形态不止一种：上游打的是 `dsh-v0.2.1-rc.5`，也有人直接用 `v0.2.2`。
 * 前面的 `dsh-` 是仓库自己的版本前缀，去掉它，版本号才能和 semver 对得上。
 *
 * @param {string} text
 * @returns {string}
 */
export function parseGithubVersion(text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return '';
    const rel = arr.find((r) => r && !r.draft && r.tag_name) ?? arr.find((r) => r && r.tag_name);
    if (!rel) return '';
    const tag = String(rel.tag_name ?? rel.name ?? '');
    return tag
      .replace(/^dsh[-_]/i, '')
      .replace(/^v/i, '')
      .trim();
  } catch {
    return '';
  }
}

/**
 * 从 npm registry 响应里取 dist-tags.latest。
 * @param {string} text
 * @returns {string}
 */
export function parseNpmVersion(text) {
  try {
    const obj = JSON.parse(text);
    return obj?.['dist-tags']?.latest ?? '';
  } catch {
    return '';
  }
}
