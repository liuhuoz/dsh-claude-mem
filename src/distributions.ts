/**
 * Daily, type and project distributions for the panel's second tab.
 *
 * Primary source is the worker's own SQLite file, opened read-only: one GROUP BY
 * answers the whole tab in milliseconds. The HTTP API is the fallback for hosts
 * where that file is unreadable — it caps a page at 100 rows and cannot filter by
 * type or date, so the fallback walks every observation.
 * @module dsh-claude-mem/distributions
 */

import type { DayBucket, DistributionCell, Distributions } from './overview-types.js'

/** How many days of daily buckets the tab draws. */
export const DISTRIBUTION_DAYS = 84

/** One aggregated (day, type, project, count) row from either source. */
export interface DistributionRow {
  readonly day: string
  readonly type: string
  readonly project: string
  readonly count: number
}

/** What the reader needs; the caller owns URL resolution and test seams. */
export interface DistributionOptions {
  /** Resolved worker base URL. */
  readonly baseUrl: string
  /** Database path reported by the worker, when it reported one. */
  readonly databasePath?: string | undefined
  /** Clock, for the day window and for tests. */
  readonly now?: number
  /** fetch override for tests. */
  readonly fetchImpl?: typeof fetch
  /** Per-request deadline for the HTTP fallback. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4_000
const PAGE = 100
const MAX_ROWS = 50_000

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read distribution rows from the worker's SQLite file.
 * @param databasePath - absolute path from the worker's stats endpoint.
 * @returns rows, or undefined when this file cannot be read.
 */
async function rowsFromSqlite(databasePath: string): Promise<DistributionRow[] | undefined> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const statement = database.prepare('SELECT substr(created_at, 1, 10) AS day, type, project, COUNT(*) AS n FROM observations GROUP BY day, type, project')
      const rows = statement.all() as readonly { day?: unknown; type?: unknown; project?: unknown; n?: unknown }[]
      return rows.flatMap((row) => {
        const day = text(row.day)
        const type = text(row.type)
        const project = text(row.project)
        const count = num(row.n)
        if (day === undefined || type === undefined || count === undefined) return []
        return [{ day, type, project: project ?? '', count }]
      })
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}

/** One JSON GET that never throws. */
async function getJson(options: DistributionOptions, endpoint: string): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl ?? fetch)(options.baseUrl.replace(/\/+$/, '') + endpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Walk the observations API until it reports no more pages. */
async function rowsFromApi(options: DistributionOptions): Promise<DistributionRow[] | undefined> {
  const rows: DistributionRow[] = []
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const body = record(await getJson(options, '/api/observations?limit=' + PAGE + '&offset=' + offset))
    if (body === undefined) return offset === 0 ? undefined : rows
    const items = Array.isArray(body.items) ? body.items : []
    for (const item of items) {
      const entry = record(item)
      const day = text(entry?.created_at)?.slice(0, 10)
      const type = text(entry?.type)
      if (day === undefined || type === undefined) continue
      rows.push({ day, type, project: text(entry?.project) ?? '', count: 1 })
    }
    if (body.hasMore !== true || items.length === 0) break
  }
  return rows
}

/**
 * Fold raw rows into the payload the tab draws.
 * @param rows - aggregated rows from either source.
 * @param source - which source produced them.
 * @param now - clock, for the day window.
 * @returns daily buckets plus all-time type and project totals.
 */
export function foldDistributions(rows: readonly DistributionRow[], source: Distributions['source'], now: number): Distributions {
  const cutoff = new Date(now - (DISTRIBUTION_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  const days = new Map<string, { total: number; byType: Map<string, number>; byProject: Map<string, number> }>()
  const types = new Map<string, number>()
  const projects = new Map<string, { count: number; lastWrite: string }>()
  const cells = new Map<string, DistributionCell>()
  let total = 0

  for (const row of rows) {
    total += row.count
    types.set(row.type, (types.get(row.type) ?? 0) + row.count)
    const known = projects.get(row.project)
    if (known === undefined) projects.set(row.project, { count: row.count, lastWrite: row.day })
    else projects.set(row.project, { count: known.count + row.count, lastWrite: row.day > known.lastWrite ? row.day : known.lastWrite })

    if (row.day < cutoff) continue
    const bucket = days.get(row.day) ?? { total: 0, byType: new Map<string, number>(), byProject: new Map<string, number>() }
    bucket.total += row.count
    bucket.byType.set(row.type, (bucket.byType.get(row.type) ?? 0) + row.count)
    bucket.byProject.set(row.project, (bucket.byProject.get(row.project) ?? 0) + row.count)
    days.set(row.day, bucket)

    const cellKey = row.day + '\t' + row.type + '\t' + row.project
    const cell = cells.get(cellKey)
    if (cell === undefined) cells.set(cellKey, { day: row.day, type: row.type, project: row.project, count: row.count })
    else cells.set(cellKey, { day: cell.day, type: cell.type, project: cell.project, count: cell.count + row.count })
  }

  const sortedDays: DayBucket[] = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, bucket]) => ({
      day,
      total: bucket.total,
      byType: Object.fromEntries([...bucket.byType.entries()].sort((a, b) => b[1] - a[1])),
      byProject: Object.fromEntries([...bucket.byProject.entries()].sort((a, b) => b[1] - a[1])),
    }))

  return {
    source,
    total,
    days: sortedDays,
    types: [...types.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    projects: [...projects.entries()]
      .map(([key, value]) => ({ key, count: value.count, lastWrite: value.lastWrite }))
      .sort((a, b) => b.count - a.count),
    cells: [...cells.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
  }
}

/**
 * Read the distributions, preferring the database over the API.
 * @param options - worker URL, database path and test seams.
 * @returns the distributions, or null when neither source answered.
 */
export async function readDistributions(options: DistributionOptions): Promise<Distributions | null> {
  const now = options.now ?? Date.now()
  if (options.databasePath !== undefined && options.databasePath.length > 0) {
    const rows = await rowsFromSqlite(options.databasePath)
    if (rows !== undefined) return foldDistributions(rows, 'sqlite', now)
  }
  const rows = await rowsFromApi(options)
  return rows === undefined ? null : foldDistributions(rows, 'api', now)
}
