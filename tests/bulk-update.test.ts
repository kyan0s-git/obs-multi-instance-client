import { describe, expect, it } from 'vitest'
import type { BulkUpdateRequest, ObsInstall, ObsInstance } from '../src/shared/types'
import { InstanceManager } from '../src/main/services/instance-manager'
import { mergeLaunchOptions } from '../src/main/services/defaults'
import type { Store } from '../src/main/services/store'

/**
 * Mass update is the one action in the app that writes to every instance at
 * once, so the properties worth pinning are the ones that make it safe to
 * press: only ticked fields move, an instance that already matches is left
 * alone, and one failure does not stop the rest of the fleet.
 *
 * The store is stubbed rather than real because none of that behaviour
 * involves the filesystem — `Store` is only imported as a type by
 * `InstanceManager`, so a plain object satisfies it.
 */

function makeInstall(id: string, label: string, problems: string[] = []): ObsInstall {
  return {
    id,
    label,
    root: `/opt/${id}`,
    executable: `/opt/${id}/bin/obs`,
    version: '31.0.2',
    detected: true,
    problems
  }
}

function makeInstance(id: string, name: string, overrides: Partial<ObsInstance> = {}): ObsInstance {
  return {
    id,
    name,
    role: '',
    color: '#4f9dff',
    dir: `/workspace/instances/${name}`,
    installId: 'install-a',
    isolation: 'xdg-config-home',
    websocket: { enabled: true, port: 4460, password: 'secret', ipv4Only: false },
    launch: mergeLaunchOptions(null),
    order: 0,
    disabled: false,
    autoRestart: false,
    createdAt: 0,
    updatedAt: 0,
    notes: '',
    ...overrides
  }
}

/** Minimal in-memory stand-in for the parts of `Store` bulk update touches. */
function makeStore(
  instances: ObsInstance[],
  installs: ObsInstall[],
  options: { failOn?: string } = {}
): Store {
  const stub = {
    getInstance: (id: string) => instances.find((i) => i.id === id) ?? null,
    getInstances: () => instances,
    getInstall: (id: string) => installs.find((i) => i.id === id) ?? null,
    updateInstance: async (id: string, patch: Partial<ObsInstance>) => {
      if (options.failOn === id) throw new Error('disk is full')
      const instance = instances.find((i) => i.id === id)
      if (!instance) throw new Error(`Unknown instance: ${id}`)
      Object.assign(instance, patch, {
        id: instance.id,
        dir: instance.dir,
        launch: patch.launch ? { ...instance.launch, ...patch.launch } : instance.launch,
        websocket: patch.websocket ? { ...instance.websocket, ...patch.websocket } : instance.websocket,
        updatedAt: Date.now()
      })
      return instance
    }
  }
  return stub as unknown as Store
}

function request(over: Partial<BulkUpdateRequest>): BulkUpdateRequest {
  return {
    instanceIds: [],
    fields: [],
    values: {},
    reprovision: false,
    ...over
  }
}

describe('bulk update preview', () => {
  it('reports only the fields that actually differ', () => {
    const instances = [
      makeInstance('a', 'ISO 1'),
      makeInstance('b', 'ISO 2', { launch: { ...mergeLaunchOptions(null), verboseLog: true } })
    ]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const preview = manager.preview(
      request({
        instanceIds: ['a', 'b'],
        fields: ['verboseLog'],
        values: { verboseLog: true }
      })
    )

    expect(preview.items).toHaveLength(2)
    // "b" is already verbose, so it has nothing to do.
    expect(preview.items[0].changes.map((c) => c.field)).toEqual(['verboseLog'])
    expect(preview.items[1].changes).toEqual([])
    expect(preview.items[0].changes[0]).toMatchObject({ from: 'off', to: 'on' })
  })

  it('treats an identical extraArgs list as no change', () => {
    const args = ['--disable-shutdown-check']
    const instances = [
      makeInstance('a', 'ISO 1', { launch: { ...mergeLaunchOptions(null), extraArgs: [...args] } })
    ]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const same = manager.preview(
      request({ instanceIds: ['a'], fields: ['extraArgs'], values: { extraArgs: [...args] } })
    )
    expect(same.items[0].changes).toEqual([])

    const different = manager.preview(
      request({ instanceIds: ['a'], fields: ['extraArgs'], values: { extraArgs: [] } })
    )
    expect(different.items[0].changes[0]).toMatchObject({ from: '--disable-shutdown-check', to: '(none)' })
  })

  it('forces re-provisioning when the OBS installation changes', () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const installs = [makeInstall('install-a', 'OBS 31'), makeInstall('install-b', 'OBS 30')]
    const manager = new InstanceManager(makeStore(instances, installs))

    const preview = manager.preview(
      request({
        instanceIds: ['a'],
        fields: ['installId'],
        values: { installId: 'install-b' },
        reprovision: false
      })
    )

    expect(preview.items[0].willReprovision).toBe(true)
    expect(preview.warnings.join(' ')).toMatch(/re-runs provisioning/i)
    // The install is shown by label, not by opaque id.
    expect(preview.items[0].changes[0]).toMatchObject({ from: 'OBS 31', to: 'OBS 30' })
  })

  it('does not re-provision an instance that has nothing to change', () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const preview = manager.preview(
      request({
        instanceIds: ['a'],
        fields: ['installId'],
        values: { installId: 'install-a' },
        reprovision: true
      })
    )

    expect(preview.items[0].changes).toEqual([])
    expect(preview.items[0].willReprovision).toBe(false)
  })

  it('warns that Safe Mode takes the instance out of remote control', () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const preview = manager.preview(
      request({ instanceIds: ['a'], fields: ['safeMode'], values: { safeMode: true } })
    )

    expect(preview.items[0].warnings.join(' ')).toMatch(/websocket/i)
  })

  it('warns when the target installation is unusable', () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const installs = [
      makeInstall('install-a', 'OBS 31'),
      makeInstall('install-b', 'OBS 30', ['obs64.exe is missing'])
    ]
    const manager = new InstanceManager(makeStore(instances, installs))

    const preview = manager.preview(
      request({ instanceIds: ['a'], fields: ['installId'], values: { installId: 'install-b' } })
    )
    expect(preview.items[0].warnings.join(' ')).toMatch(/obs64\.exe is missing/)

    const missing = manager.preview(
      request({ instanceIds: ['a'], fields: ['installId'], values: { installId: 'nope' } })
    )
    expect(missing.items[0].warnings.join(' ')).toMatch(/no longer exists/i)
  })
})

describe('bulk update apply', () => {
  it('writes only the ticked fields and leaves the rest of the launch options alone', async () => {
    const instances = [
      makeInstance('a', 'ISO 1', {
        launch: { ...mergeLaunchOptions(null), studioMode: true, startRecording: true }
      })
    ]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    await manager.applyBulkUpdate(
      request({
        instanceIds: ['a'],
        fields: ['profile'],
        values: { profile: 'Show', studioMode: false },
        reprovision: false
      })
    )

    expect(instances[0].launch.profile).toBe('Show')
    // `studioMode` had a value in `values` but was not ticked in `fields`.
    expect(instances[0].launch.studioMode).toBe(true)
    expect(instances[0].launch.startRecording).toBe(true)
  })

  it('merges websocket flags without dropping the port or password', async () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    await manager.applyBulkUpdate(
      request({
        instanceIds: ['a'],
        fields: ['websocketIpv4Only'],
        values: { websocketIpv4Only: true }
      })
    )

    expect(instances[0].websocket).toMatchObject({
      enabled: true,
      port: 4460,
      password: 'secret',
      ipv4Only: true
    })
  })

  it('skips an instance that already matches rather than bumping it', async () => {
    const instances = [makeInstance('a', 'ISO 1', { role: 'Program' })]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const outcomes = await manager.applyBulkUpdate(
      request({ instanceIds: ['a'], fields: ['role'], values: { role: 'Program' } })
    )

    expect(outcomes[0]).toMatchObject({ ok: true, changed: 0, detail: 'Already matches' })
    expect(instances[0].updatedAt).toBe(0)
  })

  it('keeps going after one instance fails', async () => {
    const instances = [makeInstance('a', 'ISO 1'), makeInstance('b', 'ISO 2'), makeInstance('c', 'ISO 3')]
    const manager = new InstanceManager(
      makeStore(instances, [makeInstall('install-a', 'OBS 31')], { failOn: 'b' })
    )

    const outcomes = await manager.applyBulkUpdate(
      request({ instanceIds: ['a', 'b', 'c'], fields: ['autoRestart'], values: { autoRestart: true } })
    )

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true])
    expect(outcomes[1].detail).toMatch(/disk is full/)
    expect(instances.map((i) => i.autoRestart)).toEqual([true, false, true])
  })

  it('ignores instances that are not in the roster', async () => {
    const instances = [makeInstance('a', 'ISO 1')]
    const manager = new InstanceManager(makeStore(instances, [makeInstall('install-a', 'OBS 31')]))

    const outcomes = await manager.applyBulkUpdate(
      request({ instanceIds: ['a', 'ghost'], fields: ['notes'], values: { notes: 'Rack 2' } })
    )

    expect(outcomes).toHaveLength(1)
    expect(instances[0].notes).toBe('Rack 2')
  })
})
