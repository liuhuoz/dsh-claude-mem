import { describe, expect, it } from 'vitest'
import { observationPayload } from '../src/hooks.js'

const SUCCESS = {
  cwd: 'C:/work',
  toolName: 'read',
  toolInput: { file_path: 'a.ts' },
  text: 'file body',
  failed: false,
} as const

const FAILURE = {
  cwd: 'C:/work',
  toolName: 'ops_bash',
  toolInput: { command: 'false' },
  text: 'exit code 1',
  failed: true,
} as const

describe('observationPayload', () => {
  it('reports a successful call through tool_response under PostToolUse', () => {
    expect(observationPayload(SUCCESS, { sessionId: 'session-1' })).toEqual({
      session_id: 'session-1',
      transcript_path: '',
      cwd: 'C:/work',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'a.ts' },
      tool_response: { content: [{ type: 'text', text: 'file body' }], is_error: false },
    })
  })

  it('reports a failed call with the merged is_error marker, not a second event', () => {
    expect(observationPayload(FAILURE, { sessionId: 'session-1' })).toEqual({
      session_id: 'session-1',
      transcript_path: '',
      cwd: 'C:/work',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { is_error: true, error: 'exit code 1' },
    })
  })

  it('keeps the subagent labels on both branches', () => {
    const attribution = { sessionId: 'parent-1', agentId: 'child-1', agentType: 'explore' }
    expect(observationPayload(FAILURE, attribution)).toMatchObject({ agent_id: 'child-1', agent_type: 'explore' })
    expect(observationPayload(SUCCESS, attribution)).toMatchObject({ agent_id: 'child-1', agent_type: 'explore' })
  })

  it('defaults a missing tool_input to an empty object', () => {
    expect(observationPayload({ ...SUCCESS, toolInput: undefined }, { sessionId: 's' })).toMatchObject({ tool_input: {} })
  })
})
