import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'

interface SliderFieldProps<T extends number | [number, number]> {
  id: string
  label: ReactNode
  value: T
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (value: T) => void
  hint?: ReactNode
}

export function SliderField<T extends number | [number, number]>({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  format = (v) => String(Math.round(v)),
  onChange,
  hint,
}: SliderFieldProps<T>) {
  const isRange = Array.isArray(value)
  const values = isRange ? (value as [number, number]) : [value as number]
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-xs font-medium text-foreground/90">
          {label}
        </Label>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {isRange ? `${format(values[0])} – ${format(values[1])}` : format(values[0])}
        </span>
      </div>
      <Slider
        id={id}
        value={values}
        min={min}
        max={max}
        step={step}
        minStepsBetweenThumbs={0}
        onValueChange={(v) => onChange((isRange ? [v[0], v[1]] : v[0]) as T)}
        aria-label={typeof label === 'string' ? label : id}
      />
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}
