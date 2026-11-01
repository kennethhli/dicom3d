import { describe, expect, it } from 'vitest'
import { fromView, toView, withSlice, type Voxel } from './mpr'

const dims: Voxel = [512, 512, 133]

describe('MPR cursor mapping', () => {
  it('round-trips a voxel through every view', () => {
    const v: Voxel = [300, 210, 40]
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      const p = toView(axis, v, dims)
      expect(fromView(axis, p.x, p.y, p.slice, dims)).toEqual(v)
    }
  })

  it('puts superior at the top of coronal and sagittal views', () => {
    expect(toView('coronal', [0, 0, 132], dims).y).toBe(0)
    expect(toView('sagittal', [0, 0, 0], dims).y).toBe(132)
  })

  it('links views: a click in one view selects the matching slice in the others', () => {
    const v = fromView('axial', 300, 210, 40, dims)
    expect(toView('coronal', v, dims).slice).toBe(210)
    expect(toView('sagittal', v, dims).slice).toBe(300)
  })

  it('changes only the slice coordinate and clamps to the volume', () => {
    expect(withSlice('coronal', [300, 210, 40], 99, dims)).toEqual([300, 99, 40])
    expect(fromView('axial', -5, 600, 500, dims)).toEqual([0, 511, 132])
  })
})
