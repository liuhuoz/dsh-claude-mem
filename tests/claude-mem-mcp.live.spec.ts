import { describe, expect, it } from 'vitest'
import { WorkerClient } from '../src/worker.js'
import { ClaudeMemMcp } from '../src/claude-mem-mcp.js'

const BASE_URL = process.env.DSH_MEM_BASE_URL ?? 'http://127.0.0.1:37777'

describe.skipIf(process.env.DSH_MEM_LIVE !== '1')('live claude-mem installation', () => {
  it('resolves the MCP server from the worker health payload', async () => {
    const worker = new WorkerClient({ baseUrl: BASE_URL, timeoutMs: 30_000 })
    const health = await worker.health()
    expect(typeof health.workerPath).toBe('string')

    const mcp = new ClaudeMemMcp(worker)
    const corpora = await mcp.call('list_corpora', {}, { cwd: process.cwd(), timeoutMs: 60_000 })
    expect(corpora.text.length).toBeGreaterThan(0)

    const outline = await mcp.call('smart_outline', { file_path: 'src/mcp.ts' }, { cwd: process.cwd(), timeoutMs: 120_000 })
    expect(outline.text).toContain('McpClient')
  }, 180_000)
})
