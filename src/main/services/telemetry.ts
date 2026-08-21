import { EventEmitter } from 'node:events'
import pidusage from 'pidusage'
import si from 'systeminformation'
import type { DiskStats, GpuStats, InstanceStats, SystemStats } from '@shared/types'
import { log, errorMessage } from '../util/logger.js'
import type { ObsPool } from './obs-pool.js'

/** Supplies the OBS processes to sample, keyed by instance. */
export type PidProvider = () => Array<{ instanceId: string; pid: number }>

/** Byte/duration counters carried between ticks so bitrate can be derived. */
interface OutputCursor {
  bytes: number
  at: number
}

interface InstanceCursors {
  stream: OutputCursor | null
  record: OutputCursor | null
}

/**
 * Samples every instance and the host machine on a fixed cadence and keeps a
 * bounded history for the charts.
 *
 * OBS reports cumulative byte counters rather than a bitrate, so live bitrate
 * is differentiated here from consecutive samples. That also means the first
 * sample after a recording starts reports `null` rather than a wild number.
 */
export class Telemetry extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private systemTimer: NodeJS.Timeout | null = null
  private cursors = new Map<string, InstanceCursors>()
  private history = new Map<string, InstanceStats[]>()
  private systemHistory: SystemStats[] = []
  private lastSystem: SystemStats | null = null
  private intervalMs = 1000
  private historyLength = 300
  private sampling = false

  constructor(
    private readonly pool: ObsPool,
    private readonly pids: PidProvider
  ) {
    super()
  }

  configure(options: { intervalMs?: number; historyLength?: number }): void {
    if (options.intervalMs !== undefined) {
      this.intervalMs = Math.max(250, options.intervalMs)
    }
    if (options.historyLength !== undefined) {
      this.historyLength = Math.max(30, options.historyLength)
      for (const [id, samples] of this.history) {
        if (samples.length > this.historyLength) {
          this.history.set(id, samples.slice(-this.historyLength))
        }
      }
    }
    if (this.timer) this.start()
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    // Host-level probes (GPU, disks, network) are considerably more expensive
    // than an OBS round trip, so they run on their own slower cadence.
    this.systemTimer = setInterval(() => void this.sampleSystem(), Math.max(2000, this.intervalMs * 2))
    void this.tick()
    void this.sampleSystem()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.systemTimer) clearInterval(this.systemTimer)
    this.timer = null
    this.systemTimer = null
  }

  /** Drops retained state for an instance that was deleted or stopped. */
  forget(instanceId: string): void {
    this.cursors.delete(instanceId)
    this.history.delete(instanceId)
  }

  getHistory(instanceId: string): InstanceStats[] {
    return this.history.get(instanceId) ?? []
  }

  getAllHistory(): Record<string, InstanceStats[]> {
    return Object.fromEntries(this.history)
  }

  getSystemHistory(): SystemStats[] {
    return this.systemHistory
  }

  getLatestSystem(): SystemStats | null {
    return this.lastSystem
  }

  /* ---------------- instance sampling ---------------- */

  private async tick(): Promise<void> {
    // A slow OBS (or a stalled disk) can make a tick outlast its interval;
    // skipping rather than stacking keeps the queue from running away.
    if (this.sampling) return
    this.sampling = true

    try {
      const connectedIds = this.pool.connectedIds()
      const processCpu = await this.sampleProcesses()

      const samples = await Promise.all(
        connectedIds.map((id) => this.sampleInstance(id, processCpu.get(id) ?? null))
      )
      const valid = samples.filter((sample): sample is InstanceStats => sample !== null)

      for (const sample of valid) {
        const bucket = this.history.get(sample.instanceId) ?? []
        bucket.push(sample)
        if (bucket.length > this.historyLength) bucket.splice(0, bucket.length - this.historyLength)
        this.history.set(sample.instanceId, bucket)
      }

      if (valid.length > 0) this.emit('instance', valid)
    } catch (err) {
      log.debug('telemetry', `Sample tick failed: ${errorMessage(err)}`)
    } finally {
      this.sampling = false
    }
  }

  private async sampleInstance(
    instanceId: string,
    process: { cpu: number; memoryMb: number } | null
  ): Promise<InstanceStats | null> {
    const connection = this.pool.get(instanceId)
    if (!connection?.isConnected) return null

    const at = Date.now()

    try {
      // One batch keeps the three status reads on a single round trip, so the
      // numbers in a sample all describe the same moment.
      const responses = await connection.callBatch(
        [
          { requestType: 'GetStats' },
          { requestType: 'GetStreamStatus' },
          { requestType: 'GetRecordStatus' }
        ],
        6000
      )

      const stats = pick(responses, 'GetStats')
      const stream = pick(responses, 'GetStreamStatus')
      const record = pick(responses, 'GetRecordStatus')

      const cursors = this.cursors.get(instanceId) ?? { stream: null, record: null }
      const streamKbps = this.deriveKbps(cursors, 'stream', num(stream?.outputBytes), at, bool(stream?.outputActive))
      const recordKbps = this.deriveKbps(cursors, 'record', num(record?.outputBytes), at, bool(record?.outputActive))
      this.cursors.set(instanceId, cursors)

      return {
        instanceId,
        at,
        obsCpuPercent: num(stats?.cpuUsage),
        obsMemoryMb: num(stats?.memoryUsage),
        procCpuPercent: process?.cpu ?? null,
        procMemoryMb: process?.memoryMb ?? null,
        availableDiskSpaceMb: num(stats?.availableDiskSpace),
        activeFps: num(stats?.activeFps),
        averageFrameRenderTimeMs: num(stats?.averageFrameRenderTime),
        renderSkippedFrames: num(stats?.renderSkippedFrames),
        renderTotalFrames: num(stats?.renderTotalFrames),
        outputSkippedFrames: num(stats?.outputSkippedFrames),
        outputTotalFrames: num(stats?.outputTotalFrames),
        streamKbps,
        recordKbps,
        streamBytes: num(stream?.outputBytes),
        recordBytes: num(record?.outputBytes),
        streamDurationMs: num(stream?.outputDuration),
        recordDurationMs: num(record?.outputDuration),
        streamCongestion: num(stream?.outputCongestion),
        webSocketIncomingMessages: num(stats?.webSocketSessionIncomingMessages),
        webSocketOutgoingMessages: num(stats?.webSocketSessionOutgoingMessages)
      }
    } catch (err) {
      log.debug('telemetry', `Instance sample failed: ${errorMessage(err)}`, instanceId)
      return null
    }
  }

  /**
   * Converts a cumulative byte counter into kbit/s.
   *
   * Returns null on the first sample of an output and whenever the counter
   * resets (a new recording file), because a delta against a stale cursor
   * would render as a spike that never happened.
   */
  private deriveKbps(
    cursors: InstanceCursors,
    key: 'stream' | 'record',
    bytes: number | null,
    at: number,
    active: boolean
  ): number | null {
    if (!active || bytes === null) {
      cursors[key] = null
      return null
    }

    const previous = cursors[key]
    cursors[key] = { bytes, at }

    if (!previous || bytes < previous.bytes) return null
    const elapsedSec = (at - previous.at) / 1000
    if (elapsedSec <= 0) return null

    return ((bytes - previous.bytes) * 8) / 1000 / elapsedSec
  }

  /** OS-level CPU/RSS for each running OBS process, keyed by instance. */
  private async sampleProcesses(): Promise<Map<string, { cpu: number; memoryMb: number }>> {
    const tracked = this.pids()
    const result = new Map<string, { cpu: number; memoryMb: number }>()
    if (tracked.length === 0) return result

    try {
      const stats = await pidusage(tracked.map((entry) => entry.pid))
      for (const { instanceId, pid } of tracked) {
        const entry = stats[pid]
        if (!entry) continue
        result.set(instanceId, {
          cpu: Math.round(entry.cpu * 10) / 10,
          memoryMb: Math.round(entry.memory / (1024 * 1024))
        })
      }
    } catch (err) {
      // A process that exits mid-sample makes pidusage throw for the whole
      // batch; the next tick picks up the corrected pid list.
      log.debug('telemetry', `Process sample failed: ${errorMessage(err)}`)
    }

    return result
  }

  /* ---------------- host sampling ---------------- */

  private async sampleSystem(): Promise<void> {
    try {
      const [load, mem, graphics, disks, net, temp] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.graphics().catch(() => ({ controllers: [] as unknown[] })),
        si.fsSize().catch(() => [] as unknown[]),
        si.networkStats().catch(() => [] as unknown[]),
        si.cpuTemperature().catch(() => ({ main: null }))
      ])

      const processStats = await this.sampleProcesses()
      const obsAggregate = [...processStats.values()].reduce(
        (acc, entry) => ({
          count: acc.count + 1,
          cpuPercent: acc.cpuPercent + entry.cpu,
          memoryMb: acc.memoryMb + entry.memoryMb
        }),
        { count: 0, cpuPercent: 0, memoryMb: 0 }
      )

      const sample: SystemStats = {
        at: Date.now(),
        cpuPercent: round1(load.currentLoad),
        cpuPerCore: (load.cpus ?? []).map((core) => round1(core.load)),
        cpuTemperatureC: typeof temp.main === 'number' ? round1(temp.main) : null,
        memUsedMb: Math.round((mem.total - mem.available) / (1024 * 1024)),
        memTotalMb: Math.round(mem.total / (1024 * 1024)),
        gpus: mapGpus(graphics.controllers as unknown[]),
        disks: mapDisks(disks as unknown[]),
        network: aggregateNetwork(net as unknown[]),
        obsProcesses: {
          count: obsAggregate.count,
          cpuPercent: round1(obsAggregate.cpuPercent),
          memoryMb: obsAggregate.memoryMb
        }
      }

      this.lastSystem = sample
      this.systemHistory.push(sample)
      if (this.systemHistory.length > this.historyLength) {
        this.systemHistory.splice(0, this.systemHistory.length - this.historyLength)
      }

      this.emit('system', sample)
    } catch (err) {
      log.debug('telemetry', `System sample failed: ${errorMessage(err)}`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Response shaping                                                    */
/* ------------------------------------------------------------------ */

type BatchResponse = Array<{
  requestType: string
  requestStatus: { result: boolean; code: number }
  responseData?: Record<string, unknown>
}>

/** Pulls one response out of a batch, tolerating a request that failed. */
function pick(responses: BatchResponse, requestType: string): Record<string, unknown> | null {
  const match = responses.find((response) => response.requestType === requestType)
  if (!match || !match.requestStatus.result) return null
  return match.responseData ?? null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown): boolean {
  return value === true
}

function round1(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : 0
}

function mapGpus(controllers: unknown[]): GpuStats[] {
  return controllers.map((raw) => {
    const gpu = raw as Record<string, unknown>
    return {
      vendor: String(gpu.vendor ?? 'Unknown'),
      model: String(gpu.model ?? 'Unknown'),
      utilizationPercent: num(gpu.utilizationGpu),
      memoryUsedMb: num(gpu.memoryUsed),
      memoryTotalMb: num(gpu.memoryTotal),
      temperatureC: num(gpu.temperatureGpu),
      // Only NVIDIA exposes these, and only through nvidia-smi.
      encoderUtilPercent: num(gpu.utilizationEncoder),
      decoderUtilPercent: num(gpu.utilizationDecoder)
    }
  })
}

function mapDisks(entries: unknown[]): DiskStats[] {
  return entries
    .map((raw) => {
      const disk = raw as Record<string, unknown>
      return {
        mount: String(disk.mount ?? ''),
        fs: String(disk.fs ?? ''),
        usedMb: Math.round(Number(disk.used ?? 0) / (1024 * 1024)),
        totalMb: Math.round(Number(disk.size ?? 0) / (1024 * 1024)),
        readMbps: null,
        writeMbps: null
      }
    })
    .filter((disk) => disk.totalMb > 0)
}

function aggregateNetwork(entries: unknown[]): { rxKbps: number; txKbps: number } {
  let rx = 0
  let tx = 0
  for (const raw of entries) {
    const iface = raw as Record<string, unknown>
    rx += Math.max(0, Number(iface.rx_sec ?? 0))
    tx += Math.max(0, Number(iface.tx_sec ?? 0))
  }
  return { rxKbps: Math.round((rx * 8) / 1000), txKbps: Math.round((tx * 8) / 1000) }
}
