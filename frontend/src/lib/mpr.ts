import type { SliceAxis } from './measure'

/** Voxel indices (column, row, slice) into the assembled volume. */
export type Voxel = [number, number, number]

export interface ViewPoint {
  x: number
  y: number
  slice: number
}

/**
 * Where a voxel appears in a 2D view. Coronal and sagittal views put superior at
 * the top, so their y axis runs opposite to the volume's slice index.
 */
export function toView(axis: SliceAxis, [i, j, k]: Voxel, dims: Voxel): ViewPoint {
  const nz = dims[2]
  if (axis === 'axial') return { x: i, y: j, slice: k }
  if (axis === 'coronal') return { x: i, y: nz - 1 - k, slice: j }
  return { x: j, y: nz - 1 - k, slice: i }
}

/** Inverse of ``toView``; the result is clamped to the volume. */
export function fromView(axis: SliceAxis, x: number, y: number, slice: number, dims: Voxel): Voxel {
  const nz = dims[2]
  const v: Voxel =
    axis === 'axial' ? [x, y, slice] : axis === 'coronal' ? [x, slice, nz - 1 - y] : [slice, x, nz - 1 - y]
  return v.map((n, d) => Math.max(0, Math.min(dims[d] - 1, Math.floor(n)))) as Voxel
}

/** Moves the cursor to another slice of ``axis`` while keeping its in-plane position. */
export function withSlice(axis: SliceAxis, cursor: Voxel, slice: number, dims: Voxel): Voxel {
  const { x, y } = toView(axis, cursor, dims)
  return fromView(axis, x, y, slice, dims)
}
