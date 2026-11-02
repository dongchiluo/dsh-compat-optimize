/**
 * lib/paths.js —— 默认路径解析（**不写死任何本机绝对路径**）。
 *
 * 开源版把原来写死的开发机工作区目录换成了三级来源：
 *
 *   1. 显式配置（工具 config / CLI 参数）：最优先，调用方说了算；
 *   2. 环境变量 `DSH_COMPAT_BASE_DIR`，其次 `DSH_HOME`；
 *   3. 兜底 `os.homedir()`。
 *
 * `baseDir` 的语义是「插件与产物的根」：
 *   · 插件目录       `<baseDir>/plugins`
 *   · 报告落盘       `<baseDir>/out/compat`
 *   · 缓存目录       `<baseDir>/.cache/compat-check`
 *
 * 想换位置就设环境变量，不要改代码：
 *
 *   DSH_COMPAT_BASE_DIR=/opt/dsh   node bin/compat-check-cli.mjs check
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 默认工作区根目录。
 * @returns {string}
 */
export function defaultBaseDir() {
  return process.env.DSH_COMPAT_BASE_DIR
    || process.env.DSH_HOME
    || os.homedir();
}

/**
 * 默认插件目录：`<baseDir>/plugins`。
 * @param {string} [baseDir]
 * @returns {string}
 */
export function defaultPluginsDir(baseDir) {
  return path.join(baseDir || defaultBaseDir(), 'plugins');
}

/**
 * 默认报告落盘目录：`<baseDir>/out/compat`。
 * @param {string} [baseDir]
 * @returns {string}
 */
export function defaultOutDir(baseDir) {
  return path.join(baseDir || defaultBaseDir(), 'out', 'compat');
}
