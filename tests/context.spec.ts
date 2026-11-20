import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkerClient } from '../src/worker.ts'
import type { LiveSettings } from '../src/settings.ts'
import { rehydrateContext, WORK_STATE_MARKER } from '../src/hooks.ts'

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

function fakeWorker(context: string | (() => Promise<string>), state: string | (() => Promise<string>)): WorkerClient {
  const call = (value: string | (() => Promise<string>)) =>
    vi.fn(typeof value === 'string' ? async () => value : value)
  return { context: call(context), workState: call(state) } as unknown as WorkerClient
}

function injectedText(inject: ReturnType<typeof vi.fn>): string {
  expect(inject).toHaveBeenCalledTimes(1)
  const message = inject.mock.calls[0]?.[0] as UserMessage
  const block = message.content[0]
  expect(block.type).toBe('text')
  return block.type === 'text' ? block.text : ''
}

describe('rehydrateContext', () => {
  it('re-injects the session block and the open work state in one message', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker('session context', '- release\n  - [doing] ship')

    await rehydrateContext(worker, agent, settings())

    expect(injectedText(inject)).toBe(`session context\n\n${WORK_STATE_MARKER}\n- release\n  - [doing] ship`)
    expect(worker.context).toHaveBeenCalledTimes(1)
    expect(worker.context).toHaveBeenCalledWith({ projects: 'work' })
    expect(worker.workState).toHaveBeenCalledTimes(1)
    expect(worker.workState).toHaveBeenCalledWith({ cwd: 'C:/work' })
  })

  it('injects the block alone when nothing is open', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker('session context', 'Nothing open for work.')

    await rehydrateContext(worker, agent, settings())

    expect(injectedText(inject)).toBe('session context')
  })

  it('still injects the work state when the block is empty', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker('', '- release\n  - [doing] ship')

    await rehydrateContext(worker, agent, settings())

    expect(injectedText(inject)).toBe(`${WORK_STATE_MARKER}\n- release\n  - [doing] ship`)
  })

  it('stays silent when the worker has neither', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker('', 'Nothing recorded in "release" for work.')

    await rehydrateContext(worker, agent, settings())

    expect(inject).not.toHaveBeenCalled()
  })

  it('never throws when the worker is unavailable', async () => {
    const { agent, inject } = fakeAgent()
    const worker = fakeWorker(
      async () => { throw new Error('ECONNREFUSED') },
      async () => { throw new Error('ECONNREFUSED') },
    )

    await expect(rehydrateContext(worker, agent, settings())).resolves.toBeUndefined()
    expect(inject).not.toHaveBeenCalled()
  })
})
