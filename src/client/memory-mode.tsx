/**
 * The per-session memory read-only control.
 *
 * One component, four seats: a composer tool-row button, a header badge that
 * doubles as the state reminder, a New Session option beside the workspace and
 * preset dropdowns, and a dock pill next to the activity and usage pills. The
 * state is the `memReadOnly` projection; the switch is the host's
 * `/mem-readonly` command, so every surface writes through one path and the
 * pushed projection frame is the only confirmation.
 * @module dsh-claude-mem/client/memory-mode
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { translateFor, type Translate } from './messages.js'

/** The projection key the host folds the session's mode into. */
export const READ_ONLY_PROJECTION = 'memReadOnly'

/** The host command that switches the mode. */
export const READ_ONLY_COMMAND = 'mem-readonly'

/** Which seat the control is rendered in. */
export type MemoryModeVariant = 'button' | 'badge' | 'option' | 'pill'

/** The business face every registration injects. */
export interface MemoryModeInjected {
  readonly variant: MemoryModeVariant
  /** Switch the mode; resolves to an error message, or null when the command took. */
  readonly setReadOnly: (on: boolean) => Promise<string | null>
}

/** Props: the framework's session standard props plus the injected face. */
export interface MemoryModeProps extends Partial<MemoryModeInjected> {
  readonly sessionId?: string
  readonly useProjection?: (key: string) => unknown
  readonly t?: Translate
}

const BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  padding: '2px 8px',
  borderRadius: 999,
  cursor: 'pointer',
  opacity: 0.9,
}

const ACTIVE_BACKGROUND = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.18))'
const ACCENT = 'var(--dsw-alias-brand-primary, #d9a441)'

function chipStyle(readOnly: boolean): CSSProperties {
  return { ...BASE, background: readOnly ? ACTIVE_BACKGROUND : 'transparent' }
}

function pillStyle(readOnly: boolean): CSSProperties {
  return { ...BASE, fontSize: 11, padding: '1px 7px', opacity: 0.8, background: readOnly ? ACTIVE_BACKGROUND : 'transparent' }
}

function optionStyle(): CSSProperties {
  return { ...BASE, border: 0, padding: 0, gap: 8, background: 'transparent' }
}

function dotStyle(readOnly: boolean): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: 3,
    background: readOnly ? ACCENT : 'currentColor',
    opacity: readOnly ? 1 : 0.35,
  }
}

function trackStyle(readOnly: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'inline-block',
    width: 28,
    height: 16,
    borderRadius: 8,
    background: readOnly ? ACCENT : 'rgba(127,127,127,.35)',
    transition: 'background .15s',
  }
}

function knobStyle(readOnly: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    left: readOnly ? 14 : 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    background: '#fff',
    transition: 'left .15s',
  }
}

/**
 * Defensive wrapper: a shell that serves a session seat without the projection
 * hook gets nothing rather than a broken render.
 */
export function MemoryModeControl(props: MemoryModeProps): JSX.Element | null {
  if (typeof props.useProjection !== 'function') return null
  return <MemoryModeBody {...props} useProjection={props.useProjection} t={props.t ?? translateFor('en')} />
}

interface BodyProps extends MemoryModeProps {
  readonly useProjection: (key: string) => unknown
  readonly t: Translate
}

function MemoryModeBody({ sessionId, useProjection, setReadOnly, variant = 'badge', t }: BodyProps): JSX.Element | null {
  const readOnly = useProjection(READ_ONLY_PROJECTION) === true
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A pushed frame is the confirmation: a stale failure must not outlive the state it described.
  useEffect(() => { setError(null) }, [readOnly])
  if (setReadOnly === undefined || sessionId === undefined) return null
  const label = readOnly ? t('readonlyOn') : t('readonlyOff')
  const title = error === null
    ? (readOnly ? t('readonlyTitleOn') : t('readonlyTitleOff'))
    : t('readonlyFailed', { reason: error })
  const toggle = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    try {
      setError(await setReadOnly(!readOnly))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  const common = {
    type: 'button' as const,
    onClick: toggle,
    title,
    disabled: pending,
    'aria-pressed': readOnly,
  }
  if (variant === 'option') {
    return (
      <button {...common} role="switch" aria-checked={readOnly} style={optionStyle()}>
        <span>{t('readonlySwitch')}</span>
        <span style={trackStyle(readOnly)}><span style={knobStyle(readOnly)} /></span>
      </button>
    )
  }
  const text = label
  return (
    <button {...common} style={variant === 'pill' ? pillStyle(readOnly) : chipStyle(readOnly)}>
      <span style={dotStyle(readOnly)} />
      {text}
    </button>
  )
}
