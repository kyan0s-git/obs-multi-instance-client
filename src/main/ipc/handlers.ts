import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import {
  API_METHODS,
  IPC_EVENT_CHANNEL,
  IPC_PREFIX,
  type ApiMethod,
  type DisplayInfo,
  type FleetApi,
  type LaunchPreview
} from '@shared/api'
import type {
  BulkUpdateOutcome,
  InstanceAssets,
  IpcEventName,
  IpcEvents,
  ObsUpdateCandidate
} from '@shared/types'
import { BUILD_ID } from '@shared/version.js'
import { randomUUID } from 'node:crypto'
import { ensureDir, pathExists, removeQuiet, safeFolderName } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { buildLaunchSpec, formatCommandRedacted } from '../services/launch-args.js'
import { layoutFor, describeManualInstall, detectInstalls, revalidateInstall } from '../services/obs-install.js'
import * as control from '../services/obs-control.js'
import { instanceExecutable, instancePaths, workspacePaths } from '../services/paths.js'
import { applySync, planSync, readInstanceAssets } from '../services/sync.js'
import {
  applyImport,
  exportBundle,
  importBundleAssets,
  inspectBundle,
  planImport
} from '../services/bundle.js'
import { WORKSPACE_MOUNT_ID } from '../services/asset-server.js'
import { planInstallRemoval, planInstanceRemoval, type RemovalContext } from '../services/removal.js'
import { downloadSupport, isNewer, latestRelease } from '../services/obs-catalog.js'
import {
  copyPlugins,
  installPlugin,
  installTheme,
  readAddons,
  removePlugin as removeInstancePlugin,
  removeTheme as removeInstanceTheme,
  setTheme as setInstanceTheme
} from '../services/obs-addons.js'
import {
  buildConfigExport,
  planConfigImport,
  readConfigExport,
  settingsToApply
} from '../services/config-transfer.js'
import { checkForFleetUpdate } from '../services/fleet-update.js'
import type { Supervisor } from '../services/supervisor.js'

/** Methods of the API that main implements; the shape is checked against FleetApi. */
type Handlers = {
  [K in ApiMethod]: (...args: never[]) => unknown
}

/**
 * Registers every IPC handler and starts forwarding supervisor events to the
 * renderer.
 *
 * Handlers stay thin: they translate arguments, call a service, and let errors
 * propagate. Electron serialises a thrown error back to the caller's promise,
 * which is exactly the behaviour the renderer's toast layer expects.
 */
export function registerIpc(supervisor: Supervisor, getWindow: () => BrowserWindow | null): void {
  const handlers = buildHandlers(supervisor, getWindow)

  for (const method of API_METHODS) {
    const handler = handlers[method]
    ipcMain.handle(`${IPC_PREFIX}:${method}`, async (_event, ...args: unknown[]) => {
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        log.error('ipc', `${method} failed: ${errorMessage(err)}`)
        throw err
      }
    })
  }

  forwardEvents(supervisor, getWindow)
}

export function disposeIpc(): void {
  for (const method of API_METHODS) ipcMain.removeHandler(`${IPC_PREFIX}:${method}`)
}

/* ------------------------------------------------------------------ */
/* Event forwarding                                                    */
/* ------------------------------------------------------------------ */

const FORWARDED: IpcEventName[] = [
  'workspace:changed',
  'runtime:changed',
  'stats:instance',
  'stats:system',
  'health:changed',
  'preview:frames',
  'log:entry',
  'snapshot:changed',
  'assets:changed',
  'downloads:changed'
]

function forwardEvents(supervisor: Supervisor, getWindow: () => BrowserWindow | null): void {
  const send = <E extends IpcEventName>(event: E, payload: IpcEvents[E]): void => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IPC_EVENT_CHANNEL, { event, payload })
  }

  for (const event of FORWARDED) {
    if (event === 'log:entry' || event === 'downloads:changed') continue
    supervisor.on(event, (payload) => send(event, payload as IpcEvents[typeof event]))
  }

  // The downloader is its own emitter rather than a supervisor event, because
  // progress fires far more often than anything else the supervisor relays.
  supervisor.downloader.on('jobs', (jobs) => send('downloads:changed', jobs as IpcEvents['downloads:changed']))

  // Logs come straight off the logger so main-process messages emitted before
  // the supervisor exists still reach the UI.
  log.on('entry', (entry) => send('log:entry', entry))
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function buildHandlers(
  supervisor: Supervisor,
  getWindow: () => BrowserWindow | null
): Handlers & FleetApiImplementation {
  const { store, instances, launcher, pool, telemetry, multiview, assets, windows, downloader } =
    supervisor

  /** Everything a removal plan needs to describe consequences. */
  const removalContext = (): RemovalContext => ({
    workspaceRoot: store.getSettings().root,
    instances: store.getInstances(),
    installs: store.getInstalls(),
    runningIds: new Set(launcher.runningIds())
  })

  const resolvePair = (id: string) => {
    const instance = store.getInstance(id)
    if (!instance) return null
    const install = store.getInstall(instance.installId)
    if (!install) return null
    return { instance, install }
  }

  /**
   * A running instance holds its configuration in memory, so files written
   * underneath it change nothing on screen until it restarts. Saying so beats
   * letting the operator wonder why the sync appeared to do nothing.
   */
  const warnAboutRunningTargets = (instanceIds: string[]): void => {
    for (const id of new Set(instanceIds.filter((target) => launcher.isRunning(target)))) {
      log.warn(
        'sync',
        `"${store.getInstance(id)?.name ?? id}" is running; restart it to pick up the copied files.`,
        id
      )
    }
  }

  return {
    /* ---- workspace ---- */

    getState: async () => store.getState(),

    updateSettings: async (patch) => supervisor.applySettings(patch),

    chooseWorkspaceRoot: async () => {
      const window = getWindow()
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose a workspace folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: store.getSettings().root
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },

    openPath: async (target) => {
      const error = await shell.openPath(target)
      if (error !== '') throw new Error(error)
    },

    revealPath: async (target) => {
      shell.showItemInFolder(target)
    },

    openUrl: async (url) => {
      // Restricted to http(s) so a crafted asset URL cannot be turned into a
      // file:// or custom-scheme handler invocation.
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Refusing to open a ${parsed.protocol} URL`)
      }
      await shell.openExternal(parsed.toString())
    },

    /* ---- installs ---- */

    detectInstalls: async () => {
      const detected = await detectInstalls()
      await store.mergeDetectedInstalls(detected)
      return store.getInstalls()
    },

    addInstall: async (root) => {
      const install = await describeManualInstall(root)
      return store.addInstall(install)
    },

    browseForInstall: async () => {
      const window = getWindow()
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        title: 'Locate the OBS Studio installation',
        // On macOS the install *is* an .app bundle, so files must be pickable.
        properties: process.platform === 'darwin' ? ['openDirectory', 'openFile'] : ['openDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return null
      const install = await describeManualInstall(result.filePaths[0])
      return store.addInstall(install)
    },

    removeInstall: async (request) => {
      const install = store.getInstall(request.installId)
      if (!install) return

      const plan = await planInstallRemoval(request.installId, request.deleteFiles, removalContext())
      if (plan.blockers.length > 0) throw new Error(plan.blockers.join(' '))

      if (plan.affectedInstances.length > 0 && !request.force) {
        throw new Error(
          `${plan.affectedInstances.length} instance(s) still use this installation. ` +
            'Confirm the removal to proceed anyway.'
        )
      }

      await store.removeInstall(request.installId, request.force)

      // Deleting comes last: an unregistered-but-present folder is recoverable,
      // a deleted-but-still-registered one is not.
      for (const deletion of plan.deletions) await removeQuiet(deletion.path)
    },

    planInstallRemoval: async (installId, deleteFiles) =>
      planInstallRemoval(installId, deleteFiles, removalContext()),

    reassignInstances: async (instanceIds, installId) => {
      if (!store.getInstall(installId)) throw new Error('That installation is not registered')

      let moved = 0
      for (const id of instanceIds) {
        const instance = store.getInstance(id)
        if (!instance || instance.installId === installId) continue
        await instances.update(id, { installId })
        // The instance's portable links point into the old install, so the
        // folder has to be re-provisioned against the new one.
        await instances.repair(id).catch(() => undefined)
        moved += 1
      }
      return moved
    },

    revalidateInstalls: async () => {
      // `addInstall` merges onto the entry with the same root, so this
      // refreshes metadata in place rather than creating duplicates.
      const refreshed = await Promise.all(store.getInstalls().map(revalidateInstall))
      for (const install of refreshed) await store.addInstall(install)
      return store.getInstalls()
    },

    /* ---- instances ---- */

    createInstances: async (request) => instances.create(request),
    cloneInstance: async (sourceId, newName) => instances.clone(sourceId, newName),
    updateInstance: async (id, patch) => {
      const updated = await instances.update(id, patch)
      // A port or password edit means the live connection is now pointed at
      // the wrong endpoint.
      if (patch.websocket) await pool.open(updated)
      return updated
    },
    removeInstance: async (id, deleteFiles) => {
      if (launcher.isRunning(id)) await supervisor.stop(id, false)
      await instances.remove(id, deleteFiles)
    },

    planInstanceRemoval: async (id, deleteFiles) =>
      planInstanceRemoval(id, deleteFiles, removalContext()),
    reorderInstances: async (orderedIds) => store.reorderInstances(orderedIds),
    repairInstance: async (id) => instances.repair(id),
    verifyInstance: async (id) => instances.verify(id),
    discoverInstances: async () => instances.discover(),

    previewBulkUpdate: async (request) => instances.preview(request),

    applyBulkUpdate: async (request) => {
      const outcomes = await instances.applyBulkUpdate(request)

      // A running instance holds its launch options from when it started, so
      // a changed flag only takes effect on the next launch.
      warnAboutRunningTargets(
        outcomes.filter((outcome) => outcome.changed > 0).map((outcome) => outcome.instanceId)
      )

      // Websocket changes move the endpoint the pool is pointed at.
      if (request.fields.some((field) => field.startsWith('websocket'))) {
        for (const outcome of outcomes) {
          const instance = store.getInstance(outcome.instanceId)
          if (instance) await pool.open(instance)
        }
      }

      return outcomes
    },
    renumberPorts: async () => instances.renumberPorts(),

    previewLaunch: async (id): Promise<LaunchPreview> => {
      const pair = resolvePair(id)
      if (!pair) throw new Error('Instance or its OBS install is missing')

      const executable = instanceExecutable(pair.instance, pair.install, layoutFor().executableRel)
      const spec = buildLaunchSpec(pair.instance, pair.install, executable)
      const paths = instancePaths(pair.instance, pair.install)

      // Only the variables the client sets are interesting; echoing the whole
      // environment back would be noise and could leak unrelated secrets.
      const interesting: Record<string, string> = {}
      for (const key of ['XDG_CONFIG_HOME', 'HOME', 'OBS_FLEET_INSTANCE_ID', 'OBS_FLEET_INSTANCE_NAME']) {
        if (spec.env[key] !== undefined) interesting[key] = spec.env[key]
      }
      for (const key of Object.keys(pair.instance.launch.env)) {
        interesting[key] = spec.env[key] ?? ''
      }

      return {
        command: formatCommandRedacted(spec),
        cwd: spec.cwd,
        env: interesting,
        configDir: paths.configDir,
        executable
      }
    },

    /* ---- lifecycle ---- */

    launch: async (id) => supervisor.launch(id),
    launchAll: async (ids) => supervisor.launchAll(ids),
    stop: async (id, force) => supervisor.stop(id, force),
    stopAll: async (ids, force) => supervisor.stopAll(ids, force ?? false),
    bulk: async (request) => supervisor.bulk(request),

    /* ---- runtime / telemetry ---- */

    getRuntimes: async () => supervisor.getRuntimes(),
    getHealth: async () => supervisor.getHealth(),
    getStatsHistory: async (id) => telemetry.getHistory(id),
    getAllStatsHistory: async () => telemetry.getAllHistory(),
    getSystemHistory: async () => telemetry.getSystemHistory(),

    /* ---- control surface ---- */

    getSnapshot: async (id) => supervisor.getSnapshot(id),
    refreshSnapshot: async (id) => supervisor.refreshSnapshot(id),
    setScene: async (id, sceneName) => control.setProgramScene(pool.require(id), sceneName),
    setPreviewScene: async (id, sceneName) => control.setPreviewScene(pool.require(id), sceneName),
    setStudioMode: async (id, enabled) => control.setStudioMode(pool.require(id), enabled),
    triggerTransition: async (id) => control.triggerTransition(pool.require(id)),
    setSceneItemEnabled: async (id, sceneName, sceneItemId, enabled) =>
      control.setSceneItemEnabled(pool.require(id), sceneName, sceneItemId, enabled),
    setInputMute: async (id, inputName, muted) =>
      control.setInputMute(pool.require(id), inputName, muted),
    setInputVolumeDb: async (id, inputName, volumeDb) =>
      control.setInputVolumeDb(pool.require(id), inputName, volumeDb),

    openSourceProperties: async (id, inputName) => {
      // Opens OBS's own properties dialog on the instance, which is far better
      // than reimplementing every source's settings UI here.
      await pool.require(id).call('OpenInputPropertiesDialog', { inputName })
      await windows.focus(id, supervisor.pidMap()).catch(() => undefined)
    },

    /* ---- multiview ---- */

    setMultiviewVisible: async (ids) => {
      multiview.setVisible(ids)
    },
    captureNow: async (id) => {
      supervisor.emit('preview:frames', [await multiview.captureOnce(id)])
    },

    /* ---- sync ---- */

    readAssets: async (id) => {
      const pair = resolvePair(id)
      if (!pair) {
        return {
          instanceId: id,
          profiles: [],
          sceneCollections: [],
          uiLayouts: [],
          error: 'Instance not found'
        }
      }
      return readInstanceAssets(pair.instance, pair.install)
    },

    readAllAssets: async () => {
      const results: InstanceAssets[] = []
      for (const instance of store.getInstances()) {
        const install = store.getInstall(instance.installId)
        results.push(
          install
            ? await readInstanceAssets(instance, install)
            : {
                instanceId: instance.id,
                profiles: [],
                sceneCollections: [],
                uiLayouts: [],
                error: 'OBS install missing'
              }
        )
      }
      return results
    },

    planSync: async (request) => planSync(request, resolvePair, store.getSettings().root),

    applySync: async (plan, transform) => {
      const result = await applySync(plan, resolvePair, transform)
      warnAboutRunningTargets(result.applied.map((item) => item.targetInstanceId))
      return result
    },

    /* ---- import / export ---- */

    exportBundle: async (request) => {
      const window = getWindow()
      if (!window) return null

      const suggested = `obs-fleet-${new Date().toISOString().slice(0, 10)}.zip`
      const result = await dialog.showSaveDialog(window, {
        title: 'Export fleet bundle',
        defaultPath: suggested,
        filters: [{ name: 'OBS Fleet bundle', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return null

      const { buffer } = await exportBundle(
        request,
        resolvePair,
        workspacePaths(store.getSettings().root).assets,
        BUILD_ID
      )
      await fs.writeFile(result.filePath, buffer)

      return { path: result.filePath, sizeBytes: buffer.length }
    },

    chooseBundle: async () => {
      const window = getWindow()
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        title: 'Open fleet bundle',
        properties: ['openFile'],
        filters: [{ name: 'OBS Fleet bundle', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      return inspectBundle(result.filePaths[0])
    },

    inspectBundle: async (file) => inspectBundle(file),

    planImport: async (request) =>
      planImport(request, resolvePair, store.getSettings().root),

    applyImport: async (plan, transform) => {
      const result = await applyImport(plan.plan, plan.stagingDir, transform, resolvePair)
      warnAboutRunningTargets(result.applied.map((item) => item.targetInstanceId))
      return result
    },

    importBundleAssets: async (file, overwrite) => {
      const result = await importBundleAssets(
        file,
        workspacePaths(store.getSettings().root).assets,
        { overwrite }
      )
      assets.invalidate()
      return result
    },

    /* ---- HTML assets ---- */

    listHtmlAssets: async () => assets.list(),

    listAssetMounts: async () => {
      // Warm the listings so counts and sizes are populated.
      await assets.list()
      return assets.mountStatuses()
    },

    addAssetMount: async () => {
      const window = getWindow()
      if (!window) return assets.mountStatuses()

      const result = await dialog.showOpenDialog(window, {
        title: 'Attach a folder to publish to every instance',
        properties: ['openDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return assets.mountStatuses()

      const folder = result.filePaths[0]
      const settings = store.getSettings()

      if (settings.assetMounts.some((mount) => path.resolve(mount.path) === path.resolve(folder))) {
        throw new Error('That folder is already attached')
      }

      const mount = {
        id: randomUUID().slice(0, 8),
        name: path.basename(folder) || 'Assets',
        path: folder,
        enabled: true,
        // Large media libraries are the common case here, and watching one
        // recursively costs file handles for files that rarely change.
        watch: false,
        builtIn: false
      }

      await supervisor.applySettings({ assetMounts: [...settings.assetMounts, mount] })
      await assets.list()
      return assets.mountStatuses()
    },

    updateAssetMount: async (id, patch) => {
      if (id === WORKSPACE_MOUNT_ID) {
        throw new Error('The workspace asset folder is built in and cannot be reconfigured')
      }
      const settings = store.getSettings()
      const next = settings.assetMounts.map((mount) =>
        mount.id === id ? { ...mount, ...patch, id: mount.id, builtIn: false } : mount
      )
      await supervisor.applySettings({ assetMounts: next })
      await assets.list()
      return assets.mountStatuses()
    },

    removeAssetMount: async (id) => {
      if (id === WORKSPACE_MOUNT_ID) {
        throw new Error('The workspace asset folder is built in and cannot be removed')
      }
      const settings = store.getSettings()
      await supervisor.applySettings({
        assetMounts: settings.assetMounts.filter((mount) => mount.id !== id)
      })
      return assets.mountStatuses()
    },

    importHtmlAssets: async () => {
      const window = getWindow()
      if (!window) return assets.list()

      const result = await dialog.showOpenDialog(window, {
        title: 'Add files to the shared asset library',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Web and media', extensions: ['html', 'htm', 'js', 'css', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'woff2'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (result.canceled) return assets.list()

      const root = workspacePaths(store.getSettings().root).assets
      await ensureDir(root)
      for (const file of result.filePaths) {
        await fs.copyFile(file, path.join(root, path.basename(file)))
      }

      return assets.list()
    },

    createHtmlAsset: async (name, contents) => {
      const root = workspacePaths(store.getSettings().root).assets
      await ensureDir(root)

      const safe = safeFolderName(name.replace(/\.html?$/i, ''))
      const file = path.join(root, `${safe}.html`)
      if (await pathExists(file)) throw new Error(`"${safe}.html" already exists`)

      await fs.writeFile(file, contents, 'utf8')
      return assets.list()
    },

    deleteHtmlAsset: async (relPath) => {
      const root = path.resolve(workspacePaths(store.getSettings().root).assets)
      const target = path.resolve(root, relPath)
      // Same traversal guard the server uses; a crafted relPath must not be
      // able to delete outside the asset library.
      if (!target.startsWith(root + path.sep)) throw new Error('Refusing to delete outside the asset library')

      await removeQuiet(target)
      return assets.list()
    },

    reloadHtmlAssets: async () => {
      assets.broadcastReload('manual')
    },

    assetServerUrl: async () => (assets.isRunning ? assets.baseUrl : null),

    deployBrowserSource: async (spec, targets) => supervisor.deployBrowserSource(spec, targets),

    listBrowserSources: async (id) => control.listBrowserSources(pool.require(id)),

    /* ---- window control ---- */

    listDisplays: async (): Promise<DisplayInfo[]> => {
      const primaryId = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((display, index) => ({
        id: display.id,
        label: display.label || `Display ${index + 1}`,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        primary: display.id === primaryId
      }))
    },

    windowCapability: async () => windows.capabilities(),
    listNativeWindows: async () => windows.listWindows(supervisor.pidMap()),
    tileWindows: async (request) => windows.tile(request, supervisor.pidMap()),
    focusWindow: async (id) => windows.focus(id, supervisor.pidMap()),
    minimizeWindows: async (ids) => windows.minimizeAll(ids, supervisor.pidMap()),

    /* ---- the OBS library ---- */

    obsCatalog: async (force) => {
      const unsupportedReason = downloadSupport(process.platform as never)

      // A platform that cannot install a download still gets the list: seeing
      // which version is current is useful even when the button is absent.
      try {
        const releases = await downloader.releases(force ?? false)
        return { fetchedAt: Date.now(), releases, unsupportedReason }
      } catch (err) {
        log.warn('obs', `Could not fetch the OBS release list: ${errorMessage(err)}`)
        return { fetchedAt: Date.now(), releases: [], unsupportedReason }
      }
    },

    installObsVersion: async (request) => {
      const install = await downloader.install(request.version, request.label)
      return store.addInstall(install)
    },

    obsUpdates: async () => {
      const releases = await downloader.releases().catch(() => [])
      const newest = latestRelease(releases)
      if (!newest) return []

      const candidates: ObsUpdateCandidate[] = []

      for (const install of store.getInstalls()) {
        // Only managed installs can be updated in place — the others belong to
        // whatever installed them.
        if (!install.managed) continue
        if (!isNewer(newest.version, install.version)) continue

        candidates.push({
          installId: install.id,
          installLabel: install.label,
          currentVersion: install.version,
          latestVersion: newest.version,
          usedBy: store
            .getInstances()
            .filter((instance) => instance.installId === install.id)
            .map((instance) => instance.name)
        })
      }

      return candidates
    },

    downloadJobs: async () => downloader.listJobs(),
    cancelDownload: async (jobId) => downloader.cancel(jobId),
    clearFinishedDownloads: async () => downloader.clearFinished(),

    /* ---- plugins and themes ---- */

    readAddons: async (instanceId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')
      return readAddons(pair.instance, pair.install)
    },

    installPluginArchive: async (instanceId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')

      const window = getWindow()
      if (!window) throw new Error('No window')

      const result = await dialog.showOpenDialog(window, {
        title: 'Install an OBS plugin',
        filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) return []

      warnAboutRunningTargets([instanceId])
      return installPlugin(pair.instance, pair.install, result.filePaths[0])
    },

    removePlugin: async (instanceId, pluginId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')
      warnAboutRunningTargets([instanceId])
      await removeInstancePlugin(pair.instance, pair.install, pluginId)
    },

    copyPluginsTo: async (sourceId, targetIds) => {
      const source = resolvePair(sourceId)
      if (!source) throw new Error('Instance not found')

      const targets = targetIds
        .map(resolvePair)
        .filter((pair): pair is NonNullable<typeof pair> => pair !== null)

      warnAboutRunningTargets(targetIds)
      const results = await copyPlugins(source, targets)
      return results.map((result) => ({
        instanceId: result.instanceId,
        ok: result.ok,
        changed: result.ok ? 1 : 0,
        detail: result.detail
      }))
    },

    installThemeFile: async (instanceId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')

      const window = getWindow()
      if (!window) throw new Error('No window')

      const result = await dialog.showOpenDialog(window, {
        title: 'Install an OBS theme',
        filters: [{ name: 'OBS theme', extensions: ['obt', 'ovt', 'oha'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) throw new Error('Cancelled')

      return installTheme(pair.instance, pair.install, result.filePaths[0])
    },

    removeTheme: async (instanceId, themeId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')
      await removeInstanceTheme(pair.instance, pair.install, themeId)
    },

    setTheme: async (instanceId, themeId) => {
      const pair = resolvePair(instanceId)
      if (!pair) throw new Error('Instance not found')
      warnAboutRunningTargets([instanceId])
      await setInstanceTheme(pair.instance, pair.install, themeId)
    },

    /* ---- configuration transfer ---- */

    exportConfiguration: async (includeSecrets) => {
      const window = getWindow()
      if (!window) return null

      const result = await dialog.showSaveDialog(window, {
        title: 'Export fleet configuration',
        defaultPath: `obs-fleet-config-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'OBS Fleet configuration', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return null

      const document = buildConfigExport(store.getSettings(), store.getInstances(), {
        includeSecrets,
        appVersion: BUILD_ID
      })
      await fs.writeFile(result.filePath, JSON.stringify(document, null, 2), 'utf8')

      if (includeSecrets) {
        log.warn(
          'config',
          `${result.filePath} contains websocket passwords in plain text — treat it as a credential`
        )
      }

      return { path: result.filePath }
    },

    chooseConfiguration: async () => {
      const window = getWindow()
      if (!window) return null

      const result = await dialog.showOpenDialog(window, {
        title: 'Import fleet configuration',
        filters: [{ name: 'OBS Fleet configuration', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) return null

      const document = readConfigExport(await fs.readFile(result.filePaths[0], 'utf8'))
      return { path: result.filePaths[0], document }
    },

    planConfigurationImport: async (file, options) => {
      const document = readConfigExport(await fs.readFile(file, 'utf8'))
      return planConfigImport(
        {
          settings: store.getSettings(),
          instances: store.getInstances(),
          installCount: store.getInstalls().length
        },
        document,
        options
      )
    },

    applyConfigurationImport: async (file, options) => {
      const document = readConfigExport(await fs.readFile(file, 'utf8'))
      const plan = planConfigImport(
        {
          settings: store.getSettings(),
          instances: store.getInstances(),
          installCount: store.getInstalls().length
        },
        document,
        options
      )
      if (plan.blockers.length > 0) throw new Error(plan.blockers.join(' '))

      if (options.settings) {
        await supervisor.applySettings(settingsToApply(document.settings, options))
      }

      if (options.instances) {
        const byName = new Map(store.getInstances().map((instance) => [instance.name, instance]))

        for (const entry of document.instances) {
          const existing = byName.get(entry.name)

          if (!existing) {
            // Creation provisions a folder; the definition is applied on top so
            // the imported launch options and role survive.
            const created = await instances.create({
              name: entry.name,
              count: 1,
              // Isolation is deliberately not taken from the document: the
              // right strategy is a property of this platform, not of the
              // machine the configuration came from.
              installId: store.getInstalls()[0]?.id ?? '',
              role: entry.role,
              color: entry.color,
              launch: entry.launch
            })
            const made = created.instances[0]
            if (made) {
              await instances.update(made.id, {
                notes: entry.notes,
                disabled: entry.disabled,
                autoRestart: entry.autoRestart
              })
            }
            continue
          }

          if (options.existing === 'update') {
            await instances.update(existing.id, {
              role: entry.role,
              color: entry.color,
              notes: entry.notes,
              disabled: entry.disabled,
              autoRestart: entry.autoRestart,
              launch: entry.launch
            })
          }
        }
      }

      return plan
    },

    applyInstanceDefaults: async (instanceIds) => {
      const defaults = store.getSettings().instanceDefaults
      const targets = instanceIds.length > 0 ? instanceIds : store.getInstances().map((i) => i.id)

      const outcomes: BulkUpdateOutcome[] = []
      for (const id of targets) {
        try {
          await instances.update(id, { launch: defaults })
          outcomes.push({ instanceId: id, ok: true, changed: 1, detail: 'Defaults applied' })
        } catch (err) {
          outcomes.push({ instanceId: id, ok: false, changed: 0, detail: errorMessage(err) })
        }
      }

      warnAboutRunningTargets(targets)
      return outcomes
    },

    /* ---- self-update ---- */

    checkFleetUpdate: async () => checkForFleetUpdate(process.platform as never),

    /* ---- logs ---- */

    getLogs: async (limit) => log.history(limit ?? 500),
    clearLogs: async () => log.clear(),

    openInstanceLogFolder: async (id) => {
      const pair = resolvePair(id)
      if (!pair) throw new Error('Instance not found')
      const logsDir = instancePaths(pair.instance, pair.install).logsDir
      const error = await shell.openPath(logsDir)
      if (error !== '') throw new Error(error)
    }
  }
}

/**
 * Structural check: the handler object must satisfy every FleetApi method
 * (minus `on`, which only exists in the renderer bridge).
 */
type FleetApiImplementation = {
  [K in Exclude<keyof FleetApi, 'on'>]: (
    ...args: Parameters<FleetApi[K]>
  ) => ReturnType<FleetApi[K]>
}
