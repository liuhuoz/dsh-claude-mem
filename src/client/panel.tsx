/**
 * Panel shell: four tabs over one page, with the data pages reading the host's
 * aggregated overview route.
 *
 * The settings tab is the configuration page itself, unchanged; the other tabs
 * are read-only. Nothing here calls the worker directly — the page origin is
 * refused by claude-mem, so every number arrives through the host bridge.
 * @module dsh-claude-mem/client/panel
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, DisclosureRow, Input, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Overview } from '../overview-types.js'
import { ClaudeMemIcon } from './icon.js'
import { ClaudeMemPage } from './page.js'
import { Heatmap } from './heatmap.js'
import { CompositionRing, NEUTRAL_COLOR, ProjectRanking, StackedBars, crossTotals, lastDays, projectColor, typeColor, windowTotals } from './breakdown.js'
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

/** Page gutter: 16px at the narrowest, 48px on a wide frame, then a 960px reading column. */
const PAGE_GUTTER = 'max(clamp(16px, 4vw, 48px), calc((100% - 960px) / 2))' as const

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, minWidth: 0 } as const,
  head: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    boxSizing: 'border-box',
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: PAGE_GUTTER,
    paddingRight: PAGE_GUTTER,
  } as const,
  headTop: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', minWidth: 0 } as const,
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } as const,
  title: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px', whiteSpace: 'nowrap' } as const,
  sub: { margin: 0, flex: 'auto', minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } as const,
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    boxSizing: 'border-box',
    overflowY: 'auto',
    paddingTop: 8,
    paddingBottom: 48,
    paddingLeft: PAGE_GUTTER,
    paddingRight: PAGE_GUTTER,
  } as const,
  tabs: {
    paddingLeft: PAGE_GUTTER,
    paddingRight: PAGE_GUTTER,
    boxSizing: 'border-box',
  } as const,
  /** The rule rides the content column, so it stops at the same edges as the body. */
  tabStrip: {
    display: 'flex',
    gap: 4,
    paddingBottom: 6,
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  } as const,
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
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 } as const,
  charts: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } as const,
  split: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, alignItems: 'stretch' } as const,
  card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 2 } as const,
  kpiValue: { fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' } as const,
  kpiLabel: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } as const,
  kpiFoot: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
  section: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 10 } as const,
  sectionTitle: { margin: 0, fontSize: 11.5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)' } as const,
  // One grid for the whole recent list, so the tag column is as wide as the
  // longest label and every title and project dot starts on the same edge.
  recentList: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 8 } as const,
  recentTagCell: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } as const,
  recentTextCell: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } as const,
  rowFirst: { borderTop: 'none' } as const,
  // Reserve the slot a three-digit count needs, so the counts share one column
  // and every session title truncates at the same edge, in any language.
  sessionCount: { display: 'inline-grid', flex: 'none' } as const,
  sessionCountGhost: { gridArea: '1 / 1', visibility: 'hidden' } as const,
  sessionCountValue: { gridArea: '1 / 1', justifySelf: 'end' } as const,
  rowTitle: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  rowMeta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } as const,
  tag: { flex: 'none', fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)' } as const,
  projectTag: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%', verticalAlign: 'middle' } as const,
  projectDot: { width: 6, height: 6, borderRadius: '50%', flex: 'none', display: 'block' } as const,
  projectName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  /** The viewer and repository links ride the tab strip, right-aligned. */
  links: { display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto', fontSize: 12 } as const,
  link: { color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none', borderBottom: '1px dashed currentColor', cursor: 'pointer' } as const,
  muted: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } as const,
  injectionHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } as const,
  eyebrow: { fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary)' } as const,
  injectionHeadline: { margin: 0, fontSize: 13.5, lineHeight: 1.45, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  fieldBlock: { display: 'flex', flexDirection: 'column', gap: 4 } as const,
  fieldLabel: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } as const,
  fieldBody: { paddingLeft: 18, color: 'var(--dsw-alias-label-primary)', fontSize: 12 } as const,
  allSections: { display: 'flex', flexDirection: 'column', gap: 14 } as const,

  injectionBody: { maxHeight: 200, overflowY: 'auto', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 } as const,
  injectionActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 } as const,


  detail: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '2px 18px', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } as const,
  detailRow: { display: 'flex', gap: 8, justifyContent: 'space-between', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 2 } as const,
  detailCount: { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } as const,
} as const

/**
 * A pill in one of the charts' colours: the fill, the edge and the text all
 * lean on the same hue, so a tag here and its bar or arc on the distribution
 * tab read as one thing. The text mixes against the theme's primary label and
 * the fill against `transparent`, so one set of hex colours works in both
 * themes.
 *
 * The 45% text share is what keeps every palette colour at or above 4.5:1 on
 * both a white and a dark card — `change` (the yellow) is the binding case,
 * and at 55% it drops to 3.7:1 on white.
 * @param color - the palette colour this pill stands for.
 * @param extra - layout overrides on top of the base pill.
 * @returns the pill style.
 */
function pillStyle(color: string, extra?: CSSProperties): CSSProperties {
  return {
    ...styles.tag,
    color: `color-mix(in srgb, ${color} 45%, var(--dsw-alias-label-primary))`,
    background: `color-mix(in srgb, ${color} 20%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
    ...extra,
  }
}

/**
 * The observation-type pill: the type's own colour, so a tag in the recent
 * list matches that type's bar, arc and legend entry. An unknown type keeps
 * the charts' neutral tone.
 * @param type - the observation type, as the overview payload reports it.
 * @returns the pill style for that type.
 */
function tagStyle(type: string): CSSProperties {
  return pillStyle(typeColor(type))
}

/**
 * A project name carrying the colour the distribution tab gives that project,
 * as a dot rather than a pill. The filled pill is the type badge's shape, and
 * both palettes use the same six hues: on a metadata line a filled project
 * chip competed with the title and read as a second category of equal weight.
 * The dot keeps the colour — the match with that project's bar and ring
 * segment — while shape, size and position keep it metadata.
 *
 * A project the charts do not rank (no distribution payload, or one the worker
 * excluded) keeps the neutral tone instead of borrowing a neighbour's hue.
 * @param project - the project key, as the overview payload reports it.
 * @param rank - that project's index in the ranked list, when it has one.
 * @returns the dot and the name.
 */
function ProjectTag({ project, rank }: { project: string; rank: number | undefined }): JSX.Element {
  return (
    <span style={styles.projectTag}>
      <i style={{ ...styles.projectDot, background: rank === undefined ? NEUTRAL_COLOR : projectColor(project, rank) }} />
      <span style={styles.projectName}>{project}</span>
    </span>
  )
}

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
  // Project dots borrow the rank colours the distribution tab gives each
  // project; a project it does not rank keeps the neutral tone.
  const projectRanks = new Map<string, number>()
  for (const [index, entry] of (data.distributions?.projects ?? []).entries()) projectRanks.set(entry.key, index)

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
          <span style={styles.muted}>{t('savingsFoot', { day: savings.day })}</span>
        </div>
      ) : null}

      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>{t('recentTitle')}</h4>
        <div style={styles.recentList}>
          {(data.recent ?? []).map((item, index) => (
            <Fragment key={index}>
              <span style={{ ...styles.recentTagCell, ...(index === 0 ? styles.rowFirst : {}) }}>
                <span style={{ ...tagStyle(item.type), boxSizing: 'border-box', width: '100%', textAlign: 'center' }}>{item.type}</span>
              </span>
              <span style={{ ...styles.recentTextCell, ...(index === 0 ? styles.rowFirst : {}) }}>
                <span style={styles.rowTitle}>{item.title}</span>
                <span style={styles.rowMeta}><ProjectTag project={item.project} rank={projectRanks.get(item.project)} /> · {relative(Date.parse(item.createdAt), t)}</span>
              </span>
            </Fragment>
          ))}
        </div>
        {data.recent === null ? <span style={styles.muted}>{t('overviewUnavailable')}</span> : null}
      </div>

    </>
  )
}

/** Days the range switch offers; the heatmap keeps its own twelve weeks. */
const RANGES = [7, 14, 30] as const

/** One selected slice of the tab: a day, or a type/project inside its dimension. */
interface TrendPick {
  readonly kind: 'day' | 'type' | 'project'
  readonly key: string
}

/**
 * The distribution tab: daily columns, twelve weeks of activity, composition and
 * ranking over the days the range switch admits. A click narrows the tab to one
 * day (the heatmap) or one type/project (the bars, the rings, the ranking), and
 * clicking the same slice again releases it.
 */
function TrendTab({ t }: { t: Translate }): JSX.Element {
  const [data, setData] = useState<Overview | undefined>(undefined)
  const [range, setRange] = useState<number>(14)
  const [pick, setPick] = useState<TrendPick | null>(null)

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

  const days = lastDays(range)
  const window = windowTotals(distributions.days, days)
  const pickedKind = pick?.kind === 'type' || pick?.kind === 'project' ? pick.kind : null
  // `cells` is new on this bridge, so a client reloaded against an older host still renders.
  const cross = pickedKind === null || pick === null ? null : crossTotals(distributions.cells ?? [], days, pickedKind, pick.key)
  const typeEntries = pick?.kind === 'project' ? (cross?.types ?? window.types) : window.types
  const projectEntries = pick?.kind === 'type' ? (cross?.projects ?? window.projects) : window.projects
  const forKind = (kind: TrendPick['kind']): string | null => (pick !== null && pick.kind === kind ? pick.key : null)
  const toggle = (next: TrendPick): void => {
    setPick(current => (current !== null && current.kind === next.kind && current.key === next.key ? null : next))
  }
  const pickedCount = pick === null || pick.kind === 'day'
    ? 0
    : (pick.kind === 'type' ? window.types : window.projects).find((entry) => entry.key === pick.key)?.count ?? 0
  const pickedPercent = window.total > 0 ? Math.round((pickedCount / window.total) * 100) : 0
  const dayBucket = pick !== null && pick.kind === 'day'
    ? distributions.days.find((bucket) => bucket.day === pick.key)
    : undefined

  return (
    <>
      <div style={styles.toolbar}>
        {RANGES.map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => setRange(count)}
            style={count === range ? { ...styles.tab, ...styles.tabOn } : styles.tab}
          >
            {t('rangeDays', { days: count })}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {pick !== null ? (
          <Button size="sm" variant="outline" onClick={() => setPick(null)}>{t('clearSelection')}</Button>
        ) : null}
      </div>

      {pick !== null ? (
        <div style={styles.section}>
          <span style={{ ...styles.rowTitle, fontSize: 12.5 }}>
            {pick.key}
            {' · '}
            {t('tipTotal', { count: pick.kind === 'day' ? dayBucket?.total ?? 0 : pickedCount })}
            {pick.kind === 'day' ? '' : ' · ' + t('pickedShare', { percent: pickedPercent })}
          </span>
          {dayBucket !== undefined ? (
            <div style={styles.detail}>
              {Object.entries(dayBucket.byType).sort((a, b) => b[1] - a[1]).map(([key, count]) => (
                <span key={'type-' + key} style={styles.detailRow}>
                  <span>{key}</span>
                  <span style={styles.detailCount}>{count}</span>
                </span>
              ))}
              {Object.entries(dayBucket.byProject).sort((a, b) => b[1] - a[1]).map(([key, count]) => (
                <span key={'project-' + key} style={styles.detailRow}>
                  <span>{key}</span>
                  <span style={styles.detailCount}>{count}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={styles.charts}>
        <div style={styles.section}>
          <StackedBars
            days={days}
            buckets={distributions.days}
            dimension="type"
            keys={typeEntries.map((entry) => entry.key)}
            t={t}
            selectedKey={forKind('type')}
            onPickKey={(key) => toggle({ kind: 'type', key })}
          />
        </div>
        <div style={styles.section}>
          <StackedBars
            days={days}
            buckets={distributions.days}
            dimension="project"
            keys={projectEntries.map((entry) => entry.key)}
            t={t}
            selectedKey={forKind('project')}
            onPickKey={(key) => toggle({ kind: 'project', key })}
          />
        </div>
      </div>

      <div style={styles.split}>
        <div style={{ ...styles.section, justifyContent: 'center' }}>
          <Heatmap
            buckets={distributions.days}
            total={distributions.total}
            t={t}
            selected={forKind('day')}
            onSelect={(day) => { if (day === null) setPick(null); else toggle({ kind: 'day', key: day }) }}
          />
        </div>
        <div style={{ ...styles.section, justifyContent: 'center' }}>
          <h4 style={styles.sectionTitle}>{t('compositionTitle')}</h4>
          <CompositionRing
            entries={typeEntries}
            caption={t('byType')}
            t={t}
            colorOf={(key) => typeColor(key)}
            selectedKey={forKind('type')}
            onPickKey={(key) => toggle({ kind: 'type', key })}
          />
          <CompositionRing
            entries={projectEntries}
            caption={t('byProject')}
            t={t}
            colorOf={(key, index) => projectColor(key, index)}
            selectedKey={forKind('project')}
            onPickKey={(key) => toggle({ kind: 'project', key })}
          />
        </div>
      </div>

      <div style={styles.section}>
        <ProjectRanking
          projects={projectEntries}
          excluded={data.projects?.excluded ?? 0}
          t={t}
          selectedKey={forKind('project')}
          onPickKey={(key) => toggle({ kind: 'project', key })}
        />
      </div>
    </>
  )
}

/** Localized names for the field labels claude-mem's block writes. */
const FIELD_COPY: Readonly<Record<string, 'fieldRequest' | 'fieldCompleted' | 'fieldLearned' | 'fieldNextSteps' | 'fieldNotes'>> = {
  request: 'fieldRequest',
  completed: 'fieldCompleted',
  learned: 'fieldLearned',
  'next steps': 'fieldNextSteps',
  notes: 'fieldNotes',
}

/**
 * A field's mark, so a row reads like the viewer's sections: a message for the
 * request, a check for what was done, a bulb for what was learned, an arrow for
 * what follows.
 * @param props.label - the field's raw label.
 * @returns a 13px outline glyph.
 */
function FieldGlyph({ label }: { readonly label: string }): JSX.Element {
  const key = label.toLowerCase()
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      {key === 'completed' ? <path d="M20 6 9 17l-5-5" />
        : key === 'learned' ? <><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" /></>
          : key === 'next steps' ? <path d="M4 12h13M13 6l6 6-6 6" />
            : key === 'notes' ? <><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></>
              : <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />}
    </svg>
  )
}

/** The sessions tab: latest injection plus the sessions that produced summaries. */
function SessionsTab({ t }: { t: Translate }): JSX.Element {
  const [data, setData] = useState<Overview | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'recent' | 'items'>('recent')
  const [bySection, setBySection] = useState(false)
  const [field, setField] = useState<string | null>(null)
  // A fresh bucket per render would discard the markdown render cache.
  const markdownLabels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t])
  // The block's shape is new on this bridge: a client reloaded against an older
  // host still renders, with no preview and no per-summary rows.
  const injection = data?.injection ?? null
  const injectionText = injection?.text ?? ''
  const injectionSections = (injection?.sections ?? []).map((section) => ({ ...section, fields: section.fields ?? [] }))
  const newest = injectionSections[0]
  const activeField = newest === undefined
    ? undefined
    : (newest.fields.find((item) => item.label === field)
      ?? newest.fields.find((item) => /^next steps$/i.test(item.label))
      ?? newest.fields[newest.fields.length - 1])
  const fieldLabel = (label: string): string => {
    const key = FIELD_COPY[label.toLowerCase()]
    return key === undefined ? label : t(key)
  }

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

  // Project chips borrow the rank colours the distribution tab hands each
  // project, so a session's chip matches that project's bar and ring segment.
  const projectRank = useMemo(() => {
    const ranks = new Map<string, number>()
    for (const [index, entry] of (data?.distributions?.projects ?? []).entries()) ranks.set(entry.key, index)
    return ranks
  }, [data])

  return (
    <>
      {injection !== null ? (
        <div style={styles.section}>
          <div style={styles.injectionHead}>
            <span style={styles.eyebrow}>{t('injectionEyebrow')}</span>
            <span style={styles.rowMeta}>{injection.project}</span>
            <span style={{ flex: 1 }} />
            <span style={styles.rowMeta}>
              {newest !== undefined && newest.date.length > 0 ? newest.date : relative(injection.at, t)}
            </span>
          </div>
          {newest !== undefined ? (
            <>
              <h3 style={styles.injectionHeadline}>{newest.request.length > 0 ? newest.request : newest.prompt}</h3>
              {activeField !== undefined ? (
                <div style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>
                    <FieldGlyph label={activeField.label} />
                    {fieldLabel(activeField.label)}
                  </span>
                  <div style={styles.fieldBody}>
                    <MarkdownText text={activeField.value} variant="compact" labels={markdownLabels} />
                  </div>
                </div>
              ) : null}
              {newest.fields.length > 0 ? (
                <div style={styles.injectionActions}>
                  {newest.fields.map((item) => (
                    <Button
                      key={item.label}
                      size="sm"
                      variant="outline"
                      onClick={() => setField(item.label)}
                      style={item.label === activeField?.label ? { fontWeight: 600 } : undefined}
                    >
                      {fieldLabel(item.label)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div style={styles.injectionBody}>
              <MarkdownText text={injectionText} variant="compact" labels={markdownLabels} />
            </div>
          )}
          {newest !== undefined && newest.fields.length > 1 ? (
            <DisclosureRow
              icon={null}
              title={t('injectionAllFields')}
              open={bySection}
              expandable
              onToggle={() => setBySection((current) => !current)}
            >
              <div style={styles.allSections}>
                {newest.fields.map((item) => (
                  <div key={item.label} style={styles.fieldBlock}>
                    <span style={styles.fieldLabel}>
                      <FieldGlyph label={item.label} />
                      {fieldLabel(item.label)}
                    </span>
                    <div style={styles.fieldBody}>
                      <MarkdownText text={item.value} variant="compact" labels={markdownLabels} />
                    </div>
                  </div>
                ))}
              </div>
            </DisclosureRow>
          ) : null}
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
            <span style={{ ...styles.kpiLabel, ...styles.sessionCount }}>
              <span aria-hidden="true" style={styles.sessionCountGhost}>{t('sessionItems', { count: 999 })}</span>
              <span style={styles.sessionCountValue}>{t('sessionItems', { count: item.itemCount })}</span>
            </span>
          </span>
          <span style={styles.rowMeta}><ProjectTag project={item.project} rank={projectRank.get(item.project)} /> · {t('sessionStarted', { when: relative(item.startedAt, t) })}</span>
        </div>
      ))}
      {data !== undefined && sessions.length === 0 ? <span style={styles.muted}>{t('sessionsEmpty')}</span> : null}
    </>
  )
}

/** The panel: tab strip plus the selected page. */
export function ClaudeMemTabs({ t, form }: { t: Translate; form?: ConfigPageForm | undefined }): JSX.Element {
  const [tab, setTab] = useState<TabKey>('overview')
  // The viewer link lives in the tab strip now, so the shell owns the one number
  // it needs: the port the worker published.
  const [viewerPort, setViewerPort] = useState<number | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch(OVERVIEW_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return
        const payload = await response.json() as Overview
        if (alive) setViewerPort(payload.worker?.port)
      } catch {
        /* the overview tab reports failures; the link keeps its default port */
      }
    })()
    return () => { alive = false }
  }, [])
  return (
    <div style={styles.root}>
      <header style={styles.head}>
        <div style={styles.headTop}>
          <div style={styles.titleRow}>
            <ClaudeMemIcon size={18} />
            <h2 style={styles.title}>{t('panelTitle')}</h2>
            <p style={styles.sub}>{t('panelSubtitle')}</p>
          </div>
        </div>
      </header>
      <nav style={styles.tabs}>
        <div style={styles.tabStrip}>
          {TABS.map((entry) => (
            <button key={entry.key} type="button" onClick={() => setTab(entry.key)} style={entry.key === tab ? { ...styles.tab, ...styles.tabOn } : styles.tab}>
              {entry.label(t)}
            </button>
          ))}
          <span style={styles.links}>
            <a style={styles.link} onClick={() => window.open('http://127.0.0.1:' + (viewerPort ?? 37777), '_blank', 'noopener')}>{t('openViewer')}</a>
            <a style={styles.link} onClick={() => window.open('https://github.com/liuhuoz/dsh-claude-mem', '_blank', 'noopener')}>GitHub</a>
          </span>
        </div>
      </nav>
      <div style={styles.body}>
        {tab === 'overview' ? <OverviewTab t={t} /> : null}
        {tab === 'trend' ? <TrendTab t={t} /> : null}
        {tab === 'sessions' ? <SessionsTab t={t} /> : null}
        {tab === 'settings' ? <ClaudeMemPage t={t} view="page" form={form} /> : null}
      </div>
    </div>
  )
}
