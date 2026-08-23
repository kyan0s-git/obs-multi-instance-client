import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type {
  BundleContents,
  BundleSource,
  ObsInstall,
  ObsInstance,
  SyncPlan,
  SyncResult,
  SyncTransform
} from '@shared/types'
import { ensureDir, pathExists, removeQuiet } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'
import { createZip, isSafeBundlePath, readZip, type ZipEntry } from '../util/zip.js'
import { instancePaths } from './paths.js'
import { applySync, planSync, readInstanceAssets, UI_LAYOUT_SLUG } from './sync.js'
import { readUiLayout, writeUiLayout, type UiLayout } from './ui-layout.js'

export const BUNDLE_FORMAT = 'obs-fleet-bundle'
export const BUNDLE_VERSION = 1

/** Largest bundle we will read into memory. Configuration is kilobytes. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

interface BundleManifest {
  format: typeof BUNDLE_FORMAT
  version: number
  createdAt: number
  createdBy: string
  platform: string
  sources: BundleSource[]
  /** Present when the workspace asset library was included. */
  assets: { fileCount: number; totalBytes: number } | null
}

export interface ExportRequest {
  /** Instances to take configuration from. */
  sourceInstanceIds: string[]
  /** Asset slugs to include, per instance id. Empty means "all". */
  profiles: Record<string, string[]>
  sceneCollections: Record<string, string[]>
  includeUiLayout: boolean
  /** Bundle the workspace asset library so overlays travel with the config. */
  includeAssets: boolean
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Packs instance configuration into a single portable archive.
 *
 * The layout mirrors an OBS config tree per source instance, so an operator
 * can open the bundle in any zip tool and see recognisable `basic.ini` and
 * scene collection files rather than an opaque blob.
 */
export async function exportBundle(
  request: ExportRequest,
  resolve: (id: string) => { instance: ObsInstance; install: ObsInstall } | null,
  workspaceAssetsDir: string,
  appVersion: string
): Promise<{ buffer: Buffer; manifest: BundleManifest }> {
  const entries: ZipEntry[] = []
  const sources: BundleSource[] = []

  for (const instanceId of request.sourceInstanceIds) {
    const resolved = resolve(instanceId)
    if (!resolved) continue

    const { instance, install } = resolved
    const paths = instancePaths(instance, install)
    const assets = await readInstanceAssets(instance, install)
    const prefix = `sources/${safeBundleSegment(instance.name)}`

    const wantedProfiles = request.profiles[instanceId] ?? []
    const wantedCollections = request.sceneCollections[instanceId] ?? []

    const source: BundleSource = {
      instanceName: instance.name,
      role: instance.role,
      color: instance.color,
      profiles: [],
      sceneCollections: [],
      uiLayout: null
    }

    for (const asset of assets.profiles) {
      if (wantedProfiles.length > 0 && !wantedProfiles.includes(asset.slug)) continue
      const added = await addDirectory(entries, asset.path, `${prefix}/profiles/${asset.slug}`)
      source.profiles.push({ slug: asset.slug, name: asset.name, fileCount: added })
    }

    for (const asset of assets.sceneCollections) {
      if (wantedCollections.length > 0 && !wantedCollections.includes(asset.slug)) continue
      entries.push({
        path: `${prefix}/scenes/${asset.slug}.json`,
        data: await fs.readFile(asset.path),
        mtime: new Date(asset.modifiedAt)
      })
      source.sceneCollections.push({ slug: asset.slug, name: asset.name })
    }

    if (request.includeUiLayout) {
      const layout = await readUiLayout(paths.userIni)
      if (layout) {
        entries.push({
          path: `${prefix}/ui-layout.json`,
          data: Buffer.from(JSON.stringify(layout, null, 2))
        })
        source.uiLayout = { description: assets.uiLayouts[0]?.name ?? 'window layout' }
      }
    }

    sources.push(source)
  }

  let assetSummary: BundleManifest['assets'] = null
  if (request.includeAssets && (await pathExists(workspaceAssetsDir))) {
    const before = entries.length
    const fileCount = await addDirectory(entries, workspaceAssetsDir, 'assets')
    const totalBytes = entries
      .slice(before)
      .reduce((total, entry) => total + entry.data.length, 0)
    assetSummary = { fileCount, totalBytes }
  }

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: Date.now(),
    createdBy: `OBS Fleet ${appVersion}`,
    platform: process.platform,
    sources,
    assets: assetSummary
  }

  // The manifest goes first so a reader can stream it out cheaply.
  entries.unshift({ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) })

  const buffer = await createZip(entries)
  log.info(
    'bundle',
    `Exported ${sources.length} instance(s), ${entries.length} file(s), ${Math.round(buffer.length / 1024)} KB`
  )

  return { buffer, manifest }
}

/** Recursively adds a directory to the entry list, returning the file count. */
async function addDirectory(
  entries: ZipEntry[],
  root: string,
  prefix: string
): Promise<number> {
  let count = 0

  const walk = async (dir: string, rel: string): Promise<void> => {
    let dirEntries: Dirent[]
    try {
      dirEntries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of dirEntries) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`

      if (entry.isDirectory()) {
        await walk(abs, childRel)
        continue
      }
      if (!entry.isFile()) continue

      const stat = await fs.stat(abs).catch(() => null)
      if (!stat) continue

      entries.push({
        path: `${prefix}/${childRel}`,
        data: await fs.readFile(abs),
        mtime: stat.mtime
      })
      count += 1
    }
  }

  await walk(root, '')
  return count
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/** Reads a bundle's manifest without extracting anything. */
export async function inspectBundle(file: string): Promise<BundleContents> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle is too large to open (${Math.round(stat.size / 1024 / 1024)} MB)`)
  }

  const archive = await readZip(await fs.readFile(file))
  const manifestEntry = archive.find((entry) => entry.path === 'manifest.json')
  if (!manifestEntry) {
    throw new Error('Not an OBS Fleet bundle: no manifest.json inside')
  }

  let manifest: BundleManifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as BundleManifest
  } catch (err) {
    throw new Error(`Bundle manifest is unreadable: ${errorMessage(err)}`)
  }

  if (manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`Not an OBS Fleet bundle (format: ${String(manifest.format)})`)
  }
  if (manifest.version > BUNDLE_VERSION) {
    throw new Error(
      `This bundle was made by a newer version of OBS Fleet (bundle format ${manifest.version}, this build understands ${BUNDLE_VERSION})`
    )
  }

  return {
    path: file,
    sizeBytes: stat.size,
    createdAt: manifest.createdAt,
    createdBy: manifest.createdBy,
    platform: manifest.platform,
    sources: manifest.sources,
    assets: manifest.assets,
    fileCount: archive.length
  }
}

/**
 * Extracts one source out of a bundle into a temporary folder shaped like an
 * instance's config tree.
 *
 * Doing it this way means import reuses the whole sync pipeline — the same
 * plan, the same per-instance rewrites, the same backups — instead of
 * reimplementing copying and path retargeting a second time.
 */
export async function stageBundleSource(
  file: string,
  sourceName: string
): Promise<{ stagingDir: string; instance: ObsInstance; layout: UiLayout | null }> {
  const archive = await readZip(await fs.readFile(file))
  const prefix = `sources/${safeBundleSegment(sourceName)}/`

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-import-'))
  // A synthetic instance whose paths resolve inside the staging folder, so
  // `instancePaths` produces the config layout sync already understands.
  const staged = stagedInstance(stagingDir)
  const paths = instancePaths(staged, STAGING_INSTALL)

  await ensureDir(paths.profilesDir)
  await ensureDir(paths.scenesDir)

  let layout: UiLayout | null = null

  for (const entry of archive) {
    if (!entry.path.startsWith(prefix)) continue
    const rel = entry.path.slice(prefix.length)

    // The bundle is untrusted input; refuse anything that would escape.
    if (!isSafeBundlePath(rel)) {
      log.warn('bundle', `Skipping unsafe path in bundle: ${entry.path}`)
      continue
    }

    if (rel === 'ui-layout.json') {
      try {
        layout = JSON.parse(entry.data.toString('utf8')) as UiLayout
      } catch {
        log.warn('bundle', 'Bundle contains an unreadable ui-layout.json; skipping it')
      }
      continue
    }

    let destination: string | null = null
    if (rel.startsWith('profiles/')) {
      destination = path.join(paths.profilesDir, ...rel.slice('profiles/'.length).split('/'))
    } else if (rel.startsWith('scenes/')) {
      destination = path.join(paths.scenesDir, ...rel.slice('scenes/'.length).split('/'))
    }
    if (!destination) continue

    // Second guard, on the resolved path this time.
    const resolved = path.resolve(destination)
    if (!resolved.startsWith(path.resolve(stagingDir) + path.sep)) continue

    await ensureDir(path.dirname(resolved))
    await fs.writeFile(resolved, entry.data)
  }

  if (layout) await writeUiLayout(paths.userIni, layout, { includeGeometry: true })

  return { stagingDir, instance: staged, layout }
}

export interface ImportRequest {
  file: string
  /** Which source inside the bundle to import from. */
  sourceName: string
  targetInstanceIds: string[]
  profiles: string[]
  sceneCollections: string[]
  uiLayout: boolean
  transform: SyncTransform
  skipIdentical: boolean
}

/**
 * Plans an import. The staging folder is returned so the caller can apply the
 * plan against it and clean up afterwards.
 */
export async function planImport(
  request: ImportRequest,
  resolveTarget: (id: string) => { instance: ObsInstance; install: ObsInstall } | null,
  workspaceRoot: string
): Promise<{ plan: SyncPlan; stagingDir: string }> {
  const staged = await stageBundleSource(request.file, request.sourceName)

  const resolve = (id: string): { instance: ObsInstance; install: ObsInstall } | null =>
    id === staged.instance.id
      ? { instance: staged.instance, install: STAGING_INSTALL }
      : resolveTarget(id)

  try {
    const plan = await planSync(
      {
        sourceInstanceId: staged.instance.id,
        targetInstanceIds: request.targetInstanceIds,
        profiles: request.profiles,
        sceneCollections: request.sceneCollections,
        uiLayout: request.uiLayout,
        transform: request.transform,
        skipIdentical: request.skipIdentical
      },
      resolve,
      workspaceRoot
    )
    return { plan, stagingDir: staged.stagingDir }
  } catch (err) {
    await removeQuiet(staged.stagingDir)
    throw err
  }
}

/** Applies a previously planned import, then removes the staging folder. */
export async function applyImport(
  plan: SyncPlan,
  stagingDir: string,
  transform: SyncTransform,
  resolveTarget: (id: string) => { instance: ObsInstance; install: ObsInstall } | null
): Promise<SyncResult> {
  const staged = stagedInstance(stagingDir)

  const resolve = (id: string): { instance: ObsInstance; install: ObsInstall } | null =>
    id === staged.id ? { instance: staged, install: STAGING_INSTALL } : resolveTarget(id)

  try {
    return await applySync(plan, resolve, transform)
  } finally {
    await removeQuiet(stagingDir)
  }
}

/** Restores a bundled asset library into the workspace assets folder. */
export async function importBundleAssets(
  file: string,
  workspaceAssetsDir: string,
  options: { overwrite: boolean }
): Promise<{ written: number; skipped: number }> {
  const archive = await readZip(await fs.readFile(file))
  const root = path.resolve(workspaceAssetsDir)
  let written = 0
  let skipped = 0

  for (const entry of archive) {
    if (!entry.path.startsWith('assets/')) continue
    const rel = entry.path.slice('assets/'.length)
    if (rel === '' || !isSafeBundlePath(rel)) {
      skipped += 1
      continue
    }

    const destination = path.resolve(root, ...rel.split('/'))
    if (!destination.startsWith(root + path.sep)) {
      skipped += 1
      continue
    }

    if (!options.overwrite && (await pathExists(destination))) {
      skipped += 1
      continue
    }

    await ensureDir(path.dirname(destination))
    await fs.writeFile(destination, entry.data)
    written += 1
  }

  return { written, skipped }
}

/* ------------------------------------------------------------------ */
/* Staging helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * A fake install used only to drive `instancePaths` for the staging folder.
 * Nothing is ever launched from it.
 */
const STAGING_INSTALL: ObsInstall = {
  id: '__bundle__',
  label: 'Bundle staging',
  root: '',
  executable: '',
  version: null,
  detected: false,
  problems: []
}

/** Stable synthetic instance for a staging directory. */
function stagedInstance(stagingDir: string): ObsInstance {
  return {
    id: `__bundle__:${stagingDir}`,
    name: 'Bundle',
    role: '',
    color: '#4f9dff',
    dir: stagingDir,
    installId: STAGING_INSTALL.id,
    // Gives `<stagingDir>/config/obs-studio/...`, independent of host platform.
    isolation: 'xdg-config-home',
    websocket: { enabled: false, port: 0, password: '', ipv4Only: false },
    launch: {
      profile: null,
      sceneCollection: null,
      startScene: null,
      startStreaming: false,
      startRecording: false,
      startReplayBuffer: false,
      startVirtualCam: false,
      studioMode: false,
      minimizeToTray: false,
      alwaysOnTop: false,
      safeMode: false,
      onlyBundledPlugins: false,
      disableUpdater: true,
      disableMissingFilesCheck: true,
      verboseLog: false,
      extraArgs: [],
      env: {}
    },
    order: 0,
    disabled: true,
    autoRestart: false,
    createdAt: 0,
    updatedAt: 0,
    notes: ''
  }
}

/** Keeps instance names usable as archive path segments. */
export function safeBundleSegment(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|\0]+/g, '-').replace(/^\.+/, '').trim()
  return cleaned === '' ? 'instance' : cleaned
}

export { UI_LAYOUT_SLUG }
