/**
 * The twelve-week activity heatmap, laid out like a contribution graph: one
 * column per week, one row per weekday, months labelled above the week a month
 * starts in, intensity in five steps. The block sits centred in its card with a
 * left-aligned text summary beside it.
 * @module dsh-claude-mem/client/heatmap
 */

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayBucket } from '../overview-types.js'
import type { Translate } from './messages.js'

/** Columns drawn by default; a quarter of activity reads better than half a year. */
export const HEATMAP_WEEKS = 12

/** Milliseconds in a day. */
const DAY_MS = 86_400_000

/** Day key in UTC, matching how the worker stores created_at. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Week columns ending with the week that contains `end`.
 * @param end - the day the grid ends on (UTC).
 * @param weeks - how many week columns to produce.
 * @returns columns of seven day keys, Sunday first.
 */
export function weekColumns(end: Date, weeks: number = HEATMAP_WEEKS): string[][] {
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  const trailing = new Date(endDay).getUTCDay()
  const start = endDay - ((weeks - 1) * 7 + trailing) * DAY_MS
  const columns: string[][] = []
  for (let week = 0; week < weeks; week++) {
    const column: string[] = []
    for (let day = 0; day < 7; day++) column.push(dayKey(new Date(start + (week * 7 + day) * DAY_MS)))
    columns.push(column)
  }
  return columns
}

/**
 * Map a day's count onto the five intensity steps.
 * @param count - observations written that day.
 * @param max - the window's busiest day.
 * @returns 0 (empty) through 4 (busiest).
 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (max <= 1) return 4
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** What the summary column reports. */
export interface HeatStats {
  /** Observations inside the window. */
  readonly window: number
  /** Observations in the last seven days. */
  readonly recent: number
  /** Days with at least one observation. */
  readonly activeDays: number
  /** Longest run of consecutive active days. */
  readonly bestStreak: number
  /** Mean observations per day across the window. */
  readonly average: number
}

/**
 * Summarise a set of day keys.
 * @param days - the window, oldest first.
 * @param counts - observations per day.
 * @returns window totals, activity and streaks.
 */
export function heatStats(days: readonly string[], counts: Readonly<Record<string, number>>): HeatStats {
  let window = 0
  let activeDays = 0
  let streak = 0
  let bestStreak = 0
  for (const day of days) {
    const count = counts[day] ?? 0
    window += count
    if (count > 0) {
      activeDays += 1
      streak += 1
      if (streak > bestStreak) bestStreak = streak
    } else {
      streak = 0
    }
  }
  const recent = days.slice(-7).reduce((sum, day) => sum + (counts[day] ?? 0), 0)
  return { window, recent, activeDays, bestStreak, average: days.length === 0 ? 0 : window / days.length }
}

/**
 * Intensity fills, weakest to strongest: one hue at rising opacity, so the ramp
 * reads the same way on a light card and a dark one. The empty day is a faint
 * neutral rather than a theme colour, so a quiet grid still looks like a grid.
 */
const LEVEL_FILLS = [
  'color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)',
  'color-mix(in srgb, var(--dsw-alias-state-business-primary) 28%, transparent)',
  'color-mix(in srgb, var(--dsw-alias-state-business-primary) 50%, transparent)',
  'color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, transparent)',
  'color-mix(in srgb, var(--dsw-alias-state-business-primary) 92%, transparent)',
] as const

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 8 } as const,
  title: { margin: 0, fontSize: 11.5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)' } as const,
  block: { display: 'flex', gap: 20, alignItems: 'center', justifyContent: 'center' } as const,
  months: { position: 'relative', height: 13, paddingLeft: 20, marginBottom: 3 } as const,
  month: { position: 'absolute', top: 0, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' } as const,
  grid: { display: 'flex', gap: 3 } as const,
  weekdays: { display: 'flex', flexDirection: 'column', gap: 3 } as const,
  weekday: { width: 17, height: 14, lineHeight: '14px', fontSize: 9.5, textAlign: 'right', paddingRight: 3, color: 'var(--dsw-alias-label-tertiary)' } as const,
  column: { display: 'flex', flexDirection: 'column', gap: 3 } as const,
  cell: { width: 14, height: 14, borderRadius: 2, background: 'var(--dsw-alias-interactive-bg-hover)' } as const,
  summary: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', textAlign: 'left' } as const,
  summaryHead: { display: 'flex', alignItems: 'baseline', gap: 6 } as const,
  summaryValue: { fontSize: 19, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const,
  summaryCaption: { fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' } as const,
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 18px' } as const,
  legend: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 } as const,
} as const

/**
 * Draw the window.
 * @param props - buckets from the overview route, all-time total, translator and optional clock.
 * @returns the heatmap and its summary column.
 */
export function Heatmap({ buckets, total, t, weeks = HEATMAP_WEEKS, now = new Date() }: {
  readonly buckets: readonly DayBucket[]
  readonly total: number
  readonly t: Translate
  readonly weeks?: number
  readonly now?: Date
}): JSX.Element {
  const counts: Record<string, number> = {}
  for (const bucket of buckets) counts[bucket.day] = bucket.total
  const columns = weekColumns(now, weeks)
  const days = columns.flat()
  const stats = heatStats(days, counts)
  const max = days.reduce((peak, day) => Math.max(peak, counts[day] ?? 0), 0)
  const share = total > 0 ? Math.round((stats.recent / total) * 100) : 0

  const months = columns
    .map((column, index) => {
      const first = column[0]
      const previous = index > 0 ? columns[index - 1][0] : undefined
      const changed = previous === undefined || previous.slice(0, 7) !== first.slice(0, 7)
      return changed ? { key: first, left: 20 + index * 17, label: Number(first.slice(5, 7)) + t('monthSuffix') } : undefined
    })
    .filter((entry): entry is { key: string; left: number; label: string } => entry !== undefined)

  return (
    <div style={styles.section}>
      <h4 style={styles.title}>{t('heatTitle', { weeks })}</h4>
      <div style={styles.block}>
        <div>
          <div style={styles.months}>
            {months.map((month) => (
              <span key={month.key} style={{ ...styles.month, left: month.left }}>{month.label}</span>
            ))}
          </div>
          <div style={styles.grid}>
            <div style={styles.weekdays}>
              <span style={styles.weekday}>{t('wdSun')}</span>
              <span style={styles.weekday} />
              <span style={styles.weekday}>{t('wdTue')}</span>
              <span style={styles.weekday} />
              <span style={styles.weekday}>{t('wdThu')}</span>
              <span style={styles.weekday} />
              <span style={styles.weekday}>{t('wdSat')}</span>
            </div>
            {columns.map((column, index) => (
              <div key={index} style={styles.column}>
                {column.map((day) => {
                  const count = counts[day] ?? 0
                  return (
                    <Tooltip
                      key={day}
                      label={day + '\n' + t('heatDay', { count })}
                      side="top"
                      portal
                      delayMs={120}
                    >
                      <span
                        aria-label={day + ' · ' + count}
                        style={{ ...styles.cell, background: LEVEL_FILLS[heatLevel(count, max)] }}
                      />
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>
          <div style={styles.legend}>
            {t('heatLess')}
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} style={{ ...styles.cell, width: 11, height: 11, background: LEVEL_FILLS[level] }} />
            ))}
            {t('heatMore')}
          </div>
        </div>
        <div style={styles.summary}>
          <div style={styles.summaryHead}>
            <span style={styles.summaryValue}>{stats.window.toLocaleString()}</span>
            <span style={styles.summaryCaption}>{t('heatWindow', { weeks })}</span>
          </div>
          <div style={styles.summaryGrid}>
            <span>{t('heatRecent', { count: stats.recent.toLocaleString(), percent: share })}</span>
            <span>{t('heatActive', { active: stats.activeDays, days: days.length })}</span>
            <span>{t('heatStreak', { days: stats.bestStreak })}</span>
            <span>{t('heatAverage', { value: stats.average.toFixed(1) })}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

