import { describe, expect, it } from 'vitest'
import { ellipseStats, formatArea, rulerLengthMm } from './measure'

describe('rulerLengthMm', () => {
  it('accounts for anisotropic pixel spacing', () => {
    expect(rulerLengthMm([0, 0], [3, 4], 1, 1)).toBeCloseTo(5)
    expect(rulerLengthMm([0, 0], [0, 10], 0.7, 2.5)).toBeCloseTo(25)
  })
})

describe('ellipseStats', () => {
  it('summarises the pixels inside the ellipse', () => {
    // Left half of the image is 0 HU, right half is 100 HU.
    const sample = (x: number) => (x < 50 ? 0 : 100)
    const left = ellipseStats(sample, 100, 100, [10, 10], [40, 40], 1, 1)!
    expect(left.mean).toBe(0)
    expect(left.sd).toBe(0)
    expect(Math.abs(left.areaMm2 / (Math.PI * 15 * 15) - 1)).toBeLessThan(0.02)

    const both = ellipseStats(sample, 100, 100, [30, 30], [70, 70], 0.5, 0.5)!
    expect(both.mean).toBeCloseTo(50, 0)
    expect(both.min).toBe(0)
    expect(both.max).toBe(100)
    expect(both.sd).toBeGreaterThan(45)
  })

  it('clips to the image and ignores degenerate boxes', () => {
    expect(ellipseStats(() => 1, 10, 10, [5, 5], [5.2, 9], 1, 1)).toBeNull()
    const edge = ellipseStats(() => 1, 10, 10, [-10, -10], [10, 10], 1, 1)!
    expect(edge.count).toBeLessThanOrEqual(100)
  })
})

describe('formatArea', () => {
  it('switches to cm² for large regions', () => {
    expect(formatArea(50)).toBe('50.0 mm²')
    expect(formatArea(250)).toBe('2.50 cm²')
  })
})
