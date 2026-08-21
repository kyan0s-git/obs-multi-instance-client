import type {
  BrowserSourceDeployTarget,
  BrowserSourceSpec,
  BulkOutcome,
  BulkRequest,
  CreateInstanceRequest,
  CreateInstanceResult,
  DeployReport,
  HtmlAsset,
  InstanceAssets,
  InstanceHealth,
  InstanceRuntime,
  InstanceSnapshot,
  InstanceStats,
  IpcEventName,
  IpcEvents,
  LogEntry,
  NativeWindow,
  ObsInstall,
  ObsInstance,
  SyncPlan,
  SyncResult,
  SyncTransform,
  SystemStats,
  TileRequest,
  TileResult,
  WorkspaceSettings,
  WorkspaceState
} from './types'

export interface DisplayInfo {
  id: number
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  primary: boolean
}

export interface LaunchPreview {
  command: string
  cwd: string
  /** Only the environment variables the client sets or overrides. */
  env: Record<string, string>
  configDir: string
  executable: string
}

export interface SyncPlanRequest {
  sourceInstanceId: string
  targetInstanceIds: string[]
  profiles: string[]
  sceneCollections: string[]
  transform: SyncTransform
  skipIdentical: boolean
}

export interface WindowCapability {
  available: boolean
  detail: string
}

/**
 * The complete surface the renderer can call.
 *
 * Every method is an `ipcRenderer.invoke` round trip; there is no direct Node
 * access in the renderer, which is why `contextIsolation` stays on and
 * `nodeIntegration` stays off.
 */
export interface FleetApi {
  /* ---- workspace ---- */
  getState(): Promise<WorkspaceState>
  updateSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings>
  chooseWorkspaceRoot(): Promise<string | null>
  openPath(target: string): Promise<void>
  revealPath(target: string): Promise<void>
  /** Opens an http(s) URL in the operator's default browser. */
  openUrl(url: string): Promise<void>

  /* ---- installs ---- */
  detectInstalls(): Promise<ObsInstall[]>
  addInstall(root: string): Promise<ObsInstall>
  browseForInstall(): Promise<ObsInstall | null>
  removeInstall(id: string): Promise<void>
  revalidateInstalls(): Promise<ObsInstall[]>

  /* ---- instances ---- */
  createInstances(request: CreateInstanceRequest): Promise<CreateInstanceResult>
  cloneInstance(sourceId: string, newName: string): Promise<ObsInstance>
  updateInstance(id: string, patch: Partial<ObsInstance>): Promise<ObsInstance>
  removeInstance(id: string, deleteFiles: boolean): Promise<void>
  reorderInstances(orderedIds: string[]): Promise<void>
  repairInstance(id: string): Promise<string[]>
  verifyInstance(id: string): Promise<string[]>
  discoverInstances(): Promise<ObsInstance[]>
  renumberPorts(): Promise<void>
  previewLaunch(id: string): Promise<LaunchPreview>

  /* ---- lifecycle ---- */
  launch(id: string): Promise<void>
  launchAll(ids?: string[]): Promise<BulkOutcome[]>
  stop(id: string, force: boolean): Promise<void>
  stopAll(ids?: string[], force?: boolean): Promise<BulkOutcome[]>
  bulk(request: BulkRequest): Promise<BulkOutcome[]>

  /* ---- runtime / telemetry ---- */
  getRuntimes(): Promise<InstanceRuntime[]>
  getHealth(): Promise<InstanceHealth[]>
  getStatsHistory(id: string): Promise<InstanceStats[]>
  getAllStatsHistory(): Promise<Record<string, InstanceStats[]>>
  getSystemHistory(): Promise<SystemStats[]>

  /* ---- control surface ---- */
  getSnapshot(id: string): Promise<InstanceSnapshot | null>
  refreshSnapshot(id: string): Promise<InstanceSnapshot | null>
  setScene(id: string, sceneName: string): Promise<void>
  setPreviewScene(id: string, sceneName: string): Promise<void>
  setStudioMode(id: string, enabled: boolean): Promise<void>
  triggerTransition(id: string): Promise<void>
  setSceneItemEnabled(
    id: string,
    sceneName: string,
    sceneItemId: number,
    enabled: boolean
  ): Promise<void>
  setInputMute(id: string, inputName: string, muted: boolean): Promise<void>
  setInputVolumeDb(id: string, inputName: string, volumeDb: number): Promise<void>
  openSourceProperties(id: string, inputName: string): Promise<void>

  /* ---- multiview ---- */
  setMultiviewVisible(ids: string[] | null): Promise<void>
  captureNow(id: string): Promise<void>

  /* ---- sync ---- */
  readAssets(id: string): Promise<InstanceAssets>
  readAllAssets(): Promise<InstanceAssets[]>
  planSync(request: SyncPlanRequest): Promise<SyncPlan>
  applySync(plan: SyncPlan, transform: SyncTransform): Promise<SyncResult>

  /* ---- HTML assets ---- */
  listHtmlAssets(): Promise<HtmlAsset[]>
  importHtmlAssets(): Promise<HtmlAsset[]>
  createHtmlAsset(name: string, contents: string): Promise<HtmlAsset[]>
  deleteHtmlAsset(relPath: string): Promise<HtmlAsset[]>
  reloadHtmlAssets(): Promise<void>
  assetServerUrl(): Promise<string | null>
  deployBrowserSource(
    spec: BrowserSourceSpec,
    targets: BrowserSourceDeployTarget[]
  ): Promise<DeployReport[]>
  listBrowserSources(id: string): Promise<Array<{ name: string; url: string }>>

  /* ---- window control ---- */
  listDisplays(): Promise<DisplayInfo[]>
  windowCapability(): Promise<WindowCapability>
  listNativeWindows(): Promise<NativeWindow[]>
  tileWindows(request: TileRequest): Promise<TileResult>
  focusWindow(id: string): Promise<void>
  minimizeWindows(ids: string[]): Promise<void>

  /* ---- logs ---- */
  getLogs(limit?: number): Promise<LogEntry[]>
  clearLogs(): Promise<void>
  openInstanceLogFolder(id: string): Promise<void>

  /* ---- events ---- */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

/** Channel prefix for every invoke; keeps the namespace obvious in devtools. */
export const IPC_PREFIX = 'fleet'

export const IPC_EVENT_CHANNEL = 'fleet:event'

/**
 * Method names the preload bridge exposes. Kept as data so preload can build
 * the bridge in a loop and main can assert every one has a handler.
 */
export const API_METHODS = [
  'getState',
  'updateSettings',
  'chooseWorkspaceRoot',
  'openPath',
  'revealPath',
  'openUrl',
  'detectInstalls',
  'addInstall',
  'browseForInstall',
  'removeInstall',
  'revalidateInstalls',
  'createInstances',
  'cloneInstance',
  'updateInstance',
  'removeInstance',
  'reorderInstances',
  'repairInstance',
  'verifyInstance',
  'discoverInstances',
  'renumberPorts',
  'previewLaunch',
  'launch',
  'launchAll',
  'stop',
  'stopAll',
  'bulk',
  'getRuntimes',
  'getHealth',
  'getStatsHistory',
  'getAllStatsHistory',
  'getSystemHistory',
  'getSnapshot',
  'refreshSnapshot',
  'setScene',
  'setPreviewScene',
  'setStudioMode',
  'triggerTransition',
  'setSceneItemEnabled',
  'setInputMute',
  'setInputVolumeDb',
  'openSourceProperties',
  'setMultiviewVisible',
  'captureNow',
  'readAssets',
  'readAllAssets',
  'planSync',
  'applySync',
  'listHtmlAssets',
  'importHtmlAssets',
  'createHtmlAsset',
  'deleteHtmlAsset',
  'reloadHtmlAssets',
  'assetServerUrl',
  'deployBrowserSource',
  'listBrowserSources',
  'listDisplays',
  'windowCapability',
  'listNativeWindows',
  'tileWindows',
  'focusWindow',
  'minimizeWindows',
  'getLogs',
  'clearLogs',
  'openInstanceLogFolder'
] as const

export type ApiMethod = (typeof API_METHODS)[number]
