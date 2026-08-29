import { useEffect, useMemo, useState } from 'react'
import type {
  DisplayAssignment,
  DisplayDistribution,
  NativeWindow,
  TileLayout,
  TileRequest,
  WindowLayoutSettings
} from '@shared/types'
import type { DisplayInfo, WindowCapability } from '@shared/api'
import { computeTiling, distributeAcrossDisplays } from '@shared/tiling'
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

const DISTRIBUTIONS: Array<{ id: DisplayDistribution; label: string; hint: string }> = [
  { id: 'balanced', label: 'Balanced', hint: 'Split evenly, in order, across the chosen displays.' },
  {
    id: 'sequential',
    label: 'Fill in turn',
    hint: 'Fill each display up to its limit before moving to the next.'
  }
]

/** Per-display choices layered over the page defaults. */
interface DisplayOverride {
  layout: TileLayout
  fullBounds: boolean
  mainInstanceId: string | null
}

/**
 * Arranges the real OBS windows, across as many monitors as the rig has.
 *
 * Multiview shows what each instance is outputting; this page is for when the
 * operator needs the actual OBS UI of several instances at once — adding
 * sources, opening filters, dragging things around.
 */
export default function WindowsView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)
  const saved = workspace?.settings.windowLayout

  const [capability, setCapability] = useState<WindowCapability | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [windows, setWindows] = useState<NativeWindow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)

  // Page defaults, seeded from the workspace and editable here.
  const [layout, setLayout] = useState<TileLayout>(saved?.layout ?? 'grid')
  const [distribution, setDistribution] = useState<DisplayDistribution>(
    saved?.distribution === 'manual' ? 'balanced' : saved?.distribution ?? 'balanced'
  )
  const [gap, setGap] = useState(saved?.gap ?? 6)
  const [margin, setMargin] = useState(saved?.margin ?? 0)
  const [fullBounds, setFullBounds] = useState(saved?.fullBounds ?? false)
  const [maxPerDisplay, setMaxPerDisplay] = useState(saved?.maxPerDisplay ?? 0)
  const [displayIds, setDisplayIds] = useState<number[]>(saved?.displayIds ?? [])
  const [overrides, setOverrides] = useState<Record<number, DisplayOverride>>({})

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

      // Drop remembered displays that are no longer attached, so a rig that
      // lost a monitor does not try to place windows onto nothing.
      setDisplayIds((current) => {
        const attached = current.filter((id) => displayList.some((entry) => entry.id === id))
        if (attached.length > 0) return attached
        const primary = displayList.find((entry) => entry.primary)
        return primary ? [primary.id] : []
      })
    })()
  }, [])

  // Default the selection to everything running, but keep any manual choice.
  useEffect(() => {
    setSelected((current) => {
      if (current.size > 0) return current
      return new Set(running.map((instance) => instance.id))
    })
  }, [running])

  const selectedIds = running.map((instance) => instance.id).filter((id) => selected.has(id))

  const overrideFor = (displayId: number | null): DisplayOverride =>
    (displayId !== null ? overrides[displayId] : undefined) ?? {
      layout,
      fullBounds,
      mainInstanceId: null
    }

  const patchOverride = (displayId: number, patch: Partial<DisplayOverride>): void =>
    setOverrides((current) => ({
      ...current,
      [displayId]: { ...overrideFor(displayId), ...patch }
    }))

  /**
   * The plan, recomputed as the controls move.
   *
   * `distributeAcrossDisplays` is the same function the main process runs, so
   * the diagram below cannot disagree with what the windows actually do.
   */
  const assignments = useMemo<DisplayAssignment[]>(() => {
    const shares = distributeAcrossDisplays({
      instanceIds: selectedIds,
      displayIds,
      distribution,
      maxPerDisplay
    })

    return shares.map((share) => {
      const override = overrideFor(share.displayId)
      return {
        displayId: share.displayId,
        instanceIds: share.instanceIds,
        layout: override.layout,
        gap,
        margin,
        mainInstanceId:
          override.mainInstanceId && share.instanceIds.includes(override.mainInstanceId)
            ? override.mainInstanceId
            : share.instanceIds[0] ?? null,
        fullBounds: override.fullBounds
      }
    })
    // `overrideFor` closes over the same values this list already names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.join(','), displayIds, distribution, maxPerDisplay, layout, gap, margin, fullBounds, overrides])

  const refreshWindows = async (): Promise<void> => {
    const found = await guard('List windows', () => window.fleet.listNativeWindows())
    if (found) setWindows(found)
  }

  const apply = async (): Promise<void> => {
    if (assignments.length === 0) return
    setBusy(true)

    const request: TileRequest = { assignments }
    const result = await guard('Arrange windows', () => window.fleet.tileWindows(request))
    setBusy(false)
    if (!result) return

    const across = assignments.length === 1 ? '' : ` across ${assignments.length} displays`
    if (result.failed.length === 0 && result.warnings.length === 0) {
      toast('success', `Arranged ${result.moved.length} window(s)${across}`)
    } else {
      toast(
        result.moved.length > 0 ? 'warn' : 'error',
        `Arranged ${result.moved.length} of ${selectedIds.length}`,
        [
          ...result.warnings,
          ...result.failed.map((entry) => `${nameOf(running, entry.instanceId)}: ${entry.reason}`)
        ].join('\n')
      )
    }

    void refreshWindows()
  }

  const saveDefaults = async (): Promise<void> => {
    setSaving(true)
    const windowLayout: WindowLayoutSettings = {
      layout,
      distribution,
      gap,
      margin,
      fullBounds,
      displayIds,
      maxPerDisplay
    }
    const ok = await guard('Save layout defaults', () => window.fleet.updateSettings({ windowLayout }))
    setSaving(false)
    if (ok) toast('success', 'Saved as the default arrangement')
  }

  if (running.length === 0) {
    return (
      <Empty title="No running instances">
        Window arrangement works on OBS windows that are already open. Launch some instances first.
      </Empty>
    )
  }

  const toggleDisplay = (id: number, on: boolean): void =>
    setDisplayIds((current) => {
      const next = on ? [...current, id] : current.filter((entry) => entry !== id)
      // Keep them in the order the platform reports, so "first display" means
      // the same thing here as it does on the desk.
      return displays.filter((entry) => next.includes(entry.id)).map((entry) => entry.id)
    })

  return (
    <>
      {capability && !capability.available && (
        <Callout tone="danger" title="Window control unavailable">
          {capability.detail}
        </Callout>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          <Panel
            title="Displays"
            actions={
              <button
                className="btn btn--sm btn--ghost"
                onClick={() =>
                  setDisplayIds(
                    displayIds.length === displays.length ? [] : displays.map((entry) => entry.id)
                  )
                }
              >
                {displayIds.length === displays.length ? 'None' : 'All'}
              </button>
            }
          >
            <div style={{ display: 'grid', gap: 4 }}>
              {displays.map((display) => {
                const share = assignments.find((entry) => entry.displayId === display.id)
                return (
                  <div key={display.id} className="row" style={{ gap: 8 }}>
                    <Check
                      checked={displayIds.includes(display.id)}
                      onChange={(checked) => toggleDisplay(display.id, checked)}
                      label={
                        <span className="row" style={{ gap: 6 }}>
                          <span>{display.label}</span>
                          <span className="num faint">
                            {display.bounds.width}×{display.bounds.height}
                          </span>
                          {display.primary && <span className="faint">primary</span>}
                        </span>
                      }
                    />
                    <div className="spacer" />
                    <span className="num faint">
                      {share ? `${share.instanceIds.length} window(s)` : '—'}
                    </span>
                  </div>
                )
              })}
            </div>

            {displayIds.length === 0 && (
              <div className="field__hint" style={{ marginTop: 10 }}>
                Nothing chosen — everything goes to the primary display.
              </div>
            )}
          </Panel>

          <Panel
            title="Arrangement"
            actions={
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn--sm" disabled={saving} onClick={() => void saveDefaults()}>
                  {saving ? 'Saving…' : 'Save as default'}
                </button>
                <button
                  className="btn btn--sm btn--primary"
                  disabled={busy || selectedIds.length === 0 || capability?.available === false}
                  onClick={() => void apply()}
                >
                  <IconWindows size={13} /> Arrange {selectedIds.length} window
                  {selectedIds.length === 1 ? '' : 's'}
                </button>
              </div>
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
                {displayIds.length > 1 && ' Displays below can override this individually.'}
              </span>

              <div className="grid-3">
                <Field label="Spread across displays">
                  <select
                    className="select"
                    value={distribution}
                    onChange={(e) => setDistribution(e.target.value as DisplayDistribution)}
                  >
                    {DISTRIBUTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
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

              <div className="grid-2">
                {distribution === 'sequential' && (
                  <Field
                    label="Windows per display"
                    hint="0 fills evenly instead of to a limit."
                  >
                    <input
                      className="input num"
                      type="number"
                      min={0}
                      max={32}
                      value={maxPerDisplay}
                      onChange={(e) => setMaxPerDisplay(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </Field>
                )}
                <Check
                  checked={fullBounds}
                  onChange={setFullBounds}
                  label="Use the whole screen, under the taskbar"
                />
              </div>

              {assignments.length === 0 ? (
                <Callout>Select at least one instance.</Callout>
              ) : (
                assignments.map((assignment) => (
                  <DisplayPlan
                    key={assignment.displayId ?? 'primary'}
                    assignment={assignment}
                    display={displays.find((entry) => entry.id === assignment.displayId) ?? null}
                    instances={running}
                    showOverrides={displayIds.length > 1}
                    onPatch={(patch) =>
                      assignment.displayId !== null && patchOverride(assignment.displayId, patch)
                    }
                  />
                ))
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
        </div>

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
              const on = assignments.find((entry) => entry.instanceIds.includes(instance.id))
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
                  {on && displayIds.length > 1 && (
                    <span className="faint" title="Display this window will be placed on">
                      {displayLabel(displays, on.displayId)}
                    </span>
                  )}
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

/** One display's share of the plan: its options and a diagram of the result. */
function DisplayPlan({
  assignment,
  display,
  instances,
  showOverrides,
  onPatch
}: {
  assignment: DisplayAssignment
  display: DisplayInfo | null
  instances: Array<{ id: string; name: string; color: string }>
  showOverrides: boolean
  onPatch: (patch: Partial<DisplayOverride>) => void
}): JSX.Element {
  const area = display ? (assignment.fullBounds ? display.bounds : display.workArea) : null
  const aspect = area ? area.width / area.height : 16 / 9

  return (
    <div className="panel__inset" style={{ display: 'grid', gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <strong>{display?.label ?? 'Primary display'}</strong>
        {display && (
          <span className="num faint">
            {area?.width}×{area?.height}
          </span>
        )}
        <div className="spacer" />
        <span className="num faint">{assignment.instanceIds.length} window(s)</span>
      </div>

      {showOverrides && display && (
        <div className="grid-3">
          <Field label="Layout on this display">
            <select
              className="select"
              value={assignment.layout}
              onChange={(e) => onPatch({ layout: e.target.value as TileLayout })}
            >
              {LAYOUTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {assignment.layout === 'main-and-stack' && (
            <Field label="Large pane">
              <select
                className="select"
                value={assignment.mainInstanceId ?? ''}
                onChange={(e) => onPatch({ mainInstanceId: e.target.value })}
              >
                {assignment.instanceIds.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(instances, id)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Screen area">
            <Check
              checked={assignment.fullBounds}
              onChange={(checked) => onPatch({ fullBounds: checked })}
              label="Full screen"
            />
          </Field>
        </div>
      )}

      <TilingPreview
        assignment={assignment}
        aspect={aspect}
        colors={assignment.instanceIds.map(
          (id) => instances.find((instance) => instance.id === id)?.color ?? '#4f9dff'
        )}
      />
    </div>
  )
}

/**
 * Scaled-down diagram of where the windows will land.
 *
 * Runs `computeTiling` — the same function the main process runs — against a
 * scaled copy of the display, so the diagram is the plan rather than an
 * impression of it.
 */
function TilingPreview({
  assignment,
  aspect,
  colors
}: {
  assignment: DisplayAssignment
  aspect: number
  colors: string[]
}): JSX.Element {
  const width = 480
  const height = Math.round(width / (aspect || 16 / 9))
  // The real display is unknown here, so scale relative to a 1920-wide one:
  // gaps and margins are pixel values on the real screen.
  const scale = width / 1920

  const rects = computeTiling({
    layout: assignment.layout,
    count: assignment.instanceIds.length,
    area: { x: 0, y: 0, width, height },
    gap: Math.max(1, assignment.gap * scale),
    margin: assignment.margin * scale,
    mainIndex: assignment.mainInstanceId
      ? Math.max(0, assignment.instanceIds.indexOf(assignment.mainInstanceId))
      : 0
  })

  return (
    <svg
      className="tiling-preview"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${assignment.layout} layout preview for ${assignment.instanceIds.length} windows`}
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
    </svg>
  )
}

function displayLabel(displays: DisplayInfo[], displayId: number | null): string {
  if (displayId === null) return 'primary'
  return displays.find((entry) => entry.id === displayId)?.label ?? `#${displayId}`
}

function nameOf(instances: Array<{ id: string; name: string }>, id: string): string {
  return instances.find((instance) => instance.id === id)?.name ?? id
}
