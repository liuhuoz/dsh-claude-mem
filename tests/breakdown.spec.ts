import { describe, expect, it, vi } from 'vitest'

// The chart components render their hover bubbles through the host's Tooltip
// primitive; this spec covers the pure helpers, so the primitive is stubbed.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Tooltip: () => null }))

import { barHeight, donutArcs, lastDays, projectColor, stackRatios, topKeys, typeColor } from '../src/client/breakdown.js'

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

describe('colours', () => {
  it('falls back for unknown types and cycles the project palette', () => {
    expect(typeColor('bugfix')).toBe('#e8833a')
    expect(typeColor('unknown-type')).toBe('#7c8698')
    expect(projectColor('x', 0)).toBe(projectColor('y', 0))
    expect(projectColor('x', 0)).not.toBe(projectColor('y', 1))
  })
})
