import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ViewerSettings, Volume } from '@/lib/types'

type Axis = 'axial' | 'coronal' | 'sagittal'

interface Geometry {
  width: number
  height: number
  depth: number
  physW: number
  physH: number
  labels: { top: string; bottom: string; left: string; right: string }
  /** Voxel index for display pixel (x, y) on slice s. */
  voxel: (x: number, y: number, s: number) => number
}

function geometry(volume: Volume, axis: Axis): Geometry {
  const [nx, ny, nz] = volume.dims
  const [sx, sy, sz] = volume.spacing
  const plane = nx * ny
  switch (axis) {
    case 'axial':
      return {
        width: nx,
        height: ny,
        depth: nz,
        physW: nx * sx,
        physH: ny * sy,
        labels: { top: 'A', bottom: 'P', left: 'R', right: 'L' },
        voxel: (x, y, s) => s * plane + y * nx + x,
      }
    case 'coronal':
      return {
        width: nx,
        height: nz,
        depth: ny,
        physW: nx * sx,
        physH: nz * sz,
        labels: { top: 'S', bottom: 'I', left: 'R', right: 'L' },
        voxel: (x, y, s) => (nz - 1 - y) * plane + s * nx + x,
      }
    case 'sagittal':
      return {
        width: ny,
        height: nz,
        depth: nx,
        physW: ny * sy,
        physH: nz * sz,
        labels: { top: 'S', bottom: 'I', left: 'A', right: 'P' },
        voxel: (x, y, s) => (nz - 1 - y) * plane + x * nx + s,
      }
  }
}

function clipRect(axis: Axis, s: ViewerSettings): { x: [number, number]; y: [number, number]; slice: [number, number] } {
  const flip = (r: [number, number]): [number, number] => [1 - r[1], 1 - r[0]]
  if (axis === 'axial') return { x: s.clipX, y: s.clipY, slice: s.clipZ }
  if (axis === 'coronal') return { x: s.clipX, y: flip(s.clipZ), slice: s.clipY }
  return { x: s.clipY, y: flip(s.clipZ), slice: s.clipX }
}

export function SliceViewer({ volume, settings }: { volume: Volume; settings: ViewerSettings }) {
  const [axis, setAxis] = useState<Axis>('axial')
  const geo = useMemo(() => geometry(volume, axis), [volume, axis])
  const [slice, setSlice] = useState(() => Math.floor(geo.depth / 2))
  const [hover, setHover] = useState<{ x: number; y: number; hu: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    setSlice(Math.floor(geo.depth / 2))
    setHover(null)
  }, [geo])

  const range = volume.valueMax - volume.valueMin
  const lo = (settings.windowCenter - settings.windowWidth / 2 - volume.valueMin) / range
  const hi = (settings.windowCenter + settings.windowWidth / 2 - volume.valueMin) / range

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { width, height, voxel } = geo
    canvas.width = width
    canvas.height = height
    const img = ctx.createImageData(width, height)
    const px = img.data
    const span = Math.max(hi - lo, 1e-6)
    const s = Math.min(slice, geo.depth - 1)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let w = (volume.data[voxel(x, y, s)] - lo) / span
        w = w < 0 ? 0 : w > 1 ? 1 : w
        const g = (w * 255) | 0
        const o = (y * width + x) * 4
        px[o] = px[o + 1] = px[o + 2] = g
        px[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)

    const clip = clipRect(axis, settings)
    const full = clip.x[0] <= 0 && clip.x[1] >= 1 && clip.y[0] <= 0 && clip.y[1] >= 1
    if (!full) {
      ctx.strokeStyle = 'rgba(95,212,255,0.9)'
      ctx.lineWidth = Math.max(1, width / 256)
      ctx.setLineDash([4, 3])
      ctx.strokeRect(
        clip.x[0] * width,
        clip.y[0] * height,
        (clip.x[1] - clip.x[0]) * width,
        (clip.y[1] - clip.y[0]) * height,
      )
    }
  }, [geo, slice, lo, hi, volume, axis, settings])

  const outsideClip = (() => {
    const c = clipRect(axis, settings).slice
    const t = (slice + 0.5) / geo.depth
    return t < c[0] || t > c[1]
  })()

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * geo.width)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * geo.height)
    if (x < 0 || y < 0 || x >= geo.width || y >= geo.height) return setHover(null)
    const v = volume.data[geo.voxel(x, y, slice)]
    setHover({ x, y, hu: volume.valueMin + v * range })
  }

  const wide = geo.physW >= geo.physH
  const unit = volume.metadata.modality === 'CT' ? 'HU' : ''
  const positionMm = ((slice + 0.5) / geo.depth) * (axis === 'axial' ? volume.dims[2] * volume.spacing[2] : axis === 'coronal' ? volume.dims[1] * volume.spacing[1] : volume.dims[0] * volume.spacing[0])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">2D Slice (MPR)</h3>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={axis}
          onValueChange={(v) => v && setAxis(v as Axis)}
        >
          <ToggleGroupItem value="axial" className="px-2 text-xs">Axial</ToggleGroupItem>
          <ToggleGroupItem value="coronal" className="px-2 text-xs">Coronal</ToggleGroupItem>
          <ToggleGroupItem value="sagittal" className="px-2 text-xs">Sagittal</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-lg border bg-black">
        <canvas
          ref={canvasRef}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="cursor-crosshair"
          style={{
            aspectRatio: `${geo.physW} / ${geo.physH}`,
            width: wide ? '100%' : 'auto',
            height: wide ? 'auto' : '100%',
          }}
          aria-label={`${axis} slice ${slice + 1} of ${geo.depth}`}
        />
        <span className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.top}</span>
        <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.bottom}</span>
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.left}</span>
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.right}</span>
        <div className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[10px] leading-tight text-white/60">
          <div>
            W {Math.round(settings.windowWidth)} / L {Math.round(settings.windowCenter)}
          </div>
        </div>
        <div className="pointer-events-none absolute right-2 bottom-1.5 text-right font-mono text-[10px] leading-tight text-white/60">
          {hover ? (
            <>
              <div className="text-white/90">
                {hover.hu.toFixed(0)} {unit}
              </div>
              <div>
                ({hover.x}, {hover.y})
              </div>
            </>
          ) : (
            <div>hover for {unit || 'value'}</div>
          )}
        </div>
        {outsideClip && (
          <div className="pointer-events-none absolute top-1.5 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-cyan-300">
            outside clip box
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Slider
          value={[slice]}
          min={0}
          max={geo.depth - 1}
          step={1}
          onValueChange={([v]) => setSlice(v)}
          aria-label="Slice index"
        />
        <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {slice + 1}/{geo.depth} · {positionMm.toFixed(0)}mm
        </span>
      </div>
    </div>
  )
}
