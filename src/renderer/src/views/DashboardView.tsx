import { useMemo, useState } from 'react'
import type { InstanceHealth, InstanceRuntime, InstanceStats, ObsInstance } from '@shared/types'
import {
  IconBroadcast,
  IconExternal,
  IconPause,
  IconPlay,
  IconPlus,
  IconRecord,
  IconStop,
  IconWarning,
  IconWrench
} from '../components/Icons'
import { Callout, Chip, Empty, HealthDot, Meter, Panel, Sparkline } from '../components/ui'
import {
  dropPercent,
  formatKbps,
  formatMb,
  formatMs,
  formatPercent,
  formatUptime
} from '../lib/format'
import { guard, toast, useFleet } from '../state/store'
import type { ViewId } from '../App'

/**
 * The screen an operator leaves open during a show: one card per instance
 * with transport controls, live encoder health, and the host's own load.
 */
export default function DashboardView({
  onNavigate
}: {
  onNavigate: (view: ViewId) => void
}): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const runtimes = useFleet((state) => state.runtimes)
  const health = useFleet((state) => state.health)
  const stats = useFleet((state) => state.stats)
  const system = useFleet((state) => state.system)

  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )

  const installs = workspace?.installs ?? []

  if (installs.length === 0) {
    return (
      <Empty
        title="No OBS installation yet"
        action={
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn--primary" onClick={() => onNavigate('library')}>
              Open the OBS library
            </button>
            <button className="btn" onClick={() => onNavigate('settings')}>
              Add an existing OBS
            </button>
          </div>
        }
      >
        OBS Fleet could not find OBS Studio automatically. The OBS library can download a version
        for you, or point Settings at a copy you already have — either way, instance folders are
        handled from there.
      </Empty>
    )
  }

  if (instances.length === 0) {
    return (
      <Empty
        title="No instances yet"
        action={
          <button className="btn btn--primary" onClick={() => onNavigate('instances')}>
            <IconPlus /> Create instances
          </button>
        }
      >
        An instance is an isolated OBS configuration with its own profiles, scene collections,
        recording folder and control port. Create two or more and they can run side by side.
      </Empty>
    )
  }

  const latestSystem = system[system.length - 1] ?? null

  return (
    <>
      {latestSystem && <HostPanel />}

      <div className="cards">
        {instances.map((instance) => (
          <InstanceCard
            key={instance.id}
            instance={instance}
            runtime={runtimes[instance.id]}
            health={health[instance.id]}
            stats={stats[instance.id] ?? []}
          />
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Host resources                                                      */
/* ------------------------------------------------------------------ */

function HostPanel(): JSX.Element {
  const system = useFleet((state) => state.system)
  const latest = system[system.length - 1]
  if (!latest) return <></>

  const memPercent = latest.memTotalMb > 0 ? (latest.memUsedMb / latest.memTotalMb) * 100 : 0
  const cpuHistory = system.map((sample) => sample.cpuPercent)

  return (
    <Panel title="Host resources">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 18
        }}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          <Meter value={latest.cpuPercent} label={`CPU (${latest.cpuPerCore.length} threads)`} />
          <Sparkline points={cpuHistory} color="var(--accent)" width={190} height={26} />
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <Meter value={memPercent} label="Memory" warn={85} critical={94} />
          <div className="faint num" style={{ fontSize: 11 }}>
            {formatMb(latest.memUsedMb)} of {formatMb(latest.memTotalMb)}
          </div>
        </div>

        {latest.gpus.slice(0, 2).map((gpu, index) => (
          <div key={`${gpu.model}-${index}`} style={{ display: 'grid', gap: 6 }}>
            <Meter
              value={gpu.utilizationPercent ?? 0}
              label={`GPU ${gpu.model.slice(0, 26)}`}
              warn={85}
              critical={95}
            />
            <div className="faint num" style={{ fontSize: 11 }}>
              {gpu.memoryUsedMb !== null && gpu.memoryTotalMb !== null
                ? `${formatMb(gpu.memoryUsedMb)} / ${formatMb(gpu.memoryTotalMb)}`
                : 'VRAM unavailable'}
              {gpu.encoderUtilPercent !== null && ` · enc ${formatPercent(gpu.encoderUtilPercent)}`}
              {gpu.temperatureC !== null && ` · ${gpu.temperatureC.toFixed(0)}°C`}
            </div>
          </div>
        ))}

        <div style={{ display: 'grid', gap: 6 }}>
          <div className="row" style={{ fontSize: 11 }}>
            <span className="muted">OBS processes</span>
            <div className="spacer" />
            <span className="num">{latest.obsProcesses.count}</span>
          </div>
          <div className="faint num" style={{ fontSize: 11 }}>
            {formatPercent(latest.obsProcesses.cpuPercent, 1)} CPU ·{' '}
            {formatMb(latest.obsProcesses.memoryMb)} RSS
          </div>
          <div className="faint num" style={{ fontSize: 11 }}>
            Net ↑{formatKbps(latest.network.txKbps)} ↓{formatKbps(latest.network.rxKbps)}
          </div>
        </div>
      </div>
    </Panel>
  )
}

/* ------------------------------------------------------------------ */
/* Instance card                                                       */
/* ------------------------------------------------------------------ */

function InstanceCard({
  instance,
  runtime,
  health,
  stats
}: {
  instance: ObsInstance
  runtime: InstanceRuntime | undefined
  health: InstanceHealth | undefined
  stats: InstanceStats[]
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const latest = stats[stats.length - 1] ?? null

  const state = runtime?.state ?? 'stopped'
  const connected = runtime?.wsConnected ?? false
  const isRunning = state !== 'stopped' && state !== 'crashed'
  const level = health?.level ?? 'unknown'

  const renderDrop = dropPercent(latest?.renderSkippedFrames ?? null, latest?.renderTotalFrames ?? null)
  const outputDrop = dropPercent(latest?.outputSkippedFrames ?? null, latest?.outputTotalFrames ?? null)

  const act = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await guard(label, action)
    setBusy(false)
  }

  const bulkOne = (action: Parameters<typeof window.fleet.bulk>[0]['action'], label: string) =>
    act(label, async () => {
      const outcomes = await window.fleet.bulk({ action, instanceIds: [instance.id] })
      const failure = outcomes.find((outcome) => !outcome.ok)
      if (failure) throw new Error(failure.detail)
    })

  return (
    <article
      className="card"
      style={{ ['--instance-color' as string]: instance.color }}
    >
      <header className="card__head">
        <HealthDot level={level} />
        <div style={{ display: 'grid', minWidth: 0 }}>
          <span className="card__name truncate">{instance.name}</span>
          {instance.role !== '' && <span className="card__role truncate">{instance.role}</span>}
        </div>
        <div className="spacer" />
        {runtime?.streaming && (
          <Chip tone="live">
            <span className="dot dot--live" /> LIVE
          </Chip>
        )}
        {runtime?.recording && (
          <Chip tone="rec">
            <IconRecord size={9} /> {runtime.recordingPaused ? 'PAUSED' : 'REC'}
          </Chip>
        )}
        {!isRunning && <Chip>{state === 'crashed' ? 'Crashed' : 'Stopped'}</Chip>}
        {isRunning && !connected && <Chip tone="warn">Connecting</Chip>}
      </header>

      <div className="card__body">
        <div className="metrics">
          <MetricValue label="FPS" value={latest?.activeFps?.toFixed(1) ?? '—'} />
          <MetricValue
            label="Render"
            value={formatMs(latest?.averageFrameRenderTimeMs)}
            tone={toneFor(latest?.averageFrameRenderTimeMs ?? null, 8, 16)}
          />
          <MetricValue
            label="Render drop"
            value={formatPercent(renderDrop, 2)}
            tone={toneFor(renderDrop, 1, 5)}
          />
          <MetricValue
            label="Enc drop"
            value={formatPercent(outputDrop, 2)}
            tone={toneFor(outputDrop, 1, 5)}
          />
          <MetricValue label="CPU" value={formatPercent(latest?.obsCpuPercent, 1)} />
          <MetricValue label="RAM" value={formatMb(latest?.obsMemoryMb)} />
          <MetricValue
            label="Bitrate"
            value={formatKbps(latest?.streamKbps ?? latest?.recordKbps)}
          />
          <MetricValue label="Uptime" value={formatUptime(runtime?.startedAt ?? null)} />
        </div>

        <div className="row" style={{ fontSize: 11 }}>
          <span className="faint truncate">
            {runtime?.currentProgramScene ?? 'No scene'}
            {runtime?.sceneCollection ? ` · ${runtime.sceneCollection}` : ''}
          </span>
          <div className="spacer" />
          <Sparkline
            points={stats.slice(-60).map((sample) => sample.activeFps)}
            color={instance.color}
            width={70}
            height={18}
          />
        </div>

        {health && health.issues.length > 0 && (
          <Callout tone={health.level === 'critical' ? 'danger' : 'warn'}>
            {health.issues.slice(0, 2).map((issue) => (
              <div key={issue.code} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                <IconWarning size={12} />
                <span>{issue.message}</span>
              </div>
            ))}
            {health.issues.length > 2 && (
              <span className="faint">+{health.issues.length - 2} more</span>
            )}
          </Callout>
        )}

        {runtime?.lastError && !isRunning && (
          <Callout tone="danger">{runtime.lastError}</Callout>
        )}
      </div>

      <footer className="card__foot">
        {isRunning ? (
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void act('Stop instance', () => window.fleet.stop(instance.id, false))}
            title="Close OBS cleanly"
          >
            <IconStop size={12} /> Stop
          </button>
        ) : (
          <button
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => void act('Launch instance', () => window.fleet.launch(instance.id))}
          >
            <IconPlay size={12} /> Launch
          </button>
        )}

        <button
          className="btn btn--sm"
          disabled={!connected || busy}
          onClick={() =>
            void bulkOne(
              runtime?.recording ? 'stopRecording' : 'startRecording',
              runtime?.recording ? 'Stop recording' : 'Start recording'
            )
          }
        >
          <IconRecord size={11} /> {runtime?.recording ? 'Stop' : 'Rec'}
        </button>

        {runtime?.recording && (
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() =>
              void bulkOne(
                runtime.recordingPaused ? 'resumeRecording' : 'pauseRecording',
                runtime.recordingPaused ? 'Resume' : 'Pause'
              )
            }
          >
            <IconPause size={11} />
          </button>
        )}

        <button
          className={`btn btn--sm ${runtime?.streaming ? 'btn--live' : ''}`}
          disabled={!connected || busy}
          onClick={() =>
            void bulkOne(
              runtime?.streaming ? 'stopStreaming' : 'startStreaming',
              runtime?.streaming ? 'Stop stream' : 'Start stream'
            )
          }
        >
          <IconBroadcast size={12} />
        </button>

        <div className="spacer" />

        <button
          className="btn btn--sm btn--ghost"
          disabled={!isRunning}
          title="Bring the OBS window to the front"
          onClick={() => void guard('Focus window', () => window.fleet.focusWindow(instance.id))}
        >
          <IconExternal size={12} />
        </button>

        <button
          className="btn btn--sm btn--ghost"
          title="Check this instance folder"
          onClick={() =>
            void guard('Verify instance', async () => {
              const problems = await window.fleet.verifyInstance(instance.id)
              if (problems.length === 0) toast('success', `${instance.name} is healthy`)
              else toast('warn', `${instance.name} has issues`, problems.join('\n'))
            })
          }
        >
          <IconWrench size={12} />
        </button>
      </footer>
    </article>
  )
}

function MetricValue({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'warn' | 'critical'
}): JSX.Element {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className={`metric__value ${tone ? `metric__value--${tone}` : ''}`}>{value}</div>
    </div>
  )
}

function toneFor(
  value: number | null,
  warn: number,
  critical: number
): 'warn' | 'critical' | undefined {
  if (value === null) return undefined
  if (value >= critical) return 'critical'
  if (value >= warn) return 'warn'
  return undefined
}
