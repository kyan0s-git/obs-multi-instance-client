import os from 'node:os'
import path from 'node:path'
import type {
  HealthThresholds,
  InstanceLaunchOptions,
  MultiviewSettings,
  WorkspaceSettings
} from '@shared/types'

/** Palette used to colour-code instance cards, previews and chart series. */
export const INSTANCE_COLORS = [
  '#4f9dff',
  '#38d39f',
  '#ffb454',
  '#ff6b8a',
  '#a78bfa',
  '#2dd4bf',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb923c',
  '#34d399',
  '#c084fc'
] as const

export function defaultLaunchOptions(): InstanceLaunchOptions {
  return {
    profile: null,
    sceneCollection: null,
    startScene: null,
    startStreaming: false,
    startRecording: false,
    startReplayBuffer: false,
    startVirtualCam: false,
    studioMode: false,
    minimizeToTray: false,
    alwaysOnTop: false,
    safeMode: false,
    onlyBundledPlugins: false,
    // Instances are managed as a fleet; per-instance updaters fight each other.
    disableUpdater: true,
    // A modal on startup would block an unattended bulk launch.
    disableMissingFilesCheck: true,
    verboseLog: false,
    extraArgs: [],
    env: {}
  }
}

export function defaultThresholds(): HealthThresholds {
  return {
    renderSkipWarnPercent: 1,
    renderSkipCriticalPercent: 5,
    outputSkipWarnPercent: 1,
    outputSkipCriticalPercent: 5,
    fpsDropWarnPercent: 5,
    fpsDropCriticalPercent: 15,
    frameRenderTimeWarnMs: 8,
    frameRenderTimeCriticalMs: 16,
    congestionWarn: 0.3,
    congestionCritical: 0.7,
    diskSpaceWarnMb: 20_000,
    diskSpaceCriticalMb: 5_000,
    cpuWarnPercent: 80,
    cpuCriticalPercent: 92,
    memoryWarnPercent: 85,
    memoryCriticalPercent: 94
  }
}

export function defaultMultiview(): MultiviewSettings {
  return { enabled: true, fps: 2, quality: 480, source: 'program' }
}

/** Default workspace root: `~/OBS Fleet`, kept outside the app bundle. */
export function defaultWorkspaceRoot(): string {
  return path.join(os.homedir(), 'OBS Fleet')
}

export function defaultSettings(): WorkspaceSettings {
  return {
    root: defaultWorkspaceRoot(),
    // 4455 is the obs-websocket default; the fleet starts one above it so a
    // stock OBS on the same host keeps working.
    basePort: 4456,
    perInstancePasswords: true,
    sharedPassword: '',
    bulkLaunchStaggerMs: 2500,
    statsIntervalMs: 1000,
    statsHistoryLength: 300,
    multiview: defaultMultiview(),
    thresholds: defaultThresholds(),
    assetServerPort: 4599,
    assetServerEnabled: true,
    assetMounts: [],
    logRateLimitPerSecond: 40,
    theme: 'dark',
    confirmDestructive: true
  }
}

/** Fills in any field a hand-edited or older settings file is missing. */
export function mergeSettings(partial: Partial<WorkspaceSettings> | null): WorkspaceSettings {
  const base = defaultSettings()
  if (!partial) return base
  return {
    ...base,
    ...partial,
    multiview: { ...base.multiview, ...(partial.multiview ?? {}) },
    thresholds: { ...base.thresholds, ...(partial.thresholds ?? {}) },
    assetMounts: Array.isArray(partial.assetMounts) ? partial.assetMounts : base.assetMounts
  }
}

export function mergeLaunchOptions(
  partial: Partial<InstanceLaunchOptions> | null | undefined
): InstanceLaunchOptions {
  const base = defaultLaunchOptions()
  if (!partial) return base
  return {
    ...base,
    ...partial,
    extraArgs: partial.extraArgs ? [...partial.extraArgs] : base.extraArgs,
    env: { ...base.env, ...(partial.env ?? {}) }
  }
}
