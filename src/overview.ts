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
 * daily telemetry file, so this module reads the day that file carries.
 * @module dsh-claude-mem/overview
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { InjectionSection, Overview, OverviewOptions } from './overview-types.js'
import { readDistributions } from './distributions.js'
import { mcpClientReading } from './mcp-presence.js'
import { parseHealth } from './probe.js'

export type { Overview, OverviewOptions }

/** Host route the browser half calls. */
export const OVERVIEW_BRIDGE_PATH = '/api/dsh-claude-mem/overview'

/** One worker endpoint answered, or why it did not. */
type Settled<T> = { ok: true; value: T } | { ok: false }


const DEFAULT_TIMEOUT_MS = 4_000

/**
 * Split claude-mem's recent-context block into its memory and its summaries.
 *
 * The block opens with a markdown title and a "Showing last N session(s) for …"
 * line, which describe the block instead of carrying memory; both are dropped,
 * so the text starts at the first `**Summary (Prompt #N)**` heading, and each
 * summary is split out for the sessions tab's per-entry rows.
 * @param body - the block text, ANSI already stripped.
 * @returns the memory text and one entry per summary it carries.
 */
export function splitContextBlock(body: string): { text: string; sections: InjectionSection[] } {
  const lines = body.split('\n')
  let start = 0
  while (start < lines.length) {
    const line = lines[start].trim()
    const label = line.length === 0 || line.startsWith('#') || line === '---' || /^Showing last \d+ session/i.test(line)
    if (!label) break
    start += 1
  }
  const text = lines.slice(start).join('\n').trim()
  const sections: InjectionSection[] = []
  let prompt: string | undefined
  let held: string[] = []
  const flush = (): void => {
    if (prompt === undefined) return
    const fields: { label: string; value: string }[] = []
    for (const line of held) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // The block separates summaries with a horizontal rule; it is markup, not
      // the tail of whichever field the line happens to follow.
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue
      const match = /^\*\*([^*]+):\*\*\s*(.*)$/.exec(trimmed)
      if (match === null) {
        const last = fields[fields.length - 1]
        if (last === undefined) continue
        fields[fields.length - 1] = { label: last.label, value: (last.value + '\n' + trimmed).trim() }
        continue
      }
      fields.push({ label: (match[1] ?? '').trim(), value: (match[2] ?? '').trim() })
    }
    const stamped = (fields.find((field) => /^date$/i.test(field.label))?.value ?? '').trim().split('\n')[0]?.trim() ?? ''
    const kept = fields.filter((field) => !/^date$/i.test(field.label))
    const request = kept.find((field) => /^request$/i.test(field.label))?.value ?? ''
    const parsed = stamped.length > 0 ? Date.parse(stamped.replace(/\//g, '-')) : Number.NaN
    sections.push({ prompt: 'Prompt #' + prompt, date: stamped, at: Number.isNaN(parsed) ? 0 : parsed, request, fields: kept })
  }
  for (const line of text.split('\n')) {
    const match = /^\*\*Summary \(Prompt #(\d+)\)\*\*$/.exec(line.trim())
    if (match === null) {
      if (prompt !== undefined) held.push(line)
      continue
    }
    flush()
    prompt = match[1] ?? ''
    held = []
  }
  flush()
  // The block lists its summaries out of order, so the newest is found by the
  // stamp it carries; entries without one keep their block order last.
  sections.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
  return { text, sections }
}

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

/**
 * Read the token savings claude-mem's telemetry file carries.
 *
 * The file holds one day, stamped on the writer's UTC clock, and the writer only
 * rolls it when it has something to record. Whatever day it carries is therefore
 * the newest data there is: showing it beats blanking the line at local midnight
 * or on a quiet day, and `day` travels in the payload so the page can say which
 * day the numbers belong to.
 * @param options - resolved worker URL plus test seams.
 * @returns the day's totals, or null when the file has none.
 */
async function readSavings(options: OverviewOptions): Promise<Overview['savings']> {
  const file = options.telemetryPath ?? path.join(homedir(), '.claude-mem', 'telemetry-daily.json')
  try {
    const payload = record(JSON.parse(await readFile(file, 'utf8')))
    if (payload === undefined) return null
    const day = text(payload.day)
    if (day === undefined) return null
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
    readSavings(options),
  ])

  // Whether this host could launch the worker's MCP server is a separate answer
  // from the worker's own `mcp.ready`, so it is looked up rather than read.
  const mcpClient = await mcpClientReading(options.baseUrl, health.ok ? parseHealth(health.value) : undefined, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })

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
      const { text: memory, sections } = splitContextBlock(body)
      injectionOut = {
        project: newest.project,
        at: (sections[0]?.at ?? 0) > 0 ? sections[0]?.at ?? newest.startedAt : newest.startedAt,
        chars: body.length,
        lines: body.split('\n').length,
        text: memory,
        sections,
      }
    }
  }

  const distributions = await readDistributions({
    baseUrl: options.baseUrl,
    databasePath: text(statsDb?.path),
    now,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })

  return {
    worker,
    database,
    processing: processingOut,
    mcp: mcpOut,
    mcpClient,
    chroma: chromaOut,
    projects: projectsOut,
    recent: recentOut,
    sessions: sessionsOut,
    injection: injectionOut,
    savings,
    distributions,
    fetchedAt: now,
  }
}
