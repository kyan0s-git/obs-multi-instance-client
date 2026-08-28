import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  BulkUpdatableField,
  BulkUpdateChange,
  BulkUpdateOutcome,
  BulkUpdatePreview,
  BulkUpdatePreviewItem,
  BulkUpdateRequest,
  BulkUpdateValues,
  CreateInstanceRequest,
  CreateInstanceResult,
  InstanceLaunchOptions,
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

  /* ---------------- bulk update ---------------- */

  /**
   * Works out what a bulk update would change, without writing anything.
   *
   * Shown for confirmation because applying a wrong flag to twelve instances
   * at once is the kind of mistake that is discovered mid-show, and because
   * "nothing here actually differs" is a useful answer in its own right.
   */
  preview(request: BulkUpdateRequest): BulkUpdatePreview {
    const items: BulkUpdatePreviewItem[] = []
    const warnings: string[] = []

    // Repointing at a different OBS install invalidates a portable instance's
    // junctions, so provisioning has to be re-run whether or not it was asked
    // for.
    const installChanged = request.fields.includes('installId')
    const reprovision = request.reprovision || installChanged

    if (installChanged && !request.reprovision) {
      warnings.push(
        'Changing the OBS installation re-runs provisioning, because portable instances link into the install they were built against.'
      )
    }

    for (const instanceId of request.instanceIds) {
      const instance = this.store.getInstance(instanceId)
      if (!instance) continue

      const changes = describeChanges(instance, request.fields, request.values, this.store)
      const itemWarnings: string[] = []

      if (request.fields.includes('installId')) {
        const target = this.store.getInstall(request.values.installId ?? '')
        if (!target) itemWarnings.push('The selected OBS installation no longer exists.')
        else if (target.problems.length > 0) {
          itemWarnings.push(`Target installation reports: ${target.problems.join('; ')}`)
        }
      }

      if (request.fields.includes('safeMode') && request.values.safeMode === true) {
        itemWarnings.push(
          'Safe Mode disables the websocket server, so OBS Fleet will not be able to control this instance.'
        )
      }

      items.push({
        instanceId,
        instanceName: instance.name,
        changes,
        warnings: itemWarnings,
        willReprovision: reprovision && changes.length > 0
      })
    }

    return { items, warnings }
  }

  /**
   * Applies a bulk update.
   *
   * A failure on one instance never stops the others: a partial result the
   * operator can see beats an all-or-nothing rollback they cannot reason about
   * with a show about to start.
   */
  async applyBulkUpdate(request: BulkUpdateRequest): Promise<BulkUpdateOutcome[]> {
    const preview = this.preview(request)
    const outcomes: BulkUpdateOutcome[] = []

    for (const item of preview.items) {
      if (item.changes.length === 0) {
        outcomes.push({
          instanceId: item.instanceId,
          ok: true,
          changed: 0,
          detail: 'Already matches'
        })
        continue
      }

      try {
        const instance = this.store.getInstance(item.instanceId)
        if (!instance) throw new Error('Instance no longer exists')

        await this.update(item.instanceId, buildPatch(instance, request.fields, request.values))

        if (item.willReprovision) {
          const remaining = await this.repair(item.instanceId)
          if (remaining.length > 0) {
            outcomes.push({
              instanceId: item.instanceId,
              ok: false,
              changed: item.changes.length,
              detail: `Updated, but provisioning reported: ${remaining.join('; ')}`
            })
            continue
          }
        }

        outcomes.push({
          instanceId: item.instanceId,
          ok: true,
          changed: item.changes.length,
          detail: item.willReprovision
            ? `${item.changes.length} change(s), re-provisioned`
            : `${item.changes.length} change(s)`
        })
      } catch (err) {
        outcomes.push({
          instanceId: item.instanceId,
          ok: false,
          changed: 0,
          detail: errorMessage(err)
        })
      }
    }

    const changed = outcomes.filter((outcome) => outcome.ok && outcome.changed > 0).length
    log.info('instances', `Bulk update touched ${changed} of ${outcomes.length} instance(s)`)

    return outcomes
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

/** Human labels for the bulk-update fields, used in the confirmation table. */
const FIELD_LABELS: Record<BulkUpdatableField, string> = {
  installId: 'OBS installation',
  role: 'Role',
  color: 'Accent colour',
  notes: 'Notes',
  disabled: 'Skip in bulk operations',
  autoRestart: 'Restart on crash',
  websocketEnabled: 'Remote control',
  websocketIpv4Only: 'Bind IPv4 only',
  profile: 'Profile',
  sceneCollection: 'Scene collection',
  startScene: 'Start scene',
  startRecording: 'Start recording on launch',
  startStreaming: 'Start streaming on launch',
  startReplayBuffer: 'Start replay buffer on launch',
  startVirtualCam: 'Start virtual camera on launch',
  studioMode: 'Studio mode',
  minimizeToTray: 'Minimise to tray',
  alwaysOnTop: 'Always on top',
  safeMode: 'Safe mode',
  onlyBundledPlugins: 'Only bundled plugins',
  disableUpdater: 'Disable updater',
  disableMissingFilesCheck: 'Disable missing files check',
  verboseLog: 'Verbose logging',
  extraArgs: 'Extra arguments'
}

/** Launch fields map straight onto `InstanceLaunchOptions` keys. */
const LAUNCH_FIELDS = new Set<BulkUpdatableField>([
  'profile',
  'sceneCollection',
  'startScene',
  'startRecording',
  'startStreaming',
  'startReplayBuffer',
  'startVirtualCam',
  'studioMode',
  'minimizeToTray',
  'alwaysOnTop',
  'safeMode',
  'onlyBundledPlugins',
  'disableUpdater',
  'disableMissingFilesCheck',
  'verboseLog',
  'extraArgs'
])

/** Reads the value a field currently holds on an instance. */
function currentValue(instance: ObsInstance, field: BulkUpdatableField): unknown {
  switch (field) {
    case 'installId':
      return instance.installId
    case 'role':
      return instance.role
    case 'color':
      return instance.color
    case 'notes':
      return instance.notes
    case 'disabled':
      return instance.disabled
    case 'autoRestart':
      return instance.autoRestart
    case 'websocketEnabled':
      return instance.websocket.enabled
    case 'websocketIpv4Only':
      return instance.websocket.ipv4Only
    default:
      return instance.launch[field as keyof InstanceLaunchOptions]
  }
}

/**
 * Lists the fields that would actually change.
 *
 * Comparing before writing is what lets the UI say "8 of 12 already match",
 * and keeps an unchanged instance from having its `updatedAt` bumped for
 * nothing.
 */
function describeChanges(
  instance: ObsInstance,
  fields: BulkUpdatableField[],
  values: BulkUpdateValues,
  store: Store
): BulkUpdateChange[] {
  const changes: BulkUpdateChange[] = []

  for (const field of fields) {
    const next = values[field]
    if (next === undefined) continue

    const before = currentValue(instance, field)
    if (sameValue(before, next)) continue

    changes.push({
      field,
      label: FIELD_LABELS[field],
      from: formatValue(field, before, store),
      to: formatValue(field, next, store)
    })
  }

  return changes
}

/** Builds the patch `Store.updateInstance` expects from the flat field set. */
function buildPatch(
  instance: ObsInstance,
  fields: BulkUpdatableField[],
  values: BulkUpdateValues
): Partial<ObsInstance> {
  const patch: Partial<ObsInstance> = {}
  const launch: Partial<InstanceLaunchOptions> = {}
  const websocket = { ...instance.websocket }
  let touchedWebsocket = false

  for (const field of fields) {
    const next = values[field]
    if (next === undefined) continue

    if (LAUNCH_FIELDS.has(field)) {
      Object.assign(launch, { [field]: next })
      continue
    }

    switch (field) {
      case 'installId':
        patch.installId = String(next)
        break
      case 'role':
        patch.role = String(next)
        break
      case 'color':
        patch.color = String(next)
        break
      case 'notes':
        patch.notes = String(next)
        break
      case 'disabled':
        patch.disabled = Boolean(next)
        break
      case 'autoRestart':
        patch.autoRestart = Boolean(next)
        break
      case 'websocketEnabled':
        websocket.enabled = Boolean(next)
        touchedWebsocket = true
        break
      case 'websocketIpv4Only':
        websocket.ipv4Only = Boolean(next)
        touchedWebsocket = true
        break
    }
  }

  if (Object.keys(launch).length > 0) patch.launch = launch as InstanceLaunchOptions
  if (touchedWebsocket) patch.websocket = websocket

  return patch
}

function sameValue(before: unknown, next: unknown): boolean {
  if (Array.isArray(before) && Array.isArray(next)) {
    return before.length === next.length && before.every((entry, i) => entry === next[i])
  }
  return before === next
}

/** Renders a value for the confirmation table. */
function formatValue(field: BulkUpdatableField, value: unknown, store: Store): string {
  if (field === 'installId') {
    return store.getInstall(String(value))?.label ?? String(value)
  }
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(' ')
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value === null || value === '') return '(unset)'
  return String(value)
}

/**
 * URL-safe random password. obs-websocket takes an arbitrary string; base64url
 * keeps it copy-pasteable into third-party control surfaces.
 */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString('base64url')
}
