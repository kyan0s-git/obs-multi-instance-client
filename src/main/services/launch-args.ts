import type { ObsInstall, ObsInstance, Platform } from '@shared/types'
import { instancePaths, isolationOwnsInstall } from './paths.js'

export interface LaunchSpec {
  executable: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/**
 * Builds the exact command line and environment for one instance.
 *
 * Kept pure and separate from spawning so the argument contract is unit
 * testable — a wrong flag here means an instance silently shares config with
 * another, which is the worst failure mode this app has.
 */
export function buildLaunchSpec(
  instance: ObsInstance,
  install: ObsInstall,
  executable: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform as Platform
): LaunchSpec {
  const paths = instancePaths(instance, install)
  const { launch, websocket } = instance
  const args: string[] = []

  // Always present. Without --multi, OBS shows a blocking "already running"
  // dialog for every instance after the first.
  args.push('--multi')

  if (isolationOwnsInstall(instance.isolation)) {
    // Portable mode is what redirects config into the instance folder.
    args.push('--portable')
  }

  if (launch.profile) args.push('--profile', launch.profile)
  if (launch.sceneCollection) args.push('--collection', launch.sceneCollection)
  if (launch.startScene) args.push('--scene', launch.startScene)

  if (launch.studioMode) args.push('--studio-mode')
  if (launch.minimizeToTray) args.push('--minimize-to-tray')
  if (launch.alwaysOnTop) args.push('--always-on-top')
  if (launch.onlyBundledPlugins) args.push('--only-bundled-plugins')
  if (launch.disableUpdater) args.push('--disable-updater')
  if (launch.disableMissingFilesCheck) args.push('--disable-missing-files-check')
  if (launch.verboseLog) args.push('--verbose')

  // Safe mode disables third-party plugins *and* websockets, so the two are
  // mutually exclusive: honouring both would produce an instance the client
  // can never talk to.
  if (launch.safeMode) {
    args.push('--safe-mode')
  } else if (websocket.enabled) {
    args.push('--websocket_port', String(websocket.port))
    if (websocket.password !== '') args.push('--websocket_password', websocket.password)
    if (websocket.ipv4Only) args.push('--websocket_ipv4_only')
  }

  // Auto-start flags go last so an operator-supplied override in extraArgs
  // cannot accidentally precede them.
  if (launch.startStreaming) args.push('--startstreaming')
  if (launch.startRecording) args.push('--startrecording')
  if (launch.startReplayBuffer) args.push('--startreplaybuffer')
  if (launch.startVirtualCam) args.push('--startvirtualcam')

  args.push(...launch.extraArgs.filter((arg) => arg.trim() !== ''))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value
  }

  if (instance.isolation === 'xdg-config-home') {
    // libobs reads XDG_CONFIG_HOME directly, so this is the whole isolation
    // mechanism on Linux.
    env.XDG_CONFIG_HOME = paths.configParent
  } else if (instance.isolation === 'home-redirect') {
    // Foundation resolves Application Support under $HOME for a non-sandboxed
    // process, which is how macOS instances get separate config.
    env.HOME = paths.fakeHome ?? env.HOME
    delete env.XDG_CONFIG_HOME
  }

  // Per-instance plugins.
  //
  // These two are the only plugin mechanism that survives portable mode:
  // OBS's `AddExtraModulePaths` reads them and *then* returns early when
  // portable, so on Windows — where instances here are portable — the usual
  // per-user plugin folder is never searched. OBS also requires both to be set
  // before it adds the path at all, so they are always written as a pair.
  env.OBS_PLUGINS_PATH = paths.pluginsBinDir
  env.OBS_PLUGINS_DATA_PATH = paths.pluginsDataDir

  // Marks the process so window enumeration and crash reports can attribute
  // it back to an instance even after a restart.
  env.OBS_FLEET_INSTANCE_ID = instance.id
  env.OBS_FLEET_INSTANCE_NAME = instance.name

  Object.assign(env, launch.env)

  // Running from the instance root keeps any relative path an operator types
  // into OBS scoped to that instance.
  const cwd = platform === 'win32' && isolationOwnsInstall(instance.isolation)
    ? paths.obsRoot
    : paths.root

  return { executable, args, env, cwd }
}

/** Renders a spec as a copyable shell command, for the UI and logs. */
export function formatCommand(spec: LaunchSpec): string {
  const quote = (value: string): string =>
    /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
  return [quote(spec.executable), ...spec.args.map(quote)].join(' ')
}

/** Same as {@link formatCommand} but with the websocket password masked. */
export function formatCommandRedacted(spec: LaunchSpec): string {
  const args = [...spec.args]
  const passwordIndex = args.indexOf('--websocket_password')
  if (passwordIndex !== -1 && passwordIndex + 1 < args.length) {
    args[passwordIndex + 1] = '********'
  }
  return formatCommand({ ...spec, args })
}
