import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fetchDeidReport, type DeidReport } from '@/lib/api'
import type { DeidChange, DeidSummary } from '@/lib/types'
import type { VolumeSource } from '@/hooks/useVolumeLoader'

const ACTION_TONE: Record<string, string> = {
  removed: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  replaced: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  emptied: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
}

function ChangeRow({ change }: { change: DeidChange }) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{change.tag}</td>
      <td className="py-1.5 pr-2 text-xs">{change.keyword}</td>
      <td className="py-1.5 pr-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${ACTION_TONE[change.action] ?? ''}`}>
          {change.action}
          {change.count && change.count > 1 ? ` ×${change.count}` : ''}
        </span>
      </td>
      <td className="max-w-40 truncate py-1.5 font-mono text-[11px] text-muted-foreground/80 line-through decoration-rose-400/60" title={change.original ?? ''}>
        {change.original ?? ''}
      </td>
    </tr>
  )
}

export function PrivacyDialog({ source, deid }: { source: VolumeSource | null; deid: DeidSummary | null }) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<DeidReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const datasetId = source?.kind === 'sample' ? source.dataset.id : null

  useEffect(() => {
    if (!open || !datasetId) return
    const controller = new AbortController()
    setReport(null)
    setError(null)
    fetchDeidReport(datasetId, controller.signal)
      .then(setReport)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message)
      })
    return () => controller.abort()
  }, [open, datasetId])

  if (!source) return null
  const local = deid?.source === 'local'
  const changes = datasetId ? (report?.changes ?? []) : (deid?.changes ?? [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Badge
            variant="outline"
            className={local ? 'border-amber-500/40 text-amber-200' : 'border-emerald-500/40 text-emerald-300'}
          >
            <ShieldCheck aria-hidden />
            {local ? 'Local only' : 'De-identified'}
          </Badge>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>De-identification report</DialogTitle>
          <DialogDescription>
            {local
              ? 'The API was unreachable, so these files were decoded entirely in your browser and never uploaded. Their headers were not scrubbed.'
              : source.kind === 'sample' && source.dataset.source === 'tcia'
                ? 'This real scan was already anonymised by The Cancer Imaging Archive and is scrubbed again by the API before it is sent. Only tag names are reported. Geometry and pixel data are kept intact.'
                : datasetId
                ? 'Each sample slice is scrubbed on the server before it is sent. The sample PHI is synthetic, so original values are shown for illustration. Geometry and pixel data are kept intact.'
                : 'Your files were scrubbed by the API before parsing. Original values are never sent back to the browser.'}
          </DialogDescription>
        </DialogHeader>
        {!local && (
          <ScrollArea className="max-h-[55vh] pr-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {datasetId && !report && !error && <p className="text-sm text-muted-foreground">Loading report…</p>}
            {deid && !datasetId && (
              <p className="mb-2 text-xs text-muted-foreground">
                {deid.accepted} file(s) accepted
                {deid.rejected.length > 0 && `, ${deid.rejected.length} rejected (${deid.rejected.slice(0, 3).join(', ')}…)`}
              </p>
            )}
            {changes.length > 0 && (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b text-[10px] tracking-wider text-muted-foreground uppercase">
                    <th className="pb-1.5 font-medium">Tag</th>
                    <th className="pb-1.5 font-medium">Attribute</th>
                    <th className="pb-1.5 font-medium">Action</th>
                    <th className="pb-1.5 font-medium">{datasetId ? 'Original' : ''}</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <ChangeRow key={`${c.tag}-${c.keyword}`} change={c} />
                  ))}
                </tbody>
              </table>
            )}
            {report && (
              <div className="mt-4 space-y-1.5">
                <h4 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Preserved for reconstruction
                </h4>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  {Object.entries(report.preserved).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate text-emerald-300/90">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
