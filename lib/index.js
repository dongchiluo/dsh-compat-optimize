/**
 * dsh-compat-optimize —— 「DSH 本地插件兼容性体检」的快路径与离线化（注册为 `compat_optimize` 工具）。
 *
 * 解决的问题：`compat_check` 每次都以 **LLM 工具调用**的形态进会话 ——
 * 每轮都要重发工具 schema（compat_check 定义 1,198 字符 ≈ 774–950 token），
 * 一次体检通常 4–8 轮往返，每轮 input 40–100K token。而它做的事其实全是本地的。
 *
 * 实测的账：一次 `compat_check action=check` 本地计算只要 283–552 ms，
 * 其中 **69% 是重复解析 174 MB app.asar 的头**（4.76 MB 的 JSON，每次 50–60 ms，一次体检解析 4 次）。
 *
 * 所以这里做三件事：
 *   1. **磁盘缓存**：asar 头 / asar 条目 / 上游响应都落盘（与主插件**共用同一份格式**，两边互不失效）；
 *   2. **一次给全结论**：`run` 一次返回「摘要 + 报告路径 + 报告正文（截断 40 行）」，
 *      模型不必再追问一轮；
 *   3. **完全脱离 LLM**：`bin/compat-check-cli.mjs` 是可直跑的 CLI，0 token、可进 CI。
 *
 * 插件契约：cordis 通过具名导出读取 name / inject / Config / apply。
 * 逻辑全在 lib/tool.js（不打印、不退出）；这里只做工具注册。
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ACTIONS, DESCRIPTION, PARAMETERS, runAction } from './tool.js';
import { defaultCacheDir } from './asar-cache.js';
import { defaultBaseDir } from './paths.js';
import { OUTPUT_SCHEMA } from './output-schema.js';

/** 插件 id，在 cordis.patch.yml 中用它做条目 id 引用。 */
export const name = 'tool-compat-optimize';

/** 需要的宿主服务。 */
export const inject = ['tools'];

/** 部署期可调参数。 */
export const Config = z.object({
  /** 工作区根目录；缺省取 $DSH_COMPAT_BASE_DIR / $DSH_HOME / 用户主目录。 */
  baseDir: z.string().default(defaultBaseDir()),
  /** 插件目录；缺省取 baseDir 下的 plugins。 */
  // 用 .required(false) 而不是 .optional()：schemastery 3.18.x 没有 optional 方法。
  pluginsDir: z.string().required(false),
  /** DSH 安装目录；留空表示自动探测（从进程路径与常见安装位置找）。 */
  installDir: z.string().required(false),
  /** 报告落盘目录；缺省取 baseDir 下的 out/compat。 */
  outDir: z.string().required(false),
  /** 缓存目录；留空取 baseDir 下的 .cache/compat-check（与主插件共用同一份）。 */
  cacheDir: z.string().required(false),
  /** bench 连跑几次；缺省 5。 */
  iterations: z.number().default(5),
  /** 启动时是否预热缓存（会解析一次 app.asar 头，约 50–60 ms）。 */
  warmOnStart: z.boolean().default(false),
  /** 上游响应缓存的存活时间（毫秒）；缺省 6 小时。 */
  notesCacheTtlMs: z.number().default(6 * 60 * 60 * 1000),
  /** 主插件目录；留空表示取同级兄弟目录 dsh-compat-check。 */
  mainPluginDir: z.string().required(false),
  /**
   * 工具可见性：是否延迟加载。
   *
   * **默认开**。注意它的真实语义（2026-11-02 在宿主源码里查实）：
   * `deferLoading` **不会**把工具定义从每轮请求的 tools[] 里去掉 ——
   * 宿主 `ToolRegistry.schemaOf` 照样投影它（只多带一个 `deferLoading: true` 标记），
   * 会话侧 `ToolHistory.snapshot()` 也照样把全部 active 工具发出去。
   * 它省的是「模型现在能不能直接调它」（延迟到宿主发 tool-addition 消息为止），
   * **不是**「每轮多少 token」。
   *
   * 真正省常驻 token 的是把 DESCRIPTION 压短（本插件 433 → 104 字符）。
   * 本插件每轮仍会带约 942 字符（≈236 token）的定义。
   */
  deferLoading: z.boolean().default(true),
});

/** 注册 `compat_optimize` 工具。 */
export function apply(ctx, config) {
  // Config 的可选键在没配时是 undefined —— 归一成空串，下游一律用 `x || 默认值` 取值。
  const cfg = {
    baseDir: defaultBaseDir(),
    ...config,
    pluginsDir: config?.pluginsDir ?? '',
    installDir: config?.installDir ?? '',
    outDir: config?.outDir ?? '',
    cacheDir: config?.cacheDir ?? '',
    iterations: config?.iterations ?? 5,
    warmOnStart: config?.warmOnStart === true,
    notesCacheTtlMs: config?.notesCacheTtlMs ?? 6 * 60 * 60 * 1000,
    mainPluginDir: config?.mainPluginDir ?? '',
    // 默认开：只显式给 false 才关（Config 里配成 false 或调用方传 false 都关）。
    deferLoading: config?.deferLoading !== false,
  };

  ctx.tools.register(defineTool({
    name: 'compat_optimize',
    description: DESCRIPTION,
    // 参数说明的唯一真相在 lib/tool.js 的 PARAMETERS —— 曾经 index.js 里另抄了一份，
    // 两份一漂就看不出工具定义到底多大；现在只留一处。
    parameters: PARAMETERS,
    output: {
      // schema 单独放在 lib/output-schema.js：自检要能把它和「实际返回的键」放在一起核对。
      schema: OUTPUT_SCHEMA,
      // render 必须带上报告正文 —— 只给 summary 的话模型还得再问一轮「报告呢」，
      // 那就等于没优化。
      render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
    },

    deferLoading: cfg.deferLoading,

    async execute(args) {
      return runAction(args.action, args, cfg);
    },

    presentCall: (args) => ({
      card: 'generic',
      title: `compat_optimize · ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  }));

  /* --- 启动预热（可选） --- */
  // 预热要在工具注册**之后**：工具本身必须先能用，预热只是让它更快。
  if (cfg.warmOnStart) {
    (async () => {
      try {
        const { warmCaches } = await import('./warm.js');
        const r = await warmCaches({
          installDir: cfg.installDir,
          // cacheDir 留空 = 落到 baseDir/.cache/compat-check（与主插件共用）
          cacheDir: cfg.cacheDir || defaultCacheDir(cfg.baseDir),
          withNetwork: false,
        });
        logTo(ctx, 'info', `[compat-optimize] 缓存预热完成：${r.elapsedMs} ms（asar 头 ${r.header.cached ? '命中' : r.header.parsed ? '已解析写入' : '未完成'}）`);
      } catch (e) {
        logTo(ctx, 'warn', `[compat-optimize] 缓存预热失败：${e?.message ?? e}`);
      }
    })();
  }
}

/**
 * 渲染工具输出文本：**摘要 + 报告正文 + 落盘路径**。
 *
 * @param {object} value 工具返回值
 * @returns {string}
 */
export function renderToolText(value) {
  if (!value) return '';
  const parts = [];
  if (value.summary) parts.push(String(value.summary));
  if (value.reportPath) parts.push(`\n报告已落盘：${value.reportPath}`);
  if (value.reportExcerpt) parts.push(`\n${String(value.reportExcerpt)}`);
  if (Array.isArray(value.warnings) && value.warnings.length) {
    parts.push(`\n提示：\n${value.warnings.map((w) => `- ${w}`).join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * 往宿主日志里写一行。
 *
 * ctx.logger 是可调用的 LoggerService（`ctx.logger('name')` 拿子 Logger），
 * 但自检里传进来的假 ctx 可能压根没有 logger —— 所以这里到处都要能安全地什么都不做。
 */
function logTo(ctx, level, msg) {
  try {
    const logger = ctx?.logger;
    if (!logger) return;
    if (typeof logger[level] === 'function') {
      logger[level](msg);
      return;
    }
    if (typeof logger === 'function') {
      logger('compat-optimize')?.[level]?.(msg);
    }
  } catch { /* 日志失败不该影响主线 */ }
}
