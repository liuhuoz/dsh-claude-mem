import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * Guards the shape the host actually loads. `lib/client.js` is executed as a
 * classic script that registers a factory into `window.__ModuleLoader__`, so an
 * ES module bundle parses as nothing and takes the whole plugin combo down with
 * it. This test fails if the build regresses to `import` statements.
 */
const BUNDLE = 'lib/client.js'

interface LoaderEntry {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

function loadBundle(): LoaderEntry | undefined {
  if (!existsSync(BUNDLE)) return undefined
  const sandbox: Record<string, unknown> = {}
  let entry: LoaderEntry | undefined
  sandbox.window = { __ModuleLoader__: { load: (value: LoaderEntry) => { entry = value } } }
  sandbox.globalThis = sandbox.window
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), sandbox, { filename: BUNDLE })
  return entry
}

const stubComponent = () => function Stub() { return null }

function requireStub(specifier: string): unknown {
  if (specifier === 'react') {
    return {
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
      useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
      createElement: () => null,
    }
  }
  if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: () => stubComponent() })
  }
  throw new Error(`unexpected require: ${specifier}`)
}

describe('client bundle', () => {
  const entry = loadBundle()

  it.skipIf(entry === undefined)('registers a loader factory under the package name', () => {
    expect(entry!.id).toBe('@liuhuoz/dsh-claude-mem')
    expect(typeof entry!.factory).toBe('function')
  })

  it.skipIf(entry === undefined)('executes as CommonJS and exports the plugin surface', () => {
    const exports = entry!.factory(requireStub)
    expect(Object.keys(exports).sort()).toEqual(['LOCALE', 'PACKAGE', 'ROW_ID', 'apply', 'inject', 'name'])
    expect(exports.inject).toEqual(['slots', 'locale'])
  })

  it.skipIf(entry === undefined)('registers the locales and the row configuration page', () => {
    const exports = entry!.factory(requireStub)
    const dictionaries: Array<{ namespace: string; locale: string }> = []
    const registrations: Array<{ name: string; key?: string; locale?: string }> = []

    const ctx = {
      effect: (factory: () => unknown) => {
        factory()
        return () => {}
      },
      locale: {
        register: (namespace: string, locale: string) => {
          dictionaries.push({ namespace, locale })
          return () => {}
        },
      },
      slots: {
        inject: (_slot: string, factory: () => unknown) => {
          factory()
          return () => {}
        },
        register: (options: { name: string; key?: string; locale?: string }, component: unknown) => {
          registrations.push(options)
          expect(typeof component).toBe('function')
          return () => {}
        },
      },
    }

    ;(exports.apply as (ctx: unknown) => void)(ctx)

    expect(dictionaries).toEqual([
      { namespace: 'dsh-claude-mem', locale: 'en' },
      { namespace: 'dsh-claude-mem', locale: 'zh' },
    ])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: 'plugins.row.config',
      key: '@liuhuoz/dsh-claude-mem#dsh-claude-mem',
      locale: 'dsh-claude-mem',
    })
  })
})
