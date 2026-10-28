import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Circle, Crosshair, Ruler, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ellipseStats,
  formatArea,
  rulerLengthMm,
  type Measurement,
  type Point,
  type RoiStats,
  type SliceAxis,
} from '@/lib/measure'
import type { ViewerSettings, Volume } from '@/lib/types'
import { cn } from '@/lib/utils'

type Tool = 'probe' | 'ruler' | 'roi'

interface Geometry {
  width: number
  height: number
  depth: number
  /** mm per display pixel along x and y, and along the slice axis. */
  pxW: number
  pxH: number
  pxD: number
  labels: { top: string; bottom: string; left: string; right: string }
  voxel: (x: number, y: number, s: number) => number
}

function geometry(volume: Volume, axis: SliceAxis): Geometry {
  const [nx, ny, nz] = volume.dims
  const [sx, sy, sz] = volume.spacing
  const plane = nx * ny
  switch (axis) {
    case 'axial':
      return {
        width: nx,
        height: ny,
        depth: nz,
        pxW: sx,
        pxH: sy,
        pxD: sz,
        labels: { top: 'A', bottom: 'P', left: 'R', right: 'L' },
        voxel: (x, y, s) => s * plane + y * nx + x,
      }
    case 'coronal':
      return {
        width: nx,
        height: nz,
        depth: ny,
        pxW: sx,
        pxH: sz,
        pxD: sy,
        labels: { top: 'S', bottom: 'I', left: 'R', right: 'L' },
        voxel: (x, y, s) => (nz - 1 - y) * plane + s * nx + x,
      }
    case 'sagittal':
      return {
        width: ny,
        height: nz,
        depth: nx,
        pxW: sy,
        pxH: sz,
        pxD: sx,
        labels: { top: 'S', bottom: 'I', left: 'A', right: 'P' },
        voxel: (x, y, s) => (nz - 1 - y) * plane + x * nx + s,
      }
  }
}

function clipRect(axis: SliceAxis, s: ViewerSettings): { x: [number, number]; y: [number, number]; slice: [number, number] } {
  const flip = (r: [number, number]): [number, number] => [1 - r[1], 1 - r[0]]
  if (axis === 'axial') return { x: s.clipX, y: s.clipY, slice: s.clipZ }
  if (axis === 'coronal') return { x: s.clipX, y: flip(s.clipZ), slice: s.clipY }
  return { x: s.clipY, y: flip(s.clipZ), slice: s.clipX }
}

const AXIS_SHORT: Record<SliceAxis, string> = { axial: 'Ax', coronal: 'Cor', sagittal: 'Sag' }

export function SliceViewer({ volume, settings }: { volume: Volume; settings: ViewerSettings }) {
  const [axis, setAxis] = useState<SliceAxis>('axial')
  const geo = useMemo(() => geometry(volume, axis), [volume, axis])
  const [slice, setSlice] = useState(() => Math.floor(geo.depth / 2))
  const [hover, setHover] = useState<{ x: number; y: number; hu: number } | null>(null)
  const [tool, setTool] = useState<Tool>('probe')
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [draft, setDraft] = useState<{ a: Point; b: Point } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(1)
  const pendingSlice = useRef<number | null>(null)

  useEffect(() => {
    setSlice(pendingSlice.current ?? Math.floor(geo.depth / 2))
    pendingSlice.current = null
    setHover(null)
    setDraft(null)
  }, [geo])

  const range = volume.valueMax - volume.valueMin
  const lo = (settings.windowCenter - settings.windowWidth / 2 - volume.valueMin) / range
  const hi = (settings.windowCenter + settings.windowWidth / 2 - volume.valueMin) / range
  const s = Math.min(slice, geo.depth - 1)
  const huAt = useCallback(
    (x: number, y: number) => volume.valueMin + volume.data[geo.voxel(x, y, s)] * range,
    [volume, geo, s, range],
  )

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
  }, [geo, s, lo, hi, volume])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dir = Math.sign(e.deltaY)
      setSlice((v) => Math.max(0, Math.min(geo.depth - 1, v + dir)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [geo.depth])

  const toImage = (e: PointerEvent<HTMLElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [((e.clientX - rect.left) / rect.width) * geo.width, ((e.clientY - rect.top) / rect.height) * geo.height]
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (tool === 'probe' || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toImage(e)
    setDraft({ a: p, b: p })
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = toImage(e)
    if (draft) setDraft({ a: draft.a, b: p })
    const x = Math.floor(p[0])
    const y = Math.floor(p[1])
    if (x < 0 || y < 0 || x >= geo.width || y >= geo.height) return setHover(null)
    setHover({ x, y, hu: huAt(x, y) })
  }

  const onPointerUp = () => {
    if (!draft || tool === 'probe') return
    const moved = Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1])
    if (moved > 2) {
      setMeasurements((m) => [...m, { id: nextId.current++, kind: tool, axis, slice: s, a: draft.a, b: draft.b }])
    }
    setDraft(null)
  }

  const visible = measurements.filter((m) => m.axis === axis && m.slice === s)
  const statsFor = useCallback(
    (a: Point, b: Point): RoiStats | null => ellipseStats(huAt, geo.width, geo.height, a, b, geo.pxW, geo.pxH),
    [huAt, geo],
  )
  const roiStats = useMemo(() => {
    const map = new Map<number, RoiStats | null>()
    for (const m of measurements) {
      if (m.kind !== 'roi') continue
      const g = m.axis === axis ? geo : geometry(volume, m.axis)
      const at = (x: number, y: number) => volume.valueMin + volume.data[g.voxel(x, y, m.slice)] * range
      map.set(m.id, ellipseStats(at, g.width, g.height, m.a, m.b, g.pxW, g.pxH))
    }
    return map
  }, [measurements, volume, geo, axis, range])

  const clip = clipRect(axis, settings)
  const clipped = clip.x[0] > 0 || clip.x[1] < 1 || clip.y[0] > 0 || clip.y[1] < 1
  const t = (s + 0.5) / geo.depth
  const outsideClip = t < clip.slice[0] || t > clip.slice[1]
  const physW = geo.width * geo.pxW
  const physH = geo.height * geo.pxH
  const wide = physW >= physH
  const unit = volume.metadata.modality === 'CT' ? 'HU' : ''
  const positionMm = t * geo.depth * geo.pxD
  const pct = (p: Point): { left: string; top: string } => ({
    left: `${(p[0] / geo.width) * 100}%`,
    top: `${(p[1] / geo.height) * 100}%`,
  })

  const labelFor = (m: { kind: 'ruler' | 'roi'; a: Point; b: Point }, stats?: RoiStats | null) =>
    m.kind === 'ruler'
      ? `${rulerLengthMm(m.a, m.b, geo.pxW, geo.pxH).toFixed(1)} mm`
      : stats
        ? `${stats.mean.toFixed(0)} ± ${stats.sd.toFixed(0)} ${unit}`
        : '—'

  const renderShape = (m: { kind: 'ruler' | 'roi'; a: Point; b: Point }, key: string, isDraft = false) => {
    const stroke = isDraft ? 'rgb(253 224 71)' : 'rgb(250 204 21)'
    if (m.kind === 'ruler') {
      return (
        <g key={key}>
          <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {[m.a, m.b].map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={geo.width / 160} fill={stroke} />
          ))}
        </g>
      )
    }
    return (
      <ellipse
        key={key}
        cx={(m.a[0] + m.b[0]) / 2}
        cy={(m.a[1] + m.b[1]) / 2}
        rx={Math.abs(m.b[0] - m.a[0]) / 2}
        ry={Math.abs(m.b[1] - m.a[1]) / 2}
        fill="rgb(250 204 21 / 0.08)"
        stroke={stroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    )
  }

  const labelPos = (m: { kind: 'ruler' | 'roi'; a: Point; b: Point }): Point =>
    m.kind === 'ruler'
      ? [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2]
      : [Math.max(m.a[0], m.b[0]), Math.min(m.a[1], m.b[1])]

  const jumpTo = (m: Measurement) => {
    if (m.axis === axis) {
      setSlice(m.slice)
    } else {
      pendingSlice.current = m.slice
      setAxis(m.axis)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">2D Slice (MPR)</h3>
        <ToggleGroup type="single" size="sm" variant="outline" value={axis} onValueChange={(v) => v && setAxis(v as SliceAxis)}>
          <ToggleGroupItem value="axial" className="px-2 text-xs">Axial</ToggleGroupItem>
          <ToggleGroupItem value="coronal" className="px-2 text-xs">Coronal</ToggleGroupItem>
          <ToggleGroupItem value="sagittal" className="px-2 text-xs">Sagittal</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex items-center justify-between gap-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={tool} onValueChange={(v) => v && setTool(v as Tool)}>
          {(
            [
              { id: 'probe', icon: Crosshair, label: 'Probe', tip: `Hover to read ${unit || 'values'}` },
              { id: 'ruler', icon: Ruler, label: 'Ruler', tip: 'Drag to measure distance in mm' },
              { id: 'roi', icon: Circle, label: 'ROI', tip: 'Drag an ellipse for mean, SD, min/max and area' },
            ] as const
          ).map(({ id, icon: Icon, label, tip }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={id} className="gap-1 px-2 text-xs" aria-label={label}>
                  <Icon aria-hidden />
                  {label}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tip}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Button variant="ghost" size="xs" onClick={() => setMeasurements([])} disabled={measurements.length === 0}>
          <Trash2 aria-hidden />
          Clear
        </Button>
      </div>

      <div className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-lg border bg-black">
        <div
          ref={stageRef}
          className={cn('relative touch-none select-none', tool === 'probe' ? 'cursor-crosshair' : 'cursor-cell')}
          style={{ aspectRatio: `${physW} / ${physH}`, width: wide ? '100%' : 'auto', height: wide ? 'auto' : '100%' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDraft(null)}
          onPointerLeave={() => !draft && setHover(null)}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label={`${axis} slice ${s + 1} of ${geo.depth}`} />
          <svg
            viewBox={`0 0 ${geo.width} ${geo.height}`}
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden
          >
            {clipped && (
              <rect
                x={clip.x[0] * geo.width}
                y={clip.y[0] * geo.height}
                width={(clip.x[1] - clip.x[0]) * geo.width}
                height={(clip.y[1] - clip.y[0]) * geo.height}
                fill="none"
                stroke="rgb(95 212 255 / 0.9)"
                strokeDasharray="4 3"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {visible.map((m) => renderShape(m, `m${m.id}`))}
            {draft && tool !== 'probe' && renderShape({ kind: tool, ...draft }, 'draft', true)}
          </svg>
          {visible.map((m) => (
            <span
              key={`l${m.id}`}
              className="pointer-events-none absolute -translate-y-full rounded bg-black/70 px-1 py-px font-mono text-[10px] whitespace-nowrap text-yellow-300"
              style={pct(labelPos(m))}
            >
              {labelFor(m, roiStats.get(m.id))}
            </span>
          ))}
          {draft && tool !== 'probe' && (
            <span
              className="pointer-events-none absolute -translate-y-full rounded bg-black/70 px-1 py-px font-mono text-[10px] whitespace-nowrap text-yellow-200"
              style={pct(labelPos({ kind: tool, ...draft }))}
            >
              {labelFor({ kind: tool, ...draft }, tool === 'roi' ? statsFor(draft.a, draft.b) : null)}
            </span>
          )}
        </div>
        <span className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.top}</span>
        <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.bottom}</span>
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.left}</span>
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[11px] text-amber-300/90">{geo.labels.right}</span>
        <div className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[10px] leading-tight text-white/60">
          W {Math.round(settings.windowWidth)} / L {Math.round(settings.windowCenter)}
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
            <div>scroll to page slices</div>
          )}
        </div>
        {outsideClip && (
          <div className="pointer-events-none absolute top-1.5 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-cyan-300">
            outside clip box
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Slider value={[s]} min={0} max={geo.depth - 1} step={1} onValueChange={([v]) => setSlice(v)} aria-label="Slice index" />
        <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {s + 1}/{geo.depth} · {positionMm.toFixed(0)}mm
        </span>
      </div>

      {measurements.length > 0 && (
        <ul className="divide-y rounded-lg border text-[11px]" aria-label="Measurements">
          {measurements.map((m) => {
            const g = m.axis === axis ? geo : geometry(volume, m.axis)
            const stats = roiStats.get(m.id)
            return (
              <li key={m.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() => jumpTo(m)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary"
                  title="Go to slice"
                >
                  {m.kind === 'ruler' ? <Ruler className="size-3.5 shrink-0 text-yellow-300" /> : <Circle className="size-3.5 shrink-0 text-yellow-300" />}
                  <span className="font-mono tabular-nums">
                    {m.kind === 'ruler'
                      ? `${rulerLengthMm(m.a, m.b, g.pxW, g.pxH).toFixed(1)} mm`
                      : stats
                        ? `μ ${stats.mean.toFixed(0)} σ ${stats.sd.toFixed(0)} [${stats.min.toFixed(0)}, ${stats.max.toFixed(0)}] ${unit} · ${formatArea(stats.areaMm2)}`
                        : 'empty ROI'}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {AXIS_SHORT[m.axis]} {m.slice + 1}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setMeasurements((all) => all.filter((x) => x.id !== m.id))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Delete measurement"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
