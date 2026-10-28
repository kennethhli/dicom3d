import type { LoadProgress, ParsedSlice, Volume } from '@/lib/types'
import type { WorkerRequest, WorkerResponse } from '@/workers/protocol'

export interface BuildResult {
  volume: Volume
  failures: { name: string; reason: string }[]
  timings: { parseMs: number; assembleMs: number; workers: number }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type RequestBody = DistributiveOmit<WorkerRequest, 'id'>

type Pending = {
  resolve: (msg: WorkerResponse) => void
  reject: (err: Error) => void
  onProgress?: (done: number) => void
}

class DicomWorker {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor() {
    this.worker = new Worker(new URL('../../workers/dicom.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.type === 'progress') {
        p.onProgress?.(msg.done)
        return
      }
      this.pending.delete(msg.id)
      if (msg.type === 'error') p.reject(new Error(msg.message))
      else p.resolve(msg)
    }
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Worker crashed')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }

  request(
    req: RequestBody,
    transfer: Transferable[],
    onProgress?: (done: number) => void,
  ): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker.postMessage({ ...req, id } as WorkerRequest, transfer)
    })
  }
}

let pool: DicomWorker[] | null = null

export function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
  return Math.max(1, Math.min(6, cores - 1))
}

function getPool(): DicomWorker[] {
  if (!pool) pool = Array.from({ length: poolSize() }, () => new DicomWorker())
  return pool
}

/**
 * Parse slices in parallel across the worker pool, then assemble the volume in a
 * single worker. Buffers are transferred (zero-copy) and become detached.
 */
export async function buildVolume(
  buffers: ArrayBuffer[],
  names: string[],
  onProgress?: (p: LoadProgress) => void,
): Promise<BuildResult> {
  const workers = getPool()
  const total = buffers.length
  const chunk = Math.ceil(total / workers.length)
  const doneByWorker = new Array<number>(workers.length).fill(0)
  const t0 = performance.now()

  const jobs = workers.map((w, wi) => {
    const start = wi * chunk
    const part = buffers.slice(start, start + chunk)
    if (part.length === 0) return Promise.resolve({ slices: [] as ParsedSlice[], failures: [] })
    return w
      .request({ type: 'parse', buffers: part, startIndex: start, names: names.slice(start, start + chunk) }, part, (d) => {
        doneByWorker[wi] = d
        onProgress?.({ stage: 'parse', loaded: doneByWorker.reduce((a, b) => a + b, 0), total })
      })
      .then((msg) => {
        if (msg.type !== 'parsed') throw new Error('Unexpected worker response')
        return { slices: msg.slices, failures: msg.failures }
      })
  })

  const parsed = await Promise.all(jobs)
  const slices = parsed.flatMap((p) => p.slices)
  const failures = parsed.flatMap((p) => p.failures)
  const parseMs = performance.now() - t0

  if (slices.length === 0) {
    const reason = failures[0]?.reason ?? 'no files'
    throw new Error(`None of the ${total} file(s) could be decoded: ${reason}`)
  }

  onProgress?.({ stage: 'assemble', loaded: 0, total: 1 })
  const msg = await workers[0].request(
    { type: 'assemble', slices, skipped: failures.length },
    slices.map((s) => s.values.buffer),
  )
  if (msg.type !== 'volume') throw new Error('Unexpected worker response')
  onProgress?.({ stage: 'assemble', loaded: 1, total: 1 })

  return { volume: msg.volume, failures, timings: { parseMs, assembleMs: msg.elapsedMs, workers: workers.length } }
}
