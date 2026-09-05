import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  InstanceAddons,
  ObsInstall,
  ObsInstance,
  ObsPlugin,
  ObsTheme
} from '@shared/types'
import { dirSize, ensureDir, pathExists, removeQuiet } from '../util/fsx.js'
import { iniGet, iniMerge, parseIni, serializeIni } from '../util/ini.js'
import { extractZipFile } from '../util/zip-extract.js'
import { log, errorMessage } from '../util/logger.js'
import { instancePaths } from './paths.js'

/**
 * Plugins and themes, per instance.
 *
 * Both mechanisms were read out of the OBS source rather than guessed, because
 * both have a trap in them:
 *
 * Plugins — `AddExtraModulePaths` (frontend/widgets/OBSBasic.cpp) reads
 * `OBS_PLUGINS_PATH` and `OBS_PLUGINS_DATA_PATH` and *then* returns early if
 * portable mode is on. Windows instances here are portable, so the usual
 * per-user plugin folder is never searched and those two variables are the
 * only way to give an instance its own plugins. That they are read before the
 * early return is what makes per-instance plugins possible at all.
 *
 * Themes — `OBSApp::FindThemes` scans `themes/` in the install's data folder
 * and `<userConfig>/obs-studio/themes`, accepting `.obt` (base), `.ovt`
 * (variant) and `.oha` (high-contrast adjustment). The selected theme is the
 * `[Appearance] Theme` key in `user.ini`, holding the theme's declared id, not
 * its filename.
 */

const THEME_EXTENSIONS = new Set(['.obt', '.ovt', '.oha'])
/** Library extensions OBS will try to load as a module. */
const MODULE_EXTENSIONS = new Set(['.dll', '.so', '.dylib'])

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export async function readAddons(
  instance: ObsInstance,
  install: ObsInstall
): Promise<InstanceAddons> {
  const paths = instancePaths(instance, install)

  const [plugins, themes, currentTheme] = await Promise.all([
    listPlugins(instance, install),
    listThemes(instance, install),
    readCurrentTheme(paths.userIni)
  ])

  return { instanceId: instance.id, plugins, themes, currentTheme }
}

/**
 * Everything this instance will load, per-instance first.
 *
 * Bundled modules are listed too, read-only, because "why is this source
 * missing" is usually answered by seeing that a plugin is present in one
 * instance and not another.
 */
export async function listPlugins(
  instance: ObsInstance,
  install: ObsInstall
): Promise<ObsPlugin[]> {
  const paths = instancePaths(instance, install)
  const macBundles = paths.pluginsBinDir === paths.pluginsDir

  const own = await readPluginDir(paths.pluginsBinDir, 'instance', macBundles)
  const bundled = await readPluginDir(
    path.join(paths.obsRoot, macBundles ? 'Contents/PlugIns' : 'obs-plugins/64bit'),
    'bundled',
    macBundles
  )

  // A per-instance module shadows a bundled one of the same name; showing both
  // would suggest two copies load, and only the first path OBS searches wins.
  const seen = new Set(own.map((plugin) => plugin.id))
  return [...own, ...bundled.filter((plugin) => !seen.has(plugin.id))]
}

async function readPluginDir(
  dir: string,
  scope: ObsPlugin['scope'],
  macBundles: boolean
): Promise<ObsPlugin[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const plugins: ObsPlugin[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)

    if (macBundles) {
      if (!entry.isDirectory() || !entry.name.endsWith('.plugin')) continue
      const id = entry.name.replace(/\.plugin$/, '')
      const binary = path.join(full, 'Contents', 'MacOS', id)
      plugins.push({
        id,
        name: id,
        scope,
        dir: full,
        sizeBytes: await dirSize(full).catch(() => 0),
        loadable: await pathExists(binary),
        problems: (await pathExists(binary)) ? [] : ['The bundle has no binary in Contents/MacOS']
      })
      continue
    }

    if (!entry.isFile()) continue
    if (!MODULE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue

    const id = path.basename(entry.name, path.extname(entry.name))
    const stat = await fsp.stat(full).catch(() => null)
    plugins.push({
      id,
      name: id,
      scope,
      dir,
      sizeBytes: stat?.size ?? 0,
      loadable: true,
      problems: []
    })
  }

  return plugins.sort((a, b) => a.id.localeCompare(b.id))
}

export async function listThemes(
  instance: ObsInstance,
  install: ObsInstall
): Promise<ObsTheme[]> {
  const paths = instancePaths(instance, install)

  const own = await readThemeDir(paths.themesDir, 'instance')
  const bundled = await readThemeDir(bundledThemeDir(instance, install), 'bundled')

  // OBS keeps the first theme it finds for an id, and it scans the install's
  // themes before the user's, so a bundled theme wins a collision.
  const seen = new Set(bundled.map((theme) => theme.id))
  return [...bundled, ...own.filter((theme) => !seen.has(theme.id))].sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

function bundledThemeDir(instance: ObsInstance, install: ObsInstall): string {
  const paths = instancePaths(instance, install)
  return instance.isolation === 'home-redirect'
    ? path.join(paths.obsRoot, 'Contents', 'Resources', 'themes')
    : path.join(paths.obsRoot, 'data', 'obs-studio', 'themes')
}

async function readThemeDir(dir: string, scope: ObsTheme['scope']): Promise<ObsTheme[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const themes: ObsTheme[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = path.extname(entry.name).toLowerCase()
    if (!THEME_EXTENSIONS.has(extension)) continue

    const file = path.join(dir, entry.name)
    const source = await fsp.readFile(file, 'utf8').catch(() => null)
    if (source === null) continue

    const meta = parseThemeMeta(source)
    themes.push({
      // A theme with no declared id is not loadable by OBS, but showing it with
      // its filename is more useful than hiding it.
      id: meta.id ?? path.basename(entry.name, extension),
      name: meta.name ?? path.basename(entry.name, extension),
      author: meta.author ?? '',
      kind: extension === '.obt' ? 'base' : extension === '.ovt' ? 'variant' : 'adjustment',
      dark: meta.dark === 'true',
      extends: meta.extends ?? null,
      scope,
      file
    })
  }

  return themes
}

/**
 * Reads the `@OBSThemeMeta` block from a theme file.
 *
 * The real parser is OBS's config-file tokeniser; this only needs the handful
 * of quoted string properties in the metadata block, which is a fixed shape at
 * the top of the file.
 */
export function parseThemeMeta(source: string): Record<string, string | undefined> {
  const block = /@OBSThemeMeta\s*\{([^}]*)\}/.exec(source)
  if (!block) return {}

  const meta: Record<string, string> = {}
  // Both quote styles: OBS's own themes are written with single quotes, and
  // its tokeniser accepts either, so a parser that only took double quotes
  // would silently find no metadata in every theme that ships with OBS.
  const property = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*;/g

  let match: RegExpExecArray | null
  while ((match = property.exec(block[1])) !== null) {
    meta[match[1]] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1')
  }

  return meta
}

/** The theme id this instance is set to use, if any. */
export async function readCurrentTheme(userIni: string): Promise<string | null> {
  const source = await fsp.readFile(userIni, 'utf8').catch(() => null)
  if (source === null) return null

  const parsed = parseIni(source)
  // `CurrentTheme3` is the pre-30.2 key; OBS migrates it, so it is read as a
  // fallback rather than written.
  return iniGet(parsed, 'Appearance', 'Theme') ?? iniGet(parsed, 'General', 'CurrentTheme3') ?? null
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

/** Points an instance at a theme by writing `[Appearance] Theme`. */
export async function setTheme(
  instance: ObsInstance,
  install: ObsInstall,
  themeId: string
): Promise<void> {
  const paths = instancePaths(instance, install)
  const existing = await fsp.readFile(paths.userIni, 'utf8').catch(() => '')

  const document = parseIni(existing)
  iniMerge(document, { Appearance: { Theme: themeId } })
  await ensureDir(path.dirname(paths.userIni))
  await fsp.writeFile(paths.userIni, serializeIni(document), 'utf8')

  log.info('addons', `Theme set to ${themeId}`, instance.id)
}

/** Installs a theme file into an instance's user theme folder. */
export async function installTheme(
  instance: ObsInstance,
  install: ObsInstall,
  sourceFile: string
): Promise<ObsTheme> {
  const extension = path.extname(sourceFile).toLowerCase()
  if (!THEME_EXTENSIONS.has(extension)) {
    throw new Error(`${path.basename(sourceFile)} is not an OBS theme (.obt, .ovt or .oha)`)
  }

  const paths = instancePaths(instance, install)
  await ensureDir(paths.themesDir)

  const target = path.join(paths.themesDir, path.basename(sourceFile))
  await fsp.copyFile(sourceFile, target)

  const themes = await readThemeDir(paths.themesDir, 'instance')
  const installed = themes.find((theme) => theme.file === target)
  if (!installed) throw new Error('The theme was copied but could not be read back')

  log.info('addons', `Installed theme ${installed.name}`, instance.id)
  return installed
}

export async function removeTheme(
  instance: ObsInstance,
  install: ObsInstall,
  themeId: string
): Promise<void> {
  const themes = await readThemeDir(instancePaths(instance, install).themesDir, 'instance')
  const theme = themes.find((entry) => entry.id === themeId)
  // Only user themes live in a folder this application owns; a bundled theme
  // belongs to the OBS installation and is never touched.
  if (!theme) throw new Error('That theme is not installed for this instance')

  await removeQuiet(theme.file)
  log.info('addons', `Removed theme ${theme.name}`, instance.id)
}

/**
 * Installs a plugin archive into an instance.
 *
 * Plugin authors package inconsistently, so the archive is unpacked to a
 * temporary folder and the pieces are located by shape rather than by assuming
 * one layout. Recognised: a tree containing `obs-plugins/<arch>` and
 * `data/obs-plugins/<module>`, a tree rooted directly at those, and a macOS
 * `.plugin` bundle. Anything else is reported rather than half-installed.
 */
export async function installPlugin(
  instance: ObsInstance,
  install: ObsInstall,
  archivePath: string
): Promise<ObsPlugin[]> {
  const paths = instancePaths(instance, install)
  const macBundles = paths.pluginsBinDir === paths.pluginsDir
  const staging = path.join(paths.root, '.plugin-staging')

  await removeQuiet(staging)
  await ensureDir(staging)

  try {
    await extractZipFile(archivePath, staging)

    const found = await collectPluginPayload(staging, macBundles)
    if (found.binaries.length === 0) {
      throw new Error(
        'No OBS module was found in that archive. Expected a .dll, .so or .plugin bundle — ' +
          'some plugins ship an installer instead, which has to be run separately.'
      )
    }

    await ensureDir(paths.pluginsBinDir)
    await ensureDir(paths.pluginsDataDir)

    for (const binary of found.binaries) {
      await copyInto(binary, path.join(paths.pluginsBinDir, path.basename(binary)))
    }
    for (const data of found.dataDirs) {
      await copyInto(data, path.join(paths.pluginsDataDir, path.basename(data)))
    }

    const installed = await readPluginDir(paths.pluginsBinDir, 'instance', macBundles)
    log.info(
      'addons',
      `Installed ${found.binaries.length} module(s) from ${path.basename(archivePath)}`,
      instance.id
    )
    return installed
  } finally {
    await removeQuiet(staging)
  }
}

interface PluginPayload {
  binaries: string[]
  dataDirs: string[]
}

/** Walks an unpacked plugin archive and picks out the loadable pieces. */
async function collectPluginPayload(root: string, macBundles: boolean): Promise<PluginPayload> {
  const binaries: string[] = []
  const dataDirs: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    // Plugin archives are shallow. A bound stops a pathological archive from
    // turning this into a filesystem crawl.
    if (depth > MAX_ARCHIVE_DEPTH) return

    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (macBundles && entry.name.endsWith('.plugin')) {
          binaries.push(full)
          continue
        }
        // `data/obs-plugins/<module>` holds a module's locale and assets.
        if (path.basename(dir) === 'obs-plugins' && path.basename(path.dirname(dir)) === 'data') {
          dataDirs.push(full)
          continue
        }
        await walk(full, depth + 1)
        continue
      }

      if (!macBundles && MODULE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        binaries.push(full)
      }
    }
  }

  await walk(root, 0)
  return { binaries, dataDirs }
}

const MAX_ARCHIVE_DEPTH = 8

async function copyInto(source: string, target: string): Promise<void> {
  await removeQuiet(target)
  await fsp.cp(source, target, { recursive: true })
}

export async function removePlugin(
  instance: ObsInstance,
  install: ObsInstall,
  pluginId: string
): Promise<void> {
  const paths = instancePaths(instance, install)
  const macBundles = paths.pluginsBinDir === paths.pluginsDir

  const plugins = await readPluginDir(paths.pluginsBinDir, 'instance', macBundles)
  const plugin = plugins.find((entry) => entry.id === pluginId)
  if (!plugin) {
    throw new Error(
      'That plugin is not installed for this instance. Plugins that came with the OBS ' +
        'installation are part of it and are removed by managing the installation itself.'
    )
  }

  if (macBundles) {
    await removeQuiet(plugin.dir)
  } else {
    for (const extension of MODULE_EXTENSIONS) {
      await removeQuiet(path.join(paths.pluginsBinDir, `${pluginId}${extension}`))
    }
    await removeQuiet(path.join(paths.pluginsDataDir, pluginId))
  }

  log.info('addons', `Removed plugin ${pluginId}`, instance.id)
}

/** Copies an instance's plugins onto other instances. */
export async function copyPlugins(
  source: { instance: ObsInstance; install: ObsInstall },
  targets: Array<{ instance: ObsInstance; install: ObsInstall }>
): Promise<Array<{ instanceId: string; ok: boolean; detail: string }>> {
  const from = instancePaths(source.instance, source.install)
  const results: Array<{ instanceId: string; ok: boolean; detail: string }> = []

  for (const target of targets) {
    const to = instancePaths(target.instance, target.install)
    try {
      await ensureDir(to.pluginsDir)
      await copyInto(from.pluginsBinDir, to.pluginsBinDir)
      if (from.pluginsDataDir !== from.pluginsBinDir) {
        await copyInto(from.pluginsDataDir, to.pluginsDataDir)
      }
      results.push({ instanceId: target.instance.id, ok: true, detail: 'Plugins copied' })
    } catch (err) {
      results.push({ instanceId: target.instance.id, ok: false, detail: errorMessage(err) })
    }
  }

  return results
}
