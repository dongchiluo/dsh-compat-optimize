/**
 * lib/asar-reader.js —— 极简 ASAR 只读器（本插件自带，不依赖主插件）。
 *
 * 为什么要自带一份：主插件（dsh-compat-check）可能没装、装的是别的版本、
 * 或者正在被并行改动。这个文件是本插件**独立可用**的底线 —— 即使主插件整个不在，
 * 缓存预热与体检快路径照样能跑。
 *
 * ASAR 文件布局（小端 uint32）：
 *   0..3    pickle 大小
 *   4..7    headerSize（从字节 4 起算）
 *   8..11   header 字符串大小
 *   12..15  JSON 长度
 *   16..    header JSON
 *   8+headerSize 起是文件数据区
 *
 * 数据区起点是 `8 + headerSize` 而不是 `16 + headerSize` —— pickle 头本身已经算进去了，
 * 写成 16 会整体偏移 8 字节，读出来全是乱码。
 *
 * ## 必须绕开 Electron 的 asar 虚拟文件系统
 *
 * DSH 桌面端是 Electron 跑的，Electron 的 fs 把 `.asar` 路径当成**虚拟目录**：
 *   fs.openSync('.../app.asar','r')  → ENOENT（"not found in ...\app.asar"）
 *   fs.statSync('.../app.asar').size → 0
 * 同一段代码在普通 Node 下完全正常。后果是「命令行自检全绿、DSH 里却读不到」。
 *
 * 解法：临时把 `process.noAsar` 置 true，fs 退回真实文件系统语义。
 * 用 defineProperty 而不是直接赋值：某些 Electron 版本把它定义成只读访问器，
 * 严格模式（ESM）下直接赋值会抛 TypeError。改不动就返回空还原函数。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 以「真实文件」语义打开 asar 归档。
 * @param {string} asarPath
 * @returns {number} fd
 */
export function openArchiveFd(asarPath) {
  const restore = disableAsar();
  try {
    return fs.openSync(asarPath, 'r');
  } finally {
    restore();
  }
}

/**
 * 临时关掉 Electron 的 asar 接管，返回还原函数。
 * @returns {() => void}
 */
function disableAsar() {
  const original = Object.getOwnPropertyDescriptor(process, 'noAsar');
  try {
    Object.defineProperty(process, 'noAsar', {
      value: true, configurable: true, writable: true, enumerable: false,
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (original) Object.defineProperty(process, 'noAsar', original);
      else delete process.noAsar;
    } catch { /* 还原失败也别把读取搞崩 */ }
  };
}

/**
 * 从一个已打开的 fd 里解析 asar 头。
 * @param {number} fd
 * @returns {{header:object, dataOffset:number}}
 */
export function parseHeaderFromFd(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  return { header: JSON.parse(jsonBuf.toString('utf8')), dataOffset: 8 + headerSize };
}

/**
 * 读 asar 头（**不经过缓存** —— 缓存层在 asar-cache.js）。
 * @param {string} asarPath
 * @returns {{header:object, dataOffset:number}}
 */
export function readAsarHeader(asarPath) {
  const fd = openArchiveFd(asarPath);
  try {
    return parseHeaderFromFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 只读 16 字节的 pickle 头，算出数据区起点。
 * 这是「不解析 4.76 MB header JSON」就能拿到的唯一信息 —— 一次 16 字节读，~0.05 ms。
 * @param {string} asarPath
 * @returns {number} dataOffset
 */
export function readDataOffset(asarPath) {
  const fd = openArchiveFd(asarPath);
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return 8 + head.readUInt32LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

/** 在 header 里按 `/` 分隔路径找条目；目录返回 null。 */
export function findEntry(header, innerPath) {
  let node = header;
  for (const seg of String(innerPath ?? '').split('/').filter(Boolean)) {
    if (!node || !node.files || !node.files[seg]) return null;
    node = node.files[seg];
  }
  return node && node.files ? null : node;
}

/** 列出所有文件条目（递归）。 */
export function listEntries(header, prefix = '', out = []) {
  for (const [name, child] of Object.entries(header?.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) listEntries(child, p, out);
    else out.push({ path: p, size: child.size || 0, offset: child.offset || '0' });
  }
  return out;
}

/**
 * 用**已经拿到的 header** 读出 asar 内某个文件的内容。
 *
 * 这条路径是缓存快路径的核心：header 来自磁盘缓存，就不必再解析 4.76 MB 的 JSON；
 * 连打开 182 MB 归档都省掉时（条目缓存命中），连 fd 都不用开。
 *
 * @param {string} asarPath
 * @param {object} header 已解析的 asar header
 * @param {number} dataOffset 数据区起点（8 + headerSize）
 * @param {string} innerPath asar 内路径，用 `/` 分隔
 * @returns {Buffer|null}
 */
export function readAsarFileWithHeader(asarPath, header, dataOffset, innerPath) {
  const entry = findEntry(header, innerPath);
  if (!entry) return null;
  const size = Number(entry.size ?? 0);
  const offset = Number.parseInt(String(entry.offset ?? '0'), 10) || 0;
  let fd = null;
  try {
    fd = openArchiveFd(asarPath);
    const buf = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, buf, 0, size, dataOffset + offset);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已经关了就算了 */ }
    }
  }
}

/**
 * 从 asar 里读出一个文件的内容（自己解析 header）。
 * @param {string} asarPath
 * @param {string} innerPath
 * @returns {Buffer|null}
 */
export function readAsarFile(asarPath, innerPath) {
  try {
    const { header, dataOffset } = readAsarHeader(asarPath);
    return readAsarFileWithHeader(asarPath, header, dataOffset, innerPath);
  } catch {
    return null;
  }
}

/**
 * 从 asar 里读一个 JSON 文件；不存在或解析失败都返回 null，不抛。
 * @param {string} asarPath
 * @param {string} innerPath
 * @returns {object|null}
 */
export function readAsarJson(asarPath, innerPath) {
  try {
    const buf = readAsarFile(asarPath, innerPath);
    if (!buf || !buf.length) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 把「用户给的 installDir」归一化成「安装目录」。
 *
 * CLI 的 `--install-dir` 常见写法直接指到 `resources/app.asar`（那个文件），
 * 而主插件的 findInstallDir 认的是**目录**。不归一化的话，
 * 「找不到 resources/app.asar」会被当成「这个机器上没装 DSH」——结论直接反了。
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeInstallDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let s = raw;
  try {
    if (fs.existsSync(s) && fs.statSync(s).isFile()) {
      s = path.dirname(s);
    }
  } catch { /* stat 失败就按字符串处理 */ }
  if (path.basename(s).toLowerCase() === 'app.asar') s = path.dirname(s);
  if (path.basename(s).toLowerCase() === 'resources') s = path.dirname(s);
  return s;
}
