import type {
  AssetMount,
  AssetMountStatus,
  BrowserSourceDeployTarget,
  BulkUpdateOutcome,
  BulkUpdatePreview,
  BulkUpdateRequest,
  BundleContents,
  BrowserSourceSpec,
  BulkOutcome,
  BulkRequest,
  ConfigExport,
  ConfigImportOptions,
  ConfigImportPlan,
  CreateInstanceRequest,
  CreateInstanceResult,
  DeployReport,
  DownloadJob,
  FleetUpdate,
  InstanceAddons,
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
  ObsCatalog,
  ObsInstall,
  ObsInstallRequest,
  ObsInstance,
  ObsPlugin,
  ObsTheme,
  ObsUpdateCandidate,
  RemovalPlan,
  RemoveInstallRequest,
  ExportBundleRequest,
  ImportBundleRequest,
  ImportPlan,
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
  /** Copy the source's window and dock arrangement. */
  uiLayout: boolean
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
  removeInstall(request: RemoveInstallRequest): Promise<void>
  revalidateInstalls(): Promise<ObsInstall[]>
  /** What removing this installation would break, before it is removed. */
  planInstallRemoval(installId: string, deleteFiles: boolean): Promise<RemovalPlan>
  /** Repoints instances at another installation, e.g. before removing one. */
  reassignInstances(instanceIds: string[], installId: string): Promise<number>

  /* ---- the OBS library ---- */
  /** Releases available to download, newest first. */
  obsCatalog(force?: boolean): Promise<ObsCatalog>
  /** Downloads a release and registers it as a managed installation. */
  installObsVersion(request: ObsInstallRequest): Promise<ObsInstall>
  /** Managed installations with a newer release available. */
  obsUpdates(): Promise<ObsUpdateCandidate[]>
  downloadJobs(): Promise<DownloadJob[]>
  cancelDownload(jobId: string): Promise<void>
  clearFinishedDownloads(): Promise<void>

  /* ---- plugins and themes ---- */
  readAddons(instanceId: string): Promise<InstanceAddons>
  installPluginArchive(instanceId: string): Promise<ObsPlugin[]>
  removePlugin(instanceId: string, pluginId: string): Promise<void>
  copyPluginsTo(sourceId: string, targetIds: string[]): Promise<BulkUpdateOutcome[]>
  installThemeFile(instanceId: string): Promise<ObsTheme>
  removeTheme(instanceId: string, themeId: string): Promise<void>
  setTheme(instanceId: string, themeId: string): Promise<void>

  /* ---- configuration transfer ---- */
  exportConfiguration(includeSecrets: boolean): Promise<{ path: string } | null>
  /** Opens a configuration document and reports what importing it would do. */
  chooseConfiguration(): Promise<{ path: string; document: ConfigExport } | null>
  planConfigurationImport(path: string, options: ConfigImportOptions): Promise<ConfigImportPlan>
  applyConfigurationImport(path: string, options: ConfigImportOptions): Promise<ConfigImportPlan>
  /** Pushes the workspace's default launch options onto existing instances. */
  applyInstanceDefaults(instanceIds: string[]): Promise<BulkUpdateOutcome[]>

  /* ---- self-update ---- */
  checkFleetUpdate(): Promise<FleetUpdate>

  /* ---- instances ---- */
  createInstances(request: CreateInstanceRequest): Promise<CreateInstanceResult>
  cloneInstance(sourceId: string, newName: string): Promise<ObsInstance>
  updateInstance(id: string, patch: Partial<ObsInstance>): Promise<ObsInstance>
  removeInstance(id: string, deleteFiles: boolean): Promise<void>
  /** What removing this instance would delete, before it is deleted. */
  planInstanceRemoval(id: string, deleteFiles: boolean): Promise<RemovalPlan>
  reorderInstances(orderedIds: string[]): Promise<void>
  repairInstance(id: string): Promise<string[]>
  verifyInstance(id: string): Promise<string[]>
  discoverInstances(): Promise<ObsInstance[]>
  /** Works out what a mass update would change, without writing anything. */
  previewBulkUpdate(request: BulkUpdateRequest): Promise<BulkUpdatePreview>
  /** Applies a mass update across the selected instances. */
  applyBulkUpdate(request: BulkUpdateRequest): Promise<BulkUpdateOutcome[]>
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

  /* ---- import / export ---- */
  exportBundle(request: ExportBundleRequest): Promise<{ path: string; sizeBytes: number } | null>
  chooseBundle(): Promise<BundleContents | null>
  inspectBundle(file: string): Promise<BundleContents>
  planImport(request: ImportBundleRequest): Promise<ImportPlan>
  applyImport(plan: ImportPlan, transform: SyncTransform): Promise<SyncResult>
  importBundleAssets(file: string, overwrite: boolean): Promise<{ written: number; skipped: number }>

  /* ---- HTML assets ---- */
  listHtmlAssets(): Promise<HtmlAsset[]>
  listAssetMounts(): Promise<AssetMountStatus[]>
  addAssetMount(): Promise<AssetMountStatus[]>
  updateAssetMount(id: string, patch: Partial<AssetMount>): Promise<AssetMountStatus[]>
  removeAssetMount(id: string): Promise<AssetMountStatus[]>
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
  'planInstallRemoval',
  'reassignInstances',
  'obsCatalog',
  'installObsVersion',
  'obsUpdates',
  'downloadJobs',
  'cancelDownload',
  'clearFinishedDownloads',
  'readAddons',
  'installPluginArchive',
  'removePlugin',
  'copyPluginsTo',
  'installThemeFile',
  'removeTheme',
  'setTheme',
  'exportConfiguration',
  'chooseConfiguration',
  'planConfigurationImport',
  'applyConfigurationImport',
  'applyInstanceDefaults',
  'checkFleetUpdate',
  'revalidateInstalls',
  'createInstances',
  'cloneInstance',
  'updateInstance',
  'removeInstance',
  'planInstanceRemoval',
  'reorderInstances',
  'repairInstance',
  'verifyInstance',
  'discoverInstances',
  'previewBulkUpdate',
  'applyBulkUpdate',
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
  'exportBundle',
  'chooseBundle',
  'inspectBundle',
  'planImport',
  'applyImport',
  'importBundleAssets',
  'listHtmlAssets',
  'listAssetMounts',
  'addAssetMount',
  'updateAssetMount',
  'removeAssetMount',
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
