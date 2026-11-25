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

/** The client root context as this module reaches optional services. */
interface ModeSeat {
  inject?: (
    deps: readonly string[],
    run: (inner: { slots?: SlotFace; remote?: RemoteFace }) => (() => void) | void,
  ) => (() => void) | void
}

/**
 * Register the read-only control into every seat the shell offers.
 *
 * Every seat is optional: a shell without the seat, or without the command
 * channel, shows no control instead of a dead one.
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
      const stops: Array<(() => void) | undefined> = []
      const place = (name: string, variant: MemoryModeVariant, order: number): void => {
        stops.push(slots.inject(name, () => slots.register({
          name,
          id: ROW_ID + '-readonly',
          order,
          locale: LOCALE,
          inject: (sessionId: string) => ({
            variant,
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
        }, MemoryModeControl)))
      }
      place('conversation.input.left', 'button', 20)
      place('conversation.session.header.actions', 'badge', 20)
      place('conversation.hero.options', 'option', 10)
      place('conversation.composer.dock', 'pill', 2)
      return () => {
        for (const release of stops) {
          try {
            release?.()
          } catch {
            /* the shell owns disposal of its own seats */
          }
        }
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
