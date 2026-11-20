import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkerClient } from '../src/worker.ts'
import type { LiveSettings } from '../src/settings.ts'
import {
  injectSessionContext,
  injectionPending,
  PENDING_INJECTION_LEAK_MS,
  rememberInjection,
  settleInjection,
  type PendingInjection,
} from '../src/hooks.ts'

function settings(overrides: Partial<LiveSettings> = {}): LiveSettings {
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
    ...overrides,
  }
}

function fakeAgent(id = 'session-1', cwd = 'C:/work'): { agent: Agent; inject: ReturnType<typeof vi.fn> } {
  const inject = vi.fn()
  const agent = { session: { id, header: { cwd } }, inject } as unknown as Agent
  return { agent, inject }
}

function fakeWorker(context: string | (() => Promise<string>)): WorkerClient {
  const workState = vi.fn(async () => '- release\n  - [doing] ship')
  return {
    context: vi.fn(typeof context === 'string' ? async () => context : context),
    workState,
  } as unknown as WorkerClient
}

function injectedText(inject: ReturnType<typeof vi.fn>, call = 0): string {
  const message = inject.mock.calls[call]?.[0] as UserMessage
  const block = message.content[0]
  expect(block.type).toBe('text')
  return block.type === 'text' ? block.text : ''
}

const BLOCK = 'Access Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\n\n### Nov 20, 2026\n1 9:00p ○ one'

describe('injectSessionContext', () => {
  it('injects the block the worker renders, unchanged and once', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(BLOCK)

    await injectSessionContext(worker, agent, settings(), new Map())

    expect(inject).toHaveBeenCalledTimes(1)
    expect(injectedText(inject)).toBe(BLOCK)
    expect(worker.context).toHaveBeenCalledTimes(1)
    expect(worker.context).toHaveBeenCalledWith({ projects: 'work' })
  })

  it('never fetches the work state separately: the block already carries it', async () => {
    const { agent } = fakeAgent()
    const worker = fakeWorker(BLOCK)

    await injectSessionContext(worker, agent, settings(), new Map())

    expect(worker.workState).not.toHaveBeenCalled()
  })

  it('stays silent when the worker has no context', async () => {
    const { agent, inject } = fakeAgent()

    await injectSessionContext(fakeWorker(''), agent, settings(), new Map())

    expect(inject).not.toHaveBeenCalled()
  })

  it('injects the same block whatever the work-state switch says', async () => {
    const enabled = fakeAgent()
    await injectSessionContext(fakeWorker(BLOCK), enabled.agent, settings({ workState: true }), new Map())

    const disabled = fakeAgent()
    await injectSessionContext(fakeWorker(BLOCK), disabled.agent, settings({ workState: false }), new Map())

    expect(injectedText(disabled.inject)).toBe(injectedText(enabled.inject))
  })

  it('never throws when the worker is unavailable', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(async () => {
      throw new Error('ECONNREFUSED')
    })

    await expect(injectSessionContext(worker, agent, settings(), new Map())).resolves.toBeUndefined()
    expect(inject).not.toHaveBeenCalled()
  })
})

describe('in-flight injections', () => {
  it('lets the first trigger win and makes the second step aside', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(BLOCK)
    const pending = new Map<string, PendingInjection>()
    const debug = vi.fn()

    await injectSessionContext(worker, agent, settings(), pending, debug)
    await injectSessionContext(worker, agent, settings(), pending, debug)

    expect(inject).toHaveBeenCalledTimes(1)
    expect(worker.context).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]?.[0])).toContain('still in flight')
  })

  it('injects again once the delivery event carries the same id', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(BLOCK)
    const pending = new Map<string, PendingInjection>()

    await injectSessionContext(worker, agent, settings(), pending)
    const id = (inject.mock.calls[0]?.[0] as UserMessage).id

    expect(settleInjection(pending, 'session-1', { type: 'user/message', data: { id } })).toBe(true)
    await injectSessionContext(worker, agent, settings(), pending)

    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('ignores deliveries for another id or another event type', () => {
    const pending = new Map<string, PendingInjection>()
    rememberInjection(pending, 'session-1', 'message-1')

    expect(settleInjection(pending, 'session-1', { type: 'user/message', data: { id: 'other' } })).toBe(false)
    expect(settleInjection(pending, 'session-1', { type: 'step/start', data: {} })).toBe(false)
    expect(injectionPending(pending, 'session-1')).toBe(true)
  })

  it('keeps sessions apart', async () => {
    const first = fakeAgent('session-1')
    const second = fakeAgent('session-2')
    const worker = fakeWorker(BLOCK)
    const pending = new Map<string, PendingInjection>()

    await injectSessionContext(worker, first.agent, settings(), pending)
    await injectSessionContext(worker, second.agent, settings(), pending)

    expect(first.inject).toHaveBeenCalledTimes(1)
    expect(second.inject).toHaveBeenCalledTimes(1)
  })

  it('drops a pending entry once the leak bound passes', () => {
    const pending = new Map<string, PendingInjection>()
    rememberInjection(pending, 'session-1', 'message-1', 1_000)

    expect(injectionPending(pending, 'session-1', 1_000 + PENDING_INJECTION_LEAK_MS - 1)).toBe(true)
    expect(injectionPending(pending, 'session-1', 1_000 + PENDING_INJECTION_LEAK_MS)).toBe(false)
    expect(pending.size).toBe(0)
  })
})
