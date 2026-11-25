import { describe, expect, it, vi } from 'vitest'

// The page renders through the host's primitives, which only exist in the
// browser bundle; this spec covers the pure draft/operations helpers, so every
// primitive is stubbed and the module stays importable in node.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Input: () => null,
  StateDot: () => null,
  Switch: () => null,
}))

import { DEFAULT_FILE_CONTEXT_TOOLS, DEFAULT_TOOL_NAMES } from '../src/settings.js'
import { effectiveNames, toDraft, toOperations } from '../src/client/page.js'

/** Every field the page can write; a path outside this set is a typo. */
const PAGE_FIELDS = new Set([
  'baseUrl',
  'hookPath',
  'ingest',
  'summarize',
  'workState',
  'autoStartWorker',
  'toolFilter',
  'fileContext',
  'fileContextGate',
  'subagents',
  'smart',
  'corpora',
  'fileContextTools',
  'sidebarEntry',
  'sessionSeat',
  'seatHero',
])

const defaults = () => toDraft(undefined)

describe('toDraft', () => {
  it('falls back to the page defaults when no value is stored', () => {
    const draft = defaults()
    expect(draft.baseUrl).toBe('')
    expect(draft.hookPath).toBe('')
    // Capture stages are off until the host hands over a stored value; the rest
    // of the features default on, matching the schema.
    expect(draft.ingest).toBe(false)
    expect(draft.summarize).toBe(false)
    expect(draft.workState).toBe(true)
    expect(draft.autoStartWorker).toBe(true)
    expect(draft.subagents).toBe(true)
    expect(draft.smart).toBe(true)
    expect(draft.corpora).toBe(true)
    expect(draft.fileContext).toBe(false)
    expect(draft.fileContextGate).toBe(false)
    expect(draft.sidebarEntry).toBe(false)
    expect(draft.sessionSeat).toBe('composer')
    expect(draft.seatHero).toBe(true)
    expect(draft.toolNames).toBe('')
    expect(draft.fileContextTools).toBe('')
  })

  it('joins the stored tool lists for one comma-separated field', () => {
    const draft = toDraft({
      toolFilter: { names: ['read', 'write'] },
      fileContextTools: ['read'],
      baseUrl: 'http://127.0.0.1:37777',
      ingest: true,
      sidebarEntry: true,
    })
    expect(draft.toolNames).toBe('read, write')
    expect(draft.fileContextTools).toBe('read')
    expect(draft.baseUrl).toBe('http://127.0.0.1:37777')
    expect(draft.ingest).toBe(true)
    expect(draft.sidebarEntry).toBe(true)
  })

  it('survives a malformed stored value', () => {
    const draft = toDraft({ toolFilter: { names: 'read' }, fileContextTools: 'nope', ingest: 'yes' })
    expect(draft.toolNames).toBe('')
    expect(draft.fileContextTools).toBe('')
    expect(draft.ingest).toBe(false)
  })
})

describe('toOperations', () => {
  it('writes one operation per page field', () => {
    const ops = toOperations(defaults())
    expect(ops).toHaveLength(PAGE_FIELDS.size)
    for (const op of ops) {
      expect(PAGE_FIELDS.has(op.path[0] as string), `unexpected path ${String(op.path[0])}`).toBe(true)
    }
  })

  it('clears an empty text field instead of writing an empty string', () => {
    const ops = toOperations(defaults())
    expect(ops.find((op) => op.path[0] === 'baseUrl')).toEqual({ op: 'unset', path: ['baseUrl'] })
    expect(ops.find((op) => op.path[0] === 'hookPath')).toEqual({ op: 'unset', path: ['hookPath'] })
  })

  it('trims a typed address before it is stored', () => {
    const ops = toOperations({ ...defaults(), baseUrl: '  http://127.0.0.1:37777  ' })
    expect(ops.find((op) => op.path[0] === 'baseUrl')).toEqual({
      op: 'set',
      path: ['baseUrl'],
      value: 'http://127.0.0.1:37777',
    })
  })

  it('splits the tool lists on commas and whitespace', () => {
    const ops = toOperations({ ...defaults(), toolNames: ' read, write  edit ', fileContextTools: 'read' })
    expect(ops.find((op) => op.path[0] === 'toolFilter')).toEqual({
      op: 'set',
      path: ['toolFilter', 'names'],
      value: ['read', 'write', 'edit'],
    })
    expect(ops.find((op) => op.path[0] === 'fileContextTools')).toEqual({
      op: 'set',
      path: ['fileContextTools'],
      value: ['read'],
    })
  })

  it('clears a list field when it holds no name', () => {
    const ops = toOperations({ ...defaults(), toolNames: '   ', fileContextTools: '' })
    expect(ops.find((op) => op.path[0] === 'toolFilter')).toEqual({ op: 'unset', path: ['toolFilter'] })
    expect(ops.find((op) => op.path[0] === 'fileContextTools')).toEqual({ op: 'unset', path: ['fileContextTools'] })
  })

  it('carries the seat choice and the New Session switch', () => {
    const ops = toOperations({ ...defaults(), sessionSeat: 'dock', seatHero: false })
    expect(ops.find(op => op.path[0] === 'sessionSeat')).toEqual({ op: 'set', path: ['sessionSeat'], value: 'dock' })
    expect(ops.find(op => op.path[0] === 'seatHero')).toEqual({ op: 'set', path: ['seatHero'], value: false })
  })

  it('carries every switch across, including the sidebar entry', () => {
    const ops = toOperations({
      ...defaults(),
      ingest: true,
      summarize: true,
      workState: false,
      autoStartWorker: false,
      fileContext: true,
      fileContextGate: true,
      subagents: false,
      smart: false,
      corpora: false,
      sidebarEntry: true,
    })
    const value = (field: string) => ops.find((op) => op.path[0] === field) as { value?: unknown }
    expect(value('ingest').value).toBe(true)
    expect(value('summarize').value).toBe(true)
    expect(value('workState').value).toBe(false)
    expect(value('autoStartWorker').value).toBe(false)
    expect(value('fileContext').value).toBe(true)
    expect(value('fileContextGate').value).toBe(true)
    expect(value('subagents').value).toBe(false)
    expect(value('smart').value).toBe(false)
    expect(value('corpora').value).toBe(false)
    expect(value('sidebarEntry').value).toBe(true)
  })
})

describe('effectiveNames', () => {
  it('shows the built-in list when the field is empty', () => {
    expect(effectiveNames('', DEFAULT_TOOL_NAMES)).toBe(DEFAULT_TOOL_NAMES.join(', '))
    expect(effectiveNames('  ', DEFAULT_FILE_CONTEXT_TOOLS)).toBe(DEFAULT_FILE_CONTEXT_TOOLS.join(', '))
  })

  it('normalizes a typed list to one comma-separated line', () => {
    expect(effectiveNames(' read ,  write ', DEFAULT_TOOL_NAMES)).toBe('read, write')
  })
})
