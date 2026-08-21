import type { ReactNode } from 'react'
import { useEffect } from 'react'
import type { HealthLevel } from '@shared/types'
import { IconClose } from './Icons'

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  actions,
  children,
  flush = false
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
}): JSX.Element {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel__head">
          {title && <h2 className="panel__title">{title}</h2>}
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={flush ? 'panel__body panel__body--flush' : 'panel__body'}>{children}</div>
    </section>
  )
}

export function Empty({
  title,
  children,
  action
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children && <div style={{ maxWidth: 460 }}>{children}</div>}
      {action}
    </div>
  )
}

export function Callout({
  tone = 'warn',
  title,
  children
}: {
  tone?: 'warn' | 'info' | 'danger'
  title?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`callout callout--${tone}`}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export function HealthDot({ level }: { level: HealthLevel }): JSX.Element {
  const modifier = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : level === 'critical' ? 'critical' : ''
  return <span className={`dot ${modifier ? `dot--${modifier}` : ''}`} />
}

export function Chip({
  tone,
  children
}: {
  tone?: 'ok' | 'warn' | 'critical' | 'live' | 'rec'
  children: ReactNode
}): JSX.Element {
  return <span className={`chip ${tone ? `chip--${tone}` : ''}`}>{children}</span>
}

export function Metric({
  label,
  value,
  tone
}: {
  label: string
  value: ReactNode
  tone?: 'warn' | 'critical'
}): JSX.Element {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className={`metric__value ${tone ? `metric__value--${tone}` : ''}`}>{value}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

export function Check({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function Dialog({
  title,
  onClose,
  footer,
  wide = false,
  children
}: {
  title: ReactNode
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
  children: ReactNode
}): JSX.Element {
  // Escape closes, matching every other dialog the operator uses.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`dialog ${wide ? 'dialog--wide' : ''}`} role="dialog" aria-modal="true">
        <header className="dialog__head">
          <span className="dialog__title">{title}</span>
          <div className="spacer" />
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

export interface Series {
  label: string
  color: string
  points: Array<number | null>
}

/**
 * Compact multi-series line chart.
 *
 * Hand-rolled SVG rather than a charting library: the data is a fixed-length
 * ring buffer redrawn several times a second, and the whole requirement is
 * "one polyline per series with a shared Y scale".
 */
export function LineChart({
  series,
  height = 140,
  yMax,
  yLabel,
  format = (value: number) => value.toFixed(0)
}: {
  series: Series[]
  height?: number
  yMax?: number
  yLabel?: string
  format?: (value: number) => string
}): JSX.Element {
  const width = 600
  const padLeft = 42
  const padRight = 8
  const padTop = 8
  const padBottom = 16

  const length = Math.max(...series.map((s) => s.points.length), 1)
  const values = series.flatMap((s) => s.points.filter((p): p is number => p !== null))
  const dataMax = values.length > 0 ? Math.max(...values) : 1
  const max = yMax ?? Math.max(dataMax * 1.15, 1)

  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  const x = (index: number): number =>
    padLeft + (length <= 1 ? plotWidth : (index / (length - 1)) * plotWidth)
  const y = (value: number): number => padTop + plotHeight - (Math.min(value, max) / max) * plotHeight

  const gridLines = [0, 0.25, 0.5, 0.75, 1]

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={yLabel ? `${yLabel} over time` : 'Metric over time'}
    >
      {gridLines.map((fraction) => {
        const lineY = padTop + plotHeight * fraction
        return (
          <g key={fraction}>
            <line className="chart__grid" x1={padLeft} x2={width - padRight} y1={lineY} y2={lineY} />
            <text className="chart__axis" x={padLeft - 6} y={lineY + 3} textAnchor="end">
              {format(max * (1 - fraction))}
            </text>
          </g>
        )
      })}

      {series.map((entry) => {
        // Nulls break the line into segments rather than being drawn as zero,
        // so a gap in telemetry reads as a gap, not a crash to the floor.
        const segments: string[] = []
        let current: string[] = []

        entry.points.forEach((value, index) => {
          if (value === null) {
            if (current.length > 1) segments.push(current.join(' '))
            current = []
            return
          }
          current.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`)
        })
        if (current.length > 1) segments.push(current.join(' '))

        return (
          <g key={entry.label}>
            {segments.map((points, index) => (
              <polyline
                key={index}
                points={points}
                fill="none"
                stroke={entry.color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

export function Legend({ series }: { series: Series[] }): JSX.Element {
  return (
    <div className="legend">
      {series.map((entry) => (
        <span className="legend__item" key={entry.label}>
          <span className="legend__swatch" style={{ background: entry.color }} />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

/** Tiny inline trend line for card metrics. */
export function Sparkline({
  points,
  color,
  width = 90,
  height = 22
}: {
  points: Array<number | null>
  color: string
  width?: number
  height?: number
}): JSX.Element | null {
  const real = points.filter((p): p is number => p !== null)
  if (real.length < 2) return null

  const max = Math.max(...real, 1)
  const min = Math.min(...real, 0)
  const range = max - min || 1

  const path = points
    .map((value, index) => {
      if (value === null) return null
      const x = (index / (points.length - 1)) * width
      const y = height - ((value - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .filter((entry): entry is string => entry !== null)
    .join(' ')

  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={path} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Horizontal utilisation bar, coloured by threshold. */
export function Meter({
  value,
  max = 100,
  warn = 80,
  critical = 92,
  label
}: {
  value: number
  max?: number
  warn?: number
  critical?: number
  label?: ReactNode
}): JSX.Element {
  const percent = Math.max(0, Math.min(100, (value / max) * 100))
  const color =
    value >= critical ? 'var(--critical)' : value >= warn ? 'var(--warn)' : 'var(--accent)'

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {label && (
        <div className="row" style={{ fontSize: 11 }}>
          <span className="muted">{label}</span>
          <div className="spacer" />
          <span className="num">{value.toFixed(0)}%</span>
        </div>
      )}
      <div
        style={{
          height: 5,
          background: 'var(--bg-inset)',
          borderRadius: 3,
          overflow: 'hidden'
        }}
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${percent}%`, height: '100%', background: color, transition: 'width 220ms ease' }} />
      </div>
    </div>
  )
}
