import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  InstanceAssets,
  ObsInstall,
  ObsInstance,
  SyncAsset,
  SyncPlan,
  SyncPlanItem,
  SyncResult,
  SyncTransform
} from '@shared/types'
import {
  copyTree,
  ensureDir,
  pathExists,
  readJson,
  writeJsonAtomic,
  writeTextAtomic
} from '../util/fsx.js'
import { hashCache } from '../util/hash-cache.js'
import { iniGet, iniSet, parseIni, serializeIni, type IniDocument } from '../util/ini.js'
import { log, errorMessage } from '../util/logger.js'
import { instancePaths, workspacePaths } from './paths.js'
import {
  describeUiLayout,
  readUiLayout,
  regenerateDockUuids,
  writeUiLayout,
  type UiLayout
} from './ui-layout.js'

export function defaultTransform(): SyncTransform {
  return {
    pathRewrites: [],
    retargetRecordingPath: true,
    stripStreamKey: true,
    tagBrowserSources: false,
    regenerateUuids: true,
    includeWindowGeometry: false
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lists an instance's profiles and scene collections with a content hash
 * each, which is what lets the sync matrix show "identical" vs "differs"
 * rather than just "present".
 */
export async function readInstanceAssets(
  instance: ObsInstance,
  install: ObsInstall
): Promise<InstanceAssets> {
  const paths = instancePaths(instance, install)

  try {
    const [profiles, sceneCollections, uiLayouts] = await Promise.all([
      readProfiles(paths.profilesDir),
      readSceneCollections(paths.scenesDir),
      readUiLayoutAsset(paths.userIni)
    ])
    return { instanceId: instance.id, profiles, sceneCollections, uiLayouts, error: null }
  } catch (err) {
    return {
      instanceId: instance.id,
      profiles: [],
      sceneCollections: [],
      uiLayouts: [],
      error: errorMessage(err)
    }
  }
}

async function readProfiles(profilesDir: string): Promise<SyncAsset[]> {
  const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  const assets: SyncAsset[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(profilesDir, entry.name)
    const basicIni = path.join(dir, 'basic.ini')

    // OBS keeps the display name inside basic.ini; the folder name is a
    // slugified version of it and the two routinely differ.
    let displayName = entry.name
    if (await pathExists(basicIni)) {
      const doc = parseIni(await fs.readFile(basicIni, 'utf8').catch(() => ''))
      displayName = iniGet(doc, 'General', 'Name') ?? entry.name
    }

    const stat = await fs.stat(dir)
    // One walk produces both the digest and the size; the cache means an
    // unchanged profile costs a stat per file rather than a full read.
    const walked = await hashCache.tree(dir, { transformFor: profileTransformFor })

    assets.push({
      kind: 'profile',
      name: displayName,
      slug: entry.name,
      path: dir,
      sizeBytes: walked.totalBytes,
      modifiedAt: stat.mtimeMs,
      hash: walked.digest
    })
  }

  return assets.sort((a, b) => a.name.localeCompare(b.name))
}

async function readSceneCollections(scenesDir: string): Promise<SyncAsset[]> {
  const entries = await fs.readdir(scenesDir, { withFileTypes: true }).catch(() => [])
  const assets: SyncAsset[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(scenesDir, entry.name)
    const slug = path.basename(entry.name, '.json')

    const collection = await readJson<{ name?: string }>(file)
    const stat = await fs.stat(file)

    assets.push({
      kind: 'sceneCollection',
      name: collection?.name ?? slug,
      slug,
      path: file,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      hash: await hashCache.file(file, COLLECTION_TRANSFORM)
    })
  }

  return assets.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ */
/* Canonical hashing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fields a sync is *expected* to make per-instance.
 *
 * Comparing raw bytes would be useless here: every copy is normalised on the
 * way in (display name set, recording output repointed, stream key cleared),
 * so two instances running the identical show would never compare equal.
 * Excluding exactly the fields sync rewrites makes "identical" mean what an
 * operator wants it to mean: the same show content, wherever it records to.
 */
const PROFILE_PER_INSTANCE_KEYS: Array<[section: string, key: string]> = [
  ['General', 'Name'],
  ['SimpleOutput', 'FilePath'],
  ['SimpleOutput', 'FilenameFormatting'],
  ['AdvOut', 'RecFilePath'],
  ['AdvOut', 'FFFilePath'],
  ['Output', 'FilenameFormatting']
]

const SECRET_SERVICE_KEYS = ['key', 'password', 'bearer_token']

/** Query parameters the client injects to identify the rendering instance. */
const INSTANCE_QUERY_PARAMS = ['instance', 'instanceId', 'role', 'color']

/**
 * Chooses how each file inside a profile is digested.
 *
 * `undefined` means "hash the raw bytes", which is right for everything that
 * has no per-instance content.
 */
function profileTransformFor(
  relPath: string
): { key: string; apply: (raw: Buffer) => string | Buffer } | undefined {
  if (relPath === 'basic.ini') return BASIC_INI_TRANSFORM
  if (relPath === 'service.json') return SERVICE_JSON_TRANSFORM
  return undefined
}

const BASIC_INI_TRANSFORM = {
  key: 'basic.ini',
  apply(raw: Buffer): string {
    const doc = parseIni(raw.toString('utf8'))
    for (const [section, key] of PROFILE_PER_INSTANCE_KEYS) doc.get(section)?.delete(key)
    // Re-serialising also normalises key order and whitespace, so a profile
    // that only differs in formatting still compares equal.
    return serializeIni(doc)
  }
}

const SERVICE_JSON_TRANSFORM = {
  key: 'service.json',
  apply(raw: Buffer): string {
    let service: Record<string, unknown>
    try {
      service = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      // Unparseable: fall back to the raw text rather than claiming a match.
      return raw.toString('utf8')
    }
    const settings = service.settings as Record<string, unknown> | undefined
    if (settings) for (const key of SECRET_SERVICE_KEYS) delete settings[key]
    return stableStringify(service)
  }
}

/** Digest of a scene collection with per-instance identity removed. */
const COLLECTION_TRANSFORM = {
  key: 'scene-collection',
  apply(raw: Buffer): string {
    let collection: Record<string, unknown>
    try {
      collection = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      return raw.toString('utf8')
    }

    // The display name is always retargeted on copy.
    delete collection.name

    const sources = collection.sources
    if (Array.isArray(sources)) {
      for (const entry of sources) {
        const source = entry as Record<string, unknown>
        // UUIDs are regenerated per copy by design.
        delete source.uuid

        const settings = source.settings as Record<string, unknown> | undefined
        if (settings && typeof settings.url === 'string') {
          settings.url = stripInstanceParams(settings.url)
        }
      }
    }

    return stableStringify(collection)
  }
}

/**
 * The saved window arrangement, exposed as a single synthetic asset so it
 * appears in the same matrix and plan flow as profiles and collections.
 */
async function readUiLayoutAsset(userIni: string): Promise<SyncAsset[]> {
  const layout = await readUiLayout(userIni)
  if (!layout) return []

  const stat = await fs.stat(userIni).catch(() => null)
  const canonical = stableStringify(layout.values)

  return [
    {
      kind: 'uiLayout',
      name: describeUiLayout(layout),
      // There is only ever one layout per instance, so the slug is fixed.
      slug: UI_LAYOUT_SLUG,
      path: userIni,
      sizeBytes: Buffer.byteLength(canonical),
      modifiedAt: stat?.mtimeMs ?? 0,
      hash: createHash('sha1').update(canonical).digest('hex')
    }
  ]
}

/** There is exactly one UI layout per instance. */
export const UI_LAYOUT_SLUG = 'window-layout'

/** Removes the instance-identifying query parameters from a browser URL. */
function stripInstanceParams(url: string): string {
  try {
    const parsed = new URL(url)
    for (const param of INSTANCE_QUERY_PARAMS) parsed.searchParams.delete(param)
    return parsed.toString()
  } catch {
    return url
  }
}

/** JSON with object keys sorted, so key order cannot affect the digest. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'

  const record = value as Record<string, unknown>
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
  return `{${parts.join(',')}}`
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

export interface PlanRequest {
  sourceInstanceId: string
  targetInstanceIds: string[]
  /** Asset slugs to copy, by kind. */
  profiles: string[]
  sceneCollections: string[]
  /** Copy the source's window/dock arrangement to each target. */
  uiLayout: boolean
  transform: SyncTransform
  /** Skip targets whose copy is already identical. */
  skipIdentical: boolean
}

/**
 * Works out exactly what a sync would do, without touching anything.
 *
 * The plan is surfaced in the UI for confirmation because overwriting a scene
 * collection mid-show is not recoverable from the operator's side, only from
 * the backup this plan promises.
 */
export async function planSync(
  request: PlanRequest,
  resolve: (id: string) => { instance: ObsInstance; install: ObsInstall } | null,
  workspaceRoot: string
): Promise<SyncPlan> {
  const items: SyncPlanItem[] = []
  const warnings: string[] = []

  const source = resolve(request.sourceInstanceId)
  if (!source) return { items, warnings: ['Source instance no longer exists.'] }

  const sourceAssets = await readInstanceAssets(source.instance, source.install)
  const backupRoot = path.join(
    workspacePaths(workspaceRoot).backups,
    new Date().toISOString().replace(/[:.]/g, '-')
  )

  for (const targetId of request.targetInstanceIds) {
    if (targetId === request.sourceInstanceId) continue

    const target = resolve(targetId)
    if (!target) {
      warnings.push(`Target ${targetId} no longer exists; skipped.`)
      continue
    }

    const targetPaths = instancePaths(target.instance, target.install)
    const targetAssets = await readInstanceAssets(target.instance, target.install)

    for (const slug of request.profiles) {
      const asset = sourceAssets.profiles.find((a) => a.slug === slug)
      if (!asset) {
        warnings.push(`Profile "${slug}" not found on the source instance.`)
        continue
      }

      const targetName = request.transform.renameTo?.trim() || asset.name
      const targetSlug = request.transform.renameTo?.trim() || asset.slug
      const existing = targetAssets.profiles.find((a) => a.slug === targetSlug)

      items.push({
        kind: 'profile',
        sourceInstanceId: request.sourceInstanceId,
        targetInstanceId: targetId,
        assetName: asset.name,
        targetName,
        targetPath: path.join(targetPaths.profilesDir, targetSlug),
        action: resolveAction(existing?.hash, asset.hash, request.skipIdentical, request.transform),
        backupPath: existing
          ? path.join(backupRoot, target.instance.name, 'profiles', targetSlug)
          : null
      })
    }

    if (request.uiLayout) {
      const asset = sourceAssets.uiLayouts[0]
      if (!asset) {
        warnings.push(
          'The source instance has no saved window layout yet. Open it in OBS, arrange the docks, then close it so OBS writes the layout out.'
        )
      } else {
        const existing = targetAssets.uiLayouts[0]
        items.push({
          kind: 'uiLayout',
          sourceInstanceId: request.sourceInstanceId,
          targetInstanceId: targetId,
          assetName: asset.name,
          targetName: asset.name,
          targetPath: targetPaths.userIni,
          action: resolveAction(existing?.hash, asset.hash, request.skipIdentical, request.transform),
          backupPath: existing ? path.join(backupRoot, target.instance.name, 'user.ini') : null
        })
      }
    }

    for (const slug of request.sceneCollections) {
      const asset = sourceAssets.sceneCollections.find((a) => a.slug === slug)
      if (!asset) {
        warnings.push(`Scene collection "${slug}" not found on the source instance.`)
        continue
      }

      const targetName = request.transform.renameTo?.trim() || asset.name
      const targetSlug = request.transform.renameTo?.trim() || asset.slug
      const existing = targetAssets.sceneCollections.find((a) => a.slug === targetSlug)

      items.push({
        kind: 'sceneCollection',
        sourceInstanceId: request.sourceInstanceId,
        targetInstanceId: targetId,
        assetName: asset.name,
        targetName,
        targetPath: path.join(targetPaths.scenesDir, `${targetSlug}.json`),
        action: resolveAction(existing?.hash, asset.hash, request.skipIdentical, request.transform),
        backupPath: existing
          ? path.join(backupRoot, target.instance.name, 'scenes', `${targetSlug}.json`)
          : null
      })
    }
  }

  if (items.some((item) => item.action === 'overwrite')) {
    warnings.push(
      'Overwritten assets are backed up under the workspace `backups/` folder before being replaced.'
    )
  }

  return { items, warnings }
}

/**
 * Decides whether a target already holds this asset.
 *
 * The hashes being compared are canonical (see above), so the routine
 * per-instance rewrites do not defeat the comparison. Path replacements are
 * the exception: they change real content, and only the operator knows
 * whether the target has already had them applied.
 */
function resolveAction(
  existingHash: string | undefined,
  sourceHash: string,
  skipIdentical: boolean,
  transform: SyncTransform
): SyncPlanItem['action'] {
  if (existingHash === undefined) return 'create'
  if (skipIdentical && transform.pathRewrites.length === 0 && existingHash === sourceHash) {
    return 'skip-identical'
  }
  return 'overwrite'
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

/**
 * Executes a plan item by item. A failure on one target never aborts the
 * others — a partial sync with a clear report beats an all-or-nothing rollback
 * the operator cannot reason about mid-show.
 */
export async function applySync(
  plan: SyncPlan,
  resolve: (id: string) => { instance: ObsInstance; install: ObsInstall } | null,
  transform: SyncTransform
): Promise<SyncResult> {
  const applied: SyncPlanItem[] = []
  const failed: SyncResult['failed'] = []

  for (const item of plan.items) {
    if (item.action === 'skip-identical') {
      applied.push(item)
      continue
    }

    try {
      const source = resolve(item.sourceInstanceId)
      const target = resolve(item.targetInstanceId)
      if (!source || !target) throw new Error('Instance no longer exists')

      if (item.backupPath) await backup(item.targetPath, item.backupPath)

      if (item.kind === 'profile') {
        await syncProfile(item, source, target, transform)
      } else if (item.kind === 'uiLayout') {
        await syncUiLayout(item, source, target, transform)
      } else {
        await syncSceneCollection(item, source, target, transform)
      }

      // The target's files just changed underneath the digest cache.
      hashCache.invalidate(item.targetPath)

      applied.push(item)
      log.info(
        'sync',
        `${item.action === 'create' ? 'Copied' : 'Replaced'} ${item.kind} "${item.assetName}" -> ${target.instance.name}`,
        item.targetInstanceId
      )
    } catch (err) {
      failed.push({ item, error: errorMessage(err) })
      log.error(
        'sync',
        `Failed to copy ${item.kind} "${item.assetName}": ${errorMessage(err)}`,
        item.targetInstanceId
      )
    }
  }

  return { applied, failed }
}

async function backup(from: string, to: string): Promise<void> {
  if (!(await pathExists(from))) return
  const stat = await fs.stat(from)
  if (stat.isDirectory()) {
    await copyTree(from, to, { dereference: true })
  } else {
    await ensureDir(path.dirname(to))
    await fs.copyFile(from, to)
  }
}

async function syncProfile(
  item: SyncPlanItem,
  source: { instance: ObsInstance; install: ObsInstall },
  target: { instance: ObsInstance; install: ObsInstall },
  transform: SyncTransform
): Promise<void> {
  const sourcePaths = instancePaths(source.instance, source.install)
  const targetPaths = instancePaths(target.instance, target.install)
  const sourceDir = path.join(sourcePaths.profilesDir, path.basename(item.targetPath))
  const fallbackDir = path.join(sourcePaths.profilesDir, item.assetName)

  const from = (await pathExists(sourceDir)) ? sourceDir : fallbackDir
  if (!(await pathExists(from))) {
    throw new Error(`Source profile folder not found: ${from}`)
  }

  await fs.rm(item.targetPath, { recursive: true, force: true })
  await copyTree(from, item.targetPath, { dereference: true })

  // basic.ini carries the display name and every output path.
  const basicIni = path.join(item.targetPath, 'basic.ini')
  if (await pathExists(basicIni)) {
    const doc = parseIni(await fs.readFile(basicIni, 'utf8'))
    iniSet(doc, 'General', 'Name', item.targetName)

    if (transform.retargetRecordingPath) {
      retargetRecordingPaths(doc, targetPaths.recordingsDir, target.instance.name)
    }
    applyIniPathRewrites(doc, transform.pathRewrites)

    await writeTextAtomic(basicIni, serializeIni(doc))
  }

  if (transform.stripStreamKey) {
    await stripStreamKey(path.join(item.targetPath, 'service.json'))
  }
}

/**
 * Points every recording output at the target instance's own folder.
 *
 * This is the single most important rewrite in the whole sync: without it,
 * cloning a profile makes N instances record to the same directory with the
 * same filename pattern, and they overwrite each other's takes.
 */
function retargetRecordingPaths(doc: IniDocument, recordingsDir: string, instanceName: string): void {
  iniSet(doc, 'SimpleOutput', 'FilePath', recordingsDir)
  iniSet(doc, 'AdvOut', 'RecFilePath', recordingsDir)
  iniSet(doc, 'AdvOut', 'FFFilePath', recordingsDir)

  const pattern = `${instanceName}-%CCYY-%MM-%DD %hh-%mm-%ss`
  iniSet(doc, 'Output', 'FilenameFormatting', pattern)
  iniSet(doc, 'SimpleOutput', 'FilenameFormatting', pattern)
}

function applyIniPathRewrites(doc: IniDocument, rewrites: SyncTransform['pathRewrites']): void {
  if (rewrites.length === 0) return
  for (const [, entries] of doc) {
    for (const [key, value] of entries) {
      entries.set(key, rewriteString(value, rewrites))
    }
  }
}

async function stripStreamKey(serviceFile: string): Promise<void> {
  if (!(await pathExists(serviceFile))) return
  const service = await readJson<{ settings?: Record<string, unknown> }>(serviceFile)
  if (!service?.settings) return

  for (const key of ['key', 'password', 'bearer_token']) {
    if (key in service.settings) service.settings[key] = ''
  }
  await writeJsonAtomic(serviceFile, service)
}

/**
 * Copies the window and dock arrangement into the target's `user.ini`.
 *
 * Only the `[BasicWindow]` keys that describe layout are touched — the rest of
 * the target's user config (its active profile, its first-run flag) is left
 * exactly as it was, because overwriting those would repoint the instance at a
 * profile it may not have.
 */
async function syncUiLayout(
  item: SyncPlanItem,
  source: { instance: ObsInstance; install: ObsInstall },
  target: { instance: ObsInstance; install: ObsInstall },
  transform: SyncTransform
): Promise<void> {
  const sourcePaths = instancePaths(source.instance, source.install)
  const layout = await readUiLayout(sourcePaths.userIni)
  if (!layout) throw new Error('The source instance has no saved window layout')

  // Custom browser docks are keyed by uuid in OBS's own persisted state, so
  // two instances sharing one would fight over the same dock geometry.
  const prepared: UiLayout = transform.regenerateUuids ? regenerateDockUuids(layout) : layout

  await writeUiLayout(item.targetPath, prepared, {
    includeGeometry: transform.includeWindowGeometry
  })
}

async function syncSceneCollection(
  item: SyncPlanItem,
  source: { instance: ObsInstance; install: ObsInstall },
  target: { instance: ObsInstance; install: ObsInstall },
  transform: SyncTransform
): Promise<void> {
  const sourcePaths = instancePaths(source.instance, source.install)
  const slug = path.basename(item.targetPath, '.json')
  const candidates = [
    path.join(sourcePaths.scenesDir, `${slug}.json`),
    path.join(sourcePaths.scenesDir, `${item.assetName}.json`)
  ]

  let from: string | null = null
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      from = candidate
      break
    }
  }
  if (!from) throw new Error(`Source scene collection not found: ${candidates[0]}`)

  const collection = await readJson<Record<string, unknown>>(from)
  if (!collection) throw new Error(`Could not parse scene collection: ${from}`)

  collection.name = item.targetName

  if (transform.pathRewrites.length > 0) {
    rewriteJsonStrings(collection, (value) => rewriteString(value, transform.pathRewrites))
  }
  if (transform.tagBrowserSources) {
    tagBrowserSources(collection, target.instance)
  }
  if (transform.regenerateUuids) {
    regenerateUuids(collection)
  }

  await writeJsonAtomic(item.targetPath, collection)
}

/**
 * Rewrites browser source URLs so one shared overlay file can identify which
 * instance is rendering it.
 */
function tagBrowserSources(collection: Record<string, unknown>, instance: ObsInstance): void {
  const sources = collection.sources
  if (!Array.isArray(sources)) return

  for (const raw of sources) {
    const source = raw as Record<string, unknown>
    const id = String(source.id ?? '')
    if (id !== 'browser_source' && id !== 'linuxbrowser-source') continue

    const settings = source.settings as Record<string, unknown> | undefined
    const url = settings?.url
    if (typeof url !== 'string' || url === '') continue

    try {
      const parsed = new URL(url)
      parsed.searchParams.set('instance', instance.name)
      parsed.searchParams.set('instanceId', instance.id)
      if (instance.role !== '') parsed.searchParams.set('role', instance.role)
      settings!.url = parsed.toString()
    } catch {
      // A local file path rather than a URL; leave it alone.
    }
  }
}

/**
 * Gives every source a fresh UUID.
 *
 * OBS 30+ persists source UUIDs, and two instances sharing them confuses
 * anything that keys off source identity (notably obs-websocket lookups and
 * some plugins), so a copy gets its own.
 */
function regenerateUuids(collection: Record<string, unknown>): void {
  const sources = collection.sources
  if (!Array.isArray(sources)) return
  for (const raw of sources) {
    const source = raw as Record<string, unknown>
    if (typeof source.uuid === 'string') source.uuid = crypto.randomUUID()
  }
}

/** Applies literal prefix replacements to every string in a JSON tree. */
function rewriteJsonStrings(node: unknown, rewrite: (value: string) => string): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      if (typeof child === 'string') node[index] = rewrite(child)
      else rewriteJsonStrings(child, rewrite)
    })
    return
  }
  if (node === null || typeof node !== 'object') return

  const record = node as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') record[key] = rewrite(value)
    else rewriteJsonStrings(value, rewrite)
  }
}

function rewriteString(value: string, rewrites: SyncTransform['pathRewrites']): string {
  let result = value
  for (const { from, to } of rewrites) {
    if (from === '') continue
    result = result.split(from).join(to)
  }
  return result
}
