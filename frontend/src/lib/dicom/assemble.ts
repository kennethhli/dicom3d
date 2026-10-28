import type { ParsedSlice, Vec3, Volume } from '@/lib/types'

export const HISTOGRAM_BINS = 256
/** Voxel cap: 160 MB of float32 on the CPU plus 80 MB of R16F on the GPU. Fits a 512²×150 CT. */
export const MAX_VOXELS = 40 * 1024 * 1024
const CT_FLOOR = -1024
const CT_CEIL = 3071

export class VolumeAssemblyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VolumeAssemblyError'
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Keep the largest group of slices that share a series and matrix size. */
function selectSeries(slices: ParsedSlice[]): ParsedSlice[] {
  const groups = new Map<string, ParsedSlice[]>()
  for (const s of slices) {
    const key = `${s.seriesUid ?? '?'}|${s.rows}x${s.cols}`
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  let best: ParsedSlice[] = []
  for (const g of groups.values()) if (g.length > best.length) best = g
  return best
}

interface SortResult {
  ordered: ParsedSlice[]
  zSpacing: number
  sortedBy: Volume['metadata']['sortedBy']
}

/** Order slices along the stack normal derived from ImageOrientationPatient. */
export function sortSlices(slices: ParsedSlice[]): SortResult {
  const first = slices[0]
  const fallbackSpacing = first.sliceThickness ?? 1

  if (first.orientation && slices.every((s) => s.position)) {
    const o = first.orientation
    const normal = cross([o[0], o[1], o[2]], [o[3], o[4], o[5]])
    const keyed = slices
      .map((s) => ({ s, d: dot(s.position as Vec3, normal) }))
      .sort((a, b) => a.d - b.d)
    const unique = keyed.filter((k, i) => i === 0 || Math.abs(k.d - keyed[i - 1].d) > 1e-4)
    const gaps = unique.slice(1).map((k, i) => k.d - unique[i].d)
    const spacing = median(gaps)
    return {
      ordered: unique.map((k) => k.s),
      zSpacing: Number.isFinite(spacing) && spacing > 0 ? spacing : fallbackSpacing,
      sortedBy: 'position',
    }
  }
  if (slices.every((s) => s.instanceNumber !== null)) {
    return {
      ordered: [...slices].sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0)),
      zSpacing: fallbackSpacing,
      sortedBy: 'instance',
    }
  }
  return { ordered: [...slices].sort((a, b) => a.index - b.index), zSpacing: fallbackSpacing, sortedBy: 'file-order' }
}

/**
 * Float32 → IEEE half (round-to-nearest). R16F is filterable on every WebGL2
 * device, unlike R32F which needs OES_texture_float_linear.
 */
export function toHalfFloat(src: Float32Array): Uint16Array {
  const bits = new Uint32Array(src.buffer, src.byteOffset, src.length)
  const out = new Uint16Array(src.length)
  for (let i = 0; i < bits.length; i++) {
    const x = bits[i]
    const sign = (x >>> 16) & 0x8000
    const e = ((x >>> 23) & 0xff) - 112
    let m = x & 0x7fffff
    if (e <= 0) {
      if (e < -10) {
        out[i] = sign
        continue
      }
      m = (m | 0x800000) >>> (1 - e)
      out[i] = sign | ((m + 0x1000) >>> 13)
    } else if (e > 30) {
      out[i] = sign | 0x7c00
    } else {
      out[i] = sign | ((e << 10) + ((m + 0x1000) >>> 13))
    }
  }
  return out
}

/** 2×2 box filter in-plane, used when a series exceeds the texture budget. */
function downsampleInPlane(values: Float32Array, cols: number, rows: number): Float32Array {
  const w = cols >> 1
  const h = rows >> 1
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * cols
    const r1 = r0 + cols
    for (let x = 0; x < w; x++) {
      const c = 2 * x
      out[y * w + x] = 0.25 * (values[r0 + c] + values[r0 + c + 1] + values[r1 + c] + values[r1 + c + 1])
    }
  }
  return out
}

export function assembleVolume(input: ParsedSlice[], skippedUpstream = 0): Volume {
  if (input.length === 0) throw new VolumeAssemblyError('No decodable image slices were found')
  const series = selectSeries(input)
  if (series.length < 2) {
    throw new VolumeAssemblyError('A 3D volume needs at least two slices from the same series')
  }
  const { ordered, zSpacing, sortedBy } = sortSlices(series)
  const first = ordered[0]
  const isCT = first.modality === 'CT'

  let cols = first.cols
  let rows = first.rows
  let [sx, sy] = first.pixelSpacing
  let planes = ordered.map((s) => s.values)
  while (cols * rows * ordered.length > MAX_VOXELS && cols > 64 && rows > 64) {
    planes = planes.map((p) => downsampleInPlane(p, cols, rows))
    cols >>= 1
    rows >>= 1
    sx *= 2
    sy *= 2
  }

  let lo = Infinity
  let hi = -Infinity
  for (const s of ordered) {
    if (s.min < lo) lo = s.min
    if (s.max > hi) hi = s.max
  }
  const valueMin = isCT ? Math.max(lo, CT_FLOOR) : lo
  let valueMax = isCT ? Math.min(hi, CT_CEIL) : hi
  if (valueMax <= valueMin) valueMax = valueMin + 1
  const scale = 1 / (valueMax - valueMin)

  const sliceSize = cols * rows
  const depth = planes.length
  const data = new Float32Array(sliceSize * depth)
  const histogram = new Uint32Array(HISTOGRAM_BINS)
  for (let k = 0; k < depth; k++) {
    const src = planes[k]
    const base = k * sliceSize
    for (let i = 0; i < sliceSize; i++) {
      let v = (src[i] - valueMin) * scale
      v = v < 0 ? 0 : v > 1 ? 1 : v
      data[base + i] = v
      histogram[Math.min(HISTOGRAM_BINS - 1, (v * HISTOGRAM_BINS) | 0)]++
    }
  }

  const defaultWindow =
    first.windowCenter !== null && first.windowWidth !== null && first.windowWidth > 0
      ? { center: first.windowCenter, width: first.windowWidth }
      : isCT
        ? { center: 40, width: 400 }
        : { center: (valueMin + valueMax) / 2, width: valueMax - valueMin }

  return {
    data,
    gpuData: toHalfFloat(data),
    dims: [cols, rows, depth],
    spacing: [sx, sy, zSpacing],
    valueMin,
    valueMax,
    histogram,
    defaultWindow,
    metadata: {
      modality: first.modality,
      seriesDescription: first.seriesDescription ?? 'Untitled series',
      sliceCount: depth,
      skippedSlices: skippedUpstream + (input.length - depth),
      rescaleSlope: first.rescaleSlope,
      rescaleIntercept: first.rescaleIntercept,
      sortedBy,
    },
  }
}
