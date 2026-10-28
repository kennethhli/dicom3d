import type { LoadTimings } from '@/hooks/useVolumeLoader'
import type { Volume } from '@/lib/types'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground/90 tabular-nums">{value}</dd>
    </div>
  )
}

export function StudyInfo({
  volume,
  timings,
  uploadMs,
}: {
  volume: Volume
  timings: LoadTimings | null
  uploadMs: number | null
}) {
  const [nx, ny, nz] = volume.dims
  const [sx, sy, sz] = volume.spacing
  const mb = (volume.gpuData.byteLength / 1024 / 1024).toFixed(1)
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Volume</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono text-[11px]">
        <Row label="Matrix" value={`${nx} × ${ny} × ${nz}`} />
        <Row label="Voxel (mm)" value={`${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)}`} />
        <Row label="Extent (mm)" value={`${(nx * sx).toFixed(0)} × ${(ny * sy).toFixed(0)} × ${(nz * sz).toFixed(0)}`} />
        <Row label="Range" value={`${Math.round(volume.valueMin)} … ${Math.round(volume.valueMax)}`} />
        <Row label="Rescale" value={`× ${volume.metadata.rescaleSlope} + ${volume.metadata.rescaleIntercept}`} />
        <Row label="Sorted by" value={volume.metadata.sortedBy} />
        <Row label="GPU texture" value={`${mb} MB · R16F`} />
        {volume.metadata.skippedSlices > 0 && <Row label="Skipped files" value={String(volume.metadata.skippedSlices)} />}
      </dl>
      {timings && (
        <>
          <h3 className="pt-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Pipeline</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono text-[11px]">
            <Row label="Fetch + de-id" value={`${timings.fetchMs.toFixed(0)} ms`} />
            <Row label={`Parse (${timings.workers} workers)`} value={`${timings.parseMs.toFixed(0)} ms`} />
            <Row label="Assemble volume" value={`${timings.assembleMs.toFixed(0)} ms`} />
            {uploadMs !== null && <Row label="GPU upload" value={`${uploadMs.toFixed(0)} ms`} />}
          </dl>
        </>
      )}
    </div>
  )
}
