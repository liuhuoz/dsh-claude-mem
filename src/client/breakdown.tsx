/**
 * Composition widgets for the distribution tab: stacked daily bars by type or
 * project, two composition rings and the project ranking.
 *
 * The helpers are pure and exported so the bucket maths stays testable without
 * a renderer; the components only lay the numbers out.
 * @module dsh-claude-mem/client/breakdown
 */

import { useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayBucket, DistributionCell, Distributions } from '../overview-types.js'
import type { Translate } from './messages.js'

/** A keyed count, as produced by the overview payload. */
export interface KeyedCount {
  readonly key: string
  readonly count: number
}

/** Colour per observation type; unknown types fall back to the neutral tone. */
export const TYPE_COLORS: Readonly<Record<string, string>> = {
  discovery: '#5e9eff',
  feature: '#3ecf8e',
  bugfix: '#e8833a',
  refactor: '#a78bfa',
  change: '#f2c94c',
  decision: '#ef7fa8',
}

/** Palette assigned to projects by rank. */
export const PROJECT_COLORS = ['#5e9eff', '#3ecf8e', '#e8833a', '#a78bfa', '#f2c94c', '#ef7fa8', '#4fd1c5', '#9aa1ad'] as const

/** The tone for anything the palette has no colour of its own for. */
export const NEUTRAL_COLOR = '#7c8698'

/** The synthetic bucket that absorbs everything past the head of the list. */
export const OTHER_KEY = 'other'

/**
 * Keep the head of a ranked list and fold the tail into one bucket.
 * @param entries - ranked counts, largest first.
 * @param limit - how many named buckets to keep.
 * @returns the head plus a trailing aggregate, or the input when it fits.
 */
export function topKeys(entries: readonly KeyedCount[], limit: number): KeyedCount[] {
  if (entries.length <= limit) return [...entries]
  const head = entries.slice(0, limit)
  const tail = entries.slice(limit).reduce((sum, entry) => sum + entry.count, 0)
  return tail > 0 ? [...head, { key: OTHER_KEY, count: tail }] : head
}

/**
 * Split one day into segment ratios for the stacked bars.
 * @param bucket - the day, or undefined for a day with no activity.
 * @param dimension - which split to read.
 * @param keys - the keys to draw, in order; anything else folds into other.
 * @returns ratios that sum to 1 (or an empty list for an empty day).
 */
export function stackRatios(
  bucket: DayBucket | undefined,
  dimension: 'type' | 'project',
  keys: readonly string[],
): { key: string; ratio: number }[] {
  if (bucket === undefined) return []
  const source = dimension === 'type' ? bucket.byType : bucket.byProject
  const total = Object.values(source).reduce((sum, count) => sum + count, 0)
  if (total === 0) return []
  const segments: { key: string; ratio: number }[] = []
  let consumed = 0
  for (const key of keys) {
    const count = source[key] ?? 0
    if (count === 0) continue
    segments.push({ key, ratio: count / total })
    consumed += count
  }
  if (consumed < total) segments.push({ key: OTHER_KEY, ratio: (total - consumed) / total })
  return segments
}

/**
 * Height of a day column against the busiest day.
 * @param bucket - the day, or undefined.
 * @param max - the window's busiest total.
 * @returns a 0-100 percentage.
 */
export function barHeight(bucket: DayBucket | undefined, max: number): number {
  if (bucket === undefined || max <= 0) return 0
  return Math.round((bucket.total / max) * 100)
}

/**
 * The three-value scale the stacked bars are drawn against.
 *
 * A window whose busiest day is ten or fewer uses the fixed 0/5/10 scale. Above
 * that the top rounds up to the next multiple of twenty, so the top, its half and
 * the printed labels all stay round numbers.
 * @param peak - the busiest single-day total in the window.
 * @returns the top of the scale and its midpoint.
 */
export function axisScale(peak: number): { max: number; half: number } {
  if (peak <= 10) return { max: 10, half: 5 }
  const max = Math.ceil(peak / 20) * 20
  return { max, half: max / 2 }
}

/**
 * Which day columns carry a date label.
 *
 * A week gets its two ends and the middle day, a fortnight gets two middle days,
 * and longer windows step about five days so the axis never reads as empty.
 * @param length - how many day columns the chart draws.
 * @returns column indexes, ascending, including both ends.
 */
export function tickIndexes(length: number): number[] {
  if (length <= 1) return [0]
  const step = length <= 7 ? 3 : length <= 14 ? 4 : 5
  const segments = Math.max(1, Math.round((length - 1) / step))
  const indexes = new Set<number>()
  for (let segment = 0; segment <= segments; segment += 1) {
    indexes.add(Math.round((segment * (length - 1)) / segments))
  }
  return [...indexes].sort((a, b) => a - b)
}

/** Edge length of a composition ring, in CSS pixels. */
export const DONUT_SIZE = 74

/** Stroke width of that ring. */
export const DONUT_THICKNESS = 11

/** One stroked arc of a composition ring, as dash geometry. */
export interface DonutArc {
  readonly key: string
  readonly color: string
  readonly dash: string
  readonly offset: number
}

/**
 * Turn ranked counts into the stroked arcs of a composition ring.
 *
 * Each arc is a whole circle whose dash pattern covers its own share, which
 * keeps a lone 100% segment a complete ring instead of a degenerate path.
 * @param entries - ranked counts.
 * @param colorOf - colour per key.
 * @param size - ring edge length in pixels.
 * @param thickness - stroke width in pixels.
 * @returns one arc per entry, clockwise from twelve o'clock.
 */
export function donutArcs(
  entries: readonly KeyedCount[],
  colorOf: (key: string, index: number) => string,
  size: number = DONUT_SIZE,
  thickness: number = DONUT_THICKNESS,
): DonutArc[] {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  if (total <= 0) return []
  const circumference = Math.PI * (size - thickness)
  let cursor = 0
  return entries.map((entry, index) => {
    const length = (entry.count / total) * circumference
    const arc = {
      key: entry.key,
      color: colorOf(entry.key, index),
      dash: length.toFixed(2) + ' ' + Math.max(0, circumference - length).toFixed(2),
      offset: -Number(cursor.toFixed(2)),
    }
    cursor += length
    return arc
  })
}

/**
 * The last `count` day keys ending today, oldest first.
 * @param count - how many days to produce.
 * @param end - the day the window ends on.
 * @returns UTC day keys, matching how the worker stores created_at.
 */
export function lastDays(count: number, end: Date = new Date()): string[] {
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  const days: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) days.push(new Date(endDay - offset * 86_400_000).toISOString().slice(0, 10))
  return days
}

/** Colour for a type key. */
export function typeColor(key: string): string {
  return TYPE_COLORS[key] ?? NEUTRAL_COLOR
}

/** Colour for a project key by its rank. */
export function projectColor(key: string, index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length]
}

/**
 * Aggregate the days a window covers: total, per-type counts and per-project
 * counts that keep the last day inside the window each project wrote on.
 * @param buckets - every daily bucket the payload carries.
 * @param days - the day keys the window covers, oldest first.
 * @returns window totals, largest first.
 */
export function windowTotals(
  buckets: readonly DayBucket[],
  days: readonly string[],
): { total: number; types: KeyedCount[]; projects: { key: string; count: number; lastWrite: string }[] } {
  const wanted = new Set(days)
  const types = new Map<string, number>()
  const projects = new Map<string, { count: number; lastWrite: string }>()
  let total = 0
  for (const bucket of buckets) {
    if (!wanted.has(bucket.day)) continue
    total += bucket.total
    for (const [key, count] of Object.entries(bucket.byType)) types.set(key, (types.get(key) ?? 0) + count)
    for (const [key, count] of Object.entries(bucket.byProject)) {
      const seen = projects.get(key)
      projects.set(key, {
        count: (seen?.count ?? 0) + count,
        lastWrite: bucket.day > (seen?.lastWrite ?? '') ? bucket.day : (seen?.lastWrite ?? ''),
      })
    }
  }
  const byCount = (a: { count: number }, b: { count: number }): number => b.count - a.count
  return {
    total,
    types: [...types].map(([key, count]) => ({ key, count })).sort(byCount),
    projects: [...projects].map(([key, value]) => ({ key, count: value.count, lastWrite: value.lastWrite })).sort(byCount),
  }
}

/**
 * Totals for the window restricted to one key of `kind`, so a pick in one
 * dimension can narrow the other one.
 * @param cells - day × type × project cells from the payload.
 * @param days - the day keys the window covers.
 * @param kind - the dimension the picked key belongs to.
 * @param key - the picked type or project.
 * @returns the surviving types and projects, largest first.
 */
export function crossTotals(
  cells: readonly DistributionCell[],
  days: readonly string[],
  kind: 'type' | 'project',
  key: string,
): { types: KeyedCount[]; projects: { key: string; count: number; lastWrite: string }[] } {
  const wanted = new Set(days)
  const types = new Map<string, number>()
  const projects = new Map<string, { count: number; lastWrite: string }>()
  for (const cell of cells) {
    if (!wanted.has(cell.day)) continue
    if ((kind === 'type' ? cell.type : cell.project) !== key) continue
    types.set(cell.type, (types.get(cell.type) ?? 0) + cell.count)
    const seen = projects.get(cell.project)
    projects.set(cell.project, {
      count: (seen?.count ?? 0) + cell.count,
      lastWrite: cell.day > (seen?.lastWrite ?? '') ? cell.day : (seen?.lastWrite ?? ''),
    })
  }
  const byCount = (a: { count: number }, b: { count: number }): number => b.count - a.count
  return {
    types: [...types].map(([type, count]) => ({ key: type, count })).sort(byCount),
    projects: [...projects].map(([project, value]) => ({ key: project, count: value.count, lastWrite: value.lastWrite })).sort(byCount),
  }
}

/** Hover text for one column: the day, its total, then its busiest splits. */
function dayTip(day: string, bucket: DayBucket | undefined, dimension: 'type' | 'project', t: Translate): string {
  const source = bucket === undefined ? {} : dimension === 'type' ? bucket.byType : bucket.byProject
  const lines = [day, t('tipTotal', { count: bucket?.total ?? 0 })]
  const head = Object.entries(source).sort((a, b) => b[1] - a[1]).slice(0, 3)
  for (const [key, count] of head) lines.push((key === OTHER_KEY ? t('otherKey') : key) + ' ' + count)
  return lines.join('\n')
}

/** A block dims when a pick or a hover points at a different one. */
function isDimmed(key: string, selectedKey: string | null, hoverKey: string | null): boolean {
  return (selectedKey !== null && selectedKey !== key) || (hoverKey !== null && hoverKey !== key)
}

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as const,
  title: { margin: 0, fontSize: 11.5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)' } as const,
  plot: { display: 'flex', gap: 6 } as const,
  /** Value labels sit in this gutter, on the same 96px band as the columns. */
  scale: { position: 'relative', width: 16, height: 96, flex: 'none', fontSize: 9.5, lineHeight: '10px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } as const,
  scaleTick: { position: 'absolute', right: 0, transform: 'translateY(-50%)' } as const,
  plotArea: { position: 'relative', flex: 1, minWidth: 0, height: 96 } as const,
  /** Weak dashed guides; they read behind the blocks, never over them. */
  guide: { position: 'absolute', left: 0, right: 0, zIndex: 0, borderTop: '1px dashed var(--dsw-alias-border-l1)', pointerEvents: 'none' } as const,
  /** Lifted above the guides so a full-height column still owns its top edge. */
  bars: { display: 'flex', alignItems: 'flex-end', gap: 4, height: '100%', position: 'relative', zIndex: 1 } as const,
  bar: { flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' } as const,
  stack: { width: '100%', display: 'flex', flexDirection: 'column-reverse', borderRadius: 3, overflow: 'hidden', background: 'var(--dsw-alias-interactive-bg-hover)' } as const,
  /** Same flex and gap as the columns, so each label centres on its own bar. */
  axis: { display: 'flex', gap: 4, paddingLeft: 22, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } as const,
  axisTick: { flex: 1, minWidth: 0, position: 'relative' } as const,
  axisLabel: { position: 'absolute', top: 2, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' } as const,
  /** Anchored by its end at the column centre, so it reads up-right without covering the bars. */
  axisLabelSlanted: { position: 'absolute', top: 2, right: '50%', transformOrigin: 'top right', transform: 'rotate(-45deg)', whiteSpace: 'nowrap' } as const,
  legend: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } as const,
  legendTitle: { flexBasis: '100%', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } as const,
  swatch: { width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 5 } as const,
  ring: { width: DONUT_SIZE, height: DONUT_SIZE, position: 'relative', flex: 'none' } as const,
  // The label spans the ring to centre its number; it must not eat the pointer
  // events the arcs underneath need for their bubbles and picks.
  ringLabel: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--dsw-alias-label-primary)', zIndex: 1, pointerEvents: 'none' } as const,
  ringRow: { display: 'flex', gap: 12, alignItems: 'center' } as const,
  rankRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as const,
  rankName: { width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const,
  rankTrack: { flex: 1, height: 6, borderRadius: 3, background: 'var(--dsw-alias-interactive-bg-hover)', overflow: 'hidden' } as const,
  rankCount: { width: 42, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } as const,
  rankWhen: { width: 64, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' } as const,
  empty: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
} as const

/**
 * Daily columns split by type or project.
 * @param props - days to draw, their buckets, the split and the colour rule.
 * @returns one stacked column per day.
 */
export function StackedBars({ days, buckets, dimension, keys, t, limit = 4, selectedKey = null, onPickKey }: {
  readonly days: readonly string[]
  readonly buckets: readonly DayBucket[]
  readonly dimension: 'type' | 'project'
  readonly keys: readonly string[]
  readonly t: Translate
  readonly limit?: number
  readonly selectedKey?: string | null
  readonly onPickKey?: (key: string) => void
}): JSX.Element {
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]))
  const named = topKeys(keys.map((key) => ({ key, count: 1 })), limit).map((entry) => entry.key)
  const peak = days.reduce((busiest, day) => Math.max(busiest, byDay.get(day)?.total ?? 0), 0)
  const scale = axisScale(peak)
  const ticks = tickIndexes(days.length)
  // A month of columns leaves too little room for a flat label between them, so
  // the axis leans its dates to 45° and gives them their own band instead.
  const slanted = days.length > 14
  const colorOf = dimension === 'type' ? (key: string) => typeColor(key) : (key: string, index: number) => projectColor(key, index)
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  return (
    <div style={styles.section}>
      <h4 style={styles.title}>{dimension === 'type' ? t('byType') : t('byProject')}</h4>
      <div style={styles.plot}>
        <div style={styles.scale}>
          <span style={{ ...styles.scaleTick, top: 0 }}>{scale.max}</span>
          <span style={{ ...styles.scaleTick, top: '50%' }}>{scale.half}</span>
          <span style={{ ...styles.scaleTick, top: '100%' }}>0</span>
        </div>
        <div style={styles.plotArea}>
          <div style={{ ...styles.guide, top: 0 }} />
          <div style={{ ...styles.guide, top: '50%' }} />
          <div style={styles.bars}>
            {days.map((day) => (
              <Tooltip key={day} label={dayTip(day, byDay.get(day), dimension, t)} side="top" portal delayMs={90}>
                <div
                  style={hoverDay === day ? { ...styles.bar, background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 3 } : styles.bar}
                  onPointerEnter={() => setHoverDay(day)}
                  onPointerLeave={() => setHoverDay(null)}
                >
                  <div style={{ ...styles.stack, height: barHeight(byDay.get(day), scale.max) + '%' }}>
                    {stackRatios(byDay.get(day), dimension, named).map((segment, index) => (
                      <i
                        key={segment.key}
                        onClick={onPickKey === undefined ? undefined : () => onPickKey(segment.key)}
                        onPointerEnter={() => setHoverKey(segment.key)}
                        onPointerLeave={() => setHoverKey(null)}
                        style={{
                          display: 'block',
                          width: '100%',
                          height: segment.ratio * 100 + '%',
                          background: colorOf(segment.key, index),
                          cursor: onPickKey === undefined ? 'default' : 'pointer',
                          opacity: isDimmed(segment.key, selectedKey, hoverKey) ? 0.3 : 1,
                          transition: 'opacity 120ms var(--ds-ease-in-out, ease-out)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
      <div style={{ ...styles.axis, height: slanted ? 30 : 16 }}>
        {days.map((day, index) => (
          <span key={day} style={styles.axisTick}>
            {ticks.includes(index) ? (
              <span style={slanted ? styles.axisLabelSlanted : styles.axisLabel}>{day.slice(5)}</span>
            ) : null}
          </span>
        ))}
      </div>
      <div style={styles.legend}>
        {named.map((key, index) => (
          <span key={key}>
            <i style={{ ...styles.swatch, background: colorOf(key, index) }} />
            {key === OTHER_KEY ? t('otherKey') : key}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * One composition ring with its legend; the caption heads that legend.
 * @param props - ranked counts, legend caption and colour rule.
 * @returns the ring, or an empty note when there is nothing to draw.
 */
export function CompositionRing({ entries, caption, t, limit = 6, colorOf, selectedKey = null, onPickKey }: {
  readonly entries: readonly KeyedCount[]
  readonly caption: string
  readonly t: Translate
  readonly limit?: number
  readonly colorOf: (key: string, index: number) => string
  readonly selectedKey?: string | null
  readonly onPickKey?: (key: string) => void
}): JSX.Element {
  const folded = topKeys(entries, limit)
  const shown = folded.reduce((sum, entry) => sum + entry.count, 0)
  const arcs = donutArcs(folded, colorOf)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return (
    <div style={styles.section}>
      {arcs.length === 0 ? (
        <div style={styles.section}>
          <span style={styles.legendTitle}>{caption}</span>
          <span style={styles.empty}>{t('noData')}</span>
        </div>
      ) : (
        <div style={styles.ringRow}>
          <div style={styles.ring}>
            <svg width={DONUT_SIZE} height={DONUT_SIZE} viewBox={'0 0 ' + DONUT_SIZE + ' ' + DONUT_SIZE} style={{ display: 'block', overflow: 'visible' }}>
              {arcs.map((arc) => (
                <Tooltip
                  key={arc.key}
                  side="top"
                  portal
                  delayMs={90}
                  label={() => {
                    const entry = folded.find((item) => item.key === arc.key)
                    const name = arc.key === OTHER_KEY ? t('otherKey') : arc.key
                    const share = shown > 0 ? Math.round(((entry?.count ?? 0) / shown) * 100) : 0
                    return name + '\n' + (entry?.count ?? 0) + ' · ' + share + '%'
                  }}
                >
                  <circle
                    cx={DONUT_SIZE / 2}
                    cy={DONUT_SIZE / 2}
                    r={(DONUT_SIZE - DONUT_THICKNESS) / 2}
                    fill="none"
                    stroke={arc.color}
                    strokeWidth={hoverKey === arc.key ? DONUT_THICKNESS + 2 : DONUT_THICKNESS}
                    strokeDasharray={arc.dash}
                    strokeDashoffset={arc.offset}
                    transform={'rotate(-90 ' + DONUT_SIZE / 2 + ' ' + DONUT_SIZE / 2 + ')'}
                    onClick={onPickKey === undefined || arc.key === OTHER_KEY ? undefined : () => onPickKey(arc.key)}
                    strokeOpacity={isDimmed(arc.key, selectedKey, hoverKey) ? 0.3 : 1}
                    onPointerEnter={() => setHoverKey(arc.key)}
                    onPointerLeave={() => setHoverKey(null)}
                    style={{
                      cursor: onPickKey === undefined || arc.key === OTHER_KEY ? 'default' : 'pointer',
                      transition: 'stroke-width 120ms var(--ds-ease-in-out, ease-out)',
                    }}
                  />
                </Tooltip>
              ))}
            </svg>
            <span style={styles.ringLabel}>{folded.length}</span>
          </div>
          <div style={styles.legend}>
            <span style={styles.legendTitle}>{caption}</span>
            {folded.map((entry, index) => (
              <Tooltip
                key={entry.key}
                side="top"
                portal
                delayMs={90}
                label={() => {
                  const name = entry.key === OTHER_KEY ? t('otherKey') : entry.key
                  const share = shown > 0 ? Math.round((entry.count / shown) * 100) : 0
                  return name + '\n' + entry.count + ' · ' + share + '%'
                }}
              >
                <span
                  onClick={onPickKey === undefined || entry.key === OTHER_KEY ? undefined : () => onPickKey(entry.key)}
                  onPointerEnter={() => setHoverKey(entry.key)}
                  onPointerLeave={() => setHoverKey(null)}
                  style={{
                    display: 'block',
                    cursor: onPickKey === undefined || entry.key === OTHER_KEY ? 'default' : 'pointer',
                    opacity: isDimmed(entry.key, selectedKey, hoverKey) ? 0.3 : 1,
                    transition: 'opacity 120ms var(--ds-ease-in-out, ease-out)',
                  }}
                >
                  <i style={{ ...styles.swatch, background: colorOf(entry.key, index) }} />
                  {entry.key === OTHER_KEY ? t('otherKey') : entry.key} {entry.count}
                </span>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Project ranking: count bar, total and the day each project last wrote.
 * @param props - ranked projects and how many were excluded.
 * @returns one row per project.
 */
export function ProjectRanking({ projects, excluded, t, selectedKey = null, onPickKey }: {
  readonly projects: Distributions['projects']
  readonly excluded: number
  readonly t: Translate
  readonly selectedKey?: string | null
  readonly onPickKey?: (key: string) => void
}): JSX.Element {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const peak = projects.reduce((max, project) => Math.max(max, project.count), 0)
  return (
    <div style={styles.section}>
      <h4 style={styles.title}>{t('rankingTitle', { excluded })}</h4>
      {projects.length === 0 ? <span style={styles.empty}>{t('noData')}</span> : null}
      {projects.map((project, index) => (
        <Tooltip
          key={project.key}
          side="top"
          portal
          delayMs={90}
          label={() => project.key + '\n' + t('tipTotal', { count: project.count }) + '\n' + project.lastWrite.slice(0, 10)}
        >
          <div
            onClick={onPickKey === undefined ? undefined : () => onPickKey(project.key)}
            onPointerEnter={() => setHoverKey(project.key)}
            onPointerLeave={() => setHoverKey(null)}
            style={{
              ...styles.rankRow,
              cursor: onPickKey === undefined ? 'default' : 'pointer',
              opacity: isDimmed(project.key, selectedKey, hoverKey) ? 0.3 : 1,
              transition: 'opacity 120ms var(--ds-ease-in-out, ease-out)',
            }}
          >
            <span style={styles.rankName}>{project.key}</span>
            <span style={styles.rankTrack}>
              <i style={{ display: 'block', height: '100%', width: (peak > 0 ? (project.count / peak) * 100 : 0) + '%', background: projectColor(project.key, index) }} />
            </span>
            <span style={styles.rankCount}>{project.count}</span>
            <span style={styles.rankWhen}>{project.lastWrite.slice(5)}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  )
}

