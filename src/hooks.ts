/**
 * Lifecycle hooks: drive session-start context injection, optional ingestion
 * on tool result, and optional summarization on turn stop. Platform scoping is
 * a signal, never an enforced restriction.
 *
 * Every hook reads the settings it acts on at call time. The fields the
 * settings page edits are volatile cells, so a toggle flipped in the page must
 * change behaviour immediately — capturing the flags at registration would make
 * the page look live while the hooks kept the old answer.
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
import type { LiveSettings } from './settings.js'

/** Read current settings; called wherever a value is used, never once at startup. */
export type SettingsSource = () => LiveSettings

/** Untyped listener registration: the `agent/*` event map is version-dependent. */
type OnAny = (event: string, handler: (...args: any[]) => any) => void

let workerBootAt = 0

/**
 * Best-effort worker bootstrap. `claude-mem start` is host-agnostic and
 * idempotent: it reuses a live worker (PID file + readiness probe) and only
 * spawns one when none is running. Throttled so a down worker cannot make
 * every tool call spawn a launcher.
 */
function ensureWorkerStarted(settings: LiveSettings): void {
  if (!settings.autoStartWorker) return
  const now = Date.now()
  if (now - workerBootAt < 60_000) return
  workerBootAt = now
  try {
    const child = spawn(hookLauncher(settings), ['start'], { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Bootstrap is best-effort; the worker being down surfaces through the tools.
  }
}

/** claude-mem's hook launcher: the same entry Claude Code runs for PostToolUse. */
function hookLauncher(settings: LiveSettings): string {
  const configured = settings.hookPath
  if (configured.trim().length > 0) return configured.trim()
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
function recordToolUse(exec: ToolExecution, agent: Agent, text: string, settings: LiveSettings): void {
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
    const child = spawn(hookLauncher(settings), ['hook', 'claude-code', 'observation'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('error', () => {
      ensureWorkerStarted(settings)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  } catch {
    ensureWorkerStarted(settings)
  }
}

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
function recordPrompt(worker: WorkerClient, agent: Agent, messages: readonly UserMessage[], settings: LiveSettings): void {
  if (isSubagent(agent)) return
  const text = promptText(messages)
  if (text.length === 0) return
  const project = projectName(agent, settings)
  worker
    .sessionInit({ contentSessionId: agent.session.id, project, prompt: text, ...platform(settings) })
    .catch(() => {
      ensureWorkerStarted(settings)
    })
}

/** Attach the memory lifecycle hooks to their extension points. */
/** Marker prefix for the post-compaction work-state re-injection. */
export const WORK_STATE_MARKER = '[claude-mem] open work state'

/**
 * True only when the worker returned actual open items. An empty project answers
 * "Nothing open for …" or "Nothing recorded …", which must not be injected.
 */
export function hasOpenWorkState(text: string): boolean {
  const body = text.trim()
  if (body.length === 0) return false
  return !/^Nothing (open|recorded)\b/.test(body)
}

/**
 * claude-mem's auto-clear relies on Claude Code's `/clear`. DSH has no such
 * command — it compacts the session in place — so the stand-in is to re-inject
 * the project's open work state as soon as a compaction commits.
 */
async function rehydrateWorkState(worker: WorkerClient, agent: Agent): Promise<void> {
  const cwd = typeof agent.session.header.cwd === 'string' && agent.session.header.cwd.length > 0
    ? agent.session.header.cwd
    : process.cwd()
  try {
    const text = await worker.workState({ cwd })
    if (!hasOpenWorkState(text)) return
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text: `${WORK_STATE_MARKER}\n${text.trim()}` }],
      source: { kind: 'claude-mem' } as unknown as UserMessage['source'],
    })
    agent.inject(message)
  } catch {
    // Best-effort: an unavailable worker must not break the continued turn.
  }
}

/** Injected when the work-state switch is off, so the model never calls unregistered tools. */
export const WORK_STATE_DISABLED_NOTE = 'claude-mem work state is disabled in this project: do not call work_state_write or work_state_read. Track short-lived progress with the harness todo tool instead.'

/** Append the disabled notice to the injected context when work state is switched off. */
export function applyWorkStatePolicy(text: string, enabled: boolean): string {
  return enabled ? text : `${text}\n\n${WORK_STATE_DISABLED_NOTE}`
}

export function applyMemoryHooks(ctx: Context, worker: WorkerClient, getSettings: SettingsSource): void {
  ensureWorkerStarted(getSettings())

  const on = ctx.on.bind(ctx) as unknown as OnAny

  /** Live agents by session id, so a session event can reach the agent to inject into. */
  const agents = new Map<string, Agent>()

  on('agent/created', (payload: { agent: Agent }) => {
    const { agent } = payload
    agents.set(agent.session.id, agent)
    if (isSubagent(agent)) return
    void seedSessionContext(worker, agent, getSettings())
  })

  on('agent/disposed', (payload: { agent?: Agent }) => {
    if (payload.agent !== undefined) agents.delete(payload.agent.session.id)
  })

  // DSH compacts in place instead of clearing; rehydrate the open work state once
  // the compaction commits so the continued session still sees unfinished todos.
  on('session/event', (session: { id: string }, event: { type: string }) => {
    if (event?.type !== 'compaction/end') return
    const agent = agents.get(session.id)
    if (agent === undefined || isSubagent(agent)) return
    if (!getSettings().workState) return
    void rehydrateWorkState(worker, agent)
  })

  on('agent/pre-step', (payload: { agent: Agent; messages: readonly UserMessage[] }, next: () => Promise<unknown>) => {
    // Session registration and prompt capture are not optional: the row is what
    // gives an observation its context, and claude-mem exposes no switch for it
    // either. Only observation and summarization are switchable, here and there.
    recordPrompt(worker, payload.agent, payload.messages, getSettings())
    return next()
  })

  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const settings = getSettings()
    if (settings.ingest) observeToolResult(exec, result, settings)
    return next()
  })

  on('agent/turn-stopping', (payload: { agent: Agent }) => {
    const settings = getSettings()
    if (settings.summarize) void summarizeSession(worker, payload.agent, settings)
  })
}

async function seedSessionContext(worker: WorkerClient, agent: Agent, settings: LiveSettings): Promise<void> {
  const project = projectName(agent, settings)
  try {
    // The session row is created by recordPrompt() carrying the real prompt
    // text, so no placeholder "[media prompt]" row is written here.
    const text = await worker.context({ projects: project, ...platform(settings) })
    if (text.length === 0) return
    // DSH 0.2.x rejects the retired `{ kind: 'plugin', ... }` wrapper and has no
    // catch-all producer kind; a plugin declares its own through MessageSourceMap,
    // which this package cannot augment against the published harness types, so
    // the producer kind is asserted here. The runtime accepts any non-empty kind
    // other than 'plugin'.
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text: applyWorkStatePolicy(text, settings.workState) }],
      source: { kind: 'claude-mem' } as unknown as UserMessage['source'],
    })
    agent.inject(message)
  } catch {
    // Context seeding is best-effort: an unavailable worker must not block the
    // first turn. The worker being down is reported by the mem_* tools instead.
    ensureWorkerStarted(settings)
  }
}

function observeToolResult(exec: ToolExecution, result: Readonly<ToolExecutionResult>, settings: LiveSettings): void {
  if (result.isError) return
  if (!settings.toolFilter.names.includes(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  const text = resultContentText(result.content)
  if (text.length === 0) return
  recordToolUse(exec, agent, text, settings)
}

async function summarizeSession(worker: WorkerClient, agent: Agent, settings: LiveSettings): Promise<void> {
  const project = projectName(agent, settings)
  try {
    await worker.sessionSummarize({ contentSessionId: agent.session.id, project, ...platform(settings) })
  } catch {
    // Summarization is best-effort.
    ensureWorkerStarted(settings)
  }
}

function projectName(agent: Agent, settings: LiveSettings): string {
  if (settings.project.trim().length > 0) return settings.project
  const cwd = agent.session.header.cwd
  if (cwd !== undefined) {
    const base = basename(cwd)
    if (base.length > 0) return base
  }
  return 'dsh'
}

function platform(settings: LiveSettings): { platformSource?: string } {
  return settings.platformSource.length > 0 ? { platformSource: settings.platformSource } : {}
}

function resultContentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}
