import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CreateInstanceRequest,
  CreateInstanceResult,
  ObsInstall,
  ObsInstance
} from '@shared/types'
import { ensureDir, pathExists, removeQuiet, safeFolderName } from '../util/fsx.js'
import { findFreePort } from '../util/net.js'
import { log, errorMessage } from '../util/logger.js'
import { INSTANCE_COLORS, mergeLaunchOptions } from './defaults.js'
import { instancePaths, isolationDefaultFor, workspacePaths } from './paths.js'
import { provisionInstance, readInstanceMarker, verifyInstance, writeWebSocketConfig } from './provision.js'
import type { Store } from './store.js'

/**
 * Creates, clones, imports and deletes instances.
 *
 * Everything that changes the instance roster funnels through here so port
 * allocation, folder naming and provisioning stay consistent no matter which
 * part of the UI triggered it.
 */
export class InstanceManager {
  constructor(private readonly store: Store) {}

  /* ---------------- creation ---------------- */

  /**
   * Creates one or more instances. When `count > 1` the name is suffixed
   * (`Cam 1`, `Cam 2`, ...) and each gets its own port, which is the common
   * case for a multi-camera ISO setup.
   */
  async create(request: CreateInstanceRequest): Promise<CreateInstanceResult> {
    const install = this.store.getInstall(request.installId)
    if (!install) throw new Error('Select an OBS installation first')

    const count = Math.max(1, Math.min(request.count ?? 1, 32))
    const created: ObsInstance[] = []
    const warnings: string[] = []

    const workspace = workspacePaths(this.store.getSettings().root)
    await ensureDir(workspace.instances)

    for (let index = 0; index < count; index += 1) {
      const name = count === 1 ? request.name.trim() : `${request.name.trim()} ${index + 1}`
      if (name === '') throw new Error('Instance name cannot be empty')

      const instance = await this.buildInstance(name, install, request, index)

      try {
        const result = await provisionInstance(instance, install, {
          seedFromHostConfig: request.seedFromHostConfig,
          seedFromConfigDir: await this.resolveSeedDir(request.seedFromInstanceId ?? null)
        })
        warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`))
      } catch (err) {
        // Do not leave a half-built folder behind for the operator to clean up.
        await removeQuiet(instance.dir)
        throw new Error(`Could not create "${name}": ${errorMessage(err)}`)
      }

      await this.store.addInstance(instance)
      created.push(instance)
    }

    return { instances: created, warnings }
  }

  private async buildInstance(
    name: string,
    install: ObsInstall,
    request: CreateInstanceRequest,
    index: number
  ): Promise<ObsInstance> {
    const settings = this.store.getSettings()
    const workspace = workspacePaths(settings.root)

    const dir = await this.allocateFolder(workspace.instances, name)
    const port =
      request.port !== undefined
        ? request.port + index
        : await findFreePort(settings.basePort, this.store.usedPorts())

    if (this.store.usedPorts().includes(port)) {
      throw new Error(`Port ${port} is already assigned to another instance`)
    }

    const existingCount = this.store.getInstances().length
    const now = Date.now()

    return {
      id: randomUUID(),
      name,
      role: request.role ?? '',
      color: request.color ?? INSTANCE_COLORS[(existingCount + index) % INSTANCE_COLORS.length],
      dir,
      installId: install.id,
      isolation: request.isolation ?? isolationDefaultFor(),
      websocket: {
        enabled: true,
        port,
        password: settings.perInstancePasswords
          ? generatePassword()
          : settings.sharedPassword || generatePassword(),
        ipv4Only: false
      },
      launch: mergeLaunchOptions(request.launch),
      order: existingCount + index,
      disabled: false,
      autoRestart: false,
      createdAt: now,
      updatedAt: now,
      notes: ''
    }
  }

  /** Picks a folder name that is filesystem-safe and not already in use. */
  private async allocateFolder(instancesRoot: string, name: string): Promise<string> {
    const base = safeFolderName(name)
    let candidate = path.join(instancesRoot, base)

    for (let suffix = 2; await pathExists(candidate); suffix += 1) {
      candidate = path.join(instancesRoot, `${base}-${suffix}`)
      if (suffix > 200) throw new Error(`Could not find a free folder name for "${name}"`)
    }

    return candidate
  }

  private async resolveSeedDir(sourceInstanceId: string | null): Promise<string | null> {
    if (!sourceInstanceId) return null
    const source = this.store.getInstance(sourceInstanceId)
    if (!source) return null
    const install = this.store.getInstall(source.installId)
    if (!install) return null
    return instancePaths(source, install).configDir
  }

  /* ---------------- cloning ---------------- */

  /**
   * Duplicates an existing instance, including its profiles and scene
   * collections, onto a fresh port and folder.
   */
  async clone(sourceId: string, newName: string): Promise<ObsInstance> {
    const source = this.store.getInstance(sourceId)
    if (!source) throw new Error('Source instance not found')

    const result = await this.create({
      name: newName,
      role: source.role,
      installId: source.installId,
      isolation: source.isolation,
      seedFromInstanceId: sourceId,
      launch: {
        ...source.launch,
        // Auto-start flags are intentionally dropped: a clone that immediately
        // starts recording the moment it launches is never what was meant.
        startStreaming: false,
        startRecording: false,
        startReplayBuffer: false,
        startVirtualCam: false
      }
    })

    const clone = result.instances[0]
    await this.store.updateInstance(clone.id, { notes: `Cloned from "${source.name}"` })
    return clone
  }

  /* ---------------- editing ---------------- */

  /**
   * Applies an edit, re-writing anything on disk the change affects.
   *
   * A websocket port or password change has to reach the instance's
   * obs-websocket config file, otherwise it only takes effect for launches
   * that pass the CLI override and silently diverges everywhere else.
   */
  async update(id: string, patch: Partial<ObsInstance>): Promise<ObsInstance> {
    const before = this.store.getInstance(id)
    if (!before) throw new Error('Instance not found')

    if (patch.websocket?.port !== undefined && patch.websocket.port !== before.websocket.port) {
      const clash = this.store
        .getInstances()
        .find((other) => other.id !== id && other.websocket.port === patch.websocket!.port)
      if (clash) {
        throw new Error(`Port ${patch.websocket.port} is already used by "${clash.name}"`)
      }
    }

    const updated = await this.store.updateInstance(id, patch)
    const install = this.store.getInstall(updated.installId)

    if (install && patch.websocket) {
      const paths = instancePaths(updated, install)
      await writeWebSocketConfig(paths.webSocketConfig, updated).catch((err) => {
        log.warn('instances', `Could not update websocket config: ${errorMessage(err)}`, id)
      })
    }

    return updated
  }

  /** Re-runs provisioning over an existing folder to heal broken links. */
  async repair(id: string): Promise<string[]> {
    const instance = this.store.getInstance(id)
    if (!instance) throw new Error('Instance not found')
    const install = this.store.getInstall(instance.installId)
    if (!install) throw new Error('This instance references an OBS install that no longer exists')

    const result = await provisionInstance(instance, install, { repair: true })
    const remaining = await verifyInstance(instance, install)
    return [...result.warnings, ...remaining]
  }

  async verify(id: string): Promise<string[]> {
    const instance = this.store.getInstance(id)
    if (!instance) throw new Error('Instance not found')
    const install = this.store.getInstall(instance.installId)
    if (!install) return ['This instance references an OBS install that no longer exists.']
    return verifyInstance(instance, install)
  }

  /* ---------------- deletion ---------------- */

  /**
   * Removes an instance from the roster, and optionally its folder.
   *
   * Deleting files is opt-in because an instance folder holds recordings and
   * scene collections that may be the only copy of a show's setup.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const instance = this.store.getInstance(id)
    if (!instance) return

    if (deleteFiles) {
      const workspace = workspacePaths(this.store.getSettings().root)
      const resolved = path.resolve(instance.dir)
      const guard = path.resolve(workspace.instances)

      // Only ever delete inside the workspace. An imported instance pointing
      // somewhere else gets unregistered, never erased.
      if (resolved === guard || !resolved.startsWith(guard + path.sep)) {
        throw new Error(
          `Refusing to delete ${resolved} because it is outside the workspace instances folder. Remove it manually if you really meant to.`
        )
      }

      await removeQuiet(instance.dir)
      log.info('instances', `Deleted folder ${instance.dir}`, id)
    }

    await this.store.removeInstance(id)
  }

  /* ---------------- import / discovery ---------------- */

  /**
   * Scans the workspace for instance folders that are not in the roster,
   * which is how a workspace moved between machines gets re-adopted.
   */
  async discover(): Promise<ObsInstance[]> {
    const workspace = workspacePaths(this.store.getSettings().root)
    const known = new Set(this.store.getInstances().map((i) => path.resolve(i.dir)))
    const entries = await fs.readdir(workspace.instances, { withFileTypes: true }).catch(() => [])

    const adopted: ObsInstance[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(workspace.instances, entry.name)
      if (known.has(path.resolve(dir))) continue

      const marker = await readInstanceMarker(dir)
      if (!marker) continue

      const install =
        this.store.getInstalls().find((candidate) => candidate.root === marker.installRoot) ??
        this.store.getInstalls()[0]
      if (!install) continue

      const settings = this.store.getSettings()
      const instance: ObsInstance = {
        id: marker.instanceId,
        name: marker.name,
        role: '',
        color: INSTANCE_COLORS[this.store.getInstances().length % INSTANCE_COLORS.length],
        dir,
        installId: install.id,
        isolation: (marker.isolation as ObsInstance['isolation']) ?? isolationDefaultFor(),
        websocket: {
          enabled: true,
          port: await findFreePort(settings.basePort, this.store.usedPorts()),
          password: generatePassword(),
          ipv4Only: false
        },
        launch: mergeLaunchOptions(null),
        order: this.store.getInstances().length,
        disabled: false,
        autoRestart: false,
        createdAt: marker.createdAt,
        updatedAt: Date.now(),
        notes: 'Imported from workspace folder'
      }

      // The imported folder carries a websocket password we do not know, so
      // ours is written back over it.
      await writeWebSocketConfig(instancePaths(instance, install).webSocketConfig, instance)
      await this.store.addInstance(instance)
      adopted.push(instance)
      log.info('instances', `Adopted existing instance folder ${dir}`, instance.id)
    }

    return adopted
  }

  /** Reassigns every instance to consecutive free ports from the base. */
  async renumberPorts(): Promise<void> {
    const settings = this.store.getSettings()
    const ordered = this.store.getLaunchOrder(this.store.getInstances().map((i) => i.id))
    const assigned: number[] = []

    for (const instance of ordered) {
      const port = await findFreePort(settings.basePort, assigned)
      assigned.push(port)
      if (port === instance.websocket.port) continue
      await this.update(instance.id, { websocket: { ...instance.websocket, port } })
    }
  }
}

/**
 * URL-safe random password. obs-websocket takes an arbitrary string; base64url
 * keeps it copy-pasteable into third-party control surfaces.
 */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString('base64url')
}
