import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOverview, splitContextBlock } from '../src/overview.js'

/** The day key claude-mem stamps on its daily telemetry: UTC, per the worker. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 00:30 local (+08:00): the local date has rolled, the worker's UTC day has not. */
const NOW = new Date('2026-11-24T00:30:00+08:00').getTime()

/** Payloads keyed by the endpoint path. */
function fakeFetch(payloads: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    const key = Object.keys(payloads).find((path) => url.endsWith(path))
    if (key === undefined) throw new Error('unexpected ' + url)
    return { ok: true, json: async () => payloads[key] } as Response
  }) as unknown as typeof fetch
}

/** A telemetry file whose day is the day under test unless overridden. */
function telemetry(day: string, readTokens: number, savedTokens: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'mem-overview-'))
  const file = join(dir, 'telemetry-daily.json')
  writeFileSync(file, JSON.stringify({
    day,
    rollups: {
      context_injected_rollup: {
        events: 2,
        counted: 7,
        sums: { total_tokens: readTokens, total_tokens_saved_vs_naive: savedTokens },
      },
    },
  }))
  return file
}

const payloads = {
  '/api/health': { status: 'ok', version: '16.0.3' },
  '/api/stats': {
    worker: { version: '16.0.3', port: 37777, uptime: 3600, activeSessions: 1 },
    database: { observations: 2500, sessions: 70, summaries: 630, size: 15_000_000, firstObservationAt: '2026-05-24T02:07:09.175Z' },
  },
  '/api/processing-status': { queueDepth: 0, isProcessing: false, lastSuccessfulStoreAt: 1_700_000_000_000 },
  '/api/mcp/status': { enabled: true },
  '/api/chroma/status': { status: 'disabled' },
  '/api/projects': { projects: ['a', 'b', 'probe-x'] },
  '/api/observations?limit=5': {
    items: [{ type: 'discovery', title: 'first', project: 'a', created_at: '2026-11-23T10:00:00.000Z' }],
  },
  '/api/sessions?limit=50': {
    sessions: [
      { content_session_id: 's1', project: 'a', summary_title: 'real session', item_count: 12, started_at_epoch: 1_700_000_100_000 },
      { content_session_id: 's2', project: 'probe-x', summary_title: null, item_count: 1, started_at_epoch: 1_700_000_200_000 },
    ],
  },
  '/api/context/recent?project=a': { content: [{ type: 'text', text: 'line one\nline two' }] },
}

describe('buildOverview', () => {
  it('aggregates worker, database, projects and sessions from one round of requests', async () => {
    const overview = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry(utcDay(NOW), 264_000, 38_762_000),
    })
    expect(overview.worker).toMatchObject({ version: '16.0.3', port: 37777, activeSessions: 1 })
    expect(overview.database).toMatchObject({ observations: 2500, summaries: 630 })
    expect(overview.processing).toMatchObject({ queueDepth: 0 })
    expect(overview.mcp).toEqual({ enabled: true })
    expect(overview.chroma).toEqual({ status: 'disabled' })
  })

  it('counts only projects whose session produced a summary', async () => {
    const overview = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry(utcDay(NOW), 1, 1),
    })
    expect(overview.projects).toEqual({ total: 3, active: 1, excluded: 2 })
    expect(overview.sessions).toHaveLength(1)
    expect(overview.sessions?.[0]).toMatchObject({ title: 'real session', project: 'a', itemCount: 12 })
  })

  it('lifts the block stamp out of the fields and orders summaries newest first', () => {
    const body = [
      '# Recent Session Context',
      '',
      'Showing last 2 session(s) for **alpha**:',
      '',
      '**Summary (Prompt #19)**',
      '**Date:** 2026/11/24 11:59:08',
      '**Request:** older ask',
      '',
      '---',
      '',
      '**Summary (Prompt #26)**',
      '**Date:** 2026/11/24 18:54:11',
      '**Request:** newer ask',
    ].join('\n')
    const { sections } = splitContextBlock(body)
    expect(sections.map((section) => section.prompt)).toEqual(['Prompt #26', 'Prompt #19'])
    expect(sections[0]?.date).toBe('2026/11/24 18:54:11')
    expect(sections[0]?.fields.map((field) => field.label)).toEqual(['Request'])
    expect(sections[0]?.request).toBe('newer ask')
    expect(sections[1]?.request).toBe('older ask')
  })

  it('splits the recent-context block into one entry per summary', () => {
    const body = [
      '# Recent Session Context',
      '',
      'Showing last 2 session(s) for **alpha**:',
      '',
      '---',
      '',
      '**Summary (Prompt #19)**',
      '',
      '**Request:** rebuild the changelog',
      '**Completed:** moved the notes',
      '',
      '**Summary (Prompt #18)**',
      '',
      '**Request:** ship 1.1.0',
    ].join('\n')
    const { text, sections } = splitContextBlock(body)
    expect(text.startsWith('**Summary (Prompt #19)**')).toBe(true)
    expect(sections.map((section) => section.prompt)).toEqual(['Prompt #19', 'Prompt #18'])
    expect(sections[0]?.request).toBe('rebuild the changelog')
    expect(sections[1]?.request).toBe('ship 1.1.0')
    expect(sections[0]?.fields).toEqual([
      { label: 'Request', value: 'rebuild the changelog' },
      { label: 'Completed', value: 'moved the notes' },
    ])
  })

  it('derives the injection project from the newest summarised session', async () => {
    const overview = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry(utcDay(NOW), 1, 1),
    })
    expect(overview.injection).toMatchObject({ project: 'a', lines: 2 })
    expect(overview.injection?.chars).toBe('line one\nline two'.length)
  })

  it('reports the savings the telemetry file carries', async () => {
    const fresh = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry(utcDay(NOW), 264_000, 38_762_000),
    })
    expect(fresh.savings).toMatchObject({ events: 7, readTokens: 264_000, savedTokens: 38_762_000 })
    expect(fresh.savings?.percent).toBe(Math.round((38_762_000 / (38_762_000 + 264_000)) * 100))

    const carried = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry('2000-01-01', 1, 1),
    })
    expect(carried.savings).toMatchObject({ day: '2000-01-01', readTokens: 1, savedTokens: 1 })
  })

  it('keeps showing savings after local midnight, when the file is still on the previous UTC day', async () => {
    const overview = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: fakeFetch(payloads),
      telemetryPath: telemetry('2026-11-23', 475_426, 64_539_746),
    })
    expect(overview.savings).toMatchObject({ day: '2026-11-23', readTokens: 475_426, savedTokens: 64_539_746 })
  })

  it('degrades to nulls instead of throwing when the worker is unreachable', async () => {
    const overview = await buildOverview({
      baseUrl: 'http://127.0.0.1:37777',
      now: NOW,
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      telemetryPath: join(tmpdir(), 'overview-missing-telemetry.json'),
    })
    expect(overview.worker).toBeNull()
    expect(overview.database).toBeNull()
    expect(overview.projects).toBeNull()
    expect(overview.recent).toBeNull()
    expect(overview.sessions).toBeNull()
    expect(overview.injection).toBeNull()
    expect(overview.savings).toBeNull()
  })
})
