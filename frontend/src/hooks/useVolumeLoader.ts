import { useCallback, useRef, useState } from 'react'
import { ApiError, deidentifyFiles, fetchDatasetSlices } from '@/lib/api'
import { buildVolume } from '@/lib/dicom/workerPool'
import type { DatasetInfo, DeidSummary, LoadProgress, Volume } from '@/lib/types'

export type VolumeSource =
  | { kind: 'sample'; dataset: DatasetInfo }
  | { kind: 'upload'; label: string; fileCount: number }

export interface LoadTimings {
  fetchMs: number
  parseMs: number
  assembleMs: number
  workers: number
}

export interface LoaderState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  progress: LoadProgress | null
  error: string | null
  volume: Volume | null
  source: VolumeSource | null
  deid: DeidSummary | null
  timings: LoadTimings | null
  failures: { name: string; reason: string }[]
  warning: string | null
}

const INITIAL: LoaderState = {
  status: 'idle',
  progress: null,
  error: null,
  volume: null,
  source: null,
  deid: null,
  timings: null,
  failures: [],
  warning: null,
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

export function useVolumeLoader() {
  const [state, setState] = useState<LoaderState>(INITIAL)
  const requestRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(
    async (
      source: VolumeSource,
      fetchBuffers: (
        onProgress: (p: LoadProgress) => void,
        signal: AbortSignal,
      ) => Promise<{ buffers: ArrayBuffer[]; names: string[]; deid: DeidSummary | null; warning: string | null }>,
    ) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const token = ++requestRef.current
      const live = () => token === requestRef.current
      const onProgress = (p: LoadProgress) => {
        if (live()) setState((s) => ({ ...s, progress: p }))
      }

      setState((s) => ({ ...s, status: 'loading', error: null, warning: null, progress: null, source }))
      try {
        const t0 = performance.now()
        const { buffers, names, deid, warning } = await fetchBuffers(onProgress, controller.signal)
        const fetchMs = performance.now() - t0
        if (!live()) return
        onProgress({ stage: 'parse', loaded: 0, total: buffers.length })
        const result = await buildVolume(buffers, names, onProgress)
        if (!live()) return
        setState({
          status: 'ready',
          progress: null,
          error: null,
          volume: result.volume,
          source,
          deid,
          timings: { fetchMs, ...result.timings },
          failures: result.failures,
          warning,
        })
      } catch (err) {
        if (!live() || isAbort(err)) return
        setState((s) => ({
          ...s,
          status: 'error',
          progress: null,
          error: err instanceof Error ? err.message : 'Failed to load volume',
        }))
      }
    },
    [],
  )

  const loadSample = useCallback(
    (dataset: DatasetInfo) =>
      run({ kind: 'sample', dataset }, async (onProgress, signal) => {
        const buffers = await fetchDatasetSlices(dataset, onProgress, signal)
        return {
          buffers,
          names: buffers.map((_, i) => `${dataset.id}/IM${String(i + 1).padStart(4, '0')}.dcm`),
          deid: null,
          warning: null,
        }
      }),
    [run],
  )

  const loadFiles = useCallback(
    (files: File[]) => {
      const label = files.length === 1 ? files[0].name : `${files.length} local files`
      return run({ kind: 'upload', label, fileCount: files.length }, async (onProgress, signal) => {
        try {
          const { buffers, summary } = await deidentifyFiles(files, onProgress, signal)
          return { buffers, names: buffers.map((_, i) => `upload-${i + 1}.dcm`), deid: summary, warning: null }
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 0) throw err
          // API unreachable: parse locally instead. Nothing leaves the browser in this path.
          const buffers = await Promise.all(files.map((f) => f.arrayBuffer()))
          return {
            buffers,
            names: files.map((f) => f.name),
            deid: { source: 'local', accepted: files.length, rejected: [], changes: [] },
            warning: 'De-identification service unreachable. Files were parsed locally and never left this device.',
          }
        }
      })
    },
    [run],
  )

  return { state, loadSample, loadFiles }
}
