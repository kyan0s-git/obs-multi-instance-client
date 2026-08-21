import { EventEmitter } from 'node:events'
import path from 'node:path'
import { app } from 'electron'
import type { ObsInstall, ObsInstance, WorkspaceSettings, WorkspaceState } from '@shared/types'
import { readJson, writeJsonAtomic } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { mergeLaunchOptions, mergeSettings } from './defaults.js'

interface PersistedState {
  version: number
  settings: Partial<WorkspaceSettings>
  installs: ObsInstall[]
  instances: ObsInstance[]
}

const STATE_VERSION = 1

/**
 * Single source of truth for everything the user configured: workspace
 * settings, registered OBS installs and the instance roster.
 *
 * Writes are debounced-by-await (each mutation persists immediately but
 * atomically) and every mutation emits `changed`, which the IPC layer
 * forwards to the renderer.
 */
export class Store extends EventEmitter {
  private settings: WorkspaceSettings
  private installs: ObsInstall[] = []
  private instances: ObsInstance[] = []
  private readonly file: string
  private saveChain: Promise<void> = Promise.resolve()

  constructor(file?: string) {
    super()
    this.file = file ?? path.join(app.getPath('userData'), 'workspace.json')
    this.settings = mergeSettings(null)
  }

  async load(): Promise<void> {
    const raw = await readJson<PersistedState>(this.file)
    if (!raw) {
      log.info('store', `No saved workspace at ${this.file}; starting from defaults`)
      await this.persist()
      return
    }

    this.settings = mergeSettings(raw.settings)
    this.installs = Array.isArray(raw.installs) ? raw.installs : []
    // Normalise instances so a config written by an older build still loads.
    this.instances = (Array.isArray(raw.instances) ? raw.instances : []).map((instance) => ({
      ...instance,
      launch: mergeLaunchOptions(instance.launch),
      websocket: {
        enabled: instance.websocket?.enabled ?? true,
        port: instance.websocket?.port ?? this.settings.basePort,
        password: instance.websocket?.password ?? '',
        ipv4Only: instance.websocket?.ipv4Only ?? false
      },
      order: typeof instance.order === 'number' ? instance.order : 0,
      disabled: Boolean(instance.disabled),
      autoRestart: Boolean(instance.autoRestart),
      notes: instance.notes ?? '',
      role: instance.role ?? ''
    }))

    log.info(
      'store',
      `Loaded workspace: ${this.instances.length} instance(s), ${this.installs.length} install(s)`
    )
  }

  getState(): WorkspaceState {
    return {
      settings: { ...this.settings, multiview: { ...this.settings.multiview }, thresholds: { ...this.settings.thresholds } },
      installs: this.installs.map((i) => ({ ...i })),
      instances: this.instances.map((i) => structuredClone(i))
    }
  }

  /* ---------------- settings ---------------- */

  getSettings(): WorkspaceSettings {
    return this.settings
  }

  async updateSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    this.settings = mergeSettings({ ...this.settings, ...patch })
    await this.persist()
    return this.settings
  }

  /* ---------------- installs ---------------- */

  getInstalls(): ObsInstall[] {
    return this.installs
  }

  getInstall(id: string): ObsInstall | undefined {
    return this.installs.find((i) => i.id === id)
  }

  /**
   * Merges a freshly detected set of installs with the registry, keeping any
   * hand-added entries and refreshing metadata on ones we detected before.
   */
  async mergeDetectedInstalls(detected: ObsInstall[]): Promise<void> {
    const byRoot = new Map(this.installs.map((i) => [normalizeKey(i.root), i]))
    for (const found of detected) {
      const existing = byRoot.get(normalizeKey(found.root))
      if (existing) {
        existing.executable = found.executable
        existing.version = found.version ?? existing.version
        existing.problems = found.problems
        if (existing.detected) existing.label = found.label
      } else {
        this.installs.push(found)
        byRoot.set(normalizeKey(found.root), found)
      }
    }
    await this.persist()
  }

  async addInstall(install: ObsInstall): Promise<ObsInstall> {
    const clash = this.installs.find((i) => normalizeKey(i.root) === normalizeKey(install.root))
    if (clash) {
      Object.assign(clash, install, { id: clash.id })
      await this.persist()
      return clash
    }
    this.installs.push(install)
    await this.persist()
    return install
  }

  async removeInstall(id: string): Promise<void> {
    const inUse = this.instances.filter((i) => i.installId === id)
    if (inUse.length > 0) {
      throw new Error(
        `${inUse.length} instance(s) still use this install: ${inUse.map((i) => i.name).join(', ')}`
      )
    }
    this.installs = this.installs.filter((i) => i.id !== id)
    await this.persist()
  }

  /* ---------------- instances ---------------- */

  getInstances(): ObsInstance[] {
    return this.instances
  }

  getInstance(id: string): ObsInstance | undefined {
    return this.instances.find((i) => i.id === id)
  }

  /** Instances in bulk-launch order, with disabled ones dropped. */
  getLaunchOrder(ids?: string[]): ObsInstance[] {
    const pool = ids
      ? (ids.map((id) => this.getInstance(id)).filter(Boolean) as ObsInstance[])
      : this.instances.filter((i) => !i.disabled)
    return [...pool].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  async addInstance(instance: ObsInstance): Promise<ObsInstance> {
    this.instances.push(instance)
    await this.persist()
    return instance
  }

  async updateInstance(id: string, patch: Partial<ObsInstance>): Promise<ObsInstance> {
    const instance = this.getInstance(id)
    if (!instance) throw new Error(`Unknown instance: ${id}`)

    Object.assign(instance, patch, {
      id: instance.id,
      // `dir` is structural; it only changes through an explicit move.
      dir: patch.dir ?? instance.dir,
      launch: patch.launch ? mergeLaunchOptions({ ...instance.launch, ...patch.launch }) : instance.launch,
      websocket: patch.websocket ? { ...instance.websocket, ...patch.websocket } : instance.websocket,
      updatedAt: Date.now()
    })

    await this.persist()
    return instance
  }

  async removeInstance(id: string): Promise<void> {
    this.instances = this.instances.filter((i) => i.id !== id)
    await this.persist()
  }

  async reorderInstances(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const instance = this.getInstance(id)
      if (instance) instance.order = index
    })
    await this.persist()
  }

  /** Every websocket port currently claimed, so allocation never collides. */
  usedPorts(): number[] {
    return this.instances.map((i) => i.websocket.port)
  }

  /* ---------------- persistence ---------------- */

  /**
   * Serialises writes through a promise chain so two concurrent mutations
   * cannot interleave their `writeFile`+`rename` pairs.
   */
  private persist(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      const payload: PersistedState = {
        version: STATE_VERSION,
        settings: this.settings,
        installs: this.installs,
        instances: this.instances
      }
      try {
        await writeJsonAtomic(this.file, payload)
      } catch (err) {
        log.error('store', `Failed to save workspace: ${errorMessage(err)}`)
      }
      this.emit('changed', this.getState())
    })
    return this.saveChain
  }
}

/** Case-insensitive on Windows/macOS, exact on Linux. */
function normalizeKey(target: string): string {
  const normalized = path.normalize(target).replace(/[\\/]+$/, '')
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}
