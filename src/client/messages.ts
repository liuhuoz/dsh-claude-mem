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
  hookTitle: 'Launcher',
  hookPath: 'Executable',
  hookPathHint: 'The claude-mem entry point that records observations. Leave empty to use the platform default.',
  behaviorTitle: 'Behaviour',
  ingest: 'Record tool calls as memory',
  ingestHint: 'Every observed tool result goes to claude-mem’s observer model and becomes one memory.',
  summarize: 'Write a session summary when a turn ends',
  summarizeHint: 'Asks the model for a summary at the end of every turn.',
  workState: 'Keep to-do lists and work state across sessions',
  workStateHint: 'Adds work_state_write / work_state_read, and re-injects unfinished items after the context is compacted. Turning this off hides all three.',
  autoStartWorker: 'Start the worker when it is not running',
  fileContext: 'Bring memory into file reads',
  fileContextHint: 'Attaches what claude-mem already knows about a file after a read-like tool call. Each new file costs one launcher start (about 0.4 s).',
  fileContextGate: 'Refuse full reads of large files memory already covers',
  fileContextGateHint: 'DSH already caps one read at about 50 KB and resumes with offset/limit, so this buys only a little and is off by default. When on, a file the user names in their prompt is always allowed.',
  fileContextTools: 'File-context tools',
  fileContextToolsHint: 'Leave empty for the default five (read, ops_bash, pwsh, grep, glob).',
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
  probeUnreachable: 'Could not reach the worker (not running, or the wrong port)',
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
  hookTitle: '启动器',
  hookPath: '可执行文件',
  hookPathHint: 'claude-mem 用来记录观察的入口。留空则使用平台默认路径。',
  behaviorTitle: '行为',
  ingest: '观察工具调用并写入记忆',
  ingestHint: '每条被观察的工具结果都会交给 claude-mem 的观察者模型，成为一条记忆。',
  summarize: '回合结束时生成会话摘要',
  summarizeHint: '每轮结束都会请模型总结一次本次会话。',
  workState: '跨会话保存待办与工作状态',
  workStateHint: '开启后提供 work_state_write / work_state_read，并在上下文压缩后重新注入未完成项；关闭则三者一起隐藏。',
  autoStartWorker: 'worker 未运行时自动拉起',
  fileContext: '读取文件时带入相关记忆',
  fileContextHint: '读取类工具调用后，附上 claude-mem 已知的该文件历史。每个新文件约多花一次启动器调用（约 0.4 秒）。',
  fileContextGate: '拒绝整篇读取已有记忆的大文件',
  fileContextGateHint: 'DSH 本身已把单次读取限制在约 50 KB，并支持 offset/limit 续读，因此本项收益有限，默认关闭。开启后，用户在 prompt 里点名的文件一律放行。',
  fileContextTools: '带入记忆的工具',
  fileContextToolsHint: '留空则使用默认五项（read、ops_bash、pwsh、grep、glob）。',
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
  probeUnreachable: '连不上 worker（未启动，或端口不对）',
  unavailable: '插件配置加载完成前此页不可用。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy rendered by the claude-mem configuration page. */
    'dsh-claude-mem': MessageKey
  }
}
