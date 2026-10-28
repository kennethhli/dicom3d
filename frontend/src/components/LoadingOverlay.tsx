import { Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import type { LoadProgress } from '@/lib/types'

const STAGE_LABEL: Record<LoadProgress['stage'], string> = {
  download: 'Downloading de-identified series',
  deidentify: 'Uploading for de-identification',
  parse: 'Parsing DICOM in Web Workers',
  assemble: 'Reconstructing 3D volume',
  upload: 'Uploading texture to GPU',
}

export function LoadingOverlay({ progress, label }: { progress: LoadProgress | null; label: string }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null
  const detail =
    progress?.stage === 'parse'
      ? `${progress.loaded} / ${progress.total} slices`
      : progress && (progress.stage === 'download' || progress.stage === 'deidentify')
        ? `${(progress.loaded / 1024 / 1024).toFixed(1)} MB`
        : null
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-background/55 backdrop-blur-sm">
      <div className="w-72 rounded-xl border bg-card/90 p-4 shadow-2xl" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          {progress ? STAGE_LABEL[progress.stage] : 'Connecting…'}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{label}</p>
        <Progress value={pct ?? 5} className="mt-3 h-1.5" />
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>{detail}</span>
          <span>{pct !== null ? `${pct}%` : ''}</span>
        </div>
      </div>
    </div>
  )
}
