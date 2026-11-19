import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyMcpTools } from '../src/mcp-tools.js'
import type { WorkerClient } from '../src/worker.js'

const worker = {} as unknown as WorkerClient

function registered(config: { smart?: boolean; corpora?: boolean }): string[] {
  const names: string[] = []
  const ctx = { tools: { register: (tool: { name: string }) => { names.push(tool.name) } } } as unknown as Context
  applyMcpTools(ctx, worker, { timeoutMs: 30_000, ...config })
  return names
}

describe('applyMcpTools', () => {
  it('registers the three smart tools and six corpus tools by default', () => {
    const names = registered({})
    expect(names).toEqual([
      'mem_smart_search',
      'mem_smart_outline',
      'mem_smart_unfold',
      'mem_corpus_list',
      'mem_corpus_build',
      'mem_corpus_prime',
      'mem_corpus_query',
      'mem_corpus_rebuild',
      'mem_corpus_reprime',
    ])
  })

  it('honours each switch', () => {
    expect(registered({ smart: false }).every(name => !name.startsWith('mem_smart_'))).toBe(true)
    expect(registered({ corpora: false }).every(name => !name.startsWith('mem_corpus_'))).toBe(true)
    expect(registered({ smart: false, corpora: false })).toEqual([])
  })
})
