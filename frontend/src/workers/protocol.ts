import type { ParsedSlice, Volume } from '@/lib/types'

export type WorkerRequest =
  | { id: number; type: 'parse'; buffers: ArrayBuffer[]; startIndex: number; names: string[] }
  | { id: number; type: 'assemble'; slices: ParsedSlice[]; skipped: number }

export type WorkerResponse =
  | { id: number; type: 'progress'; done: number }
  | { id: number; type: 'parsed'; slices: ParsedSlice[]; failures: { name: string; reason: string }[] }
  | { id: number; type: 'volume'; volume: Volume; elapsedMs: number }
  | { id: number; type: 'error'; message: string }
