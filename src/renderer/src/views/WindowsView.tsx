import { useEffect, useMemo, useState } from 'react'
import type { NativeWindow, TileLayout, TileRequest } from '@shared/types'
import type { DisplayInfo, WindowCapability } from '@shared/api'
import { IconExternal, IconRefresh, IconWindows } from '../components/Icons'
import { Callout, Check, Empty, Field, Panel } from '../components/ui'
import { guard, toast, useFleet } from '../state/store'

const LAYOUTS: Array<{ id: TileLayout; label: string; hint: string }> = [
  { id: 'grid', label: 'Grid', hint: 'Balanced cells sized close to 16:9.' },
  { id: 'columns', label: 'Columns', hint: 'One tall column per instance.' },
  { id: 'rows', label: 'Rows', hint: 'One wide row per instance.' },
  { id: 'main-and-stack', label: 'Main + stack', hint: 'One large pane, the rest down the side.' },
  { id: 'cascade', label: 'Cascade', hint: 'Overlapping, offset windows.' },
  { id: 'stack', label: 'Stack', hint: 'Every window full size, one on top of another.' }
]

/**
 * Arranges the real OBS windows.
 *
 * Multiview shows what each instance is outputting; this page is for when the
 * operator needs the actual OBS UI of several instances at once — adding
 * sources, opening filters, dragging things around.
 */
export default function WindowsView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)

  const [capability, setCapability] = useState<WindowCapability | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [windows, setWindows] = useState<NativeWindow[]>([])
  const [layout, setLayout] = useState<TileLayout>('grid')
  const [displayId, setDisplayId] = useState<number | null>(null)
  const [gap, setGap] = useState(6)
  const [margin, setMargin] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mainId, setMainId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const running = useMemo(
    () =>
      [...(workspace?.instances ?? [])]
        .sort((a, b) => a.order - b.order)
        .filter((instance) => {
          const runtime = runtimes[instance.id]
          return runtime && runtime.state !== 'stopped' && runtime.state !== 'crashed'
        }),
    [workspace, runtimes]
  )

  useEffect(() => {
    void (async () => {
      const [cap, displayList] = await Promise.all([
        window.fleet.windowCapability(),
        window.fleet.listDisplays()
      ])
      setCapability(cap)
      setDisplays(displayList)
      setDisplayId(displayList.find((display) => display.primary)?.id ?? null)
    })()
  }, [])

  // Default the selection to everything running, but keep any manual choice.
  useEffect(() => {
    setSelected((current) => {
      if (current.size > 0) return current
      return new Set(running.map((instance) => instance.id))
    })
  }, [running])

  const refreshWindows = async (): Promise<void> => {
    const found = await guard('List windows', () => window.fleet.listNativeWindows())
    if (found) setWindows(found)
  }

  const selectedIds = running.map((i) => i.id).filter((id) => selected.has(id))

  const apply = async (): Promise<void> => {
    if (selectedIds.length === 0) return
    setBusy(true)

    const request: TileRequest = {
      layout,
      instanceIds: selectedIds,
      displayId,
      gap,
      margin,
      mainInstanceId: mainId
    }

    const result = await guard('Arrange windows', () => window.fleet.tileWindows(request))
    setBusy(false)
    if (!result) return

    if (result.failed.length === 0 && result.warnings.length === 0) {
      toast('success', `Arranged ${result.moved.length} window(s)`)
    } else {
      toast(
        result.moved.length > 0 ? 'warn' : 'error',
        `Arranged ${result.moved.length} of ${selectedIds.length}`,
        [
          ...result.warnings,
          ...result.failed.map(
            (entry) => `${nameOf(running, entry.instanceId)}: ${entry.reason}`
          )
        ].join('\n')
      )
    }

    void refreshWindows()
  }

  if (running.length === 0) {
    return (
      <Empty title="No running instances">
        Window arrangement works on OBS windows that are already open. Launch some instances first.
      </Empty>
    )
  }

  const display = displays.find((entry) => entry.id === displayId) ?? displays[0]

  return (
    <>
      {capability && !capability.available && (
        <Callout tone="danger" title="Window control unavailable">
          {capability.detail}
        </Callout>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16 }}>
        <Panel
          title="Layout"
          actions={
            <button
              className="btn btn--sm btn--primary"
              disabled={busy || selectedIds.length === 0 || capability?.available === false}
              onClick={() => void apply()}
            >
              <IconWindows size={13} /> Arrange {selectedIds.length} window
              {selectedIds.length === 1 ? '' : 's'}
            </button>
          }
        >
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="row row--wrap" style={{ gap: 6 }}>
              {LAYOUTS.map((option) => (
                <button
                  key={option.id}
                  className={`btn btn--sm ${layout === option.id ? 'btn--primary' : ''}`}
                  onClick={() => setLayout(option.id)}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <span className="field__hint">
              {LAYOUTS.find((option) => option.id === layout)?.hint}
            </span>

            {display && (
              <TilingPreview
                layout={layout}
                count={selectedIds.length}
                gap={gap}
                margin={margin}
                aspect={display.workArea.width / display.workArea.height}
                colors={selectedIds.map(
                  (id) => running.find((instance) => instance.id === id)?.color ?? '#4f9dff'
                )}
                mainIndex={mainId ? selectedIds.indexOf(mainId) : 0}
              />
            )}

            <div className="grid-3">
              <Field label="Display">
                <select
                  className="select"
                  value={displayId ?? ''}
                  onChange={(e) => setDisplayId(Number(e.target.value))}
                >
                  {displays.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label} — {entry.bounds.width}×{entry.bounds.height}
                      {entry.primary ? ' (primary)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Gap between windows">
                <input
                  className="input num"
                  type="number"
                  min={0}
                  max={64}
                  value={gap}
                  onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
              <Field label="Margin from screen edge">
                <input
                  className="input num"
                  type="number"
                  min={0}
                  max={200}
                  value={margin}
                  onChange={(e) => setMargin(Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
            </div>

            {layout === 'main-and-stack' && (
              <Field label="Large pane">
                <select
                  className="select"
                  value={mainId ?? selectedIds[0] ?? ''}
                  onChange={(e) => setMainId(e.target.value)}
                >
                  {selectedIds.map((id) => (
                    <option key={id} value={id}>
                      {nameOf(running, id)}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="row">
              <button
                className="btn btn--sm"
                onClick={() =>
                  void guard('Minimise', () => window.fleet.minimizeWindows(selectedIds))
                }
              >
                Minimise selected
              </button>
              <div className="spacer" />
              <button className="btn btn--sm" onClick={() => void refreshWindows()}>
                <IconRefresh size={12} /> Detect windows
              </button>
            </div>
          </div>
        </Panel>

        <Panel
          title="Instances"
          actions={
            <button
              className="btn btn--sm btn--ghost"
              onClick={() =>
                setSelected(
                  selected.size === running.length
                    ? new Set()
                    : new Set(running.map((instance) => instance.id))
                )
              }
            >
              {selected.size === running.length ? 'None' : 'All'}
            </button>
          }
        >
          <div style={{ display: 'grid', gap: 4 }}>
            {running.map((instance, index) => {
              const detected = windows.find((entry) => entry.instanceId === instance.id)
              return (
                <div key={instance.id} className="row" style={{ gap: 8 }}>
                  <Check
                    checked={selected.has(instance.id)}
                    onChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current)
                        if (checked) next.add(instance.id)
                        else next.delete(instance.id)
                        return next
                      })
                    }
                    label={
                      <span className="row" style={{ gap: 6 }}>
                        <span
                          style={{
                            width: 3,
                            height: 14,
                            borderRadius: 2,
                            background: instance.color
                          }}
                        />
                        <span className="num faint">{index + 1}</span>
                        <span>{instance.name}</span>
                      </span>
                    }
                  />
                  <div className="spacer" />
                  {detected ? (
                    <span className="faint" title={detected.title}>
                      found
                    </span>
                  ) : (
                    windows.length > 0 && <span className="faint">not found</span>
                  )}
                  <button
                    className="btn btn--ghost btn--icon"
                    title="Bring this window to the front"
                    onClick={() =>
                      void guard('Focus window', () => window.fleet.focusWindow(instance.id))
                    }
                  >
                    <IconExternal size={12} />
                  </button>
                </div>
              )
            })}
          </div>

          {capability?.available && (
            <div className="field__hint" style={{ marginTop: 12 }}>
              {capability.detail}
            </div>
          )}
        </Panel>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Scaled-down diagram of where the windows will land.
 *
 * Mirrors the geometry the main process computes, so the operator can pick a
 * layout without moving anything first.
 */
function TilingPreview({
  layout,
  count,
  gap,
  margin,
  aspect,
  colors,
  mainIndex
}: {
  layout: TileLayout
  count: number
  gap: number
  margin: number
  aspect: number
  colors: string[]
  mainIndex: number
}): JSX.Element {
  const width = 480
  const height = Math.round(width / (aspect || 16 / 9))
  const scale = width / 1920

  const rects = computeLocalTiling({
    layout,
    count,
    area: { x: 0, y: 0, width, height },
    gap: Math.max(1, gap * scale),
    margin: margin * scale,
    mainIndex
  })

  return (
    <svg
      className="tiling-preview"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${layout} layout preview for ${count} windows`}
    >
      {rects.map((rect, index) => (
        <g key={index}>
          <rect
            x={rect.x}
            y={rect.y}
            width={Math.max(0, rect.width)}
            height={Math.max(0, rect.height)}
            fill={colors[index] ?? '#4f9dff'}
            fillOpacity={0.16}
            stroke={colors[index] ?? '#4f9dff'}
            strokeWidth={1.2}
            rx={2}
          />
          <text
            x={rect.x + rect.width / 2}
            y={rect.y + rect.height / 2 + 4}
            textAnchor="middle"
            fill="var(--text-dim)"
            fontSize={11}
            fontFamily="var(--mono)"
          >
            {index + 1}
          </text>
        </g>
      ))}
      {count === 0 && (
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="var(--text-faint)" fontSize={12}>
          Select at least one instance
        </text>
      )}
    </svg>
  )
}

interface LocalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Layout maths duplicated for the preview.
 *
 * The main process cannot compute this for a hypothetical arrangement without
 * the windows existing, so the diagram runs the same algorithm locally.
 */
function computeLocalTiling(options: {
  layout: TileLayout
  count: number
  area: LocalRect
  gap: number
  margin: number
  mainIndex: number
}): LocalRect[] {
  const { layout, count, gap, margin, mainIndex } = options
  if (count <= 0) return []

  const area: LocalRect = {
    x: options.area.x + margin,
    y: options.area.y + margin,
    width: Math.max(1, options.area.width - margin * 2),
    height: Math.max(1, options.area.height - margin * 2)
  }

  if (layout === 'stack') return Array.from({ length: count }, () => ({ ...area }))

  if (layout === 'cascade') {
    const step = Math.max(gap, 14)
    return Array.from({ length: count }, (_, index) => ({
      x: area.x + index * step,
      y: area.y + index * step,
      width: Math.max(40, area.width - step * (count - 1)),
      height: Math.max(30, area.height - step * (count - 1))
    }))
  }

  if (layout === 'columns' || layout === 'rows') {
    const horizontal = layout === 'columns'
    const total = horizontal ? area.width : area.height
    const size = (total - gap * (count - 1)) / count
    return Array.from({ length: count }, (_, index) => {
      const offset = index * (size + gap)
      return horizontal
        ? { x: area.x + offset, y: area.y, width: size, height: area.height }
        : { x: area.x, y: area.y + offset, width: area.width, height: size }
    })
  }

  if (layout === 'main-and-stack') {
    if (count === 1) return [{ ...area }]
    const mainWidth = area.width * 0.62
    const stackX = area.x + mainWidth + gap
    const stackWidth = area.x + area.width - stackX
    const stackCount = count - 1
    const stackHeight = (area.height - gap * (stackCount - 1)) / stackCount

    const rects = new Array<LocalRect>(count)
    const main = Math.min(Math.max(mainIndex, 0), count - 1)
    rects[main] = { x: area.x, y: area.y, width: mainWidth, height: area.height }

    let slot = 0
    for (let index = 0; index < count; index += 1) {
      if (index === main) continue
      rects[index] = {
        x: stackX,
        y: area.y + slot * (stackHeight + gap),
        width: stackWidth,
        height: stackHeight
      }
      slot += 1
    }
    return rects
  }

  const aspect = area.width / area.height
  let columns = 1
  let bestScore = Number.POSITIVE_INFINITY
  for (let candidate = 1; candidate <= count; candidate += 1) {
    const rows = Math.ceil(count / candidate)
    const cellAspect = (aspect * rows) / candidate
    const score = Math.abs(Math.log(cellAspect / (16 / 9)))
    if (score < bestScore - 1e-9) {
      bestScore = score
      columns = candidate
    }
  }

  const rows = Math.ceil(count / columns)
  const cellWidth = (area.width - gap * (columns - 1)) / columns
  const cellHeight = (area.height - gap * (rows - 1)) / rows

  return Array.from({ length: count }, (_, index) => ({
    x: area.x + (index % columns) * (cellWidth + gap),
    y: area.y + Math.floor(index / columns) * (cellHeight + gap),
    width: cellWidth,
    height: cellHeight
  }))
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
}
