import type { ReactNode } from 'react'
import { Bone, Brain, Droplets, HeartPulse, Layers, RotateCcw, ScanLine, Wind } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COLORMAPS, CT_PRESETS } from '@/lib/presets'
import type { Colormap, RenderMode, ViewerSettings, Volume } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Histogram } from './Histogram'
import { SliderField } from './SliderField'

const PRESET_ICONS: Record<string, typeof Bone> = {
  bone: Bone,
  soft: HeartPulse,
  lung: Wind,
  angio: Droplets,
  brain: Brain,
  mip: ScanLine,
}

const MODES: { id: RenderMode; label: string; tip: string }[] = [
  { id: 'dvr', label: 'DVR', tip: 'Direct volume rendering with front-to-back compositing' },
  { id: 'mip', label: 'MIP', tip: 'Maximum intensity projection' },
  { id: 'minip', label: 'MinIP', tip: 'Minimum intensity projection (airways)' },
  { id: 'iso', label: 'Iso', tip: 'Isosurface at the lower threshold, bisection-refined' },
]

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3.5 border-b px-4 py-4 last:border-b-0">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

interface Props {
  volume: Volume
  settings: ViewerSettings
  presetId: string | null
  onChange: (patch: Partial<ViewerSettings>) => void
  onPreset: (id: string) => void
  onResetClip: () => void
}

export function ControlPanel({ volume, settings, presetId, onChange, onPreset, onResetClip }: Props) {
  const isCT = volume.metadata.modality === 'CT'
  const range = volume.valueMax - volume.valueMin
  const step = range > 200 ? 1 : range / 400
  const unit = isCT ? ' HU' : ''
  const fmtHU = (v: number) => (range > 200 ? Math.round(v).toString() : v.toFixed(1))
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const clipped =
    settings.clipX[0] > 0 || settings.clipX[1] < 1 || settings.clipY[0] > 0 || settings.clipY[1] < 1 || settings.clipZ[0] > 0 || settings.clipZ[1] < 1

  return (
    <div className="text-sm">
      <Section title="Clinical presets">
        <div className="grid grid-cols-3 gap-1.5">
          {CT_PRESETS.map((p) => {
            const Icon = PRESET_ICONS[p.id] ?? Layers
            const active = presetId === p.id
            return (
              <Tooltip key={p.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onPreset(p.id)}
                    disabled={!isCT}
                    aria-pressed={active}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium transition-colors',
                      'hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40',
                      active ? 'border-primary/70 bg-primary/10 text-primary' : 'text-foreground/80',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {p.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{p.hint}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        {!isCT && (
          <p className="text-[11px] text-muted-foreground">
            HU presets apply to CT only. This {volume.metadata.modality} series uses auto-windowing.
          </p>
        )}
      </Section>

      <Section title="Window / Level">
        <Histogram volume={volume} settings={settings} />
        <SliderField
          id="window-center"
          label="Window center (level)"
          value={settings.windowCenter}
          min={volume.valueMin}
          max={volume.valueMax}
          step={step}
          format={(v) => fmtHU(v) + unit}
          onChange={(windowCenter) => onChange({ windowCenter })}
        />
        <SliderField
          id="window-width"
          label="Window width"
          value={settings.windowWidth}
          min={Math.max(step, 1e-3)}
          max={range * 1.5}
          step={step}
          format={(v) => fmtHU(v) + unit}
          onChange={(windowWidth) => onChange({ windowWidth })}
        />
      </Section>

      <Section title="Density threshold">
        <SliderField
          id="threshold"
          label={isCT ? 'Visible HU range' : 'Visible value range'}
          value={settings.threshold}
          min={volume.valueMin}
          max={volume.valueMax}
          step={step}
          format={fmtHU}
          onChange={(threshold) => onChange({ threshold })}
          hint="Voxels outside this range are fully transparent; the lower bound is the isosurface level."
        />
      </Section>

      <Section title="Rendering">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={settings.mode}
          onValueChange={(v) => v && onChange({ mode: v as RenderMode })}
          className="w-full"
        >
          {MODES.map((m) => (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={m.id} className="flex-1 text-xs">
                  {m.label}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{m.tip}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Colormap</Label>
            <Select value={settings.colormap} onValueChange={(v) => onChange({ colormap: v as Colormap })}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLORMAPS.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="inline-block h-2.5 w-6 rounded-sm" style={{ background: c.gradient }} aria-hidden />
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Quality</Label>
            <Select
              value={settings.quality}
              onValueChange={(v) => onChange({ quality: v as ViewerSettings['quality'] })}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="performance">Fast · 192 steps</SelectItem>
                <SelectItem value="balanced">Balanced · 384</SelectItem>
                <SelectItem value="high">High · 768</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <SliderField
          id="opacity"
          label="Opacity"
          value={settings.opacity}
          min={0.01}
          max={1}
          step={0.01}
          format={pct}
          onChange={(opacity) => onChange({ opacity })}
        />
        <SliderField
          id="brightness"
          label="Brightness"
          value={settings.brightness}
          min={0.3}
          max={2.5}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(brightness) => onChange({ brightness })}
        />
        <div className="flex items-center justify-between">
          <Label htmlFor="shading" className="text-xs">
            Gradient lighting
          </Label>
          <Switch id="shading" checked={settings.shading} onCheckedChange={(shading) => onChange({ shading })} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="adaptive" className="text-xs">
              Adaptive resolution
            </Label>
            <Switch id="adaptive" checked={settings.adaptive} onCheckedChange={(adaptive) => onChange({ adaptive })} />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {settings.adaptive
              ? 'Renders only on change, at a lower resolution while you interact, then refines.'
              : 'Benchmark mode: every frame is rendered at full quality.'}
          </p>
        </div>
      </Section>

      <Section
        title="Clipping planes"
        action={
          <Button variant="ghost" size="xs" onClick={onResetClip} disabled={!clipped}>
            <RotateCcw aria-hidden />
            Reset
          </Button>
        }
      >
        <SliderField
          id="clip-x"
          label="X · Right → Left"
          value={settings.clipX}
          min={0}
          max={1}
          step={0.005}
          format={pct}
          onChange={(clipX) => onChange({ clipX })}
        />
        <SliderField
          id="clip-y"
          label="Y · Anterior → Posterior"
          value={settings.clipY}
          min={0}
          max={1}
          step={0.005}
          format={pct}
          onChange={(clipY) => onChange({ clipY })}
        />
        <SliderField
          id="clip-z"
          label="Z · Inferior → Superior"
          value={settings.clipZ}
          min={0}
          max={1}
          step={0.005}
          format={pct}
          onChange={(clipZ) => onChange({ clipZ })}
        />
      </Section>
    </div>
  )
}
