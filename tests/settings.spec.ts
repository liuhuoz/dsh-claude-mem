import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'
import { resolveSettings } from '../src/settings.js'

/** Stand-in for schemastery's volatile cell, which the host writes in place. */
function cell<T>(value: T) {
  return { get: () => value, set: () => {} }
}

describe('resolveSettings', () => {
  it('projects plain values', () => {
    const settings = resolveSettings({
      baseUrl: 'http://127.0.0.1:37777',
      hookPath: 'C:/claude-mem.exe',
      injectContext: false,
      ingest: true,
      summarize: true,
      autoStartWorker: false,
      toolFilter: { names: ['read', 'bash'] },
    })
    expect(settings.baseUrl).toBe('http://127.0.0.1:37777')
    expect(settings.hookPath).toBe('C:/claude-mem.exe')
    expect(settings.injectContext).toBe(false)
    expect(settings.ingest).toBe(true)
    expect(settings.summarize).toBe(true)
    expect(settings.autoStartWorker).toBe(false)
    expect(settings.toolFilter.names).toEqual(['read', 'bash'])
  })

  it('unwraps volatile cells, which is what a live edit arrives as', () => {
    const settings = resolveSettings({
      baseUrl: cell('http://127.0.0.1:41000'),
      hookPath: cell('C:/other.exe'),
      injectContext: cell(false),
      ingest: cell(true),
      summarize: cell(true),
      autoStartWorker: cell(false),
      toolFilter: cell({ names: cell(['edit']) }),
    })
    expect(settings.baseUrl).toBe('http://127.0.0.1:41000')
    expect(settings.hookPath).toBe('C:/other.exe')
    expect(settings.injectContext).toBe(false)
    expect(settings.ingest).toBe(true)
    expect(settings.autoStartWorker).toBe(false)
    expect(settings.toolFilter.names).toEqual(['edit'])
  })

  it('falls back to the schema defaults for missing or empty values', () => {
    const settings = resolveSettings({})
    expect(settings.baseUrl).toBe('')
    expect(settings.hookPath).toBe('')
    expect(settings.injectContext).toBe(true)
    expect(settings.ingest).toBe(false)
    expect(settings.summarize).toBe(false)
    expect(settings.autoStartWorker).toBe(true)
    expect(settings.timeoutMs).toBe(30_000)
    expect(settings.dedupe).toBe(true)
    expect(settings.toolFilter.names).toEqual(['read', 'write', 'edit', 'bash'])
  })

  it('treats a cell still holding nothing as unset', () => {
    const settings = resolveSettings({ baseUrl: cell(undefined), ingest: cell(undefined) })
    expect(settings.baseUrl).toBe('')
    expect(settings.ingest).toBe(false)
  })

  it('keeps the default tool list when the filter is empty or malformed', () => {
    expect(resolveSettings({ toolFilter: { names: [] } }).toolFilter.names).toEqual(['read', 'write', 'edit', 'bash'])
    expect(resolveSettings({ toolFilter: { names: 'read' } }).toolFilter.names).toEqual(['read', 'write', 'edit', 'bash'])
    expect(resolveSettings({ toolFilter: null }).toolFilter.names).toEqual(['read', 'write', 'edit', 'bash'])
  })
})

describe('Config schema', () => {
  /** `toJSON()` stores every node once under `refs`, keyed by uid. */
  interface SchemaNode {
    meta?: { volatile?: boolean }
    dict?: Record<string, number>
  }
  interface SchemaJson {
    uid: number
    refs: Record<string, SchemaNode>
  }

  const json = Config.toJSON() as unknown as SchemaJson
  const root = json.refs[String(json.uid)]
  const nodeOf = (field: string): SchemaNode | undefined => {
    const uid = root?.dict?.[field]
    return uid === undefined ? undefined : json.refs[String(uid)]
  }

  /**
   * The settings service only projects a form for a namespace when at least one
   * field is volatile, and it drops every field that is not. A plain field here
   * makes the Plugins page pass no form at all, which is how the page first
   * shipped as "unavailable".
   */
  it('marks every field the page edits as volatile', () => {
    const pageFields = ['baseUrl', 'hookPath', 'injectContext', 'ingest', 'summarize', 'autoStartWorker', 'toolFilter']
    for (const field of pageFields) {
      expect(nodeOf(field)?.meta?.volatile, `${field} must be volatile`).toBe(true)
    }
  })

  it('leaves reload-scoped fields plain', () => {
    for (const field of ['timeoutMs', 'dedupe', 'project', 'platformSource']) {
      expect(nodeOf(field)?.meta?.volatile, `${field} must stay plain`).toBeFalsy()
    }
  })
})
