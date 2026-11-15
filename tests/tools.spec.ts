import { describe, expect, it } from 'vitest'
import { applyMemoryTools } from '../src/tools.ts'

/** A tool definition as registered on `ctx.tools`. */
interface Captured {
  name: string
  output: {
    render: (args: unknown, value: any) => Array<{ type: string; text: string }>
    schema: { properties?: Record<string, unknown> }
  }
  execute: (args: any, exec: any) => Promise<any>
}

/** Register the memory tools against a stub context and return them by name. */
function capture(worker: Record<string, Function>): Record<string, Captured> {
  const registered: Record<string, Captured> = {}
  const ctx = { tools: { register: (def: Captured) => { registered[def.name] = def } } }
  applyMemoryTools(ctx as never, worker as never, { timeoutMs: 1000 })
  return registered
}

const TABLE = 'Found 1 result(s) matching "q"\n\n| ID | Time | T | Title | Read |\n|----|------|---|-------|------|\n| #1 | 2:02 PM | ○ | thing | ~10 |\n'

describe('mem_search output', () => {
  it('passes the worker text through untouched', async () => {
    const tool = capture({ search: async () => ({ items: [], content: TABLE }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(value).toEqual({ content: TABLE })
    expect(tool.output.render({ query: 'q' }, value)).toEqual([{ type: 'text', text: TABLE }])
  })

  it('renders nothing when the worker sends no text, rather than inventing a message', async () => {
    const tool = capture({ search: async () => ({ items: [] }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(value).toEqual({ content: '' })
    expect(tool.output.render({ query: 'q' }, value)).toEqual([{ type: 'text', text: '' }])
  })

  it('exposes content and nothing else', async () => {
    const tool = capture({ search: async () => ({ items: [], content: TABLE }) }).mem_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(Object.keys(value)).toEqual(['content'])
  })

  it('forwards deep to the worker', async () => {
    let seen: unknown
    const tool = capture({ search: async (request: unknown) => { seen = request; return { items: [] } } }).mem_search
    await tool.execute({ query: 'q', deep: true }, {})
    expect(seen).toMatchObject({ query: 'q', deep: true })
  })
})

describe('mem_timeline output', () => {
  it('passes the worker text through untouched', async () => {
    const tool = capture({ timeline: async () => ({ items: [], content: 'timeline text' }) }).mem_timeline
    const value = await tool.execute({ anchor: 1 }, {})
    expect(value).toEqual({ content: 'timeline text' })
  })
})

describe('mem_dumb_search output', () => {
  it('keeps the worker failure tag instead of throwing', async () => {
    const tool = capture({ dumbSearch: async () => ({ content: 'raw tool search: disabled', isError: true }) }).mem_dumb_search
    const value = await tool.execute({ query: 'q' }, {})
    expect(value).toEqual({ content: 'raw tool search: disabled', isError: true })
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: 'raw tool search: disabled' }])
  })

  it('rejects out-of-range numeric parameters', async () => {
    const tool = capture({ dumbSearch: async () => ({ content: '' }) }).mem_dumb_search
    await expect(tool.execute({ query: 'q', limit: 21 }, {})).rejects.toThrow(/limit must be between 1 and 20/)
    await expect(tool.execute({ query: 'q', maxDetails: 0 }, {})).rejects.toThrow(/maxDetails must be between 1 and 5/)
    await expect(tool.execute({ query: 'q', depthAfter: 4 }, {})).rejects.toThrow(/depthAfter must be between 0 and 3/)
  })
})

describe('mem_get_tool_uses output', () => {
  it('renders the id, tool name and raw bodies', async () => {
    const tool = capture({
      toolUses: async () => [{ id: 542, toolName: 'Bash', project: '.dsh', toolInput: '{"a":1}', toolResponse: 'ok' }],
    }).mem_get_tool_uses
    const value = await tool.execute({ ids: [542] }, {})
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: '#T542 Bash (.dsh)\n  input: {"a":1}\n  response: ok' }])
  })

  it('caps the rendered text at the 32 KiB budget and appends the worker note', async () => {
    const big = 'x'.repeat(40 * 1024)
    const tool = capture({ toolUses: async () => [{ id: 1, toolName: 'Bash', toolResponse: big }] }).mem_get_tool_uses
    const rendered = tool.output.render({}, await tool.execute({ ids: [1] }, {}))[0].text
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(rendered.endsWith('[Response shortened; request fewer selected records for more detail.]')).toBe(true)
  })

  it('rejects an empty list and more than 100 ids', async () => {
    const tool = capture({ toolUses: async () => [] }).mem_get_tool_uses
    await expect(tool.execute({ ids: [] }, {})).rejects.toThrow(/at least one tool-use id/)
    await expect(tool.execute({ ids: Array.from({ length: 101 }, (_, i) => i) }, {})).rejects.toThrow(/at most 100 tool-use ids/)
  })

  it('declares every field a row can carry, so the schema never rejects real data', async () => {
    const row = {
      id: 1, toolUseId: 't', toolName: 'Bash', project: 'p', platformSource: 'claude',
      memorySessionId: 'm', contentSessionId: 'c', sessionDbId: 7, promptNumber: 3,
      createdAt: '2026-08-02T14:03:15.937Z', createdAtEpoch: 1785679395937,
      inputBytes: 1, responseBytes: 2, toolInput: '{}', toolResponse: 'ok',
    }
    const tool = capture({ toolUses: async () => [row] }).mem_get_tool_uses
    const value = await tool.execute({ ids: [1] }, {})
    const itemSchema = (tool.output.schema.properties as any)?.items?.items as { properties?: Record<string, unknown> } | undefined
    expect(Object.keys(itemSchema?.properties ?? {}).sort()).toEqual(Object.keys(value.items[0]).sort())
  })

  it('says so when no rows come back', async () => {
    const tool = capture({ toolUses: async () => [] }).mem_get_tool_uses
    const value = await tool.execute({ ids: [9] }, {})
    expect(tool.output.render({}, value)[0].text).toBe('No tool uses found for the given ids.')
  })
})
