/**
 * Copy for the claude-mem configuration page.
 *
 * Dictionaries are registered at runtime through `ctx.locale.register`, which
 * keeps the page readable in whichever language the app runs in without the
 * package shipping JSON files the host would have to discover.
 * @module dsh-claude-mem/client/messages
 */

/** English dictionary and the key union every other language must cover. */
export const en = {
  summary: 'A DeepSeek Harness plugin that integrates claude-mem: query, context injection, manual save, and session lifecycle over a local claude-mem worker\'s HTTP API.',
  description: 'A DeepSeek Harness plugin that integrates claude-mem: query, context injection, manual save, and session lifecycle over a local claude-mem worker\'s HTTP API.',
  connectionTitle: 'Connection',
  workerUrl: 'Worker address',
  workerUrlHint: 'Leave empty to use the address claude-mem publishes when it starts.',
  test: 'Test connection',
  testing: 'Testing…',
  hookTitle: 'Launcher',
  hookPath: 'Executable',
  hookPathHint: 'The claude-mem entry point that records observations. Leave empty to use the platform default.',
  behaviorTitle: 'Behaviour',
  ingest: 'Record tool calls as memory',
  ingestHint: 'Tool results are kept as searchable memories.',
  summarize: 'Write a session summary when a turn ends',
  summarizeHint: 'claude-mem summarizes the turn each time a turn ends.',
  workState: 'Keep to-do lists and work state across sessions',
  workStateHint: 'Keeps to-do lists and work progress the next session picks up. Turning it off only removes that ability; the rest of memory is unaffected.',
  autoStartWorker: 'Start the worker when it is not running',
  fileContext: 'Bring memory into file reads',
  fileContextHint: 'Adds what memory already knows about the file you read.',
  fileContextGate: 'Refuse full reads of large files memory already covers',
  fileContextGateHint: 'DSH already caps one read at about 50 KB and resumes with offset/limit, so this buys only a little and is off by default. When on, a file the user names in their prompt is always allowed.',
  smart: 'Read code structurally through claude-mem',
  smartHint: 'Adds mem_smart_search / mem_smart_outline / mem_smart_unfold: a file outline and single-symbol source instead of whole files. The model calls them when it wants structure; scoped to the working directory.',
  corpora: 'Knowledge corpora',
  corporaHint: 'Adds the six mem_corpus_* tools: topic-scoped slices of memory you can ask questions about.',
  subagents: 'File delegated runs under the session that started them',
  subagentsHint: 'Work done by a delegated run is recorded under the session that started it, and archived when the run ends.',
  fileContextTools: 'File-context tools',
  effectiveList: 'In effect: {names}',
  fileContextToolsHint: 'Only used while “Bring memory into file reads” is on. Comma-separated; leave empty for the built-in default list ({names}).',
  advancedTitle: 'Advanced',
  toolFilter: 'Observed tools',
  toolFilterHint: 'Only used while “Record tool calls as memory” is on. Comma-separated; leave empty for the built-in default list ({names}).',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  discarded: 'Changes discarded',
  probeConnected: 'Connected · {version} · pid {pid} · observer {provider}',
  probeConnectedPlain: 'Connected',
  probeNotInitialized: 'Reachable, but the worker is not initialised',
  probeMcpUnavailable: 'Reachable, but MCP is not ready',
  probeUnhealthy: 'Reachable, but the worker reports “{status}”',
  probeHttp: 'The service answered HTTP {status}',
  probeNotWorker: 'Something answered, but it is not the claude-mem worker',
  probeUnreachable: 'Could not reach the worker (not running, or the wrong port)',
  unavailable: 'This page is unavailable until the plugin configuration loads.',
} as const

/** Keys the page renders. */
export type MessageKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<MessageKey, string> = {
  summary: '接入 claude-mem 的 DeepSeek Harness 插件：查询、上下文注入、手动保存，以及通过本地 claude-mem worker 的 HTTP API 处理会话生命周期。',
  description: '接入 claude-mem 的 DeepSeek Harness 插件：查询、上下文注入、手动保存，以及通过本地 claude-mem worker 的 HTTP API 处理会话生命周期。',
  connectionTitle: '连接',
  workerUrl: 'worker 地址',
  workerUrlHint: '留空则使用 claude-mem 启动时公布在 worker.pid 里的地址。',
  test: '测试连接',
  testing: '检测中…',
  hookTitle: '启动器',
  hookPath: '可执行文件',
  hookPathHint: 'claude-mem 用来记录观察的入口。留空则使用平台默认路径。',
  behaviorTitle: '行为',
  ingest: '观察工具调用并写入记忆',
  ingestHint: '工具调用的结果会被记成一条可以检索的记忆。',
  summarize: '回合结束时生成会话摘要',
  summarizeHint: '每轮结束都会由 claude-mem 总结一次本轮会话。',
  workState: '跨会话保存待办与工作状态',
  workStateHint: '开启后可以维护待办清单与工作进度，下个会话接着做；关闭则不提供这项能力，其他记忆功能不受影响。',
  autoStartWorker: 'worker 未运行时自动拉起',
  fileContext: '读取文件时带入相关记忆',
  fileContextHint: '读取文件时，附上记忆里关于这个文件的历史。',
  fileContextGate: '拒绝整篇读取已有记忆的大文件',
  fileContextGateHint: 'DSH 本身已把单次读取限制在约 50 KB，并支持 offset/limit 续读，因此本项收益有限，默认关闭。开启后，用户在 prompt 里点名的文件一律放行。',
  smart: '通过 claude-mem 结构化阅读代码',
  smartHint: '新增 mem_smart_search / mem_smart_outline / mem_smart_unfold：给文件大纲与单个符号的源码，而不是整篇文件。由模型按需调用；仅限当前工作目录。',
  corpora: '知识语料库',
  corporaHint: '新增六个 mem_corpus_* 工具：把记忆按主题切成语料库，可以针对某个主题提问。',
  subagents: '把子代理的工作记在发起它的会话名下',
  subagentsHint: '子代理做的事也记在发起它的会话名下，结束时归档一条。',
  fileContextTools: '带入记忆的工具',
  effectiveList: '当前生效：{names}',
  fileContextToolsHint: '仅在上方「读取文件时带入相关记忆」开启时生效；用逗号分隔，留空表示使用默认名单（{names}）。',
  advancedTitle: '高级',
  toolFilter: '观察白名单',
  toolFilterHint: '仅在上方「观察工具调用并写入记忆」开启时生效；用逗号分隔，留空表示使用默认名单（{names}）。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  discarded: '已放弃修改',
  probeConnected: '已连接 · {version} · pid {pid} · 观察者 {provider}',
  probeConnectedPlain: '已连接',
  probeNotInitialized: '能连上，但 worker 尚未初始化完成',
  probeMcpUnavailable: '能连上，但 MCP 未就绪',
  probeUnhealthy: '能连上，但 worker 自报状态“{status}”',
  probeHttp: '服务返回 HTTP {status}',
  probeNotWorker: '有服务在响应，但不是 claude-mem worker',
  probeUnreachable: '连不上 worker（未启动，或端口不对）',
  unavailable: '插件配置加载完成前此页不可用。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy rendered by the claude-mem configuration page. */
    'dsh-claude-mem': MessageKey
  }
}
