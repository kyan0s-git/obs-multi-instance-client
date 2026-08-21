import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObsInstall, ObsInstance } from '../src/shared/types'
import { mergeLaunchOptions } from '../src/main/services/defaults'
import { instancePaths } from '../src/main/services/paths'
import { applySync, defaultTransform, planSync, readInstanceAssets } from '../src/main/services/sync'
import { iniGet, parseIni } from '../src/main/util/ini'

/**
 * Sync runs against real files, so these tests do too.
 *
 * The behaviour under test is the one that silently ruins a shoot if it
 * regresses: a profile copied to several instances must not leave them all
 * recording into the same folder with the same filename pattern.
 */

let workspace: string
let install: ObsInstall
let source: ObsInstance
let target: ObsInstance

function makeInstance(id: string, name: string, dir: string): ObsInstance {
  return {
    id,
    name,
    role: '',
    color: '#4f9dff',
    dir,
    installId: 'install-1',
    // Linux-style isolation keeps the test filesystem layout simple and is
    // independent of the host platform.
    isolation: 'xdg-config-home',
    websocket: { enabled: true, port: 4460, password: '', ipv4Only: false },
    launch: mergeLaunchOptions(null),
    order: 0,
    disabled: false,
    autoRestart: false,
    createdAt: 0,
    updatedAt: 0,
    notes: ''
  }
}

/** Writes a profile and a scene collection into an instance's config tree. */
async function seed(
  instance: ObsInstance,
  options: {
    profileName?: string
    recordingPath?: string
    streamKey?: string
    browserUrl?: string
  } = {}
): Promise<void> {
  const paths = instancePaths(instance, install)
  const profileName = options.profileName ?? 'Show'

  const profileDir = path.join(paths.profilesDir, profileName)
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(
    path.join(profileDir, 'basic.ini'),
    [
      '[General]',
      `Name=${profileName}`,
      '',
      '[SimpleOutput]',
      `FilePath=${options.recordingPath ?? '/original/recordings'}`,
      'RecFormat2=mkv',
      '',
      '[AdvOut]',
      `RecFilePath=${options.recordingPath ?? '/original/recordings'}`,
      '',
      '[Output]',
      'FilenameFormatting=%CCYY-%MM-%DD %hh-%mm-%ss',
      ''
    ].join('\n'),
    'utf8'
  )
  await fs.writeFile(
    path.join(profileDir, 'service.json'),
    JSON.stringify({ type: 'rtmp_common', settings: { server: 'auto', key: options.streamKey ?? 'live_secret_123' } }),
    'utf8'
  )

  await fs.mkdir(paths.scenesDir, { recursive: true })
  await fs.writeFile(
    path.join(paths.scenesDir, 'Show.json'),
    JSON.stringify({
      name: 'Show',
      current_scene: 'Main',
      sources: [
        { id: 'scene', name: 'Main', uuid: 'aaaaaaaa-1111-2222-3333-444444444444', settings: {} },
        {
          id: 'browser_source',
          name: 'Overlay',
          uuid: 'bbbbbbbb-1111-2222-3333-444444444444',
          settings: { url: options.browserUrl ?? 'http://127.0.0.1:4599/overlay.html' }
        },
        {
          id: 'ffmpeg_source',
          name: 'Sting',
          uuid: 'cccccccc-1111-2222-3333-444444444444',
          settings: { local_file: '/original/media/sting.mp4' }
        }
      ]
    }),
    'utf8'
  )
}

function resolve(id: string): { instance: ObsInstance; install: ObsInstall } | null {
  if (id === source.id) return { instance: source, install }
  if (id === target.id) return { instance: target, install }
  return null
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-sync-'))

  install = {
    id: 'install-1',
    label: 'OBS',
    root: '/opt/obs-studio',
    executable: '/opt/obs-studio/bin/obs',
    version: '31.0.0',
    detected: true,
    problems: []
  }

  source = makeInstance('src', 'Cam 1', path.join(workspace, 'instances', 'cam-1'))
  target = makeInstance('dst', 'Cam 2', path.join(workspace, 'instances', 'cam-2'))

  await seed(source)
  await fs.mkdir(instancePaths(target, install).profilesDir, { recursive: true })
  await fs.mkdir(instancePaths(target, install).scenesDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

describe('readInstanceAssets', () => {
  it('reads the display name out of basic.ini, not the folder name', async () => {
    await seed(source, { profileName: 'Weird Name' })
    const assets = await readInstanceAssets(source, install)

    const profile = assets.profiles.find((entry) => entry.slug === 'Weird Name')
    expect(profile?.name).toBe('Weird Name')
  })

  it('hashes assets so identical copies can be told from divergent ones', async () => {
    const first = await readInstanceAssets(source, install)
    const second = await readInstanceAssets(source, install)
    expect(first.profiles[0].hash).toBe(second.profiles[0].hash)
  })

  it('reports an empty instance without erroring', async () => {
    const assets = await readInstanceAssets(target, install)
    expect(assets.error).toBeNull()
    expect(assets.profiles).toEqual([])
    expect(assets.sceneCollections).toEqual([])
  })
})

describe('planSync', () => {
  it('plans a create when the target has nothing', async () => {
    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items).toHaveLength(2)
    expect(plan.items.every((item) => item.action === 'create')).toBe(true)
  })

  it('never plans to copy an instance onto itself', async () => {
    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [source.id, target.id],
        profiles: ['Show'],
        sceneCollections: [],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items.every((item) => item.targetInstanceId === target.id)).toBe(true)
  })

  it('warns about an asset that is not on the source', async () => {
    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Nonexistent'],
        sceneCollections: [],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items).toHaveLength(0)
    expect(plan.warnings.join(' ')).toContain('Nonexistent')
  })
})

describe('applySync', () => {
  async function syncEverything(transform = defaultTransform()) {
    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform,
        skipIdentical: false
      },
      resolve,
      workspace
    )
    return applySync(plan, resolve, transform)
  }

  it('copies the profile and scene collection across', async () => {
    const result = await syncEverything()
    expect(result.failed).toEqual([])

    const targetPaths = instancePaths(target, install)
    await expect(fs.stat(path.join(targetPaths.profilesDir, 'Show', 'basic.ini'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(targetPaths.scenesDir, 'Show.json'))).resolves.toBeTruthy()
  })

  it('repoints recording output at the target instance, so takes cannot collide', async () => {
    await syncEverything()

    const targetPaths = instancePaths(target, install)
    const ini = parseIni(
      await fs.readFile(path.join(targetPaths.profilesDir, 'Show', 'basic.ini'), 'utf8')
    )

    expect(iniGet(ini, 'SimpleOutput', 'FilePath')).toBe(targetPaths.recordingsDir)
    expect(iniGet(ini, 'AdvOut', 'RecFilePath')).toBe(targetPaths.recordingsDir)
    // The filename pattern is namespaced too, so two instances writing to a
    // shared volume still produce distinguishable files.
    expect(iniGet(ini, 'Output', 'FilenameFormatting')).toContain('Cam 2')
  })

  it('leaves the recording path alone when the rewrite is switched off', async () => {
    await syncEverything({ ...defaultTransform(), retargetRecordingPath: false })

    const targetPaths = instancePaths(target, install)
    const ini = parseIni(
      await fs.readFile(path.join(targetPaths.profilesDir, 'Show', 'basic.ini'), 'utf8')
    )
    expect(iniGet(ini, 'SimpleOutput', 'FilePath')).toBe('/original/recordings')
  })

  it('clears the stream key so a copy cannot double-publish', async () => {
    await syncEverything()

    const targetPaths = instancePaths(target, install)
    const service = JSON.parse(
      await fs.readFile(path.join(targetPaths.profilesDir, 'Show', 'service.json'), 'utf8')
    ) as { settings: { key: string } }

    expect(service.settings.key).toBe('')
  })

  it('regenerates source UUIDs so copies do not share identity', async () => {
    await syncEverything()

    const targetPaths = instancePaths(target, install)
    const collection = JSON.parse(
      await fs.readFile(path.join(targetPaths.scenesDir, 'Show.json'), 'utf8')
    ) as { sources: Array<{ uuid: string }> }

    const originals = ['aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444']
    for (const entry of collection.sources) {
      expect(originals).not.toContain(entry.uuid)
    }
    expect(new Set(collection.sources.map((entry) => entry.uuid)).size).toBe(3)
  })

  it('applies path replacements throughout the scene collection', async () => {
    await syncEverything({
      ...defaultTransform(),
      pathRewrites: [{ from: '/original/media', to: '/new/media' }]
    })

    const targetPaths = instancePaths(target, install)
    const collection = JSON.parse(
      await fs.readFile(path.join(targetPaths.scenesDir, 'Show.json'), 'utf8')
    ) as { sources: Array<{ name: string; settings: Record<string, string> }> }

    const sting = collection.sources.find((entry) => entry.name === 'Sting')
    expect(sting?.settings.local_file).toBe('/new/media/sting.mp4')
  })

  it('tags browser source URLs with the target instance when asked', async () => {
    await syncEverything({ ...defaultTransform(), tagBrowserSources: true })

    const targetPaths = instancePaths(target, install)
    const collection = JSON.parse(
      await fs.readFile(path.join(targetPaths.scenesDir, 'Show.json'), 'utf8')
    ) as { sources: Array<{ name: string; settings: Record<string, string> }> }

    const overlay = collection.sources.find((entry) => entry.name === 'Overlay')
    expect(overlay?.settings.url).toContain('instance=Cam+2')
  })

  it('backs up an overwritten asset before replacing it', async () => {
    await syncEverything()

    // Change the source, then sync again over the existing copy.
    await seed(source, { recordingPath: '/second/pass' })
    const result = await syncEverything()

    expect(result.failed).toEqual([])
    const overwritten = result.applied.find((item) => item.action === 'overwrite')
    expect(overwritten?.backupPath).toBeTruthy()
    await expect(fs.stat(overwritten!.backupPath!)).resolves.toBeTruthy()
  })

  it('reports a failure per item instead of aborting the whole run', async () => {
    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform: defaultTransform(),
        skipIdentical: false
      },
      resolve,
      workspace
    )

    // Remove the source scene collection after planning, so one item fails.
    await fs.rm(path.join(instancePaths(source, install).scenesDir, 'Show.json'))

    const result = await applySync(plan, resolve, defaultTransform())
    expect(result.applied).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].item.kind).toBe('sceneCollection')
  })

  it('recognises a target as in sync even though per-instance fields differ', async () => {
    // A real sync repoints recording paths and clears stream keys, so the
    // files are never byte-identical. The comparison still has to say "these
    // two instances are running the same show".
    await syncEverything()

    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items).toHaveLength(2)
    expect(plan.items.every((item) => item.action === 'skip-identical')).toBe(true)
  })

  it('still reports a genuine content difference as an overwrite', async () => {
    await syncEverything()

    // Change something that is real show content, not a per-instance field.
    const targetPaths = instancePaths(target, install)
    const file = path.join(targetPaths.scenesDir, 'Show.json')
    const collection = JSON.parse(await fs.readFile(file, 'utf8')) as {
      sources: Array<{ name: string; settings: Record<string, string> }>
    }
    collection.sources.push({ name: 'Extra camera', settings: {} })
    await fs.writeFile(file, JSON.stringify(collection), 'utf8')

    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: [],
        sceneCollections: ['Show'],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items[0].action).toBe('overwrite')
  })

  it('ignores key order and formatting when comparing', async () => {
    await syncEverything()

    const targetPaths = instancePaths(target, install)
    const file = path.join(targetPaths.scenesDir, 'Show.json')
    const collection = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    // Re-serialise with reversed key order and different indentation.
    const reordered = Object.fromEntries(Object.entries(collection).reverse())
    await fs.writeFile(file, JSON.stringify(reordered, null, 8), 'utf8')

    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: [],
        sceneCollections: ['Show'],
        transform: defaultTransform(),
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items[0].action).toBe('skip-identical')
  })

  it('always overwrites when path replacements are requested', async () => {
    await syncEverything()

    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform: { ...defaultTransform(), pathRewrites: [{ from: '/a', to: '/b' }] },
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items.every((item) => item.action === 'overwrite')).toBe(true)
  })

  it('skips a byte-identical copy when no rewrites are requested', async () => {
    const inert = {
      ...defaultTransform(),
      retargetRecordingPath: false,
      stripStreamKey: false,
      regenerateUuids: false
    }

    await syncEverything(inert)

    const plan = await planSync(
      {
        sourceInstanceId: source.id,
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        transform: inert,
        skipIdentical: true
      },
      resolve,
      workspace
    )

    expect(plan.items.every((item) => item.action === 'skip-identical')).toBe(true)
  })
})
