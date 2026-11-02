/**
 * lib/output-schema.js —— `compat_optimize` 工具的输出 schema（单独一个文件）。
 *
 * ## 为什么要单独一个文件
 *
 * 宿主会用 `additionalProperties: false` **严格校验工具返回值**：
 * 返回里出现一个 schema 没声明的键，整条工具调用就失败，报
 * `"value.xxx" is not a declared property (additionalProperties: false)`。
 *
 * 所以「返回了哪些键」和「声明了哪些键」必须能放在一起核对 ——
 * 把 schema 埋在 lib/index.js 的 apply() 里就没法自检了，所以抽出来。
 * `_selftest.mjs` 会跑遍每个 action，逐个拿宿主的 validateJsonSchemaValue 校验。
 *
 * ## `type: 'json'` 是什么
 *
 * 宿主 schema DSL 的一个作者级节点。编译后**不带 type**，校验时只要求
 * 「是个 lossless JSON 值」—— 用来表达「同一个键在不同 action 下形状不同」。
 *
 * 例如 `upstream`：status 返回统计对象（count/bytes/entries），
 * warm 返回上游条目数组。写成 object 或 array 都会在另一个 action 上炸。
 *
 * @see lib/index.js —— 工具注册处使用本 schema
 */

/** `compat_optimize` 的输出 schema。 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /* ---- 所有 action 共用 ---- */
    action: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
    /** 报告正文（截断到约 40 行）—— 模型一次就能拿到结论，不必再追问。 */
    reportExcerpt: { type: 'string' },
    reportPath: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    /** 本次体检耗时（毫秒）。 */
    elapsedMs: { type: 'number' },
    /** 体检逻辑来源：optimized（缓存快路径）/ plugin（主插件 runAction）/ fallback（自实现）。 */
    source: { type: 'string' },
    sourceDetail: { type: 'string' },
    /** 这次体检用的缓存目录。 */
    cacheDir: { type: 'string' },
    dshVersion: { type: 'string' },
    pluginsDir: { type: 'string' },

    /* ---- action=run ---- */
    /** 体检结论统计。三个来源（plugin / optimized / fallback）字段可能不同，所以子字段不设 required。 */
    stats: {
      type: 'object',
      additionalProperties: true,
      properties: {
        plugins: { type: 'integer' },
        ok: { type: 'integer' },
        stale: { type: 'integer' },
        shadowed: { type: 'integer' },
        broken: { type: 'integer' },
      },
    },
    /** 主插件（dsh-compat-check）的版本号。 */
    mainPluginVersion: { type: 'string' },
    /** 失败原因；成功时为 null。 */
    error: { type: 'json', description: '失败时的错误信息；成功时为 null。' },

    /* ---- action=status ---- */
    /** status 是纯离线的：没有网络。 */
    offline: { type: 'boolean' },
    /** asar 头缓存统计（条目数 / 字节数 / 有效数 / 失效数）。 */
    asarHeader: { type: 'object', additionalProperties: true },
    /** asar 条目缓存统计。 */
    asarEntry: { type: 'object', additionalProperties: true },
    /** 上一次体检的记录；本机还没有记录时是 null。 */
    lastRun: { type: 'json', description: '上一次体检记录；本机还没有记录时为 null。' },

    /* ---- action=warm ---- */
    /** 被预热的 app.asar 路径。 */
    asarPath: { type: 'string' },
    /** 探测到的 DSH 安装目录。 */
    installDir: { type: 'string' },
    /** asar 头预热结果（是否命中缓存 / 是否解析成功 / 字节数）。 */
    header: { type: 'object', additionalProperties: true },
    /** 预热到的 asar 条目列表。 */
    entries: { type: 'array', items: { type: 'object', additionalProperties: true } },

    /* ---- action=bench ---- */
    iterations: { type: 'number' },
    medianMs: { type: 'number' },
    minMs: { type: 'number' },
    maxMs: { type: 'number' },
    timesMs: { type: 'array', items: { type: 'number' } },

    /* ---- action=notes ---- */
    status: { type: 'string' },
    installed: { type: 'string' },
    latest: { type: 'string' },
    behind: { type: 'boolean' },
    /** 两个上游来源（GitHub / npm）各自的交代。 */
    sources: { type: 'array', items: { type: 'object', additionalProperties: true } },

    /* ---- 跨 action 形状不定的键 ---- */
    /**
     * status 时是上游缓存的统计对象（count/bytes/entries），
     * warm 时是上游条目数组 —— 两种形状都合法，所以不写死 type。
     */
    upstream: { type: 'json', description: 'status 返回上游缓存统计对象；warm 返回上游条目数组。' },
  },
};

export default OUTPUT_SCHEMA;
