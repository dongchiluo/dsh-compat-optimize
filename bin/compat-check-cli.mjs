#!/usr/bin/env node
/**
 * bin/compat-check-cli.mjs —— 兼容性体检的**离线 CLI**。
 *
 * ## 为什么要有它
 *
 * `compat_check` 是个 LLM 工具：每次调用都要重发工具 schema，一次体检往往 4–8 轮往返，
 * 每轮 input 40–100K token。**而它做的事全是本地的** —— 这部分 token 是纯浪费。
 *
 * 这个 CLI 把同一件事搬出 LLM：
 *   · **0 token**：不经过模型，直接 node 跑；
 *   · **可进 CI / 定时任务**：退出码即结论（0 正常 / 1 有 broken 插件 / 2 运行错误）；
 *   · **走同一套缓存**：asar 头解析结果落盘，重复跑是毫秒级。
 *
 * ## 体检逻辑来自哪里
 *
 * **直接复用主插件 `dsh-compat-check` 的 `lib/tool.js`**（运行时用
 * `pathToFileURL` 动态 import 同级兄弟目录 `../../dsh-compat-check/lib/tool.js`）——
 * CLI 与 `compat_check` 工具跑的是同一份判定代码、共用同一个缓存目录，
 * 不另写一份体检逻辑。主插件整个不在时，退化为自实现的等价检查并标注 `source: "fallback"`。
 *
 * ## 用法
 *
 *   node bin/compat-check-cli.mjs [子命令] [选项]
 *
 *   子命令（可省，默认 check）：
 *     check              跑一次体检（默认）
 *     status             只看缓存状态（纯离线）
 *     warm               只预热缓存
 *     notes              查上游 DSH 版本
 *     bench              连跑 N 次并输出耗时统计
 *
 *   --plugins-dir <dir>   插件目录（默认 <baseDir>/plugins）
 *   --install-dir <dir>   DSH 安装目录（可以指到 resources/app.asar 文件，会自动归一化）
 *   --out-dir <dir>       报告落盘目录（默认 <baseDir>/out/compat）
 *   --cache-dir <dir>     缓存目录（默认 <baseDir>/.cache/compat-check）
 *
 *   <baseDir> 取 $DSH_COMPAT_BASE_DIR / $DSH_HOME / 用户主目录 —— 不写死任何本机路径。
 *   --json                输出机器可读 JSON（不打印人话）
 *   --warm                先预热缓存再体检（会解析一次 app.asar 头）
 *   --network             允许联网（只影响 --warm 的上游预热与 --notes 的回源）
 *   --bench [N]           连跑 N 次并输出耗时统计（默认 5）
 *   --notes               查上游 DSH 版本（缓存优先；未命中时回源，除非 --offline）
 *   --refresh             忽略缓存强制回源（联网）
 *   --source <s>          体检逻辑来源：plugin（默认，复用 dsh-compat-check 的 runAction）| optimized | fallback
 *   --offline             强制不联网（覆盖 --network）
 *   --help                打印这份说明
 *
 * ## 退出码
 *
 *   0  体检跑完了，没有 broken 插件
 *   1  有 broken 插件（宿主闸门不过 / 包读不了 —— DSH 会跳过这些插件）
 *   2  运行错误（插件目录不存在、读不到 asar、报告写不出来等）
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAction } from '../lib/tool.js';
import { defaultCacheDir } from '../lib/asar-cache.js';
import { defaultOutDir, defaultPluginsDir } from '../lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 可用的子命令。 */
export const COMMANDS = ['check', 'status', 'warm', 'notes', 'bench'];

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const opts = {
    command: 'check',
    pluginsDir: '',
    installDir: '',
    outDir: '',
    cacheDir: '',
    json: false,
    warm: false,
    network: false,
    bench: 0,
    notes: false,
    refresh: false,
    source: 'plugin',
    offline: false,
    help: false,
  };
  const rest = [...argv];
  const next = (name) => {
    const v = rest.shift();
    if (v === undefined) throw new Error(`参数 ${name} 后面缺值`);
    return v;
  };

  while (rest.length) {
    const a = rest.shift();
    // 位置参数：第一个非 -- 开头的词当子命令。
    if (!a.startsWith('-')) {
      if (!COMMANDS.includes(a)) throw new Error(`未知子命令：${a}（可选 ${COMMANDS.join(' / ')}）`);
      opts.command = a;
      if (a === 'notes') opts.notes = true;
      if (a === 'bench' && opts.bench === 0) opts.bench = 5;
      continue;
    }
    switch (a) {
      case '--plugins-dir': case '--plugins': opts.pluginsDir = next(a); break;
      case '--install-dir': case '--install': opts.installDir = next(a); break;
      case '--out-dir': case '--out': opts.outDir = next(a); break;
      case '--cache-dir': case '--cache': opts.cacheDir = next(a); break;
      case '--source': opts.source = next(a); break;
      case '--json': opts.json = true; break;
      case '--warm': opts.warm = true; break;
      case '--network': opts.network = true; break;
      case '--offline': opts.offline = true; break;
      case '--refresh': opts.refresh = true; break;
      case '--notes': opts.notes = true; break;
      case '--bench': {
        const v = rest[0];
        if (v !== undefined && !v.startsWith('-')) opts.bench = Number(next(a));
        else opts.bench = 5;
        break;
      }
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`未知参数：${a}`);
    }
  }
  return opts;
}

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`参数错误：${e?.message ?? e}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const cacheDir = path.resolve(opts.cacheDir || defaultCacheDir());
  const pluginsDir = path.resolve(opts.pluginsDir || defaultPluginsDir());
  const outDir = path.resolve(opts.outDir || defaultOutDir());
  // 联网策略：
  //   --offline            → 一律不联网
  //   --network/--refresh  → 允许联网
  //   --notes              → 允许联网（查上游本来就是要走网络的；除非 --offline）
  //   其它                 → undefined = 由动作自己定（warm 默认不联网）
  const withNetwork = opts.offline ? false : (opts.network || opts.refresh || opts.notes ? true : undefined);

  const config = {
    cacheDir,
    pluginsDir,
    outDir,
    installDir: opts.installDir,
    source: opts.source,
    notesCacheTtlMs: 6 * 60 * 60 * 1000,
  };

  const out = { ok: true, command: opts.command };

  try {
    /* --- 可选：预热 --- */
    let warm = null;
    if (opts.warm && opts.command !== 'warm') {
      warm = await runAction('warm', {
        cacheDir,
        installDir: opts.installDir,
        withNetwork,
        refresh: opts.refresh,
      }, config);
      if (!opts.json) {
        process.stdout.write(`${warm.summary}\n`);
      }
    }

    /* --- status --- */
    if (opts.command === 'status') {
      const status = await runAction('status', { cacheDir }, config);
      out.status = status;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } else {
        process.stdout.write(`${status.summary}\n`);
      }
      return status.ok === false ? 2 : 0;
    }

    /* --- warm --- */
    if (opts.command === 'warm') {
      const w = await runAction('warm', {
        cacheDir,
        installDir: opts.installDir,
        withNetwork,
        refresh: opts.refresh,
      }, config);
      out.warm = w;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(w, null, 2)}\n`);
      } else {
        process.stdout.write(`${w.summary}\n`);
        for (const x of w.warnings ?? []) process.stdout.write(`提示：${x}\n`);
      }
      return w.ok === false ? 2 : 0;
    }

    /* --- notes --- */
    if (opts.notes) {
      const notes = await runAction('notes', {
        cacheDir,
        installDir: opts.installDir,
        withNetwork,
        refresh: opts.refresh,
      }, config);
      out.notes = notes;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(notes, null, 2)}\n`);
      } else {
        process.stdout.write(`${notes.summary}\n`);
        for (const s of notes.sources ?? []) {
          process.stdout.write(`  · ${s.name}：${s.ok ? `${s.version}（${s.source === 'cache' ? '命中缓存' : '联网'}）` : `读不到 —— ${s.error}`}\n`);
        }
        process.stdout.write(`耗时：${notes.elapsedMs} ms\n`);
      }
      if (!notes.ok && (opts.network || opts.refresh)) {
        process.stderr.write('上游没读到 —— 这不等于「没有更新」。\n');
        return 2;
      }
      return 0;
    }

    /* --- bench --- */
    if (opts.command === 'bench' || opts.bench > 0) {
      const bench = await runAction('bench', {
        cacheDir,
        installDir: opts.installDir,
        pluginsDir,
        outDir,
        iterations: opts.bench > 0 ? opts.bench : 5,
        refresh: opts.refresh,
      }, config);
      out.bench = bench;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(bench, null, 2)}\n`);
      } else {
        process.stdout.write(`${bench.summary}\n`);
        if (bench.reportPath) process.stdout.write(`报告已落盘：${bench.reportPath}\n`);
      }
      if ((bench.stats?.broken ?? 0) > 0) return 1;
      return bench.ok === false ? 2 : 0;
    }

    /* --- check（默认） --- */
    const run = await runAction('run', {
      cacheDir,
      installDir: opts.installDir,
      pluginsDir,
      outDir,
      refresh: opts.refresh,
    }, config);
    out.run = run;
    if (warm) out.warm = warm;

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      process.stdout.write(`${run.summary}\n`);
      if (run.sourceDetail) process.stdout.write(`来源：${run.source} —— ${run.sourceDetail}\n`);
      process.stdout.write(`耗时：${run.elapsedMs} ms\n`);
      if (run.reportPath) process.stdout.write(`报告已落盘：${run.reportPath}\n`);
      if (run.reportExcerpt) {
        process.stdout.write(`${run.reportExcerpt}\n`);
      }
      for (const w of run.warnings ?? []) process.stdout.write(`提示：${w}\n`);
    }

    if (run.error) return 2;
    if ((run.stats?.broken ?? 0) > 0) return 1;
    return 0;
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    } else {
      process.stderr.write(`运行错误：${msg}\n`);
    }
    return 2;
  }
}

/** 帮助文本。 */
const HELP = `
compat-check-cli —— DSH 本地插件兼容性体检（离线 CLI，0 token）

用法：
  node bin/compat-check-cli.mjs [子命令] [选项]

子命令（可省，默认 check）：
  check              跑一次体检
  status             只看缓存状态（纯离线）
  warm               只预热缓存
  notes              查上游 DSH 版本
  bench              连跑 N 次并输出耗时统计

选项：
  --plugins-dir <dir>   插件目录（默认 <baseDir>/plugins）
  --install-dir <dir>   DSH 安装目录（可指到 resources/app.asar 文件，会自动归一化）
  --out-dir <dir>       报告落盘目录（默认 <baseDir>/out/compat）
  --cache-dir <dir>     缓存目录（默认 <baseDir>/.cache/compat-check）
  --json                输出机器可读 JSON
  --warm                先预热缓存再体检
  --network             允许联网（只影响上游预热与 --notes 回源）
  --bench [N]           连跑 N 次并输出耗时统计（默认 5）
  --notes               查上游 DSH 版本（缓存优先；未命中时回源，除非 --offline）
  --refresh             忽略缓存强制回源（联网）
  --source <s>          plugin（默认，复用 dsh-compat-check 的 runAction）| optimized | fallback
  --offline             强制不联网
  --help                打印这份说明

退出码：0 = 没有 broken 插件；1 = 有 broken 插件；2 = 运行错误
`.trim();

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    process.stderr.write(`运行错误：${e?.message ?? e}\n`);
    process.exitCode = 2;
  });
}

export { HERE };
