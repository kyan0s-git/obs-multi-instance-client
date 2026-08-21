import path from 'node:path'
import type { IsolationStrategy, ObsInstall, ObsInstance, Platform } from '@shared/types'

const platform = process.platform as Platform

/**
 * Resolved filesystem layout of one instance.
 *
 * Every consumer (provisioning, launching, sync, telemetry) goes through this
 * so the on-disk contract lives in exactly one place.
 *
 * ```
 * <workspace>/<slug>/
 *   instance.json          our metadata marker
 *   obs/                   Windows only: junction farm or copy of the install
 *     bin/ data/ obs-plugins/
 *     config/obs-studio/   portable OBS config
 *   config/obs-studio/     Linux/macOS: config reached via XDG_CONFIG_HOME / HOME
 *   recordings/            default recording output
 *   assets/                per-instance local HTML/media
 * ```
 */
export interface InstancePaths {
  /** The instance folder itself. */
  root: string
  /** Our own metadata file. */
  marker: string
  /**
   * Install root OBS is launched from. For link-farm/copy isolation this is
   * inside the instance; otherwise it is the shared base install.
   */
  obsRoot: string
  /** The directory that *contains* `obs-studio/`. */
  configParent: string
  /** `<configParent>/obs-studio` — where global.ini, user.ini and basic/ live. */
  configDir: string
  globalIni: string
  userIni: string
  profilesDir: string
  scenesDir: string
  pluginConfigDir: string
  webSocketConfig: string
  logsDir: string
  recordingsDir: string
  assetsDir: string
  /**
   * Fake HOME handed to the child process on macOS. `null` on other
   * platforms, where HOME is left alone.
   */
  fakeHome: string | null
}

export function isolationDefaultFor(target: Platform = platform): IsolationStrategy {
  if (target === 'win32') return 'portable-linkfarm'
  if (target === 'darwin') return 'home-redirect'
  return 'xdg-config-home'
}

/** True when the strategy materialises its own copy/link of the OBS install. */
export function isolationOwnsInstall(strategy: IsolationStrategy): boolean {
  return strategy === 'portable-linkfarm' || strategy === 'portable-copy'
}

export function instancePaths(instance: ObsInstance, install: ObsInstall): InstancePaths {
  const root = instance.dir
  const strategy = instance.isolation

  let obsRoot: string
  let configParent: string
  let fakeHome: string | null = null

  if (isolationOwnsInstall(strategy)) {
    // Windows portable mode: obs64.exe sits at <obsRoot>/bin/64bit and
    // resolves portable config to <obsRoot>/config.
    obsRoot = path.join(root, 'obs')
    configParent = path.join(obsRoot, 'config')
  } else if (strategy === 'home-redirect') {
    // macOS: NSApplicationSupportDirectory under a redirected HOME.
    obsRoot = install.root
    fakeHome = path.join(root, 'home')
    configParent = path.join(fakeHome, 'Library', 'Application Support')
  } else {
    // Linux: XDG_CONFIG_HOME points straight at this folder.
    obsRoot = install.root
    configParent = path.join(root, 'config')
  }

  const configDir = path.join(configParent, 'obs-studio')

  return {
    root,
    marker: path.join(root, 'instance.json'),
    obsRoot,
    configParent,
    configDir,
    globalIni: path.join(configDir, 'global.ini'),
    userIni: path.join(configDir, 'user.ini'),
    profilesDir: path.join(configDir, 'basic', 'profiles'),
    scenesDir: path.join(configDir, 'basic', 'scenes'),
    pluginConfigDir: path.join(configDir, 'plugin_config'),
    webSocketConfig: path.join(configDir, 'plugin_config', 'obs-websocket', 'config.json'),
    logsDir: path.join(configDir, 'logs'),
    recordingsDir: path.join(root, 'recordings'),
    assetsDir: path.join(root, 'assets'),
    fakeHome
  }
}

/** Executable to spawn for this instance, honouring per-instance install copies. */
export function instanceExecutable(
  instance: ObsInstance,
  install: ObsInstall,
  executableRel: string
): string {
  return isolationOwnsInstall(instance.isolation)
    ? path.join(instancePaths(instance, install).obsRoot, executableRel)
    : install.executable
}

/** Where the host user's own (non-fleet) OBS config lives, for seeding. */
export function hostObsConfigDir(home: string): string {
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return path.join(appData, 'obs-studio')
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obs-studio')
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return path.join(xdg, 'obs-studio')
}

/** Workspace-level directories that sit alongside the instance folders. */
export interface WorkspacePaths {
  root: string
  instances: string
  /** Shared HTML/media library served to every instance. */
  assets: string
  /** Reusable instance templates. */
  templates: string
  /** Timestamped backups taken before a destructive sync. */
  backups: string
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    instances: path.join(root, 'instances'),
    assets: path.join(root, 'assets'),
    templates: path.join(root, 'templates'),
    backups: path.join(root, 'backups')
  }
}
