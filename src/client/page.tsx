/**
 * The claude-mem configuration page contributed into the Plugins page's
 * `plugins.row.config` slot.
 *
 * The page owns its draft and its save control; the host owns the accepted
 * values and the write. Draft edits are discarded when it unmounts, which is
 * what the slot contract asks for.
 * @module dsh-claude-mem/client/page
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { HEALTH_BRIDGE_PATH, parseHealth, readHealth } from '../probe.js'
import { DEFAULT_FILE_CONTEXT_TOOLS, DEFAULT_TOOL_NAMES } from '../settings.js'
import type { MessageKey } from './messages.js'

/** Translation seat this page renders with. */
export type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

/** Props the slot composes for a configuration entry. */
export interface ClaudeMemPageProps {
  readonly t: Translate
  readonly view: 'summary' | 'page'
  readonly form?: ConfigPageForm | undefined
}

/** Editable projection of the accepted configuration. */
export interface Draft {
  baseUrl: string
  hookPath: string
  ingest: boolean
  summarize: boolean
  workState: boolean
  autoStartWorker: boolean
  fileContext: boolean
  fileContextGate: boolean
  subagents: boolean
  smart: boolean
  corpora: boolean
  fileContextTools: string
  toolNames: string
  sidebarEntry: boolean
}

/** Health probe as the page shows it. */
type Probe =
  | { kind: 'idle' }
  | { kind: 'ongoing' }
  | { kind: 'done'; version?: string; pid?: number; provider?: string }
  | { kind: 'warning'; text: string }
  | { kind: 'error'; text: string }

const DEFAULT_BASE_URL = 'http://127.0.0.1:37777'

/**
 * The card system the panel already renders with: the same surface, edge, radius
 * and type scale, so the page that configures the panel reads as part of it
 * rather than as a bare form standing next to it.
 */
const layout = {
  root: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    boxSizing: 'border-box',
    padding: '11px 12px',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
  } as const,
  title: {
    margin: 0,
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  field: { display: 'flex', flexDirection: 'column', gap: 3 } as const,
  label: { display: 'block', marginBottom: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } as const,
  status: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as const,
  actions: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } as const,
  /** One setting: its words on the left, its switch anchored on the right. */
  toggle: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } as const,
  toggleText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } as const,
  toggleTitle: { fontSize: 12.5, lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  /** The fold header of the advanced card, on the card's own title type. */
  cardHeading: { margin: 0 } as const,
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', boxSizing: 'border-box', margin: 0, padding: 0, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' } as const,
  chevron: { fontSize: 10, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } as const,
  advancedBody: { display: 'flex', flexDirection: 'column', gap: 14 } as const,
  /** Pinned to the bottom edge of the scrollport, so a save is always in reach. */
  saveBar: { position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, boxSizing: 'border-box', padding: '8px 12px', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10 } as const,
} as const

function toolNamesOf(value: Record<string, unknown>): string[] {
  const filter = value.toolFilter
  if (typeof filter !== 'object' || filter === null) return []
  const names = (filter as { names?: unknown }).names
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
}

function fileContextToolsOf(value: Record<string, unknown>): string[] {
  const list = value.fileContextTools
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

export function toDraft(value: Record<string, unknown> | undefined): Draft {
  const source = value ?? {}
  return {
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
    hookPath: typeof source.hookPath === 'string' ? source.hookPath : '',
    ingest: source.ingest === true,
    summarize: source.summarize === true,
    workState: source.workState !== false,
    autoStartWorker: source.autoStartWorker !== false,
    fileContext: source.fileContext === true,
    fileContextGate: source.fileContextGate === true,
    subagents: source.subagents !== false,
    smart: source.smart !== false,
    corpora: source.corpora !== false,
    fileContextTools: fileContextToolsOf(source).join(', '),
    toolNames: toolNamesOf(source).join(', '),
    sidebarEntry: source.sidebarEntry === true,
  }
}

/** Write a text field, or clear it so the field falls back to its default. */
function textOp(field: string, value: string): SettingsPathOpView {
  const trimmed = value.trim()
  return trimmed.length === 0 ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: trimmed }
}

/** Turn the draft into the atomic operation set a save submits. */
export function toOperations(draft: Draft): SettingsPathOpView[] {
  const names = draft.toolNames.split(/[,\s]+/).map(name => name.trim()).filter(name => name.length > 0)
  const contextNames = draft.fileContextTools.split(/[,\s]+/).map(name => name.trim()).filter(name => name.length > 0)
  return [
    textOp('baseUrl', draft.baseUrl),
    textOp('hookPath', draft.hookPath),
    { op: 'set', path: ['ingest'], value: draft.ingest },
    { op: 'set', path: ['summarize'], value: draft.summarize },
    { op: 'set', path: ['workState'], value: draft.workState },
    { op: 'set', path: ['autoStartWorker'], value: draft.autoStartWorker },
    names.length === 0 ? { op: 'unset', path: ['toolFilter'] } : { op: 'set', path: ['toolFilter', 'names'], value: names },
    { op: 'set', path: ['fileContext'], value: draft.fileContext },
    { op: 'set', path: ['fileContextGate'], value: draft.fileContextGate },
    { op: 'set', path: ['subagents'], value: draft.subagents },
    { op: 'set', path: ['smart'], value: draft.smart },
    { op: 'set', path: ['corpora'], value: draft.corpora },
    contextNames.length === 0 ? { op: 'unset', path: ['fileContextTools'] } : { op: 'set', path: ['fileContextTools'], value: contextNames },
    { op: 'set', path: ['sidebarEntry'], value: draft.sidebarEntry },
  ]
}

export function effectiveNames(value: string, fallback: readonly string[]): string {
  const names = value.split(/[,\s]+/).map(name => name.trim()).filter(name => name.length > 0)
  return (names.length > 0 ? names : fallback).join(', ')
}

function healthText(t: Translate, probe: Extract<Probe, { kind: 'done' | 'warning' }>): string {
  if (probe.kind === 'warning') return probe.text
  if (probe.version === undefined && probe.pid === undefined && probe.provider === undefined) {
    return t('probeConnectedPlain')
  }
  return t('probeConnected', {
    version: probe.version ?? '?',
    pid: probe.pid ?? '?',
    provider: probe.provider ?? '?',
  })
}

function dotState(probe: Probe): 'done' | 'warning' | 'ongoing' | 'error' | 'idle' {
  if (probe.kind === 'done') return 'done'
  if (probe.kind === 'warning') return 'warning'
  if (probe.kind === 'ongoing') return 'ongoing'
  if (probe.kind === 'error') return 'error'
  return 'idle'
}

/** Render the configuration page, or its one-line summary. */
export function ClaudeMemPage({ t, view, form }: ClaudeMemPageProps): JSX.Element {
  const snapshot = form?.state
  const [draft, setDraft] = useState<Draft>(() => toDraft(snapshot?.value))
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const revision = snapshot?.revision

  // A new accepted revision means the host replaced the values underneath the
  // page: re-seed the draft so the form keeps matching what is stored.
  useEffect(() => {
    setDraft(toDraft(snapshot?.value))
    // Only the revision gates the re-seed; the value rides along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const update = useCallback(<K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(current => ({ ...current, [field]: value }))
    setNotice(undefined)
  }, [])

  const runProbe = useCallback(async () => {
    const base = draft.baseUrl.trim().length > 0 ? draft.baseUrl.trim() : DEFAULT_BASE_URL
    setProbe({ kind: 'ongoing' })
    try {
      // The worker itself refuses this page's origin (the desktop renderer runs on
      // `dsh-app://app`, which its allowlist rejects), so the probe goes through
      // the plugin's host route and answers on this page's own origin.
      const response = await fetch(`${HEALTH_BRIDGE_PATH}?baseUrl=${encodeURIComponent(base)}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        setProbe({ kind: 'error', text: t('probeHttp', { status: String(response.status) }) })
        return
      }
      const payload = await response.json() as {
        ok?: boolean
        body?: unknown
        code?: string
        status?: number
      }
      if (payload.ok !== true) {
        setProbe({
          kind: 'error',
          text: payload.code === 'http'
            ? t('probeHttp', { status: String(payload.status ?? '?') })
            : t('probeUnreachable'),
        })
        return
      }
      const health = parseHealth(payload.body)
      if (health === undefined) {
        setProbe({ kind: 'error', text: t('probeNotWorker') })
        return
      }
      const reading = readHealth(health)
      if (reading.state === 'done') {
        setProbe({ kind: 'done', version: health.version, pid: health.pid, provider: health.provider })
        return
      }
      const text = reading.key === 'notInitialized'
        ? t('probeNotInitialized')
        : reading.key === 'mcpUnavailable'
          ? t('probeMcpUnavailable')
          : t('probeUnhealthy', { status: health.status })
      setProbe({ kind: 'warning', text })
    } catch {
      setProbe({ kind: 'error', text: t('probeUnreachable') })
    }
  }, [draft.baseUrl, t])

  const save = useCallback(async () => {
    if (form === undefined) return
    setSaving(true)
    try {
      const accepted = await form.mutate(toOperations(draft), snapshot?.revision)
      setNotice(accepted ? t('saved') : t('discarded'))
    } catch {
      setNotice(t('discarded'))
    } finally {
      setSaving(false)
    }
  }, [draft, form, snapshot?.revision, t])

  if (view === 'summary') return <span>{t('summary')}</span>

  if (form === undefined) {
    return (
      <div style={layout.root}>
        <p>{t('unavailable')}</p>
      </div>
    )
  }

  const writable = snapshot?.writable !== false
  const probeText = probe.kind === 'done' || probe.kind === 'warning'
    ? healthText(t, probe)
    : probe.kind === 'error' ? probe.text : probe.kind === 'ongoing' ? t('testing') : ''

  return (
    <div style={layout.root}>
      <section style={layout.card}>
        <h3 style={layout.title}>{t('connectionTitle')}</h3>
        <label style={layout.field}>
          <span style={layout.label}>{t('workerUrl')}</span>
          <Input
            value={draft.baseUrl}
            placeholder={DEFAULT_BASE_URL}
            disabled={!writable}
            onChange={event => update('baseUrl', event.target.value)}
          />
          <span style={layout.hint}>{t('workerUrlHint')}</span>
        </label>
        <div style={layout.actions}>
          <Button size="sm" variant="outline" disabled={probe.kind === 'ongoing'} onClick={runProbe}>
            {probe.kind === 'ongoing' ? t('testing') : t('test')}
          </Button>
          {probeText.length > 0 ? (
            <span style={layout.status}>
              <StateDot state={dotState(probe)} />
              <span>{probeText}</span>
            </span>
          ) : null}
        </div>
      </section>

      <section style={layout.card}>
        <h3 style={layout.title}>{t('hookTitle')}</h3>
        <label style={layout.field}>
          <span style={layout.label}>{t('hookPath')}</span>
          <Input
            value={draft.hookPath}
            disabled={!writable}
            onChange={event => update('hookPath', event.target.value)}
          />
          <span style={layout.hint}>{t('hookPathHint')}</span>
        </label>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('autoStartWorker')}</span>
          </div>
          <Switch
            checked={draft.autoStartWorker}
            disabled={!writable}
            label={t('autoStartWorker')}
            onChange={next => update('autoStartWorker', next)}
          />
        </div>
      </section>

      <section style={layout.card}>
        <h3 style={layout.title}>{t('behaviorTitle')}</h3>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('ingest')}</span>
            <span style={layout.hint}>{t('ingestHint')}</span>
          </div>
          <Switch
            checked={draft.ingest}
            disabled={!writable}
            label={t('ingest')}
            onChange={next => update('ingest', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('summarize')}</span>
            <span style={layout.hint}>{t('summarizeHint')}</span>
          </div>
          <Switch
            checked={draft.summarize}
            disabled={!writable}
            label={t('summarize')}
            onChange={next => update('summarize', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('workState')}</span>
            <span style={layout.hint}>{t('workStateHint')}</span>
          </div>
          <Switch
            checked={draft.workState}
            disabled={!writable}
            label={t('workState')}
            onChange={next => update('workState', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('fileContext')}</span>
            <span style={layout.hint}>{t('fileContextHint')}</span>
          </div>
          <Switch
            checked={draft.fileContext}
            disabled={!writable}
            label={t('fileContext')}
            onChange={next => update('fileContext', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('fileContextGate')}</span>
            <span style={layout.hint}>{t('fileContextGateHint')}</span>
          </div>
          <Switch
            checked={draft.fileContextGate}
            disabled={!writable}
            label={t('fileContextGate')}
            onChange={next => update('fileContextGate', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('subagents')}</span>
            <span style={layout.hint}>{t('subagentsHint')}</span>
          </div>
          <Switch
            checked={draft.subagents}
            disabled={!writable}
            label={t('subagents')}
            onChange={next => update('subagents', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('smart')}</span>
            <span style={layout.hint}>{t('smartHint')}</span>
          </div>
          <Switch
            checked={draft.smart}
            disabled={!writable}
            label={t('smart')}
            onChange={next => update('smart', next)}
          />
        </div>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('corpora')}</span>
            <span style={layout.hint}>{t('corporaHint')}</span>
          </div>
          <Switch
            checked={draft.corpora}
            disabled={!writable}
            label={t('corpora')}
            onChange={next => update('corpora', next)}
          />
        </div>
      </section>

      <section style={layout.card}>
        <h3 style={layout.title}>{t('interfaceTitle')}</h3>
        <div style={layout.toggle}>
          <div style={layout.toggleText}>
            <span style={layout.toggleTitle}>{t('sidebarEntry')}</span>
            <span style={layout.hint}>{t('sidebarEntryHint')}</span>
          </div>
          <Switch
            checked={draft.sidebarEntry}
            disabled={!writable}
            label={t('sidebarEntry')}
            onChange={next => update('sidebarEntry', next)}
          />
        </div>
      </section>

      <section style={layout.card}>
        <h3 style={layout.cardHeading}>
          <button
            type="button"
            style={layout.cardHeader}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(current => !current)}
          >
            <span style={layout.title}>{t('advancedTitle')}</span>
            <span style={layout.chevron} aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
          </button>
        </h3>
        {advancedOpen ? (
          <div style={layout.advancedBody}>
            <label style={layout.field}>
              <span style={layout.label}>{t('toolFilter')}</span>
              <Input
                value={draft.toolNames}
                disabled={!writable}
                onChange={event => update('toolNames', event.target.value)}
              />
              <span style={layout.hint}>{t('toolFilterHint', { names: DEFAULT_TOOL_NAMES.join(', ') })}</span>
              <div style={layout.hint}>{t('effectiveList', { names: effectiveNames(draft.toolNames, DEFAULT_TOOL_NAMES) })}</div>
            </label>
            <label style={layout.field}>
              <span style={layout.label}>{t('fileContextTools')}</span>
              <Input
                value={draft.fileContextTools}
                disabled={!writable}
                onChange={event => update('fileContextTools', event.target.value)}
              />
              <span style={layout.hint}>{t('fileContextToolsHint', { names: DEFAULT_FILE_CONTEXT_TOOLS.join(', ') })}</span>
              <div style={layout.hint}>{t('effectiveList', { names: effectiveNames(draft.fileContextTools, DEFAULT_FILE_CONTEXT_TOOLS) })}</div>
            </label>
          </div>
        ) : null}
      </section>

      <footer style={layout.saveBar}>
        <span style={layout.hint}>{notice}</span>
        <Button variant="primary" size="sm" disabled={saving || !writable} onClick={save}>
          {saving ? t('saving') : t('save')}
        </Button>
      </footer>
    </div>
  )
}