import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyMemoryHooks } from '../src/hooks.ts'
import type { LiveSettings } from '../src/settings.ts'

const BLOCK = 'Access Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\n\n### Nov 21, 2026\n1 12:20a ○ probe'

function settings(): LiveSettings {
  return {
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
    toolFilter: { names: [] },
    timeoutMs: 1_000,
    dedupe: true,
  }
}

/** Flush the microtasks an async hook handler leaves behind. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Harness {
  readonly inject: ReturnType<typeof vi.fn>
  readonly context: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
  readonly emit: (event: string, ...args: unknown[]) => void
}

/** Register the real hooks against a stand-in context, so the wiring is what runs. */
function harness(): Harness {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {}
  const debug = vi.fn()
  const ctx = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      ;(handlers[event] ??= []).push(handler)
      return () => {}
    },
    logger: { debug },
  } as unknown as Parameters<typeof applyMemoryHooks>[0]
  const context = vi.fn(async () => BLOCK)
  const worker = { context } as unknown as Parameters<typeof applyMemoryHooks>[1]
  applyMemoryHooks(ctx, worker, settings)
  return {
    inject: vi.fn(),
    context,
    debug,
    emit: (event, ...args) => {
      for (const handler of handlers[event] ?? []) handler(...args)
    },
  }
}

function fakeAgent(inject: ReturnType<typeof vi.fn>, id = 'session-1'): Agent {
  return { session: { id, header: { cwd: 'C:/work' } }, inject } as unknown as Agent
}

describe('injection wiring', () => {
  it('suppresses a compaction while the session-start block is still in flight', async () => {
    const { inject, context, debug, emit } = harness()
    const agent = fakeAgent(inject)

    emit('agent/created', { agent })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)

    emit('session/event', { id: 'session-1' }, { type: 'compaction/end', data: {} })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(context).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]?.[0])).toContain('still in flight')
  })

  it('injects again once the queued message reaches the transcript', async () => {
    const { inject, emit } = harness()
    const agent = fakeAgent(inject)

    emit('agent/created', { agent })
    await tick()
    const id = (inject.mock.calls[0]?.[0] as { id?: string }).id

    emit('session/event', { id: 'session-1' }, { type: 'user/message', data: { id } })
    emit('session/event', { id: 'session-1' }, { type: 'compaction/end', data: {} })
    await tick()

    expect(inject).toHaveBeenCalledTimes(2)
  })
})
