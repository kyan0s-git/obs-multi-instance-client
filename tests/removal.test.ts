import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObsInstall, ObsInstance } from '../src/shared/types'
import { mergeLaunchOptions } from '../src/main/services/defaults'
import { isInsideWorkspace, planInstallRemoval, planInstanceRemoval } from '../src/main/services/removal'
import type { RemovalContext } from '../src/main/services/removal'

/**
 * Removal used to be a flat refusal whenever anything referenced the target.
 * These pin the replacement: it states the consequences, keeps the one refusal
 * that protects files this application did not create, and never silently
 * deletes something outside the workspace.
 */

let workspace: string

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-removal-'))
  await fs.mkdir(path.join(workspace, 'instances'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

function makeInstall(id: string, root: string, managed: boolean): ObsInstall {
  return {
    id,
    label: `OBS ${id}`,
    root,
    executable: path.join(root, 'bin', 'obs'),
    version: '31.0.2',
    detected: !managed,
    managed,
    problems: []
  }
}

function makeInstance(id: string, name: string, dir: string, installId = 'install-a'): ObsInstance {
  return {
    id,
    name,
    role: '',
    color: '#4f9dff',
    dir,
    installId,
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

function context(over: Partial<RemovalContext> = {}): RemovalContext {
  return {
    workspaceRoot: workspace,
    instances: [],
    installs: [],
    runningIds: new Set(),
    ...over
  }
}

describe('instance removal', () => {
  it('reports the folder and its size when files are being deleted', async () => {
    const dir = path.join(workspace, 'instances', 'iso-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'scene.json'), 'x'.repeat(2048))

    const instance = makeInstance('a', 'ISO 1', dir)
    const plan = await planInstanceRemoval('a', true, context({ instances: [instance] }))

    expect(plan.destructive).toBe(true)
    expect(plan.deletions).toHaveLength(1)
    expect(plan.deletions[0].sizeBytes).toBeGreaterThan(0)
    expect(plan.warnings.join(' ')).toMatch(/no undo/i)
  })

  it('does not delete anything when only unregistering', async () => {
    const dir = path.join(workspace, 'instances', 'iso-1')
    await fs.mkdir(dir, { recursive: true })

    const plan = await planInstanceRemoval(
      'a',
      false,
      context({ instances: [makeInstance('a', 'ISO 1', dir)] })
    )

    expect(plan.destructive).toBe(false)
    expect(plan.deletions).toEqual([])
  })

  it('refuses to erase a folder outside the workspace, and says so', async () => {
    const outside = path.join(workspace, 'elsewhere')
    await fs.mkdir(outside, { recursive: true })

    const plan = await planInstanceRemoval(
      'a',
      true,
      context({ instances: [makeInstance('a', 'Imported', outside)] })
    )

    expect(plan.deletions).toEqual([])
    expect(plan.destructive).toBe(false)
    expect(plan.warnings.join(' ')).toMatch(/outside the workspace/i)
  })

  it('warns that a running instance keeps running unsupervised', async () => {
    const dir = path.join(workspace, 'instances', 'iso-1')
    await fs.mkdir(dir, { recursive: true })

    const plan = await planInstanceRemoval(
      'a',
      false,
      context({ instances: [makeInstance('a', 'ISO 1', dir)], runningIds: new Set(['a']) })
    )

    expect(plan.runningInstances).toEqual(['ISO 1'])
    expect(plan.warnings.join(' ')).toMatch(/no longer control/i)
  })

  it('blocks on an instance that is already gone', async () => {
    const plan = await planInstanceRemoval('ghost', true, context())
    expect(plan.blockers).toHaveLength(1)
  })
})

describe('install removal', () => {
  it('lists the instances that would be left without an installation', async () => {
    const install = makeInstall('install-a', path.join(workspace, 'obs', '31.0.2'), true)
    const instances = [
      makeInstance('a', 'ISO 1', path.join(workspace, 'instances', 'a')),
      makeInstance('b', 'ISO 2', path.join(workspace, 'instances', 'b'))
    ]

    const plan = await planInstallRemoval(
      'install-a',
      false,
      context({ installs: [install], instances })
    )

    // The old behaviour was to refuse outright; now it explains and proceeds.
    expect(plan.blockers).toEqual([])
    expect(plan.affectedInstances).toEqual(['ISO 1', 'ISO 2'])
    expect(plan.warnings.join(' ')).toMatch(/needs another installation/i)
  })

  it('will not delete an OBS it did not install', async () => {
    const root = path.join(workspace, 'system-obs')
    await fs.mkdir(root, { recursive: true })

    const plan = await planInstallRemoval(
      'install-a',
      true,
      context({ installs: [makeInstall('install-a', root, false)] })
    )

    expect(plan.blockers.join(' ')).toMatch(/did not install this copy/i)
    expect(plan.deletions).toEqual([])
  })

  it('deletes a build it downloaded itself', async () => {
    const root = path.join(workspace, 'obs', '31.0.2')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'obs64.exe'), 'x'.repeat(1024))

    const plan = await planInstallRemoval(
      'install-a',
      true,
      context({ installs: [makeInstall('install-a', root, true)] })
    )

    expect(plan.blockers).toEqual([])
    expect(plan.destructive).toBe(true)
    expect(plan.deletions[0].path).toBe(root)
  })

  it('flags instances that are running on the install being removed', async () => {
    const install = makeInstall('install-a', path.join(workspace, 'obs', '31'), true)
    const instances = [makeInstance('a', 'ISO 1', path.join(workspace, 'instances', 'a'))]

    const plan = await planInstallRemoval(
      'install-a',
      false,
      context({ installs: [install], instances, runningIds: new Set(['a']) })
    )

    expect(plan.runningInstances).toEqual(['ISO 1'])
    expect(plan.warnings.join(' ')).toMatch(/does not stop them/i)
  })
})

describe('workspace containment', () => {
  it('accepts a folder under the instances directory', () => {
    expect(isInsideWorkspace(path.join(workspace, 'instances', 'a'), workspace)).toBe(true)
  })

  it('rejects the instances directory itself and anything outside it', () => {
    expect(isInsideWorkspace(path.join(workspace, 'instances'), workspace)).toBe(false)
    expect(isInsideWorkspace('/etc', workspace)).toBe(false)
    // A sibling whose name merely starts the same way must not pass.
    expect(isInsideWorkspace(`${path.join(workspace, 'instances')}-evil`, workspace)).toBe(false)
  })
})
