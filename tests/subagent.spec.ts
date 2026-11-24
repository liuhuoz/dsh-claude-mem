import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { archiveSubagentStop, attributionOf, hookToolName, rememberSubagent, subagentStopFields, type SubagentIdentity } from '../src/hooks.js'

/** The pieces of Agent this module reads: a session id plus its header. */
function fakeAgent(id: string, header: Record<string, unknown>): Agent {
  return { session: { id, header } } as unknown as Agent
}

describe('hookToolName', () => {
  it('renders a delegated run as the Task tool', () => {
    expect(hookToolName('subagent')).toBe('Task')
    expect(hookToolName('subagent_fork')).toBe('Task')
  })

  it('keeps the existing mappings', () => {
    expect(hookToolName('read')).toBe('Read')
    expect(hookToolName('ops_bash')).toBe('Bash')
    expect(hookToolName('grep')).toBe('grep')
  })
})

describe('attributionOf', () => {
  it('files a parent session under itself', () => {
    const agent = fakeAgent('parent-1', { origin: 'main', cwd: 'C:/work' })
    expect(attributionOf(agent, new Map())).toEqual({ sessionId: 'parent-1' })
  })

  it('files a delegated run against the parent it was started from', () => {
    const agent = fakeAgent('child-1', { origin: 'subagent', parentSessionId: 'parent-1', agentPreset: 'explore' })
    const known = new Map<string, SubagentIdentity>([
      ['child-1', { parentSessionId: 'parent-1', agentType: 'explore', runId: 'run-1' }],
    ])
    expect(attributionOf(agent, known)).toEqual({ sessionId: 'parent-1', agentId: 'child-1', agentType: 'explore' })
  })

  it('falls back to the session header when subagent/start never arrived', () => {
    const agent = fakeAgent('child-2', { delegationDepth: 1, parentSessionId: 'parent-2', agentPreset: 'review' })
    expect(attributionOf(agent, new Map())).toEqual({ sessionId: 'parent-2', agentId: 'child-2', agentType: 'review' })
  })

  it('prefers the tracked agent type over the header', () => {
    const agent = fakeAgent('child-3', { origin: 'subagent', parentSessionId: 'parent-3', agentPreset: 'header-type' })
    const known = new Map<string, SubagentIdentity>([['child-3', { parentSessionId: 'parent-3', agentType: 'tracked' }]])
    expect(attributionOf(agent, known).agentType).toBe('tracked')
  })

  it('omits the type when neither source has one', () => {
    const agent = fakeAgent('child-4', { origin: 'subagent', parentSessionId: 'parent-4' })
    expect(attributionOf(agent, new Map())).toEqual({ sessionId: 'parent-4', agentId: 'child-4' })
  })
})

describe('rememberSubagent', () => {
  it('registers a child from its header when start never arrived', () => {
    const subagents = new Map<string, SubagentIdentity>()
    rememberSubagent(fakeAgent('child-1', { origin: 'subagent', parentSessionId: 'parent-1', agentPreset: 'explore' }), subagents)
    expect(subagents.get('child-1')).toEqual({ parentSessionId: 'parent-1', agentType: 'explore' })
  })

  it('completes an entry that subagent/start created without a type', () => {
    const subagents = new Map<string, SubagentIdentity>([['child-2', { parentSessionId: 'parent-2', runId: 'run-2' }]])
    rememberSubagent(fakeAgent('child-2', { origin: 'subagent', parentSessionId: 'parent-2', agentPreset: 'review' }), subagents)
    expect(subagents.get('child-2')).toEqual({ parentSessionId: 'parent-2', runId: 'run-2', agentType: 'review' })
  })

  it('never replaces a known type', () => {
    const subagents = new Map<string, SubagentIdentity>([['child-3', { parentSessionId: 'parent-3', agentType: 'tracked' }]])
    rememberSubagent(fakeAgent('child-3', { origin: 'subagent', parentSessionId: 'parent-3', agentPreset: 'header' }), subagents)
    expect(subagents.get('child-3')?.agentType).toBe('tracked')
  })
})

describe('subagentStopFields', () => {
  it('mirrors the upstream agent-lifecycle entry, with the dsh platform', () => {
    const now = 1_795_400_000_000
    expect(subagentStopFields('child-1', { parentSessionId: 'parent-1', agentType: 'explore' }, now)).toEqual({
      task: 'Agent child-1 in dsh session parent-1',
      status: 'done',
      platform_source: 'dsh',
      content_session_id: 'parent-1',
      agent_id: 'child-1',
      agent_type: 'explore',
      stopped_at: new Date(now).toISOString(),
      stopped_at_epoch: now,
      stop_source: 'subagent-stop-hook',
    })
  })

  it('keeps a null agent type rather than dropping the key', () => {
    const fields = subagentStopFields('child-2', { parentSessionId: 'parent-2' }, 1)
    expect(fields.agent_type).toBeNull()
    expect(fields.platform_source).toBe('dsh')
  })
})

describe('archiveSubagentStop', () => {
  const fields = { task: 't' }
  const noSleep = () => Promise.resolve()

  it('writes once when the worker answers', async () => {
    const write = vi.fn(async () => 'saved')
    await expect(archiveSubagentStop(write, 'C:/work', fields, { delays: [0, 0], sleep: noSleep })).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('C:/work', fields)
  })

  it('retries with the given delays and gives up after the last one', async () => {
    const write = vi.fn(async () => { throw new Error('down') })
    const onRetry = vi.fn()
    const sleeps: number[] = []
    const result = await archiveSubagentStop(write, 'C:/work', fields, {
      delays: [1, 2, 3],
      onRetry,
      sleep: async ms => { sleeps.push(ms) },
    })
    expect(result).toBe(false)
    expect(write).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([1, 2, 3])
    expect(onRetry).toHaveBeenCalledTimes(3)
  })

  it('stops retrying as soon as a write lands', async () => {
    let calls = 0
    const write = vi.fn(async () => {
      calls += 1
      if (calls < 2) throw new Error('down')
      return 'ok'
    })
    await expect(archiveSubagentStop(write, 'C:/work', fields, { delays: [0, 0, 0], sleep: noSleep })).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
