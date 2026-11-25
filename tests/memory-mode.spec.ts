import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { applyMemoryHooks } from '../src/hooks.ts'
import {
  OPEN_MODE, READ_ONLY_EVENT, READ_ONLY_PROJECTION, attachMemoryMode, foldReadOnly,
  ownerSessionId, parseModeArgument, readOnlyOf, type MemoryMode,
} from '../src/memory-mode.ts'
import type { LiveSettings } from '../src/settings.ts'

const settings = {
  baseUrl: 'http://127.0.0.1:1',
  project: '',
  platformSource: '',
  hookPath: '',
  ingest: true,
  summarize: true,
  autoStartWorker: false,
  workState: true,
  fileContext: false,
  fileContextGate: false,
  fileContextTools: [],
  subagents: true,
  smart: true,
  corpora: true,
  toolFilter: { names: ['read'] },
  timeoutMs: 1_000,
  dedupe: true,
  sidebarEntry: false,
} as unknown as LiveSettings

/** One genuine user prompt, the shape the pre-step handler reads. */
function prompt(text: string): unknown[] {
  return [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]
}

interface Row {
  readonly id: string
  readonly header: Record<string, unknown>
}

function agentOf(row: Row): never {
  return { session: { id: row.id, header: row.header }, inject: vi.fn() } as never
}

/** Build a host context that records the projection unit and the command. */
function fakeContext(values: Record<string, unknown> = {}) {
  const register = vi.fn((_definition: unknown) => () => {})
  const command = vi.fn((_definition: unknown) => () => {})
  const snapshot = vi.fn((_session: unknown, _keys?: readonly string[]) => ({ asOfSeq: 0, values }))
  const warn = vi.fn()
  const ctx = {
    sessionProjections: { register, snapshot },
    commands: { register: command },
    logger: { warn },
  } as unknown as Context
  return { ctx, register, command, snapshot, warn }
}

describe('foldReadOnly', () => {
  it('ignores every other event', () => {
    expect(foldReadOnly(true, { type: 'user/message', data: {} })).toBe(true)
    expect(foldReadOnly(false, { type: 'turn/end', data: {} })).toBe(false)
  })

  it('takes the whole value the event carries', () => {
    expect(foldReadOnly(false, { type: READ_ONLY_EVENT, data: { enabled: true } })).toBe(true)
    expect(foldReadOnly(true, { type: READ_ONLY_EVENT, data: { enabled: false } })).toBe(false)
  })

  it('treats a malformed payload as off', () => {
    expect(foldReadOnly(true, { type: READ_ONLY_EVENT, data: { enabled: 'yes' } })).toBe(false)
    expect(foldReadOnly(true, { type: READ_ONLY_EVENT, data: undefined })).toBe(false)
  })
})

describe('parseModeArgument', () => {
  it('flips on an empty argument', () => {
    expect(parseModeArgument('', false)).toBe(true)
    expect(parseModeArgument('   ', true)).toBe(false)
  })

  it('accepts both spellings and the short forms', () => {
    expect(parseModeArgument('read-only', false)).toBe(true)
    expect(parseModeArgument('READ-ONLY', false)).toBe(true)
    expect(parseModeArgument('on', false)).toBe(true)
    expect(parseModeArgument('read-write', true)).toBe(false)
    expect(parseModeArgument('off', true)).toBe(false)
  })

  it('rejects anything else', () => {
    expect(parseModeArgument('maybe', false)).toBeUndefined()
  })
})

describe('ownerSessionId', () => {
  it('keeps an ordinary session as its own owner', () => {
    expect(ownerSessionId({ id: 'session-1', header: { cwd: 'C:/work' } } as never)).toBe('session-1')
  })

  it('files a delegated run under its parent', () => {
    expect(ownerSessionId({ id: 'child', header: { origin: 'subagent', parentSessionId: 'parent' } } as never)).toBe('parent')
  })

  it('does not treat a fork without a parent id as delegated', () => {
    expect(ownerSessionId({ id: 'fork', header: { delegationDepth: 0 } } as never)).toBe('fork')
  })
})

describe('readOnlyOf', () => {
  it('reads the projection value for the session', () => {
    const { ctx, snapshot } = fakeContext({ [READ_ONLY_PROJECTION]: true })
    expect(readOnlyOf(ctx, { id: 'session-1' } as never)).toBe(true)
    expect(snapshot).toHaveBeenCalledWith({ id: 'session-1' }, [READ_ONLY_PROJECTION])
  })

  it('stays open when the projection cannot be read', () => {
    const { ctx, snapshot, warn } = fakeContext()
    snapshot.mockImplementation(() => { throw new Error('no projection service') })
    expect(readOnlyOf(ctx, { id: 'session-1' } as never)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('is open without a session', () => {
    const { ctx } = fakeContext()
    expect(readOnlyOf(ctx, undefined)).toBe(false)
  })
})

describe('attachMemoryMode', () => {
  it('registers the projection unit with the declared shape', () => {
    const { ctx, register } = fakeContext()
    attachMemoryMode(ctx)
    const unit = register.mock.calls[0]?.[0] as {
      key: string, stateVersion: number, init: () => boolean,
      apply: (state: boolean, event: { type: string, data?: unknown }) => boolean,
      wire: { summary: boolean, view: (state: boolean) => boolean },
    }
    expect(unit.key).toBe(READ_ONLY_PROJECTION)
    expect(unit.stateVersion).toBe(1)
    expect(unit.init()).toBe(false)
    expect(unit.apply(false, { type: READ_ONLY_EVENT, data: { enabled: true } })).toBe(true)
    expect(unit.wire.summary).toBe(false)
    expect(unit.wire.view(true)).toBe(true)
  })

  it('registers the command that appends the event', () => {
    const { ctx, command } = fakeContext()
    attachMemoryMode(ctx)
    const definition = command.mock.calls[0]?.[0] as {
      name: string
      handler: (invocation: { agent: unknown, rawInput: string }) => { kind: string, text?: string }
    }
    expect(definition.name).toBe('mem-readonly')
    const append = vi.fn()
    const agent = { session: { id: 'session-1', append } }
    const result = definition.handler({ agent, rawInput: 'read-only' })
    expect(result.kind).toBe('success')
    expect(append).toHaveBeenCalledWith(READ_ONLY_EVENT, { enabled: true })
  })

  it('refuses an argument it does not understand', () => {
    const { ctx, command } = fakeContext()
    attachMemoryMode(ctx)
    const definition = command.mock.calls[0]?.[0] as {
      handler: (invocation: { agent: unknown, rawInput: string }) => { kind: string }
    }
    const append = vi.fn()
    const result = definition.handler({ agent: { session: { id: 'session-1', append } }, rawInput: 'maybe' })
    expect(result.kind).toBe('error')
    expect(append).not.toHaveBeenCalled()
  })

  it('toggles against the value the projection reports', () => {
    const { ctx, command } = fakeContext({ [READ_ONLY_PROJECTION]: true })
    attachMemoryMode(ctx)
    const definition = command.mock.calls[0]?.[0] as {
      handler: (invocation: { agent: unknown, rawInput: string }) => { kind: string }
    }
    const append = vi.fn()
    definition.handler({ agent: { session: { id: 'session-1', append } }, rawInput: '' })
    expect(append).toHaveBeenCalledWith(READ_ONLY_EVENT, { enabled: false })
  })

  it('swallows the handle promise 0.2.2 hands back', async () => {
    const { ctx, register } = fakeContext()
    register.mockImplementation(() => Promise.reject(new Error('registration failed')))
    expect(() => attachMemoryMode(ctx)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})

/** Register the real hooks against a stand-in context so the wiring itself runs. */
function harness(mode: MemoryMode) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {}
  const ctx = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      ;(handlers[event] ??= []).push(handler)
      return () => {}
    },
    logger: { debug: () => {} },
  } as unknown as Context
  const worker = {
    sessionInit: vi.fn(async () => ({})),
    ingestObservation: vi.fn(async () => ({})),
    sessionSummarize: vi.fn(async () => ({})),
    workStateWrite: vi.fn(async () => ({})),
    context: vi.fn(async () => ''),
  }
  applyMemoryHooks(ctx, worker as never, () => settings, mode)
  const emit = async (event: string, ...args: unknown[]): Promise<void> => {
    for (const handler of handlers[event] ?? []) await handler(...args)
  }
  return { worker, emit }
}

const READ_ONLY: MemoryMode = { isReadOnly: session => session?.id === 'read-only' }
const READ_WRITE: MemoryMode = { isReadOnly: () => false }

describe('capture gates', () => {
  it('stops prompt capture for a read-only session', async () => {
    const { worker, emit } = harness(READ_ONLY)
    const agent = agentOf({ id: 'read-only', header: { cwd: 'C:/work' } })
    await emit('agent/pre-step', { agent, messages: prompt('hello') }, async () => ({ kind: 'enter', messages: [] }))
    expect(worker.sessionInit).not.toHaveBeenCalled()
  })

  it('still records a read-write session', async () => {
    const { worker, emit } = harness(READ_WRITE)
    const agent = agentOf({ id: 'session-1', header: { cwd: 'C:/work' } })
    await emit('agent/pre-step', { agent, messages: prompt('hello') }, async () => ({ kind: 'enter', messages: [] }))
    expect(worker.sessionInit).toHaveBeenCalledTimes(1)
  })

  it('drops tool observations from a read-only session', async () => {
    const { worker, emit } = harness(READ_ONLY)
    const agent = agentOf({ id: 'read-only', header: { cwd: 'C:/work' } })
    await emit('agent/created', { agent })
    const exec = { name: 'read', arguments: {}, callId: 'call-1', agent }
    const result = { content: [{ type: 'text', text: 'body' }], isError: false }
    await emit('tools/post-execute', exec, result, async () => ({ kind: 'allow' }))
    expect(worker.ingestObservation).not.toHaveBeenCalled()
  })

  it('files a delegated run under its parent mode', async () => {
    const { worker, emit } = harness(READ_ONLY)
    await emit('agent/created', { agent: agentOf({ id: 'read-only', header: { cwd: 'C:/work' } }) })
    const child = agentOf({ id: 'child-1', header: { cwd: 'C:/work', origin: 'subagent', parentSessionId: 'read-only' } })
    const exec = { name: 'read', arguments: {}, callId: 'call-2', agent: child }
    const result = { content: [{ type: 'text', text: 'body' }], isError: false }
    await emit('tools/post-execute', exec, result, async () => ({ kind: 'allow' }))
    expect(worker.ingestObservation).not.toHaveBeenCalled()
  })

  it('keeps observation capture for a read-write parent', async () => {
    const { worker, emit } = harness(READ_WRITE)
    const child = agentOf({ id: 'child-2', header: { cwd: 'C:/work', origin: 'subagent', parentSessionId: 'session-1' } })
    const exec = { name: 'read', arguments: {}, callId: 'call-3', agent: child }
    const result = { content: [{ type: 'text', text: 'body' }], isError: false }
    await emit('tools/post-execute', exec, result, async () => ({ kind: 'allow' }))
    expect(worker.ingestObservation).toHaveBeenCalledTimes(1)
  })

  it('stops summary writing for a read-only session', async () => {
    const { worker, emit } = harness(READ_ONLY)
    const agent = agentOf({ id: 'read-only', header: { cwd: 'C:/work' } })
    await emit('agent/turn-stopping', { agent })
    expect(worker.sessionSummarize).not.toHaveBeenCalled()
  })

  it('summarizes nothing for a run started from a read-only session', async () => {
    const { worker, emit } = harness(READ_ONLY)
    await emit('agent/created', { agent: agentOf({ id: 'read-only', header: { cwd: 'C:/work' } }) })
    const child = agentOf({ id: 'child-4', header: { cwd: 'C:/work', origin: 'subagent', parentSessionId: 'read-only' } })
    await emit('agent/turn-stopping', { agent: child })
    expect(worker.sessionSummarize).not.toHaveBeenCalled()
  })

  it('leaves no archive entry for a run started from a read-only session', async () => {
    const { worker, emit } = harness(READ_ONLY)
    await emit('agent/created', { agent: agentOf({ id: 'read-only', header: { cwd: 'C:/work' } }) })
    const identity = { id: 'child-3', parentSessionId: 'read-only', runId: 'run-1' }
    await emit('subagent/start', identity)
    await emit('subagent/end', { ...identity, stopReason: 'done' })
    expect(worker.workStateWrite).not.toHaveBeenCalled()
  })
})

describe('OPEN_MODE', () => {
  it('never reports read-only', () => {
    expect(OPEN_MODE.isReadOnly(undefined)).toBe(false)
    expect(OPEN_MODE.isReadOnly({ id: 'session-1' } as never)).toBe(false)
  })
})
