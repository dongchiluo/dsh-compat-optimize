/**
 * lib/semver-lite.js —— 够用就好的 semver 子集（只在「主插件不可用」的兜底路径用）。
 *
 * 为什么自己写而不是引 semver 包：
 *   · 沙箱里不能 `npm install`（npm 缓存 EPERM）；
 *   · 主插件本来就自带 `lib/semver.js` —— 正常路径直接用它；
 *   · 兜底路径只用来回答「声明的版本范围覆盖不覆盖当前 DSH 版本」，
 *     覆盖不到的范围（`workspace:` / `file:` / `git+` / URL）一律判「不覆盖」。
 *
 * 支持的范围写法：
 *   `1.2.3` `1.2` `1` `=1.2.3` `>1.2.3` `>=1.2.3` `<1.2.3` `<=1.2.3`
 *   `^1.2.3`（含 `^0.2.3` 的 0.x 特殊规则） `~1.2.3`
 *   空格连接 = 且（`>=0.2.1-rc.5 <0.3.0`） `||` = 或
 *   `*` / `x` / `latest` = 任意
 *
 * 预发布版本（`0.2.1-rc.5`）按 semver 规则比较：
 *   · 数值标识符按数值比，字母标识符按 ASCII 比，数值 < 字母；
 *   · 标识符多的版本更大（`1.0.0-alpha` < `1.0.0-alpha.1`）；
 *   · **有预发布标记的版本小于同版本号的无预发布版本**（`1.0.0-rc.1 < 1.0.0`）。
 */

/**
 * 解析版本号。
 * @param {string} v
 * @returns {{major:number, minor:number, patch:number, pre:string[], raw:string}|null}
 */
export function parseVersion(v) {
  const s = String(v ?? '').trim().replace(/^[=v\s]+/, '');
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    raw: s,
  };
}

/**
 * 比较两个预发布标识符列表。
 * @returns {number} -1 / 0 / 1
 */
function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;   // 有预发布 < 无预发布
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;   // 标识符少的更小
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;            // 数值标识符 < 字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本号。
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 / 0 / 1
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return comparePre(va.pre, vb.pre);
}

/**
 * 一个比较器覆盖的版本区间（用于 `^` / `~` / 部分版本号）。
 * @returns {{min:string, max:string}|null}
 */
function expand(op, ver) {
  const v = parseVersion(ver);
  if (!v) return null;
  const major = v.major;
  const minor = v.minor;
  const patch = v.patch;
  const pre = v.pre.length ? `-${v.pre.join('.')}` : '';

  if (op === '^') {
    let upper;
    if (major !== 0) upper = `${major + 1}.0.0`;
    else if (minor !== 0) upper = `0.${minor + 1}.0`;
    else upper = `0.0.${patch + 1}`;
    return { min: `${major}.${minor}.${patch}${pre}`, max: upper };
  }
  if (op === '~') {
    const parts = String(ver).trim().split('-')[0].split('.');
    const upper = parts.length === 1 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return { min: `${major}.${minor}.${patch}${pre}`, max: upper };
  }
  return null;
}

/**
 * 版本号是否满足范围。
 *
 * @param {string} version
 * @param {string} range
 * @param {{includePrerelease?:boolean}} [opts]
 * @returns {boolean}
 */
export function satisfies(version, range, opts = {}) {
  const includePrerelease = opts.includePrerelease !== false;
  const v = parseVersion(version);
  if (!v) return false;
  const raw = String(range ?? '').trim();
  if (!raw || raw === '*' || raw === 'x' || raw === 'X' || raw === 'latest') return true;

  return raw.split('||').some((part) => {
    const comparators = part.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return true;
    return comparators.every((c) => matchOne(v, c, includePrerelease));
  });
}

/**
 * 判断单个比较器。
 * @param {object} v 已解析的版本
 * @param {string} c 比较器字符串
 * @param {boolean} includePrerelease
 * @returns {boolean}
 */
function matchOne(v, c, includePrerelease) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = m[2].trim();

  // 没法解析的版本范围（workspace: / file: / git+ / URL）一律判不满足。
  if (!parseVersion(target)) return false;

  // 范围里没有预发布标记时，标准 semver 不让预发布版本匹配 ——
  // 宿主闸门用的是 includePrerelease 语义，所以只在显式要求时放开。
  if (!includePrerelease && v.pre.length) {
    const targetHasPre = /-\d/.test(target);
    if (!targetHasPre) return false;
  }

  if (op === '^' || op === '~') {
    const ex = expand(op, target);
    if (!ex) return false;
    return compareVersions(v.raw, ex.min) >= 0 && compareVersions(v.raw, ex.max) < 0;
  }

  if (op === '=') {
    const parts = String(target).replace(/^[v=]/, '').split('-')[0].split('.');
    if (parts.length < 3) {
      // 部分版本号：1.2 → >=1.2.0 <1.3.0；1 → >=1.0.0 <2.0.0
      const ex = expand('~', parts.length === 1 ? `${parts[0]}.0.0` : `${parts[0]}.${parts[1]}.0`);
      if (!ex) return false;
      return compareVersions(v.raw, ex.min) >= 0 && compareVersions(v.raw, ex.max) < 0;
    }
    return compareVersions(v.raw, target) === 0;
  }

  const cmp = compareVersions(v.raw, target);
  if (op === '>') return cmp > 0;
  if (op === '>=') return cmp >= 0;
  if (op === '<') return cmp < 0;
  if (op === '<=') return cmp <= 0;
  return false;
}

/**
 * 从范围里取出「钉死的那个版本」（`1.2.3` 这种精确写法）。
 * @param {string} range
 * @returns {string|null}
 */
export function pinnedVersion(range) {
  const s = String(range ?? '').trim();
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(s)) return s;
  return null;
}

/**
 * 范围的简短描述（报告里显示）。
 * @param {string} range
 * @returns {string}
 */
export function describeRange(range) {
  const s = String(range ?? '').trim();
  if (!s) return '';
  if (/^(workspace|file|link|git|https?):/.test(s)) return `${s}（非版本号范围）`;
  return s;
}
