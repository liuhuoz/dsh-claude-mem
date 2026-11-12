import { describe, expect, it } from 'vitest'
import { CLAUDE_MEM_DEFAULT_PORT, parseWorkerPid, resolveBaseUrl } from '../src/endpoint.js'

describe('parseWorkerPid', () => {
  it('reads the port claude-mem publishes', () => {
    const raw = '{\n  "pid": 36480,\n  "port": 37777,\n  "startedAt": "2026-11-12T03:59:59.808Z"\n}'
    expect(parseWorkerPid(raw)).toBe(37777)
  })

  it('ignores content that is not the pid file shape', () => {
    expect(parseWorkerPid(undefined)).toBeUndefined()
    expect(parseWorkerPid('')).toBeUndefined()
    expect(parseWorkerPid('not json')).toBeUndefined()
    expect(parseWorkerPid('[]')).toBeUndefined()
    expect(parseWorkerPid('{"pid":1}')).toBeUndefined()
  })

  it('rejects ports outside the usable range or not integers', () => {
    expect(parseWorkerPid('{"port":"37777"}')).toBeUndefined()
    expect(parseWorkerPid('{"port":0}')).toBeUndefined()
    expect(parseWorkerPid('{"port":65536}')).toBeUndefined()
    expect(parseWorkerPid('{"port":37777.5}')).toBeUndefined()
  })
})

describe('resolveBaseUrl', () => {
  it('prefers explicit configuration over everything else', () => {
    expect(resolveBaseUrl('http://127.0.0.1:40000', 'http://env:1', 37777)).toBe('http://127.0.0.1:40000')
  })

  it('falls back to the environment before the published port', () => {
    expect(resolveBaseUrl('', 'http://env:1', 37777)).toBe('http://env:1')
    expect(resolveBaseUrl('   ', '  http://env:2  ', 37777)).toBe('http://env:2')
  })

  it('uses the port the worker published', () => {
    expect(resolveBaseUrl('', undefined, 41000)).toBe('http://127.0.0.1:41000')
    expect(resolveBaseUrl('', '   ', 41000)).toBe('http://127.0.0.1:41000')
  })

  it('falls back to the claude-mem default port', () => {
    expect(resolveBaseUrl('', undefined, undefined)).toBe(`http://127.0.0.1:${CLAUDE_MEM_DEFAULT_PORT}`)
    expect(CLAUDE_MEM_DEFAULT_PORT).toBe(37777)
  })

  it('strips trailing slashes so callers can append a path', () => {
    expect(resolveBaseUrl('http://127.0.0.1:37777///', undefined, undefined)).toBe('http://127.0.0.1:37777')
    expect(resolveBaseUrl('', 'http://env:1/', undefined)).toBe('http://env:1')
  })
})
