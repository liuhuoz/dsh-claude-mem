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

  /** Apply the bundle against a shell that serves the command channel. */
  const applyWithModeSeats = (value?: Record<string, unknown>) => {
    const exports = entry!.factory(requireStub)
    const registrations: Array<Record<string, unknown>> = []
    const calls: Array<{ sessionId: string; line: string }> = []
    let answer: { ok: boolean; value?: unknown; error?: { message: string; code: string } } = { ok: true, value: { kind: 'success' } }
    const dispose = () => () => {}
    const slots = {
      // The shell's seat gate: the inner registration lives exactly as long as
      // this disposer, which is what a seat switched off in the configuration uses.
      inject: (_slot: string, factory: () => unknown) => {
        const inner = factory()
        return () => {
          if (typeof inner === 'function') inner()
        }
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push(options)
        expect(typeof component).toBe('function')
        return () => {
          const at = registrations.indexOf(options)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
    }
    const remote = {
      commands: {
        execute: async (sessionId: string, line: string) => {
          calls.push({ sessionId, line })
          return answer
        },
      },
    }
    const configForms = {
      get: () => value === undefined
        ? undefined
        : { getSnapshot: () => ({ value }), subscribe: () => dispose() },
    }
    const ctx = {
      effect: (factory: () => unknown) => {
        factory()
        return dispose()
      },
      locale: { register: dispose },
      slots,
      inject: (deps: string[], run: (inner: unknown) => unknown) => {
        run(deps.includes('configForms') ? { slots, remote, configForms } : { slots, remote })
        return dispose()
      },
    }
    ;(exports.apply as (ctx: unknown) => void)(ctx)
    return { registrations, calls, fail: () => { answer = { ok: false, error: { message: 'refused', code: 'DENIED' } } } }
  }

  it.skipIf(entry === undefined)('mounts the read-only control at four seats', () => {
    const { registrations } = applyWithModeSeats()
    const seats = registrations.filter(options => String(options.name ?? '').startsWith('conversation.'))
    expect(seats.map(options => options.name)).toEqual([
      'conversation.input.left',
      'conversation.session.header.actions',
      'conversation.composer.dock',
      'conversation.hero.options',
    ])
    for (const seat of seats) {
      expect(seat).toMatchObject({ id: 'dsh-claude-mem-readonly', locale: 'dsh-claude-mem' })
      expect(typeof seat.inject).toBe('function')
    }
  })

  it.skipIf(entry === undefined)('mounts only the seat the configuration chose', () => {
    const { registrations } = applyWithModeSeats({ sessionSeat: 'header' })
    const seats = registrations.filter(options => String(options.name ?? '').startsWith('conversation.'))
    expect(seats.map(options => options.name)).toEqual([
      'conversation.session.header.actions',
      'conversation.hero.options',
    ])
  })

  it.skipIf(entry === undefined)('hides every in-session seat on the off choice', () => {
    const { registrations } = applyWithModeSeats({ sessionSeat: 'none' })
    const seats = registrations.filter(options => String(options.name ?? '').startsWith('conversation.'))
    expect(seats.map(options => options.name)).toEqual(['conversation.hero.options'])
  })

  it.skipIf(entry === undefined)('switches the mode through the host command', async () => {
    const { registrations, calls, fail } = applyWithModeSeats()
    const option = registrations.find(options => options.name === 'conversation.hero.options')!
    const face = (option.inject as (id: string) => { variant: string; setReadOnly: (on: boolean) => Promise<string | null> })('session-1')
    expect(face.variant).toBe('option')
    await expect(face.setReadOnly(true)).resolves.toBeNull()
    expect(calls).toEqual([{ sessionId: 'session-1', line: '/mem-readonly read-only' }])
    await expect(face.setReadOnly(false)).resolves.toBeNull()
    expect(calls[1]).toEqual({ sessionId: 'session-1', line: '/mem-readonly read-write' })
    fail()
    await expect(face.setReadOnly(true)).resolves.toBe('refused (DENIED)')
  })
})
