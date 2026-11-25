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
      useMemo: (factory: () => unknown) => factory(),
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

  /** Apply the bundle against a shell whose configuration scope holds `sidebarEntry`. */
  const applyWithScope = (value: boolean | undefined, serveForms = true) => {
    const exports = entry!.factory(requireStub)
    const registrations: Array<Record<string, unknown>> = []
    const dispose = () => () => {}
    const scope = value === undefined
      ? undefined
      : {
          getSnapshot: () => ({ value: { sidebarEntry: value }, revision: 1, writable: true }),
          subscribe: dispose,
          mutate: () => true,
        }
    const ctx = {
      effect: (factory: () => unknown) => {
        factory()
        return dispose()
      },
      locale: { register: dispose },
      slots: {
        inject: (_slot: string, factory: () => unknown) => {
          factory()
          return dispose()
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push(options)
          expect(typeof component).toBe('function')
          return dispose()
        },
      },
      inject: (_deps: string[], run: (inner: unknown) => unknown) => {
        if (serveForms) run({ configForms: { get: () => scope } })
        return dispose()
      },
    }
    ;(exports.apply as (ctx: unknown) => void)(ctx)
    return registrations
  }

  it.skipIf(entry === undefined)('registers the rail row and its page once the switch is on', () => {
    const registrations = applyWithScope(true)
    const row = registrations.find(options => options.name === 'sidebar.panellist')
    const page = registrations.find(options => options.name === 'main')
    expect(row).toMatchObject({ id: 'dsh-claude-mem', order: 60 })
    expect((row!.label as () => string)()).toBe('dsh-claude-mem')
    expect(page).toMatchObject({ key: 'dsh-claude-mem' })
  })

  it.skipIf(entry === undefined)('leaves the rail row out while the switch is off', () => {
    const registrations = applyWithScope(false)
    expect(registrations.map(options => options.name)).toEqual(['plugins.row.config'])
  })

  it.skipIf(entry === undefined)('yields to a shell that serves no configuration forms', () => {
    const registrations = applyWithScope(undefined, false)
    expect(registrations.map(options => options.name)).toEqual(['plugins.row.config'])
  })
})
