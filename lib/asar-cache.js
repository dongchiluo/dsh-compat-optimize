/**
 * lib/asar-cache.js —— asar 头 / asar 条目的磁盘缓存。
 *
 * ## 这份缓存是「两边共用」的
 *
 * 主插件 `dsh-compat-check` 与本插件 `dsh-compat-optimize` 读**同一个**缓存目录、
 * 用**同一个**文件格式，所以谁先跑谁受益、谁更新了另一边立刻看得见。
 *
 * 磁盘格式（**逐字段与主插件 lib/cache.js 一致**，改一边就要改另一边）：
 *
 * - 缓存根目录：`<cacheDir>/`（默认 `<baseDir>/.cache/compat-check`）
 * - asar 头：`<cacheDir>/asar-header/<sha1(resolve(asarPath))>.json`
 *   `{"formatVersion":2,"asarPath":"...","size":N,"mtimeMs":N,"fingerprint":"sha1","header":{...},"dataOffset":N}`
 * - asar 条目：`<cacheDir>/asar-entry/<sha1(resolve(asarPath)|innerPath)>.json`
 *   `{"formatVersion":2,"asarPath":"...","innerPath":"...","size":N,"mtimeMs":N,"fingerprint":"sha1","dataB64":"..."}`
 *
 * ## 失效判据
 *
 * 主判据是**内容指纹**（文件头 64 KB 的 sha1）：DSH 升级会换掉 app.asar，
 * 指纹必然变 —— 所以「缓存比实际版本旧」这件事不可能悄悄发生。
 *
 * 曾经用 size + mtimeMs 判活，但在真实宿主里**判不活**：DSH 进程内
 * `fs.statSync(app.asar)` 返回合成 stat（size=0、mtime=进程启动时刻），
 * 于是缓存每次都被判成过期，优化 1 等于白做。详见 fingerprintOf 的注释。
 *
 * ## 为什么值得缓存
 *
 * app.asar 有 174 MB，它的 header JSON 有 4.76 MB；每次 `JSON.parse` 要 50–60 ms。
 * 一次体检要读 4–6 次 asar 里的 package.json（DSH runtime + 三个宿主包），
 * 于是同一个 header 在一次体检里被反复解析 4 次 —— 合计约 195 ms，占体检总耗时 69%。
 *
 * 两级缓存把这条链拆开：
 *   · **头缓存**：省掉 4.76 MB 的 JSON.parse（进程内一次、跨进程靠磁盘）
 *   · **条目缓存**：连 182 MB 归档都不用打开 —— 直接读 base64 出来的小 JSON
 *
 * 写缓存**永远不能把主流程带崩**：所有写都是 best-effort，失败只当没缓存。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { defaultBaseDir } from './paths.js';
import {
  openArchiveFd,
  readAsarFileWithHeader,
  readAsarHeader,
  readDataOffset,
} from './asar-reader.js';

/**
 * 缓存格式版本。结构变了就 +1，旧缓存自然作废（不会读到半懂不懂的数据）。
 *
 * v2：判活主判据从 size+mtimeMs 换成**内容指纹**（见 fingerprintOf 的注释）。
 * 本插件与主插件 dsh-compat-check 共用同一套磁盘格式，版本号必须同步。
 */
export const CACHE_FORMAT_VERSION = 2;

/** 单个条目最大缓存体积（字节）。大文件不缓存 —— 缓存它不划算。 */
export const MAX_CACHEABLE_BYTES = 512 * 1024;

/**
 * 指纹取样字节数：文件头 64 KB（与主插件 lib/cache.js 一致）。
 */
export const FINGERPRINT_BYTES = 64 * 1024;

/** sha1 十六进制摘要，用作文件名。 */
export function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/**
 * 文件内容指纹：sha1(前 64 KB)。
 *
 * **为什么不用 size+mtimeMs 当主判据？**
 * 宿主进程（DSH 自己）里 `fs.statSync(app.asar)` 返回的是**合成 stat**：
 * size=0、mtimeMs=进程启动时刻 —— 而同一时刻本机普通 node 报的是
 * size=182766714 / mtime=2026-10-29。也就是说在真实宿主里，
 * 「size+mtime 变了 ⇒ 归档被换过」这条判据**永远成立**，
 * 磁盘缓存形同虚设（优化 1 白做）。内容指纹不看 stat，宿主内外一致。
 *
 * @param {string} file
 * @returns {string|null} 读不到返回 null
 */
export function fingerprintOf(file) {
  try {
    // 用「真实文件」语义打开：Electron 接管 .asar 时 openSync 会 ENOENT，
    // 而宿主里 app.asar 恰恰是 .asar —— 不绕开这一层指纹永远算不出来。
    const fd = openArchiveFd(file);
    try {
      const buf = Buffer.alloc(FINGERPRINT_BYTES);
      const n = fs.readSync(fd, buf, 0, FINGERPRINT_BYTES, 0);
      return sha1(buf.subarray(0, n).toString('latin1'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 判一条缓存条目还新不新。
 *
 * 主判据 = 内容指纹；指纹取不到时才退回 size+mtimeMs。
 *
 * @param {object} c 缓存条目
 * @param {{size:number,mtimeMs:number}|null} stat 当前 stat
 * @param {string|null} fingerprint 当前内容指纹
 * @returns {boolean}
 */
export function entryIsFresh(c, stat, fingerprint) {
  if (c.fingerprint && fingerprint) return c.fingerprint === fingerprint;
  if (!stat) return false;
  return c.size === stat.size && c.mtimeMs === stat.mtimeMs;
}

/**
 * 默认缓存根目录。
 * @param {string} [baseDir] 工作区根目录
 * @returns {string}
 */
export function defaultCacheDir(baseDir) {
  return path.resolve(baseDir || defaultBaseDir(), '.cache', 'compat-check');
}

/* ------------------------------------------------------------------ *
 * 路径（与主插件逐字一致：sha1 的输入是 resolve 之后的绝对路径）
 * ------------------------------------------------------------------ */

/** asar 头缓存文件路径。 */
export function asarHeaderCachePath(asarPath, cacheDir) {
  return path.join(cacheDir, 'asar-header', `${sha1(path.resolve(asarPath))}.json`);
}

/** asar 内某个条目的缓存文件路径。 */
export function asarEntryCachePath(asarPath, innerPath, cacheDir) {
  return path.join(cacheDir, 'asar-entry', `${sha1(`${path.resolve(asarPath)}|${innerPath}`)}.json`);
}

/* ------------------------------------------------------------------ *
 * 基础读写（写失败只当没缓存）
 * ------------------------------------------------------------------ */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** 取文件的 size/mtimeMs；取不到返回 null（调用方据此判断「没法判活」）。 */
export function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * asar 头
 * ------------------------------------------------------------------ */

/**
 * 读 asar 头缓存（**只读缓存，不解析 asar**）。
 *
 * @param {string} asarPath
 * @param {{cacheDir:string, refresh?:boolean}} opts
 * @returns {{ok:boolean, hit:boolean, header:object|null, dataOffset:number,
 *            stat:{size:number,mtimeMs:number}|null, cachePath:string, reason?:string}}
 */
export function readAsarHeaderCache(asarPath, { cacheDir, refresh = false } = {}) {
  const abs = path.resolve(asarPath);
  const stat = statOf(abs);
  const fingerprint = fingerprintOf(abs);
  const cachePath = asarHeaderCachePath(abs, cacheDir ?? '');
  if (!stat) return { ok: false, hit: false, header: null, dataOffset: 0, stat: null, cachePath, reason: `文件不存在：${abs}` };
  if (!cacheDir) return { ok: false, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: '没给 cacheDir' };

  if (!refresh) {
    const c = readJsonFile(cachePath);
    if (!c) return { ok: true, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: 'miss' };
    if (c.formatVersion !== CACHE_FORMAT_VERSION) return { ok: true, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: 'formatVersion 不符' };
    if (c.asarPath !== abs) return { ok: true, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: 'asarPath 不符' };
    if (!entryIsFresh(c, stat, fingerprint)) return { ok: true, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: '内容指纹已变（归档被换过）' };
    if (!c.header || typeof c.header !== 'object') return { ok: true, hit: false, header: null, dataOffset: 0, stat, cachePath, reason: '缓存内容不完整' };
    return {
      ok: true,
      hit: true,
      header: c.header,
      // dataOffset 是主插件额外写的字段；没有就现算（读 16 字节 pickle 头，~0.05 ms）。
      dataOffset: c.dataOffset || readDataOffsetQuiet(abs),
      stat,
      fingerprint,
      cachePath,
    };
  }
  return { ok: true, hit: false, header: null, dataOffset: 0, stat, fingerprint, cachePath, reason: 'refresh' };
}

/**
 * 写 asar 头缓存（best-effort）。
 *
 * @param {string} asarPath
 * @param {object} header 已解析的 header
 * @param {{cacheDir:string, stat?:object, dataOffset?:number, fingerprint?:string|null}} opts
 * @returns {boolean} 是否写成功
 */
export function writeAsarHeaderCache(asarPath, header, { cacheDir, stat, dataOffset, fingerprint } = {}) {
  if (!cacheDir || !asarPath || !header) return false;
  const abs = path.resolve(asarPath);
  const st = stat ?? statOf(abs);
  if (!st) return false;
  return writeJsonFile(asarHeaderCachePath(abs, cacheDir), {
    formatVersion: CACHE_FORMAT_VERSION,
    asarPath: abs,
    size: st.size,
    mtimeMs: st.mtimeMs,
    fingerprint: fingerprint ?? fingerprintOf(abs),
    header,
    dataOffset: dataOffset ?? readDataOffsetQuiet(abs),
  });
}

/**
 * 让某个 asar 的头缓存失效（删文件）。
 * @param {string} asarPath
 * @param {{cacheDir:string}} opts
 * @returns {boolean}
 */
export function invalidateAsarCache(asarPath, { cacheDir } = {}) {
  if (!cacheDir || !asarPath) return false;
  const p = asarHeaderCachePath(asarPath, cacheDir);
  try {
    if (fs.existsSync(p)) fs.rmSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 让某个 asar 的**全部**缓存失效：头缓存 + 属于它的所有条目缓存。
 *
 * `refresh` 用它 —— 「忽略缓存强制回源」不能只清头缓存：
 * 条目缓存里存着从旧归档里读出来的 package.json，不清的话还是旧值。
 *
 * @param {string} asarPath
 * @param {{cacheDir:string}} opts
 * @returns {number} 清掉的文件数
 */
export function invalidateAsarCaches(asarPath, { cacheDir } = {}) {
  if (!cacheDir || !asarPath) return 0;
  const abs = path.resolve(asarPath);
  let removed = 0;

  if (invalidateAsarCache(abs, { cacheDir })) removed += 1;

  try {
    const dir = path.join(cacheDir, 'asar-entry');
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const c = readJsonFile(p);
      if (!c) continue;
      if (c.asarPath !== abs) continue;
      try {
        fs.rmSync(p);
        removed += 1;
      } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 目录不存在 = 没有条目缓存 */ }

  return removed;
}

/**
 * 读 asar 头 —— **命中就返回缓存，没命中就解析并顺手写缓存**。
 *
 * 这是本插件对外的主入口：调用方不必关心缓存存不存在。
 *
 * @param {string} asarPath
 * @param {{cacheDir:string, refresh?:boolean, parseOnMiss?:boolean}} opts
 * @returns {{ok:boolean, hit:boolean, header:object|null, dataOffset:number,
 *            stat:object|null, cachePath:string, parsed?:boolean, reason?:string, error?:string}}
 */
export function readAsarHeaderCached(asarPath, { cacheDir, refresh = false, parseOnMiss = true } = {}) {
  const cached = readAsarHeaderCache(asarPath, { cacheDir, refresh });
  if (cached.hit) return { ...cached, parsed: false };
  if (!cached.ok) return { ...cached, parsed: false };
  if (!parseOnMiss) return { ...cached, parsed: false };

  const abs = path.resolve(asarPath);
  try {
    const { header, dataOffset } = readAsarHeader(abs);
    writeAsarHeaderCache(abs, header, { cacheDir, stat: cached.stat, dataOffset });
    return { ok: true, hit: false, parsed: true, header, dataOffset, stat: cached.stat, cachePath: cached.cachePath };
  } catch (e) {
    return { ...cached, parsed: false, ok: false, error: `解析 asar 头失败：${e?.message ?? e}` };
  }
}

/* ------------------------------------------------------------------ *
 * asar 条目（跨进程省掉「打开 182 MB 归档」这一步）
 * ------------------------------------------------------------------ */

/**
 * 读 asar 内某个小文件的缓存。
 * @returns {Buffer|null}
 */
export function readAsarEntryCache(asarPath, innerPath, { cacheDir, stat } = {}) {
  if (!cacheDir || !asarPath || !innerPath) return null;
  const abs = path.resolve(asarPath);
  const st = stat ?? statOf(abs);
  if (!st) return null;
  const fingerprint = fingerprintOf(abs);
  const c = readJsonFile(asarEntryCachePath(abs, innerPath, cacheDir));
  if (!c || c.formatVersion !== CACHE_FORMAT_VERSION) return null;
  if (c.asarPath !== abs || c.innerPath !== innerPath) return null;
  if (!entryIsFresh(c, st, fingerprint)) return null;
  if (typeof c.dataB64 !== 'string') return null;
  try {
    return Buffer.from(c.dataB64, 'base64');
  } catch {
    return null;
  }
}

/**
 * 写 asar 内某个小文件的缓存（best-effort）。
 * @returns {boolean}
 */
export function writeAsarEntryCache(asarPath, innerPath, buf, { cacheDir, stat } = {}) {
  if (!cacheDir || !asarPath || !innerPath || !buf) return false;
  const abs = path.resolve(asarPath);
  const st = stat ?? statOf(abs);
  if (!st) return false;
  if (buf.length > MAX_CACHEABLE_BYTES) return false;
  return writeJsonFile(asarEntryCachePath(abs, innerPath, cacheDir), {
    formatVersion: CACHE_FORMAT_VERSION,
    asarPath: abs,
    innerPath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    fingerprint: fingerprintOf(abs),
    dataB64: buf.toString('base64'),
  });
}

/**
 * 读 asar 内某个 JSON 文件 —— **走两级缓存**：
 *   条目缓存命中 → 直接拿内容（连归档都不用开）
 *   条目未命中   → 用头缓存（或现解析）定位偏移，读出来后顺手写条目缓存
 *
 * @param {string} asarPath
 * @param {string} innerPath
 * @param {{cacheDir:string, refresh?:boolean}} opts
 * @returns {{ok:boolean, data:object|null, source:string, error?:string}}
 *   source: 'entry-cache' | 'header-cache' | 'asar' | 'none'
 */
export function readAsarJsonCached(asarPath, innerPath, { cacheDir, refresh = false } = {}) {
  const abs = path.resolve(asarPath);
  const stat = statOf(abs);
  if (!stat) return { ok: false, data: null, source: 'none', error: `文件不存在：${abs}` };

  if (!refresh) {
    const buf = readAsarEntryCache(abs, innerPath, { cacheDir, stat });
    if (buf) {
      const data = safeJson(buf);
      if (data) return { ok: true, data, source: 'entry-cache' };
    }
  }

  const hdr = readAsarHeaderCached(abs, { cacheDir, refresh });
  if (!hdr.ok || !hdr.header) return { ok: false, data: null, source: 'none', error: hdr.error ?? hdr.reason ?? '拿不到 asar 头' };

  const buf = readAsarFileWithHeader(abs, hdr.header, hdr.dataOffset, innerPath);
  if (!buf) return { ok: true, data: null, source: hdr.hit ? 'header-cache' : 'asar' };
  writeAsarEntryCache(abs, innerPath, buf, { cacheDir, stat });
  return { ok: true, data: safeJson(buf), source: hdr.hit ? 'header-cache' : 'asar' };
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/**
 * 汇总缓存目录状态：条目数、字节数，以及每条 asar 头缓存**现在还判不判活**。
 *
 * @param {string} cacheDir
 * @returns {{cacheDir:string, asarHeader:{count:number,bytes:number,valid:number,stale:number,entries:object[]},
 *            asarEntry:{count:number,bytes:number}, upstream:{count:number,bytes:number}}}
 */
export function cacheStatus(cacheDir) {
  const sum = (sub) => {
    let count = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(path.join(cacheDir, sub))) {
        const p = path.join(cacheDir, sub, name);
        try {
          const st = fs.statSync(p);
          count += 1;
          bytes += st.size;
        } catch { /* 读不到就当没有 */ }
      }
    } catch { /* 目录不存在 = 没有缓存 */ }
    return { count, bytes };
  };

  const header = sum('asar-header');
  const entry = sum('asar-entry');
  const upstream = sum('upstream');

  /* 每条 asar 头缓存：现在还能不能用（内容指纹对不对得上，stat 只作兜底） */
  const entries = [];
  let valid = 0;
  let stale = 0;
  try {
    for (const name of fs.readdirSync(path.join(cacheDir, 'asar-header'))) {
      const p = path.join(cacheDir, 'asar-header', name);
      const c = readJsonFile(p);
      if (!c) continue;
      const st = c.asarPath ? statOf(c.asarPath) : null;
      const fp = c.asarPath ? fingerprintOf(c.asarPath) : null;
      const isValid = !!(st && c.formatVersion === CACHE_FORMAT_VERSION && entryIsFresh(c, st, fp));
      if (isValid) valid += 1; else stale += 1;
      entries.push({
        file: name,
        asarPath: c.asarPath ?? '',
        cachedSize: c.size ?? null,
        cachedMtimeMs: c.mtimeMs ?? null,
        cachedFingerprint: c.fingerprint ?? null,
        currentSize: st?.size ?? null,
        currentMtimeMs: st?.mtimeMs ?? null,
        currentFingerprint: fp ?? null,
        valid: isValid,
        bytes: (() => { try { return fs.statSync(p).size; } catch { return 0; } })(),
      });
    }
  } catch { /* 目录不存在 = 没有缓存 */ }

  return {
    cacheDir,
    asarHeader: { ...header, valid, stale, entries },
    asarEntry: entry,
    upstream,
  };
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** 读 16 字节 pickle 头算 dataOffset；失败返回 0（调用方会退回到「现解析」）。 */
function readDataOffsetQuiet(abs) {
  try {
    return readDataOffset(abs);
  } catch {
    return 0;
  }
}
