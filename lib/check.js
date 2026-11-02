/**
 * lib/check.js —— 体检编排层：决定走哪条「体检逻辑」，并统一出报告。
 *
 * ## 体检逻辑来自哪里
 *
 * **默认直接复用主插件 `dsh-compat-check` 0.3.0 的 `lib/tool.js`** ——
 * 也就是说，CLI 与 `compat_check` 工具跑的是**同一份判定代码**，
 * 缓存目录也共用同一个（`<baseDir>/.cache/compat-check/`），两边互不失效。
 * 不另写一份体检逻辑，是刻意的：两份判定逻辑迟早会分叉，分叉之后
 * 「CLI 说全绿、插件说有问题」就没人说得清是谁错了。
 *
 * 三条来源（source）：
 *
 *   plugin（默认）
 *     调主插件的 `runAction('check', ...)`，并把 `cacheDir` 传进去 ——
 *     主插件 0.3.0 的 `detectDsh` 已支持 `cacheDir`，于是 asar 头走磁盘缓存，
 *     不再每次重新解析 4.76 MB 的 JSON。
 *
 *   optimized
 *     主插件的 `lib/tool.js` 不可用（但 host/plugins/report 还在）时的等价路径：
 *     同样是主插件的模块，只是自己拼一遍 detectDsh → checkPlugins → renderReport。
 *
 *   fallback
 *     主插件整个不在时的自实现兜底（见 fallback-check.js），
 *     输出里明确标注 `source: "fallback"`，不假装是主插件的结论。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadMainPlugin, isUsable, mainPluginVersion } from './main-plugin.js';
import {
  checkPluginsFallback,
  detectDshLite,
  renderFallbackReport,
  renderFallbackSummary,
} from './fallback-check.js';
import { defaultCacheDir, invalidateAsarCaches } from './asar-cache.js';
import { normalizeInstallDir } from './asar-reader.js';

/** 体检来源。 */
export const SOURCES = ['plugin', 'optimized', 'fallback'];

/**
 * 今天的日期串（本地时区），用于报告文件名。
 * @param {Date} [d]
 * @returns {string}
 */
export function yyyyMmdd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 报告默认落盘路径：`<outDir>/compat-report-<yyyy-mm-dd>.md`。
 * @param {string} outDir
 * @param {Date} [d]
 * @returns {string}
 */
export function defaultReportPath(outDir, d = new Date()) {
  return path.resolve(outDir, `compat-report-${yyyyMmdd(d)}.md`);
}

/**
 * 跑一次体检。
 *
 * @param {{
 *   installDir?:string, pluginsDir:string, cacheDir?:string, outDir?:string,
 *   source?:string, mainPluginDir?:string, include?:string[], writeReport?:boolean,
 *   refresh?:boolean
 * }} opts
 * @returns {Promise<{
 *   ok:boolean, source:string, sourceDetail:string, summary:string, report:string,
 *   reportPath:string, stats:object, dshVersion:string, pluginsDir:string,
 *   warnings:string[], elapsedMs:number, mainPluginVersion:string
 * }>}
 */
export async function runCompatCheck(opts = {}) {
  const started = Date.now();
  const pluginsDir = path.resolve(opts.pluginsDir ?? '.');
  const cacheDir = path.resolve(opts.cacheDir ?? defaultCacheDir());
  const outDir = opts.outDir ? path.resolve(opts.outDir) : null;
  const requested = SOURCES.includes(opts.source) ? opts.source : 'plugin';

  if (!fs.existsSync(pluginsDir)) {
    return errorResult({
      requested,
      pluginsDir,
      cacheDir,
      elapsedMs: Date.now() - started,
      message: `pluginsDir 不存在：${pluginsDir}`,
    });
  }

  /* --- refresh：把 asar 缓存清掉，逼它重新解析 --- */
  if (opts.refresh) {
    try {
      const asarPath = findAsarPath(opts.installDir);
      if (asarPath) invalidateAsarCaches(asarPath, { cacheDir });
    } catch { /* 清不掉缓存不算致命错误 */ }
  }

  const main = await loadMainPlugin({ mainPluginDir: opts.mainPluginDir });

  let result;
  if (requested === 'fallback') {
    result = runFallback({ ...opts, pluginsDir, cacheDir, outDir, mainError: '调用方指定了 fallback' });
  } else if (requested === 'optimized') {
    result = isUsable(main)
      ? runOptimized(main, { ...opts, pluginsDir, cacheDir, outDir })
      : runFallback({ ...opts, pluginsDir, cacheDir, outDir, mainError: main.error });
  } else if (isUsable(main) && main.modules.tool?.runAction) {
    result = runViaMainPlugin(main, { ...opts, pluginsDir, cacheDir, outDir });
  } else if (isUsable(main)) {
    result = runOptimized(main, { ...opts, pluginsDir, cacheDir, outDir });
  } else {
    result = runFallback({ ...opts, pluginsDir, cacheDir, outDir, mainError: main.error });
  }

  result.elapsedMs = Date.now() - started;

  /* --- 落盘报告（主插件自己写过就不重复写） --- */
  if (outDir && opts.writeReport !== false && result.report && !result.reportPath) {
    const reportPath = defaultReportPath(outDir);
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, result.report, 'utf8');
      result.reportPath = reportPath;
    } catch (e) {
      result.warnings.push(`报告落盘失败（${reportPath}）：${e?.message ?? e}`);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * plugin（默认）：直接调主插件 runAction
 * ------------------------------------------------------------------ */
function runViaMainPlugin(main, ctx) {
  try {
    const r = main.modules.tool.runAction('check', {
      installDir: ctx.installDir,
      // 主插件把报告写到 <outDir>/<args.report>
      report: `compat-report-${yyyyMmdd()}.md`,
    }, {
      pluginsDir: ctx.pluginsDir,
      cacheDir: ctx.cacheDir,
      outDir: ctx.outDir ?? undefined,
      baseDir: path.dirname(ctx.pluginsDir),
    });
    return {
      ok: !!r.ok,
      source: 'plugin',
      sourceDetail: `直接调用 ${main.dir}/lib/tool.js 的 runAction('check')（cacheDir=${ctx.cacheDir}）`,
      summary: r.summary ?? '',
      report: r.reportExcerpt ?? '',
      reportPath: r.reportPath ?? '',
      stats: r.stats ?? {},
      dshVersion: r.dshVersion ?? '',
      pluginsDir: r.pluginsDir ?? ctx.pluginsDir,
      warnings: r.warnings ?? [],
      mainPluginVersion: mainPluginVersion(main.dir),
    };
  } catch (e) {
    const fb = runFallback({ ...ctx, mainError: `runAction 失败：${e?.message ?? e}` });
    fb.sourceDetail = `${fb.sourceDetail}（runAction 失败：${e?.message ?? e}）`;
    return fb;
  }
}

/* ------------------------------------------------------------------ *
 * optimized：主插件 tool.js 不可用时的等价路径（同样用主插件的模块）
 * ------------------------------------------------------------------ */
function runOptimized(main, ctx) {
  const { host, plugins, report } = main.modules;
  try {
    const detected = host.detectDsh({
      installDir: ctx.installDir,
      pluginsDir: ctx.pluginsDir,
      cacheDir: ctx.cacheDir,        // ← 关键：这一行就是省时间的那一行
    });
    const scan = plugins.checkPlugins({
      pluginsDir: ctx.pluginsDir,
      host: detected,
      include: ctx.include?.length ? ctx.include : undefined,
      stopAt: ctx.pluginsDir,
    });
    const plans = plugins.planUpgrades(ctx.pluginsDir, scan, detected);
    const body = report.renderReport({ host: detected, scan, plans });
    const summary = report.renderSummary({ host: detected, scan, plans });

    return {
      ok: scan.summary.broken === 0,
      source: 'optimized',
      sourceDetail: `复用 ${main.dir} 的 host/plugins/report 模块，detectDsh 带 cacheDir=${ctx.cacheDir}`,
      summary,
      report: body,
      reportPath: '',
      stats: {
        plugins: scan.summary.total,
        ok: scan.summary.ok,
        stale: scan.summary.stale,
        shadowed: scan.summary.shadowed,
        broken: scan.summary.broken,
      },
      dshVersion: detected.dshVersion ?? '',
      pluginsDir: ctx.pluginsDir,
      warnings: [
        ...(detected.warnings ?? []),
        ...scan.findings.flatMap((f) => f.issues.filter((i) => i.level !== 'ok').map((i) => `${f.name}：${i.text}`)),
      ],
      mainPluginVersion: mainPluginVersion(main.dir),
    };
  } catch (e) {
    const fb = runFallback({ ...ctx, mainError: `optimized 路径出错：${e?.message ?? e}` });
    fb.sourceDetail = `${fb.sourceDetail}（optimized 路径失败：${e?.message ?? e}）`;
    return fb;
  }
}

/* ------------------------------------------------------------------ *
 * fallback：自实现等价检查
 * ------------------------------------------------------------------ */
function runFallback(ctx, mainError = null) {
  try {
    const host = detectDshLite({ installDir: ctx.installDir, cacheDir: ctx.cacheDir });
    const scan = checkPluginsFallback({
      pluginsDir: ctx.pluginsDir,
      host,
      include: ctx.include?.length ? ctx.include : undefined,
      stopAt: ctx.pluginsDir,
    });
    return {
      ok: scan.summary.broken === 0,
      source: 'fallback',
      sourceDetail: `自实现等价检查（主插件不可用${mainError ? `：${mainError}` : ''}）`,
      summary: renderFallbackSummary({ host, scan }),
      report: renderFallbackReport({ host, scan }),
      reportPath: '',
      stats: {
        plugins: scan.summary.total,
        ok: scan.summary.ok,
        stale: scan.summary.stale,
        shadowed: scan.summary.shadowed,
        broken: scan.summary.broken,
      },
      dshVersion: host.dshVersion ?? '',
      pluginsDir: ctx.pluginsDir,
      warnings: host.warnings ?? [],
      mainPluginVersion: '',
    };
  } catch (e) {
    return errorResult({
      requested: 'fallback',
      pluginsDir: ctx.pluginsDir,
      cacheDir: ctx.cacheDir,
      elapsedMs: 0,
      message: `体检失败：${e?.message ?? e}`,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 找 app.asar 的路径（installDir 可以指到文件，会自动归一化）。 */
function findAsarPath(installDir) {
  const dir = normalizeInstallDir(installDir);
  if (!dir) return '';
  const p = path.join(dir, 'resources', 'app.asar');
  try {
    return fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

/**
 * 统一错误返回：任何一步失败都返回结构化结果，不抛未捕获异常
 */
function errorResult({ requested, pluginsDir, cacheDir, elapsedMs, message }) {
  return {
    ok: false,
    error: message,
    source: 'fallback',
    sourceDetail: `请求的来源是 ${requested}，但没能跑起来`,
    summary: `体检失败：${message}`,
    report: `# 体检失败\n\n${message}\n`,
    reportPath: '',
    stats: { plugins: 0, ok: 0, stale: 0, shadowed: 0, broken: 0 },
    dshVersion: '',
    pluginsDir,
    cacheDir,
    warnings: [message],
    elapsedMs,
    mainPluginVersion: '',
  };
}
