import { useMemo } from 'react'
import type { ViewerSettings, Volume } from '@/lib/types'

/** Log-scaled intensity histogram with the window and threshold ranges overlaid. */
export function Histogram({ volume, settings }: { volume: Volume; settings: ViewerSettings }) {
  const path = useMemo(() => {
    const h = volume.histogram
    let max = 0
    // Skip the first bin (air / padding) so it does not flatten everything else.
    for (let i = 1; i < h.length; i++) max = Math.max(max, Math.log1p(h[i]))
    if (max === 0) return ''
    let d = 'M0,40'
    for (let i = 0; i < h.length; i++) {
      const x = (i / (h.length - 1)) * 100
      const y = 40 - Math.min(1, Math.log1p(h[i]) / max) * 38
      d += ` L${x.toFixed(2)},${y.toFixed(2)}`
    }
    return `${d} L100,40 Z`
  }, [volume])

  const range = volume.valueMax - volume.valueMin
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - volume.valueMin) / range) * 100))
  const wLo = pct(settings.windowCenter - settings.windowWidth / 2)
  const wHi = pct(settings.windowCenter + settings.windowWidth / 2)
  const tLo = pct(settings.threshold[0])
  const tHi = pct(settings.threshold[1])

  return (
    <div className="space-y-1">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-14 w-full rounded-md border bg-black/30" aria-hidden>
        <rect x={tLo} y="0" width={Math.max(0, tHi - tLo)} height="40" fill="rgb(95 212 255 / 0.10)" />
        <path d={path} fill="rgb(255 255 255 / 0.28)" />
        <polyline
          points={`0,40 ${wLo},40 ${wHi},2 100,2`}
          fill="none"
          stroke="rgb(95 212 255)"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground tabular-nums">
        <span>{Math.round(volume.valueMin)}</span>
        <span>{Math.round((volume.valueMin + volume.valueMax) / 2)}</span>
        <span>{Math.round(volume.valueMax)}</span>
      </div>
    </div>
  )
}
