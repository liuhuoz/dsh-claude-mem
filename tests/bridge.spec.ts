import { describe, expect, it } from 'vitest'
import { allowedProbeOrigin } from '../src/bridge.js'

/**
 * The bridge takes its target from the page, so this allowlist is the only thing
 * between the host's network position and an arbitrary request. It exists to
 * keep the probe pointing at a local worker, not to be permissive.
 */
describe('allowedProbeOrigin', () => {
  it('accepts the loopback worker addresses this plugin owns', () => {
    expect(allowedProbeOrigin('http://127.0.0.1:37777')).toBe('http://127.0.0.1:37777')
    expect(allowedProbeOrigin('http://localhost:37777')).toBe('http://localhost:37777')
    expect(allowedProbeOrigin('http://[::1]:37777')).toBe('http://[::1]:37777')
  })

  it('normalizes to the origin and tolerates surrounding space', () => {
    expect(allowedProbeOrigin('  http://127.0.0.1:37777/api/health  ')).toBe('http://127.0.0.1:37777')
    expect(allowedProbeOrigin('http://127.0.0.1:37777/')).toBe('http://127.0.0.1:37777')
  })

  it('refuses anything that is not loopback', () => {
    expect(allowedProbeOrigin('http://example.com')).toBeUndefined()
    expect(allowedProbeOrigin('http://192.168.1.5:37777')).toBeUndefined()
    expect(allowedProbeOrigin('http://10.0.0.1')).toBeUndefined()
    expect(allowedProbeOrigin('http://0.0.0.0:37777')).toBeUndefined()
  })

  it('refuses other schemes', () => {
    expect(allowedProbeOrigin('file:///etc/passwd')).toBeUndefined()
    expect(allowedProbeOrigin('ftp://127.0.0.1')).toBeUndefined()
    expect(allowedProbeOrigin('javascript:alert(1)')).toBeUndefined()
  })

  it('refuses missing or malformed input', () => {
    expect(allowedProbeOrigin(undefined)).toBeUndefined()
    expect(allowedProbeOrigin(null)).toBeUndefined()
    expect(allowedProbeOrigin('')).toBeUndefined()
    expect(allowedProbeOrigin('   ')).toBeUndefined()
    expect(allowedProbeOrigin('127.0.0.1:37777')).toBeUndefined()
    expect(allowedProbeOrigin('not a url')).toBeUndefined()
  })
})
