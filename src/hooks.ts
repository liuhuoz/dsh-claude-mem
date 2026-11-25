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
import { FILE_CONTEXT_TIMEOUT_MS, FileMemoryLookup, GATE_MIN_BYTES, HttpFileContext, gateCandidate, gateReason, promptMentionsFile, type FileContextSource } from './file-context.js'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { WorkerClient } from './worker.js'
import { DSH_PLATFORM, type LiveSettings } from './settings.js'
import type { MemObservationIngest } from './types.js'
import { OPEN_MODE, type MemoryMode } from './memory-mode.js'

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

/** How long one direct capture may take before it is handed to the CLI. */
export const OBSERVATION_TIMEOUT_MS = 5_000

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
 * Everything one tool result contributes to claude-mem's payload, in the shape
 * Claude Code sends it.
 */
export interface ObservationFields {
  readonly cwd: string
  readonly toolName: string
  readonly toolInput: unknown
  readonly text: string
  /** True when the call failed; only the response body changes, never the event. */
  readonly failed: boolean
}

/**
 * What claude-mem stores for one result: the text body, or the failure marker.
 *
 * The event stays `PostToolUse` for failures too: the pipeline reads the
 * structured marker out of `tool_response` (`{ is_error: true, error }`), the
 * shape the harnesses that expose a single post-tool event already send.
 */
function toolResponseOf(fields: ObservationFields): Record<string, unknown> {
  return fields.failed
    ? { is_error: true, error: fields.text }
    : { content: [{ type: 'text', text: fields.text }], is_error: false }
}

/**
 * The hook payload Claude Code would send for this call — the shape the CLI
 * fallback feeds to `claude-mem hook dsh observation`.
 */
export function observationPayload(
  fields: ObservationFields,
  attribution: ToolAttribution,
  toolUseId?: string,
): Record<string, unknown> {
  return {
    session_id: attribution.sessionId,
    transcript_path: '',
    cwd: fields.cwd,
    hook_event_name: 'PostToolUse',
    tool_name: hookToolName(fields.toolName),
    tool_input: fields.toolInput ?? {},
    ...toolUseId === undefined ? {} : { tool_use_id: toolUseId },
    tool_response: toolResponseOf(fields),
    // Subagent work is filed against the parent session and labelled, never as a
    // session of its own: the parent is what the user reads.
    ...attribution.agentId === undefined ? {} : { agent_id: attribution.agentId },
    ...attribution.agentType === undefined ? {} : { agent_type: attribution.agentType },
  }
}

/**
 * The same call as a direct `POST /api/sessions/observations` body.
 *
 * `platformSource` is the field the CLI can never set for us: claude-mem takes
 * the platform from the adapter name there, and the platform is part of the
 * session key. `toolUseId` unlocks the raw `tool_uses` backup and the
 * `already_processed` dedupe, neither of which the CLI path could reach.
 */
export function observationIngest(
  fields: ObservationFields,
  attribution: ToolAttribution,
  toolUseId?: string,
  now = Date.now(),
): MemObservationIngest {
  return {
    contentSessionId: attribution.sessionId,
    toolName: hookToolName(fields.toolName),
    toolInput: fields.toolInput ?? {},
    toolResponse: toolResponseOf(fields),
    cwd: fields.cwd,
    platformSource: DSH_PLATFORM,
    eventOccurredAtEpochMs: now,
    ...toolUseId === undefined ? {} : { toolUseId },
    ...attribution.agentId === undefined ? {} : { agentId: attribution.agentId },
    ...attribution.agentType === undefined ? {} : { agentType: attribution.agentType },
  }
}

/**
 * Feed one tool result to claude-mem's own capture route.
 *
 * The worker queues generation from it; a refused call falls back to the CLI,
 * whose spool keeps the event until the worker answers.
 */
function recordToolUse(
  worker: WorkerClient,
  exec: ToolExecution,
  agent: Agent,
  text: string,
  settings: LiveSettings,
  attribution: ToolAttribution,
  failed: boolean,
): void {
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  const fields: ObservationFields = { cwd, toolName: exec.name, toolInput: exec.arguments, text, failed }
  const toolUseId = exec.callId
  worker
    .ingestObservation(observationIngest(fields, attribution, toolUseId), AbortSignal.timeout(OBSERVATION_TIMEOUT_MS))
    .catch(() => {
      // Direct capture failed. The CLI keeps its own spool, so the event is not
      // lost while the worker restarts; it writes platform `dsh` too, which is
      // what keeps one session in one row. Only this event loses its agent label.
      ensureWorkerStarted(settings)
      recordToolUseFallback(fields, attribution, toolUseId, settings)
    })
}

/** Capture through claude-mem's own CLI, which spools while the worker is down. */
function recordToolUseFallback(
  fields: ObservationFields,
  attribution: ToolAttribution,
  toolUseId: string | undefined,
  settings: LiveSettings,
): void {
  const payload = observationPayload(fields, attribution, toolUseId)
  try {
    const child = spawn(hookLauncher(settings), ['hook', 'dsh', 'observation'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  } catch {
    // Capture never breaks a tool call, and this is already the last resort.
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
 * Run an archive once per child.
 *
 * `subagent/end` and `agent/disposed` describe the same run from two angles, and
 * claude-mem files each stop as a new work-state entry rather than replacing one,
 * so a second call leaves a duplicate behind.
 */
function archiveOnce(archived: Set<string>, childSessionId: string, archive: () => void): void {
  if (archived.has(childSessionId)) return
  archived.add(childSessionId)
  if (archived.size > 512) {
    const oldest = archived.values().next().value
    if (oldest !== undefined) archived.delete(oldest)
  }
  archive()
}

/** Prefer the tracked type, then the child session header the agent still holds. */
function withAgentType(identity: SubagentIdentity, child: Agent | undefined): SubagentIdentity {
  if (identity.agentType !== undefined) return identity
  const agentType = child === undefined ? undefined : agentTypeOf(undefined, headerOf(child))
  return agentType === undefined ? identity : { ...identity, agentType }
}

/**
 * claude-mem's `agent-lifecycle` entry for one delegated run that ended.
 *
 * Field for field what the upstream SubagentStop hook stores, with the platform
 * this plugin writes. The list carries no writer guard, so the HTTP route
 * accepts it — and only My Work reads it back, as one more piece of evidence.
 */
export function subagentStopFields(
  childSessionId: string,
  identity: SubagentIdentity,
  now = Date.now(),
): Record<string, unknown> {
  return {
    task: `Agent ${childSessionId} in ${DSH_PLATFORM} session ${identity.parentSessionId}`,
    status: 'done',
    platform_source: DSH_PLATFORM,
    content_session_id: identity.parentSessionId,
    agent_id: childSessionId,
    agent_type: identity.agentType ?? null,
    stopped_at: new Date(now).toISOString(),
    stopped_at_epoch: now,
    stop_source: 'subagent-stop-hook',
  }
}

/** Waits between archive attempts; the entry is dropped after the last one. */
export const ARCHIVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000]

/**
 * Write one archive entry, retrying a few times before giving up.
 *
 * A worker that is merely starting recovers inside this window; one that stays
 * down loses a work-view hint (the launch's own `returnedAtEpoch` still says the
 * call returned), which is why no disk-backed outbox is kept for it: claude-mem
 * cannot accept this entry without an agent id any other way.
 */
export async function archiveSubagentStop(
  write: (cwd: string, fields: Record<string, unknown>) => Promise<unknown>,
  cwd: string,
  fields: Record<string, unknown>,
  options: {
    readonly delays?: readonly number[]
    readonly onRetry?: () => void
    readonly sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<boolean> {
  const delays = options.delays ?? ARCHIVE_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await write(cwd, fields)
      return true
    } catch {
      if (attempt === delays.length) return false
      options.onRetry?.()
      await sleep(delays[attempt] ?? 0)
    }
  }
  return false
}

function recordSubagentStop(
  worker: WorkerClient,
  childSessionId: string,
  identity: SubagentIdentity,
  settings: LiveSettings,
  cwd: string | undefined,
): void {
  if (!settings.subagents) return
  const target = cwd !== undefined && cwd.length > 0 ? cwd : process.cwd()
  void archiveSubagentStop(
    (at, fields) => worker.workStateWrite({ cwd: at, list: 'agent-lifecycle', fields }),
    target,
    subagentStopFields(childSessionId, identity),
    { onRetry: () => ensureWorkerStarted(settings) },
  )
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
    .sessionInit({ contentSessionId: agent.session.id, project, prompt: text, ...writePlatform() })
    .catch(() => {
      ensureWorkerStarted(settings)
    })
}

/** Marker prefix for the memory block attached after a read-like tool call. */
export const FILE_CONTEXT_MARKER = '[claude-mem] file context'

/**
 * Build one injected message. Session start and compaction both go through it so
 * the two paths cannot drift apart.
 *
 * The text never depends on a setting: `workState` decides whether the two
 * work_state tools are registered (the write permission), not what the model is
 * told about the project.
 */
function memoryMessage(text: string): UserMessage {
  // DSH 0.2.x rejects the retired `{ kind: 'plugin', ... }` wrapper and has no
  // catch-all producer kind; a plugin declares its own through MessageSourceMap,
  // which this package cannot augment against the published harness types, so
  // the producer kind is asserted here. The runtime accepts any non-empty kind
  // other than 'plugin'.
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'claude-mem' } as unknown as UserMessage['source'],
  })
}

/** One accepted injection whose message has not reached the transcript yet. */
export interface PendingInjection {
  readonly id: string
  readonly at: number
}

/**
 * Upper bound for an accepted injection that never reports delivery. Delivery is
 * normally what ends the state — the `user/message` carrying the same id — so this
 * only resets an entry whose event never arrived.
 */
export const PENDING_INJECTION_LEAK_MS = 30 * 60_000

/**
 * True while this session already has the block in flight: the first trigger wins
 * and later ones step aside, whichever event fired them.
 */
export function injectionPending(pending: Map<string, PendingInjection>, sessionId: string, now = Date.now()): boolean {
  const entry = pending.get(sessionId)
  if (entry === undefined) return false
  if (now - entry.at >= PENDING_INJECTION_LEAK_MS) {
    pending.delete(sessionId)
    return false
  }
  return true
}

/** Record an injection the harness accepted but has not delivered yet. */
export function rememberInjection(pending: Map<string, PendingInjection>, sessionId: string, id: string, now = Date.now()): void {
  pending.set(sessionId, { id, at: now })
}

/** End the in-flight state once its message reaches the transcript. */
export function settleInjection(
  pending: Map<string, PendingInjection>,
  sessionId: string,
  event: { type?: string; data?: { id?: unknown } },
): boolean {
  if (event?.type !== 'user/message') return false
  const entry = pending.get(sessionId)
  if (entry === undefined || event.data?.id !== entry.id) return false
  pending.delete(sessionId)
  return true
}

/** Best-effort debug logging: a logger problem must never change behaviour. */
function debugLogger(ctx: Context): (message: string) => void {
  return (message: string) => {
    try {
      (ctx.logger as unknown as { debug?: (input: string) => void })?.debug?.(`[claude-mem] ${message}`)
    } catch {
      // Ignored on purpose: logging must never break an injection decision.
    }
  }
}

/**
 * Put the project's memory context into the conversation: the block claude-mem
 * renders for a session start. That block already opens with the project's open
 * work state ("Work state, still open: …") when there is one, so fetching the
 * work state separately would inject the same list twice.
 *
 * Session start and every committed compaction call it — a compaction keeps the
 * summary but drops the block the session started with, so a continued turn has
 * to be given it again.
 */
export async function injectSessionContext(
  worker: WorkerClient,
  agent: Agent,
  settings: LiveSettings,
  pending: Map<string, PendingInjection>,
  debug: (message: string) => void = () => {},
): Promise<void> {
  const sessionId = agent.session.id
  // One in-flight copy per session: the trigger that got there first wins, and a
  // later one — compaction or session start, whoever fired it — steps aside,
  // because the queued copy is still going to be delivered.
  if (injectionPending(pending, sessionId)) {
    debug(`context injection skipped: ${pending.get(sessionId)?.id ?? 'unknown'} is still in flight`)
    return
  }
  const project = projectName(agent, settings)
  try {
    // The session row is created by recordPrompt() carrying the real prompt
    // text, so no placeholder "[media prompt]" row is written here.
    const text = await worker.context({ projects: project, ...readPlatform(settings) })
    if (text.length === 0) return
    const message = memoryMessage(text)
    agent.inject(message)
    rememberInjection(pending, sessionId, message.id)
  } catch {
    // Best-effort: an unavailable worker must not block the first turn or the
    // continued one. The worker being down surfaces through the mem_* tools.
    ensureWorkerStarted(settings)
  }
}

/**
 * Attach the memory lifecycle hooks to their extension points.
 * @param mode - per-session read-only mode; a read-only session writes nothing back.
 */
export function applyMemoryHooks(
  ctx: Context,
  worker: WorkerClient,
  getSettings: SettingsSource,
  mode: MemoryMode = OPEN_MODE,
): void {
  ensureWorkerStarted(getSettings())

  const on = ctx.on.bind(ctx) as unknown as OnAny

  /** Live agents by session id, so a session event can reach the agent to inject into. */
  const agents = new Map<string, Agent>()

  /** Delegated runs by child session id; their work is filed against the parent. */
  const subagents = new Map<string, SubagentIdentity>()

  /**
   * Children already archived. `subagent/end` and `agent/disposed` can both fire
   * for one run, and a late `agent/created` re-registers the identity in between,
   * so the map alone cannot tell that the archive already happened.
   */
  const archived = new Set<string>()

  /** File-context fetches started for a session, consumed at its next pre-step. */
  const pendingFileContext = new Map<string, Promise<string | null>>()

  /** The last prompt the user actually typed: an explicit request bypasses the read gate. */
  const lastPrompt = new Map<string, string>()

  /** Context injections accepted by the harness but not yet delivered, one per session. */
  const pendingInjections = new Map<string, PendingInjection>()

  const debug = debugLogger(ctx)

  /** Read-only state of the session that owns a write, resolved through the live agents. */
  const isReadOnly = (sessionId: string): boolean => mode.isReadOnly(agents.get(sessionId)?.session)

  /** One file's memory, shared by the read gate and the block that follows it. */
  const fileMemory = new FileMemoryLookup(worker)

  /** The file-context source: this plugin does the rendering and the dedupe now. */
  const fileContext = new HttpFileContext(fileMemory)

  on('agent/created', (payload: { agent: Agent }) => {
    const { agent } = payload
    agents.set(agent.session.id, agent)
    if (isSubagent(agent)) {
      // A child session is the fallback identity source: forks never emit
      // `subagent/start`, and the header already names the creator.
      rememberSubagent(agent, subagents)
      return
    }
    void injectSessionContext(worker, agent, getSettings(), pendingInjections, debug)
  })

  on('agent/disposed', (payload: { agent?: Agent }) => {
    if (payload.agent === undefined) return
    const { agent } = payload
    agents.delete(agent.session.id)
    lastPrompt.delete(agent.session.id)
    fileContext.forget(agent.session.id)
    pendingInjections.delete(agent.session.id)
    const identity = subagents.get(agent.session.id)
    if (identity === undefined) return
    subagents.delete(agent.session.id)
    // A run started from a read-only session leaves no archive entry either.
    if (isReadOnly(identity.parentSessionId)) return
    // A disposed run normally already reached `subagent/end`; this path covers a
    // run that vanished without one and has no closing message.
    archiveOnce(archived, agent.session.id, () => {
      recordSubagentStop(
        worker,
        agent.session.id,
        withAgentType(identity, agent),
        getSettings(),
        parentCwd(agents, identity.parentSessionId),
      )
    })
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
    const childId = info.id
    const known = subagents.get(childId)
    const identity = known ?? (typeof info.parentSessionId === 'string' ? { parentSessionId: info.parentSessionId } : undefined)
    if (identity === undefined) return
    const child = agents.get(childId)
    subagents.delete(childId)
    // A run started from a read-only session leaves no archive entry either.
    if (isReadOnly(identity.parentSessionId)) return
    archiveOnce(archived, childId, () => {
      recordSubagentStop(
        worker,
        childId,
        withAgentType(identity, child),
        getSettings(),
        parentCwd(agents, identity.parentSessionId),
      )
    })
  })

  // The delivery event ends the in-flight state: the message we injected
  // reappears in the transcript carrying the same id.
  on('session/event', (session: { id: string }, event: { type: string; data?: { id?: unknown } }) => {
    if (settleInjection(pendingInjections, session.id, event)) return
    // DSH compacts in place instead of clearing. The summary survives, the block
    // the session started with does not, so re-inject that block — it already
    // carries the open work state — as soon as a compaction commits.
    if (event?.type !== 'compaction/end') return
    const agent = agents.get(session.id)
    if (agent === undefined || isSubagent(agent)) return
    void injectSessionContext(worker, agent, getSettings(), pendingInjections, debug)
  })

  on('agent/pre-step', async (payload: { agent: Agent; messages: readonly UserMessage[] }, next: () => Promise<unknown>) => {
    // Session registration and prompt capture are not optional: the row is what
    // gives an observation its context, and claude-mem exposes no switch for it
    // either. Only observation and summarization are switchable, here and there.
    if (!mode.isReadOnly(payload.agent.session)) recordPrompt(worker, payload.agent, payload.messages, getSettings())
    const typed = promptText(payload.messages)
    if (typed.length > 0) lastPrompt.set(payload.agent.session.id, typed)
    const decision = await next()
    return attachFileContext(payload.agent, decision, pendingFileContext)
  })

  // A full read of a large file that memory already covers is answered here, before
  // the tool runs: the gate is the point of the feature, and a decision is the only
  // way DSH lets a plugin stop a call.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const denial = await fileReadGate(exec, getSettings(), fileMemory, lastPrompt)
    if (denial !== null) return denial
    return next()
  })

  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const settings = getSettings()
    if (settings.ingest) observeToolResult(worker, exec, result, settings, subagents, isReadOnly)
    return next()
  })

  // File context rides a second listener so the observation path above stays untouched:
  // this one only starts the fetch and always forwards the decision unchanged.
  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
    const settings = getSettings()
    if (settings.fileContext && !result.isError) startFileContext(fileContext, exec, settings, pendingFileContext)
    return next()
  })

  on('agent/turn-stopping', (payload: { agent: Agent }) => {
    const settings = getSettings()
    if (settings.summarize && !mode.isReadOnly(payload.agent.session)) void summarizeSession(worker, payload.agent, settings)
  })
}

function observeToolResult(
  worker: WorkerClient,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  settings: LiveSettings,
  subagents: Map<string, SubagentIdentity>,
  isReadOnly: (sessionId: string) => boolean,
): void {
  if (!settings.toolFilter.names.includes(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  const delegated = isSubagent(agent)
  // With the switch off a subagent takes no part in memory at all — neither its
  // own work nor a bare child session it never registered.
  if (delegated && !settings.subagents) return
  const text = resultContentText(result.content)
  // A failure is evidence of an attempt, so it is recorded like any other
  // result; when the call produced no body of its own the error message is it.
  const body = text.length > 0 ? text : result.isError ? result.error.message.trim() : ''
  if (body.length === 0) return
  // A delegated run writes under its parent's name, so the parent's mode decides.
  const attribution = attributionOf(agent, subagents)
  if (isReadOnly(attribution.sessionId)) return
  recordToolUse(worker, exec, agent, body, settings, attribution, result.isError)
}

async function summarizeSession(worker: WorkerClient, agent: Agent, settings: LiveSettings): Promise<void> {
  const project = projectName(agent, settings)
  try {
    await worker.sessionSummarize({ contentSessionId: agent.session.id, project, ...writePlatform() })
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
  fileMemory: FileMemoryLookup,
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
    const memory = await fileMemory.inspect({ sessionId: agent.session.id, cwd }, absolute, AbortSignal.timeout(FILE_CONTEXT_TIMEOUT_MS))
    if (memory === null) return null
    // A file changed after its newest observation is no longer covered, so the
    // full read is allowed: the gate must not deny on stale notes.
    if (memory.mtimeMs >= memory.newestEpochMs) return null
  } catch {
    return null
  }
  return { kind: 'deny', reason: gateReason(absolute, size) }
}

/** Start one file-context fetch; the result is consumed at the next pre-step. */
function startFileContext(
  source: FileContextSource,
  exec: ToolExecution,
  settings: LiveSettings,
  pending: Map<string, Promise<string | null>>,
): void {
  const agent = exec.agent
  if (agent === undefined || isSubagent(agent)) return
  if (!settings.fileContextTools.includes(exec.name)) return
  const header = agent.session.header
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()
  pending.set(agent.session.id, source.fetch({
    sessionId: agent.session.id,
    cwd,
    toolName: exec.name,
    arguments: exec.arguments,
  }))
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

/**
 * Platform identity carried by everything this plugin writes.
 *
 * It is a constant, not a setting: claude-mem resolves a session through
 * `(platform_source, content_session_id)`, so a toggle could split one session
 * into two rows.
 */
function writePlatform(): { platformSource: string } {
  return { platformSource: DSH_PLATFORM }
}

/** Optional read filter; empty means every platform's memory, including history. */
function readPlatform(settings: LiveSettings): { platformSource?: string } {
  return settings.platformSource.length > 0 ? { platformSource: settings.platformSource } : {}
}

function resultContentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}
