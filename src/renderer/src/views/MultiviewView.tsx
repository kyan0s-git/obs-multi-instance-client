import { useEffect, useMemo, useState } from 'react'
import type { InstanceSnapshot, ObsInstance } from '@shared/types'
import {
  IconBroadcast,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconPause,
  IconRecord,
  IconRefresh,
  IconStop,
  IconVolume,
  IconVolumeOff
} from '../components/Icons'
import { Callout, Check, Chip, Empty, Panel } from '../components/ui'
import { formatDuration, formatKbps } from '../lib/format'
import { guard, refreshSnapshot, toast, useFleet } from '../state/store'

/**
 * Watch and drive every instance from one screen.
 *
 * The previews are polled screenshots of each instance's program output, and
 * each tile carries the controls an operator actually reaches for mid-show:
 * scene switching, source visibility, mixer mutes and transport.
 */
export default function MultiviewView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)
  const previews = useFleet((state) => state.previews)
  const snapshots = useFleet((state) => state.snapshots)
  const stats = useFleet((state) => state.stats)

  const [columns, setColumns] = useState(3)
  const [showSources, setShowSources] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const multiview = workspace?.settings.multiview

  const connected = useMemo(
    () =>
      [...(workspace?.instances ?? [])]
        .sort((a, b) => a.order - b.order)
        .filter((instance) => runtimes[instance.id]?.wsConnected),
    [workspace, runtimes]
  )

  // Only poll what is on screen; a hidden tile still costs an encode in OBS.
  useEffect(() => {
    const ids = connected.map((instance) => instance.id)
    void window.fleet.setMultiviewVisible(ids)
    return () => {
      void window.fleet.setMultiviewVisible(null)
    }
  }, [connected])

  if (connected.length === 0) {
    return (
      <Empty title="Nothing connected">
        Launch instances from the Dashboard. Once an instance accepts a control connection its
        program output appears here.
      </Empty>
    )
  }

  return (
    <>
      <Panel
        title="Multiview"
        actions={
          <div className="row" style={{ gap: 12 }}>
            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <span className="muted">Columns</span>
              <input
                type="range"
                min={1}
                max={5}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
              />
              <span className="num">{columns}</span>
            </label>

            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <span className="muted">Preview rate</span>
              <select
                className="select"
                style={{ width: 90 }}
                value={multiview?.fps ?? 2}
                onChange={(e) =>
                  void guard('Update multiview', () =>
                    window.fleet.updateSettings({
                      multiview: { ...multiview!, fps: Number(e.target.value) }
                    })
                  )
                }
              >
                <option value={0.5}>0.5 fps</option>
                <option value={1}>1 fps</option>
                <option value={2}>2 fps</option>
                <option value={4}>4 fps</option>
                <option value={8}>8 fps</option>
              </select>
            </label>

            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <span className="muted">Quality</span>
              <select
                className="select"
                style={{ width: 100 }}
                value={multiview?.quality ?? 480}
                onChange={(e) =>
                  void guard('Update multiview', () =>
                    window.fleet.updateSettings({
                      multiview: { ...multiview!, quality: Number(e.target.value) }
                    })
                  )
                }
              >
                <option value={320}>320 px</option>
                <option value={480}>480 px</option>
                <option value={720}>720 px</option>
                <option value={1080}>1080 px</option>
              </select>
            </label>

            <Check checked={showSources} onChange={setShowSources} label="Sources" />
          </div>
        }
      >
        <div className="faint" style={{ fontSize: 11 }}>
          Previews are polled from each instance over its control connection. Higher rates and
          resolutions cost real GPU time inside every OBS instance, so keep them modest during a
          show.
        </div>
      </Panel>

      <div
        className="multiview"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {connected.map((instance) => (
          <Tile
            key={instance.id}
            instance={instance}
            snapshot={snapshots[instance.id]}
            frame={previews[instance.id]}
            showSources={showSources}
            expanded={expanded === instance.id}
            onToggleExpand={() =>
              setExpanded((current) => (current === instance.id ? null : instance.id))
            }
            bitrate={
              stats[instance.id]?.[stats[instance.id].length - 1]?.streamKbps ??
              stats[instance.id]?.[stats[instance.id].length - 1]?.recordKbps ??
              null
            }
            duration={
              stats[instance.id]?.[stats[instance.id].length - 1]?.recordDurationMs ??
              stats[instance.id]?.[stats[instance.id].length - 1]?.streamDurationMs ??
              null
            }
          />
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */

function Tile({
  instance,
  snapshot,
  frame,
  showSources,
  expanded,
  onToggleExpand,
  bitrate,
  duration
}: {
  instance: ObsInstance
  snapshot: InstanceSnapshot | undefined
  frame: { dataUri: string | null; error: string | null; at: number } | undefined
  showSources: boolean
  expanded: boolean
  onToggleExpand: () => void
  bitrate: number | null
  duration: number | null
}): JSX.Element {
  const runtime = useFleet((state) => state.runtimes[instance.id])
  const onAir = runtime?.streaming || runtime?.recording

  useEffect(() => {
    if (!snapshot) void refreshSnapshot(instance.id)
  }, [instance.id, snapshot])

  const bulkOne = (action: Parameters<typeof window.fleet.bulk>[0]['action'], label: string) =>
    guard(label, async () => {
      const outcomes = await window.fleet.bulk({ action, instanceIds: [instance.id] })
      const failure = outcomes.find((outcome) => !outcome.ok)
      if (failure) throw new Error(failure.detail)
    })

  return (
    <article
      className={`tile ${onAir ? 'tile--onair' : ''}`}
      style={{ ['--instance-color' as string]: instance.color }}
    >
      <header className="tile__head">
        <span className="tile__marker" />
        <span className="truncate" style={{ fontWeight: 600 }}>
          {instance.name}
        </span>
        {instance.role !== '' && <span className="faint truncate">{instance.role}</span>}
        <div className="spacer" />
        {runtime?.streaming && (
          <Chip tone="live">
            <span className="dot dot--live" /> LIVE
          </Chip>
        )}
        {runtime?.recording && (
          <Chip tone="rec">{runtime.recordingPaused ? 'PAUSE' : 'REC'}</Chip>
        )}
        <button
          className="btn btn--ghost btn--icon"
          title={expanded ? 'Collapse controls' : 'Expand controls'}
          onClick={onToggleExpand}
        >
          {expanded ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </button>
      </header>

      <div className="tile__preview">
        {frame?.dataUri ? (
          <img src={frame.dataUri} alt={`${instance.name} program output`} />
        ) : (
          <div className="tile__placeholder">
            {frame?.error ?? 'Waiting for the first frame…'}
          </div>
        )}
      </div>

      <div className="tile__scenes">
        {(snapshot?.scenes ?? []).map((scene) => {
          const isProgram = scene === runtime?.currentProgramScene
          const isPreview = scene === runtime?.currentPreviewScene && runtime?.studioModeEnabled
          return (
            <button
              key={scene}
              className={`scenebtn ${isProgram ? 'scenebtn--program' : ''} ${
                isPreview ? 'scenebtn--preview' : ''
              }`}
              title={scene}
              onClick={() =>
                void guard('Switch scene', () =>
                  runtime?.studioModeEnabled
                    ? window.fleet.setPreviewScene(instance.id, scene)
                    : window.fleet.setScene(instance.id, scene)
                )
              }
            >
              {scene}
            </button>
          )
        })}
        {(snapshot?.scenes.length ?? 0) === 0 && <span className="faint">No scenes</span>}
      </div>

      {expanded && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--line)', display: 'grid', gap: 10 }}>
          <div className="row row--wrap" style={{ gap: 6 }}>
            <button
              className="btn btn--sm"
              onClick={() =>
                void bulkOne(
                  runtime?.recording ? 'stopRecording' : 'startRecording',
                  runtime?.recording ? 'Stop recording' : 'Start recording'
                )
              }
            >
              {runtime?.recording ? <IconStop size={11} /> : <IconRecord size={11} />}
              {runtime?.recording ? 'Stop rec' : 'Record'}
            </button>

            {runtime?.recording && (
              <button
                className="btn btn--sm"
                onClick={() =>
                  void bulkOne(
                    runtime.recordingPaused ? 'resumeRecording' : 'pauseRecording',
                    'Toggle pause'
                  )
                }
              >
                <IconPause size={11} /> {runtime.recordingPaused ? 'Resume' : 'Pause'}
              </button>
            )}

            <button
              className={`btn btn--sm ${runtime?.streaming ? 'btn--live' : ''}`}
              onClick={() =>
                void bulkOne(
                  runtime?.streaming ? 'stopStreaming' : 'startStreaming',
                  'Toggle stream'
                )
              }
            >
              <IconBroadcast size={12} /> {runtime?.streaming ? 'Stop' : 'Stream'}
            </button>

            <button
              className="btn btn--sm"
              onClick={() =>
                void guard('Toggle studio mode', () =>
                  window.fleet.setStudioMode(instance.id, !runtime?.studioModeEnabled)
                )
              }
            >
              Studio {runtime?.studioModeEnabled ? 'off' : 'on'}
            </button>

            {runtime?.studioModeEnabled && (
              <button
                className="btn btn--sm btn--primary"
                onClick={() =>
                  void guard('Transition', () => window.fleet.triggerTransition(instance.id))
                }
              >
                Take
              </button>
            )}

            <div className="spacer" />

            <button
              className="btn btn--sm btn--ghost"
              title="Bring the OBS window forward"
              onClick={() => void guard('Focus window', () => window.fleet.focusWindow(instance.id))}
            >
              <IconExternal size={12} />
            </button>
            <button
              className="btn btn--sm btn--ghost"
              title="Refresh scenes and sources"
              onClick={() => void refreshSnapshot(instance.id)}
            >
              <IconRefresh size={12} />
            </button>
          </div>

          <div className="row faint num" style={{ fontSize: 11, gap: 14 }}>
            <span>{formatKbps(bitrate)}</span>
            <span>{formatDuration(duration)}</span>
            <span>{runtime?.currentProgramScene ?? '—'}</span>
          </div>

          {showSources && snapshot && (
            <SourceList instanceId={instance.id} snapshot={snapshot} />
          )}

          {showSources && snapshot && snapshot.audioInputs.length > 0 && (
            <Mixer instanceId={instance.id} snapshot={snapshot} />
          )}
        </div>
      )}
    </article>
  )
}

/* ------------------------------------------------------------------ */

function SourceList({
  instanceId,
  snapshot
}: {
  instanceId: string
  snapshot: InstanceSnapshot
}): JSX.Element {
  if (!snapshot.currentProgramScene) {
    return <Callout>No program scene selected.</Callout>
  }

  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <div className="field__label">Sources in {snapshot.currentProgramScene}</div>
      {snapshot.sceneItems.length === 0 && <span className="faint">This scene is empty.</span>}
      {snapshot.sceneItems.map((item) => (
        <div key={item.id} className="row" style={{ gap: 6, fontSize: 12 }}>
          <button
            className="btn btn--ghost btn--icon"
            title={item.enabled ? 'Hide source' : 'Show source'}
            onClick={() =>
              void guard('Toggle source', () =>
                window.fleet.setSceneItemEnabled(
                  instanceId,
                  snapshot.currentProgramScene!,
                  item.id,
                  !item.enabled
                )
              )
            }
          >
            {item.enabled ? <IconEye size={13} /> : <IconEyeOff size={13} />}
          </button>
          <span className={`truncate ${item.enabled ? '' : 'faint'}`}>{item.sourceName}</span>
          <div className="spacer" />
          {item.inputKind && <span className="faint mono">{item.inputKind}</span>}
          {item.locked && <span className="faint">locked</span>}
          <button
            className="btn btn--ghost btn--sm"
            title="Open this source's properties in OBS"
            onClick={() =>
              void guard('Open properties', () =>
                window.fleet.openSourceProperties(instanceId, item.sourceName)
              )
            }
          >
            <IconExternal size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Mixer({
  instanceId,
  snapshot
}: {
  instanceId: string
  snapshot: InstanceSnapshot
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="field__label">Audio</div>
      {snapshot.audioInputs.map((input) => (
        <div key={input.name} className="row" style={{ gap: 8, fontSize: 12 }}>
          <button
            className="btn btn--ghost btn--icon"
            title={input.muted ? 'Unmute' : 'Mute'}
            style={{ color: input.muted ? 'var(--critical)' : undefined }}
            onClick={() =>
              void guard('Toggle mute', () =>
                window.fleet.setInputMute(instanceId, input.name, !input.muted)
              )
            }
          >
            {input.muted ? <IconVolumeOff size={13} /> : <IconVolume size={13} />}
          </button>
          <span className="truncate" style={{ minWidth: 90 }}>
            {input.name}
          </span>
          <input
            type="range"
            min={-60}
            max={0}
            step={0.5}
            value={Math.max(-60, Math.min(0, input.volumeDb))}
            style={{ flex: 1 }}
            onChange={(e) =>
              void window.fleet
                .setInputVolumeDb(instanceId, input.name, Number(e.target.value))
                .catch((err) => toast('error', 'Volume', String(err)))
            }
          />
          <span className="num faint" style={{ width: 54, textAlign: 'right' }}>
            {input.volumeDb <= -60 ? '-inf' : `${input.volumeDb.toFixed(1)} dB`}
          </span>
        </div>
      ))}
    </div>
  )
}
