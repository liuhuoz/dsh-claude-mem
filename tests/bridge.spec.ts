import { describe, expect, it } from 'vitest'
import { admissionRejection, allowedProbeOrigin } from '../src/bridge.js'

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

/**
 * The host connection service owns admission for every same-origin request the
 * app makes; the bridge asks it the way the sibling host-route plugins do, so the
 * panel cannot become the one route that skips the app's own login.
 */
describe('admissionRejection', () => {
  it('leaves the route open when no connection service is reachable', () => {
    expect(admissionRejection({}, undefined)).toBeUndefined()
    expect(admissionRejection({}, null)).toBeUndefined()
  })

  it('passes a request the host admits', () => {
    expect(admissionRejection({}, { admit: () => ({ peer: { id: 'p' } }) })).toBeUndefined()
  })

  it('returns the status the host rejected with', () => {
    expect(admissionRejection({}, { admit: () => ({ rejection: 401 }) })).toBe(401)
    expect(admissionRejection({}, { admit: () => ({ rejection: 403 }) })).toBe(403)
  })

  it('falls back to requestRejection on hosts without admit()', () => {
    expect(admissionRejection({}, { requestRejection: () => undefined })).toBeUndefined()
    expect(admissionRejection({}, { requestRejection: () => 403 })).toBe(403)
  })

  it('fails closed instead of guessing the request is fine', () => {
    expect(admissionRejection({}, {})).toBe(503)
    expect(admissionRejection({}, { admit: () => undefined })).toBe(503)
    expect(admissionRejection({}, { admit: () => ({ rejection: 'nope' }) })).toBe(503)
    expect(admissionRejection({}, { admit: () => { throw new Error('boom') } })).toBe(503)
    expect(admissionRejection({}, { requestRejection: () => { throw new Error('boom') } })).toBe(503)
  })
})
