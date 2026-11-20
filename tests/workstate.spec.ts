import { describe, expect, it, vi, afterEach } from 'vitest'
import { WorkerClient } from '../src/worker.ts'

const limits = { baseUrl: 'http://127.0.0.1:39999', timeoutMs: 30_000 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkerClient.workState', () => {
  it('requests the project work state as plain text', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, text: async () => '- release\n  - [doing] ship' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const client = new WorkerClient(limits)
    const text = await client.workState({ cwd: 'D:/p', list: 'release', includeClosed: true })

    expect(text).toContain('[doing] ship')
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/api/work-state')
    expect(url).toContain('list=release')
    expect(url).toContain('includeClosed=true')
    expect(url).toContain('cwd=D%3A%2Fp')
  })

  it('omits the optional filters when they are not set', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, text: async () => 'Nothing open for p.' }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const client = new WorkerClient(limits)
    await client.workState({ cwd: 'D:/p' })

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).not.toContain('list=')
    expect(url).not.toContain('includeClosed')
  })
})
