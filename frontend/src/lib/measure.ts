export type Point = [number, number]
export type SliceAxis = 'axial' | 'coronal' | 'sagittal'

interface MeasurementBase {
  id: number
  axis: SliceAxis
  slice: number
  /** Start and end in display-pixel coordinates (fractional). */
  a: Point
  b: Point
}

export interface RulerMeasurement extends MeasurementBase {
  kind: 'ruler'
}

/** Elliptical ROI inscribed in the box spanned by ``a`` and ``b``. */
export interface RoiMeasurement extends MeasurementBase {
  kind: 'roi'
}

export type Measurement = RulerMeasurement | RoiMeasurement

export interface RoiStats {
  mean: number
  sd: number
  min: number
  max: number
  count: number
  areaMm2: number
}

/** Physical distance in mm; ``pxW``/``pxH`` are mm per display pixel along x/y. */
export function rulerLengthMm(a: Point, b: Point, pxW: number, pxH: number): number {
  return Math.hypot((b[0] - a[0]) * pxW, (b[1] - a[1]) * pxH)
}

/**
 * Statistics over the pixels whose centres fall inside the ellipse inscribed in the
 * a–b box. Uses Welford's algorithm so large ROIs stay numerically stable.
 */
export function ellipseStats(
  sample: (x: number, y: number) => number,
  width: number,
  height: number,
  a: Point,
  b: Point,
  pxW: number,
  pxH: number,
): RoiStats | null {
  const cx = (a[0] + b[0]) / 2
  const cy = (a[1] + b[1]) / 2
  const rx = Math.abs(b[0] - a[0]) / 2
  const ry = Math.abs(b[1] - a[1]) / 2
  if (rx < 0.5 || ry < 0.5) return null

  const x0 = Math.max(0, Math.floor(cx - rx))
  const x1 = Math.min(width - 1, Math.ceil(cx + rx))
  const y0 = Math.max(0, Math.floor(cy - ry))
  const y1 = Math.min(height - 1, Math.ceil(cy + ry))
  let count = 0
  let mean = 0
  let m2 = 0
  let min = Infinity
  let max = -Infinity
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx
      if (dx * dx + dy * dy > 1) continue
      const v = sample(x, y)
      count++
      const delta = v - mean
      mean += delta / count
      m2 += delta * (v - mean)
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (count === 0) return null
  return { mean, sd: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0, min, max, count, areaMm2: count * pxW * pxH }
}

export function formatArea(mm2: number): string {
  return mm2 >= 100 ? `${(mm2 / 100).toFixed(2)} cm²` : `${mm2.toFixed(1)} mm²`
}
