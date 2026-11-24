import { describe, expect, it, vi } from 'vitest'

// The module draws each cell through the host's Tooltip primitive, which only
// exists in the browser bundle; this spec covers the pure helpers, so the
// primitive is stubbed out and the module stays importable in node.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Tooltip: () => null }))

import { heatLevel, heatStats, weekColumns } from '../src/client/heatmap.js'

/** Wednesday, 2026-11-25, as the grid's end day. */
const END = new Date(Date.UTC(2026, 10, 25, 12, 0, 0))

describe('weekColumns', () => {
  it('returns one column per week with seven days each', () => {
    const columns = weekColumns(END, 12)
    expect(columns).toHaveLength(12)
    expect(columns.every((column) => column.length === 7)).toBe(true)
  })

  it('ends on the week containing the end day and starts on a Sunday', () => {
    const columns = weekColumns(END, 12)
    expect(columns.at(-1)).toContain('2026-11-25')
    expect(new Date(columns[0][0] + 'T00:00:00Z').getUTCDay()).toBe(0)
  })

  it('produces strictly increasing days across the grid', () => {
    const days = weekColumns(END, 4).flat()
    expect([...days].sort()).toEqual(days)
  })
})

describe('heatLevel', () => {
  it('maps zero to the empty step', () => {
    expect(heatLevel(0, 10)).toBe(0)
  })

  it('spreads activity across four steps', () => {
    expect(heatLevel(1, 100)).toBe(1)
    expect(heatLevel(30, 100)).toBe(2)
    expect(heatLevel(60, 100)).toBe(3)
    expect(heatLevel(100, 100)).toBe(4)
  })

  it('treats a single-observation window as the busiest step', () => {
    expect(heatLevel(1, 1)).toBe(4)
  })
})

describe('heatStats', () => {
  it('counts the window, the last seven days and the longest streak', () => {
    const days = weekColumns(END, 1).flat()
    const counts: Record<string, number> = {}
    counts[days[0]] = 2
    counts[days[1]] = 1
    counts[days[2]] = 3
    const stats = heatStats(days, counts)
    expect(stats.window).toBe(6)
    expect(stats.activeDays).toBe(3)
    expect(stats.bestStreak).toBe(3)
    expect(stats.recent).toBe(6)
    expect(stats.average).toBeCloseTo(6 / 7)
  })

  it('breaks a streak on an empty day', () => {
    const stats = heatStats(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], {
      '2026-11-01': 1,
      '2026-11-03': 1,
      '2026-11-04': 1,
    })
    expect(stats.bestStreak).toBe(2)
    expect(stats.activeDays).toBe(3)
  })
})
