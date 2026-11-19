import { describe, expect, it } from 'vitest'
import { healthUrl, parseHealth, readHealth } from '../src/probe.js'

/** The body claude-mem 15.17.0 actually returned from `GET /api/health`. */
const LIVE_HEALTH = {
  status: 'ok',
  version: '15.17.0',
  workerPath: 'C:\\Users\\liuhuoz\\.claude\\plugins\\cache\\thedotmack\\claude-mem\\15.17.0\\scripts\\worker-service.cjs',
  uptime: 37905,
  managed: false,
  hasIpc: false,
  platform: 'win32',
  pid: 36480,
  initialized: true,
  mcpReady: true,
  ai: { provider: 'claude', authMethod: 'Gateway auth token (from ~/.claude-mem/.env)' },
}

describe('healthUrl', () => {
  it('appends the health path and tolerates trailing slashes', () => {
    expect(healthUrl('http://127.0.0.1:37777')).toBe('http://127.0.0.1:37777/api/health')
    expect(healthUrl('http://127.0.0.1:37777/')).toBe('http://127.0.0.1:37777/api/health')
  })
})

describe('parseHealth', () => {
  it('keeps the reported fields and drops the rest', () => {
    const health = parseHealth(LIVE_HEALTH)
    // workerPath is the installation the MCP server ships in, so it is kept.
    expect(health).toStrictEqual({
      status: 'ok',
      version: '15.17.0',
      pid: 36480,
      initialized: true,
      mcpReady: true,
      provider: 'claude',
      workerPath: LIVE_HEALTH.workerPath,
    })
  })

  it('rejects a body that is not a health payload', () => {
    expect(parseHealth(undefined)).toBeUndefined()
    expect(parseHealth(null)).toBeUndefined()
    expect(parseHealth('<html>404</html>')).toBeUndefined()
    expect(parseHealth({ ready: true })).toBeUndefined()
    expect(parseHealth({ status: '' })).toBeUndefined()
  })

  it('tolerates a minimal body', () => {
    expect(parseHealth({ status: 'ok' })).toStrictEqual({ status: 'ok' })
  })
})

describe('readHealth', () => {
  it('grades a ready worker as done', () => {
    const reading = readHealth(parseHealth(LIVE_HEALTH)!)
    expect(reading.state).toBe('done')
    expect(reading.key).toBe('connected')
    expect(reading.health.version).toBe('15.17.0')
  })

  it('grades a reachable but uninitialized worker as a warning', () => {
    expect(readHealth({ status: 'ok', initialized: false }).key).toBe('notInitialized')
    expect(readHealth({ status: 'ok', initialized: false }).state).toBe('warning')
  })

  it('grades a reachable worker without MCP as a warning', () => {
    expect(readHealth({ status: 'ok', mcpReady: false }).key).toBe('mcpUnavailable')
  })

  it('does not call a non-ok status connected', () => {
    const reading = readHealth({ status: 'degraded' })
    expect(reading.state).toBe('warning')
    expect(reading.key).toBe('unhealthy')
  })
})
