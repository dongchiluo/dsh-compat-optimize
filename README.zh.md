# dsh-compat-optimize

[English](README.md)

> DSH 本地插件兼容性体检的**快路径**：磁盘缓存预热 + 紧凑结论 + **零 token 的离线 CLI**。

本插件是 `dsh-compat-check`（`compat_check` 工具）的**性能与成本侧补充**：
装了它，就复用它的判定代码、报告格式与缓存格式，不重复实现体检逻辑；
**没装也能独立工作**，此时走内置的等价兜底实现（输出里标注 `source: "fallback"`）。

---

## 1. 为什么要有它

`compat_check` 每次都以 **LLM 工具调用**的形态进入会话，于是：

| 环节 | 现状 | 本插件的做法 |
| --- | --- | --- |
| 工具 schema | 每请求随 `tools[]` 重发（compat_check 1,198 字符 ≈ 774–950 token） | `compat_optimize` 的 DESCRIPTION 压到 104 字符、参数描述再瘦身（工具定义 942 字符 ≈ 236 token）；`deferLoading: true` 只延迟「可调用时机」，**不省 token** |
| 一次体检 | 4–8 轮往返，每轮 input 40–100K token | `action=run` 一次返回摘要 + 报告路径 + 报告正文，**不用再追问** |
| 本地计算 | 283–552 ms，其中 **69% 是重复解析 174 MB `app.asar` 的 4.76 MB header** | 头解析结果落盘，跨进程复用；实测冷 183 ms → 热 85 ms |
| 离线体检 | 只能通过模型触发 | `bin/compat-check-cli.mjs`：**0 token**、可进 CI / 定时任务 |

---

## 2. 安装

把仓库放进 DSH 的插件目录（默认 `<baseDir>/plugins/`，`baseDir` 取
`$DSH_COMPAT_BASE_DIR` / `$DSH_HOME` / 用户主目录）即可，无需构建、无运行时依赖：

```
<baseDir>/plugins/dsh-compat-optimize/
├─ lib/            核心实现（不依赖 LLM，可脱离 DSH 用裸 node 跑）
├─ bin/            compat-check-cli.mjs —— 离线 CLI
├─ cordis.patch.yml   组合包 patch（配置默认值）
├─ package.json
└─ _selftest.mjs   离线自检（47 项断言）
```

```bash
git clone https://github.com/dongchiluo/dsh-compat-optimize.git <baseDir>/plugins/dsh-compat-optimize
```

被 DSH 加载时注册一个工具：**`compat_optimize`**（插件 id `tool-compat-optimize`）。

配置（`cordis.patch.yml` 里的默认值，可在自己的 profile 里按 id 覆盖 —— **覆盖是替换不是合并，少写一项就回到 schema 默认值**）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseDir` | 空 = `$DSH_COMPAT_BASE_DIR` / `$DSH_HOME` / 用户主目录 | 工作区根 |
| `pluginsDir` | 空 = `baseDir/plugins` | 插件目录 |
| `installDir` | 空 = 自动探测 | DSH 安装目录（可指到 `resources/app.asar`） |
| `outDir` | 空 = `baseDir/out/compat` | 报告落盘目录 |
| `cacheDir` | 空 = `baseDir/.cache/compat-check` | 缓存目录（**与主插件共用**） |
| `iterations` | `5` | `bench` 连跑几次 |
| `warmOnStart` | `false` | 启动时预热缓存 |
| `notesCacheTtlMs` | `21600000`（6 小时） | 上游响应缓存 TTL |
| `mainPluginDir` | 空 = 同级兄弟 `dsh-compat-check` | 主插件目录 |
| `deferLoading` | `true` | 工具延迟加载（**不省 token**：宿主照样投影工具定义；它延迟的是「模型现在能不能直接调它」） |

---

## 3. CLI 用法（0 token 的关键交付物）

```bash
node bin/compat-check-cli.mjs [子命令] [选项]
```

**子命令**（可省，默认 `check`）：`check` / `status` / `warm` / `notes` / `bench`

| 选项 | 说明 |
| --- | --- |
| `--plugins-dir <dir>` | 插件目录（默认 `<baseDir>/plugins`） |
| `--install-dir <dir>` | DSH 安装目录（可指到 `resources/app.asar`，自动归一化） |
| `--out-dir <dir>` | 报告落盘目录（默认 `<baseDir>/out/compat`） |
| `--cache-dir <dir>` | 缓存目录（默认 `<baseDir>/.cache/compat-check`） |
| `--json` | 输出机器可读 JSON |
| `--warm` | 先预热缓存再体检 |
| `--network` | 允许联网（只影响上游预热与 `--notes` 回源） |
| `--offline` | 强制不联网 |
| `--refresh` | 忽略缓存强制回源（联网） |
| `--notes` | 查上游 DSH 版本 |
| `--bench [N]` | 连跑 N 次并输出耗时统计（默认 5） |
| `--source <s>` | `plugin`（默认，复用主插件 runAction）/ `optimized` / `fallback` |

**退出码**：`0` = 没有 broken 插件；`1` = 有 broken 插件（宿主闸门不过，DSH 会跳过）；`2` = 运行错误。

### 常用例子

```bash
# 一次体检（人话输出 + 报告落盘 + 耗时）
node bin/compat-check-cli.mjs check

# 机器可读（进 CI）
node bin/compat-check-cli.mjs check --json

# 预热后再体检（最快路径）
node bin/compat-check-cli.mjs warm && node bin/compat-check-cli.mjs check

# 量化优化效果
node bin/compat-check-cli.mjs bench --bench 10

# 只看缓存状态（纯离线）
node bin/compat-check-cli.mjs status
```

CLI **零 LLM 依赖**、**零网络**（只有显式 `--notes` / `--refresh` / `--network` 才联网）。

---

## 4. 工具 `compat_optimize`

| action | 做什么 | 联网 |
| --- | --- | --- |
| `status` | 缓存状态：asar 头缓存的条目/大小/是否仍有效、上游缓存新鲜度、上一次体检摘要 | 否（纯离线） |
| `warm` | 预热：解析 `app.asar` 头并写缓存，顺带预热条目缓存 | 默认否（显式 `withNetwork: true` 才预热上游） |
| `run` | 跑一次体检，返回**紧凑摘要 + 报告路径 + 报告正文（截断 ~40 行）** | 否 |
| `bench` | 连跑 N 次，输出中位/最小/最大耗时（ms） | 否 |
| `notes` | 查上游版本（GitHub Release + npm registry），**优先走缓存** | 缓存未命中时回源（`withNetwork: false` 可强制离线） |

入参：`action`（必填）、`installDir`、`pluginsDir`、`outDir`、`cacheDir`、`iterations`、`refresh`、`withNetwork`、`source`。

> `withNetwork` 是**三态**的：缺省由动作决定（`notes` 允许、`warm` 不允许）；给 `false` 强制离线；给 `true` 明确允许联网。

工具的 `render` 输出**包含报告正文**，所以模型拿到一次 `run` 的结果就能下结论，不必再追问一轮。

---

## 5. 缓存目录

默认 `<baseDir>/.cache/compat-check/`；若同时装了 `dsh-compat-check`，**两边共用同一份缓存**
（磁盘格式逐字段一致，互不失效、互相命中）：

```
.cache/compat-check/
├─ asar-header\<sha1(resolve(asarPath))>.json   4.76 MB 的 asar 头
├─ asar-entry\<sha1(resolve(asarPath)|innerPath)>.json   归档内小文件（≤512 KB 才缓存）
├─ upstream\<sha1(url)>.json                     GitHub / npm 响应，TTL 6 小时
└─ last-run.json                                 本插件记录的「上一次体检」
```

判活规则：

* asar 头/条目 —— `formatVersion === 2` 且**内容指纹**（文件头 64 KB 的 sha1）和当前文件一致才算命中；
  DSH 升级换了 `app.asar`，指纹就变了，缓存自动作废。
* 上游 —— `Date.now() - fetchedAt < ttlMs`（默认 6 小时）。

> **为什么不是 `size` + `mtimeMs`？**
> DSH 桌面端是 Electron 跑的，Electron 把 `.asar` 当虚拟目录接管，
> 进程内 `fs.statSync('app.asar')` 返回的是**合成 stat**：`size=0`、
> `mtimeMs=进程启动时刻`（2026-11-02 在真实宿主里实测到的）。
> 拿 `size`+`mtimeMs` 判活，磁盘缓存每次都被判成「已失效」——
> 这条优化在生产环境等于白做。内容指纹不依赖 stat，宿主内外一致。

> **格式约定（与主插件共享）**：缓存条目是 JSON，字段为
> `{"formatVersion":2,"asarPath":"…","size":N,"mtimeMs":N,"fingerprint":"sha1","header":{…},"dataOffset":N}`
> （头）、`{"formatVersion":2,…,"fingerprint":"sha1","dataB64":"…"}`（条目）、
> `{"formatVersion":1,"url":"…","fetchedAt":N,"ttlMs":N,"status":N,"ok":true,"payload":"…"}`（上游）。
> sha1 用 node 内置 `crypto.createHash('sha1')`。

---

## 6. 常见问题

**Q：缓存会不会读到旧版本的 `app.asar`？**
不会。缓存判活看的是**内容指纹**（文件头 64 KB 的 sha1），DSH 升级换了归档指纹必变，缓存自动作废。
（不用 `size`+`mtimeMs` 是因为宿主进程里 `app.asar` 的 stat 是 Electron 合成的假值。）

**Q：`notes` 说「上游读不到」，是不是意味着没有更新？**
**不是。** 读不到（没网、限流、TTL 外又断网）只会被如实报成「读不到」，
绝不会渲染成「已是最新」。想确证就显式联网：`--notes --network`。

**Q：CLI 会不会偷偷联网？**
不会。`check` / `status` / `bench` 全程离线；只有 `--notes` / `--refresh` / `--network` 才联网。

**Q：自检怎么跑？**
`node _selftest.mjs`（60 项左右断言，含缓存命中/失效、TTL、五个 action、插件注册、CLI 冒烟），退出码 0 = 全过。
临时产物写在系统临时目录下的 `dsh-compat-optimize-selftest`，可用 `DSH_COMPAT_OPTIMIZE_TMPDIR` 改。
自检不需要真实 DSH 安装：`app.asar` 相关断言会用脚本内生成的迷你归档，找不到宿主时自动跳过。

**Q：为什么这个工具在 DSH 里「看不见」？**
`deferLoading: true`（默认）让宿主在发 tool-addition 消息之前，模型不能直接调它。
注意它**不省 token** —— 工具定义照样每请求随 tools[] 发出（≈942 字符）。
省 token 靠的是把 DESCRIPTION 压短。想随时能调，就把 `deferLoading` 设成 false。

---

## 7. 参考实测（Windows 11 · 174 MB `app.asar` · Node 24）

| 场景 | 耗时 |
| --- | --- |
| `detectDsh` 无缓存（主插件默认，一次体检解析 4 次头） | 191 ms |
| `detectDsh` 冷缓存（解析一次 + 写缓存） | 87–118 ms |
| `detectDsh` 热缓存（跨进程命中条目缓存，不碰 4.76 MB 头） | 19 ms |
| CLI `check` 冷启动（空缓存目录） | **183 ms** |
| CLI `check` 命中缓存 | **85–89 ms** |
| `checkPlugins`（扫 7 个插件，热路径的主要开销） | 57–76 ms |

---

## 8. 文件清单

```
lib/asar-reader.js     自包含 ASAR 只读器（不依赖主插件）
lib/asar-cache.js      asar 头/条目磁盘缓存（格式与主插件一致）
lib/upstream-cache.js  上游响应磁盘缓存（TTL 判活）
lib/upstream.js        缓存优先的取数层（node 内置 fetch）
lib/main-plugin.js     动态加载同级主插件 dsh-compat-check 的 lib
lib/check.js           体检编排（plugin / optimized / fallback 三种来源）
lib/fallback-check.js  自实现的兜底体检（主插件不在时用）
lib/semver-lite.js     极简 semver（兜底路径用）
lib/warm.js            缓存预热
lib/notes.js           上游版本对账
lib/tool.js            工具动作实现（status/warm/run/bench/notes）
lib/index.js           cordis 插件入口（注册 compat_optimize）
bin/compat-check-cli.mjs  离线 CLI
cordis.patch.yml       组合包 patch（配置默认值）
_selftest.mjs          离线自检
scripts/sanitize-check.mjs  发布前脱敏检查（CI 也跑）
```
