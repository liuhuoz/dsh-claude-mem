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
  summary: 'Worker endpoint, hook launcher, and what the plugin is allowed to record.',
  connectionTitle: 'Connection',
  workerUrl: 'Worker address',
  workerUrlHint: 'Leave empty to use the address claude-mem publishes when it starts.',
  test: 'Test connection',
  testing: 'Testing…',
  hookTitle: 'Hook launcher',
  hookPath: 'Executable',
  hookPathHint: 'The claude-mem entry point that records observations. Leave empty to use the platform default.',
  behaviorTitle: 'Behaviour',
  injectContext: 'Inject memory context at session start',
  ingest: 'Record tool calls as memory',
  summarize: 'Write a session summary when a turn ends',
  autoStartWorker: 'Start the worker when it is not running',
  advancedTitle: 'Advanced',
  toolFilter: 'Observed tools',
  toolFilterHint: 'Only used while “Record tool calls as memory” is on. Leave empty for the default four.',
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
  probeUnreachable: 'Could not reach the worker (not running, wrong port, or blocked by the browser)',
  unavailable: 'This page is unavailable until the plugin configuration loads.',
} as const

/** Keys the page renders. */
export type MessageKey = keyof typeof en

/** Chinese dictionary. */
export const zh: Record<MessageKey, string> = {
  summary: 'worker 地址、hook 启动器，以及插件被允许记录什么。',
  connectionTitle: '连接',
  workerUrl: 'worker 地址',
  workerUrlHint: '留空则使用 claude-mem 启动时公布在 worker.pid 里的地址。',
  test: '测试连接',
  testing: '检测中…',
  hookTitle: 'hook 启动器',
  hookPath: '可执行文件',
  hookPathHint: 'claude-mem 用来记录观察的入口。留空则使用平台默认路径。',
  behaviorTitle: '行为',
  injectContext: '会话开始时注入记忆上下文',
  ingest: '观察工具调用并写入记忆',
  summarize: '回合结束时生成会话摘要',
  autoStartWorker: 'worker 未运行时自动拉起',
  advancedTitle: '高级',
  toolFilter: '观察白名单',
  toolFilterHint: '仅在“观察工具调用并写入记忆”开启时生效；留空则使用默认四项。',
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
  probeUnreachable: '连不上 worker（未启动、端口不对，或被浏览器拦截）',
  unavailable: '插件配置加载完成前此页不可用。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy rendered by the claude-mem configuration page. */
    'claude-mem': MessageKey
  }
}
