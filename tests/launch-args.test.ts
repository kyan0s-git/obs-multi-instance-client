import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IsolationStrategy, ObsInstall, ObsInstance } from '../src/shared/types'
import { mergeLaunchOptions } from '../src/main/services/defaults'
import { buildLaunchSpec, formatCommandRedacted } from '../src/main/services/launch-args'

/**
 * The launch contract is the highest-stakes pure logic in the app: a missing
 * `--multi` blocks every instance after the first behind a modal, and a
 * missing isolation flag silently makes two instances share one config.
 */

function makeInstance(overrides: Partial<ObsInstance> = {}): ObsInstance {
  return {
    id: 'instance-1',
    name: 'Cam 1',
    role: 'ISO wide',
    color: '#4f9dff',
    dir: path.join('/workspace', 'instances', 'cam-1'),
    installId: 'install-1',
    isolation: 'portable-linkfarm',
    websocket: { enabled: true, port: 4460, password: 'secret-pass', ipv4Only: false },
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

const install: ObsInstall = {
  id: 'install-1',
  label: 'OBS',
  root: path.join('/opt', 'obs-studio'),
  executable: path.join('/opt', 'obs-studio', 'bin', 'obs'),
  version: '31.0.0',
  detected: true,
  problems: []
}

describe('buildLaunchSpec', () => {
  it('always passes --multi so instances do not block on the already-running dialog', () => {
    const spec = buildLaunchSpec(makeInstance(), install, '/obs', {}, 'win32')
    expect(spec.args).toContain('--multi')
  })

  it('passes --portable only for isolation strategies that own the install', () => {
    const portable = buildLaunchSpec(
      makeInstance({ isolation: 'portable-linkfarm' }),
      install,
      '/obs',
      {},
      'win32'
    )
    expect(portable.args).toContain('--portable')

    for (const strategy of ['xdg-config-home', 'home-redirect'] as IsolationStrategy[]) {
      const spec = buildLaunchSpec(makeInstance({ isolation: strategy }), install, '/obs', {}, 'linux')
      expect(spec.args).not.toContain('--portable')
    }
  })

  it('isolates Linux instances through XDG_CONFIG_HOME', () => {
    const instance = makeInstance({ isolation: 'xdg-config-home' })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'linux')
    expect(spec.env.XDG_CONFIG_HOME).toBe(path.join(instance.dir, 'config'))
  })

  it('isolates macOS instances through a redirected HOME', () => {
    const instance = makeInstance({ isolation: 'home-redirect' })
    const spec = buildLaunchSpec(
      instance,
      install,
      '/obs',
      { HOME: '/Users/real', XDG_CONFIG_HOME: '/should/be/removed' },
      'darwin'
    )
    expect(spec.env.HOME).toBe(path.join(instance.dir, 'home'))
    // A stale XDG_CONFIG_HOME would be ignored by macOS OBS, but leaving it
    // set makes debugging the isolation confusing.
    expect(spec.env.XDG_CONFIG_HOME).toBeUndefined()
  })

  it('gives every instance a distinct websocket port', () => {
    const first = buildLaunchSpec(makeInstance(), install, '/obs', {}, 'win32')
    const second = buildLaunchSpec(
      makeInstance({
        id: 'instance-2',
        websocket: { enabled: true, port: 4461, password: 'other', ipv4Only: false }
      }),
      install,
      '/obs',
      {},
      'win32'
    )

    expect(first.args[first.args.indexOf('--websocket_port') + 1]).toBe('4460')
    expect(second.args[second.args.indexOf('--websocket_port') + 1]).toBe('4461')
  })

  it('omits websocket flags in safe mode, because safe mode disables the server', () => {
    const instance = makeInstance({ launch: mergeLaunchOptions({ safeMode: true }) })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')

    expect(spec.args).toContain('--safe-mode')
    expect(spec.args).not.toContain('--websocket_port')
    expect(spec.args).not.toContain('--websocket_password')
  })

  it('omits the password flag when no password is set', () => {
    const instance = makeInstance({
      websocket: { enabled: true, port: 4460, password: '', ipv4Only: false }
    })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')
    expect(spec.args).toContain('--websocket_port')
    expect(spec.args).not.toContain('--websocket_password')
  })

  it('forwards profile, collection and scene selections', () => {
    const instance = makeInstance({
      launch: mergeLaunchOptions({
        profile: 'Show Profile',
        sceneCollection: 'Main Show',
        startScene: 'Opening'
      })
    })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')

    expect(spec.args[spec.args.indexOf('--profile') + 1]).toBe('Show Profile')
    expect(spec.args[spec.args.indexOf('--collection') + 1]).toBe('Main Show')
    expect(spec.args[spec.args.indexOf('--scene') + 1]).toBe('Opening')
  })

  it('appends extra arguments last and drops blank lines', () => {
    const instance = makeInstance({
      launch: mergeLaunchOptions({ extraArgs: ['--custom', '  ', '--another'] })
    })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')

    expect(spec.args.slice(-2)).toEqual(['--custom', '--another'])
  })

  it('tags the process so windows and crashes can be attributed to an instance', () => {
    const spec = buildLaunchSpec(makeInstance(), install, '/obs', {}, 'win32')
    expect(spec.env.OBS_FLEET_INSTANCE_ID).toBe('instance-1')
    expect(spec.env.OBS_FLEET_INSTANCE_NAME).toBe('Cam 1')
  })

  it('lets per-instance env overrides win over the defaults', () => {
    const instance = makeInstance({
      launch: mergeLaunchOptions({ env: { OBS_FLEET_INSTANCE_NAME: 'override' } })
    })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')
    expect(spec.env.OBS_FLEET_INSTANCE_NAME).toBe('override')
  })
})

describe('formatCommandRedacted', () => {
  it('masks the websocket password', () => {
    const spec = buildLaunchSpec(makeInstance(), install, '/obs', {}, 'win32')
    const rendered = formatCommandRedacted(spec)

    expect(rendered).not.toContain('secret-pass')
    expect(rendered).toContain('********')
  })

  it('quotes arguments containing spaces', () => {
    const instance = makeInstance({
      launch: mergeLaunchOptions({ profile: 'Show Profile' })
    })
    const spec = buildLaunchSpec(instance, install, '/obs', {}, 'win32')
    expect(formatCommandRedacted(spec)).toContain('"Show Profile"')
  })
})
