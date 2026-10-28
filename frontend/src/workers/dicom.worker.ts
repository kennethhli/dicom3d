/// <reference lib="webworker" />
import { assembleVolume } from '@/lib/dicom/assemble'
import { parseSlice } from '@/lib/dicom/parse'
import type { ParsedSlice } from '@/lib/types'
import type { WorkerRequest, WorkerResponse } from './protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer)
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.type === 'parse') {
      const slices: ParsedSlice[] = []
      const failures: { name: string; reason: string }[] = []
      req.buffers.forEach((buffer, i) => {
        try {
          slices.push(parseSlice(buffer, req.startIndex + i))
        } catch (err) {
          failures.push({ name: req.names[i] ?? `#${req.startIndex + i}`, reason: (err as Error).message })
        }
        if (i % 4 === 3 || i === req.buffers.length - 1) post({ id: req.id, type: 'progress', done: i + 1 })
      })
      post(
        { id: req.id, type: 'parsed', slices, failures },
        slices.map((s) => s.values.buffer),
      )
      return
    }

    const t0 = performance.now()
    const volume = assembleVolume(req.slices, req.skipped)
    post({ id: req.id, type: 'volume', volume, elapsedMs: performance.now() - t0 }, [
      volume.data.buffer,
      volume.histogram.buffer,
    ])
  } catch (err) {
    post({ id: req.id, type: 'error', message: (err as Error).message })
  }
}
