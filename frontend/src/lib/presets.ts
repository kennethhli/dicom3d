import type { Colormap, RenderMode, ViewerSettings, Volume } from '@/lib/types'

export interface Preset {
  id: string
  label: string
  hint: string
  windowCenter: number
  windowWidth: number
  threshold: [number, number]
  opacity: number
  mode: RenderMode
  colormap: Colormap
}

/** Window values follow common radiology defaults (W/L in HU). */
export const CT_PRESETS: Preset[] = [
  {
    id: 'bone',
    label: 'Bone',
    hint: 'W 1500 / L 450 · skeleton',
    windowCenter: 450,
    windowWidth: 1500,
    threshold: [180, 3071],
    opacity: 0.85,
    mode: 'dvr',
    colormap: 'bone',
  },
  {
    id: 'soft',
    label: 'Soft Tissue',
    hint: 'W 400 / L 40 · organs, muscle',
    windowCenter: 40,
    windowWidth: 400,
    threshold: [-160, 3071],
    opacity: 0.18,
    mode: 'dvr',
    colormap: 'flesh',
  },
  {
    id: 'lung',
    label: 'Lung',
    hint: 'W 1500 / L −600 · airways, parenchyma',
    windowCenter: -600,
    windowWidth: 1500,
    threshold: [-960, -250],
    opacity: 0.22,
    mode: 'dvr',
    colormap: 'cool',
  },
  {
    id: 'angio',
    label: 'Angio',
    hint: 'W 600 / L 300 · contrast vessels',
    windowCenter: 300,
    windowWidth: 600,
    threshold: [150, 3071],
    opacity: 0.7,
    mode: 'dvr',
    colormap: 'flesh',
  },
  {
    id: 'brain',
    label: 'Brain',
    hint: 'W 80 / L 40 · grey/white matter',
    windowCenter: 40,
    windowWidth: 80,
    threshold: [0, 90],
    opacity: 0.12,
    mode: 'dvr',
    colormap: 'grayscale',
  },
  {
    id: 'mip',
    label: 'MIP',
    hint: 'Max intensity · radiograph-like',
    windowCenter: 400,
    windowWidth: 1800,
    threshold: [-1024, 3071],
    opacity: 1,
    mode: 'mip',
    colormap: 'grayscale',
  },
]

export const DEFAULT_PRESET_BY_DATASET: Record<string, string> = {
  'lidc-chest-ct': 'bone',
  'chest-ct': 'bone',
  'head-ct': 'bone',
  'hu-calibration': 'angio',
}

const FULL_CLIP: [number, number] = [0, 1]

export function clampToVolume(range: [number, number], volume: Volume): [number, number] {
  const lo = Math.max(volume.valueMin, Math.min(volume.valueMax, range[0]))
  const hi = Math.max(lo, Math.min(volume.valueMax, range[1]))
  return [lo, hi]
}

export function applyPreset(preset: Preset, current: ViewerSettings, volume: Volume): ViewerSettings {
  return {
    ...current,
    windowCenter: preset.windowCenter,
    windowWidth: preset.windowWidth,
    threshold: clampToVolume(preset.threshold, volume),
    opacity: preset.opacity,
    mode: preset.mode,
    colormap: preset.colormap,
  }
}

/** Generic settings for non-CT data where HU presets do not apply. */
export function autoSettings(volume: Volume): ViewerSettings {
  const { center, width } = volume.defaultWindow
  const range = volume.valueMax - volume.valueMin
  return {
    windowCenter: center,
    windowWidth: width,
    threshold: [volume.valueMin + range * 0.08, volume.valueMax],
    opacity: 0.35,
    brightness: 1,
    mode: 'dvr',
    colormap: 'grayscale',
    clipX: FULL_CLIP,
    clipY: FULL_CLIP,
    clipZ: FULL_CLIP,
    quality: 'balanced',
    shading: true,
  }
}

export function initialSettings(volume: Volume, datasetId: string | null): { settings: ViewerSettings; presetId: string | null } {
  const base = autoSettings(volume)
  if (volume.metadata.modality !== 'CT') return { settings: base, presetId: null }
  const presetId = (datasetId && DEFAULT_PRESET_BY_DATASET[datasetId]) || 'bone'
  const preset = CT_PRESETS.find((p) => p.id === presetId) ?? CT_PRESETS[0]
  return { settings: applyPreset(preset, base, volume), presetId: preset.id }
}

export const COLORMAPS: { id: Colormap; label: string; gradient: string }[] = [
  { id: 'grayscale', label: 'Grayscale', gradient: 'linear-gradient(90deg,#000,#fff)' },
  { id: 'bone', label: 'Bone', gradient: 'linear-gradient(90deg,#2a2018,#b9a27f,#fff8e8)' },
  { id: 'flesh', label: 'Flesh', gradient: 'linear-gradient(90deg,#3b0a0a,#c8463a,#f3b89b,#fff)' },
  { id: 'hot', label: 'Hot Iron', gradient: 'linear-gradient(90deg,#000,#b00,#f80,#ff0,#fff)' },
  { id: 'cool', label: 'Airway', gradient: 'linear-gradient(90deg,#061a3a,#1f6fb2,#6fd3ee,#eaffff)' },
]

export const COLORMAP_INDEX: Record<Colormap, number> = {
  grayscale: 0,
  bone: 1,
  flesh: 2,
  hot: 3,
  cool: 4,
}

export const MODE_INDEX: Record<RenderMode, number> = { dvr: 0, mip: 1, minip: 2, iso: 3 }

export const QUALITY_STEPS: Record<ViewerSettings['quality'], number> = {
  performance: 192,
  balanced: 384,
  high: 768,
}
