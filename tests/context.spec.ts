import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkerClient } from '../src/worker.ts'
import type { LiveSettings } from '../src/settings.ts'
import { injectSessionContext } from '../src/hooks.ts'

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

function fakeAgent(cwd = 'C:/work'): { agent: Agent; inject: ReturnType<typeof vi.fn> } {
  const inject = vi.fn()
  const agent = { session: { id: 'session-1', header: { cwd } }, inject } as unknown as Agent
  return { agent, inject }
}

function fakeWorker(context: string | (() => Promise<string>)): WorkerClient {
  const workState = vi.fn(async () => '- release\n  - [doing] ship')
  return {
    context: vi.fn(typeof context === 'string' ? async () => context : context),
    workState,
  } as unknown as WorkerClient
}

function injectedText(inject: ReturnType<typeof vi.fn>): string {
  expect(inject).toHaveBeenCalledTimes(1)
  const message = inject.mock.calls[0]?.[0] as UserMessage
  const block = message.content[0]
  expect(block.type).toBe('text')
  return block.type === 'text' ? block.text : ''
}

describe('injectSessionContext', () => {
  it('injects the block the worker renders, unchanged and once', async () => {
    const { agent, inject } = fakeAgent()
    const block = 'Access Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\n\nWork state, still open:\n- release\n  - [doing] ship'
    const worker = fakeWorker(block)

    await injectSessionContext(worker, agent, settings())

    expect(injectedText(inject)).toBe(block)
    expect(worker.context).toHaveBeenCalledTimes(1)
    expect(worker.context).toHaveBeenCalledWith({ projects: 'work' })
  })

  it('never fetches the work state separately: the block already carries it', async () => {
    const { agent } = fakeAgent()
    const worker = fakeWorker('block')

    await injectSessionContext(worker, agent, settings())

    expect(worker.workState).not.toHaveBeenCalled()
  })

  it('stays silent when the worker has no context', async () => {
    const { agent, inject } = fakeAgent()

    await injectSessionContext(fakeWorker(''), agent, settings())

    expect(inject).not.toHaveBeenCalled()
  })

  it('injects the same block whatever the work-state switch says', async () => {
    const enabled = fakeAgent()
    await injectSessionContext(fakeWorker('block'), enabled.agent, settings({ workState: true }))

    const disabled = fakeAgent()
    await injectSessionContext(fakeWorker('block'), disabled.agent, settings({ workState: false }))

    expect(injectedText(disabled.inject)).toBe(injectedText(enabled.inject))
  })

  it('never throws when the worker is unavailable', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(async () => { throw new Error('ECONNREFUSED') })

    await expect(injectSessionContext(worker, agent, settings())).resolves.toBeUndefined()
    expect(inject).not.toHaveBeenCalled()
  })
})
