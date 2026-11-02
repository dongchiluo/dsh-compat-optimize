#!/usr/bin/env node
/**
 * _selftest.mjs —— 离线自检（不联网、不需要 LLM）。
 *
 * 覆盖四件必须成立的事：
 *   (a) asar 头缓存写 → 读命中；
 *   (b) 归档**内容**变了 → 缓存失效（按内容指纹判活，不能拿旧缓存糊弄新版本）；
 *       只改 mtimeMs、内容没变 → 仍然命中（stat 判活在宿主里不可靠）。
 *   (c) 上游缓存 TTL 到点就失效（用注入的 now 验证，不靠真的等 6 小时）；
 *   (d) 工具的五个 action 都能跑，且返回结构正确（notes 走预置缓存，全程离线）。
 *
 * 跑法：node _selftest.mjs      退出码 0 = 全过，1 = 有 FAIL。
 *
 * 临时产物写在系统临时目录下的 dsh-compat-optimize-selftest（可用
 * DSH_COMPAT_OPTIMIZE_TMPDIR 覆盖），不往插件目录里落垃圾。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  asarHeaderCachePath,
  cacheStatus,
  invalidateAsarCache,
  readAsarEntryCache,
  readAsarHeaderCache,
  readAsarHeaderCached,
  readAsarJsonCached,
  sha1,
  statOf,
  writeAsarEntryCache,
  writeAsarHeaderCache,
} from './lib/asar-cache.js';
import {
  readUpstreamCache,
  writeUpstreamCache,
  DEFAULT_TTL_MS,
} from './lib/upstream-cache.js';
import { runAction, ACTIONS } from './lib/tool.js';
import { githubReleasesUrl, npmPackageUrl } from './lib/upstream.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.resolve(
  process.env.DSH_COMPAT_OPTIMIZE_TMPDIR || path.join(os.tmpdir(), 'dsh-compat-optimize-selftest'),
);

let pass = 0;
let fail = 0;
let skipped = 0;

/**
 * 记一条断言结果。
 * @param {boolean} ok
 * @param {string} name
 * @param {string} [detail]
 */
function check(ok, name, detail = '') {
  if (ok) {
    pass += 1;
    process.stdout.write(`PASS  ${name}${detail ? ` —— ${detail}` : ''}\n`);
  } else {
    fail += 1;
    process.stdout.write(`FAIL  ${name}${detail ? ` —— ${detail}` : ''}\n`);
  }
}

/**
 * 记一条「环境不具备、如实跳过」的断言。
 * @param {string} name
 * @param {string} [detail]
 */
function skip(name, detail = '') {
  skipped += 1;
  process.stdout.write(`SKIP  ${name}${detail ? ` —— ${detail}` : ''}\n`);
}

/* ------------------------------------------------------------------ *
 * 造一个最小的合成 asar
 * ------------------------------------------------------------------ */

/**
 * @param {{path:string, files:Record<string,string>}} spec
 * @returns {string} asar 路径
 */
function makeAsar(spec) {
  const files = {};
  let offset = 0;
  const datas = [];
  for (const [inner, content] of Object.entries(spec.files)) {
    const buf = Buffer.from(content, 'utf8');
    const segs = inner.split('/');
    let node = files;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      node[seg] = node[seg] ?? { files: {} };
      node = node[seg].files;
    }
    node[segs[segs.length - 1]] = { size: buf.length, offset: String(offset) };
    datas.push(buf);
    offset += buf.length;
  }

  const header = { files };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad, 0)]);
  const headerSize = 8 + jsonPadded.length;

  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(4 + jsonPadded.length, 8);
  head.writeUInt32LE(jsonPadded.length, 12);

  fs.mkdirSync(path.dirname(spec.path), { recursive: true });
  fs.writeFileSync(spec.path, Buffer.concat([head, jsonPadded, ...datas]));
  return spec.path;
}

/* ------------------------------------------------------------------ *
 * (a)(b) asar 头缓存
 * ------------------------------------------------------------------ */
function testAsarHeaderCache(cacheDir) {
  const asarPath = makeAsar({
    path: path.join(TMP, 'synthetic', 'app.asar'),
    files: {
      'dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }),
      'dsh/node_modules/@deepseek-ai/dsh-tools/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.1-rc.5' }),
    },
  });

  // 清掉可能残留的旧缓存
  invalidateAsarCache(asarPath, { cacheDir });

  const stat = statOf(asarPath);
  const parsed = readAsarHeaderCached(asarPath, { cacheDir });
  check(parsed.ok && parsed.parsed === true, 'asar 头：未命中时能现解析', `parsed=${parsed.parsed}`);
  check(!!parsed.header?.files?.dsh, 'asar 头：内容解析正确');

  const file = asarHeaderCachePath(asarPath, cacheDir);
  check(fs.existsSync(file), 'asar 头：缓存文件已落盘', path.relative(TMP, file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(
    onDisk.formatVersion === 2
      && onDisk.asarPath === path.resolve(asarPath)
      && onDisk.size === stat.size
      && onDisk.mtimeMs === stat.mtimeMs
      && typeof onDisk.fingerprint === 'string'
      && /^[0-9a-f]{40}$/.test(onDisk.fingerprint)
      && !!onDisk.header
      && typeof onDisk.header === 'object',
    'asar 头：磁盘格式与主插件契约一致（formatVersion/asarPath/size/mtimeMs/fingerprint/header）',
    JSON.stringify({ formatVersion: onDisk.formatVersion, size: onDisk.size, mtimeMs: onDisk.mtimeMs, fingerprint: onDisk.fingerprint }),
  );
  check(
    path.basename(file) === `${sha1(path.resolve(asarPath))}.json`,
    'asar 头：文件名是 sha1(resolve(asarPath))',
  );

  // (a) 命中
  const hit = readAsarHeaderCache(asarPath, { cacheDir });
  check(hit.hit === true && !!hit.header?.files?.dsh, 'asar 头：写 → 读命中');

  // (b1) 只改 mtimeMs、内容没变 → **仍然命中**。
  // 判活看的是内容指纹，不是 stat：宿主进程里 app.asar 的 stat 是合成的
  // （size=0、mtime=进程启动时刻），拿 stat 判活会让磁盘缓存永远失效。
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(asarPath, future, future);
  const stillHit = readAsarHeaderCache(asarPath, { cacheDir });
  check(stillHit.hit === true, 'asar 头：只改 mtimeMs、内容没变 → 仍然命中（按内容指纹判活）', stillHit.reason ?? '');

  // (b2) 内容变了（追加一个字节）→ 指纹变 → 失效
  fs.appendFileSync(asarPath, Buffer.from('x'));
  const stale2 = readAsarHeaderCache(asarPath, { cacheDir });
  check(stale2.hit === false, 'asar 头：内容变了 → 缓存失效', stale2.reason ?? '');

  // 缓存状态里要能看出「这条已经失效」——
  // 注意这条断言必须放在 readAsarJsonCached 之前：后者在缓存失效时会现解析并
  // **重写**头缓存（新 stat），写完就又变回 valid 了。
  const statusStale = cacheStatus(cacheDir);
  check(
    statusStale.asarHeader.entries.some((e) => e.valid === false),
    '缓存状态：能标出已失效的条目',
    `valid=${statusStale.asarHeader.valid} / stale=${statusStale.asarHeader.stale}`,
  );

  // (c) 模拟宿主的「合成 stat」。
  // DSH 桌面端是 Electron 跑的，Electron 把 .asar 当虚拟目录接管，
  // 于是进程内 `fs.statSync(app.asar)` 返回 size=0、mtime=进程启动时刻 ——
  // 拿 size+mtime 判活，磁盘缓存每次都被判成过期，优化 1 等于白做。
  // 这里把 statSync 换成宿主语义，验证判活走的是内容指纹。
  const rewritten = readAsarHeaderCached(asarPath, { cacheDir });
  check(rewritten.hit === false && rewritten.parsed === true,
    'asar 头：内容变了之后现解析并重写缓存（先有一份新缓存再测宿主语义）');
  const realStatSync = fs.statSync;
  const asarKey = path.resolve(asarPath).toLowerCase();
  fs.statSync = function patched(p, ...rest) {
    if (String(p).toLowerCase() === asarKey) {
      return { size: 0, mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false };
    }
    return realStatSync.call(fs, p, ...rest);
  };
  try {
    const underSim = readAsarHeaderCache(asarPath, { cacheDir });
    check(underSim.hit === true,
      'asar 头：宿主式合成 stat 下仍然命中（判活靠内容指纹，不靠 stat）', underSim.reason ?? '');
    const statusSim = cacheStatus(cacheDir);
    check(statusSim.asarHeader.valid >= 1 && statusSim.asarHeader.stale === 0,
      '缓存状态：合成 stat 下仍显示「有效」',
      `valid=${statusSim.asarHeader.valid} / stale=${statusSim.asarHeader.stale}`);
  } finally {
    fs.statSync = realStatSync;
  }

  // 条目缓存
  const buf = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.1-rc.5' }), 'utf8');
  writeAsarEntryCache(asarPath, 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json', buf, { cacheDir });
  const entry = readAsarEntryCache(asarPath, 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json', { cacheDir });
  check(!!entry && entry.toString('utf8') === buf.toString('utf8'), 'asar 条目：写 → 读命中');

  // 两级缓存：readAsarJsonCached 第二次应该走 entry-cache
  const j1 = readAsarJsonCached(asarPath, 'dsh/package.json', { cacheDir });
  const j2 = readAsarJsonCached(asarPath, 'dsh/package.json', { cacheDir });
  check(j1.ok && j2.ok && j2.source === 'entry-cache', 'asar JSON：第二次走条目缓存（不打开归档）', `source=${j2.source}`);

  const status = cacheStatus(cacheDir);
  check(status.asarHeader.count >= 1 && Array.isArray(status.asarHeader.entries), '缓存状态：能统计 asar 头条目', `count=${status.asarHeader.count}`);

  return asarPath;
}

/* ------------------------------------------------------------------ *
 * (c) 上游缓存 TTL
 * ------------------------------------------------------------------ */
function testUpstreamCache(cacheDir) {
  const url = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20';
  const T = 1_700_000_000_000;
  const payload = JSON.stringify([{ tag_name: 'v0.2.2', draft: false }]);

  const wrote = writeUpstreamCache(cacheDir, url, payload, { ttlMs: DEFAULT_TTL_MS, status: 200, ok: true, now: T });
  check(wrote === true, '上游缓存：写入成功');

  const file = path.join(cacheDir, 'upstream', `${sha1(url)}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(
    onDisk.formatVersion === 1
      && onDisk.url === url
      && onDisk.fetchedAt === T
      && onDisk.ttlMs === DEFAULT_TTL_MS
      && typeof onDisk.payload === 'string'
      && onDisk.payload === payload,
    '上游缓存：磁盘格式与主插件契约一致（formatVersion/url/fetchedAt/ttlMs/payload）',
  );

  const fresh = readUpstreamCache(cacheDir, url, { ttlMs: DEFAULT_TTL_MS, now: T + 60_000 });
  check(fresh !== null && fresh.payload === payload, '上游缓存：TTL 内命中');

  const edge = readUpstreamCache(cacheDir, url, { ttlMs: DEFAULT_TTL_MS, now: T + DEFAULT_TTL_MS });
  check(edge !== null, '上游缓存：恰好到 TTL 边界仍算命中');

  const expired = readUpstreamCache(cacheDir, url, { ttlMs: DEFAULT_TTL_MS, now: T + DEFAULT_TTL_MS + 1 });
  check(expired === null, '上游缓存：过了 TTL 失效');

  const back = readUpstreamCache(cacheDir, url, { ttlMs: DEFAULT_TTL_MS, now: T - 1000 });
  check(back === null, '上游缓存：时钟被往回调（负 age）算失效');
}

/* ------------------------------------------------------------------ *
 * (d) 工具各 action
 * ------------------------------------------------------------------ */
async function testToolActions(cacheDir, outDir) {
  const config = {
    cacheDir,
    outDir,
    pluginsDir: path.join(TMP, 'plugins'),
    installDir: '',
    iterations: 2,
    notesCacheTtlMs: DEFAULT_TTL_MS,
  };

  // 预置上游缓存，让 notes 能离线跑完。
  // npm 的 URL 必须用实现里那一个（encodeURIComponent 后只把 %40 换回 @，
  // 斜杠保持 %2F）—— 否则预置的缓存根本命中不了，看着像「缓存没生效」。
  const ghUrl = githubReleasesUrl();
  const npmUrl = npmPackageUrl();
  writeUpstreamCache(cacheDir, ghUrl, JSON.stringify([{ tag_name: 'v0.2.2', draft: false }]), { ttlMs: DEFAULT_TTL_MS, now: Date.now() });
  writeUpstreamCache(cacheDir, npmUrl, JSON.stringify({ 'dist-tags': { latest: '0.2.2' } }), { ttlMs: DEFAULT_TTL_MS, now: Date.now() });

  check(ACTIONS.join(',') === 'status,warm,run,bench,notes', '工具：action 列表符合约定', ACTIONS.join(','));

  // status（纯离线）
  const status = await runAction('status', { cacheDir }, config);
  check(status.ok === true && typeof status.summary === 'string' && status.summary.length > 0, 'action=status：返回摘要');
  check(status.offline === true, 'action=status：标明是离线');
  check(typeof status.asarHeader?.count === 'number' && Array.isArray(status.upstream?.entries), 'action=status：返回缓存统计');

  // warm（离线，不预热上游）
  const warm = await runAction('warm', { cacheDir, withNetwork: false }, config);
  check(warm.ok === true || warm.warnings?.length > 0, 'action=warm：返回结果（找不到 asar 时也要有结构化说明）', warm.summary?.split('\n')[0] ?? '');
  check(Array.isArray(warm.entries), 'action=warm：返回条目列表');

  // warm + refresh（回归：曾经 refresh=true 时直接读 null.hit → TypeError 崩掉）
  const warmRefresh = await runAction('warm', { cacheDir, withNetwork: false, refresh: true }, config);
  check(warmRefresh && (warmRefresh.ok === true || (warmRefresh.warnings?.length ?? 0) > 0),
    'action=warm refresh=true：不抛异常，返回结构化结果', warmRefresh?.summary?.split('\n')[0] ?? '');
  check(Array.isArray(warmRefresh?.entries), 'action=warm refresh=true：仍返回条目列表');

  // run
  const run = await runAction('run', { cacheDir, outDir }, config);
  check(typeof run.summary === 'string' && run.summary.length > 0, 'action=run：返回摘要');
  check(run.stats && typeof run.stats.plugins === 'number', 'action=run：返回 stats');
  check(typeof run.elapsedMs === 'number' && run.elapsedMs >= 0, 'action=run：返回耗时', `${run.elapsedMs} ms`);
  check(typeof run.source === 'string' && ['optimized', 'plugin', 'fallback'].includes(run.source), 'action=run：标明来源', run.source);
  check(typeof run.reportExcerpt === 'string', 'action=run：返回报告正文片段（模型不用再追问一轮）', `${run.reportExcerpt.split('\n').length} 行`);

  // run 的落盘：报告文件应该存在（体检能跑起来时）
  if (run.reportPath) {
    check(fs.existsSync(run.reportPath), 'action=run：报告已落盘', run.reportPath);
  } else {
    process.stdout.write('NOTE  action=run：本机没找到 app.asar，跳过「报告落盘」这一项断言\n');
  }

  // bench
  const bench = await runAction('bench', { cacheDir, outDir, iterations: 2 }, config);
  check(bench.ok !== undefined && Array.isArray(bench.timesMs) && bench.timesMs.length === 2, 'action=bench：返回每次耗时', bench.timesMs?.join(' / '));
  check(typeof bench.medianMs === 'number' && typeof bench.minMs === 'number' && typeof bench.maxMs === 'number', 'action=bench：返回中位/最小/最大');

  // notes（离线 + 预置缓存）
  const notes = await runAction('notes', { cacheDir, withNetwork: false }, config);
  check(typeof notes.summary === 'string' && notes.summary.length > 0, 'action=notes：返回摘要');
  check(Array.isArray(notes.sources) && notes.sources.length === 2, 'action=notes：两个上游来源都有交代');
  check(notes.sources.every((s) => s.source === 'cache'), 'action=notes：命中缓存，没联网');

  // 未知 action 不许抛
  const bad = await runAction('nope', {}, config);
  check(bad.ok === false && typeof bad.error === 'string', '工具：未知 action 返回结构化错误，不抛异常', bad.error);

  return { status, warm, run, bench, notes, bad };
}

/* ------------------------------------------------------------------ *
 * (g) 输出 schema 与真实返回值必须对得上
 *
 * 这一节是被真事故逼出来的：宿主用 `additionalProperties: false`
 * 严格校验工具返回值，schema 少声明一个键 → 整条工具调用失败，报
 *   "value.xxx" is not a declared property (additionalProperties: false)
 * 而漏掉的键只有在真调一次工具时才会暴露。这里把它变成离线断言。
 * ------------------------------------------------------------------ */

/**
 * 本地最小校验器：实现宿主真正会卡人的那几条规则。
 * 宿主包在时优先用宿主的（权威），不在时用这个兜底，保证 CI 也能跑。
 *
 * @param {any} spec 作者级 schema 节点
 * @param {any} value
 * @param {string} path
 * @param {string[]} out 违规信息收集
 */
function localValidate(spec, value, path, out) {
  if (!spec || typeof spec !== 'object') return;
  const type = spec.type;

  // `type: 'json'` = 任意 JSON 值（宿主的「无 type 节点」等价物）。
  if (type === 'json' || type === undefined) return;

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.push(`${path} 应为 object`);
      return;
    }
    const props = spec.properties ?? {};
    if (spec.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) out.push(`${path}.${k} is not a declared property (additionalProperties: false)`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (sub?.required === true && !(k in value)) out.push(`${path}.${k} is required`);
      if (k in value) localValidate(sub, value[k], `${path}.${k}`, out);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) { out.push(`${path} 应为 array`); return; }
    if (spec.items) value.forEach((v, i) => localValidate(spec.items, v, `${path}[${i}]`, out));
    return;
  }

  if (type === 'string' && typeof value !== 'string') out.push(`${path} 应为 string`);
  else if (type === 'boolean' && typeof value !== 'boolean') out.push(`${path} 应为 boolean`);
  else if (type === 'number' && typeof value !== 'number') out.push(`${path} 应为 number`);
}

/**
 * @param {Record<string, any>} results 各 action 的真实返回值
 */
async function testOutputSchema(results) {
  const { OUTPUT_SCHEMA } = await import(pathToFileURL(path.join(HERE, 'lib', 'output-schema.js')).href);

  // 优先用宿主的编译器 + 校验器（权威判据）。
  let host = null;
  try {
    host = await import('@deepseek-ai/dsh-tools');
  } catch {
    host = null;
  }

  let compiled = null;
  if (host?.valueSchemaSpecToJsonSchema) {
    try {
      compiled = host.valueSchemaSpecToJsonSchema(OUTPUT_SCHEMA);
      check(true, 'schema：宿主的 valueSchemaSpecToJsonSchema 编译通过');
    } catch (e) {
      check(false, 'schema：宿主的 valueSchemaSpecToJsonSchema 编译通过', e?.message);
      return;
    }
  } else {
    skip('schema：宿主编译器可用（退回本地最小校验器）');
  }

  const declared = new Set(Object.keys(compiled?.properties ?? OUTPUT_SCHEMA.properties ?? {}));
  const validate = (spec, value, label) => {
    if (host?.validateJsonSchemaValue && compiled) {
      return host.validateJsonSchemaValue(compiled, value, 'value');
    }
    const out = [];
    localValidate(spec, value, label, out);
    return out;
  };

  for (const [action, value] of Object.entries(results)) {
    if (!value || typeof value !== 'object') continue;
    const violations = validate(OUTPUT_SCHEMA, value, action);
    check(violations.length === 0, `schema：action=${action} 的返回值通过校验`, violations.join('; '));

    // 单独点名未声明的键 —— 报错信息要能直接指向该补哪个键。
    const undeclared = Object.keys(value).filter((k) => !declared.has(k));
    check(undeclared.length === 0, `schema：action=${action} 没返回未声明的键`, undeclared.join(', '));
  }

  // 负向断言：塞一个没声明的键，校验器必须报错。
  // 否则「校验器太松 → 永远绿」这条路径也会被当成通过。
  const injected = { ...results.status, __undeclared_probe__: 1 };
  const violations = validate(OUTPUT_SCHEMA, injected, 'probe');
  check(violations.length > 0, 'schema：负向探针（塞未声明的键）必须被抓出来', violations[0] ?? '(没抓到 —— 校验器太松)');

  // 注册的工具必须用的就是这份 schema（防止改了文件没接到 defineTool 上）。
  // 注意：defineTool 会把属性上的 `required: true` 归一化成顶层 `required` 数组，
  // 所以不能比引用、也不能比原始 JSON —— 得比**编译之后**的等价物。
  // （顺带一提：归一化后的形式不能反过来喂给作者级 DSL，
  //   会报「schema.required is not supported by the value schema DSL」——
  //   所以只能从作者级 schema 往编译方向比。）
  // lib/index.js 会 import 宿主包（@deepseek-ai/schemastery 等）。脱离 DSH 环境跑时
  // 这些包可能解析不到 —— 那是环境问题，不该让整份自检红掉，降级成 SKIP 更诚实。
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(HERE, 'lib', 'index.js')).href);
  } catch (e) {
    process.stdout.write(`NOTE  跳过「注册工具用的就是这份 schema」：宿主依赖不可解析（${e?.message ?? e}）\n`);
    return;
  }
  const cfg = await mod.Config({});
  let tool = null;
  mod.apply({ tools: { register: (t) => { tool = t; } } }, cfg);
  const registered = tool?.output?.schema;
  if (host?.valueSchemaSpecToJsonSchema) {
    const a = JSON.stringify(host.valueSchemaSpecToJsonSchema(OUTPUT_SCHEMA));
    const b = JSON.stringify(registered);
    check(a === b, '插件：defineTool 用的就是 lib/output-schema.js 这份 schema（编译后等价）');
  } else {
    const a = Object.keys(OUTPUT_SCHEMA.properties ?? {}).sort().join(',');
    const b = Object.keys(registered?.properties ?? {}).sort().join(',');
    check(a === b, '插件：defineTool 用的就是 lib/output-schema.js 这份 schema');
  }
}


/* ------------------------------------------------------------------ *
 * (e) 插件注册：deferLoading 默认开 + 工具注册成功
 * ------------------------------------------------------------------ */
async function testPluginRegistration() {
  // 同 testOutputSchema：拿不到宿主依赖就 SKIP，不让整份自检判红。
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(HERE, 'lib', 'index.js')).href);
  } catch (e) {
    process.stdout.write(`NOTE  跳过「插件注册」：宿主依赖不可解析（${e?.message ?? e}）\n`);
    return;
  }
  check(mod.name === 'tool-compat-optimize', '插件：name 导出正确', mod.name);

  const cfg = await mod.Config({});
  check(cfg.deferLoading === true, '插件：deferLoading 默认开（注意：它不省 token，只延迟「模型现在能不能直接调它」）', String(cfg.deferLoading));

  let tool = null;
  const ctx = { tools: { register: (t) => { tool = t; } } };
  mod.apply(ctx, cfg);
  check(!!tool && tool.name === 'compat_optimize', '插件：工具注册成功（假 ctx）', tool?.name ?? '(没注册)');
  check(tool?.deferLoading === true, '插件：注册时带着 deferLoading=true', String(tool?.deferLoading));
  check(typeof tool?.execute === 'function', '插件：工具带 execute');

  // render 必须把报告正文带出来 —— 只给 summary 的话模型还得再追问一轮。
  const rendered = tool?.output?.render?.({}, { summary: '摘要S', reportExcerpt: '正文R', reportPath: 'P' });
  const text = rendered?.[0]?.text ?? '';
  check(text.includes('摘要S') && text.includes('正文R'), '插件：render 输出含摘要与报告正文', JSON.stringify(text.slice(0, 60)));
}

/* ------------------------------------------------------------------ *
 * (f) CLI 冒烟：check 子命令 + --json
 * ------------------------------------------------------------------ */
async function testCli(cacheDir, outDir) {
  const cli = await import(pathToFileURL(path.join(HERE, 'bin', 'compat-check-cli.mjs')).href);

  const parsed = cli.parseArgs(['check', '--json']);
  check(parsed.command === 'check' && parsed.json === true, 'CLI：位置子命令 check 能解析', JSON.stringify({ command: parsed.command, json: parsed.json }));

  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code = -1;
  try {
    code = await cli.main([
      'check', '--json',
      '--cache-dir', cacheDir,
      '--out-dir', outDir,
      // 显式给一个空的假插件目录：自检不能依赖本机是否有 DSH 插件。
      '--plugins-dir', path.join(TMP, 'plugins'),
    ]);
  } finally {
    process.stdout.write = origWrite;
  }
  check(code === 0 || code === 1, 'CLI：check 跑完并给出退出码（0 正常 / 1 有 broken）', `exit=${code}`);

  let json = null;
  try { json = JSON.parse(chunks.join('')); } catch { /* 下面断言会报 */ }
  check(!!json && typeof json.run?.summary === 'string' && json.run.summary.length > 0, 'CLI：--json 输出是合法 JSON');
  check(!!json && ['plugin', 'optimized', 'fallback'].includes(json.run?.source), 'CLI：输出标明体检来源', json?.run?.source ?? '(无)');
  check(!!json && typeof json.run?.reportPath === 'string' && json.run.reportPath.length > 0, 'CLI：输出带报告路径', json?.run?.reportPath ?? '(无)');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const cacheDir = path.join(TMP, 'cache');
  const outDir = path.join(TMP, 'out');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // 空的假插件目录：自检必须脱离本机真实插件，换台机器结论也一样。
  fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

  process.stdout.write(`# dsh-compat-optimize 自检\n临时目录：${TMP}\n\n`);

  process.stdout.write('## (a)(b) asar 头 / 条目缓存\n');
  testAsarHeaderCache(cacheDir);

  process.stdout.write('\n## (c) 上游缓存 TTL\n');
  testUpstreamCache(cacheDir);

  process.stdout.write('\n## (d) 工具各 action\n');
  const actionResults = await testToolActions(cacheDir, outDir);

  process.stdout.write('\n## (e) 插件注册\n');
  await testPluginRegistration();

  process.stdout.write('\n## (f) CLI 冒烟\n');
  await testCli(cacheDir, outDir);

  process.stdout.write('\n## (g) 输出 schema ↔ 真实返回值\n');
  await testOutputSchema(actionResults);

  process.stdout.write(`\n结果：${pass} PASS / ${fail} FAIL${skipped ? ` / ${skipped} SKIP` : ''}\n`);
  return fail === 0 ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  process.stdout.write(`\nFAIL  自检脚本自身抛错：${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
