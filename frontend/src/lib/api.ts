import { decodeBundle } from '@/lib/dicom/bundle'
import type { DatasetInfo, DeidChange, DeidSummary, LoadProgress } from '@/lib/types'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let detail = res.statusText
  try {
    const body = (await res.json()) as { detail?: string }
    if (body.detail) detail = body.detail
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, detail || `Request failed (${res.status})`)
}

export async function fetchDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
  const res = await fetch(`${API_BASE}/api/datasets`, { signal })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as DatasetInfo[]
}

/** Downloads a de-identified sample series with streamed progress. */
export async function fetchDatasetSlices(
  dataset: DatasetInfo,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer[]> {
  const res = await fetch(`${API_BASE}/api/datasets/${encodeURIComponent(dataset.id)}/bundle`, { signal })
  if (!res.ok) throw await errorFrom(res)
  // Content-Length reflects the gzip size, so estimate the decoded size instead.
  const expected = dataset.rows * dataset.cols * dataset.slices * 2 + dataset.slices * 2048
  if (!res.body) {
    const buf = await res.arrayBuffer()
    return decodeBundle(buf)
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress?.({ stage: 'download', loaded: Math.min(received, expected * 0.99), total: expected })
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  onProgress?.({ stage: 'download', loaded: expected, total: expected })
  return decodeBundle(merged.buffer)
}

/** Sends local files to the API for de-identification and returns the scrubbed copies. */
export function deidentifyFiles(
  files: File[],
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<{ buffers: ArrayBuffer[]; summary: DeidSummary }> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/api/deidentify`)
    xhr.responseType = 'arraybuffer'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ stage: 'deidentify', loaded: e.loaded, total: e.total })
    }
    xhr.onerror = () => reject(new ApiError(0, 'Could not reach the de-identification service'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(new TextDecoder().decode(xhr.response as ArrayBuffer)) as { detail?: string }
          if (body.detail) detail = body.detail
        } catch {
          /* keep default */
        }
        reject(new ApiError(xhr.status, detail))
        return
      }
      try {
        const buffers = decodeBundle(xhr.response as ArrayBuffer)
        const header = xhr.getResponseHeader('X-Deid-Report')
        const report = header
          ? (JSON.parse(atob(header)) as { accepted: number; rejected: string[]; changes: DeidChange[] })
          : { accepted: buffers.length, rejected: [], changes: [] }
        resolve({ buffers, summary: { source: 'server', ...report } })
      } catch (err) {
        reject(err as Error)
      }
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

export interface DeidReport {
  dataset_id: string
  slice_index: number
  changes: DeidChange[]
  preserved: Record<string, string>
}

export async function fetchDeidReport(datasetId: string, signal?: AbortSignal): Promise<DeidReport> {
  const res = await fetch(`${API_BASE}/api/datasets/${encodeURIComponent(datasetId)}/deid-report`, { signal })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as DeidReport
}
