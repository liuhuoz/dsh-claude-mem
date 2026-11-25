/**
 * `dsh-claude-mem` — a DeepSeek Harness plugin integrating claude-mem: query,
 * context injection, manual save, and session lifecycle over a local claude-mem
 * worker's HTTP API. A single self-contained package (no monorepo-only
 * dependencies), installable from a git clone via `dsh plugin add`.
 *
 * Platform scoping is a SIGNAL, never an enforced restriction: `platformSource`
 * defaults to unset (unfiltered). Both capture stages (`ingest`, `summarize`)
 * default to on, matching claude-mem's own behaviour, so a plain mount records
 * from the first turn.
 * @module dsh-claude-mem
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-skill'
import { WorkerClient } from './worker.js'
import { applyMemoryTools } from './tools.js'
import { applyMcpTools } from './mcp-tools.js'
import { applyMemoryHooks } from './hooks.js'
import { memSearchSkill } from './skill.js'
import { parseWorkerPid, resolveBaseUrl } from './endpoint.js'
import { DEFAULT_FILE_CONTEXT_TOOLS, DEFAULT_TOOL_NAMES, resolveSettings, type LiveSettings } from './settings.js'
import { registerHealthBridge, registerOverviewBridge } from './bridge.js'
import { OPEN_MODE, attachMemoryMode, type MemoryMode } from './memory-mode.js'

export const name = 'dsh-claude-mem'
export const inject = ['tools', 'skills']

/**
 * Port the worker published in `~/.claude-mem/worker.pid`. The plugin only ever
 * *finds* the worker; claude-mem decides where it listens. Cached briefly
 * because the resolved base URL is now read per request rather than once.
 */
let portCache: { at: number; port: number | undefined } | undefined

function publishedWorkerPort(): number | undefined {
  const now = Date.now()
  if (portCache !== undefined && now - portCache.at < 30_000) return portCache.port
  let port: number | undefined
  try {
    port = parseWorkerPid(readFileSync(join(homedir(), '.claude-mem', 'worker.pid'), 'utf8'))
  } catch {
    port = undefined
  }
  portCache = { at: now, port }
  return port
}

/**
 * Plugin configuration.
 *
 * The fields the settings page edits are `.volatile()`: schemastery then hands
 * the plugin a cell that the host writes in place, which is what lets an edit
 * take effect without remounting the plugin. Without that marker the settings
 * service projects no form for this namespace and the page has nothing to show.
 * Those values are read through `resolveSettings()` at the moment they are used.
 *
 * Only the two capture stages claude-mem itself lets a user switch off are
 * configurable here (`DISABLE_OBSERVATION` / `DISABLE_SUMMARY`). Session
 * registration, prompt capture and session-start injection always happen:
 * without them the plugin would not be doing its job, so a switch for them
 * would be a false choice.
 *
 * `timeoutMs`, `dedupe`, `project` and `platformSource` stay plain, so changing
 * them still needs a reload. `platformSource` only narrows reads: every capture
 * writes `DSH_PLATFORM`, because claude-mem keys a session on the platform.
 */
export const Config = Schema.object({
  baseUrl: Schema.string().default('').volatile(),
  timeoutMs: Schema.number().default(30_000),
  dedupe: Schema.boolean().default(true),
  sidebarEntry: Schema.boolean().default(false).volatile(),
  platformSource: Schema.string().default(''),
  project: Schema.string().default(''),
  ingest: Schema.boolean().default(true).volatile(),
  summarize: Schema.boolean().default(true).volatile(),
  toolFilter: Schema.object({
    names: Schema.array(Schema.string()).default([...DEFAULT_TOOL_NAMES]),
  }).default({ names: [...DEFAULT_TOOL_NAMES] }).volatile(),
  hookPath: Schema.string().default('').volatile(),
  workState: Schema.boolean().default(true).volatile(),
  fileContext: Schema.boolean().default(false).volatile(),
  fileContextGate: Schema.boolean().default(false).volatile(),
  subagents: Schema.boolean().default(true).volatile(),
  smart: Schema.boolean().default(true).volatile(),
  corpora: Schema.boolean().default(true).volatile(),
  fileContextTools: Schema.array(Schema.string()).default([...DEFAULT_FILE_CONTEXT_TOOLS]).volatile(),
  autoStartWorker: Schema.boolean().default(true).volatile(),
})

/** Mount the worker client, the model-facing tools plus the mem-search skill, and the lifecycle hooks. */
export function apply(ctx: Context, config: unknown): void {
  const current = (): LiveSettings => resolveSettings(config)
  const initial = current()
  assertPositiveInteger('timeoutMs', initial.timeoutMs)

  const worker = new WorkerClient({
    baseUrl: () => resolveBaseUrl(current().baseUrl, process.env.DSH_MEM_BASE_URL, publishedWorkerPort()),
    timeoutMs: initial.timeoutMs,
    dedupe: initial.dedupe,
  })

  /**
   * The per-session read-only mode. It starts open and is replaced once the
   * projection and command services mount, so a host that offers neither
   * records exactly as before.
   */
  const mode: MemoryMode = { isReadOnly: OPEN_MODE.isReadOnly }

  /** Live agents by session id, shared by the write hooks and the write tools. */
  const liveAgents = new Map<string, Agent>()
  ctx.inject(['sessionProjections', 'commands'], (sctx: Context) => {
    const live = attachMemoryMode(sctx)
    mode.isReadOnly = live.isReadOnly
    sctx.effect(() => () => {
      mode.isReadOnly = OPEN_MODE.isReadOnly
    }, 'dsh-claude-mem: read-only mode')
  })

  ctx.skills.register(memSearchSkill)
  applyMemoryTools(ctx, worker, {
    timeoutMs: initial.timeoutMs,
    workState: initial.workState,
    mode,
    sessions: liveAgents,
  })
  applyMcpTools(ctx, worker, {
    smart: initial.smart,
    corpora: initial.corpora,
    timeoutMs: initial.timeoutMs,
  })
  applyMemoryHooks(ctx, worker, current, mode, liveAgents)
  registerHealthBridge(ctx)
  registerOverviewBridge(ctx, () => resolveBaseUrl(current().baseUrl, process.env.DSH_MEM_BASE_URL, publishedWorkerPort()))
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`claude-mem: ${field} must be a positive integer`)
  }
}
