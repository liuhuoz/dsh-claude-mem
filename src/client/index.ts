/**
 * Browser half of the claude-mem plugin: registers the configuration page into
 * the Plugins page's row slot and the page's own copy into the locale registry.
 *
 * The host mounts this module on the Loader row whose specifier is exactly this
 * package name, so the registration lives only while the plugin is enabled.
 * @module dsh-claude-mem/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ClaudeMemPage } from './page.js'
import { registerSidebar } from './sidebar.js'
import { en, zh } from './messages.js'
import { MemoryModeControl, READ_ONLY_COMMAND, type MemoryModeVariant } from './memory-mode.js'

export const name = 'dsh-claude-mem-client'

/** Services this half needs before it can register anything. */
export const inject = ['slots', 'locale']

/** The bundle's package name, fixed by `package.json`. */
export const PACKAGE = '@liuhuoz/dsh-claude-mem'

/** The row id the bundle patch declares for the claude-mem entry. */
export const ROW_ID = 'dsh-claude-mem'

/** Dictionary namespace this half registers and renders the page with. */
export const LOCALE = 'dsh-claude-mem'

/**
 * The two services this half consumes. The framework provides `slots` as a
 * `SlotCore` seat with its own injection helper, and `locale` as the browser
 * locale registry; neither ships a `Context` augmentation this package can
 * import, so both are declared here rather than guessed at a call site.
 */
interface ClientSeat extends SlotCore {
  /** Run `factory` once the slot exists, and again if it is redeclared. */
  inject(slot: string, factory: () => () => void): () => void
}

/** Register the locale dictionaries and the row configuration page. */
export function apply(ctx: Context): void {
  const { slots, locale } = ctx as Context & { slots: ClientSeat; locale: LocaleRuntime }
  ctx.effect(() => locale.register(LOCALE, 'en', { ...en }))
  ctx.effect(() => locale.register(LOCALE, 'zh', { ...zh }))
  slots.inject('plugins.row.config', () => slots.register({
    name: 'plugins.row.config',
    key: `${PACKAGE}#${ROW_ID}`,
    locale: LOCALE,
  }, ClaudeMemPage))

  // The sidebar row is a convenience over the same page; a shell that cannot
  // serve it, or a user who left the switch off, simply has no row.
  ctx.effect(() => registerSidebar(ctx, { rowId: ROW_ID, locale }))
  // The read-only control rides the host command channel; a shell without it
  // shows no control, and the slash command stays the way in.
  ctx.effect(() => registerMemoryMode(ctx))
}

/** Minimal slot face: registration and the seat-existence gate. */
interface SlotFace {
  register(options: Record<string, unknown>, component: unknown): (() => void) | undefined
  inject(slot: string, factory: () => (() => void) | void): (() => void) | undefined
}

/** The host's remote command channel, as the page sees it. */
interface RemoteCommands {
  execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<
    | { readonly ok: true; readonly value?: unknown }
    | { readonly ok: false; readonly error: { readonly message: string; readonly code: string } }
  >
}

interface RemoteFace {
  readonly commands: RemoteCommands
}

/** One configuration row's accepted value, as the client sees it. */
interface SeatScope {
  getSnapshot?(): { readonly value?: Record<string, unknown> } | undefined
  subscribe(listener: () => void): () => void
}

/** The optional settings service the page and the rail row already read. */
interface ConfigFormsFace {
  get(rowId: string): SeatScope | undefined
  whileServed?(rowIds: readonly string[], run: () => (() => void) | void): () => void
}

/** The client root context as this module reaches optional services. */
interface ModeSeat {
  inject?: (
    deps: readonly string[],
    run: (inner: { slots?: SlotFace; remote?: RemoteFace; configForms?: ConfigFormsFace }) => (() => void) | void,
  ) => (() => void) | void
}

/** Which configuration key governs which seat. */
type SeatKey = 'seatComposer' | 'seatHeader' | 'seatDock' | 'seatHero'

interface SeatSpec {
  readonly key: SeatKey
  readonly name: string
  readonly variant: MemoryModeVariant
  readonly order: number
}

const SEATS: readonly SeatSpec[] = [
  { key: 'seatComposer', name: 'conversation.input.left', variant: 'button', order: 20 },
  { key: 'seatHeader', name: 'conversation.session.header.actions', variant: 'badge', order: 20 },
  { key: 'seatDock', name: 'conversation.composer.dock', variant: 'dock', order: 2 },
  { key: 'seatHero', name: 'conversation.hero.options', variant: 'option', order: 10 },
]

/** Read the seat choice out of one accepted configuration value. */
function seatFlags(value: Record<string, unknown> | undefined): Partial<Record<SeatKey, boolean>> {
  const source = value ?? {}
  const choice = typeof source.sessionSeat === 'string' ? source.sessionSeat : 'composer'
  return {
    seatComposer: choice === 'composer',
    seatHeader: choice === 'header',
    seatDock: choice === 'dock',
    seatHero: source.seatHero !== false,
  }
}

/**
 * Register the read-only control into every seat the shell offers and this
 * configuration keeps on.
 *
 * A seat is optional twice over: the shell may not declare it, and the user may
 * switch it off. Both cases show nothing rather than a dead control. The seats
 * follow the accepted configuration live, so a save in the settings page moves
 * a control without a reload.
 * @param ctx - the client root context.
 * @returns a disposer releasing every registration.
 */
function registerMemoryMode(ctx: Context): () => void {
  const seat = ctx as unknown as ModeSeat
  if (typeof seat.inject !== 'function') return () => {}
  let stop: (() => void) | undefined
  try {
    const result = seat.inject(['slots', 'remote', 'remote.commands'], (inner) => {
      const slots = inner.slots
      const remote = inner.remote
      if (slots === undefined || remote === undefined) return
      const placed = new Map<SeatKey, () => void>()
      let stopScope: (() => void) | undefined

      const place = (spec: SeatSpec): void => {
        if (placed.has(spec.key)) return
        const release = slots.inject(spec.name, () => slots.register({
          name: spec.name,
          id: ROW_ID + '-readonly',
          order: spec.order,
          locale: LOCALE,
          inject: (sessionId: string) => ({
            variant: spec.variant,
            setReadOnly: async (on: boolean): Promise<string | null> => {
              try {
                const answer = await remote.commands.execute(
                  sessionId,
                  '/' + READ_ONLY_COMMAND + ' ' + (on ? 'read-only' : 'read-write'),
                  [],
                )
                if (!answer.ok) return answer.error.message + ' (' + answer.error.code + ')'
                return answer.value === undefined ? 'unknown command' : null
              } catch (error: unknown) {
                return error instanceof Error ? error.message : String(error)
              }
            },
          }),
        }, MemoryModeControl))
        if (typeof release === 'function') placed.set(spec.key, release)
      }

      const withdraw = (key: SeatKey): void => {
        const release = placed.get(key)
        if (release === undefined) return
        placed.delete(key)
        try {
          release()
        } catch {
          /* the shell owns disposal of its own seats */
        }
      }

      const apply = (flags: Partial<Record<SeatKey, boolean>>): void => {
        for (const spec of SEATS) {
          if (flags[spec.key] === false) withdraw(spec.key)
          else place(spec)
        }
      }

      // Every seat on until the configuration scope says otherwise.
      apply({})

      const watch = (forms: ConfigFormsFace): (() => void) => {
        const run = (): (() => void) => {
          const scope = forms.get(ROW_ID)
          if (scope === undefined) return () => {}
          const sync = (): void => {
            try {
              apply(seatFlags(scope.getSnapshot?.()?.value))
            } catch {
              apply({})
            }
          }
          sync()
          try {
            stopScope = scope.subscribe(sync)
          } catch {
            stopScope = undefined
          }
          return () => {
            try {
              stopScope?.()
            } catch {
              /* as above */
            }
            stopScope = undefined
          }
        }
        const cleanup = typeof forms.whileServed === 'function' ? forms.whileServed([ROW_ID], run) : run()
        return typeof cleanup === 'function' ? cleanup : () => {}
      }

      let stopForms: (() => void) | undefined
      try {
        const watching = seat.inject!(['configForms'], (formSeat) => {
          const forms = formSeat.configForms
          if (forms === undefined) return
          return watch(forms)
        })
        stopForms = typeof watching === 'function' ? watching : undefined
      } catch {
        /* a shell without the settings service keeps every seat */
      }

      return () => {
        try {
          stopForms?.()
        } catch {
          /* the shell releases its own seats */
        }
        try {
          stopScope?.()
        } catch {
          /* as above */
        }
        for (const release of placed.values()) {
          try {
            release()
          } catch {
            /* as above */
          }
        }
        placed.clear()
      }
    })
    stop = typeof result === 'function' ? result : undefined
  } catch (error) {
    console.error('dsh-claude-mem: registering the memory read-only control failed', error)
  }
  return () => {
    try {
      stop?.()
    } catch {
      /* as above */
    }
  }
}
