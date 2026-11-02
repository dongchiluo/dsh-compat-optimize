/**
 * lib/tool.js —— `compat_optimize` 工具的动作实现。
 *
 * 刻意不 import schemastery / dsh-tools：本层要能**脱离 DSH**直接用 node 跑
 * （CLI 就是这么用的），也只有这样自检才能在纯 node 里跑。
 *
 * ## 为什么要再做一个工具，而不是直接用 compat_check
 *
 * `compat_check` 每次都以 **LLM 工具调用**的形态进入会话：每轮都要重发工具 schema
 * （compat_check 的定义 1,198 字符 ≈ 774–950 token），一次体检通常 4–8 轮往返，
 * 每轮 input 40–100K token。它做的事其实全是本地的。
 *
 * 这个工具把同一件事拆成两种用法：
 *   · `run` / `bench` / `status` / `warm` —— **一次性拿全部结论**：
 *     紧凑摘要 + 报告路径 + 报告正文（截断到约 40 行）一次返回，模型不必再追问一轮。
 *   · `bin/compat-check-cli.mjs` —— **完全不经过 LLM**：0 token、可进 CI、可挂定时任务。
 *
 * ## 五个动作
 *
 *   status  缓存状态（纯离线）：asar 头缓存的条目/大小/判活、上游缓存的新鲜度、上一次体检摘要
 *   warm    预热：解析 app.asar 头并写缓存（可选顺带预热上游，默认不联网）
 *   run     跑一次体检（缓存快路径），落盘报告并返回摘要 + 报告正文
 *   bench   连跑 N 次，输出中位/最小/最大耗时（量化优化效果）
 *   notes   查上游版本（缓存优先，TTL 内不联网）
 */

import fs from 'node:fs';
import path from 'node:path';

import { cacheStatus, defaultCacheDir } from './asar-cache.js';
import { listUpstreamCache } from './upstream-cache.js';
import { runCompatCheck, yyyyMmdd } from './check.js';
import { warmCaches } from './warm.js';
import { runUpstreamNotes } from './notes.js';
import { loadMainPlugin, mainPluginVersion } from './main-plugin.js';
import { defaultOutDir, defaultPluginsDir } from './paths.js';

/** 工具支持的动作。 */
export const ACTIONS = ['status', 'warm', 'run', 'bench', 'notes'];

/**
 * 工具描述（宿主每次调用都要重发它，所以写紧凑一点）。
 *
 * 逐个 action 的细节放在**参数的 description** 里（见下面的 PARAMETERS），
 * 宿主会把它投影进每轮请求的 tools[]，所以工具级描述只留「这是什么 + 能干什么」。
 *
 * 实测（2026-11-02，宿主 `ToolRegistry.schemaOf` 的投影口径）：
 *   433 字符 → 工具定义 1463 字符；
 *   186 字符 → 1216 字符；再压到 104 字符 + 参数描述瘦身 434 → 242 → 工具定义 942 字符。
 *   （output.schema 不在投影里，补全它对常驻 token 是 0 成本。）
 */
export const DESCRIPTION = [
  'compat_optimize —— DSH 本地插件兼容性体检快路径（磁盘缓存）。',
  'status 看缓存 | warm 预热 | run 体检+报告正文 | bench 量化耗时 | notes 查上游版本。',
].join('');

/** 工具入参说明（宿主据此渲染 schema）。 */
export const PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: [...ACTIONS],
    description: '要做哪件事：看缓存 / 预热 / 体检 / 计时 / 查上游版本',
  },
  installDir: { type: 'string', description: 'DSH 安装目录（可指到 app.asar，会自动归一化）；缺省自动探测。' },
  pluginsDir: { type: 'string', description: '本地插件目录；缺省取配置。' },
  outDir: { type: 'string', description: '报告落盘目录；缺省取配置。' },
  cacheDir: { type: 'string', description: '缓存目录（与 dsh-compat-check 共用）；缺省取配置。' },
  iterations: { type: 'number', description: 'bench 连跑几次；缺省 5。' },
  refresh: { type: 'boolean', description: '忽略缓存强制回源。' },
  withNetwork: { type: 'boolean', description: '是否允许联网回源；缺省 notes 允许、warm 不允许。' },
  source: { type: 'string', description: '体检来源：plugin（默认，复用 dsh-compat-check）/ optimized / fallback。' },
};

/**
 * 工具入口。
 *
 * @param {string} action ACTIONS 之一
 * @param {object} args 工具入参
 * @param {object} config 部署配置
 * @returns {Promise<object>} 结构化结果（**不抛未捕获异常**）
 */
export async function runAction(action, args = {}, config = {}) {
  const started = Date.now();
  try {
    if (!ACTIONS.includes(action)) {
      return error(`未知 action：${action}（可选 ${ACTIONS.join(' / ')}）`);
    }
    const ctx = resolveContext(args, config);

    switch (action) {
      case 'status': return await doStatus(ctx);
      case 'warm': return await doWarm(ctx);
      case 'run': return await doRun(ctx);
      case 'bench': return await doBench(ctx);
      case 'notes': return await doNotes(ctx);
      default: return error(`未知 action：${action}`);
    }
  } catch (e) {
    return error(`动作 ${action} 执行失败：${e?.message ?? e}`);
  } finally {
    void started;
  }
}

/* ------------------------------------------------------------------ *
 * 上下文：把「入参 > 配置 > 默认」理顺
 * ------------------------------------------------------------------ */
function resolveContext(args = {}, config = {}) {
  const cacheDir = path.resolve(args.cacheDir || config.cacheDir || defaultCacheDir(config.baseDir));
  const pluginsDir = path.resolve(args.pluginsDir || config.pluginsDir || defaultPluginsDir(config.baseDir));
  const outDir = path.resolve(args.outDir || config.outDir || defaultOutDir(config.baseDir));
  const installDir = args.installDir || config.installDir || '';
  const iterations = Number(args.iterations ?? config.iterations ?? 5) || 5;
  const refresh = args.refresh === true || args.refresh === 'true';
  // withNetwork 是三态的：
  //   undefined → 由动作自己定默认值（notes 默认允许回源；warm 默认不联网）
  //   false     → 强制离线
  //   true      → 允许联网
  const net = args.withNetwork;
  const withNetwork = net === undefined || net === null || net === ''
    ? undefined
    : (net === true || net === 'true');
  return {
    cacheDir,
    pluginsDir,
    outDir,
    installDir,
    iterations,
    refresh,
    withNetwork,
    source: args.source || config.source || 'plugin',
    mainPluginDir: config.mainPluginDir,
    notesCacheTtlMs: Number(config.notesCacheTtlMs ?? 6 * 60 * 60 * 1000),
    baseDir: config.baseDir,
  };
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */
async function doStatus(ctx) {
  const status = cacheStatus(ctx.cacheDir);
  const upstream = listUpstreamCache(ctx.cacheDir, { ttlMs: ctx.notesCacheTtlMs });
  const last = readLastRun(ctx.cacheDir);

  const asarLines = status.asarHeader.entries.map((e) => {
    const state = e.valid ? '仍有效' : '已失效';
    let detail;
    if (e.currentSize === null) {
      detail = '（源文件已不在）';
    } else if (e.cachedFingerprint && e.currentFingerprint) {
      detail = e.cachedFingerprint === e.currentFingerprint
        ? `内容指纹一致（${e.currentFingerprint.slice(0, 12)}…）`
        : `内容指纹已变（${e.cachedFingerprint.slice(0, 12)}… → ${e.currentFingerprint.slice(0, 12)}…）`;
    } else {
      detail = `缓存 size=${e.cachedSize}/mtimeMs=${e.cachedMtimeMs} · 现在 size=${e.currentSize}/mtimeMs=${e.currentMtimeMs}`;
    }
    return `  · ${e.asarPath || e.file} —— ${state}（${detail}）`;
  });

  const upstreamLines = upstream.map((u) => {
    const age = Math.round(u.ageMs / 1000);
    return `  · ${u.url} —— ${u.fresh ? '新鲜' : '已过期'}（${age}s 前取到，TTL ${Math.round(u.ttlMs / 1000)}s，${u.bytes} 字节）`;
  });

  const summary = [
    `缓存目录：${ctx.cacheDir}`,
    `asar 头缓存：${status.asarHeader.count} 条 / ${status.asarHeader.bytes} 字节 —— 有效 ${status.asarHeader.valid}，失效 ${status.asarHeader.stale}`,
    ...(asarLines.length ? asarLines : ['  （还没有 asar 头缓存 —— 跑一次 action=warm 就能预热）']),
    `asar 条目缓存：${status.asarEntry.count} 条 / ${status.asarEntry.bytes} 字节`,
    `上游响应缓存：${status.upstream.count} 条 / ${status.upstream.bytes} 字节`,
    ...(upstreamLines.length ? upstreamLines : ['  （还没有上游缓存）']),
    last
      ? `上一次体检：${last.at} · 来源 ${last.source} · ${last.summary?.split('\n')[0] ?? ''}`
      : '上一次体检：（本机还没有记录）',
  ].join('\n');

  return {
    action: 'status',
    ok: true,
    summary,
    offline: true,
    cacheDir: ctx.cacheDir,
    asarHeader: {
      count: status.asarHeader.count,
      bytes: status.asarHeader.bytes,
      valid: status.asarHeader.valid,
      stale: status.asarHeader.stale,
      entries: status.asarHeader.entries,
    },
    asarEntry: status.asarEntry,
    upstream: { count: status.upstream.count, bytes: status.upstream.bytes, entries: upstream },
    lastRun: last,
    reportExcerpt: '',
    reportPath: '',
    warnings: [],
  };
}

/* ------------------------------------------------------------------ *
 * warm
 * ------------------------------------------------------------------ */
async function doWarm(ctx) {
  // 预热上游默认**不联网**：没人要求时不该偷偷发两个请求。
  const withNetwork = ctx.withNetwork === true;
  const r = await warmCaches({
    installDir: ctx.installDir,
    cacheDir: ctx.cacheDir,
    withNetwork,
    refresh: ctx.refresh,
    ttlMs: ctx.notesCacheTtlMs,
  });

  const entryHits = r.entries.filter((e) => e.cached).length;
  const summary = [
    `预热完成：${r.elapsedMs} ms`,
    `asar 头：${r.header.cached ? '已命中（跳过解析）' : r.header.parsed ? '解析并写入缓存' : '未完成'}${r.header.bytes ? `（${r.header.bytes} 字节）` : ''}`,
    `asar 条目：${entryHits}/${r.entries.length} 个已缓存`,
    `上游：${withNetwork ? `${r.upstream.filter((u) => u.ok).length}/${r.upstream.length} 个已缓存` : '未预热（默认不联网）'}`,
  ].join('\n');

  return {
    action: 'warm',
    ok: r.ok,
    summary,
    asarPath: r.asarPath,
    // 找不到宿主时 warm.js 给 null；output schema 声明的是 string，这里归一成空串，
    // 否则宿主的 additionalProperties/type 校验会直接判整次调用失败。
    installDir: r.installDir ?? '',
    header: r.header,
    entries: r.entries,
    upstream: r.upstream,
    elapsedMs: r.elapsedMs,
    reportExcerpt: '',
    reportPath: '',
    warnings: r.warnings,
  };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */
async function doRun(ctx) {
  const r = await runCompatCheck({
    installDir: ctx.installDir,
    pluginsDir: ctx.pluginsDir,
    cacheDir: ctx.cacheDir,
    outDir: ctx.outDir,
    source: ctx.source,
    mainPluginDir: ctx.mainPluginDir,
    refresh: ctx.refresh,
  });

  writeLastRun(ctx.cacheDir, {
    at: new Date().toISOString(),
    source: r.source,
    summary: r.summary,
    stats: r.stats,
    dshVersion: r.dshVersion,
    reportPath: r.reportPath,
    elapsedMs: r.elapsedMs,
  });

  return {
    action: 'run',
    ok: r.ok,
    summary: r.summary,
    source: r.source,
    sourceDetail: r.sourceDetail,
    reportPath: r.reportPath,
    reportExcerpt: excerpt(r.report, 40),
    stats: r.stats,
    dshVersion: r.dshVersion,
    pluginsDir: r.pluginsDir,
    elapsedMs: r.elapsedMs,
    mainPluginVersion: r.mainPluginVersion,
    warnings: r.warnings,
    error: r.error ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * bench
 * ------------------------------------------------------------------ */
async function doBench(ctx) {
  const n = Math.max(1, Math.min(50, ctx.iterations));
  const times = [];
  let last = null;
  for (let i = 0; i < n; i += 1) {
    const r = await runCompatCheck({
      installDir: ctx.installDir,
      pluginsDir: ctx.pluginsDir,
      cacheDir: ctx.cacheDir,
      outDir: ctx.outDir,
      source: ctx.source,
      mainPluginDir: ctx.mainPluginDir,
      refresh: ctx.refresh,
      writeReport: i === n - 1,     // 只有最后一次落盘
    });
    times.push(r.elapsedMs);
    last = r;
  }

  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  const summary = [
    `连跑 ${n} 次：中位 ${median} ms · 最小 ${sorted[0]} ms · 最大 ${sorted[sorted.length - 1]} ms`,
    `每次耗时：${times.join(' / ')} ms`,
    `来源：${last?.source ?? '?'} —— ${last?.sourceDetail ?? ''}`,
    `体检结论：${last?.summary?.split('\n')[0] ?? ''}`,
  ].join('\n');

  return {
    action: 'bench',
    ok: last?.ok ?? false,
    summary,
    iterations: n,
    medianMs: median,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    timesMs: times,
    source: last?.source ?? '',
    sourceDetail: last?.sourceDetail ?? '',
    stats: last?.stats ?? {},
    reportPath: last?.reportPath ?? '',
    reportExcerpt: excerpt(last?.report ?? '', 40),
    elapsedMs: times.reduce((a, b) => a + b, 0),
    warnings: last?.warnings ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * notes
 * ------------------------------------------------------------------ */
async function doNotes(ctx) {
  const r = await runUpstreamNotes({
    installDir: ctx.installDir,
    pluginsDir: ctx.pluginsDir,
    cacheDir: ctx.cacheDir,
    withNetwork: ctx.withNetwork,
    refresh: ctx.refresh,
    ttlMs: ctx.notesCacheTtlMs,
    mainPluginDir: ctx.mainPluginDir,
  });

  return {
    action: 'notes',
    ok: r.ok,
    summary: r.summary,
    installed: r.installed,
    latest: r.latest,
    behind: r.behind,
    status: r.status,
    sources: r.sources,
    reportExcerpt: '',
    reportPath: '',
    elapsedMs: r.elapsedMs,
    warnings: r.warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 统一错误返回。 */
function error(message) {
  return {
    action: 'unknown',
    ok: false,
    error: message,
    summary: `执行失败：${message}`,
    reportExcerpt: '',
    reportPath: '',
    stats: { plugins: 0, ok: 0, stale: 0, shadowed: 0, broken: 0 },
    warnings: [message],
  };
}

/** 截取报告前 N 行。 */
function excerpt(text, lines = 40) {
  return String(text || '').split(/\r?\n/).slice(0, lines).join('\n');
}

/** 「上一次体检摘要」落盘位置（放在缓存根目录下的 last-run.json，与主插件互不干扰）。 */
function lastRunPath(cacheDir) {
  return path.join(cacheDir, 'last-run.json');
}

function writeLastRun(cacheDir, data) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(lastRunPath(cacheDir), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 写不了不影响主流程 */ }
}

function readLastRun(cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(lastRunPath(cacheDir), 'utf8'));
  } catch {
    return null;
  }
}

export { loadMainPlugin, mainPluginVersion, yyyyMmdd };
