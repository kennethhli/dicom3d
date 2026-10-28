import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { AlertTriangle, Camera, FileUp, FolderOpen, MousePointer2, RefreshCw, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { ControlPanel } from '@/components/controls/ControlPanel'
import { LoadingOverlay } from '@/components/LoadingOverlay'
import { PrivacyDialog } from '@/components/PrivacyDialog'
import { StudyInfo } from '@/components/StudyInfo'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PerfMonitor } from '@/components/viewer/PerfMonitor'
import { SliceViewer } from '@/components/viewer/SliceViewer'
import { VolumeViewport, type VolumeViewportHandle } from '@/components/viewer/VolumeViewport'
import { useVolumeLoader } from '@/hooks/useVolumeLoader'
import { fetchDatasets } from '@/lib/api'
import { filesFromDataTransfer, filterDicomCandidates } from '@/lib/files'
import { applyPreset, CT_PRESETS, initialSettings } from '@/lib/presets'
import type { DatasetInfo, PerfStats, ViewerSettings } from '@/lib/types'
import type { CameraView } from '@/render/VolumeRenderer'
import { cn } from '@/lib/utils'

const VIEWS: { id: CameraView; label: string; title: string }[] = [
  { id: 'anterior', label: 'A', title: 'Anterior view' },
  { id: 'posterior', label: 'P', title: 'Posterior view' },
  { id: 'left', label: 'L', title: 'Left lateral view' },
  { id: 'right', label: 'R', title: 'Right lateral view' },
  { id: 'superior', label: 'S', title: 'Superior view' },
  { id: 'inferior', label: 'I', title: 'Inferior view' },
]

const UPLOAD_ID = '__upload__'

export default function App() {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null)
  const [datasetsError, setDatasetsError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] = useState<ViewerSettings | null>(null)
  const [presetId, setPresetId] = useState<string | null>(null)
  const [stats, setStats] = useState<PerfStats | null>(null)
  const [uploadMs, setUploadMs] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const viewportRef = useRef<VolumeViewportHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const { state, loadSample, loadFiles } = useVolumeLoader()
  const { volume } = state

  const loadDatasets = useCallback(() => {
    setDatasetsError(null)
    const controller = new AbortController()
    fetchDatasets(controller.signal)
      .then(setDatasets)
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        setDatasets([])
        setDatasetsError(err.message)
      })
    return controller
  }, [])

  useEffect(() => {
    const controller = loadDatasets()
    return () => controller.abort()
  }, [loadDatasets])

  useEffect(() => {
    if (selectedId || !datasets?.length) return
    setSelectedId(datasets[0].id)
    loadSample(datasets[0])
  }, [datasets, selectedId, loadSample])

  const sourceId = state.source?.kind === 'sample' ? state.source.dataset.id : null
  useEffect(() => {
    if (!volume) return
    const init = initialSettings(volume, sourceId)
    setSettings(init.settings)
    setPresetId(init.presetId)
  }, [volume]) // eslint-disable-line react-hooks/exhaustive-deps -- re-initialise only when a new volume arrives

  useEffect(() => {
    if (state.warning) toast.warning(state.warning)
  }, [state.warning])

  useEffect(() => {
    if (state.failures.length > 0) {
      toast.message(`${state.failures.length} file(s) skipped`, {
        description: state.failures[0].reason,
      })
    }
  }, [state.failures])

  const patchSettings = useCallback((patch: Partial<ViewerSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    if (
      'windowCenter' in patch ||
      'windowWidth' in patch ||
      'threshold' in patch ||
      'mode' in patch ||
      'colormap' in patch ||
      'opacity' in patch
    ) {
      setPresetId(null)
    }
  }, [])

  const choosePreset = useCallback(
    (id: string) => {
      const preset = CT_PRESETS.find((p) => p.id === id)
      if (!preset || !volume) return
      setSettings((s) => (s ? applyPreset(preset, s, volume) : s))
      setPresetId(id)
    },
    [volume],
  )

  const handleFiles = useCallback(
    (files: File[]) => {
      const candidates = filterDicomCandidates(files)
      if (candidates.length === 0) {
        toast.error('No DICOM files found', { description: 'Drop a folder or a set of .dcm slices from one series.' })
        return
      }
      setSelectedId(UPLOAD_ID)
      loadFiles(candidates)
    },
    [loadFiles],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= CT_PRESETS.length && volume?.metadata.modality === 'CT') choosePreset(CT_PRESETS[n - 1].id)
      const view = VIEWS.find((v) => v.label.toLowerCase() === e.key.toLowerCase())
      if (view) viewportRef.current?.setView(view.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [choosePreset, volume])

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    handleFiles(await filesFromDataTransfer(e.dataTransfer))
  }

  const saveScreenshot = () => {
    const url = viewportRef.current?.screenshot()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `dicom3d-${Date.now()}.png`
    a.click()
  }

  const sourceLabel =
    state.source?.kind === 'sample' ? state.source.dataset.name : state.source?.kind === 'upload' ? state.source.label : ''
  const loading = state.status === 'loading'

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className="flex h-dvh flex-col bg-background text-foreground"
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-sky-600 text-[11px] font-black text-slate-950 shadow-[0_0_24px_-4px] shadow-cyan-400/60">
              3D
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight">DICOM3D</h1>
              <p className="hidden text-[11px] text-muted-foreground sm:block">GPU volumetric CT viewer</p>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
            <Select
              value={selectedId ?? undefined}
              onValueChange={(id) => {
                const ds = datasets?.find((d) => d.id === id)
                if (!ds) return
                setSelectedId(id)
                loadSample(ds)
              }}
              disabled={!datasets?.length}
            >
              <SelectTrigger className="w-full min-w-0 sm:w-72" aria-label="Sample dataset">
                <SelectValue placeholder={datasets === null ? 'Loading datasets…' : 'Choose a sample series'} />
              </SelectTrigger>
              <SelectContent>
                {datasets?.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    <span className="truncate">{d.name}</span>
                    <span className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">{d.slices} sl</span>
                  </SelectItem>
                ))}
                {selectedId === UPLOAD_ID && (
                  <SelectItem value={UPLOAD_ID} disabled>
                    {sourceLabel || 'Local upload'}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <PrivacyDialog source={state.source} deid={state.deid} />
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => {
                handleFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <FileUp aria-hidden />
              <span className="hidden sm:inline">Open files</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => folderInputRef.current?.click()}>
              <FolderOpen aria-hidden />
              <span className="hidden sm:inline">Folder</span>
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[300px_minmax(0,1fr)_340px] lg:overflow-hidden">
          <aside className="order-3 border-t bg-sidebar/60 lg:order-1 lg:min-h-0 lg:border-t-0 lg:border-r">
            <ScrollArea className="lg:h-full">
              {volume && settings ? (
                <ControlPanel
                  volume={volume}
                  settings={settings}
                  presetId={presetId}
                  onChange={patchSettings}
                  onPreset={choosePreset}
                  onResetClip={() => patchSettings({ clipX: [0, 1], clipY: [0, 1], clipZ: [0, 1] })}
                />
              ) : (
                <div className="space-y-3 p-4">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />
                  ))}
                </div>
              )}
            </ScrollArea>
          </aside>

          <main className="relative order-1 h-[62vh] min-h-[360px] shrink-0 overflow-hidden bg-[radial-gradient(ellipse_at_center,oklch(0.24_0.03_240)_0%,oklch(0.12_0.01_250)_70%)] lg:order-2 lg:h-auto">
            <VolumeViewport
              ref={viewportRef}
              volume={volume}
              settings={settings}
              onStats={setStats}
              onUploaded={setUploadMs}
              onError={(m) => toast.error('GPU upload failed', { description: m })}
            />

            {volume && (
              <>
                <div className="pointer-events-none absolute top-3 left-3 max-w-[60%] space-y-0.5 font-mono text-[11px] text-white/70">
                  <div className="truncate text-white/90">{sourceLabel}</div>
                  <div>
                    {volume.metadata.modality} · {volume.dims.join('×')} ·{' '}
                    {settings && `W ${Math.round(settings.windowWidth)} L ${Math.round(settings.windowCenter)}`}
                  </div>
                </div>
                <div className="absolute top-3 right-3">
                  <PerfMonitor stats={stats} uploadMs={uploadMs} />
                </div>
                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-white/10 bg-black/50 p-1 backdrop-blur-md">
                  {VIEWS.map((v) => (
                    <Tooltip key={v.id}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="font-mono text-xs text-white/80 hover:text-white"
                          onClick={() => viewportRef.current?.setView(v.id)}
                          aria-label={v.title}
                        >
                          {v.label}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {v.title} <kbd className="ml-1 opacity-60">{v.label}</kbd>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  <div className="mx-0.5 h-5 w-px bg-white/15" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="text-white/80" onClick={saveScreenshot} aria-label="Save screenshot">
                        <Camera aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Save PNG</TooltipContent>
                  </Tooltip>
                </div>
                <div className="pointer-events-none absolute bottom-4 left-3 hidden items-center gap-1.5 text-[11px] text-white/45 xl:flex">
                  <MousePointer2 className="size-3" aria-hidden />
                  Drag to rotate · Right-drag to pan · Scroll to zoom
                </div>
              </>
            )}

            {loading && <LoadingOverlay progress={state.progress} label={sourceLabel} />}

            {!loading && state.status === 'error' && (
              <div className="absolute inset-0 z-10 grid place-items-center p-6">
                <div className="max-w-sm rounded-xl border border-destructive/40 bg-card/95 p-5 text-center shadow-2xl">
                  <AlertTriangle className="mx-auto size-6 text-destructive" aria-hidden />
                  <p className="mt-2 text-sm font-medium">Couldn’t load this series</p>
                  <p className="mt-1 text-xs text-muted-foreground">{state.error}</p>
                  {state.source?.kind === 'sample' && (
                    <Button size="sm" variant="outline" className="mt-4" onClick={() => state.source?.kind === 'sample' && loadSample(state.source.dataset)}>
                      <RefreshCw aria-hidden />
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            )}

            {!loading && !volume && state.status !== 'error' && datasets !== null && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <div className="max-w-md text-center">
                  <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-dashed border-primary/40 text-primary">
                    <Upload className="size-5" aria-hidden />
                  </div>
                  <p className="mt-3 text-sm font-medium">
                    {datasetsError ? 'The DICOM3D API is offline' : 'Drop a DICOM series to begin'}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {datasetsError
                      ? 'Sample datasets come from the FastAPI backend on port 8765. You can still drop local .dcm files: they will be parsed entirely in your browser.'
                      : 'Drag a folder or a set of .dcm slices anywhere onto this window.'}
                  </p>
                  {datasetsError && (
                    <Button size="sm" variant="outline" className="mt-4" onClick={() => loadDatasets()}>
                      <RefreshCw aria-hidden />
                      Retry connection
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div
              className={cn(
                'pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary/70 bg-primary/10 backdrop-blur-sm transition-opacity',
                dragging ? 'opacity-100' : 'opacity-0',
              )}
              aria-hidden={!dragging}
            >
              <div className="text-center">
                <Upload className="mx-auto size-8 text-primary" aria-hidden />
                <p className="mt-2 text-sm font-medium">Drop DICOM files or a folder</p>
                <p className="text-xs text-muted-foreground">Headers are de-identified by the API before parsing</p>
              </div>
            </div>
          </main>

          <aside className="order-2 border-t bg-sidebar/60 lg:order-3 lg:min-h-0 lg:border-t-0 lg:border-l">
            <ScrollArea className="lg:h-full">
              <div className="space-y-6 p-4">
                {volume && settings ? (
                  <>
                    <SliceViewer volume={volume} settings={settings} />
                    <StudyInfo volume={volume} timings={state.timings} uploadMs={uploadMs} />
                  </>
                ) : (
                  <>
                    <div className="aspect-square animate-pulse rounded-lg bg-muted/50" />
                    <div className="h-40 animate-pulse rounded-lg bg-muted/50" />
                  </>
                )}
              </div>
            </ScrollArea>
          </aside>
        </div>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  )
}
