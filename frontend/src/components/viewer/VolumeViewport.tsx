import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { VolumeRenderer, type CameraView } from '@/render/VolumeRenderer'
import type { PerfStats, ViewerSettings, Volume } from '@/lib/types'

export interface VolumeViewportHandle {
  setView: (view: CameraView) => void
  screenshot: () => string | null
}

interface Props {
  volume: Volume | null
  settings: ViewerSettings | null
  onStats: (stats: PerfStats) => void
  onUploaded: (ms: number) => void
  onError: (message: string) => void
}

export const VolumeViewport = forwardRef<VolumeViewportHandle, Props>(function VolumeViewport(
  { volume, settings, onStats, onUploaded, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<VolumeRenderer | null>(null)
  const [webglError, setWebglError] = useState<string | null>(null)
  const callbacks = useRef({ onStats, onUploaded, onError })
  useLayoutEffect(() => {
    callbacks.current = { onStats, onUploaded, onError }
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    try {
      rendererRef.current = new VolumeRenderer(el, (s) => callbacks.current.onStats(s))
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL 2 is not available')
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    const r = rendererRef.current
    if (!r || !volume) return
    try {
      callbacks.current.onUploaded(r.setVolume(volume))
    } catch (err) {
      callbacks.current.onError(err instanceof Error ? err.message : 'Failed to upload the volume to the GPU')
    }
  }, [volume])

  useEffect(() => {
    if (settings && volume) rendererRef.current?.setSettings(settings)
  }, [settings, volume])

  useImperativeHandle(ref, () => ({
    setView: (view) => rendererRef.current?.setView(view),
    screenshot: () => rendererRef.current?.screenshot() ?? null,
  }))

  return (
    <div ref={containerRef} className="absolute inset-0">
      {webglError && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          <div>
            <p className="font-medium text-foreground">3D rendering is unavailable</p>
            <p className="mt-1 max-w-sm">
              DICOM3D needs WebGL 2 with float textures. Try a recent Chrome, Edge, Firefox or Safari. ({webglError})
            </p>
          </div>
        </div>
      )}
    </div>
  )
})
