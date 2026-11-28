import { describe, expect, it, vi, afterEach } from 'vitest'
import { WorkerClient, workerPathFromDoctor } from '../src/worker.ts'

const limits = { baseUrl: 'http://127.0.0.1:39999', timeoutMs: 30_000 }

function stubFetch(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkerClient.search', () => {
  it('normalizes an MCP-shaped content response into content text', async () => {
    stubFetch({ content: [{ type: 'text', text: 'index table' }] })
    const client = new WorkerClient(limits)
    const result = await client.search({ query: 'q' })
    expect(result.content).toBe('index table')
    expect(result.items).toEqual([])
  })

  it('normalizes a bare array response into items', async () => {
    stubFetch([{ id: 9, title: 'nine', narrative: 'full text', project: 'p' }])
    const client = new WorkerClient(limits)
    const result = await client.search({ query: 'q' })
    expect(result.items).toMatchObject([{ id: 9, title: 'nine', narrative: 'full text', project: 'p' }])
  })

  it('deduplicates the rendered index text (rows differing only by id)', async () => {
    const text = '| #627 | 12:22 PM | ◆ | Media prompt processing session initiated | ~144 |\n| #671 | ″ | ◆ | Media prompt processing session initiated | ~144 |'
    stubFetch({ content: [{ type: 'text', text }] })
    const client = new WorkerClient({ ...limits, dedupe: true })
    const result = await client.search({ query: 'q' })
    expect(result.content).toContain('#627')
    expect(result.content).not.toContain('#671')
  })

  it('leaves rendered text untouched when dedupe is disabled', async () => {
    const text = '| #627 | 12:22 PM | ◆ | Media prompt processing session initiated | ~144 |\n| #671 | ″ | ◆ | Media prompt processing session initiated | ~144 |'
    stubFetch({ content: [{ type: 'text', text }] })
    const client = new WorkerClient({ ...limits, dedupe: false })
    const result = await client.search({ query: 'q' })
    expect(result.content).toBe(text)
  })

  it('omits platformSource when not set (unfiltered)', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerClient(limits)
    await client.search({ query: 'q' })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).not.toContain('platformSource')
  })

  it('forwards platformSource when present as an optional filter', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerClient(limits)
    await client.search({ query: 'q', platformSource: 'dsh' })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('platformSource=dsh')
  })
})

describe('WorkerClient.getObservations', () => {
  it('posts ids as a batch body and normalizes the bare array', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { method?: string; body?: unknown }) =>
      ({ ok: true, status: 200, json: async () => ([{ id: 650, title: 'nine', narrative: 'full' }]), text: async () => '[]' }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650, 694] })
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
    expect(result.items).toMatchObject([{ id: 650, title: 'nine', narrative: 'full' }])
  })

  it('deduplicates identical content (same narrative) when dedupe is true', async () => {
    stubFetch([
      { id: 627, title: 'Media prompt', narrative: 'same' },
      { id: 671, title: 'Media prompt', narrative: 'same' },
      { id: 715, title: 'Media prompt', narrative: 'distinct' },
    ])
    const client = new WorkerClient({ ...limits, dedupe: true })
    const result = await client.getObservations({ ids: [627, 671, 715] })
    expect(result.items.map(i => i.id)).toEqual([627, 715])
  })

  it('keeps raw results when dedupe is disabled', async () => {
    stubFetch([
      { id: 627, title: 'Media prompt', narrative: 'same' },
      { id: 671, title: 'Media prompt', narrative: 'same' },
    ])
    const client = new WorkerClient({ ...limits, dedupe: false })
    const result = await client.getObservations({ ids: [627, 671] })
    expect(result.items.map(i => i.id)).toEqual([627, 671])
  })

  it('rejects an empty id list', async () => {
    const client = new WorkerClient(limits)
    await expect(client.getObservations({ ids: [] })).rejects.toMatchObject({ code: 'MEM_INVALID_REQUEST' })
  })

  it('decodes JSON-string list/object fields for parity with the raw API', async () => {
    stubFetch([{
      id: 650,
      title: 'nine',
      narrative: 'full',
      facts: '["a","b"]',
      concepts: '[]',
      files_read: '["x.c"]',
      files_modified: '[]',
      metadata: '{"kind":"architecture"}',
      created_at: '2026-08-02T14:03:15.937Z',
      created_at_epoch: 1785679395937,
      memory_session_id: 'manual-VCU',
      subtitle: 'Manual memory',
      content_hash: 'abc123',
    }])
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650] })
    expect(result.items[0]).toMatchObject({
      id: 650,
      title: 'nine',
      narrative: 'full',
      facts: ['a', 'b'],
      concepts: [],
      filesRead: ['x.c'],
      filesModified: [],
      metadata: { kind: 'architecture' },
      createdAt: '2026-08-02T14:03:15.937Z',
      createdAtEpoch: 1785679395937,
      memorySessionId: 'manual-VCU',
      subtitle: 'Manual memory',
      contentHash: 'abc123',
    })
  })

  it('drops a non-JSON list string rather than leaking the raw string', async () => {
    stubFetch([{ id: 650, title: 'nine', facts: 'not-json', concepts: '[]' }])
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650] })
    expect(result.items[0].concepts).toEqual([])
    expect(result.items[0].facts).toBeUndefined()
  })
})

describe('WorkerClient.dumbSearch', () => {
  it('posts the mapped body and keeps the failure tag', async () => {
    stubFetch({ content: [{ type: 'text', text: 'dumb text' }], isError: true })
    const client = new WorkerClient(limits)
    const result = await client.dumbSearch({ query: 'q', limit: 5, maxDetails: 2 })
    expect(result).toEqual({ content: 'dumb text', isError: true })
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://127.0.0.1:39999/api/dumb-search')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ query: 'q', limit: 5, maxDetails: 2 })
  })

  it('rejects a blank query before any request', async () => {
    const client = new WorkerClient(limits)
    await expect(client.dumbSearch({ query: '   ' })).rejects.toThrow(/query is required/)
  })
})

describe('WorkerClient.toolUses', () => {
  it('posts the ids and maps snake_case rows with bodies untouched', async () => {
    stubFetch([{
      id: 542,
      tool_use_id: 'chatcmpl-1',
      tool_name: 'Bash',
      project: '.dsh',
      tool_input: '{"command":"x"}',
      tool_response: 'ok',
      tool_input_bytes: 15,
      tool_response_bytes: 2,
    }])
    const client = new WorkerClient(limits)
    const rows = await client.toolUses({ ids: [542] })
    expect(rows).toEqual([{
      id: 542,
      toolUseId: 'chatcmpl-1',
      toolName: 'Bash',
      project: '.dsh',
      toolInput: '{"command":"x"}',
      toolResponse: 'ok',
      inputBytes: 15,
      responseBytes: 2,
    }])
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://127.0.0.1:39999/api/tool-uses/batch')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ ids: [542] })
  })

  it('rejects an empty id list', async () => {
    const client = new WorkerClient(limits)
    await expect(client.toolUses({ ids: [] })).rejects.toThrow(/at least one tool-use id/)
  })
})

describe('WorkerClient.ingestObservation', () => {
  const base = { contentSessionId: 'session-1', toolName: 'Read', cwd: 'C:/work', platformSource: 'dsh' } as const

  it('posts the direct-capture body and reports queued', async () => {
    stubFetch({ status: 'queued' })
    const client = new WorkerClient(limits)
    const answer = await client.ingestObservation({
      ...base,
      toolInput: { file_path: 'a.ts' },
      toolResponse: { content: [], is_error: false },
      toolUseId: 'call-1',
      agentId: 'child-1',
      agentType: 'explore',
      eventOccurredAtEpochMs: 5,
    })
    expect(answer).toBe('queued')
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls[0][0]).toBe('http://127.0.0.1:39999/api/sessions/observations')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({
      contentSessionId: 'session-1',
      tool_name: 'Read',
      cwd: 'C:/work',
      platformSource: 'dsh',
      tool_input: { file_path: 'a.ts' },
      tool_response: { content: [], is_error: false },
      tool_use_id: 'call-1',
      agentId: 'child-1',
      agentType: 'explore',
      eventOccurredAtEpochMs: 5,
    })
  })

  it('treats a skip as the worker answering, not as a failure', async () => {
    stubFetch({ status: 'skipped', reason: 'tool_excluded' })
    const client = new WorkerClient(limits)
    await expect(client.ingestObservation(base)).resolves.toBe('skipped')
  })

  it('rejects when the worker refuses the event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'initializing',
      json: async () => ({}),
    }) as Response))
    const client = new WorkerClient(limits)
    await expect(client.ingestObservation(base)).rejects.toMatchObject({ code: 'MEM_PROVIDER_ERROR' })
  })
})

describe('WorkerClient.workerScriptPath', () => {
  /** One fetch stub that answers health and doctor from the same URL map. */
  function stubRoutes(routes: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const href = String(url)
      const key = Object.keys(routes).find(path => href.endsWith(path))
      if (key === undefined) return { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response
      const body = routes[key]
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response
    }))
  }

  it('uses the path an older worker publishes on health', async () => {
    stubRoutes({ '/api/health': { status: 'ok', workerPath: 'C:/cm/scripts/worker-service.cjs' } })
    const client = new WorkerClient(limits)
    await expect(client.workerScriptPath()).resolves.toBe('C:/cm/scripts/worker-service.cjs')
  })

  it('falls back to the supervisor payload when health names no path', async () => {
    stubRoutes({
      '/api/health': { status: 'ok' },
      '/api/admin/doctor': { health: { workerPath: 'C:/cm/17.0.2/scripts/worker-service.cjs' } },
    })
    const client = new WorkerClient(limits)
    await expect(client.workerScriptPath()).resolves.toBe('C:/cm/17.0.2/scripts/worker-service.cjs')
  })

  it('names no script when neither payload carries one', async () => {
    stubRoutes({ '/api/health': { status: 'ok' }, '/api/admin/doctor': { health: {} } })
    const client = new WorkerClient(limits)
    await expect(client.workerScriptPath()).resolves.toBeUndefined()
  })

  it('reads nothing out of a doctor payload of another shape', () => {
    expect(workerPathFromDoctor({ health: { workerPath: '  ' } })).toBeUndefined()
    expect(workerPathFromDoctor({ health: null })).toBeUndefined()
    expect(workerPathFromDoctor('nope')).toBeUndefined()
  })
})

describe('WorkerClient.workStateWrite', () => {
  const request = { cwd: 'C:/work', list: 'agent-lifecycle', fields: { task: 't' } }

  it('reports a refused write under its own code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => 'a check command refused this write',
    }) as Response))
    const client = new WorkerClient(limits)
    await expect(client.workStateWrite(request)).rejects.toMatchObject({ code: 'MEM_WRITE_REFUSED' })
  })

  it('keeps a transient failure retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'initializing',
    }) as Response))
    const client = new WorkerClient(limits)
    await expect(client.workStateWrite(request)).rejects.toMatchObject({ code: 'MEM_PROVIDER_ERROR' })
  })
})
