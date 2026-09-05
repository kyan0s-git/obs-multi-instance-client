import { describe, expect, it } from 'vitest'
import type { ConfigImportOptions, ObsInstance, WorkspaceSettings } from '../src/shared/types'
import { defaultSettings, mergeLaunchOptions } from '../src/main/services/defaults'
import {
  buildConfigExport,
  planConfigImport,
  readConfigExport,
  settingsToApply
} from '../src/main/services/config-transfer'

/**
 * Importing someone else's configuration is the operation where a surprise is
 * least welcome, so these pin what the plan promises: credentials do not
 * travel unless asked for, this machine's paths are not overwritten by
 * another rig's, and every setting that changes is named.
 */

function makeInstance(name: string, over: Partial<ObsInstance> = {}): ObsInstance {
  return {
    id: `id-${name}`,
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
    ...over
  }
}

function options(over: Partial<ConfigImportOptions> = {}): ConfigImportOptions {
  return { settings: true, instances: true, existing: 'skip', keepLocalPaths: true, ...over }
}

describe('export', () => {
  it('leaves websocket passwords out by default', () => {
    const document = buildConfigExport(defaultSettings(), [makeInstance('ISO 1')], {
      includeSecrets: false,
      appVersion: '0.4.0'
    })

    expect(document.includesSecrets).toBe(false)
    expect(document.instances[0].websocket.password).toBeUndefined()
    // The port is not a secret and is kept.
    expect(document.instances[0].websocket.port).toBe(4460)
  })

  it('includes them when explicitly asked', () => {
    const document = buildConfigExport(defaultSettings(), [makeInstance('ISO 1')], {
      includeSecrets: true,
      appVersion: '0.4.0'
    })

    expect(document.includesSecrets).toBe(true)
    expect(document.instances[0].websocket.password).toBe('secret')
  })

  it('exports instances in launch order', () => {
    const document = buildConfigExport(
      defaultSettings(),
      [makeInstance('B', { order: 1 }), makeInstance('A', { order: 0 })],
      { includeSecrets: false, appVersion: '0.4.0' }
    )

    expect(document.instances.map((entry) => entry.name)).toEqual(['A', 'B'])
  })
})

describe('reading a document', () => {
  it('rejects something that is not a fleet configuration', () => {
    expect(() => readConfigExport('{"hello":"world"}')).toThrow(/not an OBS Fleet configuration/i)
    expect(() => readConfigExport('not json at all')).toThrow(/not valid JSON/i)
  })

  it('points at the right importer when handed the wrong kind of file', () => {
    expect(() => readConfigExport('{"format":"obs-fleet-bundle","version":1}')).toThrow(/Sync page/i)
  })

  it('refuses a document from a newer build', () => {
    expect(() => readConfigExport('{"format":"obs-fleet-config","version":99}')).toThrow(
      /newer version/i
    )
  })

  it('fills in settings a document omits', () => {
    const document = readConfigExport('{"format":"obs-fleet-config","version":1}')
    expect(document.settings.basePort).toBe(defaultSettings().basePort)
    expect(document.instances).toEqual([])
  })
})

describe('import plan', () => {
  const current = { settings: defaultSettings(), instances: [makeInstance('ISO 1')] }

  function incoming(over: Partial<WorkspaceSettings> = {}, names: string[] = []) {
    return buildConfigExport(
      { ...defaultSettings(), ...over },
      names.map((name) => makeInstance(name)),
      { includeSecrets: false, appVersion: '0.4.0' }
    )
  }

  it('names each setting that would change', () => {
    const plan = planConfigImport(current, incoming({ statsIntervalMs: 2000 }), options())

    expect(plan.settingChanges).toContainEqual({
      key: 'statsIntervalMs',
      from: String(defaultSettings().statsIntervalMs),
      to: '2000'
    })
  })

  it('holds back this machine’s paths and ports by default', () => {
    const plan = planConfigImport(
      current,
      incoming({ root: '/somewhere/else', basePort: 9000 }),
      options()
    )

    expect(plan.settingChanges.map((change) => change.key)).not.toContain('root')
    expect(plan.settingChanges.map((change) => change.key)).not.toContain('basePort')
  })

  it('takes them when asked, and warns', () => {
    const plan = planConfigImport(
      current,
      incoming({ root: '/somewhere/else' }),
      options({ keepLocalPaths: false })
    )

    expect(plan.settingChanges.map((change) => change.key)).toContain('root')
    expect(plan.warnings.join(' ')).toMatch(/do not exist on this machine/i)
  })

  it('separates new instances from ones that already exist', () => {
    const plan = planConfigImport(current, incoming({}, ['ISO 1', 'ISO 2']), options())

    expect(plan.newInstances).toEqual(['ISO 2'])
    expect(plan.skippedInstances).toEqual(['ISO 1'])
    expect(plan.updatedInstances).toEqual([])
  })

  it('updates existing instances when that is the choice', () => {
    const plan = planConfigImport(current, incoming({}, ['ISO 1']), options({ existing: 'update' }))

    expect(plan.updatedInstances).toEqual(['ISO 1'])
    expect(plan.skippedInstances).toEqual([])
  })

  it('says where new instances get their passwords from', () => {
    const plan = planConfigImport(current, incoming({}, ['ISO 2']), options())
    expect(plan.warnings.join(' ')).toMatch(/freshly generated/i)
  })

  it('warns that a document carries no OBS files', () => {
    const plan = planConfigImport(current, incoming({}, ['ISO 2']), options())
    expect(plan.warnings.join(' ')).toMatch(/come from a bundle/i)
  })

  it('blocks when nothing is selected', () => {
    const plan = planConfigImport(
      current,
      incoming(),
      options({ settings: false, instances: false })
    )
    expect(plan.blockers).toHaveLength(1)
  })
})

describe('settings to apply', () => {
  it('omits machine-specific keys when keeping local paths', () => {
    const patch = settingsToApply({ ...defaultSettings(), root: '/elsewhere' }, options())
    expect(patch.root).toBeUndefined()
    expect(patch.theme).toBeDefined()
  })

  it('includes them otherwise', () => {
    const patch = settingsToApply(
      { ...defaultSettings(), root: '/elsewhere' },
      options({ keepLocalPaths: false })
    )
    expect(patch.root).toBe('/elsewhere')
  })

  it('applies nothing when settings are not selected', () => {
    expect(settingsToApply(defaultSettings(), options({ settings: false }))).toEqual({})
  })
})

describe('instances need somewhere to run', () => {
  it('blocks creating instances when no OBS installation is registered', () => {
    const incoming = buildConfigExport(defaultSettings(), [makeInstance('ISO 9')], {
      includeSecrets: false,
      appVersion: '0.4.0'
    })

    const plan = planConfigImport(
      { settings: defaultSettings(), instances: [], installCount: 0 },
      incoming,
      options()
    )

    expect(plan.blockers.join(' ')).toMatch(/No OBS installation/i)
  })

  it('allows the import when an installation exists', () => {
    const incoming = buildConfigExport(defaultSettings(), [makeInstance('ISO 9')], {
      includeSecrets: false,
      appVersion: '0.4.0'
    })

    const plan = planConfigImport(
      { settings: defaultSettings(), instances: [], installCount: 1 },
      incoming,
      options()
    )

    expect(plan.blockers).toEqual([])
  })

  it('does not block a settings-only import with no installations', () => {
    const incoming = buildConfigExport(defaultSettings(), [], {
      includeSecrets: false,
      appVersion: '0.4.0'
    })

    const plan = planConfigImport(
      { settings: defaultSettings(), instances: [], installCount: 0 },
      incoming,
      options({ instances: false })
    )

    expect(plan.blockers).toEqual([])
  })
})
