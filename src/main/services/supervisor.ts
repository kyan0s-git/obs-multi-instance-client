import { EventEmitter } from 'node:events'
import type {
  BulkOutcome,
  BulkRequest,
  DeployReport,
  BrowserSourceDeployTarget,
  BrowserSourceSpec,
  InstanceHealth,
  InstanceRuntime,
  InstanceSnapshot,
  ObsInstance,
  WorkspaceSettings
} from '@shared/types'
import { debounce, mapLimit, sleep } from '../util/async.js'
import { waitForPort } from '../util/net.js'
import { findListenerPid, pidAlive, stopPid } from '../util/process.js'
import { ensureDir } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { AssetServer } from './asset-server.js'
import { evaluateHealth } from './health.js'
import { InstanceManager } from './instance-manager.js'
import { Launcher, type LauncherExit } from './launcher.js'
import { Multiview } from './multiview.js'
import * as control from './obs-control.js'
import type { ConnectionStatus } from './obs-connection.js'
import { ObsPool, type ObsEventEnvelope } from './obs-pool.js'
import { workspacePaths } from './paths.js'
import { Store } from './store.js'
import { Telemetry } from './telemetry.js'
import { WindowControl } from './window-control.js'

/** How long an instance may take to answer on the websocket after launch. */
const CONNECT_GRACE_MS = 45_000

/** Restarts inside this window count towards the crash-loop cutoff. */
const CRASH_LOOP_WINDOW_MS = 120_000
const CRASH_LOOP_LIMIT = 3

interface RestartTracker {
  attempts: number[]
}

/**
 * The application core.
 *
 * Owns every service, keeps the authoritative runtime view of the fleet, and
 * is the only thing the IPC layer talks to. Emits the same event names the
 * renderer subscribes to, so adding a channel means adding one emit here.
 */
export class Supervisor extends EventEmitter {
  readonly store = new Store()
  readonly launcher = new Launcher()
  readonly pool = new ObsPool()
  // Lazily reads the pid map so adopted instances are sampled too.
  readonly telemetry = new Telemetry(this.pool, () =>
    [...this.pidMap()].map(([pid, instanceId]) => ({ pid, instanceId }))
  )
  readonly multiview = new Multiview(this.pool)
  readonly assets = new AssetServer()
  readonly windows = new WindowControl()
  readonly instances = new InstanceManager(this.store)

  private runtime = new Map<string, InstanceRuntime>()
  private snapshots = new Map<string, InstanceSnapshot>()
  private targetFps = new Map<string, number>()
  private restarts = new Map<string, RestartTracker>()
  /** Pids of instances started before this session, adopted on startup. */
  private adoptedPids = new Map<string, number>()
  private healthTimer: NodeJS.Timeout | null = null
  private started = false

  private broadcastRuntime = debounce(() => {
    this.emit('runtime:changed', this.getRuntimes())
  }, 80)

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.store.load()
    await this.ensureWorkspace()

    this.wireStore()
    this.wireLauncher()
    this.wirePool()
    this.wireTelemetry()
    this.wireMultiview()
    this.wireAssets()

    for (const instance of this.store.getInstances()) {
      this.runtime.set(instance.id, blankRuntime(instance.id))
    }

    const settings = this.store.getSettings()
    this.telemetry.configure({
      intervalMs: settings.statsIntervalMs,
      historyLength: settings.statsHistoryLength
    })
    this.telemetry.start()
    this.multiview.configure(settings.multiview)
    this.launcher.setLogRateLimit(settings.logRateLimitPerSecond)

    await this.startAssetServer(settings)

    this.healthTimer = setInterval(() => this.publishHealth(), 2000)
    log.info('supervisor', 'Fleet supervisor started')

    // Closing the client leaves instances running on purpose, so a restart
    // has to find them again rather than presenting a fleet that looks down.
    void this.adoptRunningInstances()
  }

  async shutdown(options: { stopInstances: boolean }): Promise<void> {
    this.started = false
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null

    this.telemetry.stop()
    this.multiview.stop()
    await this.assets.stop()
    await this.pool.closeAll()

    if (options.stopInstances) {
      log.info('supervisor', 'Closing all running instances')
      await this.launcher.quitAll({ timeoutMs: 20_000 })
    }
  }

  private async ensureWorkspace(): Promise<void> {
    const workspace = workspacePaths(this.store.getSettings().root)
    for (const dir of Object.values(workspace)) await ensureDir(dir)
  }

  private async startAssetServer(settings: WorkspaceSettings): Promise<void> {
    if (!settings.assetServerEnabled) return
    const workspace = workspacePaths(settings.root)
    this.assets.setInstancesProvider(() => this.store.getInstances())

    try {
      await this.assets.start(workspace.assets, settings.assetServerPort, settings.assetMounts)
      this.emit('assets:changed', await this.assets.list())
    } catch (err) {
      log.error(
        'assets',
        `Could not start the asset server on port ${settings.assetServerPort}: ${errorMessage(err)}`
      )
    }
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  private wireStore(): void {
    this.store.on('changed', () => {
      // Keep a runtime record for every instance, and drop records for ones
      // that were deleted. Live references are enough here; only the payload
      // that crosses IPC needs a defensive copy.
      const instances = this.store.getInstances()
      const ids = new Set(instances.map((instance) => instance.id))
      for (const instance of instances) {
        if (!this.runtime.has(instance.id)) this.runtime.set(instance.id, blankRuntime(instance.id))
      }
      for (const id of [...this.runtime.keys()]) {
        if (!ids.has(id)) {
          this.runtime.delete(id)
          this.snapshots.delete(id)
          this.telemetry.forget(id)
          this.multiview.forget(id)
          void this.pool.close(id)
        }
      }

      this.emit('workspace:changed', this.store.getState())
      this.broadcastRuntime()
    })
  }

  private wireLauncher(): void {
    this.launcher.on('state', ({ instanceId, state }) => {
      this.patchRuntime(instanceId, {
        state,
        pid: this.launcher.getPid(instanceId),
        startedAt: this.launcher.getStartedAt(instanceId)
      })
    })

    this.launcher.on('exit', (exit: LauncherExit) => void this.handleExit(exit))

    this.launcher.on('error', ({ instanceId, error }) => {
      this.patchRuntime(instanceId, { lastError: error })
    })
  }

  private wirePool(): void {
    this.pool.on('status', (status: ConnectionStatus) => {
      this.patchRuntime(status.instanceId, {
        wsConnected: status.connected,
        wsError: status.error,
        obsVersion: status.obsVersion,
        state: this.stateFor(status.instanceId, status.connected)
      })
    })

    this.pool.on('connected', (status: ConnectionStatus) => {
      void this.refreshSnapshot(status.instanceId)
      void this.readTargetFps(status.instanceId)
    })

    this.pool.on('obsEvent', (envelope: ObsEventEnvelope) => this.handleObsEvent(envelope))
  }

  private wireTelemetry(): void {
    this.telemetry.on('instance', (samples) => this.emit('stats:instance', samples))
    this.telemetry.on('system', (sample) => this.emit('stats:system', sample))
  }

  private wireMultiview(): void {
    this.multiview.on('frames', (frames) => this.emit('preview:frames', frames))
  }

  private wireAssets(): void {
    this.assets.on('changed', () => {
      void this.assets.list().then((list) => this.emit('assets:changed', list))
    })
  }

  /* ------------------------------------------------------------------ */
  /* Runtime state                                                       */
  /* ------------------------------------------------------------------ */

  getRuntimes(): InstanceRuntime[] {
    return [...this.runtime.values()].map((entry) => ({ ...entry }))
  }

  getRuntime(instanceId: string): InstanceRuntime {
    return this.runtime.get(instanceId) ?? blankRuntime(instanceId)
  }

  getSnapshot(instanceId: string): InstanceSnapshot | null {
    return this.snapshots.get(instanceId) ?? null
  }

  /**
   * Reconciles the run state with what we actually know.
   *
   * A dropped websocket must not leave an instance reading as `connected`,
   * but it also does not mean the process died: OBS being busy or restarting
   * its websocket server is a live process with no control channel.
   */
  private stateFor(instanceId: string, connected: boolean): InstanceRuntime['state'] {
    if (connected) return 'connected'
    if (this.launcher.isRunning(instanceId)) return 'running'

    const current = this.runtime.get(instanceId)?.state ?? 'stopped'
    // An adopted instance has no child process of ours to check, so a lost
    // connection is all we have to go on.
    return current === 'connected' ? 'stopped' : current
  }

  private patchRuntime(instanceId: string, patch: Partial<InstanceRuntime>): void {
    const current = this.runtime.get(instanceId) ?? blankRuntime(instanceId)
    this.runtime.set(instanceId, { ...current, ...patch })
    this.broadcastRuntime()
  }

  /* ------------------------------------------------------------------ */
  /* Launching                                                           */
  /* ------------------------------------------------------------------ */

  async launch(instanceId: string): Promise<void> {
    const instance = this.requireInstance(instanceId)
    const install = this.store.getInstall(instance.installId)
    if (!install) throw new Error(`"${instance.name}" references an OBS install that no longer exists`)

    this.patchRuntime(instanceId, { lastError: null, exit: null })
    await this.launcher.launch(instance, install)

    if (instance.websocket.enabled) {
      await this.pool.open(instance)
      void this.awaitConnection(instance)
    }
  }

  /**
   * Starts every enabled instance in order, pausing between launches.
   *
   * The stagger is not cosmetic: OBS instances all initialising their GPU
   * encoder at the same moment routinely fail with "failed to start encoder",
   * and a serialised start avoids it entirely.
   */
  async launchAll(instanceIds?: string[]): Promise<BulkOutcome[]> {
    const targets = this.store.getLaunchOrder(instanceIds)
    const stagger = this.store.getSettings().bulkLaunchStaggerMs
    const outcomes: BulkOutcome[] = []

    for (let index = 0; index < targets.length; index += 1) {
      const instance = targets[index]

      if (this.launcher.isRunning(instance.id)) {
        outcomes.push({ instanceId: instance.id, ok: true, detail: 'Already running' })
        continue
      }

      try {
        await this.launch(instance.id)
        outcomes.push({ instanceId: instance.id, ok: true, detail: 'Launched' })
      } catch (err) {
        const detail = errorMessage(err)
        outcomes.push({ instanceId: instance.id, ok: false, detail })
        this.patchRuntime(instance.id, { lastError: detail })
      }

      if (index < targets.length - 1) await sleep(stagger)
    }

    return outcomes
  }

  async stop(instanceId: string, force = false): Promise<void> {
    // Disable auto-restart for this stop so a deliberate shutdown is not
    // fought by the watchdog.
    this.restarts.delete(instanceId)

    if (this.launcher.isRunning(instanceId)) {
      await this.launcher.quit(instanceId, { force })
    } else {
      await this.stopAdopted(instanceId, force)
    }

    await this.pool.close(instanceId)
    this.patchRuntime(instanceId, {
      state: 'stopped',
      pid: null,
      wsConnected: false,
      startedAt: null
    })
    this.telemetry.forget(instanceId)
  }

  /**
   * Stops an instance this session did not launch.
   *
   * There is no child process to signal, so the pid resolved when the
   * instance was adopted is used instead. If it cannot be resolved, say so
   * plainly rather than reporting a stop that did not happen.
   */
  private async stopAdopted(instanceId: string, force: boolean): Promise<void> {
    const instance = this.store.getInstance(instanceId)
    const pid =
      this.adoptedPids.get(instanceId) ??
      (instance ? await findListenerPid(instance.websocket.port) : null)

    if (pid === null) {
      if (!this.pool.isConnected(instanceId)) return
      throw new Error(
        'This instance was started outside OBS Fleet and its process could not be identified. Close it from its own window.'
      )
    }

    this.adoptedPids.delete(instanceId)
    await stopPid(pid, { force })

    // taskkill and SIGTERM are requests; give OBS a moment to act on one.
    const deadline = Date.now() + (force ? 3000 : 15_000)
    while (pidAlive(pid) && Date.now() < deadline) await sleep(250)

    if (!force && pidAlive(pid)) {
      log.warn('supervisor', 'Adopted instance did not close in time; terminating', instanceId)
      await stopPid(pid, { force: true })
    }
  }

  async stopAll(instanceIds?: string[], force = false): Promise<BulkOutcome[]> {
    const targets = instanceIds ?? this.launcher.runningIds()
    return mapLimit(targets, 4, async (id) => {
      try {
        await this.stop(id, force)
        return { instanceId: id, ok: true, detail: force ? 'Terminated' : 'Closed' }
      } catch (err) {
        return { instanceId: id, ok: false, detail: errorMessage(err) }
      }
    })
  }

  /** Watches for the first successful connection and reports if it never comes. */
  private async awaitConnection(instance: ObsInstance): Promise<void> {
    const deadline = Date.now() + CONNECT_GRACE_MS

    while (Date.now() < deadline) {
      if (!this.launcher.isRunning(instance.id)) return
      if (this.pool.isConnected(instance.id)) return
      await sleep(1000)
    }

    if (this.launcher.isRunning(instance.id) && !this.pool.isConnected(instance.id)) {
      const detail =
        'OBS is running but never accepted a control connection. Check that the websocket server is enabled and the port is free.'
      log.warn('supervisor', detail, instance.id)
      this.patchRuntime(instance.id, { lastError: detail })
    }
  }

  /**
   * Finds instances that are already running from an earlier session of the
   * client and takes control of them again.
   *
   * Detection is simply "does something answer on this instance's websocket
   * port": the process is not ours, so there is no pid to check. Adopted
   * instances report OBS's own CPU and memory figures but not OS-level
   * per-process ones, and stopping one closes it over the socket rather than
   * by signal.
   */
  private async adoptRunningInstances(): Promise<void> {
    const candidates = this.store
      .getInstances()
      .filter((instance) => instance.websocket.enabled && !this.launcher.isRunning(instance.id))

    const adopted = await mapLimit(candidates, 6, async (instance) => {
      // A short probe keeps startup quick; anything not listening yet is
      // simply not running.
      const listening = await waitForPort(instance.websocket.port, '127.0.0.1', 600, 200)
      if (!listening) return null

      // Resolve the pid now so the instance can be stopped and resource-sampled
      // like one we launched ourselves.
      const pid = await findListenerPid(instance.websocket.port)
      if (pid !== null) this.adoptedPids.set(instance.id, pid)

      await this.pool.open(instance)
      return instance
    })

    const found = adopted.filter((instance): instance is ObsInstance => instance !== null)
    if (found.length === 0) return

    for (const instance of found) {
      this.patchRuntime(instance.id, {
        state: 'running',
        pid: this.adoptedPids.get(instance.id) ?? null
      })
    }
    log.info(
      'supervisor',
      `Reconnected to ${found.length} instance(s) already running: ${found.map((i) => i.name).join(', ')}`
    )
  }

  /**
   * Decides what an unexpected exit means: a restartable blip, or a crash
   * loop that needs a human.
   */
  private async handleExit(exit: LauncherExit): Promise<void> {
    const instance = this.store.getInstance(exit.instanceId)
    await this.pool.close(exit.instanceId)

    this.patchRuntime(exit.instanceId, {
      pid: null,
      startedAt: null,
      wsConnected: false,
      streaming: false,
      recording: false,
      recordingPaused: false,
      replayBufferActive: false,
      virtualCamActive: false,
      exit: { code: exit.code, signal: exit.signal, at: exit.at }
    })

    if (!exit.unexpected || !instance?.autoRestart) return

    const tracker = this.restarts.get(exit.instanceId) ?? { attempts: [] }
    const cutoff = Date.now() - CRASH_LOOP_WINDOW_MS
    tracker.attempts = tracker.attempts.filter((at) => at > cutoff)

    if (tracker.attempts.length >= CRASH_LOOP_LIMIT) {
      const detail = `"${instance.name}" crashed ${tracker.attempts.length} times in two minutes; auto-restart paused.`
      log.error('supervisor', detail, exit.instanceId)
      this.patchRuntime(exit.instanceId, { lastError: detail })
      this.restarts.set(exit.instanceId, tracker)
      return
    }

    tracker.attempts.push(Date.now())
    this.restarts.set(exit.instanceId, tracker)

    log.warn('supervisor', `Restarting "${instance.name}" after an unexpected exit`, exit.instanceId)
    await sleep(3000)

    try {
      await this.launch(exit.instanceId)
    } catch (err) {
      this.patchRuntime(exit.instanceId, { lastError: errorMessage(err) })
    }
  }

  /* ------------------------------------------------------------------ */
  /* OBS events and snapshots                                            */
  /* ------------------------------------------------------------------ */

  private handleObsEvent(envelope: ObsEventEnvelope): void {
    const { instanceId, eventType } = envelope
    const data = (envelope.data ?? {}) as Record<string, unknown>

    switch (eventType) {
      case 'CurrentProgramSceneChanged': {
        const sceneName = String(data.sceneName ?? '')
        this.patchRuntime(instanceId, { currentProgramScene: sceneName })
        this.syncMultiviewScenes(instanceId, sceneName, undefined)
        void this.refreshSnapshot(instanceId)
        return
      }
      case 'CurrentPreviewSceneChanged': {
        const sceneName = String(data.sceneName ?? '')
        this.patchRuntime(instanceId, { currentPreviewScene: sceneName })
        this.syncMultiviewScenes(instanceId, undefined, sceneName)
        return
      }
      case 'StudioModeStateChanged':
        this.patchRuntime(instanceId, { studioModeEnabled: data.studioModeEnabled === true })
        void this.refreshSnapshot(instanceId)
        return
      case 'StreamStateChanged':
        this.patchRuntime(instanceId, { streaming: data.outputActive === true })
        return
      case 'RecordStateChanged':
        this.patchRuntime(instanceId, {
          recording: data.outputActive === true,
          recordingPaused: String(data.outputState ?? '') === 'OBS_WEBSOCKET_OUTPUT_PAUSED'
        })
        return
      case 'ReplayBufferStateChanged':
        this.patchRuntime(instanceId, { replayBufferActive: data.outputActive === true })
        return
      case 'VirtualcamStateChanged':
        this.patchRuntime(instanceId, { virtualCamActive: data.outputActive === true })
        return
      case 'CurrentProfileChanged':
        this.patchRuntime(instanceId, { profile: String(data.profileName ?? '') })
        void this.readTargetFps(instanceId)
        void this.refreshSnapshot(instanceId)
        return
      case 'CurrentSceneCollectionChanged':
        this.patchRuntime(instanceId, { sceneCollection: String(data.sceneCollectionName ?? '') })
        void this.refreshSnapshot(instanceId)
        return
      case 'ExitStarted':
        this.patchRuntime(instanceId, { state: 'stopping' })
        return
      default:
        // Structural changes need a fresh snapshot; value changes are already
        // reflected in runtime above.
        if (STRUCTURAL_EVENTS.has(eventType)) void this.refreshSnapshot(instanceId)
    }
  }

  private syncMultiviewScenes(
    instanceId: string,
    program?: string,
    preview?: string
  ): void {
    const runtime = this.getRuntime(instanceId)
    this.multiview.setScenes(
      instanceId,
      program ?? runtime.currentProgramScene,
      preview ?? runtime.currentPreviewScene
    )
  }

  /** Re-reads scenes, sources and mixer state for the control surface. */
  async refreshSnapshot(instanceId: string): Promise<InstanceSnapshot | null> {
    const connection = this.pool.get(instanceId)
    if (!connection?.isConnected) return null

    try {
      const snapshot = await control.readSnapshot(connection)
      this.snapshots.set(instanceId, snapshot)

      this.patchRuntime(instanceId, {
        currentProgramScene: snapshot.currentProgramScene,
        currentPreviewScene: snapshot.currentPreviewScene,
        studioModeEnabled: snapshot.studioMode,
        profile: snapshot.currentProfile,
        sceneCollection: snapshot.currentSceneCollection
      })
      this.multiview.setScenes(
        instanceId,
        snapshot.currentProgramScene,
        snapshot.currentPreviewScene
      )

      this.emit('snapshot:changed', snapshot)
      return snapshot
    } catch (err) {
      log.debug('supervisor', `Snapshot refresh failed: ${errorMessage(err)}`, instanceId)
      return null
    }
  }

  /** Reads the instance's configured output FPS, used by the health checks. */
  private async readTargetFps(instanceId: string): Promise<void> {
    const connection = this.pool.get(instanceId)
    if (!connection?.isConnected) return

    try {
      const video = await connection.call('GetVideoSettings')
      const denominator = Number(video.fpsDenominator ?? 1)
      const numerator = Number(video.fpsNumerator ?? 0)
      if (denominator > 0 && numerator > 0) {
        this.targetFps.set(instanceId, numerator / denominator)
      }
    } catch {
      // Older obs-websocket builds may not expose this; health simply skips
      // the FPS check rather than guessing a target.
    }
  }

  /* ------------------------------------------------------------------ */
  /* Health                                                              */
  /* ------------------------------------------------------------------ */

  getHealth(): InstanceHealth[] {
    const settings = this.store.getSettings()
    const system = this.telemetry.getLatestSystem()

    return this.store.getInstances().map((instance) => {
      const history = this.telemetry.getHistory(instance.id)
      // A ten-sample window is roughly the last ten seconds at the default
      // rate: long enough to smooth a hiccup, short enough to react.
      const window = history.slice(-10)

      return evaluateHealth({
        instanceId: instance.id,
        runtime: this.getRuntime(instance.id),
        latest: history[history.length - 1] ?? null,
        window,
        targetFps: this.targetFps.get(instance.id) ?? null,
        system,
        thresholds: settings.thresholds
      })
    })
  }

  private publishHealth(): void {
    this.emit('health:changed', this.getHealth())
  }

  /* ------------------------------------------------------------------ */
  /* Bulk operations                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Runs one action across many instances.
   *
   * Process-level actions are serialised (see {@link launchAll}); websocket
   * actions run in parallel because simultaneity is the point — pressing
   * record on eight ISO instances should land within one frame of each other.
   */
  async bulk(request: BulkRequest): Promise<BulkOutcome[]> {
    const ids =
      request.instanceIds.length > 0
        ? request.instanceIds
        : this.store.getInstances().filter((instance) => !instance.disabled).map((i) => i.id)

    if (request.action === 'launch') return this.launchAll(ids)
    if (request.action === 'quit') return this.stopAll(ids, false)
    if (request.action === 'kill') return this.stopAll(ids, true)

    const payload = request.payload ?? {}

    return mapLimit(ids, 8, async (instanceId) => {
      try {
        const connection = this.pool.require(instanceId)

        switch (request.action) {
          case 'startRecording':
            await control.startRecording(connection)
            break
          case 'stopRecording':
            await control.stopRecording(connection)
            break
          case 'pauseRecording':
            await control.pauseRecording(connection)
            break
          case 'resumeRecording':
            await control.resumeRecording(connection)
            break
          case 'splitRecordFile':
            await control.splitRecordFile(connection)
            break
          case 'startStreaming':
            await control.startStreaming(connection)
            break
          case 'stopStreaming':
            await control.stopStreaming(connection)
            break
          case 'startReplayBuffer':
            await control.startReplayBuffer(connection)
            break
          case 'stopReplayBuffer':
            await control.stopReplayBuffer(connection)
            break
          case 'saveReplayBuffer':
            await control.saveReplayBuffer(connection)
            break
          case 'startVirtualCam':
            await control.startVirtualCam(connection)
            break
          case 'stopVirtualCam':
            await control.stopVirtualCam(connection)
            break
          case 'setScene':
            await control.setProgramScene(connection, requireString(payload.sceneName, 'sceneName'))
            break
          case 'setPreviewScene':
            await control.setPreviewScene(connection, requireString(payload.sceneName, 'sceneName'))
            break
          case 'triggerTransition':
            await control.triggerTransition(connection)
            break
          case 'setStudioMode':
            await control.setStudioMode(connection, payload.enabled === true)
            break
          case 'refreshBrowserSources': {
            const count = await control.refreshBrowserSources(connection)
            return { instanceId, ok: true, detail: `Refreshed ${count} browser source(s)` }
          }
          case 'setProfile':
            await control.setProfile(connection, requireString(payload.profileName, 'profileName'))
            break
          case 'setSceneCollection':
            await control.setSceneCollection(
              connection,
              requireString(payload.sceneCollectionName, 'sceneCollectionName')
            )
            break
          default:
            throw new Error(`Unsupported action: ${request.action}`)
        }

        return { instanceId, ok: true, detail: 'OK' }
      } catch (err) {
        return { instanceId, ok: false, detail: errorMessage(err) }
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Browser source deployment                                           */
  /* ------------------------------------------------------------------ */

  /** Pushes one browser source into many instances at once. */
  async deployBrowserSource(
    spec: BrowserSourceSpec,
    targets: BrowserSourceDeployTarget[]
  ): Promise<DeployReport[]> {
    return mapLimit(targets, 4, async (target) => {
      const instance = this.store.getInstance(target.instanceId)
      if (!instance) {
        return { instanceId: target.instanceId, ok: false, detail: 'Instance not found' }
      }

      try {
        const connection = this.pool.require(target.instanceId)
        const detail = await control.deployBrowserSource(
          connection,
          instance,
          spec,
          target.sceneName
        )
        await this.refreshSnapshot(target.instanceId)
        return { instanceId: target.instanceId, ok: true, detail }
      } catch (err) {
        return { instanceId: target.instanceId, ok: false, detail: errorMessage(err) }
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  /** Applies a settings change and restarts whatever it affects. */
  async applySettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    const before = this.store.getSettings()
    const settings = await this.store.updateSettings(patch)

    if (patch.statsIntervalMs !== undefined || patch.statsHistoryLength !== undefined) {
      this.telemetry.configure({
        intervalMs: settings.statsIntervalMs,
        historyLength: settings.statsHistoryLength
      })
    }

    if (patch.multiview) this.multiview.configure(settings.multiview)
    if (patch.logRateLimitPerSecond !== undefined) {
      this.launcher.setLogRateLimit(settings.logRateLimitPerSecond)
    }

    const assetServerChanged =
      patch.assetServerEnabled !== undefined ||
      patch.assetServerPort !== undefined ||
      (patch.root !== undefined && patch.root !== before.root)

    if (assetServerChanged) {
      await this.assets.stop()
      await this.ensureWorkspace()
      await this.startAssetServer(settings)
    } else if (patch.assetMounts !== undefined && this.assets.isRunning) {
      // Mounts can be reconciled in place, so adding a media folder does not
      // interrupt overlays that are currently on air.
      await this.assets.setMounts(workspacePaths(settings.root).assets, settings.assetMounts)
      this.emit('assets:changed', await this.assets.list())
    }

    return settings
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  requireInstance(instanceId: string): ObsInstance {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new Error('Instance not found')
    return instance
  }

  /**
   * pid -> instance id map, used by window control and process sampling.
   * Includes adopted instances so their windows can be tiled and focused too.
   */
  pidMap(): Map<number, string> {
    const map = new Map(this.launcher.pids().map(({ pid, instanceId }) => [pid, instanceId]))
    for (const [instanceId, pid] of this.adoptedPids) {
      if (!this.launcher.isRunning(instanceId) && pidAlive(pid)) map.set(pid, instanceId)
    }
    return map
  }

  /** Reconnects the websocket pool to match the current roster. */
  async syncConnections(): Promise<void> {
    await this.pool.sync(
      this.store.getInstances(),
      (instance) => instance.websocket.enabled && this.launcher.isRunning(instance.id)
    )
  }
}

/** Events that change structure rather than a single value. */
const STRUCTURAL_EVENTS = new Set([
  'SceneListChanged',
  'SceneCreated',
  'SceneRemoved',
  'SceneNameChanged',
  'SceneItemCreated',
  'SceneItemRemoved',
  'SceneItemListReindexed',
  'SceneItemEnableStateChanged',
  'SceneItemLockStateChanged',
  'InputCreated',
  'InputRemoved',
  'InputNameChanged',
  'InputMuteStateChanged',
  'InputVolumeChanged',
  'ProfileListChanged',
  'SceneCollectionListChanged',
  'CurrentSceneTransitionChanged'
])

function blankRuntime(instanceId: string): InstanceRuntime {
  return {
    id: instanceId,
    state: 'stopped',
    pid: null,
    startedAt: null,
    exit: null,
    wsConnected: false,
    wsError: null,
    obsVersion: null,
    currentProgramScene: null,
    currentPreviewScene: null,
    studioModeEnabled: false,
    streaming: false,
    recording: false,
    recordingPaused: false,
    replayBufferActive: false,
    virtualCamActive: false,
    sceneCollection: null,
    profile: null,
    lastError: null
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing required "${field}"`)
  }
  return value
}
