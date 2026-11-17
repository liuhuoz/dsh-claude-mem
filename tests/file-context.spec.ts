import { describe, expect, it } from 'vitest'
import { capContext, claudeToolName, msysToWin, parseHookOutput, preToolPayload } from '../src/file-context.js'

const call = (name: string, args: unknown) => ({ sessionId: 'session-1', cwd: 'D:/repo', name, arguments: args })

describe('claudeToolName', () => {
  it('maps the DSH tools claude-mem parses', () => {
    expect(claudeToolName('read')).toBe('Read')
    expect(claudeToolName('ops_bash')).toBe('Bash')
    expect(claudeToolName('pwsh')).toBe('Bash')
    expect(claudeToolName('grep')).toBe('Grep')
    expect(claudeToolName('glob')).toBe('Glob')
  })

  it('leaves other tools alone', () => {
    expect(claudeToolName('todo_write')).toBe('todo_write')
  })
})

describe('msysToWin', () => {
  it('rewrites drive tokens at a boundary', () => {
    expect(msysToWin('cat /d/repo/a.ts')).toBe('cat D:/repo/a.ts')
    expect(msysToWin('"/c/Users/x/y"')).toBe('"C:/Users/x/y"')
  })

  it('leaves ordinary text and urls alone', () => {
    expect(msysToWin('npm run build')).toBe('npm run build')
    expect(msysToWin('https://example.com/d/x')).toBe('https://example.com/d/x')
    expect(msysToWin('/usr/local/bin')).toBe('/usr/local/bin')
  })
})

describe('preToolPayload', () => {
  it('translates a read call', () => {
    const payload = preToolPayload(call('read', { file_path: 'D:/repo/src/a.ts', limit: 20 }))
    expect(payload).toEqual({
      session_id: 'session-1',
      cwd: 'D:/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'D:/repo/src/a.ts' },
    })
  })

  it('normalises a bash command and adopts its workdir', () => {
    const payload = preToolPayload(call('ops_bash', { command: 'cat /d/repo/a.ts', workdir: 'D:/other' }))
    expect(payload?.tool_name).toBe('Bash')
    expect(payload?.cwd).toBe('D:/other')
    expect(payload?.tool_input).toEqual({ command: 'cat D:/repo/a.ts' })
  })

  it('keeps the pattern and path of grep and glob', () => {
    expect(preToolPayload(call('grep', { pattern: 'foo', path: 'src' }))?.tool_input).toEqual({ pattern: 'foo', path: 'src' })
    expect(preToolPayload(call('glob', { pattern: '**/*.ts' }))?.tool_input).toEqual({ pattern: '**/*.ts' })
  })

  it('answers null when the call carries nothing usable', () => {
    expect(preToolPayload(call('read', {}))).toBeNull()
    expect(preToolPayload(call('write', { file_path: 'D:/repo/a.ts' }))).toBeNull()
    expect(preToolPayload(call('ops_bash', { command: '' }))).toBeNull()
  })
})

describe('parseHookOutput', () => {
  it('reads additionalContext', () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'line one' } })
    expect(parseHookOutput(stdout)).toBe('line one')
  })

  it('answers null for every silent shape', () => {
    expect(parseHookOutput('')).toBeNull()
    expect(parseHookOutput('{}')).toBeNull()
    expect(parseHookOutput('not json')).toBeNull()
    expect(parseHookOutput(JSON.stringify({ hookSpecificOutput: { additionalContext: '   ' } }))).toBeNull()
    expect(parseHookOutput(JSON.stringify({ continue: true, suppressOutput: true }))).toBeNull()
  })
})

describe('capContext', () => {
  it('keeps short text and trims long text', () => {
    expect(capContext('  short  ')).toBe('short')
    const long = 'x'.repeat(50)
    const capped = capContext(long, 10)
    expect(capped.startsWith('x'.repeat(10))).toBe(true)
    expect(capped).toContain('truncated')
  })
})
