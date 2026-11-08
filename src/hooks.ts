/**
 * Lifecycle hooks: drive session-start context injection, optional ingestion
 * on tool result, and optional summarization on turn stop. Platform scoping is
 * a signal, never an enforced restriction.
 * @module dsh-claude-mem/hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { WorkerClient } from './worker.js'

export interface HooksConfig {
  platformSource?: string
  project?: string
  injectContext: boolean
  ingest: boolean
  summarize: boolean
  toolFilter: { names: string[] }
}

/** Untyped listener registration: the `agent/*` event map is version-dependent. */
type OnAny = (event: string, handler: (...args: any[]) => any) => void

/** Subagent sessions get their context from the parent, never from global memory. */
function isSubagent(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/** Text of the genuine user prompts entering this step, ignoring injected context. */
function promptText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim().length > 0) parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Record the real prompt text so claude-mem stops storing "[media prompt]". */
function recordPrompt(worker: WorkerClient, agent: Agent, messages: readonly UserMessage[], config: HooksConfig): void {
  if (isSubagent(agent)) return
  const text = promptText(messages)
  if (text.length === 0) return
  const project = projectName(agent, config)
  worker
    .sessionInit({ contentSessionId: agent.session.id, project, prompt: text, ...platform(config) })
    .catch(() => {})
}

/** Attach the memory lifecycle hooks to their extension points. */
export function applyMemoryHooks(ctx: Context, worker: WorkerClient, config: HooksConfig): void {
  const on = ctx.on.bind(ctx) as unknown as OnAny

  on('agent/created', (payload: { agent: Agent }) => {
    const { agent } = payload
    if (!config.injectContext) return
    if (isSubagent(agent)) return
    void seedSessionContext(worker, agent, config)
  })

  on('agent/pre-step', (payload: { agent: Agent; messages: readonly UserMessage[] }, next: () => Promise<unknown>) => {
    recordPrompt(worker, payload.agent, payload.messages, config)
    return next()
  })

  if (config.ingest) {
    ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
      observeToolResult(exec, result, config)
      return next()
    })
  }

  if (config.summarize) {
    ctx.on('agent/turn-stopping', (payload: { agent: Agent }) => {
      void summarizeSession(worker, payload.agent, config)
    })
  }
}

async function seedSessionContext(worker: WorkerClient, agent: Agent, config: HooksConfig): Promise<void> {
  const project = projectName(agent, config)
  try {
    // The session row is created by recordPrompt() carrying the real prompt
    // text, so no placeholder "[media prompt]" row is written here.
    const text = await worker.context({ projects: project, ...platform(config) })
    if (text.length === 0) return
    // DSH 0.2.x rejects the retired `{ kind: 'plugin', ... }` wrapper and has no
    // catch-all producer kind; a plugin declares its own through MessageSourceMap,
    // which this package cannot augment against the published harness types, so
    // the producer kind is asserted here. The runtime accepts any non-empty kind
    // other than 'plugin'.
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'claude-mem' } as unknown as UserMessage['source'],
    })
    agent.inject(message)
  } catch {
    // Context seeding is best-effort: an unavailable worker must not block the
    // first turn. The worker being down is reported by the mem_* tools instead.
  }
}

function observeToolResult(exec: ToolExecution, result: Readonly<ToolExecutionResult>, config: HooksConfig): void {
  if (result.isError) return
  if (!config.toolFilter.names.includes(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  const text = resultContentText(result.content)
  if (text.length === 0) return
  recordToolUse(exec, agent, text)
}

/** claude-mem's hook launcher: the same entry Claude Code runs for PostToolUse. */
function hookLauncher(): string {
  const explicit = process.env.DSH_MEM_HOOK_BIN
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local !== undefined && local.length > 0) return `${local}\\claude-mem\\bin\\claude-mem.exe`
  }
  return 'claude-mem'
}

/** Claude Code tool names, so claude-mem's skip and filtering rules keep matching. */
function hookToolName(name: string): string {
  if (name === 'ops_bash' || name === 'pwsh' || name === 'bash' || name === 'shell') return 'Bash'
  if (name === 'read') return 'Read'
  if (name === 'write') return 'Write'
  if (name === 'edit') return 'Edit'
  return name
}

/**
 * Feed one tool result through claude-mem's own observation pipeline. The hook
 * launcher runs the observer model, produces a semantic observation, and
 * attributes it to the real content session.
 */
function recordToolUse(exec: ToolExecution, agent: Agent, text: string): void {
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  const payload = {
    session_id: agent.session.id,
    transcript_path: '',
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: hookToolName(exec.name),
    tool_input: exec.arguments ?? {},
    tool_response: { content: [{ type: 'text', text }], is_error: false },
  }
  try {
    const child = spawn(hookLauncher(), ['hook', 'claude-code', 'observation'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  } catch {
    // Ingestion is fire-and-forget alongside the real tool's success.
  }
}

async function summarizeSession(worker: WorkerClient, agent: Agent, config: HooksConfig): Promise<void> {
  const project = projectName(agent, config)
  try {
    await worker.sessionSummarize({ contentSessionId: agent.session.id, project, ...platform(config) })
  } catch {
    // Summarization is best-effort.
  }
}

function projectName(agent: Agent, config: HooksConfig): string {
  if (config.project !== undefined && config.project.trim().length > 0) return config.project
  const cwd = agent.session.header.cwd
  if (cwd !== undefined) {
    const base = basename(cwd)
    if (base.length > 0) return base
  }
  return 'dsh'
}

function platform(config: HooksConfig): { platformSource?: string } {
  return config.platformSource !== undefined && config.platformSource.length > 0
    ? { platformSource: config.platformSource }
    : {}
}

function resultContentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}
