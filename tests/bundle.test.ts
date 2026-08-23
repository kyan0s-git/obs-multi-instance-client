import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObsInstall, ObsInstance } from '../src/shared/types'
import {
  applyImport,
  exportBundle,
  importBundleAssets,
  inspectBundle,
  planImport
} from '../src/main/services/bundle'
import { mergeLaunchOptions } from '../src/main/services/defaults'
import { instancePaths } from '../src/main/services/paths'
import { defaultTransform } from '../src/main/services/sync'
import { iniGet, parseIni } from '../src/main/util/ini'
import { createZip } from '../src/main/util/zip'

/**
 * A bundle is how a fleet configuration leaves the machine, so these tests
 * exercise the whole trip: real files out, a real archive on disk, real files
 * back into a different instance.
 */

let workspace: string
let install: ObsInstall
let source: ObsInstance
let target: ObsInstance
let bundlePath: string
let assetsDir: string

function makeInstance(id: string, name: string, dir: string): ObsInstance {
  return {
    id,
    name,
    role: 'ISO',
    color: '#4f9dff',
    dir,
    installId: 'install-1',
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

async function seedSource(): Promise<void> {
  const paths = instancePaths(source, install)

  const profileDir = path.join(paths.profilesDir, 'Show')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(
    path.join(profileDir, 'basic.ini'),
    [
      '[General]',
      'Name=Show',
      '',
      '[SimpleOutput]',
      'FilePath=/original/recordings',
      '',
      '[AdvOut]',
      'RecFilePath=/original/recordings',
      ''
    ].join('\n')
  )
  await fs.writeFile(
    path.join(profileDir, 'service.json'),
    JSON.stringify({ settings: { key: 'live_secret' } })
  )

  await fs.mkdir(paths.scenesDir, { recursive: true })
  await fs.writeFile(
    path.join(paths.scenesDir, 'Show.json'),
    JSON.stringify({
      name: 'Show',
      sources: [{ id: 'scene', name: 'Main', uuid: 'original-uuid', settings: {} }]
    })
  )

  await fs.mkdir(path.dirname(paths.userIni), { recursive: true })
  await fs.writeFile(
    paths.userIni,
    ['[Basic]', 'Profile=Show', '', '[BasicWindow]', 'DockState=DOCKSTATE', 'DocksLocked=true', ''].join(
      '\n'
    )
  )
}

function resolve(id: string): { instance: ObsInstance; install: ObsInstall } | null {
  if (id === source.id) return { instance: source, install }
  if (id === target.id) return { instance: target, install }
  return null
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'obsfleet-bundle-'))
  bundlePath = path.join(workspace, 'fleet.zip')
  assetsDir = path.join(workspace, 'assets')

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

  await seedSource()
  await fs.mkdir(instancePaths(target, install).profilesDir, { recursive: true })
  await fs.mkdir(instancePaths(target, install).scenesDir, { recursive: true })

  await fs.mkdir(assetsDir, { recursive: true })
  await fs.writeFile(path.join(assetsDir, 'overlay.html'), '<p>overlay</p>')
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

async function writeBundle(
  overrides: Partial<Parameters<typeof exportBundle>[0]> = {}
): Promise<void> {
  const { buffer } = await exportBundle(
    {
      sourceInstanceIds: [source.id],
      profiles: {},
      sceneCollections: {},
      includeUiLayout: true,
      includeAssets: false,
      ...overrides
    },
    resolve,
    assetsDir,
    '0.1.0-test'
  )
  await fs.writeFile(bundlePath, buffer)
}

describe('exportBundle', () => {
  it('writes an archive describing what it contains', async () => {
    await writeBundle()
    const contents = await inspectBundle(bundlePath)

    expect(contents.sources).toHaveLength(1)
    expect(contents.sources[0].instanceName).toBe('Cam 1')
    expect(contents.sources[0].profiles.map((entry) => entry.slug)).toContain('Show')
    expect(contents.sources[0].sceneCollections.map((entry) => entry.slug)).toContain('Show')
    expect(contents.sources[0].uiLayout).not.toBeNull()
    expect(contents.createdBy).toBe('OBS Fleet 0.1.0-test')
  })

  it('omits the UI layout when it was not requested', async () => {
    await writeBundle({ includeUiLayout: false })
    const contents = await inspectBundle(bundlePath)
    expect(contents.sources[0].uiLayout).toBeNull()
  })

  it('includes the asset library on request', async () => {
    await writeBundle({ includeAssets: true })
    const contents = await inspectBundle(bundlePath)

    expect(contents.assets?.fileCount).toBe(1)
    expect(contents.assets!.totalBytes).toBeGreaterThan(0)
  })

  it('reports no assets when they were not included', async () => {
    await writeBundle()
    expect((await inspectBundle(bundlePath)).assets).toBeNull()
  })
})

describe('inspectBundle', () => {
  it('rejects a zip that is not a fleet bundle', async () => {
    const notABundle = path.join(workspace, 'other.zip')
    await fs.writeFile(notABundle, await createZip([{ path: 'a.txt', data: Buffer.from('x') }]))

    await expect(inspectBundle(notABundle)).rejects.toThrow(/no manifest/i)
  })

  it('refuses a bundle from a newer format version', async () => {
    const future = path.join(workspace, 'future.zip')
    await fs.writeFile(
      future,
      await createZip([
        {
          path: 'manifest.json',
          data: Buffer.from(
            JSON.stringify({ format: 'obs-fleet-bundle', version: 999, sources: [] })
          )
        }
      ])
    )

    await expect(inspectBundle(future)).rejects.toThrow(/newer version/i)
  })
})

describe('import round trip', () => {
  async function importAll(transform = defaultTransform()) {
    const { plan, stagingDir } = await planImport(
      {
        file: bundlePath,
        sourceName: 'Cam 1',
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: ['Show'],
        uiLayout: true,
        transform,
        skipIdentical: false
      },
      resolve,
      workspace
    )
    return applyImport(plan, stagingDir, transform, resolve)
  }

  it('restores the profile and scene collection into the target', async () => {
    await writeBundle()
    const result = await importAll()

    expect(result.failed).toEqual([])

    const targetPaths = instancePaths(target, install)
    await expect(
      fs.stat(path.join(targetPaths.profilesDir, 'Show', 'basic.ini'))
    ).resolves.toBeTruthy()
    await expect(fs.stat(path.join(targetPaths.scenesDir, 'Show.json'))).resolves.toBeTruthy()
  })

  it('applies the same per-instance rewrites a normal sync would', async () => {
    await writeBundle()
    await importAll()

    const targetPaths = instancePaths(target, install)
    const ini = parseIni(
      await fs.readFile(path.join(targetPaths.profilesDir, 'Show', 'basic.ini'), 'utf8')
    )

    // The imported profile must record into the target's own folder, not the
    // path baked into the bundle on someone else's machine.
    expect(iniGet(ini, 'SimpleOutput', 'FilePath')).toBe(targetPaths.recordingsDir)
    expect(iniGet(ini, 'AdvOut', 'RecFilePath')).toBe(targetPaths.recordingsDir)

    const service = JSON.parse(
      await fs.readFile(path.join(targetPaths.profilesDir, 'Show', 'service.json'), 'utf8')
    ) as { settings: { key: string } }
    expect(service.settings.key).toBe('')
  })

  it('restores the window layout without clobbering the target profile', async () => {
    await writeBundle()

    // The target already has its own active profile selected.
    const targetPaths = instancePaths(target, install)
    await fs.mkdir(path.dirname(targetPaths.userIni), { recursive: true })
    await fs.writeFile(targetPaths.userIni, '[Basic]\nProfile=TargetOwn\n')

    await importAll()

    const ini = parseIni(await fs.readFile(targetPaths.userIni, 'utf8'))
    expect(iniGet(ini, 'BasicWindow', 'DockState')).toBe('DOCKSTATE')
    expect(iniGet(ini, 'Basic', 'Profile')).toBe('TargetOwn')
  })

  it('gives imported sources fresh UUIDs', async () => {
    await writeBundle()
    await importAll()

    const collection = JSON.parse(
      await fs.readFile(
        path.join(instancePaths(target, install).scenesDir, 'Show.json'),
        'utf8'
      )
    ) as { sources: Array<{ uuid: string }> }

    expect(collection.sources[0].uuid).not.toBe('original-uuid')
  })

  it('removes the staging folder after applying', async () => {
    await writeBundle()

    const { plan, stagingDir } = await planImport(
      {
        file: bundlePath,
        sourceName: 'Cam 1',
        targetInstanceIds: [target.id],
        profiles: ['Show'],
        sceneCollections: [],
        uiLayout: false,
        transform: defaultTransform(),
        skipIdentical: false
      },
      resolve,
      workspace
    )

    await applyImport(plan, stagingDir, defaultTransform(), resolve)
    await expect(fs.stat(stagingDir)).rejects.toThrow()
  })
})

describe('importBundleAssets', () => {
  it('restores bundled assets into the workspace', async () => {
    await writeBundle({ includeAssets: true })

    const restoreDir = path.join(workspace, 'restored')
    const result = await importBundleAssets(bundlePath, restoreDir, { overwrite: false })

    expect(result.written).toBe(1)
    expect(await fs.readFile(path.join(restoreDir, 'overlay.html'), 'utf8')).toBe('<p>overlay</p>')
  })

  it('keeps existing files unless overwrite is requested', async () => {
    await writeBundle({ includeAssets: true })

    const restoreDir = path.join(workspace, 'restored')
    await fs.mkdir(restoreDir, { recursive: true })
    await fs.writeFile(path.join(restoreDir, 'overlay.html'), 'MINE')

    const kept = await importBundleAssets(bundlePath, restoreDir, { overwrite: false })
    expect(kept.skipped).toBe(1)
    expect(await fs.readFile(path.join(restoreDir, 'overlay.html'), 'utf8')).toBe('MINE')

    const replaced = await importBundleAssets(bundlePath, restoreDir, { overwrite: true })
    expect(replaced.written).toBe(1)
    expect(await fs.readFile(path.join(restoreDir, 'overlay.html'), 'utf8')).toBe('<p>overlay</p>')
  })

  it('refuses a traversal path inside a hostile bundle', async () => {
    // A bundle can come from anywhere, so a crafted entry must not be able to
    // write outside the asset folder.
    const hostile = path.join(workspace, 'hostile.zip')
    const raw = await createZip([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'obs-fleet-bundle', version: 1, sources: [] })) },
      { path: 'assets/safe.txt', data: Buffer.from('ok') }
    ])
    // Rewrite a stored path to a traversal one, bypassing the writer's guard.
    const patched = Buffer.from(raw).toString('binary').split('assets/safe.txt').join('assets/../../x')
    await fs.writeFile(hostile, Buffer.from(patched, 'binary'))

    const restoreDir = path.join(workspace, 'restored')
    const result = await importBundleAssets(hostile, restoreDir, { overwrite: true }).catch(
      () => ({ written: 0, skipped: 1 })
    )

    expect(result.written).toBe(0)
    await expect(fs.stat(path.join(workspace, 'x'))).rejects.toThrow()
  })
})
