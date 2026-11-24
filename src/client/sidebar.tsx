/**
 * The sidebar half of claude-mem: one row in the left rail and the page it opens.
 *
 * Both seats this file claims are declared by a shell the package does not
 * depend on at runtime, so every registration sits inside a `slots.inject`
 * callback: the callback runs only once the shell declares the seat, and a
 * shell without one leaves the row absent. Nothing here may throw — the same
 * bundle carries the Plugins page's configuration row, and a failure to mount
 * a convenience row must not take that page down with it.
 *
 * The page behind the row is the configuration page itself, driven through
 * `configForms` instead of the host-supplied form the row seat receives. The
 * glyph is Lucide's "brain" (ISC); the shell owns the row, its size and its
 * colours, this component draws only the glyph.
 * @module dsh-claude-mem/client/sidebar
 */

import { useEffect, useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { ClaudeMemTabs } from './panel.js'
import { translateFor, type Translate } from './messages.js'

/** Panel identity: the rail row's `id` and the `main` seat's `key` must agree. */
export const PANEL_ID = 'dsh-claude-mem'

/** The row's visible name, the shell's tooltip and its accessible name. */
const PANEL_LABEL = 'dsh-claude-mem'

/** Rail position: the shipped panels occupy 20–50, so this lands after them. */
const PANEL_ORDER = 60

/** Edge length the shell asks its rows for. */
const GLYPH_SIZE = 18

/** Props the shell passes a rail glyph: its own edge length and selected state. */
export interface PanelGlyphProps {
  readonly size?: number
  readonly active?: boolean
}

/**
 * The rail glyph: Lucide's "brain", drawn in `currentColor` so the shell's
 * selected and hover colours come through untouched.
 * @param props - the shell's glyph share.
 * @returns an 18×18 brain outline.
 */
export function ClaudeMemIcon({ size = GLYPH_SIZE }: PanelGlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.707 6.294A3 3 0 1 0 12 5a3 3 0 1 0-5.707 1.294" />
      <path d="M17.996 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.465" />
      <path d="M19.967 17.482a4 4 0 1 1-7.967.517 4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.465" />
      <path d="M6.004 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  )
}

/** One accepted configuration snapshot, as the settings host reports it. */
export interface FormSnapshot {
  readonly value?: Record<string, unknown> | undefined
  readonly revision?: number | undefined
  readonly writable?: boolean | undefined
}

/** The configuration scope `configForms` hands out for one row. */
export interface FormScope {
  getSnapshot(): FormSnapshot | undefined
  subscribe(listener: () => void): () => void
  mutate(ops: readonly unknown[], revision?: number): Promise<boolean> | boolean
}

/** The optional settings service this half reads its own switch from. */
interface ConfigFormsFace {
  get(rowId: string): FormScope | undefined
  whileServed?(rowIds: readonly string[], run: () => (() => void) | void): () => void
}

/** Loose seat shapes: this bundle must typecheck against shells that lack them. */
interface SlotOptions {
  readonly [key: string]: unknown
  readonly name: string
}

interface SlotFace {
  register(options: SlotOptions, component: unknown): (() => void) | undefined
  inject(slot: string, factory: () => (() => void) | void): (() => void) | undefined
}

interface SidebarSeat {
  readonly slots?: SlotFace
  inject?(deps: readonly string[], run: (inner: { configForms?: ConfigFormsFace }) => (() => void) | void): (() => void) | undefined
}

/**
 * The page frame the shipped centre-column panels use: the panel owns its own
 * height and carries the shell's top margin (28px plus the desktop titlebar
 * clearance). The side gutter and the scrolling body live in the panel itself,
 * the same division the market panel uses. The row-configuration seat renders
 * the same page without this frame, because the Plugins page already pads it.
 */
const PANEL_SHELL_STYLE = {
  boxSizing: 'border-box',
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))',
} as const

/** What the row's page receives through the `main` seat's inject callback. */
interface PanelProps {
  readonly t?: Translate
  readonly scope?: FormScope | undefined
}

/**
 * Project a configuration scope into the form shape the page already takes, so
 * both seats render the same component and cannot drift apart.
 * @param scope - the row's configuration scope, when the host serves one.
 * @returns a form whose state follows the scope, or undefined while unreadable.
 */
function useConfigForm(scope: FormScope | undefined): ConfigPageForm | undefined {
  const [snapshot, setSnapshot] = useState<FormSnapshot | undefined>(() => scope?.getSnapshot())

  useEffect(() => {
    if (scope === undefined) {
      setSnapshot(undefined)
      return
    }
    const sync = (): void => setSnapshot(scope.getSnapshot())
    sync()
    return scope.subscribe(sync)
  }, [scope])

  return useMemo(() => {
    if (scope === undefined || snapshot === undefined) return undefined
    return {
      state: snapshot,
      mutate: async (ops: unknown, revision?: number) =>
        Boolean(await scope.mutate(ops as readonly unknown[], revision)),
    } as unknown as ConfigPageForm
  }, [scope, snapshot])
}

/**
 * The row's page: the configuration page, mounted in the centre column.
 * @param props - the injected translator and configuration scope.
 * @returns the configuration page.
 */
export function ClaudeMemPanel({ t, scope }: PanelProps): JSX.Element {
  const form = useConfigForm(scope)
  const translate = t ?? translateFor('en')
  return (
    <div style={PANEL_SHELL_STYLE}>
      <ClaudeMemTabs t={translate} form={form} />
    </div>
  )
}

/** Pick the language to render the panel in, without depending on a locale API. */
function detectLanguage(locale: unknown): string {
  const face = locale as { getSnapshot?: () => { active?: string } | undefined } | undefined
  const active = face?.getSnapshot?.()?.active
  const browser = typeof navigator === 'undefined'
    ? undefined
    : navigator.languages?.[0] ?? navigator.language
  return String(active ?? browser ?? 'en')
}

/** Whether the accepted configuration has the row switched on. */
function rowEnabled(scope: FormScope): boolean {
  const value = scope.getSnapshot()?.value
  return value !== undefined && value.sidebarEntry === true
}

/** Read the switch, treating an unreadable scope as "off". */
function readEnabled(scope: FormScope): boolean {
  try {
    return rowEnabled(scope)
  } catch {
    return false
  }
}

/** Options the plugin half hands the sidebar registration. */
export interface SidebarOptions {
  readonly rowId: string
  readonly locale?: unknown
}

/**
 * Register the rail row and its page, following the switch in the settings row.
 *
 * Never throws: every failure degrades into a missing row plus one console
 * line, because the bundle's other seats stay useful without this one.
 * @param ctx - the client root context.
 * @param options - the loader row id and the locale service.
 * @returns a disposer releasing the row, the page and the subscription.
 */
export function registerSidebar(ctx: Context, options: SidebarOptions): () => void {
  const seat = ctx as unknown as SidebarSeat
  const slots = seat.slots
  if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
    return () => {}
  }

  let stopRow: (() => void) | undefined
  let stopScope: (() => void) | undefined
  let scope: FormScope | undefined

  const show = (enabled: boolean): void => {
    if (enabled === (stopRow !== undefined)) return
    if (!enabled) {
      try {
        stopRow?.()
      } catch (error) {
        console.error('dsh-claude-mem: releasing the sidebar entry failed', error)
      }
      stopRow = undefined
      return
    }
    try {
      const stop = slots.inject('main', () => slots.inject('sidebar.panellist', () => {
        const panel = slots.register(
          { name: 'main', key: PANEL_ID, inject: () => ({ t: translateFor(detectLanguage(options.locale)), scope }) },
          ClaudeMemPanel,
        )
        const row = slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => PANEL_LABEL },
          ClaudeMemIcon,
        )
        return () => {
          try {
            row?.()
          } catch {
            /* the shell owns disposal of its own seat */
          }
          try {
            panel?.()
          } catch {
            /* as above */
          }
        }
      }))
      stopRow = typeof stop === 'function' ? stop : () => {}
    } catch (error) {
      console.error('dsh-claude-mem: registering the sidebar entry failed', error)
      stopRow = undefined
    }
  }

  const attach = (next: FormScope | undefined): void => {
    try {
      stopScope?.()
    } catch {
      /* a stale subscription cannot keep the row alive */
    }
    stopScope = undefined
    scope = next
    if (next === undefined) {
      show(false)
      return
    }
    const update = (): void => show(readEnabled(next))
    update()
    try {
      stopScope = next.subscribe(update)
    } catch (error) {
      console.error('dsh-claude-mem: watching the configuration scope failed', error)
      stopScope = undefined
    }
  }

  let stopInject: (() => void) | undefined
  try {
    if (typeof seat.inject === 'function') {
      const result = seat.inject(['configForms'], (inner) => {
        const forms = inner.configForms
        if (forms === undefined) return
        const run = (): (() => void) => {
          attach(forms.get(options.rowId))
          return () => {
            try {
              stopScope?.()
            } catch {
              /* nothing left to release */
            }
            stopScope = undefined
            scope = undefined
            show(false)
          }
        }
        if (typeof forms.whileServed === 'function') return forms.whileServed([options.rowId], run)
        return run()
      })
      stopInject = typeof result === 'function' ? result : undefined
    }
  } catch (error) {
    console.error('dsh-claude-mem: reading the configuration scope failed', error)
  }

  return () => {
    try {
      stopInject?.()
    } catch {
      /* the injection chain releases what it owns */
    }
    try {
      stopScope?.()
    } catch {
      /* as above */
    }
    try {
      stopRow?.()
    } catch {
      /* as above */
    }
  }
}
