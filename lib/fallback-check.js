/**
 * lib/fallback-check.js —— **自实现**的等价兼容性体检。
 *
 * 什么时候用：主插件 `dsh-compat-check` 没装 / 装坏了 / 正在被改到 import 失败。
 * 这时本插件必须**还能给出结论**，而不是直接罢工 —— 一个工具因为邻居不在就不干活，
 * 那是在拿别人的可用性当自己的可用性。
 *
 * 结论口径必须和主插件一致（这是「等价」二字的含义）：
 *   · 宿主闸门：`engines.dsh` 优先，没有才看 peerDependencies 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`；
 *   · 比的是**运行时版本**（DSH 应用版本），不是插件解析到的包版本；
 *   · 闸门不过 = **broken**（宿主会整个跳过这个 bundle，工具一个都不出现且不报错）；
 *   · 声明落后 = **stale**（不等于跑不了）；
 *   · 插件目录自带宿主副本且与运行时不一致 = **shadowed**。
 *
 * 输出里一律标 `source: "fallback"`，让看报告的人知道这份结论不是主插件出的。
 */

import fs from 'node:fs';
import path from 'node:path';

import { readAsarJsonCached } from './asar-cache.js';
import { normalizeInstallDir } from './asar-reader.js';
import { compareVersions, describeRange, pinnedVersion, satisfies } from './semver-lite.js';

/** 宿主包清单（与主插件一致）。 */
export const HOST_PACKAGES = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'];

/** 严重度从好到坏。 */
export const SEVERITY = ['ok', 'stale', 'shadowed', 'broken'];

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const worst = (list) => list.reduce((acc, v) => (SEVERITY.indexOf(v) > SEVERITY.indexOf(acc) ? v : acc), 'ok');

/**
 * 找安装目录（优先显式值；显式值可以指到 app.asar 文件，会被归一化成目录）。
 * @param {string} [explicit]
 * @returns {string|null}
 */
export function findInstallDir(explicit) {
  const looksLikeRoot = (d) => !!d && (exists(path.join(d, 'resources', 'app.asar'))
    || exists(path.join(d, 'resources', 'runtime', 'primary-runtime', 'runtime.json')));

  if (explicit) {
    const dir = normalizeInstallDir(explicit);
    return looksLikeRoot(dir) ? path.resolve(dir) : null;
  }
  const candidates = [];
  if (process.execPath) {
    let dir = path.dirname(process.execPath);
    for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i += 1) {
      candidates.push(dir);
      dir = path.dirname(dir);
    }
  }
  for (const key of ['DSH_INSTALL_DIR', 'DSH_DESKTOP_ROOT', 'DSH_APP_ROOT', 'DEEPSEEK_HARNESS_HOME']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'DeepSeek Harness'));
  // 非系统盘安装很常见：按盘符轮一遍常见布局，而不是写死某一台机器的路径。
  for (const drive of ['C:', 'D:', 'E:']) {
    candidates.push(`${drive}\\Program Files\\DeepSeek Harness`);
  }
  for (const c of candidates) {
    const dir = normalizeInstallDir(c);
    if (looksLikeRoot(dir)) return path.resolve(dir);
  }
  return null;
}

/**
 * 认 DSH 版本（走缓存读 asar）。
 * @param {{installDir?:string, cacheDir?:string}} opts
 */
export function detectDshLite(opts = {}) {
  const warnings = [];
  const evidence = [];
  const installDir = findInstallDir(opts.installDir);
  if (opts.installDir && !installDir) warnings.push(`配置的 installDir 不像一个 DSH 安装目录：${opts.installDir}`);

  let runtimeJson = null;
  if (installDir) {
    const p = path.join(installDir, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
    if (exists(p)) {
      runtimeJson = readJson(p);
      if (runtimeJson?.desktopVersion) evidence.push({ label: 'runtime.json · desktopVersion', value: runtimeJson.desktopVersion, file: p });
    }
  }

  const asarPath = installDir ? path.join(installDir, 'resources', 'app.asar') : null;
  let asarVersion = null;
  if (asarPath && exists(asarPath)) {
    for (const inner of [
      'dsh/node_modules/@deepseek-ai/dsh/package.json',
      'dsh/node_modules/@deepseek-ai/dsh-desktop-runtime/package.json',
      'dsh/package.json',
    ]) {
      const r = readAsarJsonCached(asarPath, inner, { cacheDir: opts.cacheDir });
      if (r.ok && r.data?.version) {
        asarVersion = r.data.version;
        evidence.push({ label: 'app.asar 内 DSH runtime', value: asarVersion, file: `${asarPath}!${inner}` });
        break;
      }
    }
  }

  const dshVersion = runtimeJson?.desktopVersion ?? asarVersion ?? null;
  if (!dshVersion) warnings.push('没能认出 DSH 版本：runtime.json 读不到，app.asar 也不在预期位置。');

  const runtimePackages = [];
  if (asarPath && exists(asarPath)) {
    for (const name of HOST_PACKAGES) {
      const r = readAsarJsonCached(asarPath, `dsh/node_modules/${name}/package.json`, { cacheDir: opts.cacheDir });
      runtimePackages.push({ name, version: r.ok ? (r.data?.version ?? null) : null, path: `app.asar!dsh/node_modules/${name}` });
    }
  }

  return {
    dshVersion,
    evidence,
    installDir,
    installDirFoundBy: opts.installDir ? '配置 installDir' : '自动探测',
    runtimePackages,
    warnings,
    asarPath,
  };
}

/**
 * 宿主闸门（照抄主插件的判定规则）。
 * @param {object} pkg
 * @param {string|null} runtimeVersion
 */
export function evaluateHostGate(pkg, runtimeVersion) {
  const engine = pkg?.engines?.dsh;
  if (engine !== undefined) {
    if (typeof engine !== 'string') return { source: 'engines.dsh', met: false, range: null, reason: 'engines.dsh 必须是字符串' };
    const ok = safeSatisfies(runtimeVersion, engine);
    return {
      source: 'engines.dsh',
      met: ok,
      range: engine,
      reason: ok ? null : `engines.dsh "${engine}" 覆盖不了当前 DSH ${runtimeVersion}`,
    };
  }
  const peers = Object.entries(pkg?.peerDependencies ?? {}).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'));
  if (!peers.length) return { source: 'none', met: true, range: null, reason: null };
  const bad = peers.filter(([, r]) => !safeSatisfies(runtimeVersion, r));
  return {
    source: 'peer',
    met: bad.length === 0,
    range: bad.map(([n, r]) => `"${n}": "${r}"`).join('、') || null,
    reason: bad.length ? `${bad.map(([n, r]) => `${n} "${r}"`).join('、')} 覆盖不了当前 DSH ${runtimeVersion}` : null,
  };
}

function safeSatisfies(version, range) {
  try {
    return satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/** pluginsDir 下的插件目录。 */
export function listPluginDirs(pluginsDir) {
  if (!exists(pluginsDir)) return [];
  const out = [];
  try {
    for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const dir = path.join(pluginsDir, e.name);
      if (exists(path.join(dir, 'package.json'))) out.push(dir);
    }
  } catch { /* 目录读不了 = 没有插件 */ }
  return out.sort();
}

/** 抽出所有 `@deepseek-ai/*` 的版本声明。 */
export function collectDeclarations(pkg) {
  const out = [];
  for (const field of ['peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg?.[field] ?? {})) {
      if (name.startsWith('@deepseek-ai/')) out.push({ pkg: name, range, field });
    }
  }
  return out;
}

/** 沿目录链找插件自带的宿主副本。 */
export function findVendoredCopy(fromDir, name, stopAt) {
  let dir = fromDir;
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i += 1) {
    if (stopAt && path.resolve(dir) === path.resolve(stopAt)) break;
    const p = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (exists(p)) {
      const pkg = readJson(p);
      return { name, version: pkg?.version ?? null, path: p };
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * 兜底体检。
 *
 * @param {{pluginsDir:string, host:object, include?:string[], stopAt?:string}} ctx
 * @returns {{pluginsDir:string, findings:object[], summary:object}}
 */
export function checkPluginsFallback(ctx) {
  const { pluginsDir, host } = ctx;
  const stopAt = ctx.stopAt ?? pluginsDir;
  const runtimeByName = new Map((host.runtimePackages ?? []).map((p) => [p.name, p.version]));
  const dirs = listPluginDirs(pluginsDir)
    .filter((d) => !ctx.include?.length || ctx.include.includes(path.basename(d)));

  const findings = dirs.map((dir) => checkOne(dir, { host, runtimeByName, stopAt }));
  return {
    pluginsDir,
    findings,
    summary: {
      total: findings.length,
      ok: findings.filter((f) => f.verdict === 'ok').length,
      stale: findings.filter((f) => f.verdict === 'stale').length,
      shadowed: findings.filter((f) => f.verdict === 'shadowed').length,
      broken: findings.filter((f) => f.verdict === 'broken').length,
      verdict: worst(findings.map((f) => f.verdict)),
    },
  };
}

function checkOne(dir, { host, runtimeByName, stopAt }) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) {
    return {
      name: path.basename(dir), dir, version: null, pin: null,
      verdict: 'broken', checks: [], issues: [{ level: 'broken', text: `package.json 读不了或不是合法 JSON：${pkgPath}` }],
      declares: [], shadowed: [], upgrades: [],
    };
  }

  const issues = [];
  const declares = collectDeclarations(pkg);
  const runtimeVersion = host.dshVersion ?? null;

  /* --- ④ 宿主闸门 --- */
  const gate = runtimeVersion ? evaluateHostGate(pkg, runtimeVersion) : null;
  if (gate && !gate.met) {
    issues.push({ level: 'broken', text: `宿主闸门不过（${gate.source}）：${gate.reason} —— DSH 会跳过这个插件，工具一个都不出现` });
  }

  /* --- ① 声明 vs 运行时自带 --- */
  const upgrades = [];
  const peerInert = gate?.source === 'engines.dsh' && gate.met;
  for (const d of declares) {
    if (peerInert && d.field === 'peerDependencies' && (d.pkg === '@deepseek-ai/dsh' || d.pkg.startsWith('@deepseek-ai/dsh-'))) continue;
    const runtime = runtimeByName.get(d.pkg);
    if (!runtime) {
      if (!gate || gate.met) issues.push({ level: 'stale', text: `${d.pkg} "${describeRange(d.range)}"：本机运行时里读不到这个包（app.asar 内没有、node 也解析不到）` });
      continue;
    }
    if (!safeSatisfies(runtime, d.range)) {
      issues.push({ level: 'stale', text: `${d.pkg} 声明 "${describeRange(d.range)}"，运行时自带 ${runtime} —— 声明落后` });
      upgrades.push({ pkg: d.pkg, range: d.range, to: runtime });
    }
  }

  /* --- ② 影子副本 --- */
  const shadowed = [];
  for (const name of HOST_PACKAGES) {
    const vendored = findVendoredCopy(dir, name, stopAt);
    if (!vendored) continue;
    const runtime = runtimeByName.get(name);
    if (runtime && vendored.version && vendored.version !== runtime) {
      shadowed.push({ name, version: vendored.version, path: vendored.path });
      issues.push({ level: 'shadowed', text: `自带宿主副本 ${name}@${vendored.version}（运行时是 ${runtime}）：${vendored.path}` });
    }
  }

  const verdict = issues.length ? worst(issues.map((i) => i.level)) : 'ok';
  const pin = declares.find((d) => d.pkg === '@deepseek-ai/dsh-tools')?.range ?? null;

  return {
    name: pkg.name ?? path.basename(dir),
    dir,
    version: pkg.version ?? null,
    pin,
    verdict,
    checks: [
      { label: '宿主闸门', ok: gate ? gate.met : true, detail: gate ? `${gate.source}${gate.range ? ` ${gate.range}` : ''}` : '未检查（认不出 DSH 版本）' },
      { label: '版本声明', ok: !issues.some((i) => i.level === 'stale'), detail: `${declares.length} 条 @deepseek-ai/* 声明` },
      { label: '影子副本', ok: !shadowed.length, detail: shadowed.length ? `${shadowed.length} 个与运行时不一致的宿主副本` : '无' },
    ],
    issues,
    declares,
    shadowed,
    upgrades,
  };
}

/**
 * 兜底路径的报告正文（Markdown）。
 * @param {{host:object, scan:object}} input
 * @returns {string}
 */
export function renderFallbackReport({ host, scan }) {
  const L = [];
  L.push('# 插件兼容性体检报告（fallback 模式）');
  L.push('');
  L.push('> 本报告由 `dsh-compat-optimize` 的**自实现兜底路径**生成');
  L.push('> （主插件 `dsh-compat-check` 不可用）。判定口径与主插件一致，但覆盖面更窄。');
  L.push('');
  L.push('## 宿主');
  L.push('');
  L.push(`- DSH 版本：${host.dshVersion ?? '（未识别）'}`);
  L.push(`- 安装目录：${host.installDir ?? '（未找到）'}`);
  for (const e of host.evidence ?? []) L.push(`- 证据 · ${e.label}：${e.value}`);
  for (const w of host.warnings ?? []) L.push(`- ⚠️ ${w}`);
  L.push('');
  L.push('## 运行时自带');
  L.push('');
  for (const p of host.runtimePackages ?? []) L.push(`- ${p.name}：${p.version ?? '（读不到）'}`);
  L.push('');
  L.push('## 插件');
  L.push('');
  L.push(`- 目录：${scan.pluginsDir}`);
  L.push(`- 统计：共 ${scan.summary.total} 个 —— ok ${scan.summary.ok} / stale ${scan.summary.stale} / shadowed ${scan.summary.shadowed} / broken ${scan.summary.broken}`);
  L.push('');
  for (const f of scan.findings) {
    L.push(`### ${f.name} —— ${f.verdict}`);
    L.push('');
    L.push(`- 路径：${f.dir}`);
    L.push(`- 版本：${f.version ?? '（读不到）'}`);
    if (f.issues.length) {
      for (const i of f.issues) L.push(`- ${i.level}：${i.text}`);
    } else {
      L.push('- 全部对得上');
    }
    L.push('');
  }
  return L.join('\n');
}

/**
 * 兜底路径的紧凑摘要（CLI / 工具直接打印的那一屏）。
 * @param {{host:object, scan:object}} input
 * @returns {string}
 */
export function renderFallbackSummary({ host, scan }) {
  const s = scan.summary;
  return [
    `DSH ${host.dshVersion ?? '未知'} · 插件 ${s.total} 个：ok ${s.ok} / stale ${s.stale} / shadowed ${s.shadowed} / broken ${s.broken}`,
    `来源：fallback（主插件不可用，自实现等价检查）`,
  ].join('\n');
}

export { compareVersions, pinnedVersion };
