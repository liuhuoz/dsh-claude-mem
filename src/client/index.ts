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
import { en, zh } from './messages.js'

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
}
