export type Vec3 = [number, number, number]

export interface DatasetInfo {
  id: string
  name: string
  description: string
  body_part: string
  modality: string
  rows: number
  cols: number
  slices: number
  pixel_spacing_mm: number
  slice_thickness_mm: number
  window_center: number
  window_width: number
  source: 'synthetic' | 'tcia'
  attribution: string | null
  license_url: string | null
  cached: boolean
}

/** One decoded DICOM slice, values already rescaled (HU for CT). */
export interface ParsedSlice {
  index: number
  rows: number
  cols: number
  values: Float32Array
  min: number
  max: number
  position: Vec3 | null
  orientation: [number, number, number, number, number, number] | null
  pixelSpacing: [number, number]
  sliceThickness: number | null
  sliceLocation: number | null
  instanceNumber: number | null
  seriesUid: string | null
  seriesDescription: string | null
  modality: string
  windowCenter: number | null
  windowWidth: number | null
  rescaleSlope: number
  rescaleIntercept: number
  photometric: string
}

export interface VolumeMetadata {
  modality: string
  seriesDescription: string
  sliceCount: number
  skippedSlices: number
  rescaleSlope: number
  rescaleIntercept: number
  sortedBy: 'position' | 'instance' | 'file-order'
}

/**
 * Reconstructed volume. ``data`` is normalised to [0, 1] across
 * [valueMin, valueMax]; layout is x-fastest (column), then row, then slice.
 */
export interface Volume {
  data: Float32Array
  /** ``data`` as IEEE half floats for the R16F GPU texture. */
  gpuData: Uint16Array
  dims: Vec3
  spacing: Vec3
  valueMin: number
  valueMax: number
  histogram: Uint32Array
  defaultWindow: { center: number; width: number }
  metadata: VolumeMetadata
}

export type RenderMode = 'dvr' | 'mip' | 'minip' | 'iso'
export type Colormap = 'grayscale' | 'bone' | 'flesh' | 'hot' | 'cool'

export interface ViewerSettings {
  windowCenter: number
  windowWidth: number
  threshold: [number, number]
  opacity: number
  brightness: number
  mode: RenderMode
  colormap: Colormap
  clipX: [number, number]
  clipY: [number, number]
  clipZ: [number, number]
  quality: 'performance' | 'balanced' | 'high'
  shading: boolean
}

export interface PerfStats {
  fps: number
  frameMs: number
  cpuMs: number
  gpuMs: number | null
  drawingBuffer: [number, number]
  steps: number
}

export interface LoadProgress {
  stage: 'download' | 'deidentify' | 'parse' | 'assemble' | 'upload'
  loaded: number
  total: number
}

export interface DeidChange {
  keyword: string
  tag: string
  action: string
  count?: number
  original?: string | null
}

export interface DeidSummary {
  source: 'server' | 'local'
  accepted: number
  rejected: string[]
  changes: DeidChange[]
}
