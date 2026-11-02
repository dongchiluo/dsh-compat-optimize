#!/usr/bin/env node
/**
 * scripts/sanitize-check.mjs —— 发布前的脱敏闸门（零依赖）。
 *
 * 扫的是 **git 已跟踪 / 已暂存的文件**，不是整个目录 —— 只看真正会被推上去的东西。
 * 命中任何一条规则就以退出码 1 失败，可直接当 CI 门禁或 pre-commit 钩子。
 *
 * 用法：
 *   node scripts/sanitize-check.mjs            # 检查 git ls-files（工作区内容）
 *   node scripts/sanitize-check.mjs --staged   # 只看暂存区（pre-commit 用）
 *   node scripts/sanitize-check.mjs --json     # 机器可读
 *   node scripts/sanitize-check.mjs --quiet    # 只输出结论
 *
 * 退出码：0 干净 · 1 有命中 · 2 运行错误（不在 git 仓库里等）。
 *
 * 规则是**启发式**的：它只负责把可疑点摆到你面前，最终判断仍在人。
 * 需要一次性豁免时，把正则写进 `.sanitizeignore`（每行一条，`#` 开头为注释）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 二进制/生成物：不逐行扫。 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.asar', '.node', '.exe', '.dll', '.so', '.dylib',
]);

/** 本文件自己就写着这些模式，不扫。 */
const SKIP_FILES = new Set(['scripts/sanitize-check.mjs']);

/**
 * 规则表。
 * `allow(match, line)` 返回 true 表示这一条不算问题（通用系统路径、示例占位符等）。
 */
const RULES = [
  {
    id: 'win-abs-path',
    label: 'Windows 绝对路径（可能暴露本机目录结构 / 用户名）',
    // 盘符开头 + 至少一段路径；排除 %VAR% 形式的可移植写法。
    re: /\b[A-Za-z]:[\\/][A-Za-z0-9_.\-\\/ ]{2,}/g,
    allow: (m) => /^[A-Za-z]:[\\/](Program Files|Program Files \(x86\)|Windows|ProgramData|Temp|tmp)\b/i.test(m),
  },
  {
    id: 'user-home',
    label: '用户目录（暴露本机账户名）',
    re: /[\\/]Users[\\/](?!Public\b|Default\b|%)([A-Za-z0-9._-]{2,})/g,
  },
  {
    id: 'private-scope',
    label: '私有/本地 npm 作用域',
    re: /@(?:local|internal|corp|company)\//gi,
  },
  {
    id: 'github-token',
    label: 'GitHub token 形态的字符串',
    re: /gh[pousr]_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'openai-token',
    label: 'API key 形态的字符串',
    re: /\bsk-[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'aws-key',
    label: 'AWS access key 形态的字符串',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'private-key',
    label: '私钥文件内容',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'bearer',
    label: '硬编码的 Bearer token',
    re: /Bearer\s+[A-Za-z0-9._\-]{16,}/g,
  },
  {
    id: 'private-ip',
    label: '内网 IP',
    re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    id: 'personal-email',
    label: '疑似个人邮箱（提交里建议用 noreply 地址）',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: (m) => /@(users\.noreply\.github\.com|example\.(com|org|net)|localhost)$/i.test(m),
  },
];

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const opt = {
  staged: argv.includes('--staged'),
  json: argv.includes('--json'),
  quiet: argv.includes('--quiet'),
};

/* ------------------------------------------------------------------ *
 * 待扫描文件清单
 * ------------------------------------------------------------------ */
function listFiles() {
  const args = opt.staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files'];
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    process.stderr.write(`无法读取 git 文件列表：${e?.message ?? e}\n`);
    process.exit(2);
  }
}

/** 读 `.sanitizeignore`（每行一条正则）。 */
function loadIgnore() {
  const file = path.join(ROOT, '.sanitizeignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => {
      try { return new RegExp(s); } catch { return null; }
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */
const findings = [];
const ignore = loadIgnore();

for (const rel of listFiles()) {
  if (SKIP_FILES.has(rel)) continue;
  if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue; // 读不了（权限/编码）就跳过，不制造假阳性
  }
  if (text.includes('\u0000')) continue; // 二进制

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const frag = m[0];
        if (!rule.allow || !rule.allow(frag, line)) {
          if (ignore.some((re) => re.test(frag) || re.test(line))) continue;
          findings.push({ file: rel, line: i + 1, rule: rule.id, label: rule.label, match: frag });
        }
        if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1; // 防零宽死循环
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
if (opt.json) {
  process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
} else if (findings.length === 0) {
  if (!opt.quiet) process.stdout.write('脱敏检查通过：未发现本机路径 / 凭据 / 内网地址。\n');
} else {
  process.stdout.write(`脱敏检查发现 ${findings.length} 处可疑内容：\n\n`);
  for (const f of findings) {
    const frag = f.match.length > 120 ? `${f.match.slice(0, 117)}...` : f.match;
    process.stdout.write(`  ${f.file}:${f.line}  [${f.rule}] ${f.label}\n      ${frag}\n`);
  }
  process.stdout.write('\n处理方式：改代码去掉硬编码，或写进 .sanitizeignore 一次性豁免。\n');
}

process.exit(findings.length === 0 ? 0 : 1);
