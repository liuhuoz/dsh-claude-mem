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
import { Button, DisclosureRow, Input, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { HEALTH_BRIDGE_PATH, parseHealth, readHealth } from '../probe.js'
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
interface Draft {
  baseUrl: string
  hookPath: string
  ingest: boolean
  summarize: boolean
  autoStartWorker: boolean
  toolNames: string
}

/** Health probe as the page shows it. */
type Probe =
  | { kind: 'idle' }
  | { kind: 'ongoing' }
  | { kind: 'done'; version?: string; pid?: number; provider?: string }
  | { kind: 'warning'; text: string }
  | { kind: 'error'; text: string }

const DEFAULT_BASE_URL = 'http://127.0.0.1:37777'

const layout = {
  root: { display: 'flex', flexDirection: 'column', gap: 18 },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  status: { display: 'flex', alignItems: 'center', gap: 6 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  switchRow: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  hint: { opacity: 0.7, paddingLeft: 44, marginTop: -4 },
  title: { margin: 0, fontSize: 13, fontWeight: 600 },
  label: { display: 'block', marginBottom: 4 },
} as const

function toolNamesOf(value: Record<string, unknown>): string[] {
  const filter = value.toolFilter
  if (typeof filter !== 'object' || filter === null) return []
  const names = (filter as { names?: unknown }).names
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
}

function toDraft(value: Record<string, unknown> | undefined): Draft {
  const source = value ?? {}
  return {
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
    hookPath: typeof source.hookPath === 'string' ? source.hookPath : '',
    ingest: source.ingest === true,
    summarize: source.summarize === true,
    autoStartWorker: source.autoStartWorker !== false,
    toolNames: toolNamesOf(source).join(', '),
  }
}

/** Write a text field, or clear it so the field falls back to its default. */
function textOp(field: string, value: string): SettingsPathOpView {
  const trimmed = value.trim()
  return trimmed.length === 0 ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: trimmed }
}

/** Turn the draft into the atomic operation set a save submits. */
function toOperations(draft: Draft): SettingsPathOpView[] {
  const names = draft.toolNames.split(/[,\s]+/).map(name => name.trim()).filter(name => name.length > 0)
  return [
    textOp('baseUrl', draft.baseUrl),
    textOp('hookPath', draft.hookPath),
    { op: 'set', path: ['ingest'], value: draft.ingest },
    { op: 'set', path: ['summarize'], value: draft.summarize },
    { op: 'set', path: ['autoStartWorker'], value: draft.autoStartWorker },
    names.length === 0 ? { op: 'unset', path: ['toolFilter'] } : { op: 'set', path: ['toolFilter', 'names'], value: names },
  ]
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
      <section style={layout.section}>
        <h3 style={layout.title}>{t('connectionTitle')}</h3>
        <label>
          <span style={layout.label}>{t('workerUrl')}</span>
          <Input
            value={draft.baseUrl}
            placeholder={DEFAULT_BASE_URL}
            disabled={!writable}
            onChange={event => update('baseUrl', event.target.value)}
          />
          <span style={{ opacity: 0.7 }}>{t('workerUrlHint')}</span>
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

      <section style={layout.section}>
        <h3 style={layout.title}>{t('hookTitle')}</h3>
        <label>
          <span style={layout.label}>{t('hookPath')}</span>
          <Input
            value={draft.hookPath}
            disabled={!writable}
            onChange={event => update('hookPath', event.target.value)}
          />
          <span style={{ opacity: 0.7 }}>{t('hookPathHint')}</span>
        </label>
        <label style={layout.switchRow}>
          <Switch
            checked={draft.autoStartWorker}
            disabled={!writable}
            label={t('autoStartWorker')}
            onChange={next => update('autoStartWorker', next)}
          />
          <span>{t('autoStartWorker')}</span>
        </label>
      </section>

      <section style={layout.section}>
        <h3 style={layout.title}>{t('behaviorTitle')}</h3>
        <label style={layout.switchRow}>
          <Switch
            checked={draft.ingest}
            disabled={!writable}
            label={t('ingest')}
            onChange={next => update('ingest', next)}
          />
          <span>{t('ingest')}</span>
        </label>
        <span style={layout.hint}>{t('ingestHint')}</span>
        <label style={layout.switchRow}>
          <Switch
            checked={draft.summarize}
            disabled={!writable}
            label={t('summarize')}
            onChange={next => update('summarize', next)}
          />
          <span>{t('summarize')}</span>
        </label>
        <span style={layout.hint}>{t('summarizeHint')}</span>
      </section>

      <DisclosureRow
        icon={null}
        title={t('advancedTitle')}
        open={advancedOpen}
        expandable
        onToggle={() => setAdvancedOpen(current => !current)}
      >
        <label>
          <span style={layout.label}>{t('toolFilter')}</span>
          <Input
            value={draft.toolNames}
            disabled={!writable}
            onChange={event => update('toolNames', event.target.value)}
          />
          <span style={{ opacity: 0.7 }}>{t('toolFilterHint')}</span>
        </label>
        <div style={layout.actions}>
          {draft.toolNames.split(/[,\s]+/).filter(name => name.length > 0).map(name => (
            <Tag key={name}>{name}</Tag>
          ))}
        </div>
      </DisclosureRow>

      <div style={layout.actions}>
        <Button variant="primary" size="sm" disabled={saving || !writable} onClick={save}>
          {saving ? t('saving') : t('save')}
        </Button>
        {notice !== undefined ? <span style={{ opacity: 0.7 }}>{notice}</span> : null}
      </div>
    </div>
  )
}
