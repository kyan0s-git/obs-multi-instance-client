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

/**
 * What sync can move between instances.
 *
 * `uiLayout` is the OBS window arrangement — dock positions, custom browser
 * docks, panel visibility — which lives in `user.ini` under `[BasicWindow]`
 * rather than in a profile or scene collection.
 */
export type SyncAssetKind = 'profile' | 'sceneCollection' | 'uiLayout'

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
  /** At most one entry: the instance's saved window/dock arrangement. */
  uiLayouts: SyncAsset[]
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
  /**
   * Include the main window's saved position and size when copying a UI
   * layout. Off by default: identical geometry stacks every OBS window in the
   * same spot, which the Window layout page then has to undo.
   */
  includeWindowGeometry: boolean
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
/* Import / export bundles                                             */
/* ------------------------------------------------------------------ */

/** One instance's configuration as packed inside a bundle. */
export interface BundleSource {
  instanceName: string
  role: string
  color: string
  profiles: Array<{ slug: string; name: string; fileCount: number }>
  sceneCollections: Array<{ slug: string; name: string }>
  uiLayout: { description: string } | null
}

/** What a bundle on disk contains, read without extracting it. */
export interface BundleContents {
  path: string
  sizeBytes: number
  createdAt: number
  createdBy: string
  platform: string
  sources: BundleSource[]
  assets: { fileCount: number; totalBytes: number } | null
  fileCount: number
}

export interface ExportBundleRequest {
  sourceInstanceIds: string[]
  /** Asset slugs per instance id; an empty list means every asset. */
  profiles: Record<string, string[]>
  sceneCollections: Record<string, string[]>
  includeUiLayout: boolean
  /** Bundle the workspace asset library so overlays travel with the config. */
  includeAssets: boolean
}

export interface ImportBundleRequest {
  file: string
  sourceName: string
  targetInstanceIds: string[]
  profiles: string[]
  sceneCollections: string[]
  uiLayout: boolean
  transform: SyncTransform
  skipIdentical: boolean
}

/** A planned import, with the staging folder it will be applied from. */
export interface ImportPlan {
  plan: SyncPlan
  stagingDir: string
}

/* ------------------------------------------------------------------ */
/* HTML assets / browser sources                                       */
/* ------------------------------------------------------------------ */

/**
 * A folder published to every instance by the built-in asset server.
 *
 * The workspace's own `assets/` folder is always mounted at the root. Extra
 * mounts let a team point the fleet at an existing media library — b-roll,
 * stings, logo packs, font files — without copying gigabytes into the
 * workspace.
 */
export interface AssetMount {
  id: string
  /** Human label shown in the UI. */
  name: string
  /** Absolute path of the folder on disk. */
  path: string
  enabled: boolean
  /**
   * Watch the folder for changes and push a live reload.
   *
   * Off by default for added mounts: recursively watching a large media
   * library costs file handles and CPU for files that rarely change, and OBS
   * re-reads media on scene activation anyway.
   */
  watch: boolean
  /** True for the built-in workspace mount, which cannot be removed. */
  builtIn: boolean
}

export interface AssetMountStatus {
  id: string
  name: string
  path: string
  enabled: boolean
  watch: boolean
  builtIn: boolean
  /** Populated when the folder is missing or unreadable. */
  error: string | null
  fileCount: number
  totalBytes: number
  /** True when the listing hit its cap and is not showing everything. */
  truncated: boolean
  /** URL prefix this mount is served under. */
  urlPrefix: string
}

export interface HtmlAsset {
  id: string
  name: string
  /** Which mount this file came from. */
  mountId: string
  /** Path relative to that mount's root. */
  relPath: string
  absPath: string
  sizeBytes: number
  modifiedAt: number
  /** URL served by the built-in asset server. */
  url: string
  /** Broad category, used for filtering and for picking the right OBS source. */
  kind: AssetKind
  /** Declared `{{token}}` placeholders found in the file (HTML only). */
  tokens: string[]
}

export type AssetKind = 'html' | 'image' | 'video' | 'audio' | 'script' | 'font' | 'other'

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
  /** Extra folders published to every instance alongside the workspace assets. */
  assetMounts: AssetMount[]
  /**
   * Cap on OBS stdout/stderr lines forwarded to the log pane per second, per
   * instance. A verbose OBS can emit thousands, and every one costs an IPC
   * message plus a renderer re-render.
   */
  logRateLimitPerSecond: number
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
/* Bulk instance updates                                               */
/* ------------------------------------------------------------------ */

/**
 * A field a bulk update is allowed to write.
 *
 * The set is explicit rather than a `Partial<ObsInstance>` because a patch
 * object cannot distinguish "leave autoRestart alone" from "set autoRestart to
 * false" — and on a twelve-instance fleet, silently clearing a flag on every
 * instance is exactly the kind of mistake that is discovered mid-show.
 */
export type BulkUpdatableField =
  | 'installId'
  | 'role'
  | 'color'
  | 'notes'
  | 'disabled'
  | 'autoRestart'
  | 'websocketEnabled'
  | 'websocketIpv4Only'
  | 'profile'
  | 'sceneCollection'
  | 'startScene'
  | 'startRecording'
  | 'startStreaming'
  | 'startReplayBuffer'
  | 'startVirtualCam'
  | 'studioMode'
  | 'minimizeToTray'
  | 'alwaysOnTop'
  | 'safeMode'
  | 'onlyBundledPlugins'
  | 'disableUpdater'
  | 'disableMissingFilesCheck'
  | 'verboseLog'
  | 'extraArgs'

/** Values a bulk update can apply. Only fields named in `fields` are read. */
export interface BulkUpdateValues {
  installId?: string
  role?: string
  color?: string
  notes?: string
  disabled?: boolean
  autoRestart?: boolean
  websocketEnabled?: boolean
  websocketIpv4Only?: boolean
  profile?: string | null
  sceneCollection?: string | null
  startScene?: string | null
  startRecording?: boolean
  startStreaming?: boolean
  startReplayBuffer?: boolean
  startVirtualCam?: boolean
  studioMode?: boolean
  minimizeToTray?: boolean
  alwaysOnTop?: boolean
  safeMode?: boolean
  onlyBundledPlugins?: boolean
  disableUpdater?: boolean
  disableMissingFilesCheck?: boolean
  verboseLog?: boolean
  extraArgs?: string[]
}

export interface BulkUpdateRequest {
  instanceIds: string[]
  fields: BulkUpdatableField[]
  values: BulkUpdateValues
  /**
   * Re-run provisioning after applying.
   *
   * This is what repairs a fleet after OBS itself was upgraded or moved:
   * portable instances hold junctions into the base install, and those have to
   * be rebuilt. Changing `installId` forces it on.
   */
  reprovision: boolean
}

export interface BulkUpdateChange {
  field: BulkUpdatableField
  label: string
  from: string
  to: string
}

/** What a bulk update would do to one instance, before anything is written. */
export interface BulkUpdatePreviewItem {
  instanceId: string
  instanceName: string
  changes: BulkUpdateChange[]
  /** Reasons this instance needs attention, e.g. it is currently running. */
  warnings: string[]
  /** True when provisioning will be re-run for this instance. */
  willReprovision: boolean
}

export interface BulkUpdatePreview {
  items: BulkUpdatePreviewItem[]
  warnings: string[]
}

export interface BulkUpdateOutcome {
  instanceId: string
  ok: boolean
  changed: number
  detail: string
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
  'preview:frames': PreviewFrame[]
  'log:entry': LogEntry
  'snapshot:changed': InstanceSnapshot
  'assets:changed': HtmlAsset[]
}

export type IpcEventName = keyof IpcEvents
