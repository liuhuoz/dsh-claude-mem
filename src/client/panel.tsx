/**
 * Panel shell: four tabs over one page, with the data pages reading the host's
 * aggregated overview route.
 *
 * The settings tab is the configuration page itself, unchanged; the other tabs
 * are read-only. Nothing here calls the worker directly — the page origin is
 * refused by claude-mem, so every number arrives through the host bridge.
 * @module dsh-claude-mem/client/panel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Overview } from '../overview-types.js'
import { ClaudeMemPage } from './page.js'
import { Heatmap } from './heatmap.js'
import { CompositionRing, ProjectRanking, StackedBars, lastDays, projectColor, typeColor } from './breakdown.js'
import type { Translate } from './messages.js'

/** The bridge the host registers. */
const OVERVIEW_PATH = '/api/dsh-claude-mem/overview'

type TabKey = 'overview' | 'trend' | 'sessions' | 'settings'

const TABS: readonly { key: TabKey; label: (t: Translate) => string }[] = [
  { key: 'overview', label: (t) => t('tabOverview') },
  { key: 'trend', label: (t) => t('tabTrend') },
  { key: 'sessions', label: (t) => t('tabSessions') },
  { key: 'settings', label: (t) => t('tabSettings') },
]

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 } as const,
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 6 } as const,
  tab: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12.5,
    padding: '5px 11px',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  tabOn: { background: 'var(--dsw-alias-interactive-bg-active)', color: 'var(--dsw-alias-label-primary)' } as const,
  status: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as const,
  pill: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--dsw-alias-interactive-bg-hover)' } as const,
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 9 } as const,
  charts: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } as const,
  card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 2 } as const,
  kpiValue: { fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' } as const,
  kpiLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } as const,
  kpiFoot: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
  section: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 8 } as const,
  sectionTitle: { margin: 0, fontSize: 11.5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)' } as const,
  row: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } as const,
  rowTitle: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  rowMeta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } as const,
  tag: { flex: 'none', fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' } as const,
  links: { display: 'flex', gap: 12, fontSize: 12 } as const,
  link: { color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none', borderBottom: '1px dashed currentColor', cursor: 'pointer' } as const,
  muted: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } as const,
  mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 54, overflow: 'hidden', color: 'var(--dsw-alias-label-secondary)' } as const,
} as const

/** Compact human duration, e.g. 9h 12m. */
function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm'
}

/** Relative time from an epoch in milliseconds. */
function relative(epochMs: number | undefined, t: Translate): string {
  if (epochMs === undefined) return '—'
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000))
  if (minutes < 1) return t('timeJustNow')
  if (minutes < 60) return t('timeMinutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('timeHours', { count: hours })
  return t('timeDays', { count: Math.round(hours / 24) })
}

/** Tokens as 264k or 38.8M. */
function compact(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M'
  if (count >= 1_000) return Math.round(count / 1_000) + 'k'
  return String(count)
}

/** Bytes as MB with one decimal. */
function megabytes(bytes: number | undefined): string {
  return bytes === undefined ? '—' : (bytes / 1_048_576).toFixed(2) + ' MB'
}

/** A labelled number card. */
function Kpi({ value, label, foot }: { value: string; label: string; foot?: string }): JSX.Element {
  return (
    <div style={styles.card}>
      <span style={styles.kpiValue}>{value}</span>
      <span style={styles.kpiLabel}>{label}</span>
      {foot !== undefined ? <span style={styles.kpiFoot}>{foot}</span> : null}
    </div>
  )
}

/** The first tab: is memory alive, how much is there, what landed last. */
function OverviewTab({ t }: { t: Translate }): JSX.Element {
  const [data, setData] = useState<Overview | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const response = await fetch(OVERVIEW_PATH, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('http ' + response.status)
      setData(await response.json() as Overview)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (data === undefined && failed) {
    return (
      <div style={styles.section}>
        <span style={styles.rowMeta}>{t('overviewUnavailable')}</span>
        <div><Button size="sm" variant="outline" onClick={() => void load()}>{t('overviewRetry')}</Button></div>
      </div>
    )
  }
  if (data === undefined) return <span style={styles.muted}>{t('overviewLoading')}</span>

  const worker = data.worker
  const database = data.database
  const processing = data.processing
  const projects = data.projects
  const savings = data.savings
  const up = worker !== null

  return (
    <>
      <div style={styles.status}>
        <StateDot state={up ? 'done' : 'error'} />
        <span>
          {worker?.version !== undefined ? 'worker ' + worker.version : t('overviewWorkerDown')}
          {worker?.port !== undefined ? ' · ' + worker.port : ''}
          {worker?.uptimeSeconds !== undefined ? ' · ' + duration(worker.uptimeSeconds) : ''}
        </span>
        {processing?.queueDepth !== undefined ? <span style={styles.pill}>{t('ovQueue')} {processing.queueDepth}</span> : null}
        {processing?.lastSuccessfulStoreAt !== undefined ? <span style={styles.pill}>{t('ovLastStore', { when: relative(processing.lastSuccessfulStoreAt, t) })}</span> : null}
        {worker?.activeSessions !== undefined ? <span style={styles.pill}>{t('ovActiveSessions', { count: worker.activeSessions })}</span> : null}
        {data.mcp?.enabled !== undefined ? <span style={styles.pill}>{t('ovMcp', { state: data.mcp.enabled ? t('on') : t('off') })}</span> : null}
        {data.chroma?.status !== undefined ? <span style={styles.pill}>{t('ovVector', { state: data.chroma.status === 'disabled' ? t('ovVectorOff') : data.chroma.status })}</span> : null}
      </div>

      <div style={styles.kpis}>
        <Kpi value={database?.observations?.toLocaleString() ?? '—'} label={t('kpiObservations')} />
        <Kpi value={database?.sessions?.toLocaleString() ?? '—'} label={t('kpiSessions')} />
        <Kpi value={database?.summaries?.toLocaleString() ?? '—'} label={t('kpiSummaries')} />
        <Kpi value={megabytes(database?.sizeBytes)} label={t('kpiDatabase')} foot={database?.firstObservationAt !== undefined ? t('kpiDatabaseFoot', { date: database.firstObservationAt.slice(0, 10) }) : undefined} />
        <Kpi value={projects?.active !== undefined ? String(projects.active) : '—'} label={t('kpiActiveProjects')} foot={projects !== null ? t('kpiProjectsFoot', { total: projects.total, excluded: projects.excluded }) : undefined} />
      </div>

      {savings !== null ? (
        <div style={styles.section}>
          <h4 style={styles.sectionTitle}>{t('savingsTitle')}</h4>
          <span style={{ fontSize: 12.5 }}>
            {t('savingsLine', { events: savings.events, read: compact(savings.readTokens), saved: compact(savings.savedTokens), percent: savings.percent })}
          </span>
          <span style={styles.muted}>{t('savingsFoot')}</span>
        </div>
      ) : null}

      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>{t('recentTitle')}</h4>
        {(data.recent ?? []).map((item, index) => (
          <div key={index} style={index === 0 ? { ...styles.row, borderTop: 'none' } : styles.row}>
            <span style={styles.tag}>{item.type}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={styles.rowTitle}>{item.title}</span>
              <span style={styles.rowMeta}>{item.project} · {relative(Date.parse(item.createdAt), t)}</span>
            </span>
          </div>
        ))}
        {data.recent === null ? <span style={styles.muted}>{t('overviewUnavailable')}</span> : null}
      </div>

      <div style={styles.links}>
        <a style={styles.link} onClick={() => window.open('http://127.0.0.1:' + (worker?.port ?? 37777), '_blank', 'noopener')}>{t('openViewer')}</a>
        <a style={styles.link} onClick={() => window.open('https://github.com/liuhuoz/dsh-claude-mem', '_blank', 'noopener')}>GitHub</a>
      </div>
    </>
  )
}

/** The distribution tab: daily columns, twelve weeks of activity, composition and ranking. */
function TrendTab({ t }: { t: Translate }): JSX.Element {
  const [data, setData] = useState<Overview | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch(OVERVIEW_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json() as Overview
        if (alive) setData(payload)
      } catch {
        /* the overview tab reports failures; this tab stays empty */
      }
    })()
    return () => { alive = false }
  }, [])

  if (data === undefined) return <span style={styles.muted}>{t('overviewLoading')}</span>
  const distributions = data.distributions
  if (distributions === null) return <div style={styles.section}><span style={styles.muted}>{t('overviewUnavailable')}</span></div>

  const days = lastDays(14)
  const typeKeys = distributions.types.map((entry) => entry.key)
  const projectKeys = distributions.projects.map((entry) => entry.key)

  return (
    <>
      <div style={styles.charts}>
        <div style={styles.section}>
          <StackedBars days={days} buckets={distributions.days} dimension="type" keys={typeKeys} t={t} />
        </div>
        <div style={styles.section}>
          <StackedBars days={days} buckets={distributions.days} dimension="project" keys={projectKeys} t={t} />
        </div>
      </div>
      <div style={styles.section}>
        <Heatmap buckets={distributions.days} total={distributions.total} t={t} />
      </div>
      <div style={styles.charts}>
        <div style={styles.section}>
          <CompositionRing entries={distributions.types} title={t('compositionType')} t={t} colorOf={(key) => typeColor(key)} />
        </div>
        <div style={styles.section}>
          <CompositionRing entries={distributions.projects} title={t('compositionProject')} t={t} colorOf={(key, index) => projectColor(key, index)} />
        </div>
      </div>
      <div style={styles.section}>
        <ProjectRanking projects={distributions.projects} excluded={data.projects?.excluded ?? 0} t={t} />
      </div>
    </>
  )
}

/** The sessions tab: latest injection plus the sessions that produced summaries. */
function SessionsTab({ t }: { t: Translate }): JSX.Element {
  const [data, setData] = useState<Overview | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recent' | 'items'>('recent')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch(OVERVIEW_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json() as Overview
        if (alive) setData(payload)
      } catch {
        /* the overview tab reports failures; this tab stays empty */
      }
    })()
    return () => { alive = false }
  }, [])

  const sessions = useMemo(() => {
    const list = (data?.sessions ?? []).filter((item) => query.trim().length === 0 || item.title.toLowerCase().includes(query.trim().toLowerCase()))
    return sort === 'items' ? list.slice().sort((a, b) => b.itemCount - a.itemCount) : list.slice().sort((a, b) => b.startedAt - a.startedAt)
  }, [data, query, sort])

  return (
    <>
      {data?.injection !== null && data?.injection !== undefined ? (
        <div style={styles.section}>
          <h4 style={styles.sectionTitle}>{t('injectionTitle', { project: data.injection.project })}</h4>
          <span style={{ fontSize: 12.5 }}>{t('injectionSize', { chars: data.injection.chars.toLocaleString(), lines: data.injection.lines })}</span>
          <span style={styles.mono}>{data.injection.head}</span>
        </div>
      ) : null}

      <div style={styles.toolbar}>
        <button type="button" onClick={() => setSort('recent')} style={sort === 'recent' ? { ...styles.tab, ...styles.tabOn } : styles.tab}>{t('sortRecent')}</button>
        <button type="button" onClick={() => setSort('items')} style={sort === 'items' ? { ...styles.tab, ...styles.tabOn } : styles.tab}>{t('sortItems')}</button>
        <span style={{ flex: 1 }} />
        <Input value={query} placeholder={t('searchPlaceholder')} onChange={(event) => setQuery(event.target.value)} />
      </div>

      {sessions.map((item, index) => (
        <div key={index} style={styles.section}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <span style={styles.rowTitle}>{item.title}</span>
            <span style={styles.kpiLabel}>{t('sessionItems', { count: item.itemCount })}</span>
          </span>
          <span style={styles.rowMeta}>{item.project} · {t('sessionStarted', { when: relative(item.startedAt, t) })}</span>
        </div>
      ))}
      {data !== undefined && sessions.length === 0 ? <span style={styles.muted}>{t('sessionsEmpty')}</span> : null}
    </>
  )
}

/** The panel: tab strip plus the selected page. */
export function ClaudeMemTabs({ t, form }: { t: Translate; form?: ConfigPageForm | undefined }): JSX.Element {
  const [tab, setTab] = useState<TabKey>('overview')
  return (
    <div style={styles.root}>
      <nav style={styles.tabs}>
        {TABS.map((entry) => (
          <button key={entry.key} type="button" onClick={() => setTab(entry.key)} style={entry.key === tab ? { ...styles.tab, ...styles.tabOn } : styles.tab}>
            {entry.label(t)}
          </button>
        ))}
      </nav>
      <div style={{ minHeight: 0 }}>
        {tab === 'overview' ? <OverviewTab t={t} /> : null}
        {tab === 'trend' ? <TrendTab t={t} /> : null}
        {tab === 'sessions' ? <SessionsTab t={t} /> : null}
        {tab === 'settings' ? <ClaudeMemPage t={t} view="page" form={form} /> : null}
      </div>
    </div>
  )
}
