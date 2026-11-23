import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldDistributions, readDistributions } from '../src/distributions.js'
import { buildOverview } from '../src/overview.js'

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)

/** A throwaway worker database with an observations table. */
function fixtureDatabase(rows: readonly (readonly [string, string, string])[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'mem-dist-')), 'claude-mem.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE observations (created_at TEXT, type TEXT, project TEXT)')
  const insert = db.prepare('INSERT INTO observations (created_at, type, project) VALUES (?, ?, ?)')
  for (const [createdAt, type, project] of rows) insert.run(createdAt, type, project)
  db.close()
  return file
}

describe('readDistributions', () => {
  it('reads daily, type and project buckets straight from SQLite', async () => {
    const path = fixtureDatabase([
      ['2026-11-22T10:00:00.000Z', 'bugfix', 'alpha'],
      ['2026-11-22T11:00:00.000Z', 'bugfix', 'alpha'],
      ['2026-11-23T09:00:00.000Z', 'discovery', 'beta'],
      ['2026-01-01T09:00:00.000Z', 'decision', 'alpha'],
    ])
    const distributions = await readDistributions({ baseUrl: 'http://127.0.0.1:1', databasePath: path, now: NOW })
    expect(distributions?.source).toBe('sqlite')
    expect(distributions?.total).toBe(4)
    expect(distributions?.types).toEqual([
      { key: 'bugfix', count: 2 },
      { key: 'decision', count: 1 },
      { key: 'discovery', count: 1 },
    ])
    expect(distributions?.projects).toEqual([
      { key: 'alpha', count: 3, lastWrite: '2026-11-22' },
      { key: 'beta', count: 1, lastWrite: '2026-11-23' },
    ])
    expect(distributions?.days.map((day) => day.day)).toEqual(['2026-11-22', '2026-11-23'])
    expect(distributions?.days[1]).toMatchObject({ total: 1, byType: { discovery: 1 } })
  })

  it('falls back to paging the API when the database is unreadable', async () => {
    const pages: Record<string, unknown> = {
      '/api/observations?limit=100&offset=0': {
        items: [
          { created_at: '2026-11-23T09:00:00.000Z', type: 'feature', project: 'alpha' },
          { created_at: '2026-11-22T09:00:00.000Z', type: 'bugfix', project: 'beta' },
        ],
        hasMore: true,
      },
      '/api/observations?limit=100&offset=100': { items: [], hasMore: false },
    }
    const fetchImpl = (async (input: string | URL) => {
      const key = Object.keys(pages).find((path) => String(input).endsWith(path))
      if (key === undefined) throw new Error('unexpected ' + String(input))
      return { ok: true, json: async () => pages[key] } as Response
    }) as unknown as typeof fetch

    const distributions = await readDistributions({
      baseUrl: 'http://127.0.0.1:1',
      databasePath: join(tmpdir(), 'missing', 'claude-mem.db'),
      now: NOW,
      fetchImpl,
    })
    expect(distributions?.source).toBe('api')
    expect(distributions?.total).toBe(2)
    expect(distributions?.projects.map((project) => project.key)).toEqual(['alpha', 'beta'])
  })

  it('returns null when neither source answers', async () => {
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const distributions = await readDistributions({
      baseUrl: 'http://127.0.0.1:1',
      databasePath: join(tmpdir(), 'missing', 'claude-mem.db'),
      now: NOW,
      fetchImpl,
    })
    expect(distributions).toBeNull()
  })
})

describe('foldDistributions', () => {
  it('sorts day buckets chronologically and keeps only the window', () => {
    const folded = foldDistributions(
      [
        { day: '2026-11-23', type: 'feature', project: 'a', count: 3 },
        { day: '2026-11-21', type: 'bugfix', project: 'b', count: 1 },
      ],
      'api',
      NOW,
    )
    expect(folded.days.map((day) => day.day)).toEqual(['2026-11-21', '2026-11-23'])
    expect(folded.days[1].byProject).toEqual({ a: 3 })
  })
})

describe('buildOverview distributions', () => {
  it('includes the distribution payload and its source', async () => {
    const path = fixtureDatabase([['2026-11-23T09:00:00.000Z', 'feature', 'alpha']])
    const payloads: Record<string, unknown> = {
      '/api/health': { status: 'ok', version: '16.0.3' },
      '/api/stats': { worker: { version: '16.0.3' }, database: { observations: 1, path } },
      '/api/processing-status': {},
      '/api/mcp/status': { enabled: true },
      '/api/chroma/status': { status: 'disabled' },
      '/api/projects': { projects: ['alpha'] },
      '/api/observations?limit=5': { items: [] },
      '/api/sessions?limit=50': { sessions: [] },
    }
    const fetchImpl = (async (input: string | URL) => {
      const key = Object.keys(payloads).find((item) => String(input).endsWith(item))
      if (key === undefined) throw new Error('unexpected ' + String(input))
      return { ok: true, json: async () => payloads[key] } as Response
    }) as unknown as typeof fetch

    const overview = await buildOverview({ baseUrl: 'http://127.0.0.1:1', now: NOW, fetchImpl, telemetryPath: join(tmpdir(), 'none.json') })
    expect(overview.distributions?.source).toBe('sqlite')
    expect(overview.distributions?.types).toEqual([{ key: 'feature', count: 1 }])
  })
})
