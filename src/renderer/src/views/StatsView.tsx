import { useMemo, useState } from 'react'
import type { InstanceStats } from '@shared/types'
import { Empty, Legend, LineChart, Panel, type Series } from '../components/ui'
import {
  dropPercent,
  formatKbps,
  formatMb,
  formatMs,
  formatNumber,
  formatPercent
} from '../lib/format'
import { useFleet } from '../state/store'

type MetricId =
  | 'activeFps'
  | 'averageFrameRenderTimeMs'
  | 'obsCpuPercent'
  | 'procCpuPercent'
  | 'obsMemoryMb'
  | 'renderDropPercent'
  | 'outputDropPercent'
  | 'bitrate'
  | 'streamCongestion'

interface MetricDefinition {
  id: MetricId
  label: string
  unit: string
  format: (value: number) => string
  extract: (sample: InstanceStats) => number | null
  yMax?: number
}

const METRICS: MetricDefinition[] = [
  {
    id: 'activeFps',
    label: 'Rendered FPS',
    unit: 'fps',
    format: (v) => v.toFixed(0),
    extract: (s) => s.activeFps
  },
  {
    id: 'averageFrameRenderTimeMs',
    label: 'Frame render time',
    unit: 'ms',
    format: (v) => v.toFixed(1),
    extract: (s) => s.averageFrameRenderTimeMs
  },
  {
    id: 'obsCpuPercent',
    label: 'OBS CPU (self-reported)',
    unit: '%',
    format: (v) => v.toFixed(0),
    extract: (s) => s.obsCpuPercent
  },
  {
    id: 'procCpuPercent',
    label: 'Process CPU (measured)',
    unit: '%',
    format: (v) => v.toFixed(0),
    extract: (s) => s.procCpuPercent
  },
  {
    id: 'obsMemoryMb',
    label: 'Memory',
    unit: 'MB',
    format: (v) => v.toFixed(0),
    extract: (s) => s.obsMemoryMb
  },
  {
    id: 'renderDropPercent',
    label: 'Render frames dropped',
    unit: '%',
    format: (v) => v.toFixed(2),
    extract: (s) => dropPercent(s.renderSkippedFrames, s.renderTotalFrames)
  },
  {
    id: 'outputDropPercent',
    label: 'Encoder frames dropped',
    unit: '%',
    format: (v) => v.toFixed(2),
    extract: (s) => dropPercent(s.outputSkippedFrames, s.outputTotalFrames)
  },
  {
    id: 'bitrate',
    label: 'Output bitrate',
    unit: 'kb/s',
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}M` : v.toFixed(0)),
    extract: (s) => s.streamKbps ?? s.recordKbps
  },
  {
    id: 'streamCongestion',
    label: 'Stream congestion',
    unit: '',
    format: (v) => v.toFixed(2),
    extract: (s) => s.streamCongestion,
    yMax: 1
  }
]

const WINDOWS = [
  { label: '1 min', samples: 60 },
  { label: '5 min', samples: 300 },
  { label: 'All', samples: Number.POSITIVE_INFINITY }
]

/**
 * Time-series view across the whole fleet.
 *
 * Every chart plots one metric with one line per instance, so the comparison
 * that matters ("is it all of them, or just that one?") is the default read
 * rather than something the operator has to assemble.
 */
export default function StatsView(): JSX.Element {
  const workspace = useFleet((state) => state.workspace)
  const stats = useFleet((state) => state.stats)
  const system = useFleet((state) => state.system)

  const [metric, setMetric] = useState<MetricId>('activeFps')
  const [windowSize, setWindowSize] = useState(300)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const instances = useMemo(
    () => [...(workspace?.instances ?? [])].sort((a, b) => a.order - b.order),
    [workspace]
  )

  const definition = METRICS.find((entry) => entry.id === metric)!

  const series: Series[] = instances
    .filter((instance) => !hidden.has(instance.id))
    .map((instance) => {
      const history = stats[instance.id] ?? []
      const sliced = Number.isFinite(windowSize) ? history.slice(-windowSize) : history
      return {
        label: instance.name,
        color: instance.color,
        points: sliced.map(definition.extract)
      }
    })
    .filter((entry) => entry.points.length > 0)

  const systemSeries: Series[] = [
    {
      label: 'Host CPU',
      color: '#4f9dff',
      points: system.slice(-windowSize).map((sample) => sample.cpuPercent)
    },
    {
      label: 'OBS processes CPU',
      color: '#38d39f',
      points: system.slice(-windowSize).map((sample) => sample.obsProcesses.cpuPercent)
    },
    {
      label: 'Memory used %',
      color: '#ffb454',
      points: system
        .slice(-windowSize)
        .map((sample) =>
          sample.memTotalMb > 0 ? (sample.memUsedMb / sample.memTotalMb) * 100 : null
        )
    }
  ]

  if (instances.length === 0) {
    return <Empty title="No instances">Telemetry appears once an instance is running.</Empty>
  }

  return (
    <>
      <Panel
        title="Metric"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <select
              className="select"
              style={{ width: 250 }}
              value={metric}
              onChange={(e) => setMetric(e.target.value as MetricId)}
            >
              {METRICS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.unit && ` (${entry.unit})`}
                </option>
              ))}
            </select>
            <div className="btn-group">
              {WINDOWS.map((option) => (
                <button
                  key={option.label}
                  className={`btn btn--sm ${windowSize === option.samples ? 'btn--primary' : ''}`}
                  onClick={() => setWindowSize(option.samples)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {series.length === 0 ? (
          <span className="faint">No samples yet. Launch an instance to start collecting.</span>
        ) : (
          <>
            <LineChart
              series={series}
              height={200}
              yMax={definition.yMax}
              yLabel={definition.label}
              format={definition.format}
            />
            <div className="row row--wrap" style={{ marginTop: 10, gap: 12 }}>
              {instances.map((instance) => (
                <button
                  key={instance.id}
                  className="btn btn--ghost btn--sm"
                  style={{ opacity: hidden.has(instance.id) ? 0.4 : 1 }}
                  onClick={() =>
                    setHidden((current) => {
                      const next = new Set(current)
                      if (next.has(instance.id)) next.delete(instance.id)
                      else next.add(instance.id)
                      return next
                    })
                  }
                >
                  <span
                    className="legend__swatch"
                    style={{ background: instance.color, width: 10, height: 3 }}
                  />
                  {instance.name}
                </button>
              ))}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Host">
        <LineChart series={systemSeries} height={160} yMax={100} format={(v) => `${v.toFixed(0)}%`} />
        <div style={{ marginTop: 8 }}>
          <Legend series={systemSeries} />
        </div>
      </Panel>

      <Panel title="Current values" flush>
        <div className="table__scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>FPS</th>
                <th>Render</th>
                <th>Render drop</th>
                <th>Enc drop</th>
                <th>CPU (OBS)</th>
                <th>CPU (proc)</th>
                <th>Memory</th>
                <th>Bitrate</th>
                <th>Data out</th>
                <th>Disk free</th>
                <th>Congestion</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((instance) => {
                const history = stats[instance.id] ?? []
                const latest = history[history.length - 1]
                return (
                  <tr key={instance.id}>
                    <td>
                      <span className="row" style={{ gap: 7 }}>
                        <span
                          style={{
                            width: 3,
                            height: 14,
                            borderRadius: 2,
                            background: instance.color
                          }}
                        />
                        {instance.name}
                      </span>
                    </td>
                    <td className="num">{latest?.activeFps?.toFixed(1) ?? '—'}</td>
                    <td className="num">{formatMs(latest?.averageFrameRenderTimeMs)}</td>
                    <td className="num">
                      {formatPercent(
                        dropPercent(
                          latest?.renderSkippedFrames ?? null,
                          latest?.renderTotalFrames ?? null
                        ),
                        2
                      )}
                    </td>
                    <td className="num">
                      {formatPercent(
                        dropPercent(
                          latest?.outputSkippedFrames ?? null,
                          latest?.outputTotalFrames ?? null
                        ),
                        2
                      )}
                    </td>
                    <td className="num">{formatPercent(latest?.obsCpuPercent, 1)}</td>
                    <td className="num">{formatPercent(latest?.procCpuPercent, 1)}</td>
                    <td className="num">{formatMb(latest?.obsMemoryMb)}</td>
                    <td className="num">{formatKbps(latest?.streamKbps ?? latest?.recordKbps)}</td>
                    <td className="num">
                      {formatMb(
                        ((latest?.streamBytes ?? 0) + (latest?.recordBytes ?? 0)) / (1024 * 1024) ||
                          null
                      )}
                    </td>
                    <td className="num">{formatMb(latest?.availableDiskSpaceMb)}</td>
                    <td className="num">
                      {latest?.streamCongestion !== null && latest?.streamCongestion !== undefined
                        ? latest.streamCongestion.toFixed(2)
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Frame counters" flush>
        <div className="table__scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Instance</th>
                <th>Render frames</th>
                <th>Render skipped</th>
                <th>Output frames</th>
                <th>Output skipped</th>
                <th>WS in</th>
                <th>WS out</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((instance) => {
                const history = stats[instance.id] ?? []
                const latest = history[history.length - 1]
                return (
                  <tr key={instance.id}>
                    <td>{instance.name}</td>
                    <td className="num">{formatNumber(latest?.renderTotalFrames)}</td>
                    <td className="num">{formatNumber(latest?.renderSkippedFrames)}</td>
                    <td className="num">{formatNumber(latest?.outputTotalFrames)}</td>
                    <td className="num">{formatNumber(latest?.outputSkippedFrames)}</td>
                    <td className="num faint">{formatNumber(latest?.webSocketIncomingMessages)}</td>
                    <td className="num faint">{formatNumber(latest?.webSocketOutgoingMessages)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <DiskPanel />
    </>
  )
}

function DiskPanel(): JSX.Element {
  const system = useFleet((state) => state.system)
  const latest = system[system.length - 1]
  if (!latest || latest.disks.length === 0) return <></>

  return (
    <Panel title="Volumes" flush>
      <div className="table__scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Mount</th>
              <th>Filesystem</th>
              <th>Used</th>
              <th>Total</th>
              <th>Free</th>
              <th>Utilisation</th>
            </tr>
          </thead>
          <tbody>
            {latest.disks.map((disk) => {
              const percent = disk.totalMb > 0 ? (disk.usedMb / disk.totalMb) * 100 : 0
              return (
                <tr key={`${disk.fs}-${disk.mount}`}>
                  <td className="mono">{disk.mount}</td>
                  <td className="faint mono">{disk.fs}</td>
                  <td className="num">{formatMb(disk.usedMb)}</td>
                  <td className="num">{formatMb(disk.totalMb)}</td>
                  <td className="num">{formatMb(disk.totalMb - disk.usedMb)}</td>
                  <td
                    className="num"
                    style={{ color: percent > 90 ? 'var(--critical)' : undefined }}
                  >
                    {percent.toFixed(0)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
