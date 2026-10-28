import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { PerfStats } from '@/lib/types'

const HISTORY = 48

function fpsTone(fps: number) {
  if (fps >= 50) return 'text-emerald-400'
  if (fps >= 28) return 'text-amber-300'
  return 'text-rose-400'
}

const MODE_LABEL: Record<PerfStats['mode'], string> = {
  idle: 'Idle',
  interactive: 'Adaptive',
  continuous: 'Continuous',
}

export function PerfMonitor({ stats, uploadMs }: { stats: PerfStats | null; uploadMs: number | null }) {
  const [history, setHistory] = useState<number[]>([])

  useEffect(() => {
    if (!stats || stats.mode === 'idle') return
    setHistory((h) => [...h.slice(-(HISTORY - 1)), stats.fps])
  }, [stats])

  if (!stats) return null
  const idle = stats.mode === 'idle'
  const max = Math.max(70, ...history)
  const points = history.map((v, i) => `${(i / (HISTORY - 1)) * 100},${28 - (v / max) * 26}`).join(' ')

  return (
    <div className="pointer-events-none w-28 rounded-lg border border-white/10 bg-black/55 p-2.5 font-mono text-[11px] text-white/70 shadow-lg backdrop-blur-md sm:w-44">
      <div className="flex items-baseline justify-between">
        <span
          className={cn(
            'rounded px-1 text-[9px] tracking-widest uppercase',
            idle ? 'bg-white/5 text-white/45' : 'bg-cyan-400/15 text-cyan-300',
          )}
        >
          {MODE_LABEL[stats.mode]}
        </span>
        <span className={cn('text-lg leading-none font-semibold tabular-nums', idle ? 'text-white/50' : fpsTone(stats.fps))}>
          {idle ? '—' : stats.fps.toFixed(0)}
          <span className="ml-0.5 text-[10px] font-normal text-white/50">fps</span>
        </span>
      </div>
      <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="mt-1.5 hidden h-7 w-full sm:block" aria-hidden>
        <line x1="0" x2="100" y1={28 - (60 / max) * 26} y2={28 - (60 / max) * 26} stroke="currentColor" strokeOpacity="0.15" strokeDasharray="2 2" />
        {history.length > 1 && (
          <polyline points={points} fill="none" stroke="rgb(95 212 255)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <dl className="mt-1.5 hidden grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 tabular-nums sm:grid">
        <dt>Frame</dt>
        <dd className="text-right text-white/90">{stats.frameMs === null ? '—' : `${stats.frameMs.toFixed(1)} ms`}</dd>
        <dt>GPU</dt>
        <dd className="text-right text-white/90">{stats.gpuMs === null ? 'n/a' : `${stats.gpuMs.toFixed(2)} ms`}</dd>
        <dt>CPU submit</dt>
        <dd className="text-right text-white/90">{stats.cpuMs.toFixed(2)} ms</dd>
        <dt>Resolution</dt>
        <dd className="text-right text-white/90">{Math.round(stats.resolutionScale * 100)}%</dd>
        <dt>Ray steps</dt>
        <dd className="text-right text-white/90">{stats.steps}</dd>
        <dt>Buffer</dt>
        <dd className="text-right text-white/90">
          {stats.drawingBuffer[0]}×{stats.drawingBuffer[1]}
        </dd>
        {uploadMs !== null && (
          <>
            <dt>Tex upload</dt>
            <dd className="text-right text-white/90">{uploadMs.toFixed(0)} ms</dd>
          </>
        )}
      </dl>
    </div>
  )
}
