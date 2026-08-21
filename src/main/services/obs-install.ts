import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ObsInstall, Platform } from '@shared/types'
import { isDirectory, isFile, pathExists } from '../util/fsx.js'
import { log, errorMessage } from '../util/logger.js'

const run = promisify(execFile)
const platform = process.platform as Platform

/* ------------------------------------------------------------------ */
/* Layout description per platform                                     */
/* ------------------------------------------------------------------ */

/**
 * Where each platform keeps the pieces of an OBS install, and which of them
 * an isolated instance needs to see.
 *
 * `linkable` entries are the heavy, read-only parts we symlink/junction into
 * an instance folder instead of copying. `config` is what stays per-instance.
 */
export interface InstallLayout {
  /** Path of the launchable binary relative to the install root. */
  executableRel: string
  /** Directories that can be shared between instances by reference. */
  linkableDirs: string[]
  /** Files that must be real copies in the instance (launchers, plists). */
  copyFiles: string[]
  /**
   * Where OBS looks for portable config, relative to the instance root.
   * `null` means portable mode is not usable and env-var isolation is used.
   */
  portableConfigRel: string | null
}

export function layoutFor(target: Platform = platform): InstallLayout {
  switch (target) {
    case 'win32':
      // obs64.exe lives in bin/64bit, and portable config resolves to
      // "../../config" from there, i.e. <root>/config.
      return {
        executableRel: path.join('bin', '64bit', 'obs64.exe'),
        linkableDirs: ['bin', 'data', 'obs-plugins'],
        copyFiles: [],
        portableConfigRel: 'config'
      }
    case 'darwin':
      // Official macOS builds compile without ENABLE_PORTABLE_CONFIG, so
      // portable mode is unavailable; the app bundle is shared and isolation
      // comes from a redirected HOME.
      return {
        executableRel: path.join('Contents', 'MacOS', 'OBS'),
        linkableDirs: [],
        copyFiles: [],
        portableConfigRel: null
      }
    default:
      // Distro builds also compile without ENABLE_PORTABLE_CONFIG, so
      // isolation comes from XDG_CONFIG_HOME instead.
      return {
        executableRel: path.join('bin', 'obs'),
        linkableDirs: [],
        copyFiles: [],
        portableConfigRel: null
      }
  }
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

function candidateRoots(): string[] {
  const home = os.homedir()

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [
      path.join(programFiles, 'obs-studio'),
      path.join(programFilesX86, 'obs-studio'),
      path.join(localAppData, 'Programs', 'obs-studio'),
      path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'OBS Studio'),
      path.join(programFiles, 'Steam', 'steamapps', 'common', 'OBS Studio')
    ]
  }

  if (platform === 'darwin') {
    return [
      '/Applications/OBS.app',
      path.join(home, 'Applications', 'OBS.app'),
      '/Applications/OBS Studio.app'
    ]
  }

  return ['/usr', '/usr/local', '/opt/obs-studio', path.join(home, '.local')]
}

/** Reads OBS's version, tolerating every way this can fail. */
async function readVersion(root: string, executable: string): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo.ProductVersion`
        ],
        { timeout: 8000, windowsHide: true }
      )
      const version = stdout.trim()
      return version === '' ? null : version
    }

    if (platform === 'darwin') {
      const plist = path.join(root, 'Contents', 'Info.plist')
      const { stdout } = await run(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
        { timeout: 8000 }
      )
      const version = stdout.trim()
      return version === '' ? null : version
    }

    // `obs --version` prints and exits without starting the UI.
    const { stdout } = await run(executable, ['--version'], { timeout: 8000 })
    const match = stdout.match(/([0-9]+\.[0-9]+(?:\.[0-9]+)?)/)
    return match ? match[1] : stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/** Confirms a root really is an OBS install and reports what is missing. */
export async function inspectInstall(root: string): Promise<{
  executable: string
  problems: string[]
}> {
  const layout = layoutFor()
  const problems: string[] = []
  const executable = path.join(root, layout.executableRel)

  if (!(await isFile(executable))) {
    problems.push(`Executable not found at ${executable}`)
  }

  for (const dir of layout.linkableDirs) {
    if (!(await isDirectory(path.join(root, dir)))) {
      problems.push(`Missing expected directory: ${dir}`)
    }
  }

  if (platform === 'linux') {
    // Instances rely on the shared data tree being present under the prefix.
    const dataDir = path.join(root, 'share', 'obs')
    if (!(await isDirectory(dataDir))) {
      problems.push(`Missing OBS data directory: ${dataDir}`)
    }
  }

  return { executable, problems }
}

/**
 * Scans the well-known locations plus (on Windows) the uninstall registry,
 * returning every OBS install we can find.
 */
export async function detectInstalls(): Promise<ObsInstall[]> {
  const roots = new Set(candidateRoots())

  if (platform === 'win32') {
    for (const registryRoot of await registryRoots()) roots.add(registryRoot)
  }
  if (platform === 'linux') {
    for (const prefix of await linuxPrefixes()) roots.add(prefix)
  }

  const found: ObsInstall[] = []
  for (const root of roots) {
    if (!(await pathExists(root))) continue
    const { executable, problems } = await inspectInstall(root)
    // A candidate with no runnable binary is just a directory that happens
    // to exist (e.g. /usr on a box without OBS) — skip it silently.
    if (!(await isFile(executable))) continue

    const version = await readVersion(root, executable)
    found.push({
      id: randomUUID(),
      label: labelFor(root, version),
      root,
      executable,
      version,
      detected: true,
      problems
    })
  }

  log.info('installs', `Detected ${found.length} OBS install(s)`)
  return found
}

function labelFor(root: string, version: string | null): string {
  const base = platform === 'darwin' ? path.basename(root, '.app') : path.basename(root)
  const where = platform === 'linux' ? root : path.dirname(root)
  return version ? `${base} ${version} (${where})` : `${base} (${where})`
}

/** Windows uninstall registry lookup, best-effort. */
async function registryRoots(): Promise<string[]> {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OBS Studio'
  ]
  const roots: string[] = []
  for (const key of keys) {
    try {
      const { stdout } = await run('reg.exe', ['query', key, '/v', 'InstallLocation'], {
        timeout: 5000,
        windowsHide: true
      })
      const match = stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/)
      if (match) roots.push(match[1].trim())
    } catch {
      // Key absent — OBS was installed portably or not at all.
    }
  }
  return roots
}

/** Resolves `obs` on PATH back to its install prefix. */
async function linuxPrefixes(): Promise<string[]> {
  try {
    const { stdout } = await run('which', ['obs'], { timeout: 5000 })
    const binary = stdout.trim()
    if (binary === '') return []
    const real = await fs.realpath(binary).catch(() => binary)
    // /usr/bin/obs -> /usr
    return [path.dirname(path.dirname(real))]
  } catch {
    return []
  }
}

/** Registers a user-picked folder (or .app bundle) as an install. */
export async function describeManualInstall(root: string): Promise<ObsInstall> {
  const normalized = path.resolve(root)
  const { executable, problems } = await inspectInstall(normalized)
  if (problems.length > 0 && !(await isFile(executable))) {
    throw new Error(`Not an OBS installation: ${problems[0]}`)
  }
  const version = await readVersion(normalized, executable)
  return {
    id: randomUUID(),
    label: labelFor(normalized, version),
    root: normalized,
    executable,
    version,
    detected: false,
    problems
  }
}

/** Re-checks a registered install so the UI can flag one that moved or broke. */
export async function revalidateInstall(install: ObsInstall): Promise<ObsInstall> {
  try {
    const { executable, problems } = await inspectInstall(install.root)
    const version = (await readVersion(install.root, executable)) ?? install.version
    return { ...install, executable, problems, version }
  } catch (err) {
    return { ...install, problems: [errorMessage(err)] }
  }
}
