/**
 * Shared vocabulary between the Electron main process and the renderer.
 * Everything crossing the IPC boundary is described here.
 */

export type Platform = 'win32' | 'darwin' | 'linux'

/* ------------------------------------------------------------------ */
/* OBS installations                                                   */
/* ------------------------------------------------------------------ */

/**
 * A discovered (or manually registered) OBS Studio installation that
 * instances can be based on.
 */
export interface ObsInstall {
  id: string
  /** Human label, e.g. "OBS Studio 31.0.2 (Program Files)". */
  label: string
  /**
   * Root of the OBS installation.
   *  - win32:  the folder containing `bin/`, `data/`, `obs-plugins/`
   *  - darwin: the `.app` bundle
   *  - linux:  prefix containing `bin/obs` (usually `/usr`)
   */
  root: string
  /** Absolute path to the launchable binary. */
  executable: string
  version: string | null
  /** True when this entry was found by auto-detection rather than added by hand. */
  detected: boolean
  /** Populated when the install fails validation. */
  problems: string[]
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

export type InstanceRunState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'connected'
  | 'stopping'
  | 'crashed'

/**
 * How the instance gets an isolated OBS configuration directory.
 *
 * Which strategies are available is decided by how OBS itself resolves its
 * config path on each platform:
 *  - Windows builds always compile portable mode in, and resolve portable
 *    config to `<exe>/../../config`, so a per-instance install root works.
 *  - Linux and macOS builds ship with `ENABLE_PORTABLE_CONFIG` off, so
 *    portable mode is unavailable and isolation comes from the environment:
 *    `XDG_CONFIG_HOME` on Linux, `HOME` on macOS.
 */
export type IsolationStrategy =
  /** Windows: portable mode against a junction farm pointing at the base install. */
  | 'portable-linkfarm'
  /** Windows: portable mode against a full copy of the base install. */
  | 'portable-copy'
  /** Linux: shared install, per-instance `XDG_CONFIG_HOME`. */
  | 'xdg-config-home'
  /** macOS: shared app bundle, per-instance `HOME`. */
  | 'home-redirect'

export interface InstanceLaunchOptions {
  /** `--profile` */
  profile: string | null
  /** `--collection` */
  sceneCollection: string | null
  /** `--scene` */
  startScene: string | null
  startStreaming: boolean
  startRecording: boolean
  startReplayBuffer: boolean
  startVirtualCam: boolean
  studioMode: boolean
  minimizeToTray: boolean
  alwaysOnTop: boolean
  safeMode: boolean
  onlyBundledPlugins: boolean
  disableUpdater: boolean
  disableMissingFilesCheck: boolean
  verboseLog: boolean
  /** Extra raw arguments appended verbatim. */
  extraArgs: string[]
  /** Extra environment variables for the child process. */
  env: Record<string, string>
}

export interface InstanceWebSocket {
  enabled: boolean
  port: number
  password: string
  /** Bind the OBS websocket server to IPv4 only (`--websocket_ipv4_only`). */
  ipv4Only: boolean
}

export interface ObsInstance {
  id: string
  name: string
  /** Free-form label shown on the instance card, e.g. "Cam ISO 1". */
  role: string
  color: string
  /** Absolute path of this instance's folder inside the workspace. */
  dir: string
  /** Id of the {@link ObsInstall} this instance runs. */
  installId: string
  isolation: IsolationStrategy
  websocket: InstanceWebSocket
  launch: InstanceLaunchOptions
  /** Launch order for bulk starts — lower goes first. */
  order: number
  /** Skip this instance in bulk operations. */
  disabled: boolean
  /** Relaunch automatically if the process dies unexpectedly. */
  autoRestart: boolean
  createdAt: number
  updatedAt: number
  notes: string
}

/** Everything the UI needs to render one instance, config + live state. */
export interface InstanceRuntime {
  id: string
  state: InstanceRunState
  pid: number | null
  startedAt: number | null
  /** Last non-zero exit information, if the process ended badly. */
  exit: { code: number | null; signal: string | null; at: number } | null
  wsConnected: boolean
  wsError: string | null
  obsVersion: string | null
  currentProgramScene: string | null
  currentPreviewScene: string | null
  studioModeEnabled: boolean
  streaming: boolean
  recording: boolean
  recordingPaused: boolean
  replayBufferActive: boolean
  virtualCamActive: boolean
  sceneCollection: string | null
  profile: string | null
  /** Last error surfaced by launch or supervision. */
  lastError: string | null
}

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

/** One telemetry sample for a single instance. */
export interface InstanceStats {
  instanceId: string
  at: number
  /** Reported by OBS itself (whole-process CPU %, as OBS measures it). */
  obsCpuPercent: number | null
  /** Reported by OBS: resident memory in MB. */
  obsMemoryMb: number | null
  /** Process CPU % sampled from the OS by pid. */
  procCpuPercent: number | null
  /** Process RSS in MB sampled from the OS by pid. */
  procMemoryMb: number | null
  availableDiskSpaceMb: number | null
  activeFps: number | null
  averageFrameRenderTimeMs: number | null
  renderSkippedFrames: number | null
  renderTotalFrames: number | null
  outputSkippedFrames: number | null
  outputTotalFrames: number | null
  /** Live encoder bitrate in kbit/s, derived from byte deltas. */
  streamKbps: number | null
  recordKbps: number | null
  streamBytes: number | null
  recordBytes: number | null
  streamDurationMs: number | null
  recordDurationMs: number | null
  /** 0..1, from OBS `GetStreamStatus`. */
  streamCongestion: number | null
  webSocketIncomingMessages: number | null
  webSocketOutgoingMessages: number | null
}

/** Host-wide telemetry, sampled once for the whole machine. */
export interface SystemStats {
  at: number
  cpuPercent: number
  cpuPerCore: number[]
  cpuTemperatureC: number | null
  memUsedMb: number
  memTotalMb: number
  gpus: GpuStats[]
  disks: DiskStats[]
  network: { rxKbps: number; txKbps: number }
  /** Aggregate across every tracked OBS process. */
  obsProcesses: { count: number; cpuPercent: number; memoryMb: number }
}

export interface GpuStats {
  vendor: string
  model: string
  utilizationPercent: number | null
  memoryUsedMb: number | null
  memoryTotalMb: number | null
  temperatureC: number | null
  /** Encoder/decoder utilisation where the driver exposes it (NVIDIA). */
  encoderUtilPercent: number | null
  decoderUtilPercent: number | null
}

export interface DiskStats {
  mount: string
  fs: string
  usedMb: number
  totalMb: number
  /** Sampled read/write throughput in MB/s where available. */
  readMbps: number | null
  writeMbps: number | null
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export type HealthLevel = 'ok' | 'warn' | 'critical' | 'unknown'

export interface HealthIssue {
  level: Exclude<HealthLevel, 'ok' | 'unknown'>
  code: string
  message: string
}

export interface InstanceHealth {
  instanceId: string
  level: HealthLevel
  issues: HealthIssue[]
}

/** Thresholds that turn raw telemetry into health verdicts. */
export interface HealthThresholds {
  renderSkipWarnPercent: number
  renderSkipCriticalPercent: number
  outputSkipWarnPercent: number
  outputSkipCriticalPercent: number
  fpsDropWarnPercent: number
  fpsDropCriticalPercent: number
  frameRenderTimeWarnMs: number
  frameRenderTimeCriticalMs: number
  congestionWarn: number
  congestionCritical: number
  diskSpaceWarnMb: number
  diskSpaceCriticalMb: number
  cpuWarnPercent: number
  cpuCriticalPercent: number
  memoryWarnPercent: number
  memoryCriticalPercent: number
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

export type SyncAssetKind = 'profile' | 'sceneCollection'

export interface SyncAsset {
  kind: SyncAssetKind
  /** Display name as OBS shows it. */
  name: string
  /** On-disk file or directory name (OBS slugifies display names). */
  slug: string
  /** Absolute path to the asset (a directory for profiles, a .json for collections). */
  path: string
  sizeBytes: number
  modifiedAt: number
  /** Stable content hash used to tell whether two instances are in sync. */
  hash: string
}

export interface InstanceAssets {
  instanceId: string
  profiles: SyncAsset[]
  sceneCollections: SyncAsset[]
  /** Set when the instance folder could not be inspected. */
  error: string | null
}

/** Rewrites applied while copying an asset into a target instance. */
export interface SyncTransform {
  /** Give the copy a new display name in the target (blank keeps the source name). */
  renameTo?: string
  /** Literal path prefix replacements applied to every string in the asset. */
  pathRewrites: Array<{ from: string; to: string }>
  /**
   * Repoint recording output at the target instance's own `recordings/`
   * folder, so copied profiles never make two instances write the same file.
   */
  retargetRecordingPath: boolean
  /** Clear stream keys so a copied profile cannot double-publish by accident. */
  stripStreamKey: boolean
  /** Give copied browser sources per-instance query params (`?instance=<name>`). */
  tagBrowserSources: boolean
  /** Regenerate source UUIDs so copied scenes do not collide across instances. */
  regenerateUuids: boolean
}

export interface SyncPlanItem {
  kind: SyncAssetKind
  sourceInstanceId: string
  targetInstanceId: string
  assetName: string
  targetName: string
  targetPath: string
  action: 'create' | 'overwrite' | 'skip-identical'
  /** Populated for overwrites — where the previous version is backed up. */
  backupPath: string | null
}

export interface SyncPlan {
  items: SyncPlanItem[]
  warnings: string[]
}

export interface SyncResult {
  applied: SyncPlanItem[]
  failed: Array<{ item: SyncPlanItem; error: string }>
}

/* ------------------------------------------------------------------ */
/* HTML assets / browser sources                                       */
/* ------------------------------------------------------------------ */

export interface HtmlAsset {
  id: string
  name: string
  /** Path relative to the workspace `assets/` root. */
  relPath: string
  absPath: string
  sizeBytes: number
  modifiedAt: number
  /** URL served by the built-in asset server. */
  url: string
  /** Declared `{{token}}` placeholders found in the file. */
  tokens: string[]
}

export interface BrowserSourceSpec {
  /** Source name inside OBS. */
  name: string
  /** Either a served asset id, or `null` when using a raw URL. */
  assetId: string | null
  url: string
  width: number
  height: number
  fps: number
  /** Use OBS's own tick rate rather than a custom FPS. */
  fpsCustom: boolean
  /** CSS injected by OBS into the page. */
  css: string
  shutdownWhenNotVisible: boolean
  restartWhenActivated: boolean
  /** Route page audio into OBS instead of the desktop. */
  controlAudio: boolean
  /** Per-instance query parameters appended to the URL. */
  perInstanceParams: boolean
}

export interface BrowserSourceDeployTarget {
  instanceId: string
  /** Scene to add the source into; `null` means the current program scene. */
  sceneName: string | null
}

export interface DeployReport {
  instanceId: string
  ok: boolean
  detail: string
}

/* ------------------------------------------------------------------ */
/* Native window control                                               */
/* ------------------------------------------------------------------ */

export interface NativeWindow {
  /** Platform-specific handle: HWND (win32), window id (linux), or index (darwin). */
  handle: string
  pid: number
  title: string
  instanceId: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  minimized: boolean
}

export type TileLayout =
  | 'grid'
  | 'columns'
  | 'rows'
  | 'main-and-stack'
  | 'cascade'
  | 'stack'

export interface TileRequest {
  layout: TileLayout
  /** Instance ids in the order they should be placed. */
  instanceIds: string[]
  /** Display to tile onto; `null` uses the primary display. */
  displayId: number | null
  /** Inner gap between windows, in pixels. */
  gap: number
  /** Outer margin from the display work area, in pixels. */
  margin: number
  /** For `main-and-stack`: which instance gets the large pane. */
  mainInstanceId: string | null
}

export interface TileResult {
  moved: Array<{ instanceId: string; handle: string }>
  failed: Array<{ instanceId: string; reason: string }>
  /** Non-fatal notes, e.g. missing platform helper. */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* Multiview                                                           */
/* ------------------------------------------------------------------ */

export interface PreviewFrame {
  instanceId: string
  at: number
  /** `data:image/jpeg;base64,...` straight from OBS `GetSourceScreenshot`. */
  dataUri: string | null
  error: string | null
}

export interface MultiviewSettings {
  enabled: boolean
  /** Frames per second to poll from each instance. */
  fps: number
  /** Longest edge of the requested screenshot, in pixels. */
  quality: number
  /** Poll the preview (studio mode) output instead of program. */
  source: 'program' | 'preview'
}

/* ------------------------------------------------------------------ */
/* Workspace / settings                                                */
/* ------------------------------------------------------------------ */

export interface WorkspaceSettings {
  /** Root folder holding every instance directory. */
  root: string
  /** First websocket port handed out to new instances. */
  basePort: number
  /** Generate a unique random password per instance instead of sharing one. */
  perInstancePasswords: boolean
  /** Shared password used when {@link perInstancePasswords} is false. */
  sharedPassword: string
  /** Delay between launches during a bulk start, in ms. */
  bulkLaunchStaggerMs: number
  /** Telemetry sampling interval, in ms. */
  statsIntervalMs: number
  /** How many telemetry samples to retain per instance. */
  statsHistoryLength: number
  multiview: MultiviewSettings
  thresholds: HealthThresholds
  /** Port for the built-in HTML asset server. */
  assetServerPort: number
  assetServerEnabled: boolean
  theme: 'dark' | 'midnight' | 'light'
  confirmDestructive: boolean
}

export interface WorkspaceState {
  settings: WorkspaceSettings
  installs: ObsInstall[]
  instances: ObsInstance[]
}

/* ------------------------------------------------------------------ */
/* Bulk operations                                                     */
/* ------------------------------------------------------------------ */

export type BulkAction =
  | 'launch'
  | 'quit'
  | 'kill'
  | 'startRecording'
  | 'stopRecording'
  | 'pauseRecording'
  | 'resumeRecording'
  | 'startStreaming'
  | 'stopStreaming'
  | 'startReplayBuffer'
  | 'stopReplayBuffer'
  | 'saveReplayBuffer'
  | 'startVirtualCam'
  | 'stopVirtualCam'
  | 'setScene'
  | 'setPreviewScene'
  | 'triggerTransition'
  | 'setStudioMode'
  | 'refreshBrowserSources'
  | 'splitRecordFile'
  | 'setProfile'
  | 'setSceneCollection'

export interface BulkRequest {
  action: BulkAction
  instanceIds: string[]
  /** Action-specific payload — scene name, boolean flag, and so on. */
  payload?: Record<string, unknown>
}

export interface BulkOutcome {
  instanceId: string
  ok: boolean
  detail: string
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  at: number
  level: LogLevel
  /** Subsystem that emitted the line, e.g. `launcher`, `ws:cam-1`. */
  scope: string
  message: string
  instanceId: string | null
}

/* ------------------------------------------------------------------ */
/* Scenes / sources snapshot for the control surface                   */
/* ------------------------------------------------------------------ */

export interface SceneItemInfo {
  id: number
  sourceName: string
  enabled: boolean
  locked: boolean
  /** Present when the item is a group or nested scene. */
  isGroup: boolean
  inputKind: string | null
}

export interface AudioInputInfo {
  name: string
  muted: boolean
  /** Multiplier, 0..1+. */
  volumeMul: number
  volumeDb: number
  inputKind: string | null
}

export interface InstanceSnapshot {
  instanceId: string
  scenes: string[]
  currentProgramScene: string | null
  currentPreviewScene: string | null
  studioMode: boolean
  sceneItems: SceneItemInfo[]
  audioInputs: AudioInputInfo[]
  profiles: string[]
  sceneCollections: string[]
  currentProfile: string | null
  currentSceneCollection: string | null
  transitions: string[]
  currentTransition: string | null
}

/* ------------------------------------------------------------------ */
/* Instance creation                                                   */
/* ------------------------------------------------------------------ */

export interface CreateInstanceRequest {
  name: string
  role?: string
  color?: string
  installId: string
  isolation?: IsolationStrategy
  /** Copy profiles + scene collections from this instance after creation. */
  seedFromInstanceId?: string | null
  /** Copy the host user's own OBS config as the starting point. */
  seedFromHostConfig?: boolean
  /** Explicit websocket port; omitted means "next free port". */
  port?: number
  launch?: Partial<InstanceLaunchOptions>
  count?: number
}

export interface CreateInstanceResult {
  instances: ObsInstance[]
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* IPC event payloads (main -> renderer)                               */
/* ------------------------------------------------------------------ */

export interface IpcEvents {
  'workspace:changed': WorkspaceState
  'runtime:changed': InstanceRuntime[]
  'stats:instance': InstanceStats[]
  'stats:system': SystemStats
  'health:changed': InstanceHealth[]
  'preview:frame': PreviewFrame
  'log:entry': LogEntry
  'snapshot:changed': InstanceSnapshot
  'assets:changed': HtmlAsset[]
}

export type IpcEventName = keyof IpcEvents
