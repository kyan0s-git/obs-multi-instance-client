import fs from 'node:fs/promises'
import path from 'node:path'
import type { ObsInstall, ObsInstance, Platform } from '@shared/types'
import {
  copyTree,
  ensureDir,
  pathExists,
  readJson,
  removeQuiet,
  writeJsonAtomic,
  writeTextAtomic
} from '../util/fsx.js'
import { iniMerge, parseIni, serializeIni } from '../util/ini.js'
import { log, errorMessage } from '../util/logger.js'
import { layoutFor } from './obs-install.js'
import { hostObsConfigDir, instancePaths, isolationOwnsInstall } from './paths.js'

const platform = process.platform as Platform

/** Marker written into every instance folder so the workspace can be re-scanned. */
interface InstanceMarker {
  managedBy: 'obs-fleet'
  version: number
  instanceId: string
  name: string
  createdAt: number
  isolation: string
  installRoot: string
}

export interface ProvisionOptions {
  /** Copy the host user's own OBS config in as the starting point. */
  seedFromHostConfig?: boolean
  /** Copy profiles + scene collections from another instance folder. */
  seedFromConfigDir?: string | null
  /** Re-run provisioning over an existing folder instead of failing. */
  repair?: boolean
}

export interface ProvisionResult {
  warnings: string[]
  /** Bytes actually written (0 for a pure link farm). */
  bytesWritten: number
}

/**
 * Creates (or repairs) everything an instance needs on disk: the isolated OBS
 * install view, the config tree, a default profile and scene collection, and
 * the obs-websocket server config.
 *
 * Safe to re-run: existing config is preserved unless it is missing or broken.
 */
export async function provisionInstance(
  instance: ObsInstance,
  install: ObsInstall,
  options: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const paths = instancePaths(instance, install)
  const warnings: string[] = []
  let bytesWritten = 0

  if (!options.repair && (await pathExists(paths.marker))) {
    throw new Error(`An instance already exists at ${paths.root}`)
  }

  await ensureDir(paths.root)
  await ensureDir(paths.recordingsDir)
  await ensureDir(paths.assetsDir)

  if (isolationOwnsInstall(instance.isolation)) {
    const result = await materializeInstall(instance, install, warnings)
    bytesWritten += result.bytes
  }

  // Directory set libobs creates on first run. Making them up front means the
  // very first launch has nothing to migrate or repair.
  for (const dir of [
    paths.configDir,
    paths.profilesDir,
    paths.scenesDir,
    paths.pluginConfigDir,
    paths.logsDir,
    path.join(paths.configDir, 'profiler_data'),
    path.join(paths.configDir, 'updates'),
    path.join(paths.configDir, 'plugin_manager')
  ]) {
    await ensureDir(dir)
  }
  if (platform === 'win32') await ensureDir(path.join(paths.configDir, 'crashes'))

  // Seeding runs before the ini files are written, so a seeded profile can be
  // selected as the active one below.
  if (options.seedFromHostConfig) {
    const hostDir = hostObsConfigDir(process.env.HOME ?? process.env.USERPROFILE ?? '')
    if (await pathExists(hostDir)) {
      const copied = await seedConfigFrom(hostDir, paths.configDir)
      bytesWritten += copied
      log.info('provision', `Seeded from host OBS config at ${hostDir}`, instance.id)
    } else {
      warnings.push(`No host OBS config found at ${hostDir}; created an empty instance instead.`)
    }
  } else if (options.seedFromConfigDir) {
    if (await pathExists(options.seedFromConfigDir)) {
      bytesWritten += await seedConfigFrom(options.seedFromConfigDir, paths.configDir)
    } else {
      warnings.push(`Seed source ${options.seedFromConfigDir} not found; created an empty instance.`)
    }
  }

  const profileName = await ensureDefaultProfile(instance, paths.profilesDir)
  const collectionName = await ensureDefaultSceneCollection(paths.scenesDir)

  await writeGlobalIni(paths.globalIni, instance)
  await writeUserIni(paths.userIni, profileName, collectionName)
  await writeWebSocketConfig(paths.webSocketConfig, instance)

  const marker: InstanceMarker = {
    managedBy: 'obs-fleet',
    version: 1,
    instanceId: instance.id,
    name: instance.name,
    createdAt: instance.createdAt,
    isolation: instance.isolation,
    installRoot: install.root
  }
  await writeJsonAtomic(paths.marker, marker)

  log.info('provision', `Provisioned "${instance.name}" at ${paths.root}`, instance.id)
  return { warnings, bytesWritten }
}

/* ------------------------------------------------------------------ */
/* Install materialisation (Windows)                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds the per-instance view of the OBS install.
 *
 * `portable-linkfarm` creates NTFS junctions to `bin`, `data` and
 * `obs-plugins` in the base install: no meaningful disk cost, and OBS still
 * resolves its own path through the junction so portable config lands inside
 * the instance. Junctions (unlike symlinks) need no elevation.
 *
 * `portable-copy` duplicates the install outright, which costs a few hundred
 * megabytes per instance but survives the base install being upgraded or
 * removed underneath the fleet.
 */
async function materializeInstall(
  instance: ObsInstance,
  install: ObsInstall,
  warnings: string[]
): Promise<{ bytes: number }> {
  const layout = layoutFor()
  const paths = instancePaths(instance, install)
  await ensureDir(paths.obsRoot)

  let bytes = 0

  for (const rel of layout.linkableDirs) {
    const source = path.join(install.root, rel)
    const target = path.join(paths.obsRoot, rel)
    if (!(await pathExists(source))) {
      warnings.push(`Base install is missing ${rel}; the instance may not start.`)
      continue
    }

    await ensureDir(path.dirname(target))

    if (instance.isolation === 'portable-copy') {
      const copied = await copyTree(source, target, { dereference: true })
      bytes += copied.bytes
      continue
    }

    const existing = await fs.lstat(target).catch(() => null)
    if (existing) {
      // Repair path: replace whatever is there so a moved base install heals.
      if (existing.isSymbolicLink()) {
        const current = await fs.readlink(target).catch(() => null)
        if (current && path.resolve(current) === path.resolve(source)) continue
      }
      await removeQuiet(target)
    }

    try {
      // 'junction' is a no-op hint off Windows, where plain symlinks work
      // for unprivileged users anyway.
      await fs.symlink(source, target, 'junction')
    } catch (err) {
      warnings.push(
        `Could not link ${rel} (${errorMessage(err)}); falling back to a full copy.`
      )
      const copied = await copyTree(source, target, { dereference: true })
      bytes += copied.bytes
    }
  }

  for (const rel of layout.copyFiles) {
    const source = path.join(install.root, rel)
    if (!(await pathExists(source))) continue
    const target = path.join(paths.obsRoot, rel)
    await ensureDir(path.dirname(target))
    await fs.copyFile(source, target)
    bytes += (await fs.stat(source)).size
  }

  return { bytes }
}

/* ------------------------------------------------------------------ */
/* Config scaffolding                                                  */
/* ------------------------------------------------------------------ */

/** Copies profiles and scene collections out of another OBS config tree. */
async function seedConfigFrom(sourceConfigDir: string, targetConfigDir: string): Promise<number> {
  let bytes = 0
  for (const rel of [path.join('basic', 'profiles'), path.join('basic', 'scenes')]) {
    const source = path.join(sourceConfigDir, rel)
    if (!(await pathExists(source))) continue
    const copied = await copyTree(source, path.join(targetConfigDir, rel), { dereference: true })
    bytes += copied.bytes
  }
  return bytes
}

/**
 * Guarantees the instance has at least one profile, and points the recording
 * output at the instance's own `recordings/` folder so parallel instances
 * never write over each other.
 */
async function ensureDefaultProfile(instance: ObsInstance, profilesDir: string): Promise<string> {
  const existing = await fs.readdir(profilesDir).catch(() => [] as string[])
  if (existing.length > 0) {
    // Respect whatever the seed provided.
    const preferred = instance.launch.profile
    if (preferred && existing.includes(preferred)) return preferred
    return existing[0]
  }

  const name = 'Fleet Default'
  const dir = path.join(profilesDir, name)
  await ensureDir(dir)

  const recordingsDir = path.join(instance.dir, 'recordings')
  const basic = parseIni('')
  iniMerge(basic, {
    General: { Name: name },
    Output: { Mode: 'Simple' },
    SimpleOutput: {
      FilePath: recordingsDir,
      RecFormat2: 'mkv',
      // Distinguish files from different instances at a glance.
      FilenameFormatting: `${instance.name}-%CCYY-%MM-%DD %hh-%mm-%ss`
    },
    AdvOut: {
      RecFilePath: recordingsDir,
      RecFormat2: 'mkv'
    },
    Video: {
      BaseCX: '1920',
      BaseCY: '1080',
      OutputCX: '1920',
      OutputCY: '1080',
      FPSType: '0',
      FPSCommon: '60'
    }
  })

  await writeTextAtomic(path.join(dir, 'basic.ini'), serializeIni(basic))
  // OBS creates these lazily, but an empty file keeps first launch quiet.
  await writeTextAtomic(path.join(dir, 'service.json'), '{}\n')
  return name
}

/** Guarantees at least one scene collection so OBS does not open empty. */
async function ensureDefaultSceneCollection(scenesDir: string): Promise<string> {
  const existing = (await fs.readdir(scenesDir).catch(() => [] as string[])).filter((f) =>
    f.endsWith('.json')
  )
  if (existing.length > 0) return path.basename(existing[0], '.json')

  const name = 'Fleet Default'
  const collection = {
    name,
    current_scene: 'Scene',
    current_program_scene: 'Scene',
    scene_order: [{ name: 'Scene' }],
    sources: [
      {
        id: 'scene',
        versioned_id: 'scene',
        name: 'Scene',
        uuid: crypto.randomUUID(),
        settings: { custom_size: false, id_counter: 0, items: [] },
        mixers: 0,
        sync: 0,
        flags: 0,
        volume: 1.0,
        balance: 0.5,
        enabled: true,
        muted: false,
        'prev_ver': 0,
        push_to_mute: false,
        push_to_mute_delay: 0,
        push_to_talk: false,
        push_to_talk_delay: 0,
        hotkeys: {},
        deinterlace_mode: 0,
        deinterlace_field_order: 0,
        monitoring_type: 0,
        private_settings: {}
      }
    ],
    groups: [],
    quick_transitions: [],
    transitions: [],
    current_transition: 'Fade',
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0.0,
    scaling_off_y: 0.0,
    modules: {}
  }

  await writeJsonAtomic(path.join(scenesDir, `${name}.json`), collection)
  return name
}

/**
 * App-level config. Auto-updates are forced off because a fleet member that
 * silently updates itself desynchronises from the rest mid-show.
 */
async function writeGlobalIni(file: string, instance: ObsInstance): Promise<void> {
  const doc = parseIni(await fs.readFile(file, 'utf8').catch(() => ''))
  iniMerge(doc, {
    General: {
      EnableAutoUpdates: 'false',
      // Non-zero suppresses the "what's new" overlay on first launch.
      LastVersion: '520093696'
    }
  })
  if (instance.launch.disableUpdater) {
    iniMerge(doc, { General: { UpdateBranch: 'stable' } })
  }
  await writeTextAtomic(file, serializeIni(doc))
}

/**
 * User-level config. Setting `FirstRun` and an explicit profile/collection is
 * what stops OBS opening the auto-configuration wizard, which would otherwise
 * block every unattended bulk launch behind a modal.
 */
async function writeUserIni(
  file: string,
  profileName: string,
  collectionName: string
): Promise<void> {
  const doc = parseIni(await fs.readFile(file, 'utf8').catch(() => ''))
  iniMerge(doc, {
    General: { FirstRun: 'true', ConfirmOnExit: 'false' },
    Basic: {
      Profile: profileName,
      ProfileDir: profileName,
      SceneCollection: collectionName,
      SceneCollectionFile: collectionName,
      ConfigOnNewProfile: 'false'
    },
    BasicWindow: {
      // Closing a fleet member should not prompt; the client owns lifecycle.
      WarnBeforeStartingStream: 'false',
      WarnBeforeStoppingStream: 'false',
      WarnBeforeStoppingRecord: 'false'
    }
  })
  await writeTextAtomic(file, serializeIni(doc))
}

/**
 * obs-websocket reads this on load. The CLI flags can override port and
 * password, but they cannot *enable* a disabled server, so the file has to
 * exist with `server_enabled` set before the first launch.
 */
export async function writeWebSocketConfig(file: string, instance: ObsInstance): Promise<void> {
  const existing = (await readJson<Record<string, unknown>>(file)) ?? {}
  await writeJsonAtomic(file, {
    ...existing,
    // Setting this false stops obs-websocket regenerating a random password
    // over the one we just assigned.
    first_load: false,
    server_enabled: instance.websocket.enabled,
    server_port: instance.websocket.port,
    alerts_enabled: false,
    auth_required: instance.websocket.password !== '',
    server_password: instance.websocket.password
  })
}

/**
 * Re-reads an instance folder to confirm it is still intact. Used by the
 * "verify" action and before every launch.
 */
export async function verifyInstance(
  instance: ObsInstance,
  install: ObsInstall
): Promise<string[]> {
  const paths = instancePaths(instance, install)
  const problems: string[] = []

  if (!(await pathExists(paths.root))) {
    problems.push(`Instance folder is missing: ${paths.root}`)
    return problems
  }
  if (!(await pathExists(paths.configDir))) {
    problems.push(`Config directory is missing: ${paths.configDir}`)
  }
  if (!(await pathExists(paths.userIni))) {
    problems.push('user.ini is missing; OBS would open the setup wizard on launch.')
  }
  if (!(await pathExists(paths.webSocketConfig))) {
    problems.push('obs-websocket config is missing; remote control would be unavailable.')
  }

  if (isolationOwnsInstall(instance.isolation)) {
    for (const rel of layoutFor().linkableDirs) {
      const target = path.join(paths.obsRoot, rel)
      if (!(await pathExists(target))) {
        problems.push(`Linked install directory is broken or missing: ${rel}`)
      }
    }
  }

  const marker = await readJson<InstanceMarker>(paths.marker)
  if (!marker) problems.push('instance.json marker is missing or unreadable.')
  else if (marker.instanceId !== instance.id) {
    problems.push('instance.json belongs to a different instance; the folder may be shared.')
  }

  return problems
}

/** Reads the marker of a folder, used when importing instances found on disk. */
export async function readInstanceMarker(dir: string): Promise<InstanceMarker | null> {
  const marker = await readJson<InstanceMarker>(path.join(dir, 'instance.json'))
  return marker && marker.managedBy === 'obs-fleet' ? marker : null
}
