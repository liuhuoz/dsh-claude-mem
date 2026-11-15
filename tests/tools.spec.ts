import { describe, expect, it } from 'vitest'
import { applyMemoryTools } from '../src/tools.ts'

/** A tool definition as registered on `ctx.tools`. */
interface Captured {
  name: string
  output: { render: (args: unknown, value: { content: string }) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal }) => Promise<{ content: string }>
}

/** Register the memory tools against a stub context and return them by name. */
function capture(worker: { search: Function; timeline: Function }): Record<string, Captured> {
  const registered: Record<string, Captured> = {}
  const ctx = { tools: { register: (def: Captured) => { registered[def.name] = def } } }
  applyMemoryTools(ctx as never, worker as never, { timeoutMs: 1000 })
  return registered
}

const TABLE = 'Found 1 result(s) matching "q"\n\n| ID | Time | T | Title | Read |\n|----|------|---|-------|------|\n| #1 | 2:02 PM | ○ | thing | ~10 |\n'

describe('mem_search output', () => {
  it('passes the worker text through untouched', async () => {
    const tool = capture({ search: async () => ({ items: [], content: TABLE }), timeline: async () => ({ items: [] }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(value).toEqual({ content: TABLE })
    expect(tool.output.render({ query: 'q' }, value)).toEqual([{ type: 'text', text: TABLE }])
  })

  it('renders nothing when the worker sends no text, rather than inventing a message', async () => {
    const tool = capture({ search: async () => ({ items: [] }), timeline: async () => ({ items: [] }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(value).toEqual({ content: '' })
    expect(tool.output.render({ query: 'q' }, value)).toEqual([{ type: 'text', text: '' }])
  })

  it('exposes content and nothing else', async () => {
    const tool = capture({ search: async () => ({ items: [], content: TABLE }), timeline: async () => ({ items: [] }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(Object.keys(value)).toEqual(['content'])
  })
})

describe('mem_timeline output', () => {
  it('passes the worker text through untouched', async () => {
    const tool = capture({ search: async () => ({ items: [] }), timeline: async () => ({ items: [], content: 'timeline text' }) }).mem_timeline
    const value = await tool.execute({ anchor: 1 }, {})
    expect(value).toEqual({ content: 'timeline text' })
  })
})
