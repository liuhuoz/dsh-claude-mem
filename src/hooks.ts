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
import type { ToolExecution, ToolExecutionResult, PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { FILE_CONTEXT_TIMEOUT_MS, GATE_MIN_BYTES, HookCliFileContext, gateCandidate, gateReason, preToolPayload, promptMentionsFile } from './file-context.js'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { WorkerClient } from './worker.js'
import type { LiveSettings } from './settings.js'

/** Read current settings; called wherever a value is used, never once at startup. */
export type SettingsSource = () => LiveSettings

/** Untyped listener registration: the `agent/*` event map is version-dependent. */
type OnAny = (event: string, handler: (...args: any[]) => any) => void

/** Where one observed tool result is filed, and under which agent it ran. */
interface ToolAttribution {
  /** Content session the observation belongs to: the parent for a subagent. */
  readonly sessionId: string
  /** Subagent identity, present only for work done inside a delegated run. */
  readonly agentId?: string
  readonly agentType?: string
}

/** A delegated run as the plugin tracks it: child session id to its parent. */
export interface SubagentIdentity {
  readonly parentSessionId: string
  readonly agentType?: string
  readonly runId?: string
}

/** `subagent/start` payload; the DSH session header is the fallback source. */
interface SubagentRunStart {
  readonly id?: string
  readonly parentSessionId?: string
  readonly runId?: string
}

/** `subagent/end` carries the same identity plus a terminal `stopReason`. */
interface SubagentRunEnd extends SubagentRunStart {
  readonly stopReason?: string
}

/** Session header fields this module reads; the published type is narrower. */
interface LooseHeader {
  readonly cwd?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly parentSessionId?: string
  readonly agentPreset?: string
}

function headerOf(agent: Agent): LooseHeader {
  return agent.session.header as unknown as LooseHeader
}

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
export function hookToolName(name: string): string {
  if (name === 'ops_bash' || name === 'pwsh' || name === 'bash' || name === 'shell') return 'Bash'
  if (name === 'read') return 'Read'
  if (name === 'write') return 'Write'
  if (name === 'edit') return 'Edit'
  // A delegated run is a tool call from the parent's point of view, and
  // claude-mem already renders Claude Code's Task as "Task(subagent_type)".
  if (name === 'subagent' || name === 'subagent_fork') return 'Task'
  return name
}

/**
 * Feed one tool result through claude-mem's own observation pipeline. The hook
 * launcher runs the observer model, produces a semantic observation, and
 * attributes it to the real content session.
 */
function recordToolUse(
  exec: ToolExecution,
  agent: Agent,
  text: string,
  settings: LiveSettings,
  attribution: ToolAttribution,
): void {
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  const payload = {
    session_id: attribution.sessionId,
    transcript_path: '',
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: hookToolName(exec.name),
    tool_input: exec.arguments ?? {},
    tool_response: { content: [{ type: 'text', text }], is_error: false },
    // Subagent work is filed against the parent session and labelled, never as a
    // session of its own: the parent is what the user reads.
    ...attribution.agentId === undefined ? {} : { agent_id: attribution.agentId },
    ...attribution.agentType === undefined ? {} : { agent_type: attribution.agentType },
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

/**
 * File one tool result under the session that owns it.
 *
 * A delegated run never becomes a session of its own: its work is filed against
 * the parent with `agent_id`/`agent_type`, which is exactly the shape claude-mem
 * already stores for Claude Code subagents.
 */
export function attributionOf(agent: Agent, subagents: Map<string, SubagentIdentity>): ToolAttribution {
  const childId = agent.session.id
  const identity = subagents.get(childId)
  const header = headerOf(agent)
  const parentSessionId = identity?.parentSessionId ?? header.parentSessionId
  if (!isSubagent(agent) || parentSessionId === undefined) return { sessionId: childId }
  return {
    sessionId: parentSessionId,
    agentId: childId,
    ...agentTypeOf(identity, header) === undefined ? {} : { agentType: agentTypeOf(identity, header) },
  }
}

function agentTypeOf(identity: SubagentIdentity | undefined, header: LooseHeader): string | undefined {
  const type = identity?.agentType ?? header.agentPreset
  return typeof type === 'string' && type.length > 0 ? type : undefined
}

/** Remember a delegated run from its session header, when `subagent/start` has not arrived yet. */
export function rememberSubagent(agent: Agent, subagents: Map<string, SubagentIdentity>): void {
  const header = headerOf(agent)
  const existing = subagents.get(agent.session.id)
  // `subagent/start` carries no agent type, so a later session header completes
  // an entry it created first.
  if (existing !== undefined) {
    if (existing.agentType !== undefined) return
    const agentType = agentTypeOf(undefined, header)
    if (agentType !== undefined) subagents.set(agent.session.id, { ...existing, agentType })
    return
  }
  if (header.parentSessionId === undefined) return
  const agentType = agentTypeOf(undefined, header)
  subagents.set(agent.session.id, {
    parentSessionId: header.parentSessionId,
    ...agentType === undefined ? {} : { agentType },
  })
}

/**
 * Archive the end of a delegated run through claude-mem's own SubagentStop hook.
 *
 * Only the identity is sent: the child's last message and stop reason already
 * reach memory as the parent's tool result, and claude-mem drops them here too.
 * Best-effort: a failed archive never breaks the parent turn.
 */
/** Prefer the tracked type, then the child session header the agent still holds. */
function withAgentType(identity: SubagentIdentity, child: Agent | undefined): SubagentIdentity {
  if (identity.agentType !== undefined) return identity
  const agentType = child === undefined ? undefined : agentTypeOf(undefined, headerOf(child))
  return agentType === undefined ? identity : { ...identity, agentType }
}

export function subagentStopPayload(
  childSessionId: string,
  identity: SubagentIdentity,
  cwd: string | undefined,
): Record<string, unknown> {
  return {
    session_id: identity.parentSessionId,
    cwd: cwd !== undefined && cwd.length > 0 ? cwd : process.cwd(),
    hook_event_name: 'SubagentStop',
    agent_id: childSessionId,
    ...identity.agentType === undefined ? {} : { agent_type: identity.agentType },
  }
}

function recordSubagentStop(
  childSessionId: string,
  identity: SubagentIdentity,
  settings: LiveSettings,
  cwd: string | undefined,
): void {
  if (!settings.subagents) return
  const payload = subagentStopPayload(childSessionId, identity, cwd)
  try {
    const child = spawn(hookLauncher(settings), ['hook', 'claude-code', 'subagent-stop'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  } catch {
    // Archiving is best-effort, like every other hook this module drives.
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

/** Marker prefix for the memory block attached after a read-like tool call. */
export const FILE_CONTEXT_MARKER = '[claude-mem] file context'

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

  /** Delegated runs by child session id; their work is filed against the parent. */
  const subagents = new Map<string, SubagentIdentity>()

  /** File-context fetches started for a session, consumed at its next pre-step. */
  const pendingFileContext = new Map<string, Promise<string | null>>()

  /** The last prompt the user actually typed: an explicit request bypasses the read gate. */
  const lastPrompt = new Map<string, string>()

  on('agent/created', (payload: { agent: Agent }) => {
    const { agent } = payload
    agents.set(agent.session.id, agent)
    if (isSubagent(agent)) {
      // A child session is the fallback identity source: forks never emit
      // `subagent/start`, and the header already names the creator.
      rememberSubagent(agent, subagents)
      return
    }
    void seedSessionContext(worker, agent, getSettings())
  })

  on('agent/disposed', (payload: { agent?: Agent }) => {
    if (payload.agent === undefined) return
    const { agent } = payload
    agents.delete(agent.session.id)
    lastPrompt.delete(agent.session.id)
    const identity = subagents.get(agent.session.id)
    if (identity === undefined) return
    subagents.delete(agent.session.id)
    // Fallback for a run that vanished without `subagent/end` — a thrown run.
    recordSubagentStop(agent.session.id, withAgentType(identity, agent), getSettings(), parentCwd(agents, identity.parentSessionId))
  })

  // A delegated run is tracked from start to end only so its work is filed
  // against the parent. Nothing is injected into the child: what it may know is
  // the parent's decision, not this plugin's.
  on('subagent/start', (info: SubagentRunStart) => {
    if (!getSettings().subagents) return
    if (typeof info?.id !== 'string' || typeof info.parentSessionId !== 'string') return
    if (subagents.has(info.id)) return
    subagents.set(info.id, {
      parentSessionId: info.parentSessionId,
      ...info.runId === undefined ? {} : { runId: info.runId },
    })
  })

  on('subagent/end', (info: SubagentRunEnd) => {
    if (typeof info?.id !== 'string') return
    const known = subagents.get(info.id)
    const identity = known ?? (typeof info.parentSessionId === 'string' ? { parentSessionId: info.parentSessionId } : undefined)
    if (identity === undefined) return
    const child = agents.get(info.id)
    subagents.delete(info.id)
    recordSubagentStop(
      info.id,
      withAgentType(identity, child),
      getSettings(),
      parentCwd(agents, identity.parentSessionId),
    )
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

  on('agent/pre-step', async (payload: { agent: Agent; messages: readonly UserMessage[] }, next: () => Promise<unknown>) => {
    // Session registration and prompt capture are not optional: the row is what
    // gives an observation its context, and claude-mem exposes no switch for it
    // either. Only observation and summarization are switchable, here and there.
    recordPrompt(worker, payload.agent, payload.messages, getSettings())
    const typed = promptText(payload.messages)
    if (typed.length > 0) lastPrompt.set(payload.agent.session.id, typed)
    const decision = await next()
    return attachFileContext(payload.agent, decision, pendingFileContext)
  })

  // A full read of a large file that memory already covers is answered here, before
  // the tool runs: the gate is the point of the feature, and a decision is the only
  // way DSH lets a plugin stop a call.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const denial = await fileReadGate(exec, getSettings(), worker, lastPrompt)
    if (denial !== null) return denial
    return next()
  })

  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const settings = getSettings()
    if (settings.ingest) observeToolResult(exec, result, settings, subagents)
    return next()
  })

  // File context rides a second listener so the observation path above stays untouched:
  // this one only starts the fetch and always forwards the decision unchanged.
  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const settings = getSettings()
    if (settings.fileContext && !result.isError) startFileContext(exec, settings, pendingFileContext)
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

function observeToolResult(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  settings: LiveSettings,
  subagents: Map<string, SubagentIdentity>,
): void {
  if (result.isError) return
  if (!settings.toolFilter.names.includes(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  const delegated = isSubagent(agent)
  // With the switch off a subagent takes no part in memory at all — neither its
  // own work nor a bare child session it never registered.
  if (delegated && !settings.subagents) return
  const text = resultContentText(result.content)
  if (text.length === 0) return
  recordToolUse(exec, agent, text, settings, attributionOf(agent, subagents))
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

/**
 * Deny a full read of a file that is large and already covered by memory.
 *
 * Every uncertainty answers null — unknown size, unreachable worker, no
 * observations — because letting a read through is always safe.
 */
async function fileReadGate(
  exec: ToolExecution,
  settings: LiveSettings,
  worker: WorkerClient,
  prompts: Map<string, string>,
): Promise<PreToolDecision | null> {
  if (!settings.fileContextGate) return null
  const candidate = gateCandidate(exec.name, exec.arguments)
  if (candidate === null) return null
  const agent = exec.agent
  if (agent === undefined || isSubagent(agent)) return null
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  const absolute = resolve(cwd, candidate.filePath)
  let size: number
  try {
    const stat = statSync(absolute)
    if (!stat.isFile() || stat.size < GATE_MIN_BYTES) return null
    size = stat.size
  } catch {
    return null
  }
  // An explicit request for this file outranks the token heuristic: the user asked.
  const typed = prompts.get(agent.session.id)
  if (typed !== undefined && promptMentionsFile(typed, absolute)) return null
  try {
    const covered = await worker.hasObservationsFor([absolute], AbortSignal.timeout(1500))
    if (!covered) return null
  } catch {
    return null
  }
  return { kind: 'deny', reason: gateReason(absolute, size) }
}

/** Start one file-context fetch; the result is consumed at the next pre-step. */
function startFileContext(
  exec: ToolExecution,
  settings: LiveSettings,
  pending: Map<string, Promise<string | null>>,
): void {
  const agent = exec.agent
  if (agent === undefined || isSubagent(agent)) return
  if (!settings.fileContextTools.includes(exec.name)) return
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  const payload = preToolPayload({
    sessionId: agent.session.id,
    cwd,
    name: exec.name,
    arguments: exec.arguments,
  })
  if (payload === null) return
  const source = new HookCliFileContext(hookLauncher(settings), FILE_CONTEXT_TIMEOUT_MS)
  pending.set(agent.session.id, source.fetch(payload))
}

/**
 * Append the answered file context to the messages entering this step. A
 * rejected step, a missing fetch or empty context all leave the decision alone.
 */
async function attachFileContext(
  agent: Agent,
  decision: unknown,
  pending: Map<string, Promise<string | null>>,
): Promise<unknown> {
  const current = decision as { kind?: string; messages?: readonly UserMessage[] } | undefined
  if (current === undefined || current.kind !== 'enter') return decision
  const fetch = pending.get(agent.session.id)
  if (fetch === undefined) return decision
  pending.delete(agent.session.id)
  const text = await fetch.catch(() => null)
  if (text === null || text.length === 0) return decision
  const message: UserMessage = createUserMessage({
    content: [{ type: 'text', text: `${FILE_CONTEXT_MARKER}\n${text}` }],
    source: { kind: 'claude-mem' } as unknown as UserMessage['source'],
  })
  return { ...current, messages: [...(current.messages ?? []), message] }
}

/** Working directory of a parent session, used as the SubagentStop payload's cwd. */
function parentCwd(agents: Map<string, Agent>, parentSessionId: string): string | undefined {
  const parent = agents.get(parentSessionId)
  if (parent === undefined) return undefined
  const cwd = headerOf(parent).cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
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
