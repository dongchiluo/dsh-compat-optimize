/**
 * lib/main-plugin.js —— 动态加载主插件 `dsh-compat-check` 的内部模块。
 *
 * ## 为什么要动态 import
 *
 * 主插件是**另一个插件**，不能把它写成本插件的依赖：
 *   · 它的版本会变（本项目里它正在被并行改动）；
 *   · 它可能根本没装（别的机器上只装本插件）；
 *   · 打包时 `files` 白名单不包含别的插件的代码。
 * 所以只能运行时去磁盘上找、用 `pathToFileURL` 动态 import。
 *
 * ## 为什么必须用 pathToFileURL
 *
 * Windows 下 `await import('<plugins>\\...\\tool.js')` 会抛
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` —— 只有 `c:` / `file:` 协议能被 ESM loader 认。
 * `pathToFileURL(p).href` 把路径转成 `file:///...`，这才是能 import 的形式。
 *
 * ## 加载失败怎么办
 *
 * 失败**不是**致命错误：调用方（check.js）会退回到自实现的等价检查，
 * 并在输出里注明 `source: "fallback"`。本插件必须能独立跑起来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本插件自己的目录（lib/ 的上一级）。 */
export const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 本插件根目录。 */
export const PLUGIN_DIR = path.dirname(HERE);

/** 需要从主插件借用的模块。 */
const MODULE_FILES = {
  host: 'host.js',
  plugins: 'plugins.js',
  report: 'report.js',
  releases: 'releases.js',
  semver: 'semver.js',
  tool: 'tool.js',
};

/** 主插件的默认目录名（与本插件同级的兄弟目录）。 */
const DEFAULT_MAIN_PLUGIN_DIRNAME = 'dsh-compat-check';

/**
 * 猜主插件目录：优先与本插件**同级**（`<plugins>/dsh-compat-check`）。
 *
 * 同级的意思是以本插件的**父目录**为基准 —— 本插件在 `<plugins>/dsh-compat-optimize`，
 * 主插件在 `<plugins>/dsh-compat-check`。
 * 也认「嵌套」布局（本插件目录里再放一个 dsh-compat-check），免得换机器就找不到。
 *
 * @param {string} [explicit]
 * @returns {string}
 */
export function guessMainPluginDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(path.dirname(PLUGIN_DIR), DEFAULT_MAIN_PLUGIN_DIRNAME),   // <plugins>/dsh-compat-check
    path.join(PLUGIN_DIR, DEFAULT_MAIN_PLUGIN_DIRNAME),                 // <plugins>/dsh-compat-optimize/dsh-compat-check
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  return candidates[0];
}

/**
 * 载入主插件模块（模块级缓存 —— bench 要连续跑多次，不能每次重新 import）。
 *
 * @param {{mainPluginDir?:string, force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, dir:string, modules:object, error:string|null, loaded:string[]}>}
 */
export async function loadMainPlugin(opts = {}) {
  const dir = guessMainPluginDir(opts.mainPluginDir);
  const key = path.resolve(dir);
  if (!opts.force && moduleCache.has(key)) return moduleCache.get(key);

  const modules = {};
  const loaded = [];
  const errors = [];
  for (const [name, file] of Object.entries(MODULE_FILES)) {
    const full = path.join(dir, 'lib', file);
    if (!fs.existsSync(full)) { errors.push(`缺少 ${full}`); continue; }
    try {
      modules[name] = await import(pathToFileURL(full).href);
      loaded.push(name);
    } catch (e) {
      errors.push(`import ${full} 失败：${e?.message ?? e}`);
    }
  }

  const result = {
    ok: loaded.length > 0 && !!modules.host && !!modules.plugins && !!modules.report,
    dir,
    modules,
    loaded,
    error: errors.length ? errors.join('；') : null,
  };
  moduleCache.set(key, result);
  return result;
}

/** 模块级缓存（key = 主插件目录绝对路径）。 */
const moduleCache = new Map();

/**
 * 主插件是否「可复用」—— 有 host/plugins/report 三个核心模块才算。
 * @param {object} main
 * @returns {boolean}
 */
export function isUsable(main) {
  return !!(main && main.ok && main.modules?.host?.detectDsh && main.modules?.plugins?.checkPlugins && main.modules?.report?.renderReport);
}

/**
 * 读主插件的版本（报告里要写清楚「这次体检逻辑来自哪一版主插件」）。
 * @param {string} dir
 * @returns {string}
 */
export function mainPluginVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.version ?? '';
  } catch {
    return '';
  }
}
