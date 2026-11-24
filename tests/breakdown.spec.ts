import { describe, expect, it, vi } from 'vitest'

// The chart components render their hover bubbles through the host's Tooltip
// primitive; this spec covers the pure helpers, so the primitive is stubbed.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Tooltip: () => null }))

import { axisScale, barHeight, crossTotals, donutArcs, lastDays, projectColor, stackRatios, tickIndexes, topKeys, typeColor, windowTotals } from '../src/client/breakdown.js'

const day = (total: number, byType: Record<string, number>, byProject: Record<string, number>) => ({ day: '2026-11-23', total, byType, byProject })

describe('topKeys', () => {
  it('keeps the head and folds the tail', () => {
    const folded = topKeys([{ key: 'a', count: 5 }, { key: 'b', count: 3 }, { key: 'c', count: 2 }], 2)
    expect(folded).toEqual([{ key: 'a', count: 5 }, { key: 'b', count: 3 }, { key: 'other', count: 2 }])
  })

  it('leaves a short list untouched', () => {
    expect(topKeys([{ key: 'a', count: 1 }], 4)).toEqual([{ key: 'a', count: 1 }])
  })
})

describe('stackRatios', () => {
  it('normalises the named segments and folds the rest', () => {
    const ratios = stackRatios(day(10, { bugfix: 5, feature: 3, decision: 2 }, {}), 'type', ['bugfix', 'feature'])
    expect(ratios).toEqual([{ key: 'bugfix', ratio: 0.5 }, { key: 'feature', ratio: 0.3 }, { key: 'other', ratio: 0.2 }])
  })

  it('returns nothing for an empty or missing day', () => {
    expect(stackRatios(undefined, 'type', ['bugfix'])).toEqual([])
    expect(stackRatios(day(0, {}, {}), 'type', ['bugfix'])).toEqual([])
  })

  it('reads the project split when asked', () => {
    expect(stackRatios(day(4, {}, { alpha: 4 }), 'project', ['alpha'])).toEqual([{ key: 'alpha', ratio: 1 }])
  })
})

describe('barHeight', () => {
  it('scales against the busiest day', () => {
    expect(barHeight(day(5, {}, {}), 10)).toBe(50)
    expect(barHeight(undefined, 10)).toBe(0)
    expect(barHeight(day(1, {}, {}), 0)).toBe(0)
  })
})

describe('donutArcs', () => {
  it('splits the ring into proportional dashes, clockwise from the top', () => {
    const arcs = donutArcs([{ key: 'a', count: 1 }, { key: 'b', count: 1 }], (key) => key)
    const circumference = Math.PI * (74 - 11)
    const half = (circumference / 2).toFixed(2)
    expect(arcs).toHaveLength(2)
    expect(arcs[0]).toMatchObject({ key: 'a', color: 'a', dash: half + ' ' + half })
    expect(arcs[0].offset).toBeCloseTo(0)
    expect(arcs[1].offset).toBeCloseTo(-circumference / 2)
  })

  it('draws nothing when there is nothing to draw', () => {
    expect(donutArcs([{ key: 'a', count: 0 }], (key) => key)).toEqual([])
  })
})

describe('lastDays', () => {
  it('ends today and walks back the requested window', () => {
    const days = lastDays(3, new Date(Date.UTC(2026, 10, 25, 12, 0, 0)))
    expect(days).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
  })
})

describe('windowTotals', () => {
  const buckets = [
    { day: '2026-11-01', total: 2, byType: { discovery: 1, feature: 1 }, byProject: { a: 2 } },
    { day: '2026-11-02', total: 3, byType: { discovery: 3 }, byProject: { b: 1, a: 1 } },
    { day: '2026-11-03', total: 1, byType: { bugfix: 1 }, byProject: { b: 1 } },
  ]

  it('sums only the days the window admits', () => {
    const totals = windowTotals(buckets, ['2026-11-02', '2026-11-03'])
    expect(totals.total).toBe(4)
    expect(totals.types).toEqual([{ key: 'discovery', count: 3 }, { key: 'bugfix', count: 1 }])
  })

  it('keeps the last day a project wrote inside the window', () => {
    const totals = windowTotals(buckets, ['2026-11-02', '2026-11-03'])
    expect(totals.projects).toEqual([
      { key: 'b', count: 2, lastWrite: '2026-11-03' },
      { key: 'a', count: 1, lastWrite: '2026-11-02' },
    ])
  })
})

describe('crossTotals', () => {
  const cells = [
    { day: '2026-11-02', type: 'discovery', project: 'a', count: 3 },
    { day: '2026-11-02', type: 'discovery', project: 'b', count: 1 },
    { day: '2026-11-02', type: 'bugfix', project: 'b', count: 2 },
    { day: '2026-11-01', type: 'discovery', project: 'c', count: 5 },
  ]

  it('narrows the other dimension to the picked type inside the window', () => {
    const cross = crossTotals(cells, ['2026-11-02'], 'type', 'discovery')
    expect(cross.projects).toEqual([
      { key: 'a', count: 3, lastWrite: '2026-11-02' },
      { key: 'b', count: 1, lastWrite: '2026-11-02' },
    ])
  })

  it('narrows the types to the picked project', () => {
    const cross = crossTotals(cells, ['2026-11-01', '2026-11-02'], 'project', 'b')
    expect(cross.types).toEqual([{ key: 'bugfix', count: 2 }, { key: 'discovery', count: 1 }])
  })
})

describe('colours', () => {
  it('falls back for unknown types and cycles the project palette', () => {
    expect(typeColor('bugfix')).toBe('#e8833a')
    expect(typeColor('unknown-type')).toBe('#7c8698')
    expect(projectColor('x', 0)).toBe(projectColor('y', 0))
    expect(projectColor('x', 0)).not.toBe(projectColor('y', 1))
  })
})

describe('axisScale', () => {
  it('keeps the fixed 0/5/10 scale while the busiest day is ten or fewer', () => {
    expect(axisScale(0)).toEqual({ max: 10, half: 5 })
    expect(axisScale(3)).toEqual({ max: 10, half: 5 })
    expect(axisScale(10)).toEqual({ max: 10, half: 5 })
  })

  it('rounds the top up to the next multiple of twenty above ten', () => {
    expect(axisScale(11)).toEqual({ max: 20, half: 10 })
    expect(axisScale(20)).toEqual({ max: 20, half: 10 })
    expect(axisScale(21)).toEqual({ max: 40, half: 20 })
    expect(axisScale(77)).toEqual({ max: 80, half: 40 })
    expect(axisScale(100)).toEqual({ max: 100, half: 50 })
    expect(axisScale(101)).toEqual({ max: 120, half: 60 })
  })
})

describe('tickIndexes', () => {
  it('labels both ends of a week plus its middle day', () => {
    expect(tickIndexes(7)).toEqual([0, 3, 6])
  })

  it('adds two middle days across a fortnight', () => {
    expect(tickIndexes(14)).toEqual([0, 4, 9, 13])
  })

  it('steps about five days over a month', () => {
    expect(tickIndexes(30)).toEqual([0, 5, 10, 15, 19, 24, 29])
  })

  it('keeps the ends, never repeats an index and stays ascending', () => {
    for (const length of [2, 3, 7, 8, 14, 15, 30, 31]) {
      const indexes = tickIndexes(length)
      expect(new Set(indexes).size).toBe(indexes.length)
      expect(indexes[0]).toBe(0)
      expect(indexes.at(-1)).toBe(length - 1)
    }
  })
})
