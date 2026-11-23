/**
 * Overview aggregation for the panel's first tab.
 *
 * The page cannot reach the worker directly (its origin is refused), so the
 * host process gathers every number once and hands back a single payload. Each
 * source settles independently: a worker that answers only some endpoints still
 * yields a partly filled overview, and a failing field is null rather than an
 * error.
 *
 * Token savings follow claude-mem's own arithmetic: bytes of "what it would
 * have cost to rediscover this natively" minus what the injection actually
 * spent, divided by the former. Those two totals only exist in claude-mem's
 * daily telemetry file, so this module reads that file for today only.
 * @module dsh-claude-mem/overview
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Overview, OverviewOptions } from './overview-types.js'

export type { Overview, OverviewOptions }

/** Host route the browser half calls. */
export const OVERVIEW_BRIDGE_PATH = '/api/dsh-claude-mem/overview'

/** One worker endpoint answered, or why it did not. */
type Settled<T> = { ok: true; value: T } | { ok: false }


const DEFAULT_TIMEOUT_MS = 4_000

/** One JSON GET that never throws. */
async function getJson(options: OverviewOptions, endpoint: string): Promise<Settled<unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const base = options.baseUrl.replace(/\/+$/, '')
  try {
    const response = await (options.fetchImpl ?? fetch)(base + endpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { ok: false }
    return { ok: true, value: await response.json() }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/** Narrow an unknown body to a record, or undefined. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Today in the host's local time as YYYY-MM-DD. */
function localDay(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

/** Read today's token savings out of claude-mem's telemetry file. */
async function readSavings(options: OverviewOptions, now: number): Promise<Overview['savings']> {
  const file = options.telemetryPath ?? path.join(homedir(), '.claude-mem', 'telemetry-daily.json')
  try {
    const payload = record(JSON.parse(await readFile(file, 'utf8')))
    if (payload === undefined) return null
    const day = text(payload.day)
    if (day === undefined || day !== localDay(now)) return null
    const rollups = record(payload.rollups)
    const injected = record(rollups?.context_injected_rollup)
    const sums = record(injected?.sums)
    if (sums === undefined) return null
    const readTokens = num(sums.total_tokens)
    const savedTokens = num(sums.total_tokens_saved_vs_naive)
    const events = num(injected?.counted) ?? num(injected?.events)
    if (readTokens === undefined || savedTokens === undefined) return null
    const total = readTokens + savedTokens
    return {
      day,
      events: events ?? 0,
      readTokens,
      savedTokens,
      percent: total > 0 ? Math.round((savedTokens / total) * 100) : 0,
    }
  } catch {
    return null
  }
}

/**
 * Gather the overview.
 * @param options - resolved worker URL plus test seams.
 * @returns the payload; unusable sources are null.
 */
export async function buildOverview(options: OverviewOptions): Promise<Overview> {
  const now = options.now ?? Date.now()
  const [health, stats, processing, mcp, chroma, projects, observations, sessions, savings] = await Promise.all([
    getJson(options, '/api/health'),
    getJson(options, '/api/stats'),
    getJson(options, '/api/processing-status'),
    getJson(options, '/api/mcp/status'),
    getJson(options, '/api/chroma/status'),
    getJson(options, '/api/projects'),
    getJson(options, '/api/observations?limit=5'),
    getJson(options, '/api/sessions?limit=50'),
    readSavings(options, now),
  ])

  const healthBody = health.ok ? record(health.value) : undefined
  const statsBody = stats.ok ? record(stats.value) : undefined
  const statsWorker = record(statsBody?.worker)
  const statsDb = record(statsBody?.database)
  const workerBody = record(healthBody) ?? statsWorker

  const worker = healthBody === undefined && statsWorker === undefined
    ? null
    : {
        ...(text(healthBody?.version) ?? text(statsWorker?.version) ? { version: text(healthBody?.version) ?? text(statsWorker?.version) } : {}),
        ...(num(statsWorker?.port) !== undefined ? { port: num(statsWorker?.port) } : {}),
        ...(num(statsWorker?.uptime) !== undefined ? { uptimeSeconds: num(statsWorker?.uptime) } : {}),
        ...(num(statsWorker?.activeSessions) !== undefined ? { activeSessions: num(statsWorker?.activeSessions) } : {}),
      }

  const database = statsDb === undefined
    ? null
    : {
        ...(num(statsDb.observations) !== undefined ? { observations: num(statsDb.observations) } : {}),
        ...(num(statsDb.sessions) !== undefined ? { sessions: num(statsDb.sessions) } : {}),
        ...(num(statsDb.summaries) !== undefined ? { summaries: num(statsDb.summaries) } : {}),
        ...(num(statsDb.size) !== undefined ? { sizeBytes: num(statsDb.size) } : {}),
        ...(text(statsDb.firstObservationAt) !== undefined ? { firstObservationAt: text(statsDb.firstObservationAt) } : {}),
      }

  const processingBody = processing.ok ? record(processing.value) : undefined
  const processingOut = processingBody === undefined
    ? null
    : {
        ...(num(processingBody.queueDepth) !== undefined ? { queueDepth: num(processingBody.queueDepth) } : {}),
        ...(typeof processingBody.isProcessing === 'boolean' ? { isProcessing: processingBody.isProcessing } : {}),
        ...(num(processingBody.lastSuccessfulStoreAt) !== undefined ? { lastSuccessfulStoreAt: num(processingBody.lastSuccessfulStoreAt) } : {}),
      }

  const mcpBody = mcp.ok ? record(mcp.value) : undefined
  const mcpOut = mcpBody === undefined ? null : { ...(typeof mcpBody.enabled === 'boolean' ? { enabled: mcpBody.enabled } : {}) }

  const chromaBody = chroma.ok ? record(chroma.value) : undefined
  const chromaOut = chromaBody === undefined ? null : { ...(text(chromaBody.status) !== undefined ? { status: text(chromaBody.status) } : {}) }

  const projectsBody = projects.ok ? record(projects.value) : undefined
  const projectNames = Array.isArray(projectsBody?.projects) ? projectsBody.projects.filter((item): item is string => typeof item === 'string') : []

  const recentBody = observations.ok ? record(observations.value) : undefined
  const recentItems = Array.isArray(recentBody?.items) ? recentBody.items : []
  const recentOut = observations.ok
    ? recentItems.flatMap((item) => {
        const entry = record(item)
        const type = text(entry?.type)
        const title = text(entry?.title)
        const createdAt = text(entry?.created_at)
        if (type === undefined || title === undefined || createdAt === undefined) return []
        return [{ type, title, project: text(entry?.project) ?? '', createdAt }]
      })
    : null

  const sessionsBody = sessions.ok ? record(sessions.value) : undefined
  const sessionItems = Array.isArray(sessionsBody?.sessions) ? sessionsBody.sessions : []
  const summarySessions = sessionItems.flatMap((item) => {
    const entry = record(item)
    if (entry === undefined) return []
    const title = text(entry.summary_title)
    const startedAt = num(entry.started_at_epoch)
    if (title === undefined || startedAt === undefined) return []
    return [{
      title,
      project: text(entry.project) ?? '',
      itemCount: num(entry.item_count) ?? 0,
      startedAt,
      sessionId: text(entry.content_session_id) ?? '',
    }]
  })
  const activeProjects = [...new Set(summarySessions.map((item) => item.project).filter((name) => name.length > 0))]
  const projectsOut = projects.ok
    ? { total: projectNames.length, active: activeProjects.length, excluded: Math.max(0, projectNames.length - activeProjects.length) }
    : null

  const sessionsOut = sessions.ok
    ? summarySessions
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 8)
        .map(({ title, project, itemCount, startedAt }) => ({ title, project, itemCount, startedAt }))
    : null

  // Injection project: the newest session that produced a summary.
  const newest = summarySessions.slice().sort((a, b) => b.startedAt - a.startedAt)[0]
  let injectionOut: Overview['injection'] = null
  if (newest !== undefined) {
    const context = await getJson(options, '/api/context/recent?project=' + encodeURIComponent(newest.project))
    const contextBody = context.ok ? record(context.value) : undefined
    const blocks = Array.isArray(contextBody?.content) ? contextBody.content : []
    const body = blocks.flatMap((block) => {
      const entry = record(block)
      return typeof entry?.text === 'string' ? [entry.text] : []
    }).join('\n').replace(/\u001B\[[0-9;]*m/g, '').trim()
    if (body.length > 0) {
      injectionOut = {
        project: newest.project,
        chars: body.length,
        lines: body.split('\n').length,
        head: body.slice(0, 240),
      }
    }
  }

  return {
    worker,
    database,
    processing: processingOut,
    mcp: mcpOut,
    chroma: chromaOut,
    projects: projectsOut,
    recent: recentOut,
    sessions: sessionsOut,
    injection: injectionOut,
    savings,
    fetchedAt: now,
  }
}
