# dsh-compat-optimize

[中文说明](README.zh.md)

Fast path for **DSH plugin compatibility checks**: warm disk caches, one-shot compact reports,
and a **zero-token offline CLI**.

A DSH plugin plus a standalone Node CLI. No build step, no runtime dependencies.

```bash
node bin/compat-check-cli.mjs check          # 0 token, exit code is the verdict
```

---

## 1. Why

`compat_check` (from `dsh-compat-check`) is an LLM tool: every call re-sends the tool schema,
a single check usually takes 4–8 round trips at 40–100K input tokens each — while all the work
it does is local. This plugin keeps the same verdicts and removes the round trips:

| Stage | Before | With this plugin |
| --- | --- | --- |
| Tool schema | Re-sent with `tools[]` on every request (1,198 chars) | `compat_optimize` description trimmed to 104 chars (tool definition ≈ 942 chars) |
| One check | 4–8 round trips | `action=run` returns summary + report path + report body in one shot |
| Local compute | 283–552 ms, **69%** spent re-parsing the 4.76 MB `app.asar` header | Header parsed once, cached on disk and reused across processes (183 ms cold → 85 ms warm) |
| Offline / CI | Only reachable through the model | `bin/compat-check-cli.mjs` — 0 tokens, cron/CI friendly |

`deferLoading` does **not** save tokens: the host still projects the tool definition into every
request. Shrinking the description is what saves them.

---

## 2. Install

Drop the repository into your DSH plugins directory (default `<baseDir>/plugins`).
No build, no `npm install` required:

```bash
git clone https://github.com/dongchiluo/dsh-compat-optimize.git <baseDir>/plugins/dsh-compat-optimize
```

`<baseDir>` resolves to `$DSH_COMPAT_BASE_DIR`, then `$DSH_HOME`, then your home directory.
Nothing is hard-coded to a specific machine:

```bash
DSH_COMPAT_BASE_DIR=/opt/dsh node bin/compat-check-cli.mjs check
```

Loaded by DSH, the plugin registers one tool: **`compat_optimize`** (plugin id `tool-compat-optimize`).

### Configuration

Defaults live in `cordis.patch.yml` and can be overridden per plugin id in your own profile
(**override replaces, it does not merge** — omit a field and it falls back to the schema default).

| Field | Default | Meaning |
| --- | --- | --- |
| `baseDir` | empty = `$DSH_COMPAT_BASE_DIR` / `$DSH_HOME` / home | Root for plugins, reports and cache |
| `pluginsDir` | empty = `baseDir/plugins` | Plugin directory to check |
| `installDir` | empty = auto-detect | DSH install dir (may point at `resources/app.asar`) |
| `outDir` | empty = `baseDir/out/compat` | Where reports are written |
| `cacheDir` | empty = `baseDir/.cache/compat-check` | Cache directory (shared format with `dsh-compat-check`) |
| `iterations` | `5` | `bench` iterations |
| `warmOnStart` | `false` | Warm the cache when the plugin starts |
| `notesCacheTtlMs` | `21600000` (6 h) | Upstream response cache TTL |
| `mainPluginDir` | empty = sibling `dsh-compat-check` | Where to load the upstream check logic from |
| `deferLoading` | `true` | Defer tool visibility (does **not** save tokens) |

---

## 3. CLI (the zero-token deliverable)

```bash
node bin/compat-check-cli.mjs [command] [options]
```

Commands: `check` (default) · `status` · `warm` · `notes` · `bench`

| Option | Meaning |
| --- | --- |
| `--plugins-dir <dir>` | Plugin directory (default `<baseDir>/plugins`) |
| `--install-dir <dir>` | DSH install dir (may point at `resources/app.asar`) |
| `--out-dir <dir>` | Report directory (default `<baseDir>/out/compat`) |
| `--cache-dir <dir>` | Cache directory (default `<baseDir>/.cache/compat-check`) |
| `--json` | Machine-readable output |
| `--warm` | Warm the cache before checking |
| `--network` / `--offline` / `--refresh` | Network policy (off by default) |
| `--notes` | Compare against upstream DSH releases |
| `--bench [N]` | Repeat N times and report timings |
| `--source <s>` | `plugin` (default) · `optimized` · `fallback` |

**Exit codes:** `0` no broken plugins · `1` broken plugin found · `2` runtime error.

```bash
node bin/compat-check-cli.mjs check --json          # CI gate
node bin/compat-check-cli.mjs warm && node bin/compat-check-cli.mjs check
node bin/compat-check-cli.mjs bench --bench 10
```

The CLI never touches the network unless `--notes`, `--refresh` or `--network` is given.

---

## 4. Tool actions

| `action` | What it does | Network |
| --- | --- | --- |
| `status` | Cache state: header entries, freshness, last run summary | No |
| `warm` | Parse the `app.asar` header and persist it | No (unless `withNetwork: true`) |
| `run` | Run a check, return compact summary + report path + report body | No |
| `bench` | Run N times, report median/min/max | No |
| `notes` | Compare against upstream GitHub release + npm registry | On cache miss |

Parameters: `action` (required), `installDir`, `pluginsDir`, `outDir`, `cacheDir`, `iterations`,
`refresh`, `withNetwork`, `source`.

---

## 5. Cache layout

Default `<baseDir>/.cache/compat-check/`, byte-compatible with `dsh-compat-check`:

```
.cache/compat-check/
├─ asar-header/<sha1(resolve(asarPath))>.json      4.76 MB asar header
├─ asar-entry/<sha1(resolve(asarPath)|innerPath)>.json   small archived files (≤512 KB)
├─ upstream/<sha1(url)>.json                       GitHub / npm responses, TTL 6 h
└─ last-run.json                                   last check recorded by this plugin
```

Entries are validated by a **content fingerprint** (sha1 of the first 64 KB), not by `size` +
`mtimeMs`: inside Electron, `fs.statSync('app.asar')` returns a synthetic stat (`size=0`,
`mtimeMs` = process start), which would invalidate the cache on every run.

---

## 6. Self-test

```bash
node _selftest.mjs        # exit code 0 = all assertions passed
```

~60 assertions covering cache hits/misses, TTL edges, all five actions, plugin registration and a
CLI smoke test. Temporary artifacts go to the OS temp dir (`DSH_COMPAT_OPTIMIZE_TMPDIR` to override).
Everything runs without a DSH installation; the two assertions that import the DSH host packages
(`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`) are skipped when those packages are not resolvable.

---

## 7. Benchmarks (Windows 11, Node 24)

Measured with `node bin/compat-check-cli.mjs check --json` (`elapsedMs`); the `checkPlugins` row is the
median of 40 direct `checkPluginsFallback()` calls. Fixtures are synthetic plugin directories, each with
`engines.dsh` plus three `@deepseek-ai/*` peer declarations — the shape of a real desktop install.

| Scenario | 20 plugins | 120 plugins |
| --- | --- | --- |
| `checkPlugins` (scan only) | 4.8 ms | 26.6 ms |
| CLI `check` end-to-end | **10 ms** | **36–46 ms** |

That is **0.22–0.38 ms per plugin** — the real hot path on Windows.

Why it dominates: every plugin costs at least one `stat`, one `readFileSync` and one `JSON.parse`, plus
up to 8 directory levels scanned per `@deepseek-ai/*` declaration while looking for vendored host copies.
On Windows those syscalls go through NTFS and Defender's real-time scan, far slower than Linux's dentry
cache; pnpm/bun `node_modules/.pnpm` symlink farms make path resolution worse (the scan skips
`node_modules` and dot-directories).

**Optimization measured and rejected**: caching `exists`/`readJson` in a per-run Map moved 20 and 120
plugins from 4.76 → 4.77 ms and 26.58 → 26.85 ms — noise. Windows' directory cache is already fast;
**repeated `stat` is not the bottleneck, the plugin count is.** To move it, narrow the scan with
`include` or keep checks off the hot path (`warm` + `status`).

asar numbers (174 MB `app.asar`, DSH installed): 191 ms uncached → 87–118 ms cold cache → 19 ms warm;
CLI `check` 183 ms cold → 85–89 ms cached.

## 8. Requirements

- Node.js ≥ 20 (uses built-in `fetch`, `node:test`-free plain assertions)
- DSH `>=0.2.1-rc.5 <0.3.0` when used as a plugin
- Optional: `dsh-compat-check` — without it the built-in fallback is used

---

## License

[MIT](LICENSE)
