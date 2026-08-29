import { describe, expect, it } from 'vitest'
import type { InstanceHealth, InstanceRuntime, InstanceStats, SystemStats } from '../src/shared/types'
import { defaultThresholds } from '../src/main/services/defaults'
import { evaluateHealth, sameHealth } from '../src/main/services/health'

function runtime(overrides: Partial<InstanceRuntime> = {}): InstanceRuntime {
  return {
    id: 'i1',
    state: 'connected',
    pid: 100,
    startedAt: Date.now() - 60_000,
    exit: null,
    wsConnected: true,
    wsError: null,
    obsVersion: '5.5.0',
    currentProgramScene: 'Scene',
    currentPreviewScene: null,
    studioModeEnabled: false,
    streaming: false,
    recording: false,
    recordingPaused: false,
    replayBufferActive: false,
    virtualCamActive: false,
    sceneCollection: 'Main',
    profile: 'Show',
    lastError: null,
    ...overrides
  }
}

function sample(overrides: Partial<InstanceStats> = {}): InstanceStats {
  return {
    instanceId: 'i1',
    at: Date.now(),
    obsCpuPercent: 12,
    obsMemoryMb: 800,
    procCpuPercent: 14,
    procMemoryMb: 820,
    availableDiskSpaceMb: 500_000,
    activeFps: 60,
    averageFrameRenderTimeMs: 2,
    renderSkippedFrames: 0,
    renderTotalFrames: 1000,
    outputSkippedFrames: 0,
    outputTotalFrames: 1000,
    streamKbps: null,
    recordKbps: null,
    streamBytes: null,
    recordBytes: null,
    streamDurationMs: null,
    recordDurationMs: null,
    streamCongestion: null,
    webSocketIncomingMessages: 10,
    webSocketOutgoingMessages: 10,
    ...overrides
  }
}

function healthyInput(overrides: Record<string, unknown> = {}) {
  const latest = sample()
  return {
    instanceId: 'i1',
    runtime: runtime(),
    latest,
    window: [sample({ renderTotalFrames: 1000 }), sample({ renderTotalFrames: 1600 })],
    targetFps: 60,
    system: null as SystemStats | null,
    thresholds: defaultThresholds(),
    ...overrides
  }
}

describe('evaluateHealth', () => {
  it('reports a healthy instance as ok with no issues', () => {
    const result = evaluateHealth(healthyInput())
    expect(result.level).toBe('ok')
    expect(result.issues).toEqual([])
  })

  it('treats a stopped instance as unknown rather than a problem', () => {
    const result = evaluateHealth(healthyInput({ runtime: runtime({ state: 'stopped' }) }))
    expect(result.level).toBe('unknown')
    expect(result.issues).toEqual([])
  })

  it('flags a crash as critical and stops there', () => {
    const result = evaluateHealth(healthyInput({ runtime: runtime({ state: 'crashed' }) }))
    expect(result.level).toBe('critical')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].code).toBe('crashed')
  })

  it('warns when a running instance has no control connection', () => {
    const result = evaluateHealth(
      healthyInput({ runtime: runtime({ state: 'running', wsConnected: false }) })
    )
    expect(result.issues.some((issue) => issue.code === 'ws-disconnected')).toBe(true)
  })

  it('measures frame drops over the window, not the instance lifetime', () => {
    // 400 frames were skipped long ago, but nothing has been skipped recently.
    const window = [
      sample({ renderSkippedFrames: 400, renderTotalFrames: 10_000 }),
      sample({ renderSkippedFrames: 400, renderTotalFrames: 10_600 })
    ]
    const result = evaluateHealth(
      healthyInput({ window, latest: window[window.length - 1] })
    )
    expect(result.issues.some((issue) => issue.code === 'render-lag')).toBe(false)
  })

  it('flags render lag when frames are being skipped right now', () => {
    const window = [
      sample({ renderSkippedFrames: 0, renderTotalFrames: 1000 }),
      sample({ renderSkippedFrames: 60, renderTotalFrames: 1600 })
    ]
    const result = evaluateHealth(healthyInput({ window, latest: window[1] }))

    const issue = result.issues.find((entry) => entry.code === 'render-lag')
    expect(issue?.level).toBe('critical')
  })

  it('ignores counters that reset, rather than reporting a phantom spike', () => {
    // A scene collection change resets OBS's counters; the later sample has
    // fewer total frames than the earlier one.
    const window = [
      sample({ renderSkippedFrames: 500, renderTotalFrames: 90_000 }),
      sample({ renderSkippedFrames: 0, renderTotalFrames: 30 })
    ]
    const result = evaluateHealth(healthyInput({ window, latest: window[1] }))
    expect(result.issues.some((issue) => issue.code === 'render-lag')).toBe(false)
  })

  it('flags an FPS shortfall against the configured target', () => {
    const result = evaluateHealth(
      healthyInput({ latest: sample({ activeFps: 40 }), targetFps: 60 })
    )
    const issue = result.issues.find((entry) => entry.code === 'fps-drop')
    expect(issue?.level).toBe('critical')
  })

  it('skips the FPS check when the target is unknown', () => {
    const result = evaluateHealth(
      healthyInput({ latest: sample({ activeFps: 40 }), targetFps: null })
    )
    expect(result.issues.some((issue) => issue.code === 'fps-drop')).toBe(false)
  })

  it('only reports congestion while actually streaming', () => {
    const idle = evaluateHealth(healthyInput({ latest: sample({ streamCongestion: 0.9 }) }))
    expect(idle.issues.some((issue) => issue.code === 'congestion')).toBe(false)

    const live = evaluateHealth(
      healthyInput({
        latest: sample({ streamCongestion: 0.9 }),
        runtime: runtime({ streaming: true })
      })
    )
    expect(live.issues.find((issue) => issue.code === 'congestion')?.level).toBe('critical')
  })

  it('escalates as the recording volume fills up', () => {
    const warn = evaluateHealth(healthyInput({ latest: sample({ availableDiskSpaceMb: 10_000 }) }))
    expect(warn.issues.find((issue) => issue.code === 'disk-space')?.level).toBe('warn')

    const critical = evaluateHealth(healthyInput({ latest: sample({ availableDiskSpaceMb: 900 }) }))
    expect(critical.issues.find((issue) => issue.code === 'disk-space')?.level).toBe('critical')
  })

  it('reports host pressure when the machine is saturated', () => {
    const system: SystemStats = {
      at: Date.now(),
      cpuPercent: 95,
      cpuPerCore: [],
      cpuTemperatureC: null,
      memUsedMb: 31_000,
      memTotalMb: 32_000,
      gpus: [],
      disks: [],
      network: { rxKbps: 0, txKbps: 0 },
      obsProcesses: { count: 4, cpuPercent: 88, memoryMb: 6000 }
    }

    const result = evaluateHealth(healthyInput({ system }))
    expect(result.issues.some((issue) => issue.code === 'host-cpu')).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'host-memory')).toBe(true)
    expect(result.level).toBe('critical')
  })

  it('stays quiet on a freshly launched instance with no samples yet', () => {
    const result = evaluateHealth(healthyInput({ latest: null, window: [] }))
    expect(result.level).toBe('unknown')
  })
})

describe('sameHealth', () => {
  const entry = (
    instanceId: string,
    level: InstanceHealth['level'],
    issues: InstanceHealth['issues'] = []
  ): InstanceHealth => ({ instanceId, level, issues })

  it('treats structurally identical payloads as unchanged', () => {
    const a = [entry('a', 'ok'), entry('b', 'warn', [{ level: 'warn', code: 'fps', message: '54 fps' }])]
    const b = [entry('a', 'ok'), entry('b', 'warn', [{ level: 'warn', code: 'fps', message: '54 fps' }])]

    expect(sameHealth(a, b)).toBe(true)
  })

  it('notices a level change', () => {
    expect(sameHealth([entry('a', 'ok')], [entry('a', 'warn')])).toBe(false)
  })

  it('notices a new or resolved issue', () => {
    const clean = [entry('a', 'ok')]
    const broken = [entry('a', 'critical', [{ level: 'critical', code: 'disk', message: 'full' }])]

    expect(sameHealth(clean, broken)).toBe(false)
    expect(sameHealth(broken, clean)).toBe(false)
  })

  it('notices a reading that moved but kept its code', () => {
    const before = [entry('a', 'warn', [{ level: 'warn', code: 'fps', message: '54 fps' }])]
    const after = [entry('a', 'warn', [{ level: 'warn', code: 'fps', message: '48 fps' }])]

    expect(sameHealth(before, after)).toBe(false)
  })

  it('notices an instance appearing or being removed', () => {
    expect(sameHealth([entry('a', 'ok')], [entry('a', 'ok'), entry('b', 'ok')])).toBe(false)
    expect(sameHealth([], [])).toBe(true)
  })

  it('notices the roster being reordered', () => {
    expect(sameHealth([entry('a', 'ok'), entry('b', 'warn')], [entry('b', 'warn'), entry('a', 'ok')])).toBe(
      false
    )
  })
})
