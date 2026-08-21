import type {
  HealthIssue,
  HealthLevel,
  HealthThresholds,
  InstanceHealth,
  InstanceRuntime,
  InstanceStats,
  SystemStats
} from '@shared/types'

export interface HealthInput {
  instanceId: string
  runtime: InstanceRuntime
  /** Most recent telemetry sample, if any. */
  latest: InstanceStats | null
  /** Recent samples, used for rate-of-change checks. */
  window: InstanceStats[]
  /** Configured output FPS, so drops are measured against the real target. */
  targetFps: number | null
  system: SystemStats | null
  thresholds: HealthThresholds
}

/**
 * Turns raw telemetry into the verdict shown on an instance card.
 *
 * Two design choices matter here:
 *  - Skipped-frame checks use the delta over the sample window, not the
 *    lifetime counters. A show that dropped 400 frames an hour ago is healthy
 *    now, and lifetime ratios would keep it red for the rest of the session.
 *  - Nothing is reported as a problem while the instance is not actually
 *    producing frames, so a freshly launched instance is quiet rather than
 *    alarming.
 */
export function evaluateHealth(input: HealthInput): InstanceHealth {
  const { instanceId, runtime, latest, window, targetFps, system, thresholds } = input
  const issues: HealthIssue[] = []

  if (runtime.state === 'crashed') {
    issues.push({ level: 'critical', code: 'crashed', message: 'Instance exited unexpectedly.' })
    return { instanceId, level: 'critical', issues }
  }

  if (runtime.state === 'stopped') {
    return { instanceId, level: 'unknown', issues }
  }

  if (runtime.state === 'running' && !runtime.wsConnected) {
    issues.push({
      level: 'warn',
      code: 'ws-disconnected',
      message: runtime.wsError
        ? `No control connection: ${runtime.wsError}`
        : 'Running, but the control connection is not established yet.'
    })
  }

  if (!latest) {
    return { instanceId, level: issues.length > 0 ? 'warn' : 'unknown', issues }
  }

  /* ---- render pipeline ---- */

  const renderDelta = counterDelta(window, 'renderSkippedFrames', 'renderTotalFrames')
  if (renderDelta && renderDelta.total > 0) {
    const percent = (renderDelta.skipped / renderDelta.total) * 100
    if (percent >= thresholds.renderSkipCriticalPercent) {
      issues.push({
        level: 'critical',
        code: 'render-lag',
        message: `Dropping ${percent.toFixed(1)}% of frames in the render thread (GPU cannot keep up).`
      })
    } else if (percent >= thresholds.renderSkipWarnPercent) {
      issues.push({
        level: 'warn',
        code: 'render-lag',
        message: `Rendering lag: ${percent.toFixed(1)}% of recent frames skipped.`
      })
    }
  }

  const outputDelta = counterDelta(window, 'outputSkippedFrames', 'outputTotalFrames')
  if (outputDelta && outputDelta.total > 0) {
    const percent = (outputDelta.skipped / outputDelta.total) * 100
    if (percent >= thresholds.outputSkipCriticalPercent) {
      issues.push({
        level: 'critical',
        code: 'encoder-overload',
        message: `Encoder overloaded: ${percent.toFixed(1)}% of recent frames dropped.`
      })
    } else if (percent >= thresholds.outputSkipWarnPercent) {
      issues.push({
        level: 'warn',
        code: 'encoder-overload',
        message: `Encoder straining: ${percent.toFixed(1)}% of recent frames dropped.`
      })
    }
  }

  /* ---- frame timing ---- */

  if (latest.averageFrameRenderTimeMs !== null) {
    if (latest.averageFrameRenderTimeMs >= thresholds.frameRenderTimeCriticalMs) {
      issues.push({
        level: 'critical',
        code: 'slow-render',
        message: `Average frame render time ${latest.averageFrameRenderTimeMs.toFixed(1)}ms.`
      })
    } else if (latest.averageFrameRenderTimeMs >= thresholds.frameRenderTimeWarnMs) {
      issues.push({
        level: 'warn',
        code: 'slow-render',
        message: `Average frame render time ${latest.averageFrameRenderTimeMs.toFixed(1)}ms.`
      })
    }
  }

  if (targetFps !== null && targetFps > 0 && latest.activeFps !== null && latest.activeFps > 0) {
    const shortfall = ((targetFps - latest.activeFps) / targetFps) * 100
    if (shortfall >= thresholds.fpsDropCriticalPercent) {
      issues.push({
        level: 'critical',
        code: 'fps-drop',
        message: `Running at ${latest.activeFps.toFixed(1)} FPS against a ${targetFps} FPS target.`
      })
    } else if (shortfall >= thresholds.fpsDropWarnPercent) {
      issues.push({
        level: 'warn',
        code: 'fps-drop',
        message: `FPS is ${shortfall.toFixed(0)}% below the ${targetFps} FPS target.`
      })
    }
  }

  /* ---- network ---- */

  if (latest.streamCongestion !== null && runtime.streaming) {
    if (latest.streamCongestion >= thresholds.congestionCritical) {
      issues.push({
        level: 'critical',
        code: 'congestion',
        message: `Stream congestion at ${(latest.streamCongestion * 100).toFixed(0)}%; frames are backing up.`
      })
    } else if (latest.streamCongestion >= thresholds.congestionWarn) {
      issues.push({
        level: 'warn',
        code: 'congestion',
        message: `Stream congestion at ${(latest.streamCongestion * 100).toFixed(0)}%.`
      })
    }
  }

  /* ---- disk ---- */

  if (latest.availableDiskSpaceMb !== null) {
    if (latest.availableDiskSpaceMb <= thresholds.diskSpaceCriticalMb) {
      issues.push({
        level: 'critical',
        code: 'disk-space',
        message: `Only ${formatMb(latest.availableDiskSpaceMb)} left on the recording volume.`
      })
    } else if (latest.availableDiskSpaceMb <= thresholds.diskSpaceWarnMb) {
      issues.push({
        level: 'warn',
        code: 'disk-space',
        message: `${formatMb(latest.availableDiskSpaceMb)} left on the recording volume.`
      })
    }
  }

  /* ---- host pressure ---- */

  if (system) {
    if (system.cpuPercent >= thresholds.cpuCriticalPercent) {
      issues.push({
        level: 'critical',
        code: 'host-cpu',
        message: `Host CPU at ${system.cpuPercent.toFixed(0)}%; instances are competing for the encoder.`
      })
    } else if (system.cpuPercent >= thresholds.cpuWarnPercent) {
      issues.push({
        level: 'warn',
        code: 'host-cpu',
        message: `Host CPU at ${system.cpuPercent.toFixed(0)}%.`
      })
    }

    if (system.memTotalMb > 0) {
      const memPercent = (system.memUsedMb / system.memTotalMb) * 100
      if (memPercent >= thresholds.memoryCriticalPercent) {
        issues.push({
          level: 'critical',
          code: 'host-memory',
          message: `Host memory at ${memPercent.toFixed(0)}%.`
        })
      } else if (memPercent >= thresholds.memoryWarnPercent) {
        issues.push({
          level: 'warn',
          code: 'host-memory',
          message: `Host memory at ${memPercent.toFixed(0)}%.`
        })
      }
    }
  }

  return { instanceId, level: worstLevel(issues), issues }
}

/**
 * Difference between the first and last sample of a cumulative counter pair.
 * Returns null when the window is too short or the counters reset (which OBS
 * does on scene collection changes).
 */
function counterDelta(
  window: InstanceStats[],
  skippedKey: 'renderSkippedFrames' | 'outputSkippedFrames',
  totalKey: 'renderTotalFrames' | 'outputTotalFrames'
): { skipped: number; total: number } | null {
  if (window.length < 2) return null

  const first = window[0]
  const last = window[window.length - 1]
  const firstSkipped = first[skippedKey]
  const firstTotal = first[totalKey]
  const lastSkipped = last[skippedKey]
  const lastTotal = last[totalKey]

  if (
    firstSkipped === null ||
    firstTotal === null ||
    lastSkipped === null ||
    lastTotal === null ||
    lastTotal < firstTotal ||
    lastSkipped < firstSkipped
  ) {
    return null
  }

  return { skipped: lastSkipped - firstSkipped, total: lastTotal - firstTotal }
}

export function worstLevel(issues: HealthIssue[]): HealthLevel {
  if (issues.some((issue) => issue.level === 'critical')) return 'critical'
  if (issues.some((issue) => issue.level === 'warn')) return 'warn'
  return 'ok'
}

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}
